/**
 * MEDUSINO — profilo.js
 * Pagina "Il mio profilo" (e scheda di un altro partecipante, via STATE.profiloUid).
 *
 * Tre sotto-schede:
 *   • Riepilogo  — punti per turno (Esiti e Set, con i totali) + i pronostici
 *                  chiave: campione, finalisti, semifinalisti e i tre bonus, con
 *                  stato live rispetto ai risultati (raggiunto / in corsa / fuori).
 *   • Tabellone  — tabellone grafico pronosticato: viene evidenziato in verde
 *                  solo il pronostico indovinato (il resto del percorso si legge
 *                  già dalla struttura).
 *   • Risultati  — risultati ufficiali turno per turno: per ogni partita conclusa
 *                  è evidenziato se hai azzeccato l'esito e se hai indovinato il set.
 *
 * Privacy: Tabellone e Risultati di un ALTRO partecipante restano nascosti se lui
 * ha attivato "nascondi pronostico" e i pronostici sono ancora aperti (admin e
 * proprietario vedono comunque tutto). Il Riepilogo usa solo punti aggregati
 * (pubblici via classifica) e resta sempre visibile.
 */

import { STATE, navigaA } from './app.js';
import { getClassifica, getPronostici, getRisultati, getSistema } from './db.js';
import { caricaEvento, nomeGiocatore } from './evento.js';
import {
  TURNI, getCampione, getPron, getMatchPlayers, matchId, renderBracketGrafico,
} from './bracket.js';
import { WINNER_POINTS, SET_POINTS, calcolaPunteggio } from './punteggi.js';
import { rankBadge, infoBtn, openSchedaGiocatore } from './giocatore.js';

let _tabsBound = false;   // i listener dei sotto-tab si agganciano una sola volta

// ── INIT ──────────────────────────────────────────────
export async function initProfilo() {
  const page = document.getElementById('page-profilo');
  if (!page || !STATE.utente) return;

  const targetUid = STATE.profiloUid || STATE.utente.id;
  const isMe = targetUid === STATE.utente.id;

  _bindInnerTabs();
  _resetInnerTabs();
  _renderBanner(isMe);

  // Stato di caricamento
  const bd = document.getElementById('profilo-breakdown');
  if (bd) bd.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Caricamento profilo…</p></div>';
  _spinner('profilo-tabellone-container');
  _spinner('profilo-risultati-container');

  try {
    const db = await caricaEvento();
    const [classifica, risultati, sistema] = await Promise.all([
      getClassifica(), getRisultati(), getSistema(),
    ]);
    const aperti = sistema?.pronostici_aperti !== false;

    const me = (classifica || []).find(p => p.id === targetUid) || null;
    const nome = isMe
      ? (STATE.utente.nickname || STATE.utente.nome || 'Tu')
      : (me?.nome || 'Partecipante');

    const pron = (await getPronostici(targetUid)) || {};
    if (!pron.bracket) pron.bracket = {};
    if (!pron.bonus) pron.bonus = {};

    const nascosto = pron.pronostico_nascosto === true;
    const puoVedere = isMe || STATE.utente.isAdmin || !aperti || !nascosto;

    const title = document.getElementById('profilo-page-title');
    if (title) title.textContent = isMe ? '📊 Il mio profilo' : `📊 ${nome}`;

    // Mappe vincitori/set per turno: scelte utente e risultati reali.
    const userPicks = {}, realPicks = {}, realWinnersByRound = {};
    const eliminati = new Set();
    TURNI.forEach(t => {
      userPicks[t.id] = _vincitoriMap(pron, t.id);
      realPicks[t.id] = _vincitoriMap(risultati, t.id);
      realWinnersByRound[t.id] = new Set(Object.keys(realPicks[t.id]));
      // Sconfitti reali del turno (per lo stato "eliminato" dei pronostici chiave).
      for (let i = 0; i < t.matches; i++) {
        const p = getPron(risultati, t.id, matchId(t.id, i));
        if (!p?.vincitore) continue;
        const { a, b } = getMatchPlayers(t.id, i, risultati, db);
        if (p.vincitore !== a && p.vincitore !== b) continue;
        const perdente = p.vincitore === a ? b : a;
        if (perdente) eliminati.add(perdente);
      }
    });
    const stato = { winnersByRound: realWinnersByRound, eliminati };

    _renderScoreCard(me, nome, isMe, classifica);
    _renderBreakdown(me, pron, risultati, db);
    _renderKeyPicks(pron, risultati, db, stato, puoVedere);
    _renderTabellone(pron, db, realWinnersByRound, puoVedere);
    _renderRisultati(pron, risultati, db, userPicks, realPicks, puoVedere);
  } catch (err) {
    if (bd) bd.innerHTML =
      `<div class="empty-state"><div class="empty-icon">⚠️</div>` +
      `<p>Impossibile caricare il profilo.</p><p class="text-muted">${err.message || ''}</p></div>`;
  }
}

