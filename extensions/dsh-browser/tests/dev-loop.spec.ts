// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DEVLOOP_LINK_METHOD, BRIDGE_DEVLOOP_LIST_METHOD, BRIDGE_DEVLOOP_UNLINK_METHOD } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  createDevLoopPanelRpc,
  DevLoopController,
  devLoopCollector,
  devLoopDrain,
  renderDevLoopCapture,
  type DevLoopBrowser,
  type DevLoopCollected,
} from '../src/background/dev-loop.ts'
import type { ToolAnswer } from '../src/background/tools.ts'

function fakeBrowser(tabs: Record<number, { id: number; url: string; title?: string }>, collected: DevLoopCollected | null = null, frames: Record<number, string[]> = {}) {
  let stored: unknown
  const ran: string[] = []
  const browser: DevLoopBrowser = {
    getTab: async (tabId) => tabs[tabId],
    runInPage: async (_tabId, func) => {
      ran.push(func.name)
      return (func.name === 'devLoopDrain' ? collected : undefined) as never
    },
    load: async () => stored,
    save: async (value) => { stored = value },
    frameUrls: async (tabId) => frames[tabId] ?? [tabs[tabId]?.url ?? ''],
  }
  return { browser, ran, stored: () => stored }
}

const wrap = (text: string): string => text
const okDelta = async (): Promise<ToolAnswer> => ({ ok: true, result: { text: '+ [3] button "Retry"' } })

describe('DevLoopController', () => {
  it('refuses a capture for a session the user did not link in this browser', async () => {
    const { browser } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/' } })
    const controller = new DevLoopController(browser)
    const readDelta = vi.fn(okDelta)
    const answer = await controller.capture({ sessionId: 'coding', args: {} }, readDelta, wrap)
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toMatch(/not linked/u)
    expect(readDelta).not.toHaveBeenCalled()
  })

  it('installs the collector on link, persists the link, and reinstalls it on same-origin navigations only', async () => {
    const { browser, ran, stored } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/' } })
    const controller = new DevLoopController(browser)
    await controller.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    expect(ran).toEqual(['devLoopCollector'])
    expect(stored()).toEqual([{ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' }])
    await controller.onCommitted(1, 'http://localhost:3000/next')
    await controller.onCommitted(1, 'https://evil.example/')
    await controller.onCommitted(2, 'http://localhost:3000/')
    expect(ran).toEqual(['devLoopCollector', 'devLoopCollector'])
    // A restarted worker reloads the links.
    const reloaded = new DevLoopController({ ...browser, load: async () => stored() })
    expect(await reloaded.list()).toHaveLength(1)
  })

  it('the kill switch clears every link', async () => {
    const { browser, stored } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/' } })
    const controller = new DevLoopController(browser)
    await controller.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    expect(await controller.clear()).toBe(1)
    expect(await controller.list()).toEqual([])
    expect(stored()).toEqual([])
  })

  it('reads only while the linked tab is still on its origin', async () => {
    const tabs = { 1: { id: 1, url: 'http://localhost:3000/' } }
    const { browser } = fakeBrowser(tabs)
    const controller = new DevLoopController(browser)
    await controller.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    tabs[1].url = 'https://bank.example/'
    const readDelta = vi.fn(okDelta)
    const answer = await controller.capture({ sessionId: 'coding', args: { origin: 'http://localhost:3000' } }, readDelta, wrap)
    expect(answer.error?.message).toMatch(/left http:\/\/localhost:3000/u)
    expect(readDelta).not.toHaveBeenCalled()
    await controller.onRemoved(1)
    expect(await controller.list()).toEqual([])
  })

  it('shares nothing from the page when its read is refused by policy or the user', async () => {
    const { browser, ran } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/' } }, { console: [{ level: 'error', text: 'secret' }], network: [], dropped: 0 })
    const controller = new DevLoopController(browser)
    await controller.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    const refused = await controller.capture({ sessionId: 'coding', args: {} },
      async () => ({ ok: false, error: { code: 'action-failed', message: 'The user denied reading this page.' } }), wrap)
    expect(refused).toMatchObject({ ok: false, error: { message: 'The user denied reading this page.' } })
    expect(ran).not.toContain('devLoopDrain')
  })

  it('returns console errors, failed requests and the DOM delta inside the untrusted boundary', async () => {
    const collected: DevLoopCollected = {
      console: [{ level: 'exception', text: 'TypeError: user is undefined (http://localhost:3000/app.js:12)' }],
      network: [{ method: 'POST', url: 'http://localhost:3000/api/login', status: 500 }, { method: 'GET', url: 'http://localhost:4000/x', error: 'TypeError: Failed to fetch' }],
      dropped: 2,
    }
    const { browser } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/' } }, collected)
    const controller = new DevLoopController(browser)
    await controller.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    const answer = await controller.capture({ sessionId: 'coding', args: { origin: 'http://localhost:3000' } }, okDelta, wrap)
    expect(answer.ok).toBe(true)
    const text = (answer.result as { text: string }).text
    // Raw text: the bridge fences it with its own nonce.
    expect(text.startsWith('Linked tab: http://localhost:3000')).toBe(true)
    expect((answer.result as { origins: string[] }).origins).toEqual(['http://localhost:3000'])
    expect(text).toContain('Console errors since the last turn (1):')
    expect(text).toContain('- POST http://localhost:3000/api/login → 500')
    expect(text).toContain('- GET http://localhost:4000/x → TypeError: Failed to fetch')
    expect(text).toContain('(2 more entries were dropped.)')
    expect(text).toContain('DOM changes:\n+ [3] button "Retry"')
  })

  it('reports every frame origin the capture read, so a third-party iframe taints on the bridge', async () => {
    const { browser } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/' } }, null, {
      1: ['http://localhost:3000/', 'about:blank', 'https://ads.example/frame', 'data:text/html,hi', 'blob:http://localhost:3000/abc'],
    })
    const controller = new DevLoopController(browser)
    await controller.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    const answer = await controller.capture({ sessionId: 'coding', args: {} }, okDelta, wrap)
    expect((answer.result as { origins: string[] }).origins).toEqual(['http://localhost:3000', 'https://ads.example', 'data:'])
    // No frame list: the origins cannot be vouched for.
    const blind = new DevLoopController({ ...browser, frameUrls: async () => { throw new Error('gone') } })
    await blind.link({ sessionId: 'coding', tabId: 1, origin: 'http://localhost:3000' })
    expect((await blind.capture({ sessionId: 'coding', args: {} }, okDelta, wrap)).result).toMatchObject({ origins: ['http://localhost:3000', 'unknown:'] })
  })

  it('renders an empty capture plainly', () => {
    expect(renderDevLoopCapture('http://localhost:3000', { console: [], network: [], dropped: 0 }, '')).toContain('DOM changes: none reported.')
    expect(renderDevLoopCapture('http://localhost:3000', null, undefined)).toMatch(/collector was not installed/u)
  })
})

describe('page collector', () => {
  const original = { error: console.error, fetch: globalThis.fetch }
  afterEach(() => {
    console.error = original.error
    globalThis.fetch = original.fetch
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('dsh.devloop.collector')]
  })

  it('records console errors, uncaught errors and failed fetches once, and drains them', async () => {
    const quiet = vi.fn()
    console.error = quiet
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/down')) throw new TypeError('Failed to fetch')
      return new Response('nope', { status: String(input).endsWith('/missing') ? 404 : 200 })
    }) as typeof fetch
    devLoopCollector(100, 500)
    devLoopCollector(100, 500)
    console.error('render failed', new Error('boom'))
    expect(quiet).toHaveBeenCalledOnce()
    dispatchEvent(new ErrorEvent('error', { message: 'Uncaught ReferenceError: x', filename: 'http://localhost:3000/a.js', lineno: 7 }))
    await fetch('http://localhost:3000/ok')
    await fetch('http://localhost:3000/missing', { method: 'post' })
    await expect(fetch('http://localhost:3000/down')).rejects.toThrow()
    const drained = devLoopDrain()!
    expect(drained.console).toEqual([
      { level: 'error', text: 'render failed Error: boom' },
      { level: 'exception', text: 'Uncaught ReferenceError: x (http://localhost:3000/a.js:7)' },
    ])
    expect(drained.network).toEqual([
      { method: 'POST', url: 'http://localhost:3000/missing', status: 404 },
      { method: 'GET', url: 'http://localhost:3000/down', error: 'TypeError: Failed to fetch' },
    ])
    expect(devLoopDrain()).toEqual({ console: [], network: [], dropped: 0 })
  })
})

