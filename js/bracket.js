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

// ── Percorso di un giocatore nel pronostico ──────────────────────────────
/**
 * Ricostruisce il cammino di un giocatore turno per turno dentro un bracket.
 * Per ogni turno in cui compare dice se è stato dato vincente, contro chi e
 * con che punteggio; si ferma al turno in cui viene eliminato.
 * @returns {Array<{turno:string, nome:string, avversario:string|null, vince:boolean, set:string|null}>}
 */
export function percorsoGiocatore(pron, db, pid) {
  const tappe = [];
  for (const t of TURNI) {
    for (let i = 0; i < t.matches; i++) {
      const { a, b } = getMatchPlayers(t.id, i, pron, db);
      if (a !== pid && b !== pid) continue;
      const p = getPron(pron, t.id, matchId(t.id, i));
      const vince = !!(p && p.vincitore === pid);
      tappe.push({
        turno: t.id,
        nome: t.nome,
        avversario: a === pid ? b : a,
        vince,
        set: vince ? (p.set || null) : null,
      });
      break;
    }
    // se in questo turno non compare più, il cammino è finito
    if (!tappe.length || tappe[tappe.length - 1].turno !== t.id) break;
    if (!tappe[tappe.length - 1].vince) break;
  }
  return tappe;
}

// ── Render GRAFICO del tabellone completo (percorsi) ─────────────────────
// Albero a eliminazione diretta da 128 con connettori SVG, scorrevole in
// orizzontale. Il layout verticale si ricalcola in base al turno più a
// sinistra visibile: scorrendo verso la finale il tabellone si compatta
// (da ~3.300 px a poche centinaia). I chip dei turni seguono lo scroll e,
// se cliccati, portano al turno corrispondente.
// `realWinners` (opzionale) = { roundId: Set(playerId) } dei vincitori reali.
// `evidenzia` (opzionale) = playerId da mettere in risalto lungo il percorso.
export function renderBracketGrafico(container, pron, db, realWinners, evidenzia) {
  if (!container) return;

  const COL_W = 184, BOX_W = COL_W - 22, PAD_X = 6;
  const MATCH_H = 42, VGAP = 10, PAD_TOP = 32, ROW = MATCH_H + VGAP;
  const CHAMP_W = 150;
  const N = TURNI.length;

  // ── Costruzione statica del DOM (una sola volta) ──────────────────────
  const chips = TURNI.map((t, ri) =>
    `<button type="button" class="bk-chip" data-ri="${ri}">${t.nome}</button>`).join('');

  let heads = TURNI.map((t, ri) =>
    `<div class="bk-head" data-ri="${ri}" style="left:${ri * COL_W + PAD_X}px;width:${BOX_W}px">${t.nome}</div>`).join('');
  heads += `<div class="bk-head bk-head--champ" style="left:${N * COL_W + 8}px;width:${CHAMP_W - 16}px">Campione</div>`;

  // Slot con giocatore sostituito: segnalati, non assegnano punti
  const annullati = new Set((db?.sostituiti || []).map(x => (typeof x === 'string' ? x : x.pid)));
  const champ = getCampione(pron);
  let boxes = '';
  TURNI.forEach((t, ri) => {
    for (let i = 0; i < t.matches; i++) {
      const { a, b } = getMatchPlayers(t.id, i, pron, db);
      const p = getPron(pron, t.id, matchId(t.id, i));
      const win = (p && (p.vincitore === a || p.vincitore === b)) ? p.vincitore : null;
      const slot = (pid) => {
        if (!pid) return `<div class="bk-slot bk-empty">·</div>`;
        let c = win === pid ? ' bk-win' : (win ? ' bk-lose' : '');
        if (annullati.has(pid)) c += ' bk-annullato';
        if (realWinners && win === pid && realWinners[t.id] && realWinners[t.id].has(pid)) c += ' bk-correct';
        if (evidenzia && pid === evidenzia) c += ' bk-hi';
        return `<div class="bk-slot${c}" data-pid="${pid}" title="${nomeGiocatore(db, pid)}">${nomeGiocatore(db, pid)}</div>`;
      };
      boxes += `<div class="bk-match" data-ri="${ri}" data-i="${i}" ` +
               `style="left:${ri * COL_W + PAD_X}px;width:${BOX_W}px;height:${MATCH_H}px">${slot(a)}${slot(b)}</div>`;
    }
  });
  if (champ) {
    boxes += `<div class="bk-champ" data-ri="${N}" style="left:${N * COL_W + 8}px;width:${CHAMP_W - 16}px">` +
             `🏆 ${nomeGiocatore(db, champ)}</div>`;
  }

  container.innerHTML = `
    <div class="bk-chips" role="tablist">${chips}</div>
    <div class="bk-scroll">
      <div class="bk-canvas">
        <div class="bk-heads">${heads}</div>
        <svg class="bk-svg"></svg>
        ${boxes}
      </div>
    </div>`;

  const scroller = container.querySelector('.bk-scroll');
  const canvas   = container.querySelector('.bk-canvas');
  const svg      = container.querySelector('.bk-svg');
  const chipEls  = [...container.querySelectorAll('.bk-chip')];
  const headEls  = [...container.querySelectorAll('.bk-head[data-ri]')];
  const champEl  = container.querySelector('.bk-champ');
  const matchEls = {};
  container.querySelectorAll('.bk-match').forEach(el => {
    (matchEls[el.dataset.ri] ||= [])[+el.dataset.i] = el;
  });

  let base = -1;

  // ── Rilayout verticale a partire dal turno `b` ────────────────────────
  function layout(b) {
    if (b === base) return;
    base = b;

    const centers = {};
    const n0 = TURNI[b].matches;
    centers[b] = [];
    for (let i = 0; i < n0; i++) centers[b][i] = PAD_TOP + i * ROW + MATCH_H / 2;
    for (let ri = b + 1; ri < N; ri++) {
      centers[ri] = [];
      for (let i = 0; i < TURNI[ri].matches; i++) {
        centers[ri][i] = (centers[ri - 1][2 * i] + centers[ri - 1][2 * i + 1]) / 2;
      }
    }

    const H = PAD_TOP * 2 + n0 * ROW;
    const W = Math.max(N * COL_W + CHAMP_W, (N - 1) * COL_W + scroller.clientWidth);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // Posizioni dei box; i turni precedenti alla base spariscono
    TURNI.forEach((t, ri) => {
      const els = matchEls[ri] || [];
      for (let i = 0; i < t.matches; i++) {
        const el = els[i];
        if (!el) continue;
        if (ri < b) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.top = (centers[ri][i] - MATCH_H / 2) + 'px';
      }
    });
    headEls.forEach((el, ri) => { el.classList.toggle('bk-head--off', ri < b); });
    if (champEl) champEl.style.top = (centers[N - 1][0] - 18) + 'px';

    // Connettori
    let paths = '';
    for (let ri = b + 1; ri < N; ri++) {
      const childRightX = (ri - 1) * COL_W + PAD_X + BOX_W;
      const parentLeftX = ri * COL_W + PAD_X;
      const midX = (childRightX + parentLeftX) / 2;
      for (let i = 0; i < TURNI[ri].matches; i++) {
        const py = centers[ri][i];
        [2 * i, 2 * i + 1].forEach(f => {
          paths += `<path d="M${childRightX},${centers[ri - 1][f]} H${midX} V${py} H${parentLeftX}" class="bk-link"/>`;
        });
      }
    }
    if (champEl) {
      const fY = centers[N - 1][0];
      const fRightX = (N - 1) * COL_W + PAD_X + BOX_W;
      paths += `<path d="M${fRightX},${fY} H${fRightX + 24}" class="bk-link bk-link--champ"/>`;
    }
    svg.innerHTML = paths;

    chipEls.forEach((c, ri) => c.classList.toggle('active', ri === b));
  }

  // ── Scroll → aggiorna la base (throttle con rAF) ──────────────────────
  let atteso = false;
  function onScroll() {
    if (atteso) return;
    atteso = true;
    requestAnimationFrame(() => {
      atteso = false;
      const b = Math.min(N - 1, Math.max(0, Math.floor((scroller.scrollLeft + COL_W * 0.55) / COL_W)));
      layout(b);
    });
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { const b = base; base = -1; layout(b); });

  /** Porta lo scroll orizzontale al turno `ri`, con fallback se scrollTo manca. */
  function scrollAlTurno(ri) {
    const x = ri * COL_W;
    if (typeof scroller.scrollTo === 'function') {
      try { scroller.scrollTo({ left: x, behavior: 'smooth' }); return; } catch (_) { /* fallback */ }
    }
    scroller.scrollLeft = x;
  }

  chipEls.forEach((c, ri) => {
    c.addEventListener('click', () => { scrollAlTurno(ri); layout(ri); });
  });

  layout(0);
  return {
    /** Porta la vista sul turno indicato (id o indice). */
    vaiA(round) {
      const ri = typeof round === 'number' ? round : TURNI.findIndex(t => t.id === round);
      if (ri >= 0) { scrollAlTurno(ri); layout(ri); }
    },
  };
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

// ── Classifiche statistiche (ace / break / tie-break) ────────────────────
// Categorie delle classifiche informative mostrate nel tab Risultati › Bonus.
// I dati stanno in risultati/ufficiali.classifiche = { aces:[{pid,v}], breaks:[…], tiebreaks:[…] }.
export const CLASSIFICHE = [
  { id: 'aces',      emoji: '🎾', label: 'Ace' },
  { id: 'breaks',    emoji: '💥', label: 'Break' },
  { id: 'tiebreaks', emoji: '🔥', label: 'Tie-break' },
];

/**
 * Render read-only delle tre classifiche (ace/break/tie-break).
 * Ordina ogni classifica per valore decrescente. Se non c'è nessun dato,
 * lascia il contenitore vuoto (non mostra nulla).
 * @param {HTMLElement} container
 * @param {Object} ris  documento risultati ufficiali ({ …, classifiche })
 * @param {Object} db   DB evento (per i nomi giocatore)
 */
export function renderClassifiche(container, ris, db) {
  if (!container) return;
  const clf = (ris && ris.classifiche) || {};
  const hasAny = CLASSIFICHE.some(c => Array.isArray(clf[c.id]) && clf[c.id].some(r => r && r.pid));
  if (!hasAny) { container.innerHTML = ''; return; }

  let html = '<div class="clf-wrap"><h4 class="clf-heading">📊 Classifiche</h4><div class="clf-grid">';
  CLASSIFICHE.forEach(c => {
    const rows = (clf[c.id] || [])
      .filter(r => r && r.pid)
      .slice()
      .sort((a, b) => (b.v == null ? -Infinity : b.v) - (a.v == null ? -Infinity : a.v));
    if (!rows.length) return;
    html += `<div class="clf-card">
      <h5 class="clf-title">${c.emoji} ${c.label}</h5>
      <ol class="clf-list">` +
      rows.map((r, i) => `<li class="clf-row${i < 3 ? ' clf-row--top clf-row--' + (i + 1) : ''}">
        <span class="clf-pos">${i + 1}</span>
        <span class="clf-name">${nomeGiocatore(db, r.pid)}</span>
        <span class="clf-val">${r.v == null ? '' : r.v}</span>
      </li>`).join('') +
      `</ol></div>`;
  });
  html += '</div></div>';
  container.innerHTML = html;
}