// ── BANNER / SOTTO-TAB ────────────────────────────────
function _renderBanner(isMe) {
  const banner = document.getElementById('profilo-header-banner');
  if (!banner) return;
  if (isMe) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  banner.style.display = '';
  banner.innerHTML =
    `<button type="button" class="prof-back-btn">← Torna alla classifica</button>` +
    `<span class="prof-back-note">Stai guardando la scheda di un altro partecipante</span>`;
  const btn = banner.querySelector('.prof-back-btn');
  if (btn) btn.addEventListener('click', () => navigaA('classifica'));
}

/** Switch dei sotto-tab. I bottoni sono statici in index.html → listener una volta sola. */
function _bindInnerTabs() {
  if (_tabsBound) return;
  const bar = document.getElementById('profilo-inner-tabs');
  const page = document.getElementById('page-profilo');
  if (!bar || !page) return;
  const contents = [...page.children].filter(el => el.classList.contains('tab-content'));
  bar.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      bar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      contents.forEach(c => c.classList.toggle('active', c.id === targetId));
    });
  });
  _tabsBound = true;
}

function _resetInnerTabs() {
  const bar = document.getElementById('profilo-inner-tabs');
  const page = document.getElementById('page-profilo');
  if (!bar || !page) return;
  bar.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  const contents = [...page.children].filter(el => el.classList.contains('tab-content'));
  contents.forEach((c, i) => c.classList.toggle('active', i === 0));
}

// ── SCORE CARD ────────────────────────────────────────
function _renderScoreCard(me, nome, isMe, classifica) {
  const card = document.getElementById('profilo-score-card');
  if (!card) return;
  const pos = _posizione(classifica, me?.id);
  card.innerHTML = `
    <div class="score-card-inner">
      <div class="score-card-pos">${_posLabel(pos)}</div>
      <div class="score-card-info">
        <div class="score-card-nome">${nome}${isMe ? ' <span class="badge-tu">Tu</span>' : ''}</div>
        <div class="score-card-totale">${me?.totale ?? 0} <span class="score-card-pt">pt</span></div>
      </div>
    </div>`;
}

// ── RIEPILOGO: punti per turno (Esiti + Set) ──────────
function _renderBreakdown(me, pron, risultati, db) {
  const box = document.getElementById('profilo-breakdown');
  if (!box) return;

  let breakdown = me?.breakdown;
  if (!breakdown || !breakdown.perTurno) {
    breakdown = calcolaPunteggio(pron, risultati, db).breakdown;
  }
  const perTurno = breakdown.perTurno || {};

  const rows = TURNI.map(t => {
    const pt = perTurno[t.id] || { esiti: 0, set: 0 };
    const vuoto = (pt.esiti || 0) + (pt.set || 0) === 0;
    return `<tr class="prof-bd-row${vuoto ? ' prof-row--empty' : ''}">
      <td class="prof-bd-turno">${t.nome}</td>
      <td class="prof-bd-num">${pt.esiti || 0}</td>
      <td class="prof-bd-num">${pt.set || 0}</td>
    </tr>`;
  }).join('');

  const totale = (breakdown.esiti || 0) + (breakdown.set || 0) + (breakdown.bonus || 0);

  box.innerHTML = `
    <div class="prof-card">
      <h3 class="prof-card-title">📈 Punti per turno</h3>
      <table class="prof-bd-table">
        <thead><tr><th>Turno</th><th>Esiti</th><th>Set</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="prof-bd-totrow">
            <td>Totale</td>
            <td class="prof-bd-num">${breakdown.esiti || 0}</td>
            <td class="prof-bd-num">${breakdown.set || 0}</td>
          </tr>
        </tfoot>
      </table>
      <div class="prof-bd-foot">
        <span class="prof-pill">Esiti <strong>${breakdown.esiti || 0}</strong></span>
        <span class="prof-pill">Set <strong>${breakdown.set || 0}</strong></span>
        <span class="prof-pill">Bonus <strong>${breakdown.bonus || 0}</strong></span>
        <span class="prof-pill prof-pill--tot">Totale <strong>${totale}</strong></span>
      </div>
    </div>`;
}

