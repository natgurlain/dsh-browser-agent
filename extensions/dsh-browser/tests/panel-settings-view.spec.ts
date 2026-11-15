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
import { PANEL_COPY } from '../src/panel/strings.ts'

const copy = PANEL_COPY.en

/** The Settings view: sections, the row pattern, and the unsaved-changes bar. */
describe('panel settings view', () => {
  let root: Root
  let updateSettings: ReturnType<typeof vi.fn>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    localStorage.clear()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({
            dshSettings: { autoResumeSession: false, siteRules: [{ pattern: 'docs.example.com', rule: 'ask' }] },
          })),
          set: vi.fn(async () => {}),
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
      tabs: { query: vi.fn(async () => []) },
      runtime: {
        getManifest: () => ({ version: '0.1.8' }),
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
    })
    updateSettings = vi.fn(async () => {})
    panelApi = { ...fakePanelApi(), updateSettings } as PanelApi
    setUiLocalePreference('en')
    vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    setUiLocalePreference('auto')
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function openSettings(): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { document.querySelector<HTMLButtonElement>('.settings-trigger')!.click() })
  }

  const section = (id: string): HTMLDetailsElement => document.querySelector<HTMLDetailsElement>(`details[data-section="${id}"]`)!
  const saveBar = (): HTMLElement | null => document.querySelector('.settings-savebar')
  const button = (scope: ParentNode, text: string): HTMLButtonElement => (
    [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent === text)!)
  const toggle = (title: string): HTMLInputElement => (
    [...document.querySelectorAll<HTMLLabelElement>('label.setting-toggle')]
      .find((label) => label.querySelector('strong')?.textContent === title)!
      .querySelector<HTMLInputElement>('input[type=checkbox]')!)
  async function type(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('groups every setting into named sections, advanced ones collapsed by default', async () => {
    await openSettings()
    const sections = [...document.querySelectorAll<HTMLDetailsElement>('details.settings-section')]
    expect(sections.map((entry) => entry.dataset.section)).toEqual([
      'connection', 'appearance', 'permissions', 'behaviour', 'automation', 'models', 'about',
    ])
    expect(sections.map((entry) => entry.querySelector('h2')?.textContent)).toEqual(
      Object.values(copy.settings.sections).map((entry) => entry.title),
    )
    expect(sections.filter((entry) => !entry.open).map((entry) => entry.dataset.section)).toEqual(['automation', 'models'])
    // The title and its description are separate lines, never run together.
    for (const entry of sections) {
      expect(entry.querySelector('summary h2')).not.toBeNull()
      expect(entry.querySelector('summary .settings-section-help')?.textContent).not.toBe('')
    }
  })

  it('remembers which sections are open', async () => {
    await openSettings()
    await act(async () => {
      section('automation').open = true
      section('automation').dispatchEvent(new Event('toggle'))
      section('about').open = false
      section('about').dispatchEvent(new Event('toggle'))
    })
    await act(async () => { root.unmount() })
    root = createRoot(document.querySelector('#root')!)
    await openSettings()
    expect(section('automation').open).toBe(true)
    expect(section('about').open).toBe(false)
    expect(section('connection').open).toBe(true)
  })

  it('gives every control an accessible name and every button a variant', async () => {
    await openSettings()
    const settings = document.querySelector('.settings')!
    for (const control of settings.querySelectorAll<HTMLElement>('input, select, textarea')) {
      const named = control.getAttribute('aria-label') !== null
        || (control.id !== '' && settings.querySelector(`label[for="${CSS.escape(control.id)}"]`) !== null)
        || control.closest('label') !== null
      expect(`${control.outerHTML.slice(0, 80)}:${String(named)}`).toMatch(/:true$/u)
    }
    for (const candidate of settings.querySelectorAll('button')) {
      const styled = ['primary', 'secondary', 'danger', 'icon-button', 'device-row', 'entry-remove']
        .some((name) => candidate.classList.contains(name))
      expect(`${candidate.textContent}:${String(styled)}`).toMatch(/:true$/u)
      expect((candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim()).not.toBe('')
    }
    // Switches are real checkboxes with the switch role, inside their label.
    for (const input of settings.querySelectorAll('input[type=checkbox]')) {
      expect(input.getAttribute('role')).toBe('switch')
      expect(input.closest('label.setting-toggle')).not.toBeNull()
    }
  })

  it('keeps the long safety explanations reachable behind "Learn more"', async () => {
    await openSettings()
    const disclosed = [...document.querySelectorAll('details.learn-more')]
    expect(disclosed.length).toBeGreaterThan(8)
    expect(disclosed.every((entry) => entry.querySelector('summary')?.textContent === copy.settings.learnMore)).toBe(true)
    const text = disclosed.map((entry) => entry.textContent).join('\n')
    for (const statement of [
      copy.settings.unrestrictedBrowserAccessMore,
      copy.settings.allowDevToolsMore,
      copy.sitePolicy.more,
      copy.devLoop.cautionMore,
      copy.learning.fixturesMore,
    ]) expect(text).toContain(statement)
    // The short lines carry the essentials on their own.
    expect(copy.settings.allowDevToolsHelp).toContain('8 hours')
    // No debugger API here (as in Firefox): strict mode says so instead of explaining itself.
    expect(document.querySelector('.strict-mode')?.textContent).toContain(copy.sitePolicy.strictUnavailable)
    expect(copy.sitePolicy.strictMore).toContain('WebSocket messages and sendBeacon cannot be intercepted')
    // Opening a disclosure must not flip the switch it explains.
    expect(document.querySelector('label.setting-toggle details')).toBeNull()
  })

  it('shows the save bar only while there are unsaved changes, and Discard reverts them', async () => {
    await openSettings()
    expect(saveBar()).toBeNull()
    // Language and theme apply at once and never raise the bar.
    await act(async () => {
      const theme = document.querySelector<HTMLSelectElement>('select.theme-select')!
      theme.value = 'dark'
      theme.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(saveBar()).toBeNull()

    await act(async () => { toggle(copy.settings.unrestrictedBrowserAccess).click() })
    expect(saveBar()?.textContent).toContain(copy.settings.unsavedChanges)
    expect(toggle(copy.settings.unrestrictedBrowserAccess).checked).toBe(true)

    await act(async () => { button(saveBar()!, copy.settings.discard).click() })
    expect(saveBar()).toBeNull()
    expect(toggle(copy.settings.unrestrictedBrowserAccess).checked).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('saves the whole form from the bar and leaves no pending changes behind', async () => {
    await openSettings()
    await act(async () => { toggle(copy.settings.allowPageWatchers).click() })
    await act(async () => { button(saveBar()!, copy.settings.save).click() })
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings.mock.calls[0]![0]).toMatchObject({ allowPageWatchers: true, autoResumeSession: false })
    // Saving returns to the chat; reopening shows a clean form.
    expect(document.querySelector('.settings')).toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('.settings-trigger')!.click() })
    expect(saveBar()).toBeNull()
    expect(toggle(copy.settings.allowPageWatchers).checked).toBe(true)
  })

  it('validates a site rule inline, then lists it as a removable entry', async () => {
    await openSettings()
    const policy = document.querySelector('.site-policy')!
    const input = policy.querySelector<HTMLInputElement>(`input[aria-label="${copy.sitePolicy.patternLabel}"]`)!
    expect(input.placeholder).toBe(copy.sitePolicy.patternPlaceholder)
    const add = input.parentElement!.querySelector<HTMLButtonElement>('button')!
    expect(add.disabled).toBe(true)

    await type(input, 'not a site!')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(policy.querySelector('[role=alert]')?.textContent).toBe(copy.sitePolicy.invalidPattern)
    expect(add.disabled).toBe(true)
    expect(saveBar()).toBeNull()

    await type(input, 'Shop.Example.com')
    expect(policy.querySelector('[role=alert]')).toBeNull()
    await act(async () => { add.click() })
    const entries = (): string[] => [...policy.querySelector('.entry-list')!.querySelectorAll('.entry')].map((entry) => entry.textContent ?? '')
    expect(entries()).toEqual([`docs.example.com${copy.sitePolicy.rules.ask}`, `shop.example.com${copy.sitePolicy.rules['read-only']}`])
    expect(saveBar()).not.toBeNull()

    await act(async () => {
      policy.querySelector<HTMLButtonElement>(`button[aria-label="${copy.sitePolicy.removeItem('shop.example.com')}"]`)!.click()
    })
    expect(entries()).toHaveLength(1)
    expect(saveBar()).toBeNull()
  })
})
