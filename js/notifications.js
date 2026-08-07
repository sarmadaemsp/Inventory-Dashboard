/* ============================================================
   notifications.js — Toast notification system
   ============================================================ */

const Notify = (() => {
  let container = null;

  function getContainer() {
    if (!container) {
      container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
      }
    }
    return container;
  }

  const ICON_NAMES = {
    success: 'check-circle',
    error:   'x-circle',
    warning: 'alert-triangle',
    info:    'info',
  };

  function show(type, title, message, duration = 4500) {
    const c     = getContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} anim-slide-right`;
    const iconName = ICON_NAMES[type] || 'info';
    toast.innerHTML = `
      <span class="toast-icon"><i data-lucide="${iconName}" class="icon" style="width:16px;height:16px" aria-hidden="true"></i></span>
      <div>
        <div class="toast-title">${Utils.escapeHtml(title)}</div>
        ${message ? `<div class="toast-msg">${Utils.escapeHtml(message)}</div>` : ''}
      </div>
    `;

    toast.addEventListener('click', () => dismiss(toast));
    c.appendChild(toast);

    if (duration > 0) {
      setTimeout(() => dismiss(toast), duration);
    }
    return toast;
  }

  function dismiss(toast) {
    if (!toast || toast._dismissing) return;
    toast._dismissing = true;
    toast.classList.add('dismissing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  }

  return {
    success(title, message, duration)  { return show('success', title, message, duration); },
    error(title, message, duration)    { return show('error',   title, message, duration ?? 7000); },
    warning(title, message, duration)  { return show('warning', title, message, duration); },
    info(title, message, duration)     { return show('info',    title, message, duration); },

    apiError(err) {
      const msg = err?.message || 'An unexpected error occurred.';
      return show('error', 'Request Failed', msg, 7000);
    },

    clear() {
      const c = getContainer();
      Array.from(c.children).forEach(t => dismiss(t));
    },
  };
})();
