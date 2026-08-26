/**
 * MEDUSINO — live.js
 * Pagina "Risultati": risultati UFFICIALI del torneo, in sola lettura.
 *
 * I risultati sono in Firestore (risultati/ufficiali), aggiornati automaticamente
 * dalla Cloud Function di sync ESPN (ogni 2–15 min) + eventuali correzioni admin.
 * Hanno la stessa forma dei pronostici: { bracket: {R128:{...},…}, bonus:{…} }.
 *
 * Struttura della pagina (coerente con la scheda Pronostici, ma read-only):
 *   • tab per turno (1º turno → Finale): elenco partite concluse con vincitore + set
 *   • tab Tabellone: bracket grafico completo con i risultati reali
 *   • tab Bonus: esiti delle categorie bonus di fine torneo
 *   • header con badge LIVE (partite in corso) e orario dell'ultimo aggiornamento
 */

import { onRisultatiSnapshot, onSistemaSnapshot } from './db.js';
import { caricaEvento, nomeGiocatore } from './evento.js';
import {
  TURNI, matchId, getPron, getMatchPlayers,
  renderBracketGrafico, renderBonus, renderClassifiche,
} from './bracket.js';
import { rankBadge, infoBtn, openSchedaGiocatore } from './giocatore.js';
import { formatDate } from './ui.js';

let _db = null;
let _ris = null;            // risultati ufficiali correnti
let _built = false;
let _activeRound = 'R128';
let _ultimoSync = null;     // Date dell'ultimo sync ESPN (da sistema/config)
let _unsubRis = null;
let _unsubSist = null;

// ── INIT ──────────────────────────────────────────────
export async function initLive() {
  const page = document.getElementById('page-live');
  if (!page) return;

  try {
    _db = await caricaEvento();
  } catch (err) {
    page.innerHTML =
      `<div class="empty-state"><div class="empty-icon">⚠️</div>` +
      `<p>Impossibile caricare il tabellone dell'evento.</p></div>`;
    return;
  }

  _buildShell();
  _built = true;

  // Risultati ufficiali in tempo reale
  if (_unsubRis) _unsubRis();
  _unsubRis = onRisultatiSnapshot((ris) => {
    _ris = ris || {};
    if (!_ris.bracket) _ris.bracket = {};
    if (!_ris.bonus)   _ris.bonus = {};
    _renderAttivo();
    _renderUpdated();
  });

  // Stato sistema (LIVE + ultimo sync) in tempo reale
  if (_unsubSist) _unsubSist();
  _unsubSist = onSistemaSnapshot((cfg) => _renderStato(cfg));
}

export function cleanupLive() {
  if (_unsubRis)  { _unsubRis();  _unsubRis = null; }
  if (_unsubSist) { _unsubSist(); _unsubSist = null; }
  _built = false;
  _ris = null;
}

