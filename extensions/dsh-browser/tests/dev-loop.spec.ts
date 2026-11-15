// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DevLoopController,
  devLoopCollector,
  devLoopDrain,
  renderDevLoopCapture,
  type DevLoopBrowser,
  type DevLoopCollected,
} from '../src/background/dev-loop.ts'
import type { ToolAnswer } from '../src/background/tools.ts'

function fakeBrowser(tabs: Record<number, { id: number; url: string; title?: string }>, collected: DevLoopCollected | null = null) {
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
  }
  return { browser, ran, stored: () => stored }
}

const wrap = (text: string): string => `<UNTRUSTED>${text}</UNTRUSTED>`
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
    expect(text.startsWith('<UNTRUSTED>')).toBe(true)
    expect(text).toContain('Console errors since the last turn (1):')
    expect(text).toContain('- POST http://localhost:3000/api/login → 500')
    expect(text).toContain('- GET http://localhost:4000/x → TypeError: Failed to fetch')
    expect(text).toContain('(2 more entries were dropped.)')
    expect(text).toContain('DOM changes:\n+ [3] button "Retry"')
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
