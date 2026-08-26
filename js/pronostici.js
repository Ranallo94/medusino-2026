/**
 * MEDUSINO — pronostici.js
 * Scheda pronostici del tabellone tennis (128, best-of-5).
 *
 * Per ogni turno l'utente indica, partita per partita, il vincitore e (facoltativo)
 * il numero di set. Gli accoppiamenti del 1º turno vengono dal sorteggio
 * (db.draw_R128); nei turni successivi i due giocatori di ogni match sono i
 * vincitori pronosticati dall'utente nei due match alimentatori del turno
 * precedente. In coda, le categorie bonus "fine torneo".
 *
 * Documento salvato: pronostici/{uid} = { bracket, bonus, pronostico_nascosto, updatedAt }
 */

import { STATE } from './app.js';
import { getPronostici, savePronostici, onSistemaSnapshot } from './db.js';
import { caricaEvento, nomeGiocatore } from './evento.js';
import {
  TURNI, SET_OPTIONS, matchId, matchIndex, getPron, getMatchPlayers, renderBracketGrafico,
} from './bracket.js';
import { showToast } from './ui.js';
import { rankBadge, infoBtn, openSchedaGiocatore } from './giocatore.js';

let _db = null;
let _pron = null;          // copia di lavoro dei pronostici dell'utente
let _aperti = true;        // pronostici aperti/chiusi (da sistema/config)
let _unsubSistema = null;
let _built = false;

// ── INIT / CLEANUP ────────────────────────────────────
export async function initPronostici() {
  const page = document.getElementById('page-pronostici');
  if (!page) return;

  try {
    _db = await caricaEvento();
  } catch (err) {
    page.innerHTML = _errBox('Impossibile caricare il tabellone dell\'evento.', err.message);
    return;
  }

  // Carica i pronostici salvati dell'utente
  _pron = (await getPronostici(STATE.utente.id)) || {};
  if (!_pron.bracket) _pron.bracket = {};
  if (!_pron.bonus)   _pron.bonus = {};

  _buildShell();
  _built = true;

  // Stato apertura/chiusura in tempo reale
  if (_unsubSistema) _unsubSistema();
  _unsubSistema = onSistemaSnapshot((cfg) => {
    _aperti = cfg?.pronostici_aperti !== false;
    STATE.pronosticiAperti = _aperti;
    _applyLockState();
  });

  // Render iniziale di tutti i turni + bonus
  TURNI.forEach(t => _renderRound(t.id));
  _renderBonus();
}

export function cleanupPronostici() {
  if (_unsubSistema) { _unsubSistema(); _unsubSistema = null; }
  _built = false;
  _pron = null;
}

