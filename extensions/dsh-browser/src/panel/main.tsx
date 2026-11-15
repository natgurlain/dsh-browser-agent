import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import { getUiLocale, loadUiLocalePreference } from '../i18n.ts'
import { PANEL_COPY } from './strings.ts'
import { bootstrapTheme, loadThemePreference } from './theme.ts'

// Theme first, synchronously: the mirrored preference goes on <html> before
// anything renders (panel/theme-boot.js already did the same ahead of the first
// paint; this also records the resolved theme). chrome.storage, the source of
// truth, is reconciled below together with the language.
bootstrapTheme()

// Read the stored UI language before the first paint: rendering in the browser
// language and then swapping it would flash the wrong locale. Neither `load...`
// rejects (each falls back to its cached preference), so the panel always mounts.
void Promise.all([loadUiLocalePreference(), loadThemePreference()]).then(() => {
  const locale = getUiLocale()
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  document.title = PANEL_COPY[locale].documentTitle

  const root = document.getElementById('root')
  if (root === null) throw new Error('panel root missing')
  createRoot(root).render(<App />)
})
