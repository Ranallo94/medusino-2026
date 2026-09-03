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

// Schema "Finale ridotta" (US Open 2026). Rispetto a Wimbledon la finale scende
// da 180+60 a 100+20 punti: pesava il 21% del montepremi punti e valeva 2,3 volte
// il distacco 1º-5º pre-finale, ora il 12,7% e 1,45 volte. Quarti e semifinali sono
// scesi solo di poco (30→28, 75→55) apposta: comprimerli di piu' restringerebbe la
// classifica e farebbe pesare di nuovo la finale. Verificato su 2.500 tornei simulati.
// I bonus statistici scendono da 25 a 15 punti l'uno: a 25 ribaltavano da soli il
// vincitore nel 13,5% dei tornei, a 15 nell'8%. Un bonus vale comunque piu' del bonus
// set di un quarto di finale, quindi resta un premio per cui vale la pena ragionarci.
export const WINNER_POINTS = { R128: 1, R64: 2, R32: 5, R16: 12, QF: 28, SF: 55, F: 100 };
export const SET_POINTS    = { R128: 1, R64: 1, R32: 2, R16: 4,  QF: 9,  SF: 14, F: 20  };
export const BONUS_STAT_DEFAULT = 15;

function vincitoriTurno(doc, roundId) {
  const out = {};
  const matches = doc?.bracket?.[roundId] || {};
  Object.values(matches).forEach(m => {
    if (m && m.vincitore) out[m.vincitore] = m.set || null;
  });
  return out;
}

export function calcolaPunteggio(pron, risultati, db) {
  // Slot in cui il giocatore si e' ritirato dopo la chiusura dei pronostici ed e'
  // stato rimpiazzato da un lucky loser. Chi li aveva scelti non prende punti in
  // nessun turno: aveva pronosticato un altro giocatore.
  const annullati = new Set((db?.sostituiti || []).map(s => (typeof s === 'string' ? s : s.pid)));
  const breakdown = { esiti: 0, set: 0, bonus: 0, perTurno: {} };
  const tie = { campione: 0, finalisti: 0, semifinalisti: 0, quarti: 0, setEsatti: 0, bonusStat: 0 };

  TURNI.forEach(t => {
    const r = t.id;
    const reali  = vincitoriTurno(risultati, r);
    const scelti = vincitoriTurno(pron, r);
    let esiti = 0, set = 0, nGiusti = 0, nSet = 0;
    Object.keys(scelti).forEach(pid => {
      if (annullati.has(pid)) return;   // slot annullato: nessun punto, nemmeno se il sostituto vince
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
