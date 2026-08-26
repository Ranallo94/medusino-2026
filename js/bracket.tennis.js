/**
 * MEDUSINO — bracket.js
 * Tabellone a eliminazione diretta da 128 (singolare maschile, best-of-5).
 *
 * Modello pronostici per ogni match:
 *   { vincitore: "<playerId>", set: "3-0" | "3-1" | "3-2" }
 *
 * Documento pronostici/{uid}:
 *   {
 *     bracket: { R128:{ "R128_01":{vincitore,set}, ... }, R64:{...}, ... F:{ "F_01":{vincitore,set} } },
 *     bonus:   { most_aces:"<playerId>", most_breaks:"<playerId>", ... },
 *     pronostico_nascosto: bool,
 *     updatedAt
 *   }
 *
 * Documento risultati/ufficiali: stessa forma (bracket + bonus reali), compilato dall'admin.
 */

// ── Turni del tabellone (dal primo turno alla finale) ────────────────────
// Ogni turno ha metà dei match del precedente: 64 → 32 → 16 → 8 → 4 → 2 → 1.
export const TURNI = [
  { id: 'R128', nome: '1º turno',    matches: 64 },
  { id: 'R64',  nome: '2º turno',    matches: 32 },
  { id: 'R32',  nome: '3º turno',    matches: 16 },
  { id: 'R16',  nome: 'Ottavi',      matches: 8  },
  { id: 'QF',   nome: 'Quarti',      matches: 4  },
  { id: 'SF',   nome: 'Semifinali',  matches: 2  },
  { id: 'F',    nome: 'Finale',      matches: 1  },
];

// Best-of-5: servono 3 set per vincere; esiti possibili = numero di set.
export const SET_WIN = 3;
export const SET_OPTIONS = ['3-0', '3-1', '3-2'];

const TURNO_INDEX = Object.fromEntries(TURNI.map((t, i) => [t.id, i]));

// ── Helper struttura tabellone ───────────────────────────────────────────

/** Numero di match in un turno. */
export function matchesPerRound(roundId) {
  const t = TURNI.find(t => t.id === roundId);
  return t ? t.matches : 0;
}

/** ID match: es. ('R64', 0) → "R64_01" (indice 0-based → numero 1-based). */
export function matchId(roundId, index) {
  return `${roundId}_${String(index + 1).padStart(2, '0')}`;
}

/** Indice 0-based di un matchId: "R64_03" → 2. */
export function matchIndex(mid) {
  return parseInt(mid.split('_')[1], 10) - 1;
}

/**
 * I due match del turno precedente che alimentano il match (roundId, index).
 * Albero binario standard: il match i è alimentato da 2i e 2i+1 del turno prima.
 * Ritorna null per il primo turno (R128), che è fissato dal sorteggio.
 */
export function feedMatches(roundId, index) {
  const ri = TURNO_INDEX[roundId];
  if (ri <= 0) return null;
  const prev = TURNI[ri - 1].id;
  return {
    prevRound: prev,
    a: matchId(prev, index * 2),
    b: matchId(prev, index * 2 + 1),
  };
}

// ── Risoluzione giocatori di un match dai pronostici ─────────────────────

/** Pronostico (vincitore/set) di un match, sicuro su forma Firestore. */
export function getPron(pron, roundId, mid) {
  return pron?.bracket?.[roundId]?.[mid] || null;
}

/**
 * I due giocatori (slotA, slotB) di un match secondo i pronostici dell'utente.
 * - R128: presi dal sorteggio (db.draw_R128).
 * - turni successivi: i vincitori pronosticati dei due match alimentatori.
 * Ritorna { a, b } con playerId o null se non ancora determinato.
 */
export function getMatchPlayers(roundId, index, pron, db) {
  if (roundId === 'R128') {
    const m = (db.draw_R128 || [])[index];
    return { a: m?.slotA || null, b: m?.slotB || null };
  }
  const feed = feedMatches(roundId, index);
  if (!feed) return { a: null, b: null };
  return {
    a: getPron(pron, feed.prevRound, feed.a)?.vincitore || null,
    b: getPron(pron, feed.prevRound, feed.b)?.vincitore || null,
  };
}

/**
 * Verifica di coerenza: ogni vincitore pronosticato in un turno deve essere uno
 * dei due giocatori effettivamente presenti in quel match (dai turni precedenti).
 * Ritorna array di errori { roundId, mid, msg } (vuoto = tutto coerente).
 */
export function verificaCoerenza(pron, db) {
  const errori = [];
  TURNI.forEach(t => {
    for (let i = 0; i < t.matches; i++) {
      const mid = matchId(t.id, i);
      const p = getPron(pron, t.id, mid);
      if (!p?.vincitore) continue;
      const { a, b } = getMatchPlayers(t.id, i, pron, db);
      if (p.vincitore !== a && p.vincitore !== b) {
        errori.push({ roundId: t.id, mid, msg: 'vincitore non coerente con i turni precedenti' });
      }
      if (p.set && !SET_OPTIONS.includes(p.set)) {
        errori.push({ roundId: t.id, mid, msg: `set "${p.set}" non valido` });
      }
    }
  });
  return errori;
}

/** Campione pronosticato (vincitore della finale). */
export function getCampione(pron) {
  return getPron(pron, 'F', 'F_01')?.vincitore || null;
}

// ── Render read-only del tabellone (per profilo.js) ──────────────────────
// Vista compatta: per turni grandi mostra solo i match compilati.

function nomeGiocatore(db, pid) {
  if (!pid) return '?';
  const g = db.giocatori?.[pid];
  if (!g) return pid;
  const seed = g.seed ? ` [${g.seed}]` : '';
  return (g.nome || pid) + seed;
}

export function renderTabellone(container, pron, db) {
  if (!container) return;
  let html = '<div class="tb-tennis">';

  TURNI.forEach(t => {
    const righe = [];
    for (let i = 0; i < t.matches; i++) {
      const mid = matchId(t.id, i);
      const p = getPron(pron, t.id, mid);
      if (!p?.vincitore) continue; // mostra solo i pronostici compilati
      const { a, b } = getMatchPlayers(t.id, i, pron, db);
      const mkTeam = (pid) => {
        const win = p.vincitore === pid ? ' tb-winner' : '';
        return `<span class="tb-team${win}">${nomeGiocatore(db, pid)}</span>`;
      };
      righe.push(
        `<div class="tb-match">${mkTeam(a)}<span class="tb-vs">vs</span>${mkTeam(b)}` +
        `<span class="tb-set">${p.set || ''}</span></div>`
      );
    }
    if (!righe.length) return;
    html += `<div class="tb-round"><h4>${t.nome}</h4>${righe.join('')}</div>`;
  });

  const camp = getCampione(pron);
  if (camp) html += `<div class="tb-campione">🏆 ${nomeGiocatore(db, camp)}</div>`;

  html += '</div>';
  container.innerHTML = html;
}

// ── Render read-only dei bonus (per profilo.js) ──────────────────────────
export function renderBonus(container, pron, db) {
  if (!container) return;
  const cats = db.bonus || [];
  if (!cats.length) { container.innerHTML = ''; return; }
  let html = '<div class="bonus-list"><h4>Bonus fine torneo</h4>';
  cats.forEach(c => {
    const pid = pron?.bonus?.[c.id];
    html += `<div class="bonus-row"><span class="bonus-label">${c.label}</span>` +
            `<span class="bonus-val">${pid ? nomeGiocatore(db, pid) : '—'}</span></div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}
