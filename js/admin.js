/**
 * MEDUSINO — admin.js
 * Pannello admin per il torneo di tennis. Funzioni:
 *  - Approvazioni: accetta/rifiuta le richieste di iscrizione
 *  - Risultati: inserisci/correggi i vincitori reali turno per turno
 *  - Bonus: assegna i vincitori delle categorie bonus fine torneo
 *  - Partecipanti: stato schede, abilita/disabilita, gestione admin
 *  - Sistema: apri/chiudi pronostici, ricalcola la classifica
 *
 * Il ricalcolo classifica è interamente client-side (vedi handoff §8/§10):
 * carica pronostici + risultati, applica punteggi.js, scrive classifica/snapshot.
 */

import { STATE } from './app.js';
import {
  getPartecipanti, updatePartecipante, setPagamento,
  getRisultati, setRisultati, deleteRisultatoMatch, onRisultatiSnapshot,
  getTuttiPronostici, saveClassifica, getClassifica,
  getSistema, updateSistema, onSistemaSnapshot, getClassificaUpdatedAt,
} from './db.js';
import { caricaEvento, nomeGiocatore } from './evento.js';
import {
  TURNI, SET_OPTIONS, matchId, getPron, getMatchPlayers, CLASSIFICHE,
} from './bracket.js';
import { calcolaPunteggio } from './punteggi.js';
import { showToast, openModal, closeModal, formatDate } from './ui.js';

let _db = null;
let _ris = null;            // copia di lavoro dei risultati ufficiali
let _parts = [];            // partecipanti
let _aperti = true;
let _built = false;
let _unsubSistema = null;
let _activeRound = 'R128';
let _montepremiCfg = { quota: 0, percentuali: [60, 30, 10] };

// Metodi di pagamento disponibili nel menu a tendina
const METODI_PAGAMENTO = ['Contanti', 'Bonifico', 'Satispay', 'PayPal', 'Revolut'];

// ── INIT ──────────────────────────────────────────────
export async function initAdmin() {
  const page = document.getElementById('page-admin');
  if (!page) return;

  _db = await caricaEvento();
  _ris = (await getRisultati()) || {};
  if (!_ris.bracket) _ris.bracket = {};
  if (!_ris.bonus)   _ris.bonus = {};
  if (!_ris.classifiche) _ris.classifiche = {};

  _buildShell();
  _built = true;

  // I risultati sono la sezione critica: renderizzali SUBITO, così un eventuale
  // errore nei caricamenti successivi (montepremi/partecipanti/Firestore) non
  // lascia la lista partite vuota.
  TURNI.forEach(t => _renderRoundRisultati(t.id));
  _renderBonus();
  _renderClassifiche();

  try { await _caricaConfigMontepremi(); } catch (e) { console.error('[admin] config montepremi', e); }
  try { await _caricaPartecipanti(); }     catch (e) { console.error('[admin] partecipanti', e); }
  try { await _renderSistema(); }          catch (e) { console.error('[admin] sistema', e); }
  try { await _renderMontepremi(); }       catch (e) { console.error('[admin] montepremi', e); }

  if (_unsubSistema) _unsubSistema();
  _unsubSistema = onSistemaSnapshot((cfg) => {
    _aperti = cfg?.pronostici_aperti !== false;
    _aggiornaStatoPronostici();
  });
}