describe('dev-loop panel RPCs', () => {
  it('records a link only after the bridge accepts its origin, and unlinks on both sides', async () => {
    const { browser } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/app' }, 2: { id: 2, url: 'http://localhost:4000/' } })
    const controller = new DevLoopController(browser)
    const gateway = vi.fn(async (method: string, payload: unknown) => method === BRIDGE_DEVLOOP_LINK_METHOD && (payload as { url: string }).url.startsWith('http://localhost:3000')
      ? { type: 'server-response', result: { ok: true, value: { link: { origin: 'http://localhost:3000' } } } }
      : { type: 'server-response', result: { ok: false } })
    const rpc = createDevLoopPanelRpc(controller, gateway, browser.getTab)
    expect(rpc('bridge.other', {})).toBeUndefined()
    await rpc(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 's1', tabId: 1, label: 'web' })
    await rpc(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 's2', tabId: 2 })
    await expect(rpc(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: '', tabId: 1 })).rejects.toThrow(/Pick a coding session/)
    expect(await controller.list()).toEqual([{ sessionId: 's1', tabId: 1, origin: 'http://localhost:3000', label: 'web' }])
    // list re-asserts every link to the bridge (it forgets links on restart).
    gateway.mockClear()
    expect(await rpc(BRIDGE_DEVLOOP_LIST_METHOD, {})).toMatchObject({ result: { ok: true, value: { items: [expect.objectContaining({ sessionId: 's1' })] } } })
    expect(gateway).toHaveBeenCalledWith(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 's1', url: 'http://localhost:3000/' })
    await rpc(BRIDGE_DEVLOOP_UNLINK_METHOD, { sessionId: 's1' })
    expect(gateway).toHaveBeenLastCalledWith(BRIDGE_DEVLOOP_UNLINK_METHOD, { sessionId: 's1' })
    expect(await controller.list()).toEqual([])
  })

  it('tells the worker which origin was linked (the user said this app is theirs), only for an accepted link', async () => {
    const { browser } = fakeBrowser({ 1: { id: 1, url: 'http://localhost:3000/app' }, 2: { id: 2, url: 'http://localhost:4000/' } })
    const gateway = vi.fn(async (method: string, payload: unknown) => method === BRIDGE_DEVLOOP_LINK_METHOD && (payload as { url: string }).url.startsWith('http://localhost:3000')
      ? { type: 'server-response', result: { ok: true, value: { link: { origin: 'http://localhost:3000' } } } }
      : { type: 'server-response', result: { ok: false } })
    const linked: string[] = []
    const rpc = createDevLoopPanelRpc(new DevLoopController(browser), gateway, browser.getTab, (origin) => { linked.push(origin) })
    await rpc(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 's1', tabId: 1 })
    await rpc(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 's2', tabId: 2 })
    expect(linked).toEqual(['http://localhost:3000'])
  })
})