// ── SHELL (header + tab + contenitori) ────────────────
function _buildShell() {
  const page = document.getElementById('page-live');

  const tabsHtml = TURNI.map((t, i) =>
    `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-tab="ris-${t.id}" data-round="${t.id}">${t.nome}</button>`
  ).join('') +
    `<button type="button" class="tab" data-tab="ris-BRACKET" data-round="BRACKET">🗺️ Tabellone</button>` +
    `<button type="button" class="tab" data-tab="ris-BONUS" data-round="BONUS">🏆 Bonus</button>`;

  const contentsHtml = TURNI.map((t, i) =>
    `<div id="ris-${t.id}" class="tab-content${i === 0 ? ' active' : ''}">
       <div class="round-head"><h3 class="section-title">${t.nome}</h3>
         <span class="round-progress" id="risprog-${t.id}"></span></div>
       <div id="risround-${t.id}" class="round-matches"></div>
     </div>`
  ).join('') +
    `<div id="ris-BRACKET" class="tab-content">
       <div class="round-head"><h3 class="section-title">🗺️ Tabellone completo</h3>
         <span class="round-progress-note">Risultati ufficiali · scorri per esplorare</span></div>
       <div id="ris-bracket-grafico"></div>
     </div>` +
    `<div id="ris-BONUS" class="tab-content">
       <div class="round-head"><h3 class="section-title">🏆 Bonus fine torneo</h3></div>
       <div id="ris-bonus-box"></div>
       <div id="ris-classifiche-box" class="clf-outer"></div>
     </div>`;

  page.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">📊 Risultati</h2>
      <span id="ris-status" class="page-subtitle">Risultati ufficiali del torneo</span>
    </div>
    <div id="ris-live-bar" class="ris-live-bar" style="display:none"></div>
    <div class="tab-bar" id="risultati-tabs">${tabsHtml}</div>
    ${contentsHtml}
  `;

  // Cambio tab → memorizza il turno attivo e ridisegna (il toggle visivo
  // della tab è gestito dal listener globale in app.js).
  page.querySelectorAll('#risultati-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _activeRound = tab.dataset.round;
      _renderAttivo();
    });
  });
}

// ── RENDER ────────────────────────────────────────────
/** Ridisegna solo la tab attualmente attiva. */
function _renderAttivo() {
  if (!_built || !_ris) return;
  if (_activeRound === 'BONUS') {
    renderBonus(document.getElementById('ris-bonus-box'), _ris, _db);
    renderClassifiche(document.getElementById('ris-classifiche-box'), _ris, _db);
  } else if (_activeRound === 'BRACKET') {
    renderBracketGrafico(document.getElementById('ris-bracket-grafico'), _ris, _db);
  } else {
    _renderRound(_activeRound);
  }
}

/** Elenco read-only delle partite di un turno. */
function _renderRound(roundId) {
  const box = document.getElementById('risround-' + roundId);
  if (!box) return;
  const t = TURNI.find(x => x.id === roundId);
  if (!t) return;

  let html = '';
  let conclusi = 0;

  for (let i = 0; i < t.matches; i++) {
    const mid = matchId(roundId, i);
    const { a, b } = getMatchPlayers(roundId, i, _ris, _db);
    const p = getPron(_ris, roundId, mid);
    const vinc = (p && (p.vincitore === a || p.vincitore === b)) ? p.vincitore : null;
    if (vinc) conclusi++;

    // Accoppiamento non ancora determinato (turno precedente incompleto)
    if (!a && !b) {
      html += `<div class="match-card match-locked">
        <span class="match-num">${i + 1}</span>
        <span class="match-locked-msg">In attesa del turno precedente</span></div>`;
      continue;
    }

    // Giocatore in sola lettura: testo statico (non un pulsante). L'unico
    // elemento interattivo è la ⓘ che apre la scheda giocatore.
    const side = (pid) => {
      if (!pid) {
        return `<div class="match-side"><span class="ris-player ris-player--empty">—</span></div>`;
      }
      const isWin  = vinc === pid;
      const isLose = vinc && !isWin;
      const cls = 'ris-player' + (isWin ? ' ris-player--win' : '') + (isLose ? ' ris-player--lose' : '');
      return `<div class="match-side">
        <span class="${cls}">
          <span class="mt-name">${isWin ? '🏆 ' : ''}${nomeGiocatore(_db, pid)}</span>${rankBadge(_db, pid)}
        </span>
        ${infoBtn(pid)}
      </div>`;
    };

    // Slot del set: punteggio statico (non un selettore), altrimenti stato.
    let setSlot;
    if (vinc) {
      setSlot = p.set
        ? `<span class="ris-set-label">set</span><span class="ris-set-score">${p.set}</span>`
        : `<span class="ris-pending">concluso</span>`;
    } else {
      setSlot = `<span class="ris-pending">in programma</span>`;
    }

    html += `<div class="match-card${vinc ? ' match-done' : ''}">
      <span class="match-num">${i + 1}</span>
      <div class="match-teams">${side(a)}<span class="match-vs">vs</span>${side(b)}</div>
      <div class="match-set">${setSlot}</div>
    </div>`;
  }

  box.innerHTML = html;

  const prog = document.getElementById('risprog-' + roundId);
  if (prog) prog.textContent = `${conclusi}/${t.matches}`;

  // Scheda giocatore (modal con forma live ESPN)
  box.querySelectorAll('.player-info-btn[data-info]').forEach(btn => {
    btn.addEventListener('click', () => openSchedaGiocatore(_db, btn.dataset.info));
  });
}

// ── STATO LIVE / ULTIMO AGGIORNAMENTO ─────────────────
function _renderStato(cfg) {
  const live = (cfg && cfg.sync_log && cfg.sync_log.live) || 0;

  // Badge LIVE nella barra di navigazione
  const navBadge = document.getElementById('nav-live-badge');
  if (navBadge) navBadge.style.display = live > 0 ? '' : 'none';

  // Barra LIVE in pagina
  const bar = document.getElementById('ris-live-bar');
  if (bar) {
    if (live > 0) {
      const txt = live === 1 ? '1 partita in corso' : `${live} partite in corso`;
      bar.innerHTML = `<span class="ris-live-dot"></span><span class="ris-live-text">LIVE · ${txt}</span>`;
      bar.style.display = '';
    } else {
      bar.style.display = 'none';
    }
  }

  // Orario ultimo sync ESPN
  _ultimoSync = (cfg && cfg.ultimo_sync && typeof cfg.ultimo_sync.toDate === 'function')
    ? cfg.ultimo_sync.toDate() : _ultimoSync;
  _renderUpdated();
}

function _renderUpdated() {
  const el = document.getElementById('ris-status');
  if (!el) return;
  el.textContent = _ultimoSync
    ? `Aggiornato: ${formatDate(_ultimoSync.toISOString(), true)}`
    : 'Risultati ufficiali del torneo';
}
