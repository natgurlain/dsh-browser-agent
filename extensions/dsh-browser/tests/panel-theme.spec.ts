// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelApi } from '../src/panel/api.ts'
import { fakePanelApi } from './support/panel-api.ts'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', () => ({
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'
import { setUiLocalePreference } from '../src/i18n.ts'
import { setThemePreference, THEME_CACHE_KEY } from '../src/panel/theme.ts'

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void
type SchemeListener = (event: { matches: boolean }) => void

describe('panel theme setting', () => {
  let root: Root
  let set: ReturnType<typeof vi.fn>
  let storageListeners: Set<StorageListener>
  let schemeListeners: Set<SchemeListener>
  let systemDark: boolean

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-resolved-theme')
    localStorage.clear()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    set = vi.fn(async () => {})
    storageListeners = new Set()
    schemeListeners = new Set()
    systemDark = false
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      get matches() { return systemDark },
      addEventListener: (_type: string, listener: SchemeListener) => { schemeListeners.add(listener) },
      removeEventListener: (_type: string, listener: SchemeListener) => { schemeListeners.delete(listener) },
    }))
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })),
          set,
        },
        onChanged: {
          addListener: (listener: StorageListener) => { storageListeners.add(listener) },
          removeListener: (listener: StorageListener) => { storageListeners.delete(listener) },
        },
      },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
      runtime: {
        getManifest: () => ({ version: '0.1.8' }),
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
    })
    panelApi = fakePanelApi()
    setUiLocalePreference('auto')
    setThemePreference('auto')
    vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    setUiLocalePreference('auto')
    setThemePreference('auto')
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const html = (): HTMLElement => document.documentElement

  async function render(): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
  }

  async function openSettings(): Promise<HTMLSelectElement> {
    await render()
    const trigger = document.querySelector<HTMLButtonElement>('.settings-trigger')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const select = document.querySelector<HTMLSelectElement>('.settings-panel select.theme-select')
    expect(select).not.toBeNull()
    return select!
  }

  async function choose(select: HTMLSelectElement, value: string): Promise<void> {
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('renders with data-theme applied, auto by default', async () => {
    await render()
    expect(html().getAttribute('data-theme')).toBe('auto')
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
  })

  it('renders a stored dark preference on the document', async () => {
    setThemePreference('dark')
    await render()
    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-resolved-theme')).toBe('dark')
  })

  it('offers automatic, light and dark next to the language setting', async () => {
    const select = await openSettings()
    expect(select.value).toBe('auto')
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Automatic (follow system)',
      'Light',
      'Dark',
    ])
    const selects = [...select.closest('.settings-panel')!.querySelectorAll('select')]
    expect(selects).toHaveLength(2)
    expect(selects[1]).toBe(select)
  })

  it('applies a choice immediately and persists it', async () => {
    const select = await openSettings()
    await choose(select, 'dark')
    expect(set).toHaveBeenCalledWith({ dshPanelTheme: 'dark' })
    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe('dark')
    expect(document.querySelector<HTMLSelectElement>('select.theme-select')!.value).toBe('dark')

    await choose(select, 'light')
    expect(set).toHaveBeenLastCalledWith({ dshPanelTheme: 'light' })
    expect(html().getAttribute('data-theme')).toBe('light')

    await choose(select, 'auto')
    expect(set).toHaveBeenLastCalledWith({ dshPanelTheme: 'auto' })
    expect(html().getAttribute('data-theme')).toBe('auto')
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull()
  })

  it('labels the control in Chinese when the UI language is Chinese', async () => {
    setUiLocalePreference('zh')
    const select = await openSettings()
    expect([...select.options].map((option) => option.textContent)).toEqual(['自动（跟随系统）', '浅色', '深色'])
    expect(document.body.textContent).toContain('外观主题')
  })

  it('follows a preference changed in another open panel', async () => {
    const select = await openSettings()
    await act(async () => {
      for (const listener of [...storageListeners]) listener({ dshPanelTheme: { newValue: 'dark' } }, 'local')
    })
    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(select.value).toBe('dark')
  })

  it('follows the OS scheme while on auto', async () => {
    await render()
    expect(html().getAttribute('data-resolved-theme')).toBe('light')
    await act(async () => {
      systemDark = true
      expect(schemeListeners.size).toBe(1)
      for (const listener of [...schemeListeners]) listener({ matches: true })
    })
    expect(html().getAttribute('data-theme')).toBe('auto')
    expect(html().getAttribute('data-resolved-theme')).toBe('dark')
  })

  it('stops listening when the panel unmounts', async () => {
    await render()
    expect(schemeListeners.size).toBe(1)
    await act(async () => { root.unmount() })
    expect(schemeListeners.size).toBe(0)
    root = createRoot(document.querySelector('#root')!)
  })
})