// ── SHELL (header + tab + contenitori) ────────────────
function _buildShell() {
  const page = document.getElementById('page-pronostici');

  const tabsHtml = TURNI.map((t, i) =>
    `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-tab="pron-${t.id}" data-round="${t.id}">${t.nome}</button>`
  ).join('') +
    `<button type="button" class="tab" data-tab="pron-BRACKET" data-round="BRACKET">🗺️ Tabellone</button>` +
    `<button type="button" class="tab" data-tab="pron-BONUS" data-round="BONUS">🏆 Bonus</button>`;

  const contentsHtml = TURNI.map((t, i) =>
    `<div id="pron-${t.id}" class="tab-content${i === 0 ? ' active' : ''}">
       <div class="round-head"><h3 class="section-title">${t.nome}</h3>
         <span class="round-progress" id="prog-${t.id}"></span></div>
       <div id="round-${t.id}" class="round-matches"></div>
       <div class="elim-save-row">
         <button type="button" class="btn-salva-fase" data-save="${t.id}">💾 Salva ${t.nome}</button>
         <span class="elim-save-msg" id="msg-${t.id}"></span>
       </div>
     </div>`
  ).join('') +
    `<div id="pron-BRACKET" class="tab-content">
       <div class="round-head"><h3 class="section-title">🗺️ Tabellone completo</h3>
         <span class="round-progress-note">I tuoi percorsi pronosticati · scorri per esplorare</span></div>
       <div id="bracket-grafico"></div>
     </div>` +
    `<div id="pron-BONUS" class="tab-content">
       <div class="round-head"><h3 class="section-title">🏆 Bonus fine torneo</h3></div>
       <div id="bonus-box" class="bonus-form"></div>
       <div class="elim-save-row">
         <button type="button" class="btn-salva-fase" data-save="BONUS">💾 Salva Bonus</button>
         <span class="elim-save-msg" id="msg-BONUS"></span>
       </div>
     </div>`;

  page.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">📋 La mia scheda pronostici</h2>
      <span id="pronostici-status" class="page-subtitle"></span>
    </div>
    <div id="pronostici-banner" class="info-banner" style="display:none"></div>
    <div class="visibility-toggle-bar" id="visibility-toggle-bar">
      <div>
        <div class="visibility-toggle-label">🙈 Nascondi il mio pronostico</div>
        <div class="visibility-toggle-desc" id="visibility-toggle-desc"></div>
      </div>
      <button type="button" class="switch" id="visibility-switch" role="switch" aria-checked="false">
        <span class="switch-knob"></span>
      </button>
    </div>
    <div class="tab-bar" id="pronostici-tabs">${tabsHtml}</div>
    ${contentsHtml}
  `;

  // Re-render del turno quando la sua tab diventa attiva (gli accoppiamenti
  // dipendono dai vincitori del turno precedente, che possono essere cambiati).
  page.querySelectorAll('#pronostici-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const r = tab.dataset.round;
      if (r === 'BONUS') _renderBonus();
      else if (r === 'BRACKET') renderBracketGrafico(document.getElementById('bracket-grafico'), _pron, _db);
      else _renderRound(r);
    });
  });

  // Salvataggio per turno / bonus
  page.querySelectorAll('[data-save]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.save;
      if (r === 'BONUS') _salvaBonus(btn);
      else _salvaTurno(r, btn);
    });
  });

  // Interruttore visibilità scheda
  const sw = document.getElementById('visibility-switch');
  if (sw) {
    _syncVisibilitySwitch();
    sw.addEventListener('click', _toggleVisibilita);
  }
}

// ── VISIBILITÀ SCHEDA (nascondi pronostico) ───────────
/** Allinea l'aspetto dell'interruttore allo stato corrente. */
function _syncVisibilitySwitch() {
  const sw = document.getElementById('visibility-switch');
  const desc = document.getElementById('visibility-toggle-desc');
  if (!sw) return;
  const nascosto = _pron.pronostico_nascosto === true;
  sw.classList.toggle('switch--on', nascosto);
  sw.setAttribute('aria-checked', nascosto ? 'true' : 'false');
  if (desc) {
    if (!_aperti) {
      desc.textContent = 'Pronostici chiusi: tutte le schede sono ora visibili a tutti.';
    } else if (nascosto) {
      desc.textContent = 'La tua scheda è nascosta agli altri finché i pronostici sono aperti.';
    } else {
      desc.textContent = 'La tua scheda è visibile agli altri partecipanti.';
    }
  }
}

/** Attiva/disattiva la visibilità e salva subito. */
async function _toggleVisibilita() {
  if (!_aperti) { showToast('Pronostici chiusi: le schede sono visibili a tutti.', 'warning'); return; }
  const sw = document.getElementById('visibility-switch');
  const nuovo = !(_pron.pronostico_nascosto === true);
  _pron.pronostico_nascosto = nuovo;
  _syncVisibilitySwitch();
  if (sw) sw.disabled = true;
  try {
    await savePronostici(STATE.utente.id, _stripPron());
    showToast(nuovo ? '🙈 Pronostico nascosto agli altri.' : '👁️ Pronostico di nuovo visibile.', 'success');
  } catch (err) {
    // Rollback in caso di errore
    _pron.pronostico_nascosto = !nuovo;
    _syncVisibilitySwitch();
    showToast('Errore nel salvataggio: ' + err.message, 'error');
  } finally {
    if (sw) sw.disabled = !_aperti ? true : false;
  }
}

// ── RENDER DI UN TURNO ────────────────────────────────
function _renderRound(roundId) {
  const box = document.getElementById('round-' + roundId);
  if (!box) return;
  const t = TURNI.find(x => x.id === roundId);

  let html = '';
  let compilati = 0;
  for (let i = 0; i < t.matches; i++) {
    const mid = matchId(roundId, i);
    const { a, b } = getMatchPlayers(roundId, i, _pron, _db);
    const p = getPron(_pron, roundId, mid);
    const vinc = (p && (p.vincitore === a || p.vincitore === b)) ? p.vincitore : null;
    const set = vinc ? (p.set || '') : '';
    if (vinc) compilati++;

    if (!a && !b) {
      html += `<div class="match-card match-locked" data-mid="${mid}">
        <span class="match-num">${i + 1}</span>
        <span class="match-locked-msg">Completa prima il turno precedente</span></div>`;
      continue;
    }

    // Un "lato" = pulsante-giocatore (scelta vincitore) + bottone info (scheda)
    const side = (pid) => {
      if (!pid) return `<div class="match-side"><button type="button" class="match-team match-team--empty" disabled>—</button></div>`;
      const sel = vinc === pid ? ' selected' : '';
      return `<div class="match-side">
        <button type="button" class="match-team${sel}" data-mid="${mid}" data-pid="${pid}" data-round="${roundId}">
          <span class="mt-name">${nomeGiocatore(_db, pid)}</span>${rankBadge(_db, pid)}
        </button>
        ${infoBtn(pid)}
      </div>`;
    };

    const setBtns = SET_OPTIONS.map(s =>
      `<button type="button" class="set-opt${set === s ? ' selected' : ''}" data-mid="${mid}" data-round="${roundId}" data-set="${s}">${s}</button>`
    ).join('');

    html += `<div class="match-card${vinc ? ' match-done' : ''}" data-mid="${mid}">
      <span class="match-num">${i + 1}</span>
      <div class="match-teams">${side(a)}<span class="match-vs">vs</span>${side(b)}</div>
      <div class="match-set${vinc ? '' : ' match-set--hidden'}"><span class="match-set-label">set</span>${setBtns}</div>
      <div class="match-actions">
        <button type="button" class="lucky-btn" data-lucky="${mid}" data-round="${roundId}"
          title="Sceglie a caso vincitore e numero di set">🎲 Mi sento fortunato</button>
      </div>
    </div>`;
  }

  box.innerHTML = html;

  // Progress
  const prog = document.getElementById('prog-' + roundId);
  if (prog) prog.textContent = `${compilati}/${t.matches}`;

  // Listener: scelta vincitore
  box.querySelectorAll('.match-team[data-pid]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_aperti) return;
      const { mid, pid, round } = btn.dataset;
      _setVincitore(round, mid, pid);
      _renderRound(round);              // aggiorna highlight + mostra selettore set
    });
  });
  // Listener: scelta set
  box.querySelectorAll('.set-opt[data-set]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_aperti) return;
      const { mid, round, set } = btn.dataset;
      _setSet(round, mid, set);
      _renderRound(round);
    });
  });
  // Listener: apertura scheda giocatore (funziona anche a pronostici chiusi)
  box.querySelectorAll('.player-info-btn[data-info]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSchedaGiocatore(_db, btn.dataset.info);
    });
  });
  // Listener: "Mi sento fortunato" → esito + set casuali
  box.querySelectorAll('.lucky-btn[data-lucky]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_aperti) return;
      const { lucky, round } = btn.dataset;
      _luckyPick(round, lucky);
      _renderRound(round);
    });
  });

  _applyLockState();
}

// ── RENDER BONUS ──────────────────────────────────────
function _renderBonus() {
  const box = document.getElementById('bonus-box');
  if (!box) return;
  const cats = _db.bonus || [];
  if (!cats.length) { box.innerHTML = '<p class="text-muted">Nessun bonus configurato.</p>'; return; }

  // Opzioni: tutti i giocatori del tabellone, ordinati per nome (poi id)
  const ids = Object.keys(_db.giocatori || {});
  ids.sort((x, y) => nomeGiocatore(_db, x).localeCompare(nomeGiocatore(_db, y), 'it'));
  const optsHtml = (sel) => '<option value="">— scegli —</option>' +
    ids.map(pid => {
      const rk = _db.giocatori?.[pid]?.rank;
      const label = nomeGiocatore(_db, pid) + (rk ? ` · ATP #${rk}` : '');
      return `<option value="${pid}"${sel === pid ? ' selected' : ''}>${label}</option>`;
    }).join('');

  box.innerHTML = cats.map(c => {
    const sel = _pron.bonus?.[c.id] || '';
    return `<div class="bonus-field">
      <label class="bonus-field-label">${c.label}</label>
      <select class="bonus-select" data-bonus="${c.id}">${optsHtml(sel)}</select>
    </div>`;
  }).join('');

  box.querySelectorAll('.bonus-select').forEach(s => {
    s.addEventListener('change', () => {
      if (!_pron.bonus) _pron.bonus = {};
      _pron.bonus[s.dataset.bonus] = s.value || null;
    });
  });

  _applyLockState();
}

