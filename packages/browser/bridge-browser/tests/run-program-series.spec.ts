/**
 * Program series: "do the remaining N" over more steps than one `browser_run`
 * holds. One approval for the whole run, executed in batches.
 */
import { describe, expect, it, vi } from 'vitest'
import { BridgeToolError } from '../src/server.ts'
import {
  MAX_PROGRAM_STEPS,
  MAX_SERIES_STEPS,
  parseProgram,
  parseProgramSeries,
  renderSeriesOutcome,
  runProgramSeries,
} from '../src/run-program.ts'

type Handler = (name: string, args: Record<string, unknown>, program?: { id: string; step: number }) => unknown

function fakeBridge(handler: Handler) {
  const calls: { name: string; args: Record<string, unknown>; sessionId?: string; program?: { id: string; step: number } }[] = []
  const requestTool = vi.fn(async (name: string, args: Record<string, unknown>, _signal: AbortSignal, _timeout?: number, sessionId?: string, _callId?: string, program?: { id: string; step: number }) => {
    calls.push({ name, args, ...(sessionId === undefined ? {} : { sessionId }), ...(program === undefined ? {} : { program }) })
    return handler(name, args, program)
  })
  return { bridge: { requestTool } as never, calls }
}

const ok = (text: string) => ({ text })

/** `rows` repetitions of type → click → select, as the extension builds them. */
const seriesSteps = (rows: number) => Array.from({ length: rows }, (_unused, row) => [
  { tool: 'browser_type', args: { selector: `#row-${String(row + 3)} input`, text: `p${String(row)}`, replace: true } },
  { tool: 'browser_click', args: { selector: `#row-${String(row + 3)} button` } },
  { tool: 'browser_select', args: { selector: `#row-${String(row + 3)} select`, value: 'x' } },
]).flat()

const run = (bridge: never, steps: ReturnType<typeof seriesSteps>, signal = new AbortController().signal) =>
  runProgramSeries(bridge, parseProgramSeries(steps, 3), 3, { signal, sessionId: 's1' }, { toolTimeoutMs: 1000 })

/** A bridge whose extension approves the card as `p0` and each continuation as `p1`, `p2`, … */
function approving(onStep: (name: string, args: Record<string, unknown>) => unknown = (name) => ok(`${name} ok`)) {
  let batch = 0
  return fakeBridge((name, args) => name === 'browser_run' ? { programId: `p${String(batch++)}` } : onStep(name, args))
}

const stepCalls = (calls: ReturnType<typeof fakeBridge>['calls']) => calls.filter((call) => call.program !== undefined)
const runCalls = (calls: ReturnType<typeof fakeBridge>['calls']) => calls.filter((call) => call.name === 'browser_run')

