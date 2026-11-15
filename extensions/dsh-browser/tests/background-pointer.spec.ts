// @vitest-environment jsdom
/**
 * Pointer tools in dispatch: covered-element refusal, trusted clicks with a
 * CDP re-hit-test before every press, the no-effect hint, hover, and drag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputRuntime, ToolAnswer, ToolCall } from '../src/background/tools.ts'
import { dispatchOnTab } from './support/dispatch.ts'
import { mouseDrag, resolvePointerTarget, quadCenter } from '../src/background/pointer-actions.ts'
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

/**
 * What the CDP hit-test at the press point finds: the target (`true`), another
 * node in the same frame (`false`), or a node in another frame (`'frame'`).
 */
type HitOutcome = boolean | 'frame'

function runtime(harness: Harness, supported = true, hit: () => HitOutcome = () => true): InputRuntime {
  const client = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      harness.methods.push([method, params])
      if (method === 'Runtime.evaluate') return String(params.expression).includes('.has(') ? { result: { value: true } } : { result: { objectId: 'target' } }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 100 } }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 9, frameId: hit() === 'frame' ? 'other-frame' : 'main-frame' }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'hit' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: hit() === true } }
      if (method === 'DOM.describeNode') return { node: { nodeName: hit() === 'frame' ? 'IFRAME' : 'DIV' } }
      return {}
    },
    isolatedContexts: async () => [{ frameId: 'main-frame', uniqueId: 'iso-main', id: 5, isolated: true, client }],
  }
  return { supported, run: async (_tabId, operation) => operation(client) }
}

