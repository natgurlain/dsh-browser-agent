// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  bootstrapTheme,
  DARK_SCHEME_QUERY,
  getThemePreference,
  loadThemePreference,
  normalizeThemePreference,
  readCachedThemePreference,
  resolveTheme,
  saveThemePreference,
  setThemePreference,
  THEME_CACHE_KEY,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  watchSystemTheme,
  watchThemePreference,
} from '../src/panel/theme.ts'

type SchemeListener = (event: { matches: boolean }) => void

/** A controllable `matchMedia` for the dark-scheme query. */
function mockMatchMedia(initiallyDark: boolean) {
  const listeners = new Set<SchemeListener>()
  let dark = initiallyDark
  const matchMedia = vi.fn((query: string) => ({
    media: query,
    get matches() { return query === DARK_SCHEME_QUERY && dark },
    addEventListener: (_type: string, listener: SchemeListener) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: SchemeListener) => { listeners.delete(listener) },
  }))
  vi.stubGlobal('matchMedia', matchMedia)
  return {
    listeners,
    setDark(next: boolean): void {
      dark = next
      for (const listener of [...listeners]) listener({ matches: next })
    },
  }
}

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void

function mockChromeStorage(initial: Record<string, unknown> = {}) {
  const listeners = new Set<StorageListener>()
  const set = vi.fn(async (_items: Record<string, unknown>) => {})
  const get = vi.fn(async () => initial)
  vi.stubGlobal('chrome', {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: StorageListener) => { listeners.add(listener) },
        removeListener: (listener: StorageListener) => { listeners.delete(listener) },
      },
    },
  })
  return {
    get,
    set,
    listeners,
    emit(changes: Record<string, { newValue?: unknown }>, area = 'local'): void {
      for (const listener of [...listeners]) listener(changes, area)
    },
  }
}

const html = (): HTMLElement => document.documentElement

