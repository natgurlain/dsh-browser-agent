// @vitest-environment jsdom

/**
 * The bridge plugin's row in DSH Web settings ("Pair a browser", client.js).
 * It lives in the bridge package but needs React and a DOM, which this
 * workspace has, so it is exercised here.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CLIENT_SOURCE = readFileSync(resolve(__dirname, '../../../packages/browser/bridge-browser/src/client.js'), 'utf8')

interface Registered {
  options: { id: string; order: number; name: string }
  component: (props: { t: (key: string) => string }) => React.ReactElement
}

/** Load client.js the way the dsh module loader does and collect what it registers. */
function loadClient(): { rows: Registered[]; dictionaries: Record<'en' | 'zh', Record<string, string>> } {
  let factory: ((require: (name: string) => unknown) => { apply: (ctx: unknown) => void }) | undefined
  Object.assign(window, { __ModuleLoader__: { load: (module: { factory: typeof factory }) => { factory = module.factory } } })
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(CLIENT_SOURCE)()
  const rows: Registered[] = []
  let dictionaries: Record<'en' | 'zh', Record<string, string>> | undefined
  factory!((name) => { if (name === 'react') return React; throw new Error(`unexpected require: ${name}`) }).apply({
    effect: (run: () => unknown) => run(),
    locale: { register: (_namespace: string, value: typeof dictionaries) => { dictionaries = value; return () => {} } },
    slots: {
      inject: (_slot: string, run: () => unknown) => run(),
      register: (options: Registered['options'], component: Registered['component']) => { rows.push({ options, component }); return () => {} },
    },
  })
  return { rows, dictionaries: dictionaries! }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('DSH Web settings: Pair a browser', () => {
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>
  let en: Record<string, string>

  async function render(): Promise<void> {
    const { rows, dictionaries } = loadClient()
    en = dictionaries.en
    const row = rows.find(candidate => candidate.options.id === 'bridge-browser-pairing')!
    expect(row.options).toMatchObject({ name: 'settings.general.item' })
    await act(async () => { root.render(React.createElement(row.component, { t: (key: string) => en[key] ?? key })) })
  }
  const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label)!
  const actions = (): unknown[] => fetchMock.mock.calls.map(call => (JSON.parse(String(call[1].body)) as { action: unknown }).action)

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens no pairing window until the user asks, then shows the one-time code', async () => {
    await render()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')).toBeNull()

    fetchMock.mockResolvedValueOnce(json({ ok: true, code: 'ABCD-EFGH', expiresAt: 1, ttlMs: 300_000, status: { state: 'open' } }))
    await act(async () => { button(en['pairing.start']!).click() })
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')?.textContent).toBe('ABCD-EFGH')
    expect(document.body.textContent).toContain('5:00 left')
    expect(document.body.textContent).toContain(en['pairing.onlyInExtension'])
    // The request goes to dsh's authenticated /api channel, relative to the page.
    expect(fetchMock.mock.calls[0]![0]).toBe('api/bridge-browser.pairing')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(actions()).toEqual(['start'])
  })

  it('reports the extension that paired and stops showing the code', async () => {
    vi.useFakeTimers()
    await render()
    fetchMock.mockResolvedValueOnce(json({ ok: true, code: 'ABCD-EFGH', expiresAt: 1, ttlMs: 300_000, status: { state: 'open' } }))
    await act(async () => { button(en['pairing.start']!).click() })
    fetchMock.mockResolvedValue(json({ ok: true, status: { state: 'paired', at: 2, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Paired: abcdefghijklmnopabcdefghijklmnop')
    // Polling ends with the window.
    const calls = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it.each([
    [{ state: 'closed', reason: 'expired' }, 'pairing.expired'],
    [{ state: 'closed', reason: 'attempts' }, 'pairing.attempts'],
    [{ state: 'idle' }, 'pairing.expired'],
  ])('says why a window closed (%j)', async (status, key) => {
    vi.useFakeTimers()
    await render()
    fetchMock.mockResolvedValueOnce(json({ ok: true, code: 'ABCD-EFGH', expiresAt: 1, ttlMs: 300_000, status: { state: 'open' } }))
    await act(async () => { button(en['pairing.start']!).click() })
    fetchMock.mockResolvedValue(json({ ok: true, status }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(en[key])
  })

  it('cancels the window on request', async () => {
    await render()
    fetchMock.mockResolvedValueOnce(json({ ok: true, code: 'ABCD-EFGH', expiresAt: 1, ttlMs: 300_000, status: { state: 'open' } }))
    await act(async () => { button(en['pairing.start']!).click() })
    fetchMock.mockResolvedValueOnce(json({ ok: true, status: { state: 'closed', reason: 'cancelled' } }))
    await act(async () => { button(en['pairing.cancel']!).click() })
    expect(actions()).toEqual(['start', 'cancel'])
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe(en['pairing.cancelled'])
  })

  it('shows no code when dsh refuses the request or pairing is cooling down', async () => {
    await render()
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
    await act(async () => { button(en['pairing.start']!).click() })
    expect(document.querySelector('[role="status"]')?.textContent).toBe(en['pairing.unavailable'])

    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'cooldown', retryAt: Date.now() + 20_000, status: { state: 'closed', reason: 'attempts' } }, 429))
    await act(async () => { button(en['pairing.restart']!).click() })
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/^Too many wrong codes were tried\. Try again in (?:19|20) s\.$/u)

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { button(en['pairing.restart']!).click() })
    expect(document.querySelector('[role="status"]')?.textContent).toBe(en['pairing.unavailable'])
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')).toBeNull()
  })

  it('has every string in English and Chinese', () => {
    const { dictionaries } = loadClient()
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
    for (const value of [...Object.values(dictionaries.en), ...Object.values(dictionaries.zh)]) expect(value.trim()).not.toBe('')
    expect(Object.keys(dictionaries.en).filter(key => key.startsWith('pairing.')).length).toBeGreaterThanOrEqual(12)
  })
})
