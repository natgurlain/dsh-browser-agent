import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { memorySessionLedger } from '../src/session-ledger.ts'
import { registerBrowserTools } from '../src/tools.ts'
import { defineRunProgramTool } from '../src/run-program.ts'
import { defineWatchTools, memoryWatchRecords } from '../src/watchers.ts'
import {
  childPrompt,
  defineFanoutTool,
  FLEET_ACTION_TOOLS,
  FLEET_READ_TOOLS,
  FleetChildren,
  parseFleetTasks,
  registerFanoutTool,
  runFanout,
  type FanoutDeps,
  type FleetSubagents,
} from '../src/fanout.ts'

const signal = new AbortController().signal
const tasks = [
  { url: 'https://a.example/item', instruction: 'Read the price' },
  { url: 'https://b.example/item', instruction: 'Read the price' },
]

function harness(overrides: { result?: (index: number) => unknown; parentOwned?: boolean; start?: FleetSubagents['startActivation'] } = {}) {
  const requests: { name: string; args: Record<string, unknown>; sessionId?: string }[] = []
  const requestTool = vi.fn(async (name: string, args: Record<string, unknown>, _signal: AbortSignal, _timeout?: number, sessionId?: string) => {
    requests.push({ name, args, ...(sessionId === undefined ? {} : { sessionId }) })
    if (name === 'browser_fanout') {
      return { fleetId: 'fleet-1', tabs: (args.children as string[]).map((childId, index) => ({ childId, tabId: 100 + index })) }
    }
    return { text: 'released' }
  })
  const started: { childId: string; prompt: string; outputSchema?: unknown; delivery: string }[] = []
  const disposed: string[] = []
  let index = 0
  const startActivation = overrides.start ?? vi.fn(async (spec: Parameters<FleetSubagents['startActivation']>[0]) => {
    const mine = index++
    started.push({ childId: spec.childId, prompt: (spec.prompt[0] as { text: string }).text, ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }), delivery: spec.delivery })
    return {
      childId: spec.childId,
      result: Promise.resolve((overrides.result ?? ((i: number) => ({ output: [], structured: { price: `$${String(10 + i)}` }, stopReason: 'completed' })))(mine) as never),
      dispose: async () => { disposed.push(spec.childId) },
    }
  })
  const ledger = memorySessionLedger(overrides.parentOwned === false ? [] : ['parent'])
  const tainted: string[] = []
  const children = new FleetChildren()
  let n = 0
  const deps: FanoutDeps = {
    bridge: { requestTool } as never,
    subagents: () => ({ startActivation }) as FleetSubagents,
    children,
    ledger,
    taint: (id) => { tainted.push(id) },
    newId: () => `child-${String(++n)}`,
  }
  return { deps, requests, started, disposed, ledger, tainted, children, startActivation }
}

const parent = { id: 'parent' } as never

describe('parseFleetTasks', () => {
  it('accepts up to 8 http(s) tasks with instructions', () => {
    expect(parseFleetTasks(tasks)).toHaveLength(2)
    expect(() => parseFleetTasks(Array.from({ length: 9 }, () => tasks[0]))).toThrow(/at most 8/)
    expect(() => parseFleetTasks([{ url: 'file:///etc/passwd', instruction: 'x' }])).toThrow(/http or https/)
    expect(() => parseFleetTasks([{ url: 'https://a.example', instruction: ' ' }])).toThrow(/instruction/)
    expect(() => parseFleetTasks([])).toThrow(/non-empty/)
  })
})

describe('runFanout', () => {
  it('opens the fleet through the extension, records owned children, runs restricted subagents, and releases the tabs', async () => {
    const h = harness()
    const text = await runFanout(parent, { tasks, outputSchema: { type: 'object', properties: { price: { type: 'string' } } }, allowActions: false, closeTabs: true }, { signal }, h.deps, { toolTimeoutMs: 1000, provider: 'spawn' })
    expect(h.requests[0]).toMatchObject({ name: 'browser_fanout', sessionId: 'parent', args: { tasks, allowActions: false, children: ['child-1', 'child-2'] } })
    expect(h.started.map((entry) => entry.childId)).toEqual(['child-1', 'child-2'])
    expect(h.started.every((entry) => entry.delivery === 'caller' && entry.outputSchema !== undefined)).toBe(true)
    expect(h.started[0]!.prompt).toContain('https://a.example/item')
    expect(h.started[0]!.prompt).toContain('only read')
    expect(h.ledger.has('child-1')).toBe(true)
    expect(text).toMatch(/Fleet finished: 2 of 2 tasks completed/)
    expect(text).toMatch(/<UNTRUSTED_PAGE_CONTENT nonce="[^"]+">\n\{\n {2}"price": "\$10"/)
    expect(h.tainted).toEqual(['parent'])
    expect(h.disposed.sort()).toEqual(['child-1', 'child-2'])
    expect(h.requests.at(-1)).toMatchObject({ name: 'browser_fleet_release', sessionId: 'parent', args: { fleetId: 'fleet-1', closeTabs: true } })
    // Restrictions only live as long as the fleet.
    expect(h.children.allowlist('child-1')).toBeUndefined()
  })

  it('restricts children while they run: reads only, or reads plus page actions with allowActions', async () => {
    const seen: (readonly string[] | undefined)[] = []
    const h = harness()
    const start = vi.fn(async (spec: Parameters<FleetSubagents['startActivation']>[0]) => {
      seen.push(h.children.allowlist(spec.childId))
      return { childId: spec.childId, result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }) as never, dispose: async () => {} }
    })
    await runFanout(parent, { tasks: [tasks[0]!], allowActions: false, closeTabs: true }, { signal }, { ...h.deps, subagents: () => ({ startActivation: start }) as never }, { toolTimeoutMs: 1000, provider: 'spawn' })
    expect(seen[0]).toEqual([...FLEET_READ_TOOLS])
    await runFanout(parent, { tasks: [tasks[0]!], allowActions: true, closeTabs: false }, { signal }, { ...h.deps, subagents: () => ({ startActivation: start }) as never }, { toolTimeoutMs: 1000, provider: 'spawn' })
    expect(seen[1]).toEqual([...FLEET_READ_TOOLS, ...FLEET_ACTION_TOOLS])
    expect(seen.flat()).not.toContain('browser_open_tab')
    expect(seen.flat()).not.toContain('browser_close_tab')
  })

  it('does not record children of a session the bridge does not own', async () => {
    const h = harness({ parentOwned: false })
    await runFanout(parent, { tasks, allowActions: false, closeTabs: true }, { signal }, h.deps, { toolTimeoutMs: 1000, provider: 'spawn' })
    expect(h.ledger.has('child-1')).toBe(false)
  })

  it('reports a failed child without failing the fleet, and still releases tabs', async () => {
    const h = harness({ result: (i) => i === 0 ? { output: [], stopReason: 'error', diagnostic: 'model failed' } : { output: [{ type: 'text', text: 'Price: $3' }], stopReason: 'completed' } })
    const text = await runFanout(parent, { tasks, allowActions: false, closeTabs: true }, { signal }, h.deps, { toolTimeoutMs: 1000, provider: 'spawn' })
    expect(text).toMatch(/1 of 2 tasks completed/)
    expect(text).toContain('Diagnostic: model failed')
    expect(text).toContain('Price: $3')
    expect(h.requests.at(-1)!.name).toBe('browser_fleet_release')
  })

  it('starts nothing when the fleet card is declined', async () => {
    const h = harness()
    const deps = { ...h.deps, bridge: { requestTool: vi.fn(async () => { throw new Error('The user declined the tab fleet.') }) } as never }
    await expect(runFanout(parent, { tasks, allowActions: false, closeTabs: true }, { signal }, deps, { toolTimeoutMs: 1000, provider: 'spawn' })).rejects.toThrow(/declined/)
    expect(h.startActivation).not.toHaveBeenCalled()
  })
})

