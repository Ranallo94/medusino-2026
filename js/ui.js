/**
 * MEDUSINO — ui.js
 * Utilities UI: toast, modal, spinner, helpers DOM
 */

// ── TOAST ─────────────────────────────────────────────
let _toastTimer = null;

/**
 * Mostra una notifica toast temporanea.
 * @param {string} msg       Testo da mostrare
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {number} duration  ms (default 3000)
 */
export function showToast(msg, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' }[type] || 'ℹ️';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${msg}</span>`;

  container.appendChild(toast);

  // Trigger animazione entrata
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  // Auto-remove
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}

// ── MODAL ─────────────────────────────────────────────
/**
 * Apre il modal con titolo, corpo HTML e bottoni footer.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.body         HTML
 * @param {Array}  opts.buttons      [{ label, class, onClick }]
 */
export function openModal({ title = '', body = '', buttons = [] } = {}) {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const bodyEl  = document.getElementById('modal-body');
  const footerEl = document.getElementById('modal-footer');
  const closeBtn = document.getElementById('modal-close');

  titleEl.textContent = title;
  bodyEl.innerHTML = body;
  footerEl.innerHTML = '';

  buttons.forEach(({ label, cls = 'btn btn-secondary', onClick }) => {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (onClick) onClick();
    });
    footerEl.appendChild(btn);
  });

  overlay.style.display = '';

  // Chiusura X
  closeBtn.onclick = closeModal;

  // Chiusura click fuori
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  // Chiusura ESC
  document.addEventListener('keydown', _escListener);
}

function _escListener(e) {
  if (e.key === 'Escape') closeModal();
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.style.display = 'none';
  document.removeEventListener('keydown', _escListener);
}

// ── SPINNER ───────────────────────────────────────────
/**
 * Sostituisce il contenuto di un elemento con uno spinner di caricamento.
 */
export function showSpinner(containerId, msg = 'Caricamento…') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>${msg}</p>
    </div>`;
}

/**
 * Mostra un messaggio di errore in un contenitore.
 */
export function showError(containerId, msg = 'Errore nel caricamento.') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <p>${msg}</p>
    </div>`;
}

/**
 * Mostra uno stato vuoto in un contenitore.
 */
export function showEmpty(containerId, msg = 'Nessun dato disponibile.', icon = '📭') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <p>${msg}</p>
    </div>`;
}

// ── HELPERS ───────────────────────────────────────────
/**
 * Formatta una data ISO in italiano.
 * @param {string} iso  es. "2026-06-11T18:00:00Z"
 * @param {boolean} includeTime
 */
export function formatDate(iso, includeTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts = { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Rome' };
  if (includeTime) {
    opts.hour = '2-digit';
    opts.minute = '2-digit';
  }
  return d.toLocaleString('it-IT', opts);
}

/**
 * Formatta solo l'orario da una stringa ISO.
 */
export function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
}

/**
 * Crea un elemento DOM da una stringa HTML.
 */
export function html2el(htmlStr) {
  const tpl = document.createElement('template');
  tpl.innerHTML = htmlStr.trim();
  return tpl.content.firstElementChild;
}

/**
 * Debounce: ritarda l'esecuzione di fn di `wait` ms.
 */
export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
