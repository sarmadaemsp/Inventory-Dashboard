/* ============================================================
   utilities.js — Global config, formatting helpers, DOM utils,
                  file conversion, Modal class
   ============================================================ */

// ── Runtime config ────────────────────────────────────────────────────────────
// Using var (not const) so these live on window and are visible in DevTools.
// CANONICAL Cloud Run hostname for the patman-inventory-api service. There is
// exactly ONE production API base URL — do NOT duplicate this constant or
// hardcode the URL elsewhere in the frontend (api.js + every module read
// from CONFIG.CLOUD_RUN_URL). The legacy `*-znfextdp4q-uc.a.run.app`
// hostname is decommissioned; all traffic must flow through the canonical
// project-number host below.
var CLOUD_RUN_URL = 'https://patman-inventory-api-471065748321.us-central1.run.app';

var CONFIG = {
  CLOUD_RUN_URL,
  SESSION_KEY:      'patman_token',
  USER_KEY:         'patman_user',
  ORG_KEY:          'patman_org',
  MEMBERSHIPS_KEY:  'patman_memberships',
  TIMEOUT_MS:       30000,
  MAX_RETRIES:      2,
  PAGE_SIZE:        50,
  getPageSize() { return 50; },
};

/* ── Utils ──────────────────────────────────────────────────── */
const Utils = {

  /* ── Formatting ─────────────────────────────────────────── */
  formatNumber(n, decimals = 0) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  },

  formatCurrency(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    try {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return '—'; }
  },

  toDateInputValue(iso) {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso).trim())) return String(iso).trim();
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  },

  formatDatetime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return iso; }
  },

  timeAgo(iso) {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins  < 1)   return 'just now';
    if (mins  < 60)  return `${mins}m ago`;
    if (hours < 24)  return `${hours}h ago`;
    if (days  < 30)  return `${days}d ago`;
    return Utils.formatDate(iso);
  },

  /* ── DOM ─────────────────────────────────────────────────── */
  $(selector, ctx = document) {
    return ctx.querySelector(selector);
  },

  $$(selector, ctx = document) {
    return Array.from(ctx.querySelectorAll(selector));
  },

  el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class')      e.className = v;
      else if (k === 'html')  e.innerHTML = v;
      else if (k === 'text')  e.textContent = v;
      else                    e.setAttribute(k, v);
    }
    for (const c of children) {
      if (typeof c === 'string') e.insertAdjacentHTML('beforeend', c);
      else if (c instanceof Node) e.appendChild(c);
    }
    return e;
  },

  escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  on(el, event, selector, fn) {
    if (typeof selector === 'function') {
      el.addEventListener(event, selector);
    } else {
      el.addEventListener(event, e => {
        const t = e.target.closest(selector);
        if (t && el.contains(t)) fn.call(t, e, t);
      });
    }
  },

  setText(selector, value, ctx = document) {
    const el = ctx.querySelector(selector);
    if (el) el.textContent = value ?? '—';
  },

  show(selector, ctx = document) {
    const el = typeof selector === 'string' ? ctx.querySelector(selector) : selector;
    if (el) el.style.display = '';
  },

  hide(selector, ctx = document) {
    const el = typeof selector === 'string' ? ctx.querySelector(selector) : selector;
    if (el) el.style.display = 'none';
  },

  toggle(selector, force, ctx = document) {
    const el = typeof selector === 'string' ? ctx.querySelector(selector) : selector;
    if (!el) return;
    if (force === undefined) el.style.display = el.style.display === 'none' ? '' : 'none';
    else el.style.display = force ? '' : 'none';
  },

  /* ── File ────────────────────────────────────────────────── */
  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = ()  => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  },

  async fileToCSV(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
      return Utils.readFileAsText(file);
    }
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
      const buffer = await file.arrayBuffer();
      const wb     = XLSX.read(buffer, { type: 'array' });
      const ws     = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_csv(ws);
    }
    throw new Error(`Unsupported file type: ${file.name}`);
  },

  formatFileSize(bytes) {
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  },

  /* ── Misc ────────────────────────────────────────────────── */
  debounce(fn, delay) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
  },

  clamp(n, min, max) { return Math.min(Math.max(n, min), max); },

  capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; },

  buildQueryString(obj) {
    return Object.entries(obj)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  },

  badgeHtml(variant, text) {
    return `<span class="badge badge-${Utils.escapeHtml(variant)}">${Utils.escapeHtml(text)}</span>`;
  },

  stockBadge(qty) {
    qty = Number(qty);
    if (qty === 0)  return `<span class="stock-zero">${qty}</span>`;
    if (qty <= 10)  return `<span class="stock-low">${qty}</span>`;
    return `<span class="stock-positive">${qty}</span>`;
  },
};

/* ── Modal ──────────────────────────────────────────────────── */
class Modal {
  constructor({ id, title, body, footer, maxWidth = '500px', onShow, onHide } = {}) {
    this.id      = id || ('modal-' + Math.random().toString(36).slice(2));
    this.onShow  = onShow;
    this.onHide  = onHide;
    this._build(title, body, footer, maxWidth);
  }

  _build(title, body, footer, maxWidth) {
    this.overlay = Utils.el('div', { class: 'modal-overlay', style: 'display:none' });
    const modal  = Utils.el('div', { class: 'modal', style: `max-width:${maxWidth}` });

    const header = Utils.el('div', { class: 'modal-header' });
    this.titleEl = Utils.el('div', { class: 'modal-title', text: title || '' });
    const closeBtn = Utils.el('button', { class: 'btn btn-ghost btn-icon btn-sm', html: '&times;' });
    closeBtn.addEventListener('click', () => this.hide());
    header.append(this.titleEl, closeBtn);

    this.bodyEl   = Utils.el('div', { class: 'modal-body' });
    if (body) {
      if (typeof body === 'string') this.bodyEl.innerHTML = body;
      else this.bodyEl.appendChild(body);
    }

    this.footerEl = Utils.el('div', { class: 'modal-footer' });
    if (footer) {
      if (typeof footer === 'string') this.footerEl.innerHTML = footer;
      else this.footerEl.appendChild(footer);
    }

    modal.append(header, this.bodyEl, this.footerEl);
    this.overlay.appendChild(modal);
    this.overlay.addEventListener('click', e => { if (e.target === this.overlay) this.hide(); });
    document.body.appendChild(this.overlay);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.overlay.style.display !== 'none') this.hide();
    });
  }

  show() {
    this.overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    if (this.onShow) this.onShow(this);
    this.overlay.querySelector('.modal')?.classList.add('anim-scale-in');
    return this;
  }

  hide() {
    this.overlay.style.display = 'none';
    document.body.style.overflow = '';
    if (this.onHide) this.onHide(this);
    return this;
  }

  setTitle(t)    { this.titleEl.textContent = t; return this; }
  setBody(html)  { this.bodyEl.innerHTML = html; return this; }
  setFooter(html){ this.footerEl.innerHTML = html; return this; }

  destroy() {
    this.overlay.remove();
  }

  static confirm({ title = 'Confirm', message, confirmText = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
      const m = new Modal({
        title,
        body: `<p style="color:var(--txt-2);font-size:14px;line-height:1.6">${Utils.escapeHtml(message)}</p>`,
        footer: `
          <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-action="confirm">${Utils.escapeHtml(confirmText)}</button>
        `,
      });
      m.show();
      m.footerEl.addEventListener('click', e => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'confirm') { m.hide(); m.destroy(); resolve(true); }
        if (action === 'cancel')  { m.hide(); m.destroy(); resolve(false); }
      });
    });
  }
}