describe('fleet registration', () => {
  it('restricts a fleet child at agent/created and guards its calls', () => {
    const listeners: Record<string, (payload: unknown) => void> = {}
    const guards: ((execution: { name: string; agent?: { id: string } }) => unknown)[] = []
    const ctx = {
      tools: {
        register: () => () => {},
        guard: (guard: (typeof guards)[number]) => { guards.push(guard); return () => {} },
        schemas: () => ['browser_snapshot', 'browser_get_text', 'browser_wait', 'bash'].map((name) => ({ name })),
      },
      on: (name: string, listener: (payload: unknown) => void) => { listeners[name] = listener; return () => {} },
    } as unknown as Context
    const h = harness()
    registerFanoutTool(ctx, h.deps, { toolTimeoutMs: 1000, provider: 'spawn' })
    h.children.expect('kid', [...FLEET_READ_TOOLS])
    const restrict = vi.fn(() => () => {})
    listeners['agent/created']!({ agent: { id: 'kid', ctx: { tools: { restrict } } } })
    // Only registered names are passed (restrict refuses unknown ones).
    expect(restrict).toHaveBeenCalledWith({ allow: ['browser_snapshot', 'browser_get_text', 'browser_wait'] })
    const other = vi.fn()
    listeners['agent/created']!({ agent: { id: 'someone-else', ctx: { tools: { restrict: other } } } })
    expect(other).not.toHaveBeenCalled()
    expect(guards[0]!({ name: 'browser_click', agent: { id: 'kid' } })).toMatch(/Fleet workers may only use/)
    expect(guards[0]!({ name: 'bash', agent: { id: 'kid' } })).toMatch(/Fleet workers/)
    expect(guards[0]!({ name: 'browser_get_text', agent: { id: 'kid' } })).toBeUndefined()
    expect(guards[0]!({ name: 'structured_output', agent: { id: 'kid' } })).toBeUndefined()
    expect(guards[0]!({ name: 'bash', agent: { id: 'parent' } })).toBeUndefined()
  })

  it('needs an agent and keeps every Phase 3 tool inside the description budget', async () => {
    const h = harness()
    const tool = defineFanoutTool(h.deps, { toolTimeoutMs: 1000, provider: 'spawn' })
    await expect((tool.execute as (a: unknown, e: unknown) => Promise<unknown>)({ tasks }, { signal })).rejects.toThrow(/needs an agent/)
    const registered: { description: string }[] = []
    const ctx = { tools: { register: (definition: { description: string }) => { registered.push(definition); return () => {} } } } as unknown as Context
    registerBrowserTools(ctx, { requestTool: vi.fn() } as never, { toolTimeoutMs: 1000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const added = [
      tool,
      defineRunProgramTool({ requestTool: vi.fn() } as never, { toolTimeoutMs: 1000 }),
      ...defineWatchTools({ requestTool: vi.fn() } as never, memoryWatchRecords(), { toolTimeoutMs: 1000 }),
    ]
    for (const entry of added) expect(String(entry.description).length).toBeLessThan(170)
    const all = [...registered.map((entry) => entry.description), ...added.map((entry) => String(entry.description))]
    expect(all.reduce((sum, text) => sum + text.length, 0) / all.length).toBeLessThan(170)
  })

  it('tells read-only workers they cannot act', () => {
    expect(childPrompt(tasks[0]!, 0, 2, false, true)).toMatch(/only read[\s\S]*structured_output/)
    expect(childPrompt(tasks[0]!, 1, 2, true, false)).toMatch(/each page action asks the user/)
  })
})
