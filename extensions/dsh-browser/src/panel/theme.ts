/**
 * Panel colour-theme preference.
 *
 * `auto` (the default) follows the browser/OS through `prefers-color-scheme`;
 * `light` and `dark` force one. The stylesheet does the actual work: it keys
 * the dark palette off `<html data-theme="dark">`, and off the media query
 * unless `data-theme="light"`. This module only decides what goes on `<html>`,
 * where the choice is stored, and how open panels hear about a change.
 *
 * Storage mirrors the UI language (`i18n.ts`): a small `chrome.storage.local`
 * value owned by the panel. Because that read is asynchronous, the last known
 * value is also mirrored into the panel page's `localStorage`, which
 * `panel/theme-boot.js` (a render-blocking classic script) and `main.tsx` read
 * synchronously so a forced theme is on `<html>` before the first paint.
 *
 * The on-page agent overlay deliberately does not follow this preference: it
 * is drawn over arbitrary sites and has to stay visible on any of them.
 *
 * @module
 */

/** What the user picked in Settings; `auto` follows the browser/OS. */
export type ThemePreference = 'auto' | 'light' | 'dark'

/** The palette actually on screen. */
export type ResolvedTheme = 'light' | 'dark'

/** `chrome.storage.local` key holding the persisted preference. */
export const THEME_STORAGE_KEY = 'dshPanelTheme'

/** `localStorage` key of the synchronous mirror; `panel/theme-boot.js` reads the same key. */
export const THEME_CACHE_KEY = 'dshPanelTheme'

/** Attribute on `<html>` the stylesheet keys the palette off (`auto` | `light` | `dark`). */
export const THEME_ATTRIBUTE = 'data-theme'

/** Attribute on `<html>` carrying the palette in effect, for tests and theme-aware code. */
export const RESOLVED_THEME_ATTRIBUTE = 'data-resolved-theme'

/** Media query the `auto` preference follows. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

/**
 * Browser-chrome colour per palette (`<meta name="theme-color">`). Kept equal
 * to the `--canvas` token of each theme; the contrast spec asserts that.
 */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#f4f6fa', dark: '#12161e' }

/** Snap a stored or user-supplied value onto a supported preference. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto'
}

/** True when the browser/OS currently asks for a dark scheme. */
export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_SCHEME_QUERY).matches
  } catch {
    return false
  }
}

/** Resolve the preference to a palette; an explicit choice beats the system. */
export function resolveTheme(preference: unknown, prefersDark: boolean = systemPrefersDark()): ResolvedTheme {
  const normalized = normalizeThemePreference(preference)
  if (normalized === 'auto') return prefersDark ? 'dark' : 'light'
  return normalized
}

/** Write the preference onto the document so the stylesheet picks it up. */
export function applyTheme(
  preference: unknown,
  root: HTMLElement = document.documentElement,
  prefersDark: boolean = systemPrefersDark(),
): ResolvedTheme {
  const normalized = normalizeThemePreference(preference)
  const resolved = resolveTheme(normalized, prefersDark)
  root.setAttribute(THEME_ATTRIBUTE, normalized)
  root.setAttribute(RESOLVED_THEME_ATTRIBUTE, resolved)
  root.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved])
  return resolved
}

/** Synchronous read of the mirrored preference; `auto` when missing or blocked. */
export function readCachedThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_CACHE_KEY))
  } catch {
    return 'auto'
  }
}

/** Keep the synchronous mirror in step with the real preference. */
export function cacheThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'auto') localStorage.removeItem(THEME_CACHE_KEY)
    else localStorage.setItem(THEME_CACHE_KEY, preference)
  } catch {
    // A blocked localStorage only costs the pre-paint hint.
  }
}

/** Latest preference known to this panel; seeded from the synchronous mirror. */
let cachedPreference: ThemePreference | undefined

/** The preference currently in effect in this panel. */
export function getThemePreference(): ThemePreference {
  cachedPreference ??= readCachedThemePreference()
  return cachedPreference
}

/** Update the in-memory value, the mirror and the document, without touching storage. */
export function setThemePreference(value: unknown): ThemePreference {
  cachedPreference = normalizeThemePreference(value)
  cacheThemePreference(cachedPreference)
  if (typeof document !== 'undefined') applyTheme(cachedPreference)
  return cachedPreference
}

/**
 * First thing the panel runs: put the mirrored preference on `<html>` before
 * React renders. `chrome.storage.local` is reconciled afterwards.
 */
export function bootstrapTheme(): ThemePreference {
  cachedPreference = readCachedThemePreference()
  applyTheme(cachedPreference)
  return cachedPreference
}

/** Load the persisted preference and apply it; falls back to the mirror on failure. */
export async function loadThemePreference(): Promise<ThemePreference> {
  try {
    if (typeof chrome === 'undefined' || chrome.storage?.local === undefined) return getThemePreference()
    const stored = await chrome.storage.local.get(THEME_STORAGE_KEY)
    return setThemePreference(stored[THEME_STORAGE_KEY])
  } catch {
    return getThemePreference()
  }
}

/** Persist a choice and apply it to this panel immediately. */
export function saveThemePreference(value: unknown): ThemePreference {
  const preference = setThemePreference(value)
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
      void chrome.storage.local.set({ [THEME_STORAGE_KEY]: preference }).catch(() => {})
    }
  } catch {
    // A storage failure must not break the in-memory switch.
  }
  return preference
}

/**
 * Follow a preference change made by another open panel. The new value is
 * applied to this document before `onChange` runs. Returns an unsubscribe
 * function; a context without `storage.onChanged` gets a no-op.
 */
export function watchThemePreference(onChange?: (preference: ThemePreference) => void): () => void {
  if (typeof chrome === 'undefined' || chrome.storage?.onChanged === undefined) return () => {}
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return
    const change = changes[THEME_STORAGE_KEY]
    if (change === undefined) return
    // Apply first, unconditionally: `onChange?.(f())` would skip `f` without a callback.
    const preference = setThemePreference(change.newValue)
    onChange?.(preference)
  }
  try {
    chrome.storage.onChanged.addListener(listener)
  } catch {
    return () => {}
  }
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener)
    } catch {
      // The context may already be torn down; there is nothing left to detach.
    }
  }
}

/**
 * Follow the browser/OS scheme. The stylesheet repaints on its own; this keeps
 * the resolved attribute and the `theme-color` meta in step, and tells the
 * caller which palette is now showing. Returns an unsubscribe function.
 */
export function watchSystemTheme(onChange?: (resolved: ResolvedTheme) => void): () => void {
  let query: MediaQueryList
  try {
    if (typeof matchMedia !== 'function') return () => {}
    query = matchMedia(DARK_SCHEME_QUERY)
  } catch {
    return () => {}
  }
  const listener = (event: { matches: boolean }): void => {
    const resolved = applyTheme(getThemePreference(), document.documentElement, event.matches)
    onChange?.(resolved)
  }
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
