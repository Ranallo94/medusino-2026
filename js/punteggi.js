/**
 * MEDUSINO — punteggi.js
 * Motore di calcolo punteggi per il tabellone tennis (128, best-of-5).
 *
 * Scoring "per giocatore" (forgiving): per ogni turno conta QUALI giocatori
 * hai dato come vincitori e che hanno davvero vinto in quel turno — a
 * prescindere dall'avversario reale. Il bonus set premia il numero di set
 * esatto, solo se anche il vincitore è corretto.
 */
import { TURNI } from './bracket.js';

// Schema "Finale calda": i turni finali pesano di piu, per tenere la classifica
// aperta fino all'ultima partita. (Primi 2 turni ~45% dei punti, ultimi 3 ~28%.)
export const WINNER_POINTS = { R128: 1, R64: 2, R32: 5, R16: 12, QF: 30, SF: 75, F: 180 };
export const SET_POINTS    = { R128: 1, R64: 1, R32: 2, R16: 4,  QF: 10, SF: 25, F: 60  };
export const BONUS_STAT_DEFAULT = 25;

function vincitoriTurno(doc, roundId) {
  const out = {};
  const matches = doc?.bracket?.[roundId] || {};
  Object.values(matches).forEach(m => {
    if (m && m.vincitore) out[m.vincitore] = m.set || null;
  });
  return out;
}

export function calcolaPunteggio(pron, risultati, db) {
  const breakdown = { esiti: 0, set: 0, bonus: 0, perTurno: {} };
  const tie = { campione: 0, finalisti: 0, semifinalisti: 0, quarti: 0, setEsatti: 0, bonusStat: 0 };

  TURNI.forEach(t => {
    const r = t.id;
    const reali  = vincitoriTurno(risultati, r);
    const scelti = vincitoriTurno(pron, r);
    let esiti = 0, set = 0, nGiusti = 0, nSet = 0;
    Object.keys(scelti).forEach(pid => {
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
  (db?.bonus || []).forEach(c => {
    const scelto = pron?.bonus?.[c.id];
    const reale  = risultati?.bonus?.[c.id];
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
