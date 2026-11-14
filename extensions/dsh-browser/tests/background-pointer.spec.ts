// @vitest-environment jsdom
/**
 * Pointer tools in dispatch: covered-element refusal, trusted clicks, the
 * conservative real-input retry, hover, and drag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type InputRuntime, type ToolAnswer, type ToolCall } from '../src/background/tools.ts'
import { resolvePointerTarget, quadCenter } from '../src/background/pointer-actions.ts'
import type { MeasuredTarget, WatchReport } from '../src/shared/input-setup.ts'

const TAB = { id: 42, windowId: 3, url: 'https://example.com/page', title: 'Example' }
const FRAMES = [
  { frameId: 0, parentFrameId: -1, documentId: 'doc-main', url: TAB.url },
  { frameId: 2, parentFrameId: 0, documentId: 'doc-child', url: 'https://other.test/inner' },
]

function measured(extra: Partial<MeasuredTarget> = {}): MeasuredTarget {
  return {
    rect: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    visible: true,
    activation: 'other',
    draggable: false,
    tag: 'div',
    ...extra,
  }
}

interface Harness {
  setups: Array<Record<string, unknown>>
  actions: string[]
  methods: Array<[string, Record<string, unknown>]>
}

function stubChrome(options: {
  measure?: (request: Record<string, unknown>) => MeasuredTarget
  watch?: WatchReport
  clickText?: string
} = {}): Harness {
  const harness: Harness = { setups: [], actions: [], methods: [] }
  vi.stubGlobal('chrome', {
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, message: { type?: string; action?: string; request?: Record<string, unknown> }) => {
        if (message.type === 'DSH_INPUT_SETUP') {
          const request = message.request ?? {}
          harness.setups.push(request)
          switch (request.op) {
            case 'measure': return { ok: true, result: { op: 'measure', measure: (options.measure ?? (() => measured()))(request) } }
            case 'watch-end': return { ok: true, result: { op: 'watch-end', report: options.watch ?? { changed: true, reasons: ['dom'] } } }
            case 'pointer-clear': return { ok: true, result: { op: 'pointer-clear', cleared: true } }
            case 'synthetic-hover': return { ok: true, result: { op: 'synthetic-hover' } }
            case 'synthetic-drag': return { ok: true, result: { op: 'synthetic-drag', mode: 'html5', dropped: true } }
            default: return { ok: false, error: { code: 'bad-args', message: 'unknown' } }
          }
        }
        if (message.type === 'DSH_ACTION') {
          harness.actions.push(message.action ?? '')
          if (message.action === 'browser_wait') return { ok: true, result: { text: 'stable' } }
          return { ok: true, result: { text: options.clickText ?? 'Clicked element (#target).' } }
        }
        return undefined
      }),
      query: vi.fn(async () => [TAB]),
      get: vi.fn(async () => TAB),
    },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: true }]) },
    webNavigation: {
      getAllFrames: vi.fn(async () => FRAMES),
      getFrame: vi.fn(async ({ frameId }: { frameId: number }) => FRAMES.find((frame) => frame.frameId === frameId)),
    },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  })
  return harness
}

function runtime(harness: Harness, supported = true): InputRuntime {
  return {
    supported,
    run: async (_tabId, operation) => operation({
      send: async (method: string, params: Record<string, unknown> = {}) => {
        harness.methods.push([method, params])
        return {}
      },
    }),
  }
}

async function run(call: ToolCall, input?: InputRuntime): Promise<ToolAnswer> {
  return dispatchToolCall(
    call, 'auto', { maxItems: 60, maxChars: 12_000 }, async () => 'approved', undefined, TAB, () => true,
    { unrestrictedAccess: true, followTab: async () => undefined, ...(input === undefined ? {} : { input }) },
  )
}

function mouseEvents(harness: Harness): Array<[string, number, number]> {
  return harness.methods
    .filter(([method]) => method === 'Input.dispatchMouseEvent')
    .map(([, params]) => [params.type as string, params.x as number, params.y as number])
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('covered elements', () => {
  it('refuses a click whose target is covered, without clicking', async () => {
    const harness = stubChrome({ measure: () => measured({ covered: '<div id="overlay" class="modal">' }) })
    const answer = await run({ id: '1', name: 'browser_click', args: { selector: '#buy' } })
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toMatch(/element \(#buy\) is covered by <div id="overlay" class="modal">/)
    expect(harness.actions).toEqual([])
    expect(harness.setups[0]).toMatchObject({ op: 'measure', selector: '#buy', hitTest: true })
  })

  it('still clicks when the page cannot measure the target', async () => {
    const harness = stubChrome({ measure: () => { throw new Error('gone') } })
    const answer = await run({ id: '2', name: 'browser_click', args: { selector: '#missing' } })
    expect(answer.ok).toBe(true)
    expect(harness.actions).toEqual(['browser_click'])
  })
})

describe('trusted clicks', () => {
  it('moves, presses, and releases at the element center', async () => {
    const harness = stubChrome()
    const answer = await run({ id: '4', name: 'browser_click', args: { selector: '#target', trusted: true } }, runtime(harness))
    expect(answer.ok).toBe(true)
    expect(JSON.stringify(answer.result)).toContain('Clicked element (#target) (trusted)')
    expect(mouseEvents(harness)).toEqual([['mouseMoved', 60, 40], ['mousePressed', 60, 40], ['mouseReleased', 60, 40]])
    const mark = harness.setups.find((setup) => setup.op === 'measure' && typeof setup.mark === 'string')!.mark
    expect(harness.setups).toContainEqual({ op: 'pointer-clear', token: mark })
    expect(harness.actions).toEqual(['browser_wait'])
  })

  it('double-clicks with increasing click counts', async () => {
    const harness = stubChrome()
    await run({ id: '5', name: 'browser_click', args: { selector: '#target', trusted: true, action: 'dblclick' } }, runtime(harness))
    const presses = harness.methods.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
    expect(presses.map(([, params]) => params.clickCount)).toEqual([1, 2])
  })

  it('refuses trusted clicks without a debugger', async () => {
    const harness = stubChrome()
    const answer = await run({ id: '6', name: 'browser_click', args: { selector: '#target', trusted: true } }, runtime(harness, false))
    expect(answer.error?.code).toBe('input-unavailable')
  })
})

describe('real-input retry of a synthetic click', () => {
  it('retries a plain click that changed nothing', async () => {
    const harness = stubChrome({ watch: { changed: false, reasons: [] } })
    const answer = await run({ id: '7', name: 'browser_click', args: { selector: '#target' } }, runtime(harness))
    expect(harness.actions).toEqual(['browser_click', 'browser_wait'])
    expect(mouseEvents(harness).map(([type]) => type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(JSON.stringify(answer.result)).toContain('retried with real mouse input')
  })

  it('never retries a toggle, even when nothing visibly changed', async () => {
    const harness = stubChrome({ watch: { changed: false, reasons: [] }, measure: () => measured({ activation: 'toggle', tag: 'label' }) })
    await run({ id: '8', name: 'browser_click', args: { selector: '#check' } }, runtime(harness))
    expect(harness.methods).toEqual([])
  })

  it('never retries a native button whose handler showed nothing', async () => {
    const harness = stubChrome({ watch: { changed: false, reasons: [] }, measure: () => measured({ activation: 'control', tag: 'button' }) })
    await run({ id: '18', name: 'browser_click', args: { selector: '#silent' } }, runtime(harness))
    expect(harness.methods).toEqual([])
  })

  it('does not retry when the page changed or the caller chose the synthetic path', async () => {
    const changed = stubChrome({ watch: { changed: true, reasons: ['dom'] } })
    await run({ id: '9', name: 'browser_click', args: { selector: '#target' } }, runtime(changed))
    expect(changed.methods).toEqual([])
    const explicit = stubChrome({ watch: { changed: false, reasons: [] } })
    await run({ id: '10', name: 'browser_click', args: { selector: '#target', trusted: false } }, runtime(explicit))
    expect(explicit.methods).toEqual([])
    expect(explicit.setups.some((setup) => setup.watch !== undefined)).toBe(false)
  })
})

describe('hover and drag', () => {
  it('hovers with a real mouse move, or synthetic events without a debugger', async () => {
    const real = stubChrome()
    const answer = await run({ id: '11', name: 'browser_hover', args: { selector: '#menu' } }, runtime(real))
    expect(answer.ok).toBe(true)
    expect(mouseEvents(real)).toEqual([['mouseMoved', 60, 40]])
    const synthetic = stubChrome()
    const fallback = await run({ id: '12', name: 'browser_hover', args: { selector: '#menu' } }, runtime(synthetic, false))
    expect(synthetic.setups.map((setup) => setup.op)).toContain('synthetic-hover')
    expect(JSON.stringify(fallback.result)).toContain('synthetic')
  })

  it('drags a pointer target in steps from one center to the other', async () => {
    const harness = stubChrome({
      measure: (request) => request.selector === '#slot' ? measured({ center: { x: 300, y: 40 } }) : measured(),
    })
    const answer = await run({ id: '13', name: 'browser_drag', args: { from: { selector: '#card' }, to: { selector: '#slot' }, steps: 4 } }, runtime(harness))
    expect(answer.ok).toBe(true)
    const events = mouseEvents(harness)
    expect(events[0]).toEqual(['mouseMoved', 60, 40])
    expect(events[1]).toEqual(['mousePressed', 60, 40])
    expect(events.slice(2, 6).map(([, x]) => x)).toEqual([120, 180, 240, 300])
    expect(events.at(-1)).toEqual(['mouseReleased', 300, 40])
  })

  it('uses HTML5 drag-and-drop events for a draggable source', async () => {
    const harness = stubChrome({ measure: () => measured({ draggable: true }) })
    const answer = await run({ id: '14', name: 'browser_drag', args: { from: { selector: '#card' }, toOffset: { x: 50, y: 0 } } }, runtime(harness))
    expect(harness.methods).toEqual([])
    expect(harness.setups).toContainEqual({ op: 'synthetic-drag', from: { selector: '#card' }, offset: { x: 50, y: 0 }, steps: 10 })
    expect(JSON.stringify(answer.result)).toContain('HTML5 drag-and-drop')
  })

  it('requires a current snapshot for drag indices', async () => {
    stubChrome()
    const answer = await run({ id: '17', name: 'browser_drag', args: { from: { index: 3 }, toOffset: { x: 5, y: 0 } } })
    expect(answer.error?.message).toMatch(/does not belong to the current document/)
  })

  it('validates drag arguments', async () => {
    stubChrome()
    const both = await run({ id: '15', name: 'browser_drag', args: { from: { selector: '#a' }, to: { selector: '#b' }, toOffset: { x: 1, y: 1 } } })
    expect(both.error?.code).toBe('bad-args')
    const none = await run({ id: '16', name: 'browser_drag', args: { from: { selector: '#a' } } })
    expect(none.error?.message).toMatch(/exactly one of to or toOffset/)
  })
})

describe('frame-aware pointer targets', () => {
  it('measures a subframe element in its own context and sends input to that session', async () => {
    stubChrome()
    const childCalls: Array<[string, Record<string, unknown>]> = []
    const child = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        childCalls.push([method, params])
        if (method === 'Runtime.evaluate' && String(params.expression).startsWith('document.documentElement.hasAttribute')) return { result: { value: true } }
        if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-1' } }
        if (method === 'DOM.getContentQuads') return { quads: [[100, 200, 140, 200, 140, 220, 100, 220]] }
        return {}
      },
    }
    const root = {
      send: async () => ({}),
      executionContexts: async () => [{ frameId: 'cdp-frame', uniqueId: 'ctx-1', client: child }],
    }
    const target = await resolvePointerTarget(root, 42, FRAMES[1]!, 'tok-1', { x: 1, y: 1 })
    expect(target.client).toBe(child)
    expect(target.point).toEqual({ x: 120, y: 210 })
    expect(childCalls.some(([method, params]) => method === 'Runtime.evaluate' && String(params.expression).includes('[data-dsh-pointer=\\"tok-1\\"]'))).toBe(true)
  })

  it('uses the content measurement for the main frame', async () => {
    const root = { send: vi.fn(async () => ({})) }
    const target = await resolvePointerTarget(root, 42, FRAMES[0]!, 'tok', { x: 5, y: 6 })
    expect(target).toEqual({ client: root, point: { x: 5, y: 6 } })
    expect(root.send).not.toHaveBeenCalled()
    expect(quadCenter([0, 0, 10, 0, 10, 10, 0, 10])).toEqual({ x: 5, y: 5 })
  })
})
