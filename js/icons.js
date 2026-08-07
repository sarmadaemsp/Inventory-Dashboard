/* ============================================================
   icons.js — Lucide icon helper for vanilla JS templates.

   Usage in HTML templates:
     ${Icons.tag('package')}
     ${Icons.tag('search', { size: 14, cls: 'btn-icon' })}

   Static HTML elements use <i data-lucide="name"> directly;
   the MutationObserver picks them up automatically.
   ============================================================ */

const Icons = (() => {

  function tag(name, { size = 16, cls = '', style = '' } = {}) {
    const s = `width:${size}px;height:${size}px;flex-shrink:0;${style}`;
    return `<i data-lucide="${name}" class="icon${cls ? ' ' + cls : ''}" style="${s}" aria-hidden="true"></i>`;
  }

  function refresh() {
    if (window.lucide) lucide.createIcons();
  }

  function _initObserver() {
    if (!window.MutationObserver || !window.lucide) return;
    const obs = new MutationObserver(() => {
      if (document.querySelector('i[data-lucide]')) lucide.createIcons();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (window.lucide) lucide.createIcons();
    _initObserver();
  }

  return { tag, refresh, init };
})();
