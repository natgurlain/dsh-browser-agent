// @vitest-environment jsdom

/**
 * The bridge plugin's pairing prompt in the DSH app (client.js): the overlay
 * card and the General-settings row. It lives in the bridge package but needs
 * React and a DOM, which this workspace has, so it is exercised here.
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
const brave = { id: 'p1', code: '4F7-K2Q', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', name: 'Brave', expiresInMs: 100_000 }
const stranger = { id: 'p2', code: 'ZZZ-ZZZ', origin: '', name: 'Chrome', expiresInMs: 90_000 }

describe('DSH app: the pairing prompt', () => {
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>
  let en: Record<string, string>
  /** What the host currently reports; the fake route serves it to every poll. */
  let host: { requests: unknown[]; paired?: { origin: string; name: string; at: number } }

  async function render(id: string): Promise<void> {
    const { slots, dictionaries } = loadClient()
    en = dictionaries.en
    const slot = slots.find(candidate => candidate.options.id === id)!
    await act(async () => { root.render(React.createElement(slot.component, { t: (key: string) => en[key] ?? key })) })
  }
  const tick = async (ms = 2_500): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  const button = (label: string): HTMLButtonElement =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label)!
  const sent = (): unknown[] => fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)))

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    host = { requests: [] }
    fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { action: string; id?: string }
      if (body.action === 'list') return json({ ok: true, ...host })
      const found = host.requests.find(request => (request as { id: string }).id === body.id) as typeof brave | undefined
      if (found === undefined) return json({ ok: false, error: 'gone', requests: host.requests }, 409)
      host.requests = host.requests.filter(request => request !== found)
      if (body.action === 'approve') host.paired = { origin: found.origin, name: found.name, at: Date.now() }
      return json({ ok: true, ...host })
    })
    vi.stubGlobal('fetch', fetchMock)
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('registers the prompt over the app and a row in General settings', () => {
    const { slots } = loadClient()
    expect(slots.map(slot => `${slot.options.name}:${slot.options.id}`)).toEqual([
      'settings.general.item:bridge-browser-address',
      'settings.general.item:bridge-browser-pairing',
      'shell.overlay:bridge-browser-pairing-prompt',
    ])
  })

  it('shows nothing until a browser asks, then one prompt with the code and Approve / Deny', async () => {
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
    // Requests go to dsh's authenticated /api channel, relative to the page.
    expect(fetchMock.mock.calls[0]![0]).toBe('api/bridge-browser.pairing')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })

    host.requests = [brave]
    await tick()
    const prompt = document.querySelector('[data-testid="dsh-pairing-prompt"]')!
    expect(prompt.textContent).toContain('Brave wants to connect')
    expect(prompt.querySelector('[data-testid="dsh-pairing-code"]')?.textContent).toBe('4F7-K2Q')
    expect(prompt.textContent).toContain(en['pairing.compare'])
    expect(prompt.textContent).toContain(brave.origin)
    expect([...prompt.querySelectorAll('button')].map(candidate => candidate.textContent)).toEqual(['Approve', 'Deny'])

    // One click approves exactly that request.
    await act(async () => { button('Approve').click() })
    expect(sent().at(-1)).toEqual({ action: 'approve', id: 'p1' })
    expect(document.querySelector('[data-testid="dsh-pairing-request"]')).toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Paired with Brave.')
    // The confirmation leaves by itself, and the prompt with it.
    await tick(8_000)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
  })

  it('denies with one click and approves nothing', async () => {
    host.requests = [brave]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    await act(async () => { button('Deny').click() })
    expect(sent().at(-1)).toEqual({ action: 'deny', id: 'p1' })
    expect(sent().some(body => (body as { action: string }).action === 'approve')).toBe(false)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
  })

  it('lists several requests separately and warns to pick by code', async () => {
    host.requests = [brave, stranger]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    expect(document.querySelectorAll('[data-testid="dsh-pairing-request"]')).toHaveLength(2)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en['pairing.several'])
    // Approving the first leaves the stranger waiting, unapproved.
    await act(async () => { document.querySelectorAll<HTMLButtonElement>('.dshBridgePairApprove')[0]!.click() })
    expect(sent().at(-1)).toEqual({ action: 'approve', id: 'p1' })
    expect([...document.querySelectorAll('[data-testid="dsh-pairing-code"]')].map(node => node.textContent)).toEqual(['ZZZ-ZZZ'])
    expect(host.requests).toEqual([stranger])
  })

  it('says so when the request it answered was already gone', async () => {
    host.requests = [brave]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    host.requests = []
    await act(async () => { button('Approve').click() })
    expect(document.querySelector('[role="status"]')?.textContent).toBe(en['pairing.gone'])
  })

  it('renders a browser name as text, whatever it contains', async () => {
    host.requests = [{ ...brave, name: '<img src=x onerror=alert(1)>' }]
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"] img')).toBeNull()
    expect(document.querySelector('.dshBridgePairWho')?.textContent).toContain('<img src=x')
  })

  it('stays quiet and looks again later when dsh refuses the request', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    await render('bridge-browser-pairing-prompt')
    await tick(0)
    await tick(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await tick(20_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')).toBeNull()
  })

  it('shows the same requests in the General-settings row, with where to start when none waits', async () => {
    await render('bridge-browser-pairing')
    await tick(0)
    expect(document.body.textContent).toContain(en['pairing.idle'])
    host.requests = [brave]
    await tick()
    expect(document.body.textContent).not.toContain(en['pairing.idle'])
    expect(document.querySelector('[data-testid="dsh-pairing-code"]')?.textContent).toBe('4F7-K2Q')
    await act(async () => { button('Approve').click() })
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Paired with Brave.')
  })

  it('works without a translator and has every string in English and Chinese', async () => {
    const { slots, dictionaries } = loadClient()
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
    for (const value of [...Object.values(dictionaries.en), ...Object.values(dictionaries.zh)]) expect(value.trim()).not.toBe('')
    expect(Object.keys(dictionaries.en).filter(key => key.startsWith('pairing.')).length).toBeGreaterThanOrEqual(10)
    host.requests = [brave]
    const prompt = slots.find(slot => slot.options.id === 'bridge-browser-pairing-prompt')!
    await act(async () => { root.render(React.createElement(prompt.component, {})) })
    await tick(0)
    expect(document.querySelector('[data-testid="dsh-pairing-prompt"]')?.textContent).toContain('Brave wants to connect')
  })
})