// ── RIEPILOGO: pronostici chiave (campione/finalisti/SF + bonus) ─
function _renderKeyPicks(pron, risultati, db, stato, puoVedere) {
  const box = document.getElementById('profilo-keypicks');
  if (!box) return;

  if (!puoVedere) {
    box.innerHTML = `
      <div class="prof-card prof-card--locked">
        <h3 class="prof-card-title">🙈 Pronostici nascosti</h3>
        <p class="text-muted">Le scelte di questo partecipante sono nascoste finché i pronostici sono aperti.</p>
      </div>`;
    return;
  }

  const campione = getCampione(pron);
  const finalisti = Object.keys(_vincitoriMap(pron, 'SF'));
  const semifinalisti = Object.keys(_vincitoriMap(pron, 'QF'));

  const champHtml = campione
    ? _chipGiocatore(db, campione, _statoPick(campione, 'F', stato))
    : '<span class="text-muted">— non pronosticato</span>';

  box.innerHTML = `
    <div class="prof-card">
      <h3 class="prof-card-title">🎯 I tuoi pronostici chiave</h3>
      <div class="prof-keys">
        <div class="prof-key-group">
          <div class="prof-key-label">🏆 Campione</div>
          <div class="prof-chips">${champHtml}</div>
        </div>
        <div class="prof-key-group">
          <div class="prof-key-label">🥈 Finalisti</div>
          <div class="prof-chips">${_chipList(db, finalisti, 'SF', stato)}</div>
        </div>
        <div class="prof-key-group">
          <div class="prof-key-label">🎽 Semifinalisti</div>
          <div class="prof-chips">${_chipList(db, semifinalisti, 'QF', stato)}</div>
        </div>
      </div>
      <div id="profilo-keypicks-bonus"></div>
      <p class="prof-note">✅ raggiunto · ⏳ ancora in corsa · ❌ eliminato — rispetto ai risultati ufficiali.</p>
    </div>`;

  _renderBonusConfronto(document.getElementById('profilo-keypicks-bonus'), pron, risultati, db);

  box.querySelectorAll('.player-info-btn[data-info]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openSchedaGiocatore(db, btn.dataset.info); });
  });
}

function _chipList(db, pids, round, stato) {
  if (!pids.length) return '<span class="text-muted">— non pronosticati</span>';
  return pids.map(pid => _chipGiocatore(db, pid, _statoPick(pid, round, stato))).join('');
}

function _chipGiocatore(db, pid, st) {
  const icon = st === 'ok' ? '✅' : st === 'out' ? '❌' : '⏳';
  const cls = st === 'ok' ? ' prof-chip--ok' : st === 'out' ? ' prof-chip--out' : ' prof-chip--live';
  return `<span class="prof-chip${cls}">
    <span class="prof-chip-ic">${icon}</span>
    <span class="prof-chip-name">${nomeGiocatore(db, pid)}</span>${rankBadge(db, pid)}
    ${infoBtn(pid)}
  </span>`;
}

/** Stato di un pronostico chiave: 'ok' (raggiunto), 'out' (eliminato), 'live'. */
function _statoPick(pid, round, stato) {
  if (stato.winnersByRound[round]?.has(pid)) return 'ok';
  if (stato.eliminati.has(pid)) return 'out';
  return 'live';
}

