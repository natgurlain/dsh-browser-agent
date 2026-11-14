// @vitest-environment jsdom
/**
 * Paginated browser_extract runs on one approval for one origin: once the
 * "next" control lands on another origin, nothing more is read or clicked.
 * (Review PoC paginate-xorigin.)
 */
import { afterEach, expect, it, vi } from 'vitest'
import { dispatchToolCall } from '../src/background/tools.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubTab(options: { reportNavigation: boolean }): { log: string[] } {
  const runtimeListeners = new Set<(message: unknown, sender: unknown) => void>()
  let frameUrl = 'https://attacker.example/list'
  let documentId = 'doc-attacker'
  const log: string[] = []
  const sendMessage = vi.fn(async (_tabId: number, message: { action: string }, opts?: { documentId?: string }) => {
    log.push(`${message.action} -> ${frameUrl} (${opts?.documentId ?? documentId})`)
    if (message.action === 'browser_extract') {
      return { ok: true, result: { text: 'x', data: { columns: ['n'], rows: [{ n: `row from ${new URL(frameUrl).origin} #${log.length}` }] } } }
    }
    if (message.action === 'browser_click') {
      if (frameUrl.startsWith('https://attacker.example')) {
        // The attacker's "next" control navigates the tab to another site.
        frameUrl = 'https://bank.example/transfers'
        documentId = 'doc-bank'
        queueMicrotask(() => {
          for (const listener of runtimeListeners) listener({ type: 'DSH_CONTENT_READY' }, { tab: { id: 9 }, frameId: 0, documentId, url: frameUrl })
        })
        return { ok: true, result: { text: 'Clicked link.', ...(options.reportNavigation ? { navigationPending: true } : {}) } }
      }
      return { ok: true, result: { text: 'Clicked.' } }
    }
    return { ok: true, result: { text: '' } }
  })
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async (id: number) => ({ id, url: frameUrl })),
      sendMessage,
      onCreated: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId, url: frameUrl }]) },
    runtime: {
      onMessage: {
        addListener: (listener: never) => { runtimeListeners.add(listener) },
        removeListener: (listener: never) => { runtimeListeners.delete(listener) },
      },
    },
  })
  return { log }
}

for (const reportNavigation of [true, false]) {
  it(`stops paginating when the next control leaves the approved origin (navigation ${reportNavigation ? 'reported' : 'silent'})`, async () => {
    const { log } = stubTab({ reportNavigation })
    const prompts: { origins: string[] }[] = []
    const answer = await dispatchToolCall(
      { id: '1', name: 'browser_extract', args: { table: '#t', paginate: { nextSelector: '#confirm-transfer', maxPages: 3 } } },
      'ask', undefined,
      async (prompt) => { prompts.push({ origins: prompt.origins }); return 'approved' },
      undefined, { id: 9, url: 'https://attacker.example/list', title: 't' } as never,
    )
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.origins).toEqual(['https://attacker.example'])
    // Nothing is read from, or clicked on, the other origin.
    expect(log.filter((line) => line.includes('bank.example'))).toEqual([])
    const result = answer.result as { text: string; data: { rows: { n: string }[]; url: string; pages: number } }
    expect(result.data.rows.every((row) => row.n.includes('attacker.example'))).toBe(true)
    expect(result.data.pages).toBe(1)
    expect(result.data.url).toBe('https://attacker.example/list')
    expect(result.text).toMatch(/stopped: the next page is on another origin/)
  })
}
