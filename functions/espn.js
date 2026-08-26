/**
 * MEDUSINO — functions/espn.js
 * Logica pura (senza Firebase) per leggere i risultati da ESPN e mapparli sul
 * tabellone interno. Isolata qui per poterla testare senza emulatori.
 *
 * Fonte: https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard
 * Evento: ESPN espone gli US Open come events[].name === 'US Open'.
 */
'use strict';

const axios = require('axios');
const { DB, TURNI, matchId, getMatchPlayers } = require('./punteggi.js');

const ESPN_URL   = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard';
const EVENTO_KEY = 'US Open';
const GROUPING   = 'mens-singles';
const SET_OK     = new Set(DB.setOptions || ['3-0', '3-1', '3-2']);

// ── FETCH ─────────────────────────────────────────────
/** Array di YYYYMMDD (fuso America/New_York) per oggi e i giorni precedenti. */
function giorniNewYork(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    out.push(s.replace(/-/g, ''));
  }
  return out;
}

/**
 * Scarica dallo scoreboard ESPN i match US Open (mens-singles).
 * Interroga "oggi + giorni indietro", deduplica per id partita, e riporta
 * sia i match conclusi sia il conteggio di quelli in corso / in programma —
 * usato dal polling adattivo per decidere ogni quanto richiamare ESPN.
 * @returns {Promise<{matches:Array<{winner,loser,set}>, live:number, prossimi:number}>}
 */
async function fetchUsOpen(giorni = 3) {
  const urls = ['', ...giorniNewYork(giorni).map((d) => `?dates=${d}`)];
  const vistiMatch = new Set();
  const statoPerId = new Map(); // id competizione → 'pre' | 'in' | 'post'
  const matches = [];
  for (const q of urls) {
    let data;
    try {
      const res = await axios.get(ESPN_URL + q, { timeout: 12000 });
      data = res.data;
    } catch (e) {
      console.warn('[fetch ESPN]', q, e.message);
      continue;
    }
    // Conclusi (per i risultati)
    for (const m of estraiMatches(data)) {
      if (m._cid && vistiMatch.has(m._cid)) continue;
      if (m._cid) vistiMatch.add(m._cid);
      delete m._cid;
      matches.push(m);
    }
    // Stati (per il ritmo adattivo) — l'ultimo stato visto per ogni id vince
    for (const s of estraiStati(data)) statoPerId.set(s.id, s.state);
  }
  let live = 0, prossimi = 0;
  for (const state of statoPerId.values()) {
    if (state === 'in') live++;
    else if (state === 'pre') prossimi++;
  }
  return { matches, live, prossimi };
}

/** Backward-compat: solo l'elenco dei match conclusi. */
async function fetchEspnUsOpen(giorni = 3) {
  return (await fetchUsOpen(giorni)).matches;
}

/** Stato (pre/in/post) di tutte le competizioni mens-singles di una risposta ESPN. */
function estraiStati(data) {
  const out = [];
  for (const ev of (data.events || [])) {
    if (!(ev.name || '').includes(EVENTO_KEY)) continue;
    for (const g of (ev.groupings || [])) {
      const slug = (g.grouping && g.grouping.slug) || g.slug;
      if (slug !== GROUPING) continue;
      for (const c of (g.competitions || [])) {
        const state = c.status && c.status.type && c.status.type.state; // 'pre'|'in'|'post'
        if (state) out.push({ id: c.id, state });
      }
    }
  }
  return out;
}

/** Estrae i match conclusi (mens-singles) da una risposta scoreboard ESPN. */
function estraiMatches(data) {
  const out = [];
  for (const ev of (data.events || [])) {
    if (!(ev.name || '').includes(EVENTO_KEY)) continue;
    for (const g of (ev.groupings || [])) {
      const slug = (g.grouping && g.grouping.slug) || g.slug;
      if (slug !== GROUPING) continue;
      for (const c of (g.competitions || [])) {
        const m = parseCompetizione(c);
        if (m) { m._cid = c.id; out.push(m); }
      }
    }
  }
  return out;
}

/** Estrae vincitore/perdente e punteggio set da una competizione ESPN conclusa. */
function parseCompetizione(c) {
  const st = c.status && c.status.type;
  if (!st || !st.completed) return null;
  const comps = c.competitors || [];
  if (comps.length !== 2) return null;
  const win = comps.find((x) => x.winner === true);
  const los = comps.find((x) => x.winner === false);
  if (!win || !los) return null;

  const nome = (x) => (x.athlete && (x.athlete.displayName || x.athlete.fullName)) || '';
  const setVinti = (x) => (x.linescores || []).filter((ls) => ls.winner === true).length;

  let set = `${setVinti(win)}-${setVinti(los)}`;
  if (!SET_OK.has(set)) set = ''; // ritiri/walkover: vincitore valido, set non standard
  return { winner: nome(win), loser: nome(los), set };
}

