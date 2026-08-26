/**
 * MEDUSINO — giocatore.js
 * Badge ranking e scheda giocatore (modal) con dati live da ESPN.
 *
 * Dati statici (ranking ATP, seed, espnId) → usopen_db.json.
 * Dati live  → ESPN (CORS aperto):
 *   • bio/nazionalità/foto/stato  → sports.core.api.espn.com/.../athletes/{id}
 *   • forma recente (ultimi match) → site.api.espn.com/.../atp/scoreboard
 *
 * Esporta:
 *   rankBadge(db, pid)            → stringa HTML del badge ranking accanto al nome
 *   infoBtn(pid)                  → stringa HTML del bottone "ⓘ" che apre la scheda
 *   openSchedaGiocatore(db, pid)  → apre il modal con info + forma
 */

import { openModal } from './ui.js';
import { nomeGiocatore } from './evento.js';

const CORE_ATHLETE = (id) => `https://sports.core.api.espn.com/v2/sports/tennis/athletes/${id}?lang=en`;
const SCOREBOARD   = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard';
const GIORNI_FORMA = 14;   // finestra giornate per la "forma recente"

// ── BADGE & TRIGGER (usati nel rendering dei match) ───
/** Badge "#ranking" da mostrare accanto al nome. Se il rank non è noto → trattino discreto. */
export function rankBadge(db, pid) {
  const g = db?.giocatori?.[pid];
  if (!g) return '';
  if (g.rank) {
    return `<span class="rank-badge" title="Ranking ATP">#${g.rank}</span>`;
  }
  return `<span class="rank-badge rank-badge--na" title="Ranking non disponibile">–</span>`;
}

/** Bottone informazioni che apre la scheda giocatore. */
export function infoBtn(pid) {
  return `<button type="button" class="player-info-btn" data-info="${pid}"
            title="Scheda giocatore" aria-label="Apri scheda giocatore">ⓘ</button>`;
}

// ── CACHE ─────────────────────────────────────────────
const _bioCache = new Map();   // espnId → Promise<bio|null>
let _sbIndexPromise = null;    // Promise<Map<athleteId, match[]>>

// ── SCHEDA (modal) ────────────────────────────────────
export function openSchedaGiocatore(db, pid) {
  const g = db?.giocatori?.[pid] || {};
  const titolo = (g.nome || pid);

  openModal({
    title: titolo,
    body: `
      <div class="pc">
        <div class="pc-head" id="pc-head">
          <div class="pc-avatar pc-avatar--ph">🎾</div>
          <div class="pc-headmain">
            <div class="pc-name">${nomeGiocatore(db, pid)}</div>
            <div class="pc-meta">${_metaStaticHtml(g)}</div>
          </div>
        </div>
        <div class="pc-section">
          <div class="pc-section-title">Anagrafica</div>
          <div id="pc-bio" class="pc-bio"><span class="pc-loading">Carico i dati…</span></div>
        </div>
        <div class="pc-section">
          <div class="pc-section-title">Forma recente</div>
          <div id="pc-form" class="pc-form"><span class="pc-loading">Carico la forma…</span></div>
        </div>
      </div>`,
    buttons: [{ label: 'Chiudi', cls: 'btn btn-secondary', onClick: () => {
      const ov = document.getElementById('modal-overlay'); if (ov) ov.style.display = 'none';
    } }],
  });

  const espnId = g.espnId;
  if (!espnId) {
    _fill('pc-bio', `<p class="text-muted">Dati ESPN non disponibili per questo giocatore (probabile qualificato/wild card).</p>`);
    _fill('pc-form', `<p class="text-muted">Forma non disponibile.</p>`);
    return;
  }

  // Bio + nazionalità + foto
  _getBio(espnId).then(bio => {
    if (bio) {
      const head = document.getElementById('pc-head');
      if (head) head.innerHTML = _headHtml(db, pid, g, bio);
      _fill('pc-bio', _bioHtml(bio));
    } else {
      _fill('pc-bio', `<p class="text-muted">Anagrafica non disponibile al momento.</p>`);
    }
  }).catch(() => _fill('pc-bio', `<p class="text-muted">Errore nel caricamento dell'anagrafica.</p>`));

  // Forma recente
  _getForma(espnId).then(rows => {
    _fill('pc-form', _formaHtml(rows));
  }).catch(() => _fill('pc-form', `<p class="text-muted">Forma non disponibile al momento.</p>`));
}

