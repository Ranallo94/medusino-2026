/**
 * MEDUSINO 2026 — functions/index.js
 * Cloud Functions: sincronizzazione automatica e GRATUITA dei risultati del
 * tabellone (singolare maschile) da ESPN, + ricalcolo classifica.
 *
 * Fonte dati: API pubblica ESPN (nessuna chiave, nessun costo).
 * La logica pura di fetch/matching/propagazione sta in ./espn.js (testabile).
 *
 * Funzioni esportate:
 *   syncRisultati       — schedulata (ogni 15 min): pesca i risultati e li scrive
 *   syncManuale         — callable (solo admin): forza un sync immediato
 *   ricalcolaClassifica — trigger su risultati/ufficiali: ricalcola la classifica
 *   eliminaUtente       — callable (solo admin)
 *   checkApiStatus      — callable: verifica raggiungibilità ESPN
 */
'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { onDocumentWritten }        = require('firebase-functions/v2/firestore');
const { initializeApp }            = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }                  = require('firebase-admin/auth');
const axios                        = require('axios');

const { DB, calcolaPunteggio }     = require('./punteggi.js');
const espn                         = require('./espn.js');

initializeApp();
const db = getFirestore();
const REGION = 'europe-west1';
const GIORNI_FINESTRA = 2; // giorni indietro interrogati (per recuperare match conclusi)

// Ritmo del polling adattivo (minuti tra una chiamata ESPN e la successiva).
const INTERVALLI = {
  live:   2,   // c'è almeno una partita IN CORSO → controlla spesso
  attesa: 15,  // partite in programma oggi ma nessuna ancora live
  idle:   60,  // giornata di torneo senza partite imminenti (es. notte)
  fuori:  720, // fuori dalla finestra del torneo → praticamente fermo
};

// ════════════════════════════════════════════════════════
// FUNZIONI ESPORTATE
// ════════════════════════════════════════════════════════

// 1. Sync schedulato — gira ogni 2 min, ma chiama ESPN solo quando "è ora"
//    (vedi polling adattivo in _sincronizza).
exports.syncRisultati = onSchedule(
  { schedule: 'every 2 minutes', region: REGION, timeoutSeconds: 120 },
  async () => {
    try { await _sincronizza('schedule'); }
    catch (e) { console.error('[syncRisultati]', e.message); }
  }
);

// 2. Sync manuale (callable, solo admin).
exports.syncManuale = onCall({ region: REGION }, async (request) => {
  await _assertAdmin(request);
  const esito = await _sincronizza('manuale');
  return { ok: true, ...esito, timestamp: new Date().toISOString() };
});

// 3. Ricalcolo classifica — su ogni scrittura di risultati/ufficiali.
exports.ricalcolaClassifica = onDocumentWritten(
  { document: 'risultati/ufficiali', region: REGION },
  async (event) => {
    try {
      const data = event.data.after && event.data.after.data();
      if (!data) return;
      await _aggiornaClassifica(data);
    } catch (e) { console.error('[ricalcolaClassifica]', e.message); }
  }
);

// 4. Elimina utente (callable, solo admin).
exports.eliminaUtente = onCall({ region: REGION }, async (request) => {
  await _assertAdmin(request);
  const { uid } = request.data || {};
  if (!uid) throw new HttpsError('invalid-argument', 'uid mancante.');
  await getAuth().deleteUser(uid);
  return { ok: true };
});