// ── MATCHING NOMI ESPN → ID INTERNI ───────────────────
/** Rimuove accenti, spazi, punti, trattini; minuscolo. */
function norm(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Spezza il nome interno in iniziali (es. "J.M.") e cognome ("Cerundolo"). */
function parseInterno(nome) {
  const tokens = String(nome).trim().split(/\s+/);
  const initials = [];
  let i = 0;
  while (i < tokens.length - 1 && /^[A-Za-z](\.[A-Za-z])*\.?$/.test(tokens[i])) {
    initials.push(...tokens[i].replace(/\./g, '').toLowerCase().split(''));
    i++;
  }
  return { initials, core: norm(tokens.slice(i).join(' ')) };
}

// Indice cognome → [{ pid, core, firstInitial }]
const INDICE = (() => {
  const idx = [];
  for (const [pid, g] of Object.entries(DB.giocatori || {})) {
    if (!g || !g.nome) continue;
    const { initials, core } = parseInterno(g.nome);
    if (!core) continue;
    idx.push({ pid, core, firstInitial: initials[0] || null });
  }
  return idx;
})();

/** Risolve un nome completo ESPN nell'id interno (pid), o null se ambiguo/assente. */
function risolvi(espnFull) {
  const tokens = String(espnFull).trim().split(/\s+/);
  const firstInitial = norm(tokens[0])[0] || null;
  const lastPart = norm(tokens.length > 1 ? tokens.slice(1).join('') : tokens[0]);

  const cand = INDICE.filter((e) => lastPart.includes(e.core) || e.core.includes(lastPart));
  if (cand.length === 0) return null;
  if (cand.length === 1) return cand[0].pid;

  const byInit = cand.filter((e) => e.firstInitial && e.firstInitial === firstInitial);
  if (byInit.length === 1) return byInit[0].pid;

  const exact = cand.filter((e) => e.core === lastPart);
  if (exact.length === 1) return exact[0].pid;

  return null; // ambiguo: meglio non indovinare
}

/** Costruisce il pool { "pidA|pidB" → {winner,set} } dai match ESPN. */
function costruisciPool(espnMatches) {
  const pool = {};
  const nonMappati = [];
  for (const m of espnMatches) {
    const pw = risolvi(m.winner);
    const pl = risolvi(m.loser);
    if (!pw || !pl) {
      if (!pw) nonMappati.push(m.winner);
      if (!pl) nonMappati.push(m.loser);
      continue;
    }
    pool[[pw, pl].sort().join('|')] = { winner: pw, set: m.set };
  }
  return { pool, nonMappati };
}

/**
 * Propaga il tabellone: per ogni slot derivato cerca l'esito nel pool.
 * @param {Object} pool  esiti ESPN { "pidA|pidB" → {winner,set} }
 * @param {Object} [seed] risultati MANUALI (override admin) già confermati:
 *   { round: { mid: {vincitore,set,manuale:true} } }. Vengono usati per
 *   derivare gli accoppiamenti dei turni successivi e NON vengono MAI
 *   sovrascritti dagli esiti ESPN.
 */
function propagaBracket(pool, seed) {
  const result = { bracket: {} };

  // 1) Inietta gli override manuali (così i turni dopo derivano dai vincitori reali).
  if (seed) {
    for (const [r, matches] of Object.entries(seed)) {
      for (const [mid, m] of Object.entries(matches || {})) {
        if (!m || !m.vincitore) continue;
        if (!result.bracket[r]) result.bracket[r] = {};
        result.bracket[r][mid] = { ...m };
      }
    }
  }

  // 2) Propaga dagli esiti ESPN, senza toccare i match marcati manuale.
  for (const t of TURNI) {
    const r = t.id;
    for (let i = 0; i < t.matches; i++) {
      const mid = matchId(r, i);
      if (result.bracket[r] && result.bracket[r][mid] && result.bracket[r][mid].manuale) continue; // override protetto
      const { a, b } = getMatchPlayers(r, i, result, DB);
      if (!a || !b) continue;
      const hit = pool[[a, b].sort().join('|')];
      if (!hit) continue;
      if (!result.bracket[r]) result.bracket[r] = {};
      result.bracket[r][mid] = { vincitore: hit.winner, set: hit.set || '' };
    }
  }
  return result.bracket;
}

/**
 * Da match ESPN → bracket pronto da scrivere. Ritorna { bracket, nonMappati, nMatch }.
 * @param {Array}  espnMatches  match conclusi da ESPN
 * @param {Object} [seed]       override manuali da preservare/propagare
 */
function bracketDaMatches(espnMatches, seed) {
  const { pool, nonMappati } = costruisciPool(espnMatches);
  const bracket = propagaBracket(pool, seed);
  const nMatch = Object.values(bracket).reduce((s, r) => s + Object.keys(r).length, 0);
  return { bracket, nonMappati, nMatch };
}

module.exports = {
  ESPN_URL,
  fetchUsOpen,
  fetchEspnUsOpen,
  estraiMatches,
  estraiStati,
  parseCompetizione,
  norm,
  parseInterno,
  risolvi,
  costruisciPool,
  propagaBracket,
  bracketDaMatches,
};