// ── HTML BUILDERS ─────────────────────────────────────
function _metaStaticHtml(g) {
  const parts = [];
  if (g.rank) parts.push(`<span class="pc-rank">ATP #${g.rank}${_trendHtml(g)}</span>`);
  else parts.push(`<span class="pc-rank pc-rank--na">ATP n.d.</span>`);
  if (g.seed) parts.push(`<span class="pc-seed">testa di serie n.${g.seed}</span>`);
  if (g.points) parts.push(`<span class="pc-pts">${Math.round(g.points)} punti</span>`);
  return parts.join('<span class="pc-dot">·</span>');
}

function _trendHtml(g) {
  if (!g.prevRank || !g.rank || g.prevRank === g.rank) return '';
  if (g.prevRank > g.rank) return ` <span class="pc-up" title="In salita">▲${g.prevRank - g.rank}</span>`;
  return ` <span class="pc-down" title="In discesa">▼${g.rank - g.prevRank}</span>`;
}

function _headHtml(db, pid, g, bio) {
  const avatar = bio.headshot
    ? `<img class="pc-avatar" src="${bio.headshot}" alt="" loading="lazy"
         onerror="this.outerHTML='<div class=&quot;pc-avatar pc-avatar--ph&quot;>🎾</div>'">`
    : `<div class="pc-avatar pc-avatar--ph">🎾</div>`;
  const flag = bio.flag ? `<img class="pc-flag" src="${bio.flag}" alt="${bio.country || ''}"> ` : '';
  const naz = bio.country ? `<span class="pc-naz">${flag}${bio.country}</span>` : '';
  return `
    ${avatar}
    <div class="pc-headmain">
      <div class="pc-name">${bio.displayName || nomeGiocatore(db, pid)}</div>
      <div class="pc-meta">${_metaStaticHtml(g)}</div>
      <div class="pc-meta pc-meta2">${naz}${bio.status && bio.status !== 'Active' ? `<span class="pc-status">${bio.status}</span>` : ''}</div>
    </div>`;
}

