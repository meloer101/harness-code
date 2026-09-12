/* Applies the persisted theme before first paint so a dark user never sees a
   light flash. External file (not inline) because the server's CSP is
   `script-src 'self'`. Mirrors src/lib/theme.ts — keep the key in sync. */
(function () {
  var theme = 'system';
  try {
    theme = localStorage.getItem('hc.theme') || 'system';
  } catch (e) {
    /* storage blocked — fall back to system */
  }
  var dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
})();
