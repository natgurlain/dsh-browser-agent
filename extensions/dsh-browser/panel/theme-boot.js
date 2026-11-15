// Render-blocking theme bootstrap for the side panel (classic script on
// purpose: module scripts are deferred, and MV3 forbids inline scripts).
// Puts a forced light/dark choice on <html> before the stylesheet paints, so
// the panel never flashes the other palette. `auto` needs nothing here: the
// stylesheet follows prefers-color-scheme by itself. src/panel/theme.ts owns
// the model and keeps this localStorage mirror in step with chrome.storage.
(function () {
  try {
    var theme = localStorage.getItem('dshPanelTheme')
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
  } catch (error) {
    // No mirror available: the panel starts on the system scheme.
  }
})()