// ── MUTAZIONI LOCALI ──────────────────────────────────
function _setVincitore(roundId, mid, pid) {
  if (!_pron.bracket[roundId]) _pron.bracket[roundId] = {};
  const cur = _pron.bracket[roundId][mid] || {};
  // Toggle: riclic sullo stesso vincitore lo deseleziona
  if (cur.vincitore === pid) {
    delete _pron.bracket[roundId][mid];
  } else {
    _pron.bracket[roundId][mid] = { vincitore: pid, set: cur.set || '' };
  }
}

function _setSet(roundId, mid, set) {
  const cur = _pron.bracket[roundId]?.[mid];
  if (!cur || !cur.vincitore) return;
  cur.set = (cur.set === set) ? '' : set; // toggle
}

/** "Mi sento fortunato": vincitore casuale tra i due giocatori + set casuale. */
function _luckyPick(roundId, mid) {
  // Ricava i due giocatori del match (gli accoppiamenti dipendono dal turno precedente)
  const { a, b } = getMatchPlayers(roundId, matchIndex(mid), _pron, _db);
  const opts = [a, b].filter(Boolean);
  if (!opts.length) return; // match non ancora definito
  const vincitore = opts[Math.floor(Math.random() * opts.length)];
  const set = SET_OPTIONS[Math.floor(Math.random() * SET_OPTIONS.length)];
  if (!_pron.bracket[roundId]) _pron.bracket[roundId] = {};
  _pron.bracket[roundId][mid] = { vincitore, set };
}

