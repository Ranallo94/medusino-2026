/**
 * MEDUSINO — evento.js
 * Caricamento (con cache) del DB locale dell'evento (usopen_db.json):
 * struttura turni, sorteggio del 1º turno (draw_R128), anagrafica giocatori e
 * categorie bonus. Tutti i moduli che hanno bisogno del tabellone passano da qui.
 */

let _cache = null;
let _inflight = null;

/**
 * Carica il DB evento una sola volta e lo cachea.
 * @returns {Promise<Object>}
 */
export async function caricaEvento() {
  if (_cache) return _cache;
  if (_inflight) return _inflight;
  _inflight = fetch('./usopen_db.json', { cache: 'no-cache' })
    .then(r => {
      if (!r.ok) throw new Error('Impossibile caricare usopen_db.json (' + r.status + ')');
      return r.json();
    })
    .then(j => { _cache = j; _inflight = null; return j; })
    .catch(err => { _inflight = null; throw err; });
  return _inflight;
}

/** DB già caricato (o null). Per accesso sincrono dopo caricaEvento(). */
export function eventoDb() {
  return _cache;
}

/**
 * Nome leggibile di un giocatore: "Cognome [seed]" oppure l'id se non noto.
 * @param {Object} db   DB evento
 * @param {string} pid  id giocatore (es. "p001")
 */
export function nomeGiocatore(db, pid) {
  if (!pid) return '?';
  const g = db?.giocatori?.[pid];
  if (!g || !g.nome) return pid; // nomi non ancora inseriti → mostra l'id
  const seed = g.seed ? ` [${g.seed}]` : '';
  return g.nome + seed;
}

/** Bandiera/etichetta nazionalità (stringa breve), se presente. */
export function nazGiocatore(db, pid) {
  const g = db?.giocatori?.[pid];
  return g?.naz || '';
}