// ── SHELL ─────────────────────────────────────────────
function _buildShell() {
  const page = document.getElementById('page-admin');

  const roundTabs = TURNI.map((t, i) =>
    `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-tab="adm-ris-${t.id}" data-rround="${t.id}">${t.nome}</button>`
  ).join('');
  const roundContents = TURNI.map((t, i) =>
    `<div id="adm-ris-${t.id}" class="tab-content${i === 0 ? ' active' : ''}">
       <div class="round-head"><h4 class="section-title">${t.nome} — risultati reali</h4>
         <span class="round-progress" id="adm-risprog-${t.id}"></span></div>
       <div id="adm-risround-${t.id}" class="round-matches"></div>
       <div class="elim-save-row">
         <button type="button" class="btn btn-primary" data-savris="${t.id}">💾 Salva risultati ${t.nome}</button>
         <span class="elim-save-msg" id="rismsg-${t.id}"></span>
       </div>
     </div>`
  ).join('');

  page.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">⚙️ Pannello Admin</h2>
      <span class="page-subtitle">Approvazioni, risultati, sistema</span>
    </div>

    <div class="tab-bar admin-tabs">
      <button type="button" class="tab active" data-tab="tab-admin-approvazioni">
        Approvazioni <span id="approv-badge" class="nav-badge" style="display:none;position:relative;top:-1px;right:auto;margin-left:4px"></span>
      </button>
      <button type="button" class="tab" data-tab="tab-admin-risultati">Risultati</button>
      <button type="button" class="tab" data-tab="tab-admin-bonus">🏆 Bonus</button>
      <button type="button" class="tab" data-tab="tab-admin-partecipanti">Partecipanti</button>
      <button type="button" class="tab" data-tab="tab-admin-montepremi">💰 Montepremi</button>
      <button type="button" class="tab" data-tab="tab-admin-sistema">Sistema</button>
    </div>

    <div id="tab-admin-approvazioni" class="tab-content active">
      <div id="admin-approvazioni-container"></div>
    </div>

    <div id="tab-admin-risultati" class="tab-content">
      <div class="info-banner info-banner--yellow">
        <span>📝</span>
        <span>Inserisci i vincitori reali turno per turno. <strong>Ogni risultato inserito a mano è un override sull'API</strong> (🔒): il sync automatico ESPN non lo sovrascrive. Usa <strong>↺</strong> sul match per riportarlo in automatico. Dopo il salvataggio la classifica viene ricalcolata.</span>
      </div>
      <div class="tab-bar" id="ris-round-tabs">${roundTabs}</div>
      ${roundContents}
    </div>

    <div id="tab-admin-bonus" class="tab-content">
      <div class="info-banner info-banner--yellow">
        <span>🏆</span>
        <span>Assegna i vincitori delle categorie bonus quando sono noti a fine torneo.</span>
      </div>
      <div id="admin-bonus-box" class="bonus-form"></div>
      <div class="elim-save-row">
        <button type="button" class="btn btn-primary" data-savris="BONUS">💾 Salva Bonus</button>
        <span class="elim-save-msg" id="rismsg-BONUS"></span>
      </div>

      <div class="clf-admin-section">
        <div class="info-banner info-banner--yellow">
          <span>📊</span>
          <span>Inserisci le <strong>classifiche</strong> di ace, break e tie-break. Scegli il giocatore dal menu e digita il valore: le righe si <strong>riordinano da sole</strong> per valore decrescente (valore più alto in cima). Usa <strong>🗑</strong> per rimuovere. Queste classifiche sono informative e <strong>non incidono sul punteggio</strong>.</span>
        </div>
        <div id="admin-classifiche-box" class="clf-edit-wrap"></div>
        <div class="elim-save-row">
          <button type="button" class="btn btn-primary" data-savris="CLASSIFICHE">💾 Salva classifiche</button>
          <span class="elim-save-msg" id="rismsg-CLASSIFICHE"></span>
        </div>
      </div>
    </div>

    <div id="tab-admin-partecipanti" class="tab-content">
      <div id="admin-partecipanti-container"></div>
    </div>

    <div id="tab-admin-montepremi" class="tab-content">
      <div class="info-banner info-banner--yellow">
        <span>💰</span>
        <span>Segna chi ha pagato, a chi e con quale metodo. Il montepremi e la ripartizione si aggiornano in automatico.</span>
      </div>
      <div id="admin-montepremi-container"></div>
    </div>

    <div id="tab-admin-sistema" class="tab-content">
      <div class="admin-sistema-grid">
        <div class="sistema-card">
          <h4>🔒 Pronostici</h4>
          <p id="sistema-pronostici-status">—</p>
          <button type="button" id="btn-toggle-pronostici" class="btn btn-secondary">Apri / Chiudi</button>
        </div>
        <div class="sistema-card">
          <h4>🏅 Classifica</h4>
          <p id="sistema-classifica-status">—</p>
          <button type="button" id="btn-ricalcola-classifica" class="btn btn-primary">Ricalcola classifica</button>
        </div>
      </div>
    </div>
  `;

  // Salvataggi risultati per turno / bonus
  page.querySelectorAll('[data-savris]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.savris;
      if (r === 'BONUS') _salvaBonus(btn);
      else if (r === 'CLASSIFICHE') _salvaClassifiche(btn);
      else _salvaRisultatiTurno(r, btn);
    });
  });
  // Re-render del turno risultati quando la sua tab diventa attiva
  page.querySelectorAll('#ris-round-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => { _activeRound = tab.dataset.rround; _renderRoundRisultati(_activeRound); });
  });

  // L'handler globale dei tab (in app.js) disattiva TUTTI i .tab-content dentro
  // page-admin, comprese le sotto-schede dei turni: quando si entra nella scheda
  // "Risultati" riattiviamo il turno corrente (dopo che l'handler globale ha girato).
  const tabRis = page.querySelector('[data-tab="tab-admin-risultati"]');
  if (tabRis) tabRis.addEventListener('click', () => setTimeout(() => {
    page.querySelectorAll('#ris-round-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.rround === _activeRound));
    TURNI.forEach(t => {
      const c = document.getElementById('adm-ris-' + t.id);
      if (c) c.classList.toggle('active', t.id === _activeRound);
    });
    _renderRoundRisultati(_activeRound);
  }, 0));

  // Sistema
  page.querySelector('#btn-toggle-pronostici').addEventListener('click', _togglePronostici);
  page.querySelector('#btn-ricalcola-classifica').addEventListener('click', () => _ricalcola(true));

  // Montepremi: alla riapertura della scheda ricarica la classifica (per i nomi vincitori)
  const tabMp = page.querySelector('[data-tab="tab-admin-montepremi"]');
  if (tabMp) tabMp.addEventListener('click', () => setTimeout(async () => {
    await _caricaClassificaCache();
    await _renderMontepremi();
  }, 0));
}

// ── APPROVAZIONI ──────────────────────────────────────
async function _caricaPartecipanti() {
  _parts = await getPartecipanti();
  _renderApprovazioni();
  _renderPartecipanti();
}

function _displayName(p) {
  return p.nickname || `${p.nome || ''} ${p.cognome || ''}`.trim() || p.id;
}

// Costruisce un link wa.me normalizzando il numero (default prefisso Italia +39)
function _waLink(tel) {
  if (!tel) return null;
  let n = String(tel).replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (n.startsWith('3')) n = '39' + n;       // cellulare IT senza prefisso
  else if (n.startsWith('0')) n = '39' + n.replace(/^0+/, ''); // fisso IT
  if (n.length < 8) return null;
  return 'https://wa.me/' + n;
}

// Bottone WhatsApp per un partecipante (disabilitato se manca il numero)
function _waBtn(p) {
  const link = _waLink(p.telefono);
  const msg = encodeURIComponent(`Ciao ${_displayName(p)}! 🎾 Ti scrivo da Medusino.`);
  if (!link) {
    return `<button type="button" class="btn btn-secondary btn-sm" disabled title="Numero non disponibile">💬 WhatsApp</button>`;
  }
  return `<a href="${link}?text=${msg}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" title="Scrivi su WhatsApp">💬 WhatsApp</a>`;
}

function _renderApprovazioni() {
  const box = document.getElementById('admin-approvazioni-container');
  if (!box) return;
  const pending = _parts.filter(p => p.approvato !== true && p.disabilitato !== true);

  const badge = document.getElementById('approv-badge');
  if (badge) {
    if (pending.length) { badge.style.display = ''; badge.textContent = pending.length; }
    else badge.style.display = 'none';
  }

  if (!pending.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>Nessuna richiesta in attesa.</p></div>`;
    return;
  }

  box.innerHTML = pending.map(p => `
    <div class="admin-row" data-uid="${p.id}">
      <div class="admin-row-info">
        <span class="admin-row-nome">${_displayName(p)}</span>
        <span class="admin-row-sub">${p.nome || ''} ${p.cognome || ''} · ${p.telefono || '—'} · ${p.email || '—'}</span>
      </div>
      <div class="admin-row-actions">
        ${_waBtn(p)}
        <button type="button" class="btn btn-primary btn-sm" data-approva="${p.id}">✅ Approva</button>
        <button type="button" class="btn btn-secondary btn-sm" data-rifiuta="${p.id}">✖ Rifiuta</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-approva]').forEach(b =>
    b.addEventListener('click', () => _approva(b.dataset.approva)));
  box.querySelectorAll('[data-rifiuta]').forEach(b =>
    b.addEventListener('click', () => _rifiuta(b.dataset.rifiuta)));
}

async function _approva(uid) {
  try {
    await updatePartecipante(uid, { approvato: true, disabilitato: false });
    const p = _parts.find(x => x.id === uid); if (p) { p.approvato = true; p.disabilitato = false; }
    showToast('Utente approvato.', 'success');
    _renderApprovazioni(); _renderPartecipanti();
  } catch (err) { showToast('Errore: ' + err.message, 'error'); }
}

function _rifiuta(uid) {
  const p = _parts.find(x => x.id === uid);
  openModal({
    title: 'Rifiuta richiesta',
    body: `<p>Rifiutare la richiesta di <strong>${p ? _displayName(p) : uid}</strong>? L'account verrà disabilitato e non potrà accedere.</p>`,
    buttons: [
      { label: 'Annulla', cls: 'btn btn-secondary', onClick: closeModal },
      { label: 'Rifiuta', cls: 'btn btn-danger', onClick: async () => {
          closeModal();
          try {
            await updatePartecipante(uid, { approvato: false, disabilitato: true });
            const pp = _parts.find(x => x.id === uid); if (pp) { pp.approvato = false; pp.disabilitato = true; }
            showToast('Richiesta rifiutata.', 'info');
            _renderApprovazioni(); _renderPartecipanti();
          } catch (err) { showToast('Errore: ' + err.message, 'error'); }
        } },
    ],
  });
}

