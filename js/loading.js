/* ============================================================
   loading.js — Skeleton loaders, button loading states,
                table placeholders, page-level spinners
   ============================================================ */

const Loading = {

  /* ── Button ─────────────────────────────────────────────── */
  btn(btn, loading = true) {
    if (!btn) return;
    if (loading) {
      btn._originalText = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('btn-loading');
      btn.innerHTML = btn._loadingText || btn._originalText;
    } else {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      if (btn._originalText != null) btn.innerHTML = btn._originalText;
    }
  },

  /* ── Skeleton lines ─────────────────────────────────────── */
  skelLines(count = 4, widths = null) {
    const defaultWidths = ['85%', '70%', '90%', '60%', '78%', '55%', '80%'];
    let html = '';
    for (let i = 0; i < count; i++) {
      const w = widths ? widths[i % widths.length] : defaultWidths[i % defaultWidths.length];
      html += `<div class="skel skel-line" style="width:${w};margin-bottom:10px"></div>`;
    }
    return html;
  },

  /* ── Table skeleton ─────────────────────────────────────── */
  tableRows(cols = 5, rows = 8) {
    let html = '';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) {
        const w = 60 + Math.floor(Math.random() * 30);
        html += `<td><div class="skel skel-line" style="width:${w}%;height:12px"></div></td>`;
      }
      html += '</tr>';
    }
    return html;
  },

  /* ── KPI skeleton ───────────────────────────────────────── */
  kpiGrid(count = 4) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `
        <div class="kpi-card">
          <div class="skel skel-line" style="width:60%;height:11px;margin-bottom:10px"></div>
          <div class="skel skel-line" style="width:45%;height:28px;margin-bottom:8px"></div>
          <div class="skel skel-line" style="width:70%;height:10px"></div>
        </div>`;
    }
    return html;
  },

  /* ── Inline spinner html ────────────────────────────────── */
  spinnerHtml(size = '') {
    return `<div class="spin${size ? ' spin-' + size : ''}"></div>`;
  },

  /* ── Section overlay ────────────────────────────────────── */
  section(el, loading = true) {
    if (!el) return;
    if (loading) {
      if (!el.querySelector('.section-spinner')) {
        const overlay = document.createElement('div');
        overlay.className = 'section-spinner';
        overlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.7);z-index:10;border-radius:inherit';
        overlay.innerHTML = Loading.spinnerHtml();
        el.style.position = 'relative';
        el.appendChild(overlay);
      }
    } else {
      el.querySelector('.section-spinner')?.remove();
    }
  },

  /* ── Show/hide a named loading state within a container ── */
  show(containerId, html) {
    const el = document.getElementById(containerId);
    if (el) el.innerHTML = html;
  },

  /* ── Empty state ────────────────────────────────────────── */
  // icon: a Lucide icon name string (e.g. 'package', 'calendar')
  empty(icon = 'package', text = 'No data found', sub = '') {
    const iconHtml = `<i data-lucide="${icon}" class="icon" style="width:32px;height:32px;opacity:.35" aria-hidden="true"></i>`;
    return `
      <div class="empty-state">
        <div class="empty-icon">${iconHtml}</div>
        <div class="empty-text">${Utils.escapeHtml(text)}</div>
        ${sub ? `<div class="empty-sub">${Utils.escapeHtml(sub)}</div>` : ''}
      </div>`;
  },

  /* ── Full-page interaction lock ─────────────────────────── */
  // Shows a blurred fullscreen overlay with spinner that blocks ALL clicks/keystrokes.
  // Used during org switching, data recalculation, and other moments where the user
  // must NEVER interact with stale or partial state.
  lock(show = true, message = 'Loading…') {
    let overlay = document.getElementById('app-lock');
    if (show) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'app-lock';
        overlay.className = 'app-lock';
        overlay.innerHTML = `
          <div class="app-lock-inner">
            <div class="spin spin-lg"></div>
            <div class="app-lock-text"></div>
          </div>`;
        document.body.appendChild(overlay);
      }
      const txt = overlay.querySelector('.app-lock-text');
      if (txt) txt.textContent = message;
      requestAnimationFrame(() => overlay.classList.add('visible'));
    } else if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => overlay.remove(), 180);
    }
  },

  /* ── Error state ────────────────────────────────────────── */
  error(message = 'Failed to load data', onRetry = null) {
    const retryBtn = onRetry
      ? `<button class="btn btn-secondary btn-sm" onclick="(${onRetry.toString()})()">Retry</button>`
      : '';
    return `
      <div class="empty-state">
        <div class="empty-icon"><i data-lucide="alert-triangle" class="icon" style="width:32px;height:32px;color:var(--error);opacity:.7" aria-hidden="true"></i></div>
        <div class="empty-text">${Utils.escapeHtml(message)}</div>
        ${retryBtn}
      </div>`;
  },
};