// 5. Check stato API ESPN (callable).
exports.checkApiStatus = onCall({ region: REGION }, async () => {
  try {
    const res = await axios.get(espn.ESPN_URL, { timeout: 8000 });
    const eventi = (res.data.events || []).map((e) => e.name);
    return { ok: true, status: res.status, usopen: eventi.some((n) => n.includes('US Open')), eventi };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ════════════════════════════════════════════════════════
// LOGICA DI SINCRONIZZAZIONE
// ════════════════════════════════════════════════════════

async function _sincronizza(origine) {
  const cfgSnap = await db.doc('sistema/config').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const now = Date.now();

  // ── Gate adattivo (solo per le esecuzioni schedulate; il sync manuale forza) ──
  if (origine === 'schedule') {
    // Fuori dalla finestra del torneo: non interroga ESPN, ricontrolla tra molte ore.
    if (!_dentroFinestraTorneo(cfg)) {
      await _salvaStato(now + INTERVALLI.fuori * 60000, { origine, skip: 'fuori-torneo' });
      return { skipped: true, motivo: 'fuori finestra torneo' };
    }
    // Non è ancora il momento del prossimo controllo: esci senza chiamare ESPN.
    const nextAt = cfg.sync_state && cfg.sync_state.nextFetchAt
      ? new Date(cfg.sync_state.nextFetchAt).getTime() : 0;
    if (now < nextAt) return { skipped: true, motivo: 'in attesa del prossimo check' };
  }

  // 0) Override manuali già confermati dall'admin: vanno preservati (l'API non
  //    li sovrascrive) e usati per derivare gli accoppiamenti dei turni dopo.
  const prevSnap = await db.doc('risultati/ufficiali').get();
  const seed = _soloManuali(prevSnap.exists ? prevSnap.data().bracket : null);
  const protetti = Object.values(seed).reduce((s, r) => s + Object.keys(r).length, 0);

  // 1) ESPN → match conclusi + stato (quante partite in corso / in programma).
  const { matches, live, prossimi } = await espn.fetchUsOpen(GIORNI_FINESTRA);
  const { bracket, nonMappati, nMatch } = espn.bracketDaMatches(matches, seed);

  // 2) Scrive i risultati (merge: preserva correzioni manuali e bonus).
  if (nMatch > 0) {
    await db.doc('risultati/ufficiali').set(
      { bracket, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  // 3) Decide il prossimo intervallo in base a cosa sta succedendo.
  const minuti = live > 0 ? INTERVALLI.live : (prossimi > 0 ? INTERVALLI.attesa : INTERVALLI.idle);
  await _salvaStato(now + minuti * 60000, {
    origine,
    match_espn: matches.length,
    match_scritti: nMatch,
    live,
    prossimi,
    prossimo_check_min: minuti,
    protetti_manuali: protetti,
    non_mappati: nonMappati.slice(0, 20),
  });

  console.log(`[sync] ${origine} espn=${matches.length} scritti=${nMatch} manuali=${protetti} live=${live} prossimi=${prossimi} next=${minuti}min`);
  return { match_espn: matches.length, match_scritti: nMatch, protetti_manuali: protetti, live, prossimi, prossimo_check_min: minuti, non_mappati: nonMappati };
}

/** Estrae solo i risultati marcati `manuale` (override admin) dal bracket salvato. */
function _soloManuali(bracket) {
  const out = {};
  for (const [r, matches] of Object.entries(bracket || {})) {
    for (const [mid, m] of Object.entries(matches || {})) {
      if (m && m.manuale && m.vincitore) {
        if (!out[r]) out[r] = {};
        out[r][mid] = { vincitore: m.vincitore, set: m.set || '', manuale: true };
      }
    }
  }
  return out;
}

/** Salva timestamp ultimo sync, prossimo check (per il polling adattivo) e log diagnostico. */
async function _salvaStato(nextFetchAtMs, log) {
  await db.doc('sistema/config').set({
    ultimo_sync: FieldValue.serverTimestamp(),
    sync_state: { nextFetchAt: new Date(nextFetchAtMs).toISOString() },
    sync_log: { ...log, quando: new Date().toISOString() },
  }, { merge: true });
}

// ════════════════════════════════════════════════════════
// RICALCOLO CLASSIFICA
// ════════════════════════════════════════════════════════

async function _aggiornaClassifica(risultati) {
  const [pronSnap, partSnap] = await Promise.all([
    db.collection('pronostici').get(),
    db.collection('partecipanti').get(),
  ]);

  const nomi = {};
  const disabilitati = new Set();
  partSnap.docs.forEach((d) => {
    const { nome, cognome, nickname, disabilitato } = d.data();
    if (disabilitato) { disabilitati.add(d.id); return; }
    nomi[d.id] = nickname || [nome, cognome].filter(Boolean).join(' ') || d.id;
  });

  const partecipanti = pronSnap.docs
    .filter((d) => !disabilitati.has(d.id) && !!nomi[d.id])
    .map((d) => {
      const pr = d.data();
      const { totale, breakdown, spareggio } = calcolaPunteggio(pr, risultati, DB);
      return { id: d.id, nome: nomi[d.id] || d.id, totale, breakdown, spareggio };
    });

  partecipanti.sort((a, b) => {
    if (b.totale !== a.totale) return b.totale - a.totale;
    const sa = a.spareggio || [], sb = b.spareggio || [];
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      if ((sb[i] || 0) !== (sa[i] || 0)) return (sb[i] || 0) - (sa[i] || 0);
    }
    return 0;
  });

  await db.doc('classifica/snapshot').set({
    partecipanti,
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`[classifica] aggiornata — ${partecipanti.length} partecipanti`);
}

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════

async function _assertAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Autenticazione richiesta.');
  const snap = await db.doc(`partecipanti/${uid}`).get();
  if (!snap.exists || !snap.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Operazione riservata agli admin.');
  }
}

/**
 * Vero se siamo dentro (o vicino a) la finestra del torneo.
 * Configurabile in sistema/config: { torneo_inizio: "2026-06-29", torneo_fine: "2026-07-12" }.
 * Se non configurata, ritorna sempre true.
 */
function _dentroFinestraTorneo(cfg) {
  if (!cfg || (!cfg.torneo_inizio && !cfg.torneo_fine)) return true;
  const now = Date.now();
  const MARGINE = 24 * 60 * 60 * 1000; // ±1 giorno
  if (cfg.torneo_inizio && now < new Date(cfg.torneo_inizio).getTime() - MARGINE) return false;
  if (cfg.torneo_fine && now > new Date(cfg.torneo_fine).getTime() + MARGINE) return false;
  return true;
}