// ── SALVATAGGIO ───────────────────────────────────────
async function _salvaTurno(roundId, btn) {
  if (!_aperti) { showToast('Pronostici chiusi: non puoi modificare.', 'warning'); return; }
  const msg = document.getElementById('msg-' + roundId);
  btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ Salvataggio…';
  try {
    await savePronostici(STATE.utente.id, _stripPron());
    if (msg) { msg.textContent = '✅ Salvato'; msg.className = 'elim-save-msg ok'; }
    showToast('Pronostici salvati.', 'success');
  } catch (err) {
    if (msg) { msg.textContent = '❌ Errore'; msg.className = 'elim-save-msg err'; }
    showToast('Errore nel salvataggio: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
  }
}

async function _salvaBonus(btn) {
  if (!_aperti) { showToast('Pronostici chiusi: non puoi modificare.', 'warning'); return; }
  const msg = document.getElementById('msg-BONUS');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '⏳ Salvataggio…';
  try {
    await savePronostici(STATE.utente.id, _stripPron());
    if (msg) { msg.textContent = '✅ Salvato'; msg.className = 'elim-save-msg ok'; }
    showToast('Bonus salvati.', 'success');
  } catch (err) {
    if (msg) { msg.textContent = '❌ Errore'; msg.className = 'elim-save-msg err'; }
    showToast('Errore nel salvataggio: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = old;
    setTimeout(() => { if (msg) msg.textContent = ''; }, 4000);
  }
}

/** Prepara l'oggetto da salvare (senza updatedAt, aggiunto da db.js). */
function _stripPron() {
  return {
    bracket: _pron.bracket || {},
    bonus: _pron.bonus || {},
    pronostico_nascosto: _pron.pronostico_nascosto === true,
  };
}

// ── LOCK STATE (pronostici chiusi) ────────────────────
function _applyLockState() {
  if (!_built) return;
  const banner = document.getElementById('pronostici-banner');
  const status = document.getElementById('pronostici-status');
  const page = document.getElementById('page-pronostici');
  if (!page) return;

  if (_aperti) {
    if (banner) banner.style.display = 'none';
    if (status) status.textContent = 'Pronostici aperti';
  } else {
    if (banner) {
      banner.style.display = '';
      banner.className = 'info-banner info-banner--yellow';
      banner.innerHTML = '<span>🔒</span><span>I pronostici sono <strong>chiusi</strong>. La tua scheda è in sola lettura.</span>';
    }
    if (status) status.textContent = 'Pronostici chiusi';
  }

  // Disabilita/abilita input e nascondi/mostra i pulsanti salva
  page.querySelectorAll('.match-team, .set-opt, .bonus-select, .lucky-btn').forEach(el => {
    if (_aperti) el.removeAttribute('disabled');
    else el.setAttribute('disabled', 'disabled');
  });
  page.querySelectorAll('[data-save]').forEach(b => {
    b.style.display = _aperti ? '' : 'none';
  });

  // Interruttore visibilità: attivo solo a pronostici aperti
  const sw = document.getElementById('visibility-switch');
  if (sw) sw.disabled = !_aperti;
  _syncVisibilitySwitch();
}

// ── HELPERS ───────────────────────────────────────────
function _errBox(titolo, dettaglio) {
  return `<div class="page-header"><h2 class="page-title">📋 Pronostici</h2></div>
    <div class="empty-state"><div class="empty-icon">⚠️</div>
    <p>${titolo}</p><p class="text-muted">${dettaglio || ''}</p></div>`;
}
