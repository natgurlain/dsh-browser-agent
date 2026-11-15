// @vitest-environment jsdom

/**
 * The bridge plugin's pairing UI in the DSH app (client.js): the card over
 * the app and the General-settings row. It lives in the bridge package but
 * needs React and a DOM, which this workspace has, so it is exercised here.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CLIENT_SOURCE = readFileSync(resolve(__dirname, '../../../packages/browser/bridge-browser/src/client.js'), 'utf8')

interface Registered {
  options: { id: string; name: string; order?: number }
  component: (props: { t?: (key: string) => string }) => React.ReactElement | null
}

/** Load client.js the way the dsh module loader does and collect what it registers. */
function loadClient(): { slots: Registered[]; dictionaries: Record<'en' | 'zh', Record<string, string>> } {
  let factory: ((require: (name: string) => unknown) => { apply: (ctx: unknown) => void }) | undefined
  Object.assign(window, { __ModuleLoader__: { load: (module: { factory: typeof factory }) => { factory = module.factory } } })
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(CLIENT_SOURCE)()
  const slots: Registered[] = []
  let dictionaries: Record<'en' | 'zh', Record<string, string>> | undefined
  factory!((name) => { if (name === 'react') return React; throw new Error(`unexpected require: ${name}`) }).apply({
    effect: (run: () => unknown) => run(),
    locale: { register: (_namespace: string, value: typeof dictionaries) => { dictionaries = value; return () => {} } },
    slots: {
      inject: (_slot: string, run: () => unknown) => run(),
      register: (options: Registered['options'], component: Registered['component']) => { slots.push({ options, component }); return () => {} },
    },
  })
  return { slots, dictionaries: dictionaries! }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const STORE_ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('DSH app: pairing a browser', () => {
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>
  let en: Record<string, string>
  /** The host's desk; the fake route serves it and applies the actions. The code a waiting browser holds is `holds`. */
  let host: { paused: boolean; pauseReason?: string; waiting: number; hints: string[]; failures: number; pairedIds: string[]; holds: string }

  async function render(id: string): Promise<void> {
    const { slots, dictionaries } = loadClient()
    en = dictionaries.en
    const slot = slots.find(candidate => candidate.options.id === id)!
    await act(async () => { root.render(React.createElement(slot.component, { t: (key: string) => en[key] ?? key })) })
  }
  const tick = async (ms = 2_500): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label)!
  const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-testid="dsh-pairing-input"]')!
  const status = (): string => document.querySelector('[data-testid="dsh-pairing-status"]')?.textContent ?? ''
  const sent = (): Array<{ action: string; code?: string; id?: string }> => fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)))
  async function type(value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const submit = async (): Promise<void> => {
    await act(async () => { input().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    host = { paused: false, waiting: 0, hints: [], failures: 0, pairedIds: [], holds: 'ABCDEF' }
    fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string; code?: string; id?: string }
      const view = (): object => { const { holds: _holds, ...rest } = host; return rest }
      if (body.action === 'status') return json({ ok: true, ...view() })
      if (body.action === 'pause') { host.paused = true; host.pauseReason = 'user'; host.waiting = 0; return json({ ok: true, ...view() }) }
      if (body.action === 'resume') { host.paused = false; delete host.pauseReason; return json({ ok: true, ...view() }) }
      if (body.action === 'unpair') { host.pairedIds = host.pairedIds.filter(id => id !== body.id); return json({ ok: true, ...view() }) }
      const typed = String(body.code).replace(/[\s-]/gu, '').toUpperCase()
      let result = 'paired'
      if (!/^[A-HJ-NP-Z2-9]{6}$/u.test(typed)) result = 'invalid'
      else if (host.waiting === 0) result = 'none-waiting'
      else {
        if (typed !== host.holds) result = 'no-match'
        else host.pairedIds = [...host.pairedIds, STORE_ID]
        host.waiting = 0
        host.hints = []
      }
      return json({ ok: true, result, ...view() })
    })
    vi.stubGlobal('fetch', fetchMock)
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('registers the card over the app and a row in General settings', () => {
    const { slots } = loadClient()
    expect(slots.map(slot => `${slot.options.name}:${slot.options.id}`)).toEqual([
      'settings.general.item:bridge-browser-address',
      'settings.general.item:bridge-browser-pairing',
      'shell.overlay:bridge-browser-pairing-prompt',
    ])
  })

  it('shows nothing until a browser waits, then one input for the code the browser shows', async () => {
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
    // Requests go to dsh's authenticated /api channel, relative to the page, as JSON.
    expect(fetchMock.mock.calls[0]![0]).toBe('api/bridge-browser.pairing')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })

    host.waiting = 1
    host.hints = ['Brave']
    await tick()
    const prompt = document.querySelector('[data-testid="dsh-pairing-prompt"]')!
    expect(prompt.textContent).toContain('A browser wants to connect')
    expect(prompt.textContent).toContain('Enter the code it shows. It says it is Brave.')
    expect(prompt.textContent).toContain(en['pairing.only'])
    // There is nothing to approve by a click, and no code on this page: one input, one submit.
    expect([...prompt.querySelectorAll('button')].map(candidate => candidate.textContent)).toEqual(['Connect'])
    expect(prompt.querySelectorAll('input')).toHaveLength(1)
    expect(prompt.querySelector('code, output')).toBeNull()
    expect(button('Connect').disabled).toBe(true)

    await type('abc-def')
    await submit()
    expect(sent().at(-1)).toEqual({ action: 'enter', code: 'abc-def' })
    expect(status()).toBe(en['pairing.result.paired'])
    expect(input().value).toBe('')
    // The confirmation leaves by itself, and the card with it.
    await tick(10_000)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
  })

  it('says a wrong code found nobody, clears it, and keeps the layout where it was', async () => {
    host.waiting = 1
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    const before = [...document.querySelector('[data-testid="dsh-pairing-prompt"]')!.children].map(child => child.tagName)
    await type('ZZZ-ZZZ')
    await submit()
    expect(status()).toBe(en['pairing.result.no-match'])
    expect(input().value).toBe('')
    expect(host.pairedIds).toEqual([])
    // Same elements in the same order: the message fills a line that was already there.
    expect([...document.querySelector('[data-testid="dsh-pairing-prompt"]')!.children].map(child => child.tagName)).toEqual(before)

    // Input that cannot be a code stays for correction.
    host.waiting = 1
    await tick()
    await type('12')
    await submit()
    expect(status()).toBe(en['pairing.result.invalid'])
    expect(input().value).toBe('12')
  })

  it('renders hints only from plain names and shows none when requesters disagree', async () => {
    host.waiting = 1
    host.hints = ['<img src=x onerror=alert(1)>']
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    const prompt = document.querySelector('[data-testid="dsh-pairing-prompt"]')!
    expect(prompt.querySelector('img')).toBeNull()
    expect(prompt.textContent).not.toContain('says it is')
    host.waiting = 2
    host.hints = ['Brave', 'Chrome']
    await tick()
    expect(prompt.textContent).not.toContain('says it is')
  })

  it('stays quiet and looks again later when dsh refuses the request, and stops for good without a pairing route', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    await tick(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await tick(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()

    // `pairing: false` on the host: no route, so no polling at all.
    await act(async () => { root.unmount() })
    root = createRoot(document.querySelector('#root')!)
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }))
    await render('bridge-browser-pairing')
    await tick(0)
    await tick(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.dshBridgePairRow')).toBeNull()
  })

  it('offers the same input in the General-settings row, with pause, resume and unpair', async () => {
    host.pairedIds = [STORE_ID]
    await render('bridge-browser-pairing')
    await tick(0)
    const summary = (): string => document.querySelector('[data-testid="dsh-pairing-summary"]')?.textContent ?? ''
    expect(summary()).toBe(en['pairing.idle'])
    await type('ABC-DEF')
    await submit()
    expect(status()).toBe(en['pairing.result.none-waiting'])

    host.waiting = 2
    await tick()
    expect(summary()).toBe('Browsers waiting for a code: 2. Enter the code your browser shows.')

    await act(async () => { button(en['pairing.pause']!).click() })
    expect(sent().at(-1)).toEqual({ action: 'pause' })
    expect(summary()).toBe(en['pairing.paused.user'])
    // Paused: no input to type a code into.
    expect(document.querySelector('[data-testid="dsh-pairing-input"]')).toBeNull()
    host.pauseReason = 'failures'
    await tick()
    expect(summary()).toBe(en['pairing.paused.failures'])
    await act(async () => { button(en['pairing.resume']!).click() })
    expect(sent().at(-1)).toEqual({ action: 'resume' })
    expect(input()).not.toBeNull()

    // Paired extensions, and what unpairing does and does not do.
    expect(document.body.textContent).toContain(STORE_ID)
    expect(document.body.textContent).toContain(en['pairing.unpairNote'])
    await act(async () => { button(en['pairing.unpair']!).click() })
    expect(sent().at(-1)).toEqual({ action: 'unpair', id: STORE_ID })
    expect(document.body.textContent).not.toContain(STORE_ID)
  })

  it('works without a translator and has every string in English and Chinese', async () => {
    const { slots, dictionaries } = loadClient()
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
    expect(Object.keys(dictionaries)).toEqual(['en', 'zh'])
    for (const value of [...Object.values(dictionaries.en), ...Object.values(dictionaries.zh)]) expect(value.trim()).not.toBe('')
    for (const result of ['paired', 'unconfirmed', 'no-match', 'none-waiting', 'invalid', 'paused', 'busy', 'failed']) {
      expect(dictionaries.en[`pairing.result.${result}`]).toBeTruthy()
    }
    host.waiting = 1
    const prompt = slots.find(slot => slot.options.id === 'bridge-browser-pairing-prompt')!
    await act(async () => { root.render(React.createElement(prompt.component, {})) })
    await tick(0)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')?.textContent).toContain('A browser wants to connect')
  })
})