describe('panel theme preference', () => {
  beforeEach(() => {
    localStorage.clear()
    html().removeAttribute('data-theme')
    html().removeAttribute('data-resolved-theme')
    document.head.innerHTML = '<meta name="theme-color" content="#f4f6fa">'
    mockMatchMedia(false)
    setThemePreference('auto')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('normalises anything unknown to auto', () => {
    expect(normalizeThemePreference('light')).toBe('light')
    expect(normalizeThemePreference('dark')).toBe('dark')
    expect(normalizeThemePreference('auto')).toBe('auto')
    for (const value of [undefined, null, '', 'DARK', 'system', 1, {}, true]) {
      expect(normalizeThemePreference(value)).toBe('auto')
    }
  })

  it('resolves auto against the system scheme and lets an explicit choice win', () => {
    expect(resolveTheme('auto', false)).toBe('light')
    expect(resolveTheme('auto', true)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('nonsense', true)).toBe('dark')
  })

  it('reads the system scheme from matchMedia by default', () => {
    expect(resolveTheme('auto')).toBe('light')
    mockMatchMedia(true)
    expect(resolveTheme('auto')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })

  it('falls back to light when matchMedia is unavailable or throws', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(resolveTheme('auto')).toBe('light')
    vi.stubGlobal('matchMedia', () => { throw new Error('blocked') })
    expect(resolveTheme('auto')).toBe('light')
  })

  it('writes the preference, the resolved theme and the theme-color onto the document', () => {
    expect(applyTheme('dark')).toBe('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-resolved-theme')).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.dark)

    expect(applyTheme('auto')).toBe('light')
    expect(html().getAttribute('data-theme')).toBe('auto')
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.light)
  })

  it('persists a choice to chrome.storage, mirrors it to localStorage and applies it at once', () => {
    const storage = mockChromeStorage()
    expect(saveThemePreference('dark')).toBe('dark')
    expect(storage.set).toHaveBeenCalledWith({ [THEME_STORAGE_KEY]: 'dark' })
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('dark')
    expect(getThemePreference()).toBe('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')

    expect(saveThemePreference('auto')).toBe('auto')
    expect(storage.set).toHaveBeenLastCalledWith({ [THEME_STORAGE_KEY]: 'auto' })
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull()
    expect(html().getAttribute('data-theme')).toBe('auto')
  })

  it('still switches in memory when storage rejects or is missing', async () => {
    const storage = mockChromeStorage()
    storage.set.mockRejectedValueOnce(new Error('quota'))
    expect(saveThemePreference('light')).toBe('light')
    await Promise.resolve()
    expect(html().getAttribute('data-theme')).toBe('light')

    vi.stubGlobal('chrome', undefined)
    expect(saveThemePreference('dark')).toBe('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')
  })

  it('bootstraps synchronously from the localStorage mirror', () => {
    localStorage.setItem(THEME_CACHE_KEY, 'dark')
    expect(readCachedThemePreference()).toBe('dark')
    expect(bootstrapTheme()).toBe('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-resolved-theme')).toBe('dark')

    localStorage.setItem(THEME_CACHE_KEY, 'purple')
    expect(bootstrapTheme()).toBe('auto')
    expect(html().getAttribute('data-theme')).toBe('auto')
  })

  it('reconciles the mirror with chrome.storage, which wins', async () => {
    localStorage.setItem(THEME_CACHE_KEY, 'dark')
    bootstrapTheme()
    mockChromeStorage({ [THEME_STORAGE_KEY]: 'light' })
    await expect(loadThemePreference()).resolves.toBe('light')
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('light')
    expect(html().getAttribute('data-theme')).toBe('light')

    // Nothing stored (fresh profile, or the preference was reset elsewhere).
    mockChromeStorage({})
    await expect(loadThemePreference()).resolves.toBe('auto')
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull()
  })

  it('keeps the mirrored preference when the storage read fails', async () => {
    setThemePreference('dark')
    const storage = mockChromeStorage()
    storage.get.mockRejectedValueOnce(new Error('context invalidated'))
    await expect(loadThemePreference()).resolves.toBe('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')
  })

  it('follows the OS scheme live while on auto', () => {
    const media = mockMatchMedia(false)
    setThemePreference('auto')
    const seen: string[] = []
    const stop = watchSystemTheme((resolved) => seen.push(resolved))
    expect(html().getAttribute('data-resolved-theme')).toBe('light')

    media.setDark(true)
    expect(html().getAttribute('data-theme')).toBe('auto')
    expect(html().getAttribute('data-resolved-theme')).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.dark)

    media.setDark(false)
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
    expect(seen).toEqual(['dark', 'light'])

    stop()
    expect(media.listeners.size).toBe(0)
    media.setDark(true)
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
  })

  it('ignores the OS scheme while a theme is forced', () => {
    const media = mockMatchMedia(false)
    setThemePreference('light')
    watchSystemTheme()
    media.setDark(true)
    expect(html().getAttribute('data-theme')).toBe('light')
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
  })

  it('applies a preference stored by another open panel', () => {
    const storage = mockChromeStorage()
    const seen: string[] = []
    const stop = watchThemePreference((preference) => seen.push(preference))

    storage.emit({ [THEME_STORAGE_KEY]: { newValue: 'dark' } })
    expect(getThemePreference()).toBe('dark')
    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('dark')

    // Other areas and other keys are not ours; a removed value means auto.
    storage.emit({ [THEME_STORAGE_KEY]: { newValue: 'light' } }, 'sync')
    storage.emit({ dshPanelUiLocale: { newValue: 'zh' } })
    expect(html().getAttribute('data-theme')).toBe('dark')
    storage.emit({ [THEME_STORAGE_KEY]: {} })
    expect(html().getAttribute('data-theme')).toBe('auto')
    expect(seen).toEqual(['dark', 'auto'])

    stop()
    expect(storage.listeners.size).toBe(0)
  })

  it('applies both kinds of live update without a callback', () => {
    const storage = mockChromeStorage()
    const media = mockMatchMedia(false)
    setThemePreference('auto')
    watchThemePreference()
    watchSystemTheme()

    media.setDark(true)
    expect(html().getAttribute('data-resolved-theme')).toBe('dark')
    storage.emit({ [THEME_STORAGE_KEY]: { newValue: 'light' } })
    expect(html().getAttribute('data-theme')).toBe('light')
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
  })

  it('degrades to a no-op watcher without storage.onChanged or matchMedia', () => {
    vi.stubGlobal('chrome', {})
    expect(() => watchThemePreference()()).not.toThrow()
    vi.stubGlobal('matchMedia', undefined)
    expect(() => watchSystemTheme()()).not.toThrow()
  })
})

describe('panel theme bootstrap script', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../panel/theme-boot.js'), 'utf8')
  const run = (): void => { new Function(source)() }

  beforeEach(() => {
    localStorage.clear()
    html().removeAttribute('data-theme')
  })

  it('is loaded as a render-blocking classic script ahead of the app', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../panel/index.html'), 'utf8')
    expect(page).toMatch(/<script src="\.\/theme-boot\.js" vite-ignore><\/script>/)
    expect(page.indexOf('theme-boot.js')).toBeLessThan(page.indexOf('main.tsx'))
    expect(page).toContain('<meta name="color-scheme" content="light dark" />')
  })

  it('shares the mirror key with theme.ts', () => {
    expect(source).toContain(`localStorage.getItem('${THEME_CACHE_KEY}')`)
  })

  it('applies a forced theme and leaves auto to the stylesheet', () => {
    run()
    expect(html().hasAttribute('data-theme')).toBe(false)
    localStorage.setItem(THEME_CACHE_KEY, 'dark')
    run()
    expect(html().getAttribute('data-theme')).toBe('dark')
    localStorage.setItem(THEME_CACHE_KEY, 'light')
    run()
    expect(html().getAttribute('data-theme')).toBe('light')
  })

  it('ignores a corrupt mirror', () => {
    localStorage.setItem(THEME_CACHE_KEY, 'javascript:alert(1)')
    run()
    expect(html().hasAttribute('data-theme')).toBe(false)
  })
})