// ── TABELLONE: bracket con i soli indovinati evidenziati ──
function _renderTabellone(pron, db, realWinnersByRound, puoVedere) {
  const box = document.getElementById('profilo-tabellone-container');
  if (!box) return;
  if (!puoVedere) { box.innerHTML = _hiddenMsg(); return; }

  box.innerHTML = `
    <div class="prof-legend">
      <span class="prof-legend-item"><span class="prof-legend-sw prof-legend-sw--ok"></span> pronostico indovinato</span>
    </div>
    <div class="prof-card prof-bracket"><div id="profilo-bracket-grafico"></div></div>`;

  renderBracketGrafico(document.getElementById('profilo-bracket-grafico'), pron, db, realWinnersByRound);
}

function _renderBonusConfronto(container, pron, risultati, db) {
  if (!container) return;
  const cats = db.bonus || [];
  if (!cats.length) { container.innerHTML = ''; return; }
  let html = '<h4 class="prof-bonus-title">🏆 Bonus fine torneo</h4><div class="prof-bonus-list">';
  cats.forEach(c => {
    const pick = pron?.bonus?.[c.id];
    const real = risultati?.bonus?.[c.id];
    let esito = '';
    if (pick && real) {
      esito = pick === real
        ? '<span class="prof-pts prof-pts--ok">✓</span>'
        : '<span class="prof-pts prof-pts--no">✗</span>';
    }
    html += `<div class="prof-bonus-row">
      <span class="prof-bonus-label">${c.label}</span>
      <span class="prof-bonus-val">${pick ? nomeGiocatore(db, pick) : '—'} ${esito}</span>
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

// ── RISULTATI: turno per turno con esito/set indovinati ─
function _renderRisultati(pron, risultati, db, userPicks, realPicks, puoVedere) {
  const box = document.getElementById('profilo-risultati-container');
  if (!box) return;
  if (!puoVedere) { box.innerHTML = _hiddenMsg(); return; }

  const conRis = TURNI.filter(t => Object.keys(realPicks[t.id] || {}).length > 0);
  if (!conRis.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div>
      <p>Nessun risultato disponibile</p>
      <p class="text-muted">I risultati appariranno qui man mano che il torneo procede.</p></div>`;
    return;
  }
  const defRound = conRis[conRis.length - 1].id;

  const tabsHtml = conRis.map(t =>
    `<button type="button" class="prof-round-btn${t.id === defRound ? ' active' : ''}" data-round="${t.id}">${t.nome}</button>`
  ).join('');

  box.innerHTML = `
    <div class="prof-round-tabs">${tabsHtml}</div>
    <div id="profilo-risultati-round"></div>`;

  const render = (rid) => _renderRisultatiRound(rid, pron, risultati, db, userPicks);
  box.querySelectorAll('.prof-round-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      box.querySelectorAll('.prof-round-btn').forEach(b => b.classList.toggle('active', b === btn));
      render(btn.dataset.round);
    });
  });
  render(defRound);
}

