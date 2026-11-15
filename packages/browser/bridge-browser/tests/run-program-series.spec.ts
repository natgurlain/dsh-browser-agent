/**
 * Program series: "do the remaining N" over more steps than one `browser_run`
 * holds. One approval for the whole run, executed in batches.
 */
import { describe, expect, it, vi } from 'vitest'
import { BridgeToolError } from '../src/server.ts'
import {
  hasUnsafeKey,
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

/** `rows` repetitions of type → click → select, as the extension builds them: each step says what its element looks like. */
const seriesSteps = (rows: number) => Array.from({ length: rows }, (_unused, row) => [
  { tool: 'browser_type', args: { selector: `#row-${String(row + 3)} input`, text: `p${String(row)}`, replace: true }, target: { tag: 'input', role: 'textbox', name: 'Email', row: `Person ${String(row + 3)}` } },
  { tool: 'browser_click', args: { selector: `#row-${String(row + 3)} button` }, target: { tag: 'button', role: 'button', name: 'Archive', row: `Person ${String(row + 3)}` } },
  { tool: 'browser_select', args: { selector: `#row-${String(row + 3)} select`, value: 'x' }, target: { tag: 'select', role: 'combobox', name: 'State', row: `Person ${String(row + 3)}` } },
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
    // A step call carries the tool and its arguments only; the element descriptions travel with the approval calls.
    expect(ran.map((call) => ({ tool: call.name, args: call.args }))).toEqual(steps.map((step) => ({ tool: step.tool, args: step.args })))
    expect(later.every((args) => (args.steps as Array<{ target?: unknown }>).every((step) => step.target !== undefined))).toBe(true)
    expect(ran[0]!.program).toEqual({ id: 'p0', step: 0 })
    expect(ran[24]!.program).toEqual({ id: 'p1', step: 0 })
    expect(ran[113]!.program).toEqual({ id: 'p4', step: 17 })
    expect(ran.every((call) => call.sessionId === 's1')).toBe(true)
    expect(renderSeriesOutcome(outcome)).toMatch(/^Done: all 38 rows \(114 steps\)\./)
  })

  it('stops at the first failed step mid-way, starts no further batch, and reports the rows done', async () => {
    let seen = 0
    const { bridge, calls } = approving((name) => {
      if (name === 'browser_snapshot') return ok('delta')
      seen += 1
      // Step 62: the second step of row 21, in the third batch.
      if (seen === 62) throw new BridgeToolError('action-failed', 'it no longer looks like the rows you approved (was “Archive”, now “Delete”). Nothing was done to it.')
      return ok('ok')
    })
    const outcome = await run(bridge, seriesSteps(38))
    expect(outcome).toMatchObject({ stop: 'error', rows: { done: 20, total: 38, steps: 114 }, message: 'Stopped at step 62.', delta: 'delta' })
    expect(outcome.steps).toHaveLength(62)
    expect(outcome.steps.at(-1)).toMatchObject({ step: 62, ok: false })
    expect(runCalls(calls)).toHaveLength(3)
    expect(stepCalls(calls)).toHaveLength(62)
    // Said plainly: how far it got, which row stopped it and why, what state that row is in, and what the user can do.
    expect(renderSeriesOutcome(outcome).split('\n').slice(0, 3)).toEqual([
      'Stopped after 20 of 38 rows. Row 21: it no longer looks like the rows you approved (was “Archive”, now “Delete”). Nothing was done to it.',
      'Row 21 was left part-done (1 of 3 steps ran).',
      'Nothing else was done. You can continue with the rows that are left; a new card will show them as the page is now.',
    ])
  })

  it('does not call a row part-done when its first step is the one that stopped the run', async () => {
    let seen = 0
    const { bridge } = approving((name) => {
      if (name === 'browser_snapshot') return ok('delta')
      seen += 1
      if (seen === 61) throw new BridgeToolError('action-failed', 'its element is gone or hidden. Nothing was done to it.')
      return ok('ok')
    })
    const text = renderSeriesOutcome(await run(bridge, seriesSteps(38)))
    expect(text).toMatch(/^Stopped after 20 of 38 rows\. Row 21: its element is gone or hidden\. Nothing was done to it\.\nNothing else was done\./)
    expect(text).not.toMatch(/part-done/)
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
    expect(stopped.message).toBe('The browser bridge closed')
    // The bridge is gone: no delta read, and no step of the second batch.
    expect(stopped.delta).toBeUndefined()
    expect(stepCalls(killed.calls)).toHaveLength(24)
    expect(renderSeriesOutcome(stopped)).toMatch(/^Stopped after 8 of 10 rows: The browser bridge closed\.\nNothing else was done\. You can continue/)

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
    expect(renderSeriesOutcome(nothing)).toBe('Not run: The user denied the browser program..')
    expect(renderSeriesOutcome(outcome)).toMatch(/^Stopped after 8 of 10 rows: the run was cancelled\./)
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
    // Every step says what its element looks like (the extension shows, binds and re-checks it).
    const target = { tag: 'button', role: 'button', name: 'Archive', row: 'Invoice 1042' }
    expect(parseProgramSeries([{ tool: 'browser_click', args: { selector: '#a' }, target }], 1)).toEqual([{ tool: 'browser_click', args: { selector: '#a' }, target }])
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: { selector: '#a' } }], 1)).toThrow(/describe its element/)
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: { selector: '#a' }, target: { ...target, extra: 1 } }], 1)).toThrow(/describe its element/)
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: { selector: '#a' }, target: { ...target, name: 'x'.repeat(201) } }], 1)).toThrow(/describe its element/)
    // Argument names the approval card and its hash could disagree on are refused, in a series and in any program.
    const smuggled = JSON.parse('{"selector":"#a","__proto__":{"index":4}}') as Record<string, unknown>
    expect(() => parseProgramSeries([{ tool: 'browser_click', args: smuggled, target }], 1)).toThrow(/__proto__/)
    expect(() => parseProgram([{ tool: 'browser_click', args: smuggled }])).toThrow(/__proto__/)
    expect(() => parseProgram([{ tool: 'browser_drag', args: { from: { constructor: 1 } } }])).toThrow(/__proto__/)
    expect(hasUnsafeKey({ a: [{ b: { prototype: 1 } }] })).toBe(true)
    expect(hasUnsafeKey({ a: [{ b: { proto: 1 } }], selector: '__proto__' })).toBe(false)
    // The model-facing tool keeps its own cap: it cannot start a series.
    expect(() => parseProgram(seriesSteps(9))).toThrow(/at most 25 steps/)
  })
})
