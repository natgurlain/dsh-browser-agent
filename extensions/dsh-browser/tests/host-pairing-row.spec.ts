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
const STORE_ORIGIN = `chrome-extension://${STORE_ID}`
const OFFICIAL_ORIGIN = 'chrome-extension://klmdgljhcjbbpjcplbanjeclilghnaoh'
const FIREFOX_ORIGIN = 'moz-extension://0f8fad5b-d9cb-469f-a165-70867728950e'
type Requester = { origin: string; name: string; official: boolean }
const official: Requester = { origin: OFFICIAL_ORIGIN, name: 'Brave', official: true }
const unknown: Requester = { origin: STORE_ORIGIN, name: 'Chrome', official: false }

describe('DSH app: pairing a browser', () => {
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>
  let en: Record<string, string>
  /** The host's desk; the fake route serves it and applies the actions. The code a waiting browser holds is `holds`. */
  let host: {
    paused: boolean; pauseReason?: string; requests: Requester[]; failures: number; pairedOrigins: string[]; canResetToken: boolean
    paired?: { origin: string; name: string; at: number }; holds: string; resets: number
  }

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
    host = { paused: false, requests: [], failures: 0, pairedOrigins: [], canResetToken: true, holds: 'ABCDEF', resets: 0 }
    fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string; code?: string; origin?: string }
      const view = (): object => { const { holds: _holds, resets: _resets, ...rest } = host; return { ...rest, waiting: host.requests.length } }
      if (body.action === 'status') return json({ ok: true, ...view() })
      if (body.action === 'pause') { host.paused = true; host.pauseReason = 'user'; host.requests = []; return json({ ok: true, ...view() }) }
      if (body.action === 'resume') { host.paused = false; delete host.pauseReason; return json({ ok: true, ...view() }) }
      if (body.action === 'unpair') { host.pairedOrigins = host.pairedOrigins.filter(origin => origin !== body.origin); return json({ ok: true, ...view() }) }
      if (body.action === 'reset-token') { host.resets += 1; return json({ ok: true, ...view() }) }
      const typed = String(body.code).replace(/[\s-]/gu, '').toUpperCase()
      let result = 'paired'
      if (!/^[A-HJ-NP-Z2-9]{6}$/u.test(typed)) result = 'invalid'
      else if (host.requests.length === 0) result = 'none-waiting'
      else {
        if (typed !== host.holds) result = 'no-match'
        else {
          const winner = host.requests[0]!
          host.pairedOrigins = [...host.pairedOrigins, winner.origin]
          host.paired = { origin: winner.origin, name: winner.name, at: Date.now() }
        }
        host.requests = []
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

    host.requests = [official]
    await tick()
    const prompt = document.querySelector('[data-testid="dsh-pairing-prompt"]')!
    expect(prompt.textContent).toContain('A browser wants to connect')
    // Who is asking: the published extension, by the ID the browser reported.
    const requester = prompt.querySelector('[data-testid="dsh-pairing-requester"]')!
    expect(requester.textContent).toBe('dsh-browser-agent (official) (says it is Brave)')
    expect(requester.className).toBe('dshBridgePairWho')
    expect(prompt.textContent).not.toContain(en['pairing.unknownWarning'])
    expect(prompt.textContent).toContain(en['pairing.only'])
    // There is nothing to approve by a click, and no code on this page: one input, one submit.
    expect([...prompt.querySelectorAll('button')].map(candidate => candidate.textContent)).toEqual(['Connect'])
    expect(prompt.querySelectorAll('input')).toHaveLength(1)
    expect(prompt.querySelector('code, output')).toBeNull()
    expect(button('Connect').disabled).toBe(true)

    await type('abc-def')
    await submit()
    expect(sent().at(-1)).toEqual({ action: 'enter', code: 'abc-def' })
    // The notice names who was paired, and offers to undo it.
    expect(status()).toContain('Paired with klmdgljhcjbbpjcplbanjeclilghnaoh.')
    expect(input().value).toBe('')
    expect(host.pairedOrigins).toEqual([OFFICIAL_ORIGIN])
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="dsh-pairing-undo"]')!.click() })
    expect(sent().at(-1)).toEqual({ action: 'unpair', origin: OFFICIAL_ORIGIN })
    expect(host.pairedOrigins).toEqual([])
    // With nothing waiting and no notice the card leaves.
    await tick()
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
  })

  it('regression (review 2, M2): labels an extension that is not the published one as unknown, in warning style', async () => {
    host.requests = [unknown, { origin: FIREFOX_ORIGIN, name: 'Firefox', official: false }]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    const requesters = [...document.querySelectorAll('[data-testid="dsh-pairing-requester"]')]
    expect(requesters.map(node => node.textContent)).toEqual([
      `Unknown extension ${STORE_ID} — not the published DSH extension (says it is Chrome)`,
      'Unknown extension 0f8fad5b-d9cb-469f-a165-70867728950e — not the published DSH extension (says it is Firefox)',
    ])
    for (const node of requesters) expect(node.className).toBe('dshBridgePairWarn')
    expect(document.body.textContent).toContain(en['pairing.unknownWarning'])
    // Pairing it anyway is possible, and the notice says exactly which extension got in.
    await type('ABC-DEF')
    await submit()
    expect(status()).toContain(`Paired with ${STORE_ID}.`)
    expect(document.querySelector('[data-testid="dsh-pairing-undo"]')).not.toBeNull()
  })

  it('says a wrong code found nobody, clears it, and keeps the layout where it was', async () => {
    host.requests = [official]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    const before = [...document.querySelector('[data-testid="dsh-pairing-prompt"]')!.children].map(child => child.tagName)
    await type('ZZZ-ZZZ')
    await submit()
    expect(status()).toBe(en['pairing.result.no-match'])
    expect(input().value).toBe('')
    expect(host.pairedOrigins).toEqual([])
    expect(en['pairing.result.no-match']).toMatch(/choose Ask again/u)
    // Same elements in the same order: the message fills a line that was already there.
    expect([...document.querySelector('[data-testid="dsh-pairing-prompt"]')!.children].map(child => child.tagName)).toEqual(before)

    // Input that cannot be a code stays for correction.
    host.requests = [official]
    await tick()
    await type('12')
    await submit()
    expect(status()).toBe(en['pairing.result.invalid'])
    expect(input().value).toBe('12')
  })

  it('shows only well-formed origins and plain names, whatever the host answer contains', async () => {
    host.requests = [
      { origin: '<img src=x onerror=alert(1)>', name: 'Brave', official: true },
      { origin: STORE_ORIGIN, name: '<b>Chrome</b>', official: false },
    ]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    const prompt = document.querySelector('[data-testid="dsh-pairing-prompt"]')!
    expect(prompt.querySelector('img, b')).toBeNull()
    expect([...prompt.querySelectorAll('[data-testid="dsh-pairing-requester"]')].map(node => node.textContent)).toEqual([
      `Unknown extension ${STORE_ID} — not the published DSH extension`,
    ])
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
    host.pairedOrigins = [STORE_ORIGIN, FIREFOX_ORIGIN]
    await render('bridge-browser-pairing')
    await tick(0)
    const summary = (): string => document.querySelector('[data-testid="dsh-pairing-summary"]')?.textContent ?? ''
    expect(summary()).toBe(en['pairing.idle'])
    await type('ABC-DEF')
    await submit()
    expect(status()).toBe(en['pairing.result.none-waiting'])

    host.requests = [official, unknown]
    await tick()
    expect(summary()).toBe('Browsers waiting for a code: 2. Enter the code your browser shows.')
    expect(document.querySelectorAll('[data-testid="dsh-pairing-requester"]')).toHaveLength(2)

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

    // Paired extensions (Chrome and Firefox), and what unpairing does and does not do.
    expect(document.body.textContent).toContain(STORE_ORIGIN)
    expect(document.body.textContent).toContain(FIREFOX_ORIGIN)
    expect(document.body.textContent).toContain(en['pairing.unpairNote'])
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.dshBridgePairPaired button')][1]!.click() })
    expect(sent().at(-1)).toEqual({ action: 'unpair', origin: FIREFOX_ORIGIN })
    expect(document.body.textContent).not.toContain(FIREFOX_ORIGIN)
  })

  it('resets the bridge token only after a second, explicit click, and not at all when it is pinned', async () => {
    await render('bridge-browser-pairing')
    await tick(0)
    await act(async () => { button(en['pairing.reset']!).click() })
    expect(host.resets).toBe(0)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en['pairing.resetWarning'])
    await act(async () => { button(en['pairing.resetCancel']!).click() })
    expect(host.resets).toBe(0)
    await act(async () => { button(en['pairing.reset']!).click() })
    await act(async () => { button(en['pairing.resetConfirm']!).click() })
    expect(sent().at(-1)).toEqual({ action: 'reset-token' })
    expect(host.resets).toBe(1)
    expect(status()).toBe(en['pairing.resetDone'])

    host.canResetToken = false
    await tick()
    expect(button(en['pairing.reset']!)).toBeUndefined()
    expect(document.body.textContent).toContain(en['pairing.resetPinned'])
  })

  it('works without a translator and has every string in English and Chinese', async () => {
    const { slots, dictionaries } = loadClient()
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
    expect(Object.keys(dictionaries)).toEqual(['en', 'zh'])
    for (const value of [...Object.values(dictionaries.en), ...Object.values(dictionaries.zh)]) expect(value.trim()).not.toBe('')
    for (const result of ['paired', 'unconfirmed', 'no-match', 'none-waiting', 'invalid', 'paused', 'busy', 'failed']) {
      expect(dictionaries.en[`pairing.result.${result}`]).toBeTruthy()
    }
    host.requests = [official]
    const prompt = slots.find(slot => slot.options.id === 'bridge-browser-pairing-prompt')!
    await act(async () => { root.render(React.createElement(prompt.component, {})) })
    await tick(0)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')?.textContent).toContain('A browser wants to connect')
  })
})