describe('program series', () => {
  it('completes 38 rows of 3 steps (114 steps) in batches under one approval that carries the whole run', async () => {
    const steps = seriesSteps(38)
    const { bridge, calls } = approving()
    const outcome = await run(bridge, steps)
    expect(outcome).toMatchObject({ stop: 'completed', rows: { done: 38, total: 38, steps: 114 } })
    expect(outcome.steps).toHaveLength(114)
    // 8 rows (24 steps) per batch: 5 batches.
    const runs = runCalls(calls)
    expect(runs).toHaveLength(5)
    // The first call carries every step of the run, so the one card can show and bind the true total.
    const first = runs[0]!.args as { steps: unknown[]; series: { rowSteps: number; later: unknown[] } }
    expect(first.series.rowSteps).toBe(3)
    expect(first.steps).toHaveLength(24)
    expect([...first.steps, ...first.series.later]).toEqual(steps)
    // Later batches only name the approved series; none exceeds one program, and together they are exactly the approved rest.
    const later = runs.slice(1).map((call) => call.args as { steps: unknown[]; continues: string; series?: unknown })
    expect(later.every((args) => args.continues === 'p0' && args.series === undefined && args.steps.length <= MAX_PROGRAM_STEPS && args.steps.length % 3 === 0)).toBe(true)
    expect(later.flatMap((args) => args.steps)).toEqual(first.series.later)
    // Each step runs once, in order, tagged with its own batch's program and its place in it.
    const ran = stepCalls(calls)
    expect(ran.map((call) => ({ tool: call.name, args: call.args }))).toEqual(steps)
    expect(ran[0]!.program).toEqual({ id: 'p0', step: 0 })
    expect(ran[24]!.program).toEqual({ id: 'p1', step: 0 })
    expect(ran[113]!.program).toEqual({ id: 'p4', step: 17 })
    expect(ran.every((call) => call.sessionId === 's1')).toBe(true)
    expect(renderSeriesOutcome(outcome)).toMatch(/^Program completed: all 38 rows done \(114 steps\)\./)
  })

  it('stops at the first failed step mid-way, starts no further batch, and reports the rows done', async () => {
    let seen = 0
    const { bridge, calls } = approving((name) => {
      if (name === 'browser_snapshot') return ok('delta')
      seen += 1
      // Step 62: the second step of row 21, in the third batch.
      if (seen === 62) throw new BridgeToolError('action-failed', 'No element matches #row-23 button')
      return ok('ok')
    })
    const outcome = await run(bridge, seriesSteps(38))
    expect(outcome).toMatchObject({ stop: 'error', rows: { done: 20, total: 38, steps: 114 }, message: 'Stopped at step 62.', delta: 'delta' })
    expect(outcome.steps).toHaveLength(62)
    expect(outcome.steps.at(-1)).toMatchObject({ step: 62, ok: false })
    expect(runCalls(calls)).toHaveLength(3)
    expect(stepCalls(calls)).toHaveLength(62)
    const text = renderSeriesOutcome(outcome)
    expect(text).toMatch(/Program stopped by an error: 20 of 38 rows done \(61 of 114 steps ran\)\./)
    expect(text).toContain('62. browser_click FAILED: No element matches #row-23 button')
  })

  it('waits for each continuation before any of its steps: a paused agent holds the run between batches', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let batch = 0
    const { bridge, calls } = fakeBridge(async (name) => {
      if (name !== 'browser_run') return ok('ok')
      // The extension holds every tool call at its pause gate; the continuation is such a call.
      if (batch === 1) await held
      return { programId: `p${String(batch++)}` }
    })
    const running = run(bridge, seriesSteps(10))
    await vi.waitFor(() => { expect(runCalls(calls)).toHaveLength(2) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The first batch (8 rows) ran; nothing of the second starts while the continuation is held.
    expect(stepCalls(calls)).toHaveLength(24)
    release()
    expect(await running).toMatchObject({ stop: 'completed', rows: { done: 10, total: 10 } })
    expect(stepCalls(calls)).toHaveLength(30)
  })

  it('ends the run when a continuation is cancelled (kill switch) or refused, with the rows done so far', async () => {
    let batch = 0
    const killed = fakeBridge((name) => {
      if (name !== 'browser_run') return ok('ok')
      if (batch === 1) throw new BridgeToolError('bridge-closed', 'The browser bridge closed')
      return { programId: `p${String(batch++)}` }
    })
    const stopped = await run(killed.bridge, seriesSteps(10))
    expect(stopped).toMatchObject({ stop: 'error', rows: { done: 8, total: 10, steps: 30 } })
    expect(stopped.message).toMatch(/Stopped before step 25: The browser bridge closed/)
    // The bridge is gone: no delta read, and no step of the second batch.
    expect(stopped.delta).toBeUndefined()
    expect(stepCalls(killed.calls)).toHaveLength(24)
    expect(renderSeriesOutcome(stopped)).toMatch(/8 of 10 rows done \(24 of 30 steps ran\)/)

    batch = 0
    const refused = fakeBridge((name) => {
      if (name !== 'browser_run') return ok('ok')
      if (batch === 1) throw new BridgeToolError('action-failed', 'These steps are not the next part of an approved program')
      return { programId: `p${String(batch++)}` }
    })
    expect(await run(refused.bridge, seriesSteps(10))).toMatchObject({ stop: 'error', rows: { done: 8 } })
    expect(stepCalls(refused.calls)).toHaveLength(24)
  })

  it('stops between batches when the caller cancels, and runs nothing when the card is refused', async () => {
    const controller = new AbortController()
    let seen = 0
    const { bridge, calls } = approving(() => {
      seen += 1
      if (seen === 24) controller.abort()
      return ok('ok')
    })
    const outcome = await run(bridge, seriesSteps(10), controller.signal)
    expect(outcome).toMatchObject({ stop: 'cancelled', rows: { done: 8, total: 10 } })
    expect(runCalls(calls)).toHaveLength(1)

    const denied = fakeBridge(() => { throw new BridgeToolError('action-failed', 'The user denied the browser program.') })
    const nothing = await run(denied.bridge, seriesSteps(10))
    expect(nothing).toMatchObject({ stop: 'not-approved', steps: [], rows: { done: 0, total: 10, steps: 30 } })
    expect(denied.calls).toHaveLength(1)
    expect(renderSeriesOutcome(nothing)).toMatch(/^Program not run: The user denied/)
  })

  it('has one overall bound, and holds only whole repetitions of selector-targeted input', () => {
    expect(MAX_SERIES_STEPS).toBe(250)
    expect(parseProgramSeries(seriesSteps(83), 3)).toHaveLength(249)
    expect(() => parseProgramSeries(seriesSteps(84), 3)).toThrow(/at most 250 steps in total/)
    expect(() => parseProgramSeries(seriesSteps(10).slice(1), 3)).toThrow(/whole repetitions/)
    expect(() => parseProgramSeries(seriesSteps(10), undefined)).toThrow(/rowSteps/)
    expect(() => parseProgramSeries(seriesSteps(10), 26)).toThrow(/rowSteps/)
    expect(() => parseProgramSeries([{ tool: 'browser_navigate', args: { url: 'https://evil.example' } }], 1)).toThrow(/tool must be one of/)
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: { index: 4 } }], 1)).toThrow(/by selector/)
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: { selector: '#a', index: 4 } }], 1)).toThrow(/by selector/)
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: { selector: '#a' }, expect: { text: 'x' } }], 1)).toThrow(/expect/)
    // The model-facing tool keeps its own cap: it cannot start a series.
    expect(() => parseProgram(seriesSteps(9))).toThrow(/at most 25 steps/)
  })
})