function _renderRisultatiRound(roundId, pron, risultati, db, userPicks) {
  const cont = document.getElementById('profilo-risultati-round');
  if (!cont) return;
  const t = TURNI.find(x => x.id === roundId);
  if (!t) return;
  const up = userPicks[roundId] || {};
  const winPts = WINNER_POINTS[roundId], setPts = SET_POINTS[roundId];

  let cards = '', nEsiti = 0, nSet = 0, pts = 0;

  for (let i = 0; i < t.matches; i++) {
    const mid = matchId(roundId, i);
    const { a, b } = getMatchPlayers(roundId, i, risultati, db);
    const p = getPron(risultati, roundId, mid);
    const vinc = (p && (p.vincitore === a || p.vincitore === b)) ? p.vincitore : null;
    if (!vinc) continue; // solo partite concluse

    const realSet = p.set || '';
    const esitoOk = Object.prototype.hasOwnProperty.call(up, vinc);
    const userSet = up[vinc];
    const setOk = esitoOk && userSet && realSet && userSet === realSet;
    if (esitoOk) { nEsiti++; pts += winPts; }
    if (setOk) { nSet++; pts += setPts; }

    const side = (pid, isWin) => {
      if (!pid) return `<div class="match-side"><span class="match-team match-team--ro match-team--empty">—</span></div>`;
      const cls = 'match-team match-team--ro' + (isWin ? ' selected' : ' match-team--lose');
      return `<div class="match-side">
        <span class="${cls}"><span class="mt-name">${isWin ? '🏆 ' : ''}${nomeGiocatore(db, pid)}</span>${rankBadge(db, pid)}</span>
        ${infoBtn(pid)}
      </div>`;
    };

    let status;
    if (esitoOk) {
      status = `<span class="prof-pts prof-pts--ok">✓ Esito +${winPts}</span>` +
        (setOk
          ? `<span class="prof-pts prof-pts--set">🎾 Set esatto +${setPts}</span>`
          : (userSet ? `<span class="prof-pts prof-pts--miss">il tuo set: ${userSet}</span>` : ''));
    } else {
      status = `<span class="prof-pts prof-pts--no">✗ esito non indovinato</span>`;
    }

    const setPill = realSet
      ? `<span class="match-set-label">set</span><span class="set-opt selected">${realSet}</span>`
      : `<span class="ris-pending">concluso</span>`;

    cards += `<div class="match-card match-done prof-res-card${esitoOk ? ' prof-res-hit' : ''}">
      <span class="match-num">${i + 1}</span>
      <div class="match-teams">${side(a, vinc === a)}<span class="match-vs">vs</span>${side(b, vinc === b)}</div>
      <div class="match-set">${setPill}</div>
      <div class="prof-res-status">${status}</div>
    </div>`;
  }

  const head = `<div class="prof-res-head">
    <h3 class="prof-card-title">${t.nome}</h3>
    <span class="prof-res-sum">${nEsiti} esiti · ${nSet} set · <strong>${pts} pt</strong></span>
  </div>`;

  cont.innerHTML = head +
    (cards
      ? `<div class="round-matches">${cards}</div>`
      : '<p class="text-muted">Nessuna partita conclusa in questo turno.</p>');

  cont.querySelectorAll('.player-info-btn[data-info]').forEach(btn => {
    btn.addEventListener('click', () => openSchedaGiocatore(db, btn.dataset.info));
  });
}

// ── HELPERS ───────────────────────────────────────────
/** Mappa { playerId: set } dei vincitori indicati in un turno (scelte o risultati). */
function _vincitoriMap(doc, roundId) {
  const out = {};
  const matches = doc?.bracket?.[roundId] || {};
  Object.values(matches).forEach(m => { if (m && m.vincitore) out[m.vincitore] = m.set || null; });
  return out;
}

function _hiddenMsg() {
  return `<div class="empty-state">
      <div class="empty-icon">🙈</div>
      <p>Scheda nascosta</p>
      <p class="text-muted">Questo partecipante ha nascosto la propria scheda finché i pronostici sono aperti.</p>
    </div>`;
}

function _spinner(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Caricamento…</p></div>';
}

/** Posizione (con ex-aequo) di un uid nella classifica, stessa logica di classifica.js. */
function _posizione(classifica, uid) {
  if (!uid || !classifica?.length) return null;
  const sorted = [...classifica].sort((a, b) => {
    if (b.totale !== a.totale) return (b.totale || 0) - (a.totale || 0);
    const sa = a.spareggio || [], sb = b.spareggio || [];
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      if ((sb[i] || 0) !== (sa[i] || 0)) return (sb[i] || 0) - (sa[i] || 0);
    }
    return (a.nome || '').localeCompare(b.nome || '', 'it');
  });
  let pos = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const prev = sorted[i - 1], cur = sorted[i];
      const same = prev.totale === cur.totale &&
        JSON.stringify(prev.spareggio) === JSON.stringify(cur.spareggio);
      if (!same) pos = i + 1;
    }
    if (sorted[i].id === uid) return pos;
  }
  return null;
}

function _posLabel(pos) {
  if (!pos) return '—';
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  return medals[pos] || `${pos}°`;
}
