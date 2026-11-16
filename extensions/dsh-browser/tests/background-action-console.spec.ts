// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const consoleEntries: Array<{ index: number; level: string; timestamp: number; text: string }> = []
vi.mock('../src/background/devtools-controller.ts', () => ({
  capturedConsoleEntries: () => [...consoleEntries],
}))

const { callQuotedConsole, dispatchToolCall } = await import('../src/background/tools.ts')

function mockChrome(onClick: () => void) {
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(),
      sendMessage: vi.fn(async (_tabId: number, message: { type?: string }) => {
        // The pre-click hit-test is not the action itself.
        if (message.type === 'DSH_INPUT_SETUP') return { ok: false, error: { code: 'action-failed', message: 'not measured' } }
        // Neither is the card-time look at what the element is called.
        if (message.type === 'DSH_TARGET_INFO') return { ok: true, result: { targets: {} } }
        onClick()
        return { ok: true, result: { text: 'Clicked.' } }
      }),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId: 'd', url: 'https://app.example/' }]),
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  consoleEntries.length = 0
})

describe('console errors raised by an action', () => {
  const tab = { id: 3, url: 'https://app.example/', title: 'App' }
  const click = { id: 'c', name: 'browser_click', args: { selector: '#crash' } }

  it('quotes new errors inside the page-content boundary when sharing allows', async () => {
    consoleEntries.push({ index: 1, level: 'error', timestamp: 0, text: 'old failure' })
    mockChrome(() => {
      consoleEntries.push({ index: 2, level: 'log', timestamp: 1, text: 'just a log' })
      consoleEntries.push({ index: 3, level: 'exception', timestamp: 2, text: 'TypeError: boom' })
    })
    const answer = await dispatchToolCall(click, 'auto', undefined, async () => 'approved', undefined, tab)
    const text = (answer.result as { text: string }).text
    expect(text).toContain('1 console error(s) were logged during the action.')
    expect(text).toMatch(/UNTRUSTED_PAGE_CONTENT[\s\S]*\[exception\] TypeError: boom/)
    expect(text).not.toContain('old failure')
    expect(text).not.toContain('just a log')
  })

  it('only counts errors when page sharing does not allow their text', async () => {
    mockChrome(() => { consoleEntries.push({ index: 1, level: 'error', timestamp: 0, text: 'secret detail' }) })
    const answer = await dispatchToolCall(click, 'ask', undefined, async () => 'approved', undefined, tab)
    const text = (answer.result as { text: string }).text
    expect(text).toContain('1 console error(s) were logged during the action; read them with browser_console_logs.')
    expect(text).not.toContain('secret detail')
  })

  it('marks the call whose result carries the tab\'s console text, so it is never exempt from taint', async () => {
    // Console entries are collected for the whole tab (any frame, anything the page talked to).
    const noisy = { ...click, id: 'noisy' }
    mockChrome(() => { consoleEntries.push({ index: 1, level: 'error', timestamp: 0, text: 'GET https://evil.example/x failed' }) })
    await dispatchToolCall(noisy, 'auto', undefined, async () => 'approved', undefined, tab)
    expect(callQuotedConsole(noisy)).toBe(true)
    const quiet = { ...click, id: 'quiet' }
    mockChrome(() => {})
    await dispatchToolCall(quiet, 'auto', undefined, async () => 'approved', undefined, tab)
    expect(callQuotedConsole(quiet)).toBe(false)
  })
})
