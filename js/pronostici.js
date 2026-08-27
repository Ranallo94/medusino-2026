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
  percorsoGiocatore,
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
  _initRicerca();

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
    <div class="pron-search" id="pron-search">
      <span class="pron-search-icon">🔎</span>
      <input type="search" id="pron-cerca" class="pron-search-input" autocomplete="off"
             placeholder="Cerca un tennista…" aria-label="Cerca un tennista">
      <button type="button" class="pron-search-clear" id="pron-cerca-x" title="Azzera" hidden>✕</button>
      <div class="pron-search-res" id="pron-cerca-res" hidden></div>
    </div>
    <div id="pron-percorso" class="pron-percorso" hidden></div>
    <div class="tab-bar" id="pronostici-tabs">${tabsHtml}</div>
    ${contentsHtml}
  `;

  // Re-render del turno quando la sua tab diventa attiva (gli accoppiamenti
  // dipendono dai vincitori del turno precedente, che possono essere cambiati).
  page.querySelectorAll('#pronostici-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const r = tab.dataset.round;
      if (r === 'BONUS') _renderBonus();
      else if (r === 'BRACKET') renderBracketGrafico(document.getElementById('bracket-grafico'), _pron, _db, null, _evidenzia);
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

    html += `<div class="match-card${vinc ? ' match-done' : ''}" data-mid="${mid}" data-pids="${[a, b].filter(Boolean).join(',')}">
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
  _applicaFiltro();   // il ri-render azzera il filtro: lo riapplico
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


// ── RICERCA GIOCATORE ─────────────────────────────────
// Il campo fa due cose: filtra i match del turno aperto e, cliccando un
// risultato, apre il percorso completo pronosticato per quel giocatore.
let _filtro = '';
let _evidenzia = null;   // giocatore da mettere in risalto nel tabellone

/** Turno attualmente visibile fra i tab (o null se si è su Tabellone/Bonus). */
function _roundAttivo() {
  const tab = document.querySelector('#pronostici-tabs .tab.active');
  const r = tab?.dataset.round;
  return TURNI.some(t => t.id === r) ? r : null;
}

/** Giocatori del db il cui nome contiene `q` (max 8, teste di serie prima). */
function _cercaGiocatori(q) {
  const out = [];
  for (const [pid, g] of Object.entries(_db.giocatori || {})) {
    if (g.nome && g.nome.toLowerCase().includes(q)) out.push({ pid, g });
  }
  out.sort((x, y) => (x.g.seed || 999) - (y.g.seed || 999));
  return out.slice(0, 8);
}

/** Nasconde nel turno aperto i match che non riguardano i giocatori trovati. */
function _applicaFiltro() {
  const round = _roundAttivo();
  const box = round && document.getElementById('round-' + round);
  if (!box) return;
  const pids = _filtro ? new Set(_cercaGiocatori(_filtro).map(r => r.pid)) : null;
  let visibili = 0;
  box.querySelectorAll('.match-card').forEach(card => {
    if (!pids) { card.hidden = false; visibili++; return; }
    const suoi = (card.dataset.pids || '').split(',');
    const ok = suoi.some(p => pids.has(p));
    card.hidden = !ok;
    if (ok) visibili++;
  });
  let vuoto = box.querySelector('.pron-filtro-vuoto');
  if (_filtro && !visibili) {
    if (!vuoto) {
      vuoto = document.createElement('p');
      vuoto.className = 'pron-filtro-vuoto match-locked-msg';
      box.appendChild(vuoto);
    }
    vuoto.textContent = 'Nessuna partita di questo turno riguarda la tua ricerca.';
    vuoto.hidden = false;
  } else if (vuoto) {
    vuoto.hidden = true;
  }
}

/** Pannello col cammino pronosticato, turno per turno. */
function _mostraPercorso(pid) {
  const box = document.getElementById('pron-percorso');
  if (!box) return;
  _evidenzia = pid;
  const tappe = percorsoGiocatore(_pron, _db, pid);
  const nome = nomeGiocatore(_db, pid);

  let corpo;
  if (!tappe.length) {
    corpo = `<p class="pron-percorso-vuoto">Non compare nel tabellone: controlla il sorteggio del 1º turno.</p>`;
  } else {
    const righe = tappe.map(t => {
      const avv = t.avversario ? nomeGiocatore(_db, t.avversario) : '—';
      const esito = t.vince
        ? `<span class="pp-ok">passa il turno${t.set ? ' · ' + t.set : ''}</span>`
        : `<span class="pp-ko">esce qui</span>`;
      return `<li class="pp-riga"><span class="pp-turno">${t.nome}</span>
                <span class="pp-avv">contro ${avv}</span>${esito}</li>`;
    }).join('');
    const ultima = tappe[tappe.length - 1];
    const finale = ultima.vince && ultima.turno === 'F'
      ? `<p class="pron-percorso-nota">Nel tuo pronostico vince il torneo.</p>`
      : `<p class="pron-percorso-nota">Nel tuo pronostico arriva fino a: <strong>${ultima.nome}</strong>.</p>`;
    corpo = `<ol class="pp-lista">${righe}</ol>${finale}`;
  }

  box.innerHTML = `
    <div class="pron-percorso-head">
      <h4>Percorso di ${nome}</h4>
      <button type="button" class="pron-percorso-bk" id="pp-tabellone">Vedi nel tabellone</button>
      <button type="button" class="pron-percorso-x" id="pp-chiudi" title="Chiudi">✕</button>
    </div>${corpo}`;
  box.hidden = false;
  box.querySelector('#pp-chiudi').addEventListener('click', () => {
    box.hidden = true; _evidenzia = null;
    const bk = document.getElementById('bracket-grafico');
    if (bk && bk.childElementCount) renderBracketGrafico(bk, _pron, _db, null, null);
  });
  box.querySelector('#pp-tabellone').addEventListener('click', () => {
    document.querySelector('#pronostici-tabs .tab[data-round="BRACKET"]')?.click();
  });
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _initRicerca() {
  const input = document.getElementById('pron-cerca');
  const res   = document.getElementById('pron-cerca-res');
  const clear = document.getElementById('pron-cerca-x');
  if (!input) return;

  const aggiorna = () => {
    const q = input.value.trim().toLowerCase();
    clear.hidden = !q;
    _filtro = q.length >= 2 ? q : '';
    _applicaFiltro();

    if (!_filtro) { res.hidden = true; res.innerHTML = ''; return; }
    const trovati = _cercaGiocatori(_filtro);
    if (!trovati.length) {
      res.innerHTML = `<p class="pron-search-vuoto">Nessun tennista con questo nome.</p>`;
    } else {
      res.innerHTML = trovati.map(({ pid, g }) =>
        `<button type="button" class="pron-search-hit" data-pid="${pid}">
           <span class="psh-nome">${g.nome}</span>${g.seed ? `<span class="psh-seed">[${g.seed}]</span>` : ''}
           <span class="psh-cta">vedi percorso</span>
         </button>`).join('');
      res.querySelectorAll('.pron-search-hit').forEach(b =>
        b.addEventListener('click', () => { _mostraPercorso(b.dataset.pid); res.hidden = true; }));
    }
    res.hidden = false;
  };

  input.addEventListener('input', aggiorna);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; aggiorna(); input.blur(); }
  });
  clear.addEventListener('click', () => { input.value = ''; aggiorna(); input.focus(); });

  // Cambiando turno, il filtro va riapplicato al turno che si apre
  document.getElementById('pronostici-tabs')?.addEventListener('click', () => {
    setTimeout(_applicaFiltro, 0);
  });
}