function _bioHtml(b) {
  const rows = [
    ['Nazionalità', b.country ? `${b.flag ? `<img class="pc-flag" src="${b.flag}" alt=""> ` : ''}${b.country}` : null],
    ['Luogo di nascita', b.birthPlace],
    ['Età', b.age ? `${b.age} anni` : null],
    ['Altezza', b.height],
    ['Peso', b.weight],
    ['Braccio', b.hand],
    ['Professionista dal', b.debutYear],
    ['Stato', b.status],
  ].filter(r => r[1]);
  if (!rows.length) return `<p class="text-muted">Nessun dato anagrafico.</p>`;
  return `<dl class="pc-dl">` +
    rows.map(([k, v]) => `<div class="pc-dl-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('') +
    `</dl>`;
}

function _formaHtml(rows) {
  if (!rows || !rows.length) {
    return `<p class="text-muted">Nessun match concluso nelle ultime ${GIORNI_FORMA} giornate.</p>`;
  }
  const wins = rows.filter(r => r.win).length;
  const dots = rows.slice(0, 8).map(r =>
    `<span class="pc-dotres ${r.win ? 'win' : 'loss'}" title="${r.win ? 'Vittoria' : 'Sconfitta'}">${r.win ? 'V' : 'P'}</span>`
  ).join('');
  const head = `<div class="pc-formhead"><span class="pc-record">${wins}V–${rows.length - wins}P</span><span class="pc-dots">${dots}</span></div>`;
  const list = rows.slice(0, 8).map(r => {
    const flag = r.oppFlag ? `<img class="pc-flag" src="${r.oppFlag}" alt=""> ` : '';
    const res = r.win ? '<span class="pc-res win">Vinto</span>' : '<span class="pc-res loss">Perso</span>';
    const score = (r.my != null && r.op != null) ? ` <span class="pc-score">${r.my}-${r.op}</span>` : '';
    const meta = [r.tournament, r.round].filter(Boolean).join(' · ');
    return `<div class="pc-match">
      <div class="pc-match-l">${res}${score}<span class="pc-vs">vs ${flag}${r.opp}</span></div>
      <div class="pc-match-meta">${meta}${r.date ? ` · ${_d(r.date)}` : ''}</div>
    </div>`;
  }).join('');
  return head + `<div class="pc-matchlist">${list}</div>`;
}

// ── ESPN: BIO ─────────────────────────────────────────
function _getBio(espnId) {
  if (_bioCache.has(espnId)) return _bioCache.get(espnId);
  const p = _fetchJson(CORE_ATHLETE(espnId)).then(d => {
    if (!d) return null;
    return {
      displayName: d.displayName,
      country: (d.flag && d.flag.alt) || null,
      flag: (d.flag && d.flag.href) || null,
      birthPlace: (d.birthPlace && d.birthPlace.summary) || null,
      headshot: (d.headshot && d.headshot.href) || null,
      status: (d.status && d.status.name) || null,
      age: d.age || null,
      height: _cm(d.displayHeight) || d.displayHeight || null,
      weight: _kg(d.displayWeight) || d.displayWeight || null,
      hand: (d.hand && (d.hand.displayValue === 'Right' ? 'Destro' : d.hand.displayValue === 'Left' ? 'Sinistro' : d.hand.displayValue)) || null,
      debutYear: d.debutYear || null,
    };
  }).catch(() => null);
  _bioCache.set(espnId, p);
  return p;
}

// ── ESPN: FORMA (scoreboard ultime giornate) ──────────
function _getForma(espnId) {
  return _getSbIndex().then(idx => {
    const rows = (idx.get(String(espnId)) || []).filter(m => m.completed);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return rows;
  });
}

/** Costruisce (una sola volta) l'indice athleteId → match dalle ultime giornate. */
function _getSbIndex() {
  if (_sbIndexPromise) return _sbIndexPromise;
  const urls = [SCOREBOARD, ..._giorni(GIORNI_FORMA).map(d => `${SCOREBOARD}?dates=${d}`)];
  _sbIndexPromise = Promise.all(urls.map(u => _fetchJson(u).catch(() => null)))
    .then(list => {
      const idx = new Map();
      const seen = new Set();
      for (const data of list) {
        if (!data) continue;
        for (const ev of (data.events || [])) {
          const tname = ev.name || '';
          for (const g of (ev.groupings || [])) {
            const slug = (g.grouping && g.grouping.slug) || g.slug;
            if (slug !== 'mens-singles') continue;
            for (const c of (g.competitions || [])) {
              if (!c.id || seen.has(c.id)) continue;
              const comps = c.competitors || [];
              if (comps.length !== 2) continue;
              const ids = comps.map(x => String(x.id || ''));
              if (ids.some(i => i.includes('-'))) continue; // doppio
              seen.add(c.id);
              const st = (c.status && c.status.type) || {};
              const round = (c.round && c.round.displayName) || null;
              comps.forEach((me, i) => {
                const opp = comps[1 - i];
                const rec = {
                  date: c.date, tournament: tname, round,
                  completed: st.completed === true, state: st.state,
                  win: me.winner === true,
                  my: _setWon(me.linescores), op: _setWon(opp.linescores),
                  opp: (opp.athlete && opp.athlete.displayName) || String(opp.id || ''),
                  oppFlag: (opp.athlete && opp.athlete.flag && opp.athlete.flag.href) || null,
                };
                const key = String(me.id);
                if (!idx.has(key)) idx.set(key, []);
                idx.get(key).push(rec);
              });
            }
          }
        }
      }
      return idx;
    });
  return _sbIndexPromise;
}

// ── UTIL ──────────────────────────────────────────────
function _setWon(ls) { return (ls || []).filter(x => x && x.winner === true).length; }

function _fill(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

function _fetchJson(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { signal: ctrl.signal, cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .finally(() => clearTimeout(t));
}

/** YYYYMMDD per oggi e i giorni precedenti (fuso America/New_York). */
function _giorni(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    out.push(s.replace(/-/g, ''));
  }
  return out;
}

function _d(iso) {
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', timeZone: 'Europe/Rome' });
  } catch { return ''; }
}

/** "6' 3\"" → "190 cm". */
function _cm(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*'\s*(\d+)/);
  if (!m) return null;
  const cm = Math.round((parseInt(m[1], 10) * 12 + parseInt(m[2], 10)) * 2.54);
  return `${cm} cm`;
}

/** "170 lbs" → "77 kg". */
function _kg(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*lbs?/i);
  if (!m) return null;
  return `${Math.round(parseFloat(m[1]) * 0.453592)} kg`;
}
