/**
 * MEDUSINO — functions/punteggi.js  (CommonJS, usato dalle Cloud Functions)
 * Porting fedele di js/punteggi.js + js/bracket.js (solo le parti necessarie),
 * adattato a CommonJS perché le Cloud Functions non usano i moduli ES.
 *
 * Scoring "per giocatore" (forgiving): per ogni turno conta QUALI giocatori
 * hai dato vincitori e che hanno davvero vinto in quel turno, a prescindere
 * dall'avversario reale. Il bonus set premia il numero di set esatto, solo se
 * anche il vincitore è corretto.
 */
'use strict';

const DB = require('./usopen_db.json');

// ── BRACKET HELPERS (porting da js/bracket.js) ────────────────────────
const TURNI = DB.turni; // [{id:'R128',nome:'1º turno',matches:64}, ... 'F']
const SET_OPTIONS = DB.setOptions || ['3-0', '3-1', '3-2'];
const TURNO_INDEX = Object.fromEntries(TURNI.map((t, i) => [t.id, i]));

/** id stabile di un match: ("R64", 2) → "R64_03" (1-based, 2 cifre). */
function matchId(roundId, index) {
  return `${roundId}_${String(index + 1).padStart(2, '0')}`;
}

/** I due match del turno precedente che alimentano (roundId, index). */
function feedMatches(roundId, index) {
  const ri = TURNO_INDEX[roundId];
  if (ri == null || ri === 0) return null;
  const prev = TURNI[ri - 1].id;
  return { prevRound: prev, a: matchId(prev, index * 2), b: matchId(prev, index * 2 + 1) };
}

/** Cella (pronostico/risultato) di un match: doc.bracket[round][mid]. */
function getCell(doc, roundId, mid) {
  return doc && doc.bracket && doc.bracket[roundId] ? doc.bracket[roundId][mid] : null;
}

/** I due giocatori (pid) che si affrontano in (roundId, index), derivati dai turni precedenti. */
function getMatchPlayers(roundId, index, doc, db) {
  if (roundId === 'R128') {
    const m = ((db || DB).draw_R128 || [])[index];
    return { a: (m && m.slotA) || null, b: (m && m.slotB) || null };
  }
  const feed = feedMatches(roundId, index);
  if (!feed) return { a: null, b: null };
  const ca = getCell(doc, feed.prevRound, feed.a);
  const cb = getCell(doc, feed.prevRound, feed.b);
  return { a: (ca && ca.vincitore) || null, b: (cb && cb.vincitore) || null };
}

// ── PUNTEGGI (porting da js/punteggi.js) ──────────────────────────────
// Schema "Finale calda" (allineato a js/punteggi.js): turni finali piu pesanti.
const WINNER_POINTS = { R128: 1, R64: 2, R32: 5, R16: 12, QF: 28, SF: 55, F: 100 };
const SET_POINTS    = { R128: 1, R64: 1, R32: 2, R16: 4,  QF: 9,  SF: 14, F: 20  };
const BONUS_STAT_DEFAULT = 15;

function vincitoriTurno(doc, roundId) {
  const out = {};
  const matches = (doc && doc.bracket && doc.bracket[roundId]) || {};
  Object.values(matches).forEach((m) => {
    if (m && m.vincitore) out[m.vincitore] = m.set || null;
  });
  return out;
}

/**
 * Calcola il punteggio di un partecipante.
 * @param {Object} pron       pronostici { bracket:{...}, bonus:{...} }
 * @param {Object} risultati  risultati ufficiali { bracket:{...}, bonus:{...} }
 * @param {Object} db         usopen_db (per le categorie bonus)
 */
function calcolaPunteggio(pron, risultati, db) {
  const breakdown = { esiti: 0, set: 0, bonus: 0, perTurno: {} };
  const tie = { campione: 0, finalisti: 0, semifinalisti: 0, quarti: 0, setEsatti: 0, bonusStat: 0 };

  TURNI.forEach((t) => {
    const r = t.id;
    const reali  = vincitoriTurno(risultati, r);
    const scelti = vincitoriTurno(pron, r);
    let esiti = 0, set = 0, nGiusti = 0, nSet = 0;
    Object.keys(scelti).forEach((pid) => {
      if (Object.prototype.hasOwnProperty.call(reali, pid)) {
        esiti += WINNER_POINTS[r];
        nGiusti++;
        if (scelti[pid] && reali[pid] && scelti[pid] === reali[pid]) {
          set += SET_POINTS[r];
          nSet++;
        }
      }
    });
    breakdown.perTurno[r] = { esiti, set, indovinati: nGiusti };
    breakdown.esiti += esiti;
    breakdown.set   += set;
    tie.setEsatti   += nSet;
    if (r === 'F')   tie.campione      = nGiusti;
    if (r === 'SF')  tie.finalisti     = nGiusti;
    if (r === 'QF')  tie.semifinalisti = nGiusti;
    if (r === 'R16') tie.quarti        = nGiusti;
  });

  let bonusPts = 0, bonusOk = 0;
  ((db || DB).bonus || []).forEach((c) => {
    const scelto = pron && pron.bonus ? pron.bonus[c.id] : null;
    const reale  = risultati && risultati.bonus ? risultati.bonus[c.id] : null;
    if (scelto && reale && scelto === reale) {
      bonusPts += (c.punti || BONUS_STAT_DEFAULT);
      bonusOk++;
    }
  });
  breakdown.bonus = bonusPts;
  tie.bonusStat   = bonusOk;

  const totale = breakdown.esiti + breakdown.set + breakdown.bonus;
  const spareggio = [tie.campione, tie.finalisti, tie.semifinalisti, tie.quarti, tie.setEsatti, tie.bonusStat];
  return { totale, breakdown, spareggio };
}

module.exports = {
  DB,
  TURNI,
  SET_OPTIONS,
  matchId,
  feedMatches,
  getMatchPlayers,
  calcolaPunteggio,
  WINNER_POINTS,
  SET_POINTS,
};
