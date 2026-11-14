/*
 * Arcade save helper — progress lives in this browser's localStorage
 * (GitHub Pages is static hosting, so there is no server to save to).
 *
 *  - Asks the browser to make our storage persistent, so it isn't cleared
 *    automatically when the device runs low on space (Chrome, Edge, Firefox,
 *    and Safari for sites added to the Home Screen).
 *  - Detects when saving is impossible (e.g. some private-browsing modes)
 *    and shows a small banner so players aren't surprised later.
 */
(function () {
  'use strict';
  let available = true;
  try {
    const k = 'arcade.__probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
  } catch (e) { available = false; }

  const S = { available, persisted: false };
  window.ArcadeStorage = S;

  if (available && navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
      .then((p) => (p ? true : navigator.storage.persist()))
      .then((granted) => { S.persisted = !!granted; })
      .catch(() => { /* not supported — localStorage still works */ });
  }

  if (!available) {
    const show = () => {
      const b = document.createElement('div');
      b.setAttribute('role', 'status');
      b.textContent = 'Heads up: this browser isn’t saving game progress (private browsing?). Scores will reset when you close the tab.';
      b.style.cssText = 'position:fixed;left:8px;right:8px;bottom:max(8px,env(safe-area-inset-bottom));z-index:99;' +
        'padding:10px 12px;border:2px solid #000;border-radius:8px;background:#ff6a5c;color:#1d1b2e;' +
        'font:700 13px/1.4 "Courier New",monospace;text-align:center;box-shadow:0 4px 0 #000';
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 9000);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
  }
})();