async function run(call: ToolCall, input?: InputRuntime): Promise<ToolAnswer> {
  return dispatchOnTab(call, { tab: TAB, context: { unrestrictedAccess: true, ...(input === undefined ? {} : { input }) } })
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

describe('CDP re-hit-test before trusted input (#2, pointer-poc)', () => {
  it('re-hit-tests after the move and before every press', async () => {
    const harness = stubChrome()
    await run({ id: '30', name: 'browser_click', args: { selector: '#target', trusted: true, action: 'dblclick' } }, runtime(harness))
    const sequence = harness.methods
      .map(([method, params]) => method === 'Input.dispatchMouseEvent' ? String(params.type) : method)
      .filter((step) => step === 'DOM.getNodeForLocation' || step.startsWith('mouse'))
    expect(sequence).toEqual(['mouseMoved', 'DOM.getNodeForLocation', 'mousePressed', 'mouseReleased', 'DOM.getNodeForLocation', 'mousePressed', 'mouseReleased'])
    const located = harness.methods.find(([method]) => method === 'DOM.getNodeForLocation')![1]
    // Document coordinates: the viewport point plus the page's scroll offset.
    expect(located).toMatchObject({ x: 60, y: 140, ignorePointerEventsNone: false })
  })

  it('refuses the press when the point now lands on a cross-origin iframe', async () => {
    const harness = stubChrome()
    const answer = await run({ id: '31', name: 'browser_click', args: { selector: '#next', trusted: true } }, runtime(harness, true, () => 'frame'))
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toMatch(/occupied by <iframe>, so the click was not delivered/)
    expect(mouseEvents(harness).map(([type]) => type)).toEqual(['mouseMoved'])
    const mark = harness.setups.find((setup) => setup.op === 'measure' && typeof setup.mark === 'string')!.mark
    expect(harness.setups).toContainEqual({ op: 'pointer-clear', token: mark })
  })

  it('refuses when the page made the target transparent to the pointer at the last moment', async () => {
    // The content-script hit-test passed; by the press, the point reaches another node of the same frame.
    const second = stubChrome()
    const refused = await run({ id: '33', name: 'browser_click', args: { selector: '#next', trusted: true } }, runtime(second, true, () => false))
    expect(refused.ok).toBe(false)
    expect(mouseEvents(second).some(([type]) => type === 'mousePressed')).toBe(false)
  })

  it('never writes a DOM marker the page could observe', async () => {
    const harness = stubChrome()
    await run({ id: '34', name: 'browser_click', args: { selector: '#target', trusted: true } }, runtime(harness))
    expect(JSON.stringify(harness.methods)).not.toMatch(/data-dsh-pointer|data-dsh-frame|querySelector/)
    expect(vi.mocked(chrome.scripting.executeScript)).not.toHaveBeenCalled()
  })

  it('verifies a hover before moving and a drag source before pressing', async () => {
    const hover = stubChrome()
    const answer = await run({ id: '35', name: 'browser_hover', args: { selector: '#menu' } }, runtime(hover, true, () => 'frame'))
    expect(answer.ok).toBe(false)
    expect(mouseEvents(hover)).toEqual([])
    const drag = stubChrome()
    const dragged = await run({ id: '36', name: 'browser_drag', args: { from: { selector: '#card' }, toOffset: { x: 10, y: 0 } } }, runtime(drag, true, () => false))
    expect(dragged.ok).toBe(false)
    expect(mouseEvents(drag).map(([type]) => type)).toEqual(['mouseMoved'])
  })

  it('fails closed when the debugger cannot reach the isolated world', async () => {
    const harness = stubChrome()
    const input: InputRuntime = { supported: true, run: async (_tabId, operation) => operation({ send: async () => ({}) }) }
    const answer = await run({ id: '37', name: 'browser_click', args: { selector: '#target', trusted: true } }, input)
    expect(answer.ok).toBe(false)
    expect(harness.methods).toEqual([])
  })
})

describe('mouseDrag', () => {
  it('always releases the button once the press went out (#11)', async () => {
    const sent: string[] = []
    let moves = 0
    const client = {
      send: async (_method: string, params: Record<string, unknown> = {}) => {
        sent.push(String(params.type))
        if (params.type === 'mouseMoved' && ++moves === 3) throw new Error('detached')
        return {}
      },
    }
    await expect(mouseDrag(client, { x: 0, y: 0 }, { x: 100, y: 0 }, 4)).rejects.toThrow(/detached/)
    expect(sent).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased'])
  })
})

describe('synthetic click with no visible effect (#6)', () => {
  it('suggests trusted: true instead of re-sending the click', async () => {
    const harness = stubChrome({ watch: { changed: false, reasons: [] } })
    const answer = await run({ id: '7', name: 'browser_click', args: { selector: '#target' } }, runtime(harness))
    expect(harness.actions).toEqual(['browser_click'])
    expect(mouseEvents(harness)).toEqual([])
    expect(JSON.stringify(answer.result)).toContain('no visible effect — if the control needs real input, retry with trusted: true')
  })

  it('gives no hint for toggles, native buttons, or a click that changed something', async () => {
    const toggle = stubChrome({ watch: { changed: false, reasons: [] }, measure: () => measured({ activation: 'toggle', tag: 'label' }) })
    expect(JSON.stringify((await run({ id: '8', name: 'browser_click', args: { selector: '#check' } }, runtime(toggle))).result)).not.toContain('trusted: true')
    expect(toggle.methods).toEqual([])
    const button = stubChrome({ watch: { changed: false, reasons: [] }, measure: () => measured({ activation: 'control', tag: 'button' }) })
    expect(JSON.stringify((await run({ id: '18', name: 'browser_click', args: { selector: '#silent' } }, runtime(button))).result)).not.toContain('trusted: true')
    const changed = stubChrome({ watch: { changed: true, reasons: ['dom'] } })
    expect(JSON.stringify((await run({ id: '9', name: 'browser_click', args: { selector: '#target' } }, runtime(changed))).result)).not.toContain('trusted: true')
    expect(changed.methods).toEqual([])
    const explicit = stubChrome({ watch: { changed: false, reasons: [] } })
    await run({ id: '10', name: 'browser_click', args: { selector: '#target', trusted: false } }, runtime(explicit))
    expect(explicit.methods).toEqual([])
    expect(explicit.setups.some((setup) => setup.watch !== undefined)).toBe(false)
  })

  it('ends the effect watch when the click fails or is cancelled (#11)', async () => {
    const harness = stubChrome({ watch: { changed: false, reasons: [] } })
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (_tabId: number, message: { type?: string; request?: Record<string, unknown> }) => {
      if (message.type === 'DSH_INPUT_SETUP') {
        harness.setups.push(message.request ?? {})
        if (message.request?.op === 'measure') return { ok: true, result: { op: 'measure', measure: measured() } }
        return { ok: true, result: { op: 'watch-end', report: { changed: false, reasons: [] } } }
      }
      throw new Error('receiving end vanished')
    }) as never)
    await run({ id: '19', name: 'browser_click', args: { selector: '#target' } }, runtime(harness))
    const watch = harness.setups.find((setup) => setup.op === 'measure')!.watch
    expect(typeof watch).toBe('string')
    await vi.waitFor(() => { expect(harness.setups).toContainEqual({ op: 'watch-end', token: watch }) })
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
  it('finds the subframe by its isolated-world registry and sends input to that session', async () => {
    stubChrome()
    const childCalls: Array<[string, Record<string, unknown>]> = []
    const child = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        childCalls.push([method, params])
        if (method === 'Runtime.evaluate' && String(params.expression).includes('.has(')) return { result: { value: true } }
        if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-1' } }
        if (method === 'DOM.getContentQuads') return { quads: [[100, 200, 140, 200, 140, 220, 100, 220]] }
        return {}
      },
    }
    const other = { send: async () => ({ result: { value: false } }) }
    const root = {
      send: async () => ({}),
      isolatedContexts: async () => [
        { frameId: 'main', uniqueId: 'iso-main', id: 1, isolated: true, client: other },
        { frameId: 'cdp-frame', uniqueId: 'iso-child', id: 3, isolated: true, client: child },
      ],
    }
    const target = await resolvePointerTarget(root, 42, FRAMES[1]!, 'tok-1', { x: 1, y: 1 })
    expect(target.client).toBe(child)
    expect(target.point).toEqual({ x: 120, y: 210 })
    const expressions = childCalls.filter(([method]) => method === 'Runtime.evaluate').map(([, params]) => String(params.expression))
    expect(expressions.every((expression) => expression.includes('__dshPointerRegistry') && expression.includes('"tok-1"'))).toBe(true)
    expect(childCalls.every(([, params]) => params.uniqueContextId === undefined || params.uniqueContextId === 'iso-child')).toBe(true)
  })

  it('uses the content measurement for the main frame', async () => {
    const main = { send: vi.fn(async () => ({ result: { value: true } })) }
    const root = { send: vi.fn(async () => ({})), isolatedContexts: async () => [{ frameId: 'main', uniqueId: 'iso-main', id: 1, isolated: true, client: main }] }
    const target = await resolvePointerTarget(root, 42, FRAMES[0]!, 'tok', { x: 5, y: 6 })
    expect(target.client).toBe(main)
    expect(target.point).toEqual({ x: 5, y: 6 })
    expect(quadCenter([0, 0, 10, 0, 10, 10, 0, 10])).toEqual({ x: 5, y: 5 })
  })
})