// ── PARTECIPANTI ──────────────────────────────────────
async function _renderPartecipanti() {
  const box = document.getElementById('admin-partecipanti-container');
  if (!box) return;

  // Chi ha compilato almeno un pronostico
  let compilati = {};
  try {
    const prons = await getTuttiPronostici();
    prons.forEach(d => {
      const n = d.bracket ? Object.values(d.bracket).reduce((s, r) => s + Object.keys(r || {}).length, 0) : 0;
      compilati[d.id] = n;
    });
  } catch (_) {}

  const lista = _parts.filter(p => p.approvato === true);
  if (!lista.length) { box.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>Nessun partecipante approvato.</p></div>`; return; }

  box.innerHTML = `<div class="admin-part-list">` + lista.map(p => {
    const n = compilati[p.id] || 0;
    const owner = p.isOwner === true;
    const disab = p.disabilitato === true;
    return `
    <div class="admin-row${disab ? ' admin-row--off' : ''}" data-uid="${p.id}">
      <div class="admin-row-info">
        <span class="admin-row-nome">${_displayName(p)}
          ${p.isAdmin ? '<span class="badge-admin">admin</span>' : ''}
          ${owner ? '<span class="badge-owner">owner</span>' : ''}
        </span>
        <span class="admin-row-sub">${n} pronostici · ${p.email || '—'}${disab ? ' · disabilitato' : ''}</span>
      </div>
      <div class="admin-row-actions">
        ${_waBtn(p)}
        <button type="button" class="btn btn-secondary btn-sm" data-toggleadmin="${p.id}" ${owner ? 'disabled title="Owner sempre admin"' : ''}>
          ${p.isAdmin ? '↓ Rimuovi admin' : '↑ Rendi admin'}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-toggleoff="${p.id}" ${owner ? 'disabled title="Owner protetto"' : ''}>
          ${disab ? '✓ Riattiva' : '⛔ Disabilita'}
        </button>
      </div>
    </div>`;
  }).join('') + `</div>`;

  box.querySelectorAll('[data-toggleadmin]').forEach(b =>
    b.addEventListener('click', () => _toggleAdmin(b.dataset.toggleadmin)));
  box.querySelectorAll('[data-toggleoff]').forEach(b =>
    b.addEventListener('click', () => _toggleOff(b.dataset.toggleoff)));
}

async function _toggleAdmin(uid) {
  const p = _parts.find(x => x.id === uid); if (!p || p.isOwner) return;
  try {
    await updatePartecipante(uid, { isAdmin: !p.isAdmin });
    p.isAdmin = !p.isAdmin;
    showToast('Permessi aggiornati.', 'success');
    _renderPartecipanti();
  } catch (err) { showToast('Errore: ' + err.message, 'error'); }
}

async function _toggleOff(uid) {
  const p = _parts.find(x => x.id === uid); if (!p || p.isOwner) return;
  try {
    await updatePartecipante(uid, { disabilitato: !p.disabilitato });
    p.disabilitato = !p.disabilitato;
    showToast('Stato aggiornato.', 'success');
    _renderPartecipanti();
  } catch (err) { showToast('Errore: ' + err.message, 'error'); }
}

// ── RISULTATI (turno per turno) ───────────────────────
function _renderRoundRisultati(roundId) {
  const box = document.getElementById('adm-risround-' + roundId);
  if (!box) return;
  const t = TURNI.find(x => x.id === roundId);
  if (!t) { box.innerHTML = '<p class="match-locked-msg">⚠️ Turno non trovato.</p>'; return; }
  // Diagnostica: se il tabellone non è caricato, dillo invece di restare vuoto.
  if (roundId === 'R128' && (!_db || !Array.isArray(_db.draw_R128) || _db.draw_R128.length === 0)) {
    box.innerHTML = '<p class="match-locked-msg">⚠️ Tabellone non caricato: manca <code>draw_R128</code> in usopen_db.json (controlla il deploy e ricarica con Ctrl+Shift+R).</p>';
    return;
  }

  let html = '';
  let compilati = 0;
  for (let i = 0; i < t.matches; i++) {
    const mid = matchId(roundId, i);
    // Gli accoppiamenti reali derivano dai vincitori reali del turno precedente
    const { a, b } = getMatchPlayers(roundId, i, _ris, _db);
    const p = getPron(_ris, roundId, mid);
    const vinc = (p && (p.vincitore === a || p.vincitore === b)) ? p.vincitore : null;
    const set = vinc ? (p.set || '') : '';
    const manuale = vinc && p && p.manuale === true;
    if (vinc) compilati++;

    if (!a && !b) {
      html += `<div class="match-card match-locked"><span class="match-num">${i + 1}</span>
        <span class="match-locked-msg">Inserisci prima i risultati del turno precedente</span></div>`;
      continue;
    }
    const opt = (pid) => {
      if (!pid) return `<button type="button" class="match-team match-team--empty" disabled>—</button>`;
      const sel = vinc === pid ? ' selected' : '';
      return `<button type="button" class="match-team${sel}" data-mid="${mid}" data-pid="${pid}" data-round="${roundId}">${nomeGiocatore(_db, pid)}</button>`;
    };
    const setBtns = SET_OPTIONS.map(s =>
      `<button type="button" class="set-opt${set === s ? ' selected' : ''}" data-mid="${mid}" data-round="${roundId}" data-set="${s}">${s}</button>`
    ).join('');
    const ovrTag = manuale
      ? `<button type="button" class="ovr-tag" data-clearovr="${mid}" data-round="${roundId}" title="Risultato inserito a mano (l'API non lo sovrascrive). Clicca per tornare ad automatico.">🔒 manuale ↺</button>`
      : '';
    html += `<div class="match-card${vinc ? ' match-done' : ''}${manuale ? ' match-manuale' : ''}">
      <span class="match-num">${i + 1}</span>
      <div class="match-teams">${opt(a)}<span class="match-vs">vs</span>${opt(b)}</div>
      <div class="match-set${vinc ? '' : ' match-set--hidden'}"><span class="match-set-label">set</span>${setBtns}</div>
      ${ovrTag}
    </div>`;
  }
  box.innerHTML = html;
  const prog = document.getElementById('adm-risprog-' + roundId);
  if (prog) prog.textContent = `${compilati}/${t.matches}`;

  box.querySelectorAll('.match-team[data-pid]').forEach(btn =>
    btn.addEventListener('click', () => { _setRisVincitore(btn.dataset.round, btn.dataset.mid, btn.dataset.pid); _renderRoundRisultati(btn.dataset.round); }));
  box.querySelectorAll('.set-opt[data-set]').forEach(btn =>
    btn.addEventListener('click', () => { _setRisSet(btn.dataset.round, btn.dataset.mid, btn.dataset.set); _renderRoundRisultati(btn.dataset.round); }));
  box.querySelectorAll('.ovr-tag[data-clearovr]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const r = btn.dataset.round, mid = btn.dataset.clearovr;
      _clearOverride(r, mid);
      _renderRoundRisultati(r);
      try {
        await deleteRisultatoMatch(r, mid); // delete reale: il merge non cancella i campi
        showToast('Override rimosso: il match torna automatico.', 'info');
        await _ricalcola(false);
      } catch (err) { showToast('Errore: ' + err.message, 'error'); }
    }));
}

function _setRisVincitore(roundId, mid, pid) {
  if (!_ris.bracket[roundId]) _ris.bracket[roundId] = {};
  const cur = _ris.bracket[roundId][mid] || {};
  if (cur.vincitore === pid) delete _ris.bracket[roundId][mid];
  // Inserimento a mano = override sull'API: marcato `manuale`, il sync ESPN non lo tocca.
  else _ris.bracket[roundId][mid] = { vincitore: pid, set: cur.set || '', manuale: true };
}
function _setRisSet(roundId, mid, set) {
  const cur = _ris.bracket[roundId]?.[mid];
  if (!cur || !cur.vincitore) return;
  cur.set = (cur.set === set) ? '' : set;
  cur.manuale = true; // ogni modifica a mano resta un override
}
// Rimuove l'override: il match torna gestito automaticamente dall'API ESPN.
function _clearOverride(roundId, mid) {
  if (_ris.bracket[roundId]) delete _ris.bracket[roundId][mid];
}

async function _salvaRisultatiTurno(roundId, btn) {
  const msg = document.getElementById('rismsg-' + roundId);
  btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ Salvataggio…';
  try {
    await setRisultati({ bracket: _ris.bracket, bonus: _ris.bonus });
    if (msg) { msg.textContent = '✅ Salvato'; msg.className = 'elim-save-msg ok'; }
    showToast('Risultati salvati. Ricalcolo classifica…', 'success');
    await _ricalcola(false);
  } catch (err) {
    if (msg) { msg.textContent = '❌ Errore'; msg.className = 'elim-save-msg err'; }
    showToast('Errore: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
  }
}

// ── BONUS (risultati reali) ───────────────────────────
function _renderBonus() {
  const box = document.getElementById('admin-bonus-box');
  if (!box) return;
  const cats = _db.bonus || [];
  if (!cats.length) { box.innerHTML = '<p class="text-muted">Nessun bonus configurato.</p>'; return; }
  const ids = Object.keys(_db.giocatori || {});
  ids.sort((x, y) => nomeGiocatore(_db, x).localeCompare(nomeGiocatore(_db, y), 'it'));
  const optsHtml = (sel) => '<option value="">— non assegnato —</option>' +
    ids.map(pid => `<option value="${pid}"${sel === pid ? ' selected' : ''}>${nomeGiocatore(_db, pid)}</option>`).join('');

  box.innerHTML = cats.map(c => {
    const sel = _ris.bonus?.[c.id] || '';
    return `<div class="bonus-field">
      <label class="bonus-field-label">${c.label}</label>
      <select class="bonus-select" data-bonus="${c.id}">${optsHtml(sel)}</select>
    </div>`;
  }).join('');

  box.querySelectorAll('.bonus-select').forEach(s =>
    s.addEventListener('change', () => {
      if (!_ris.bonus) _ris.bonus = {};
      _ris.bonus[s.dataset.bonus] = s.value || null;
    }));
}

// ── CLASSIFICHE (ace / break / tie-break) ─────────────
/** Opzioni <option> dei 128 giocatori del tabellone, ordinate per nome. */
function _giocatoreOptions(sel) {
  const ids = Object.keys(_db.giocatori || {})
    .sort((x, y) => nomeGiocatore(_db, x).localeCompare(nomeGiocatore(_db, y), 'it'));
  return '<option value="">— seleziona —</option>' +
    ids.map(pid => `<option value="${pid}"${sel === pid ? ' selected' : ''}>${nomeGiocatore(_db, pid)}</option>`).join('');
}

/** Garantisce l'esistenza della riga idx nella classifica cat e la restituisce. */
function _clfEnsure(cat, idx) {
  if (!_ris.classifiche) _ris.classifiche = {};
  if (!Array.isArray(_ris.classifiche[cat])) _ris.classifiche[cat] = [];
  if (!_ris.classifiche[cat][idx]) _ris.classifiche[cat][idx] = { pid: null, v: null };
  return _ris.classifiche[cat][idx];
}

/** Editor delle tre classifiche (menu giocatore + valore; ordinamento automatico per valore desc). */
function _renderClassifiche() {
  const box = document.getElementById('admin-classifiche-box');
  if (!box) return;
  if (!_ris.classifiche) _ris.classifiche = {};

  // Ordina ogni classifica per valore decrescente (righe senza valore in fondo).
  CLASSIFICHE.forEach(c => {
    if (Array.isArray(_ris.classifiche[c.id])) {
      _ris.classifiche[c.id].sort((a, b) => {
        const av = a && a.v != null ? a.v : -Infinity;
        const bv = b && b.v != null ? b.v : -Infinity;
        return bv - av;
      });
    }
  });

  box.innerHTML = CLASSIFICHE.map(c => {
    const rows = _ris.classifiche[c.id] || [];
    const rowsHtml = rows.map((r, i) => `
      <div class="clf-edit-row">
        <span class="clf-edit-pos">${i + 1}</span>
        <select class="bonus-select clf-edit-player" data-cat="${c.id}" data-idx="${i}">${_giocatoreOptions(r.pid || '')}</select>
        <input type="number" class="clf-edit-val" data-cat="${c.id}" data-idx="${i}" min="0" step="1" value="${r.v == null ? '' : r.v}" placeholder="valore" aria-label="Valore">
        <button type="button" class="clf-edit-btn clf-edit-del" data-clfdel="${c.id}" data-idx="${i}" title="Rimuovi">🗑</button>
      </div>`).join('');
    return `<div class="clf-edit-card">
      <h4 class="clf-edit-title">${c.emoji} Classifica ${c.label}</h4>
      <div class="clf-edit-rows">${rowsHtml || '<p class="text-muted clf-edit-empty">Nessuna riga. Aggiungi il primo giocatore.</p>'}</div>
      <button type="button" class="btn btn-secondary clf-edit-add" data-clfadd="${c.id}">➕ Aggiungi giocatore</button>
    </div>`;
  }).join('');

  box.querySelectorAll('.clf-edit-player').forEach(s =>
    s.addEventListener('change', () => { _clfEnsure(s.dataset.cat, +s.dataset.idx).pid = s.value || null; }));
  box.querySelectorAll('.clf-edit-val').forEach(inp => {
    // Aggiorna il modello mentre si digita (senza riordinare, per non perdere il focus)…
    inp.addEventListener('input', () => {
      const raw = inp.value.trim();
      _clfEnsure(inp.dataset.cat, +inp.dataset.idx).v = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
    });
    // …e riordina automaticamente quando il campo perde il focus (o si preme Invio).
    inp.addEventListener('change', () => _renderClassifiche());
  });
  box.querySelectorAll('[data-clfadd]').forEach(b =>
    b.addEventListener('click', () => {
      const cat = b.dataset.clfadd;
      if (!Array.isArray(_ris.classifiche[cat])) _ris.classifiche[cat] = [];
      _ris.classifiche[cat].push({ pid: null, v: null });
      _renderClassifiche();
    }));
  box.querySelectorAll('[data-clfdel]').forEach(b =>
    b.addEventListener('click', () => {
      const cat = b.dataset.clfdel, i = +b.dataset.idx;
      (_ris.classifiche[cat] || []).splice(i, 1);
      _renderClassifiche();
    }));
}

async function _salvaClassifiche(btn) {
  const msg = document.getElementById('rismsg-CLASSIFICHE');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ Salvataggio…';
  try {
    // Ripulisci: scarta righe senza giocatore e normalizza i valori.
    const clean = {};
    CLASSIFICHE.forEach(c => {
      clean[c.id] = (_ris.classifiche[c.id] || [])
        .filter(r => r && r.pid)
        .map(r => ({ pid: r.pid, v: r.v == null ? null : Number(r.v) }));
    });
    _ris.classifiche = clean;
    await setRisultati({ classifiche: clean });
    if (msg) { msg.textContent = '✅ Salvato'; msg.className = 'elim-save-msg ok'; }
    showToast('Classifiche salvate', 'success');
    _renderClassifiche();
  } catch (err) {
    if (msg) { msg.textContent = '❌ Errore'; msg.className = 'elim-save-msg err'; }
    showToast('Errore: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
  }
}

async function _salvaBonus(btn) {
  const msg = document.getElementById('rismsg-BONUS');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ Salvataggio…';
  try {
    await setRisultati({ bracket: _ris.bracket, bonus: _ris.bonus });
    if (msg) { msg.textContent = '✅ Salvato'; msg.className = 'elim-save-msg ok'; }
    showToast('Bonus salvati. Ricalcolo classifica…', 'success');
    await _ricalcola(false);
  } catch (err) {
    if (msg) { msg.textContent = '❌ Errore'; msg.className = 'elim-save-msg err'; }
    showToast('Errore: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
  }
}

// ── SISTEMA ───────────────────────────────────────────
async function _renderSistema() {
  try {
    const cfg = await getSistema();
    _aperti = cfg?.pronostici_aperti !== false;
  } catch (_) {}
  _aggiornaStatoPronostici();
  try {
    const ts = await getClassificaUpdatedAt();
    const el = document.getElementById('sistema-classifica-status');
    if (el) el.textContent = ts ? `Ultimo aggiornamento: ${formatDate(ts.toISOString(), true)}` : 'Mai ricalcolata';
  } catch (_) {}
}

function _aggiornaStatoPronostici() {
  const el = document.getElementById('sistema-pronostici-status');
  if (el) el.textContent = _aperti ? '🟢 Aperti — i partecipanti possono modificare' : '🔴 Chiusi — schede bloccate';
}

async function _togglePronostici() {
  const nuovo = !_aperti;
  try {
    await updateSistema({ pronostici_aperti: nuovo });
    _aperti = nuovo;
    _aggiornaStatoPronostici();
    showToast(nuovo ? 'Pronostici aperti.' : 'Pronostici chiusi.', 'success');
  } catch (err) { showToast('Errore: ' + err.message, 'error'); }
}

// ── MONTEPREMI / PAGAMENTI ────────────────────────────
let _classificaCache = [];

async function _caricaConfigMontepremi() {
  try {
    const cfg = await getSistema();
    const mp = cfg?.montepremi || {};
    _montepremiCfg = {
      quota: Number(mp.quota) || 0,
      percentuali: Array.isArray(mp.percentuali) && mp.percentuali.length === 3
        ? mp.percentuali.map(n => Number(n) || 0)
        : [60, 30, 10],
    };
  } catch (_) {
    _montepremiCfg = { quota: 0, percentuali: [60, 30, 10] };
  }
  await _caricaClassificaCache();
}

async function _caricaClassificaCache() {
  try { _classificaCache = (await getClassifica()) || []; }
  catch (_) { _classificaCache = []; }
}

// Lista admin (per il menu "a chi ha pagato")
function _incassatori() {
  return _parts
    .filter(p => p.isAdmin === true && p.disabilitato !== true)
    .sort((a, b) => _displayName(a).localeCompare(_displayName(b), 'it'));
}

// Importo effettivo di un pagamento (default = quota corrente)
function _importoPagamento(p) {
  const pag = p.pagamento;
  if (!pag || pag.pagato !== true) return 0;
  const imp = Number(pag.importo);
  return Number.isFinite(imp) && imp > 0 ? imp : _montepremiCfg.quota;
}

function _fmtEuro(n) {
  return '€ ' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('it-IT',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Classifica ordinata per montepremi (totale desc, poi spareggio se presente)
function _classificaOrdinata() {
  const arr = [..._classificaCache];
  arr.sort((a, b) => {
    if ((b.totale || 0) !== (a.totale || 0)) return (b.totale || 0) - (a.totale || 0);
    const sa = a.spareggio || [], sb = b.spareggio || [];
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const d = (Number(sb[i]) || 0) - (Number(sa[i]) || 0);
      if (d) return d;
    }
    return (a.nome || '').localeCompare(b.nome || '', 'it');
  });
  return arr;
}

async function _renderMontepremi() {
  const box = document.getElementById('admin-montepremi-container');
  if (!box) return;

  const approvati = _parts.filter(p => p.approvato === true && p.disabilitato !== true);
  const paganti = approvati.filter(p => p.pagamento?.pagato === true);
  const montepremi = paganti.reduce((s, p) => s + _importoPagamento(p), 0);
  const atteso = _montepremiCfg.quota * approvati.length;
  const daIncassare = Math.max(0, atteso - montepremi);

  const [p1, p2, p3] = _montepremiCfg.percentuali;
  const sommaPerc = p1 + p2 + p3;
  const ord = _classificaOrdinata();
  const posti = [
    { etichetta: '🥇 1º', perc: p1, vinc: ord[0] },
    { etichetta: '🥈 2º', perc: p2, vinc: ord[1] },
    { etichetta: '🥉 3º', perc: p3, vinc: ord[2] },
  ];

  const incassatori = _incassatori();
  const incOpts = (sel) => '<option value="">— a chi —</option>' +
    incassatori.map(a => `<option value="${a.id}"${sel === a.id ? ' selected' : ''}>${_displayName(a)}</option>`).join('');
  const metOpts = (sel) => '<option value="">— metodo —</option>' +
    METODI_PAGAMENTO.map(m => `<option value="${m}"${sel === m ? ' selected' : ''}>${m}</option>`).join('');

  // ── Card impostazioni ──
  const cfgCard = `
    <div class="sistema-card mp-config">
      <h4>⚙️ Impostazioni montepremi</h4>
      <div class="mp-config-row">
        <label for="mp-quota">Quota a testa</label>
        <div class="mp-input-euro"><span>€</span>
          <input type="number" id="mp-quota" min="0" step="0.5" value="${_montepremiCfg.quota || ''}" placeholder="0">
        </div>
      </div>
      <div class="mp-config-row">
        <label>Ripartizione premi</label>
        <div class="mp-perc-inputs">
          <span class="mp-perc-pos">1º</span><input type="number" class="mp-perc" id="mp-p1" min="0" max="100" value="${p1}">%
          <span class="mp-perc-pos">2º</span><input type="number" class="mp-perc" id="mp-p2" min="0" max="100" value="${p2}">%
          <span class="mp-perc-pos">3º</span><input type="number" class="mp-perc" id="mp-p3" min="0" max="100" value="${p3}">%
          <span class="mp-perc-sum${sommaPerc === 100 ? ' ok' : ' warn'}" id="mp-perc-sum">tot ${sommaPerc}%</span>
        </div>
      </div>
      <button type="button" class="btn btn-primary" id="mp-save-cfg">💾 Salva impostazioni</button>
    </div>`;

  // ── Riepilogo + distribuzione ──
  const summaryCard = `
    <div class="mp-summary">
      <div class="mp-stat"><span class="mp-stat-val">${paganti.length}/${approvati.length}</span><span class="mp-stat-lbl">Paganti</span></div>
      <div class="mp-stat mp-stat--accent"><span class="mp-stat-val">${_fmtEuro(montepremi)}</span><span class="mp-stat-lbl">Montepremi</span></div>
      <div class="mp-stat"><span class="mp-stat-val">${_fmtEuro(daIncassare)}</span><span class="mp-stat-lbl">Ancora da incassare</span></div>
    </div>
    <div class="sistema-card mp-distrib">
      <h4>🏆 Distribuzione premi</h4>
      ${sommaPerc !== 100 ? '<p class="mp-warn-line">⚠️ Le percentuali non fanno 100%: gli importi sono comunque calcolati sul totale indicato.</p>' : ''}
      <div class="mp-distrib-list">
        ${posti.map(p => `
          <div class="mp-distrib-row">
            <span class="mp-distrib-pos">${p.etichetta}</span>
            <span class="mp-distrib-perc">${p.perc}%</span>
            <span class="mp-distrib-amt">${_fmtEuro(montepremi * p.perc / 100)}</span>
            <span class="mp-distrib-name">${p.vinc ? p.vinc.nome : '<em class="text-muted">da definire</em>'}</span>
          </div>`).join('')}
      </div>
      ${_classificaCache.length ? '' : '<p class="text-muted mp-distrib-note">La classifica non è ancora stata calcolata: i nomi dei vincitori compaiono dopo il primo ricalcolo.</p>'}
    </div>`;

  // ── Tabella pagamenti ──
  let rows;
  if (!approvati.length) {
    rows = `<div class="empty-state"><div class="empty-icon">👥</div><p>Nessun partecipante approvato.</p></div>`;
  } else {
    const sorted = [...approvati].sort((a, b) => _displayName(a).localeCompare(_displayName(b), 'it'));
    rows = `<div class="mp-pay-list">` + sorted.map(p => {
      const pag = p.pagamento || {};
      const pagato = pag.pagato === true;
      const imp = pagato ? (pag.importo ?? _montepremiCfg.quota) : '';
      return `
      <div class="mp-pay-row${pagato ? ' mp-pay-row--ok' : ''}" data-uid="${p.id}">
        <label class="mp-pay-check">
          <input type="checkbox" data-mp-pagato="${p.id}" ${pagato ? 'checked' : ''}>
          <span class="mp-pay-name">${_displayName(p)}</span>
        </label>
        <div class="mp-input-euro mp-pay-importo">
          <span>€</span>
          <input type="number" min="0" step="0.5" data-mp-importo="${p.id}" value="${imp}" ${pagato ? '' : 'disabled'} placeholder="${_montepremiCfg.quota || 0}">
        </div>
        <select class="mp-pay-select" data-mp-incassato="${p.id}" ${pagato ? '' : 'disabled'}>${incOpts(pag.incassatoDa || '')}</select>
        <select class="mp-pay-select" data-mp-metodo="${p.id}" ${pagato ? '' : 'disabled'}>${metOpts(pag.metodo || '')}</select>
      </div>`;
    }).join('') + `</div>`;
  }

  box.innerHTML = `
    ${cfgCard}
    ${summaryCard}
    <div class="mp-pay">
      <div class="round-head"><h4 class="section-title">Pagamenti</h4>
        <span class="round-progress">${paganti.length}/${approvati.length} pagati</span></div>
      ${rows}
    </div>`;

  // Listener impostazioni
  box.querySelector('#mp-save-cfg')?.addEventListener('click', (e) => _salvaConfigMontepremi(e.target));
  ['mp-p1', 'mp-p2', 'mp-p3'].forEach(id => {
    box.querySelector('#' + id)?.addEventListener('input', () => {
      const s = (Number(box.querySelector('#mp-p1').value) || 0)
        + (Number(box.querySelector('#mp-p2').value) || 0)
        + (Number(box.querySelector('#mp-p3').value) || 0);
      const el = box.querySelector('#mp-perc-sum');
      if (el) { el.textContent = 'tot ' + s + '%'; el.className = 'mp-perc-sum ' + (s === 100 ? 'ok' : 'warn'); }
    });
  });

  // Listener pagamenti
  box.querySelectorAll('[data-mp-pagato]').forEach(c =>
    c.addEventListener('change', () => _setPagato(c.dataset.mpPagato, c.checked)));
  box.querySelectorAll('[data-mp-importo]').forEach(i =>
    i.addEventListener('change', () => _setPagamentoCampo(i.dataset.mpImporto, 'importo', Number(i.value) || 0)));
  box.querySelectorAll('[data-mp-incassato]').forEach(s =>
    s.addEventListener('change', () => _setPagamentoCampo(s.dataset.mpIncassato, 'incassatoDa', s.value || '')));
  box.querySelectorAll('[data-mp-metodo]').forEach(s =>
    s.addEventListener('change', () => _setPagamentoCampo(s.dataset.mpMetodo, 'metodo', s.value || '')));
}

async function _salvaConfigMontepremi(btn) {
  const quota = Number(document.getElementById('mp-quota')?.value) || 0;
  const p1 = Number(document.getElementById('mp-p1')?.value) || 0;
  const p2 = Number(document.getElementById('mp-p2')?.value) || 0;
  const p3 = Number(document.getElementById('mp-p3')?.value) || 0;
  if (quota < 0) { showToast('La quota non può essere negativa.', 'error'); return; }
  const old = btn.textContent; btn.disabled = true; btn.textContent = '⏳ Salvataggio…';
  try {
    _montepremiCfg = { quota, percentuali: [p1, p2, p3] };
    await updateSistema({ montepremi: _montepremiCfg });
    showToast('Impostazioni montepremi salvate.', 'success');
    await _renderMontepremi();
  } catch (err) {
    showToast('Errore: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

async function _setPagato(uid, pagato) {
  const p = _parts.find(x => x.id === uid); if (!p) return;
  const prev = p.pagamento || {};
  const pagamento = pagato
    ? { pagato: true,
        importo: (prev.importo ?? _montepremiCfg.quota),
        incassatoDa: prev.incassatoDa || '',
        metodo: prev.metodo || '',
        data: prev.data || new Date().toISOString() }
    : { ...prev, pagato: false };
  try {
    await setPagamento(uid, pagamento);
    p.pagamento = pagamento;
    showToast(pagato ? 'Pagamento registrato.' : 'Pagamento annullato.', pagato ? 'success' : 'info');
    await _renderMontepremi();
  } catch (err) { showToast('Errore: ' + err.message, 'error'); }
}

async function _setPagamentoCampo(uid, campo, valore) {
  const p = _parts.find(x => x.id === uid); if (!p) return;
  const pagamento = { ...(p.pagamento || { pagato: true }), [campo]: valore };
  if (pagamento.pagato !== true) pagamento.pagato = true;
  if (!pagamento.data) pagamento.data = new Date().toISOString();
  try {
    await setPagamento(uid, pagamento);
    p.pagamento = pagamento;
    // Re-render solo se l'importo cambia il totale (per aggiornare riepilogo/distribuzione)
    if (campo === 'importo') await _renderMontepremi();
  } catch (err) { showToast('Errore: ' + err.message, 'error'); }
}

// ── RICALCOLO CLASSIFICA (client-side) ────────────────
async function _ricalcola(manuale) {
  const btn = document.getElementById('btn-ricalcola-classifica');
  if (manuale && btn) { btn.disabled = true; btn.textContent = '⏳ Ricalcolo…'; }
  try {
    const [parts, prons, ris] = await Promise.all([
      getPartecipanti(), getTuttiPronostici(), getRisultati(),
    ]);
    // Nomi solo per approvati e non disabilitati (guard contro pronostici orfani)
    const nomi = {};
    parts.forEach(p => {
      if (p.approvato === true && p.disabilitato !== true) {
        nomi[p.id] = p.nickname || `${p.nome || ''} ${p.cognome || ''}`.trim() || p.id;
      }
    });

    const out = [];
    const visti = new Set();
    prons.forEach(d => {
      if (!nomi[d.id]) return; // orfano o non idoneo
      const { totale, breakdown, spareggio } = calcolaPunteggio(d, ris, _db);
      out.push({ id: d.id, nome: nomi[d.id], totale, breakdown, spareggio });
      visti.add(d.id);
    });
    // Includi anche gli approvati senza pronostici (a 0) così compaiono in classifica
    Object.keys(nomi).forEach(uid => {
      if (visti.has(uid)) return;
      out.push({ id: uid, nome: nomi[uid], totale: 0,
        breakdown: { esiti: 0, set: 0, bonus: 0, perTurno: {} },
        spareggio: [0, 0, 0, 0, 0, 0] });
    });

    await saveClassifica(out);
    _classificaCache = out;              // aggiorna i nomi nella distribuzione premi
    if (document.getElementById('admin-montepremi-container')) await _renderMontepremi();
    showToast(`Classifica ricalcolata (${out.length} partecipanti).`, 'success');
    const el = document.getElementById('sistema-classifica-status');
    if (el) el.textContent = `Ultimo aggiornamento: ${formatDate(new Date().toISOString(), true)}`;
  } catch (err) {
    showToast('Errore nel ricalcolo: ' + err.message, 'error');
  } finally {
    if (manuale && btn) { btn.disabled = false; btn.textContent = 'Ricalcola classifica'; }
  }
}
