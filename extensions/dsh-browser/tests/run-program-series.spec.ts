// @vitest-environment jsdom
/**
 * Program series: "do the remaining N" over more steps than one `browser_run`
 * holds. One card states and binds the whole run; later batches continue it
 * without a card and can never do more than the card listed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SERIES_STEPS as BRIDGE_MAX_SERIES_STEPS, MAX_PROGRAM_STEPS as BRIDGE_MAX_PROGRAM_STEPS, SERIES_STEP_TOOLS as BRIDGE_SERIES_STEP_TOOLS } from '@natgurlain/dsh-bridge-browser/src/run-program.ts'
import {
  approveProgram,
  MAX_PROGRAM_STEPS,
  MAX_SERIES_STEPS,
  parseProgramSeries,
  PROGRAM_GRANT_TTL_MS,
  programApprovalPrompt,
  ProgramGrants,
  SERIES_GRANT_TTL_MS,
  SERIES_STEP_TOOLS,
  type ProgramStepInput,
} from '../src/background/run-program.ts'
import { LearningRuntime, type LearningDeps } from '../src/background/learning.ts'
import { MAX_FINISH_STEPS, maxFinishRows, RUN_BATCH_STEPS } from '../src/shared/repetition.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { TabFrame } from '../src/background/frames.ts'
import { memoryStorage } from './support/chrome.ts'

const ORIGIN = 'https://crm.example'
const frames: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: `${ORIGIN}/people` }]

/** `rows` repetitions of type → click → click on consecutive table rows. */
const rowSteps = (rows: number, from = 3): ProgramStepInput[] => Array.from({ length: rows }, (_unused, row) => [
  { tool: 'browser_type', args: { selector: `#people > tr:nth-child(${String(row + from)}) input`, text: 'x', replace: true } },
  { tool: 'browser_click', args: { selector: `#people > tr:nth-child(${String(row + from)}) .invite` } },
  { tool: 'browser_click', args: { selector: `#people > tr:nth-child(${String(row + from)}) .confirm` } },
]).flat()

/** The first call of a series as the bridge sends it: 8 rows now, the rest as `later`. */
const firstCall = (all: ProgramStepInput[], id = 'run-0') => ({
  id, name: 'browser_run', sessionId: 's1', args: { steps: all.slice(0, 24), series: { rowSteps: 3, later: all.slice(24) } },
})
const nextCall = (steps: ProgramStepInput[], id: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'browser_run', sessionId: 's1', args: { steps, continues: 'run-0' }, ...extra,
})

function deps(overrides: Partial<Omit<Parameters<typeof approveProgram>[1], 'authorize' | 'onContinued'>> = {}) {
  return {
    grants: new ProgramGrants(),
    resolveTab: async () => ({ id: 7, url: frames[0]!.url, windowId: 1 }),
    listFrames: async () => frames,
    signal: new AbortController().signal,
    allowSeries: vi.fn(() => true),
    ...overrides,
    authorize: vi.fn(async (_prompt: ApprovalPrompt) => 'approved' as const),
    onContinued: vi.fn(),
  }
}

/** Claim every step of a batch, as the bridge's step calls would. */
function claimAll(grants: ProgramGrants, id: string, steps: ProgramStepInput[], tabId = 7): boolean {
  return steps.every((step, index) => grants.claim({ name: step.tool, args: step.args, sessionId: 's1', program: { id, step: index } }, tabId) !== undefined)
}

describe('series card', () => {
  it('keeps the bridge and extension limits equal', () => {
    expect(MAX_SERIES_STEPS).toBe(BRIDGE_MAX_SERIES_STEPS)
    expect(MAX_PROGRAM_STEPS).toBe(BRIDGE_MAX_PROGRAM_STEPS)
    expect([...SERIES_STEP_TOOLS].sort()).toEqual([...BRIDGE_SERIES_STEP_TOOLS].sort())
    expect(MAX_FINISH_STEPS).toBe(MAX_SERIES_STEPS)
    expect(RUN_BATCH_STEPS).toBe(MAX_PROGRAM_STEPS)
  })

  it('states the true total (rows and steps) up front and lists and binds every step of every batch', () => {
    const all = rowSteps(38)
    const series = { rowSteps: 3, later: all.slice(24) }
    const prompt = programApprovalPrompt(all.slice(0, 24), frames, series)
    expect(prompt.summary).toMatch(/^Repeat a 3-step action on 38 rows: 114 steps in total on https:\/\/crm\.example/)
    expect(prompt.summary).toMatch(/batches of up to 25 steps/)
    expect(prompt.summary).toMatch(/stops at the first step that fails/)
    expect(prompt.summary).toMatch(/never does more than the steps listed here/)
    expect(prompt.summary).toMatch(/site rules, a tainted session, or strict mode protect still ask/)
    expect(prompt.canTrust).toBe(false)
    // Every one of the 114 steps is on the card with its full payload.
    expect(prompt.details).toHaveLength(114)
    expect(prompt.details![0]).toMatchObject({ label: 'Row 1 of 38, step 1 of 114: browser_type', masked: false })
    expect(prompt.details![113]).toMatchObject({ label: 'Row 38 of 38, step 114 of 114: browser_click' })
    expect((prompt.details![113] as { value: string }).value).toContain('tr:nth-child(40) .confirm')
    // The binding covers the later batches too: one changed, dropped or added later step is a different approval.
    const altered = { rowSteps: 3, later: [...series.later.slice(0, -1), { tool: 'browser_click', args: { selector: '#delete-all' } }] }
    expect(programApprovalPrompt(all.slice(0, 24), frames, altered).binding).not.toBe(prompt.binding)
    expect(programApprovalPrompt(all.slice(0, 24), frames, { rowSteps: 3, later: series.later.slice(0, -3) }).binding).not.toBe(prompt.binding)
    expect(programApprovalPrompt(all.slice(0, 24), frames).binding).not.toBe(prompt.binding)
  })

  it('accepts only bounded, whole repetitions of selector-targeted click/type/select', () => {
    const all = rowSteps(38)
    expect(parseProgramSeries({ rowSteps: 3, later: all.slice(24) }, all.slice(0, 24))).toMatchObject({ rowSteps: 3 })
    expect(parseProgramSeries({ rowSteps: 3, later: rowSteps(76) }, all.slice(0, 24))).toMatch(/at most 250 steps in total/)
    expect(parseProgramSeries({ rowSteps: 3, later: all.slice(25) }, all.slice(0, 24))).toMatch(/whole repetitions/)
    expect(parseProgramSeries({ rowSteps: 0, later: all.slice(24) }, all.slice(0, 24))).toMatch(/rowSteps/)
    expect(parseProgramSeries({ rowSteps: 3, later: [] }, all.slice(0, 24))).toMatch(/later steps/)
    expect(parseProgramSeries('all of them', all.slice(0, 24))).toMatch(/object/)
    const bad = (step: unknown) => parseProgramSeries({ rowSteps: 1, later: [step] }, [{ tool: 'browser_click', args: { selector: '#a' } }])
    expect(bad({ tool: 'browser_navigate', args: { url: 'https://evil.example' } })).toMatch(/only selector-targeted/)
    expect(bad({ tool: 'browser_get_text', args: { selector: '#a' } })).toMatch(/only selector-targeted/)
    expect(bad({ tool: 'browser_click', args: { index: 3 } })).toMatch(/only selector-targeted/)
    expect(bad({ tool: 'browser_click', args: { selector: '#a' }, expect: { text: 'x' } })).toMatch(/invalid step/)
    // The first batch is held to the same rules.
    expect(parseProgramSeries({ rowSteps: 1, later: [{ tool: 'browser_click', args: { selector: '#a' } }] }, [{ tool: 'browser_navigate', args: { url: 'https://x.example' } }])).toMatch(/only selector-targeted/)
  })
})

describe('series approval', () => {
  it('raises a series card only for the program the extension itself built, and one batch is still at most 25 steps', async () => {
    const all = rowSteps(38)
    const none = deps({ allowSeries: undefined })
    expect(await approveProgram(firstCall(all), none)).toMatchObject({ ok: false, error: { code: 'bad-args', message: expect.stringMatching(/only for the user's own/) } })
    const foreign = deps({ allowSeries: vi.fn(() => false) })
    expect(await approveProgram(firstCall(all), foreign)).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    for (const refused of [none, foreign]) {
      expect(refused.authorize).not.toHaveBeenCalled()
      expect(refused.grants.size).toBe(0)
      expect(refused.grants.seriesSize).toBe(0)
    }
    // The whole run, in order, is what the extension is asked to recognise.
    expect(foreign.allowSeries).toHaveBeenCalledWith('s1', all)
    // The per-program cap is unchanged: 114 steps in one batch is still refused, with or without a series.
    const d = deps()
    expect(await approveProgram({ id: 'x', name: 'browser_run', sessionId: 's1', args: { steps: all } }, d)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/at most 25 steps/) } })
    expect(await approveProgram({ id: 'x', name: 'browser_run', sessionId: 's1', args: { steps: all.slice(0, 24), series: { rowSteps: 3, later: all.slice(24) }, continues: 'run-0' } }, d)).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(d.authorize).not.toHaveBeenCalled()
  })

  it('runs 38 rows (114 steps) on one card: each later batch continues without a card, and nothing runs beyond the approved steps', async () => {
    const all = rowSteps(38)
    const d = deps()
    expect(await approveProgram(firstCall(all), d)).toEqual({ ok: true, result: { text: 'Program of 114 steps approved.', programId: 'run-0' } })
    expect(d.authorize).toHaveBeenCalledTimes(1)
    expect(d.authorize.mock.calls[0]![0].summary).toMatch(/38 rows: 114 steps in total/)
    expect(claimAll(d.grants, 'run-0', all.slice(0, 24))).toBe(true)
    let batch = 1
    for (let offset = 24; offset < all.length; offset += 24) {
      const steps = all.slice(offset, offset + 24)
      const id = `run-${String(batch++)}`
      expect(await approveProgram(nextCall(steps, id), d)).toEqual({ ok: true, result: { text: `Next ${String(steps.length)} steps of the approved program.`, programId: id } })
      expect(claimAll(d.grants, id, steps)).toBe(true)
    }
    expect(batch).toBe(5)
    // One card in total; four continuations were audited as covered by it.
    expect(d.authorize).toHaveBeenCalledTimes(1)
    expect(d.onContinued).toHaveBeenCalledTimes(4)
    // The approval is used up: no further batch, not even a repeat of an approved one.
    expect(d.grants.seriesSize).toBe(0)
    expect(d.grants.size).toBe(0)
    expect(await approveProgram(nextCall(all.slice(0, 24), 'run-9'), d)).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(await approveProgram(nextCall(rowSteps(1, 41), 'run-10'), d)).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(d.grants.size).toBe(0)
    expect(d.authorize).toHaveBeenCalledTimes(1)
  })

  /** A series with its first batch fully claimed, ready for the next one. */
  async function readyForSecondBatch(now?: () => number) {
    const all = rowSteps(20)
    const d = deps(now === undefined ? {} : { grants: new ProgramGrants(now) })
    expect((await approveProgram(firstCall(all), d)).ok).toBe(true)
    expect(claimAll(d.grants, 'run-0', all.slice(0, 24))).toBe(true)
    return { all, d, next: all.slice(24, 48) }
  }

  it('refuses a continuation that is not exactly the next approved steps, and withdraws the approval', async () => {
    const variants: Array<(next: ProgramStepInput[], all: ProgramStepInput[]) => ReturnType<typeof nextCall>> = [
      // One step changed.
      (next) => nextCall([{ tool: 'browser_click', args: { selector: '#delete-all' } }, ...next.slice(1)], 'run-1'),
      // Steps skipped ahead.
      (_next, all) => nextCall(all.slice(27, 51), 'run-1'),
      // Steps the card never listed.
      () => nextCall(rowSteps(8, 100), 'run-1'),
      // A partial row.
      (next) => nextCall(next.slice(0, 23), 'run-1'),
      // Another session.
      (next) => ({ ...nextCall(next, 'run-1'), sessionId: 's2' }),
      // An unknown series.
      (next) => ({ ...nextCall(next, 'run-1'), args: { steps: next, continues: 'run-x' } }),
      (next) => ({ ...nextCall(next, 'run-1'), args: { steps: next, continues: 7 as never } }),
    ]
    for (const [index, variant] of variants.entries()) {
      const { all, d, next } = await readyForSecondBatch()
      expect(await approveProgram(variant(next, all), d), `variant ${String(index)}`).toMatchObject({ ok: false, error: { code: 'action-failed', message: expect.stringMatching(/not the next part of an approved program/) } })
      expect(d.grants.size).toBe(0)
      expect(d.onContinued).not.toHaveBeenCalled()
      // No card is ever offered in its place.
      expect(d.authorize).toHaveBeenCalledTimes(1)
      // An unknown series id names nothing to revoke; every other refusal ends the series for good.
      if (index < 5) expect(await approveProgram(nextCall(next, 'run-2'), d)).toMatchObject({ ok: false })
    }
  })

  it('refuses a continuation on another tab, on another origin, after the lifetime, or after the kill switch', async () => {
    const otherTab = await readyForSecondBatch()
    expect(await approveProgram(nextCall(otherTab.next, 'run-1'), { ...otherTab.d, resolveTab: async () => ({ id: 9, url: frames[0]!.url, windowId: 1 }) })).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    const otherOrigin = await readyForSecondBatch()
    expect(await approveProgram(nextCall(otherOrigin.next, 'run-1'), { ...otherOrigin.d, listFrames: async () => [{ ...frames[0]!, url: 'https://evil.example/people' }] })).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    let now = 0
    const late = await readyForSecondBatch(() => now)
    now = SERIES_GRANT_TTL_MS + 1
    expect(await approveProgram(nextCall(late.next, 'run-1'), late.d)).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    const killed = await readyForSecondBatch()
    killed.d.grants.clear()
    expect(await approveProgram(nextCall(killed.next, 'run-1'), killed.d)).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    for (const run of [otherTab, otherOrigin, late, killed]) {
      expect(run.d.grants.size).toBe(0)
      expect(run.d.grants.seriesSize).toBe(0)
    }
    // A cancelled call (pause released by the kill switch) records nothing.
    const cancelled = await readyForSecondBatch()
    expect(await approveProgram(nextCall(cancelled.next, 'run-1'), { ...cancelled.d, signal: AbortSignal.abort() })).toMatchObject({ ok: false })
    expect(cancelled.d.grants.size).toBe(0)
  })

  it('starts the next batch only after every step of the one before it was claimed; a broken batch ends the series', async () => {
    const all = rowSteps(20)
    // Batch 1 still has steps to run: the continuation is refused and the series withdrawn.
    const early = deps()
    await approveProgram(firstCall(all), early)
    expect(claimAll(early.grants, 'run-0', all.slice(0, 23))).toBe(true)
    expect(await approveProgram(nextCall(all.slice(24, 48), 'run-1'), early)).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(early.grants.seriesSize).toBe(0)
    // A step that does not match its batch revokes the batch and the series with it.
    const broken = deps()
    await approveProgram(firstCall(all), broken)
    expect(broken.grants.claim({ name: 'browser_click', args: { selector: '#delete-all' }, sessionId: 's1', program: { id: 'run-0', step: 0 } }, 7)).toBeUndefined()
    expect(broken.grants.size).toBe(0)
    expect(broken.grants.seriesSize).toBe(0)
    expect(await approveProgram(nextCall(all.slice(24, 48), 'run-1'), broken)).toMatchObject({ ok: false })
    // A batch that outlived its own lifetime cannot be followed either.
    let now = 0
    const stale = deps({ grants: new ProgramGrants(() => now) })
    await approveProgram(firstCall(all), stale)
    now = PROGRAM_GRANT_TTL_MS + 1
    expect(await approveProgram(nextCall(all.slice(24, 48), 'run-1'), stale)).toMatchObject({ ok: false })
    expect(stale.grants.size).toBe(0)
  })

  it('keeps every step of a continued batch under the ordinary cover rules (forced and off-origin cards still ask)', async () => {
    const { d, next } = await readyForSecondBatch()
    expect((await approveProgram(nextCall(next, 'run-1'), d)).ok).toBe(true)
    const cover = d.grants.claim({ name: next[0]!.tool, args: next[0]!.args, sessionId: 's1', program: { id: 'run-1', step: 0 } }, 7)!
    const card = (extra: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({ kind: 'action', action: 'browser_type', summary: 'Type', origins: [ORIGIN], canTrust: true, ...extra })
    expect(cover.covers(card())).toBe(true)
    // Taint, site rules and strict mode force their own card; so does any other origin.
    expect(cover.covers(card({ forced: true }))).toBe(false)
    expect(cover.covers(card({ perCallOnly: true }))).toBe(false)
    expect(cover.covers(card({ origins: ['https://evil.example'] }))).toBe(false)
    // A step on another tab revokes the batch and what is left of the series.
    expect(d.grants.claim({ name: next[1]!.tool, args: next[1]!.args, sessionId: 's1', program: { id: 'run-1', step: 1 } }, 9)).toBeUndefined()
    expect(d.grants.seriesSize).toBe(0)
  })
})

describe('"Do the remaining N" beyond one program (learning runtime)', () => {
  const sendMessage = vi.fn()
  let available = 38

  beforeEach(() => {
    available = 38
    sendMessage.mockReset()
    // The page has `available` further rows; the probe reports each one's cells.
    sendMessage.mockImplementation(async (_tab: number, message: { type: string; selectors?: string[][] }) => message.type === 'DSH_WATCH_PROBE'
      ? { ok: true, result: { rows: (message.selectors ?? []).slice(0, available).map(() => []) } }
      : { ok: true })
    ;(globalThis as { chrome?: unknown }).chrome = {
      tabs: { sendMessage, get: vi.fn(async (id: number) => ({ id, url: `${ORIGIN}/people`, windowId: 1, title: 'CRM' })) },
      permissions: { contains: vi.fn(async () => false) },
      storage: { local: memoryStorage().area },
    }
  })

  async function watched() {
    const request = vi.fn(async (_method: string, _payload: unknown, _timeout?: number): Promise<unknown> => ({ type: 'server-response', result: { ok: true, value: { text: 'done' } } }))
    const learningDeps: LearningDeps = {
      rpc: () => ({ request }),
      bridgeConnected: () => true,
      agentActiveOnTab: () => false,
      halted: () => false,
      fixtureAllowed: () => true,
      capturedRequests: () => undefined,
      siteDriversSupported: true,
      activeTab: async () => ({ id: 7 } as chrome.tabs.Tab),
      storage: memoryStorage({ dshLearningSettings: { watchMe: true } }).area,
    }
    const learning = new LearningRuntime(learningDeps)
    await learning.ready
    await learning.startWatching(7)
    // The user does two rows by hand: type, invite, confirm.
    for (const row of [1, 2]) {
      await learning.onWatchEvent(7, 0, { kind: 'type', css: `#people > tr:nth-child(${String(row)}) input`, value: 'x' })
      await learning.onWatchEvent(7, 0, { kind: 'click', css: `#people > tr:nth-child(${String(row)}) .invite` })
      await learning.onWatchEvent(7, 0, { kind: 'click', css: `#people > tr:nth-child(${String(row)}) .confirm` })
    }
    const suggestion = () => (learning.snapshot() as { suggestion: { remaining: number; more: boolean; period: number; program: ProgramStepInput[] } | null }).suggestion
    return { learning, request, suggestion }
  }

  it('offers all 38 remaining rows (114 steps) and sends them as one run with the row size', async () => {
    const { learning, request, suggestion } = await watched()
    expect(suggestion()).toMatchObject({ remaining: 38, more: false, period: 3 })
    const program = suggestion()!.program
    expect(program).toEqual(rowSteps(38))
    await learning.runSuggestion('s1')
    expect(request).toHaveBeenCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: program, rowSteps: 3 }, 30 * 60_000)
  })

  it('lets exactly that program raise a series card, once, for that session, only while the run is in flight', async () => {
    const { learning, request, suggestion } = await watched()
    const program = suggestion()!.program
    // Nothing is armed before the user asks.
    expect(learning.claimSeries('s1', program)).toBe(false)
    let release!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const running = learning.runSuggestion('s1')
    await vi.waitFor(() => { expect(request).toHaveBeenCalled() })
    expect(learning.claimSeries('s2', program)).toBe(false)
    expect(learning.claimSeries(undefined, program)).toBe(false)
    expect(learning.claimSeries('s1', [...program.slice(0, -1), { tool: 'browser_click', args: { selector: '#delete-all' } }])).toBe(false)
    expect(learning.claimSeries('s1', [...program, ...rowSteps(1, 41)])).toBe(false)
    expect(learning.claimSeries('s1', program.slice(0, -3))).toBe(false)
    expect(learning.claimSeries('s1', program)).toBe(true)
    expect(learning.claimSeries('s1', program)).toBe(false)
    release({ type: 'server-response', result: { ok: true, value: { text: 'done' } } })
    await running
    expect(learning.claimSeries('s1', program)).toBe(false)
  })

  it('disarms when the run ends without the card having been raised', async () => {
    const { learning, request, suggestion } = await watched()
    const program = suggestion()!.program
    request.mockRejectedValueOnce(new Error('bridge gone'))
    await expect(learning.runSuggestion('s1')).rejects.toThrow()
    expect(learning.claimSeries('s1', program)).toBe(false)
  })

  it('caps one run at 250 steps and says rows are left over', async () => {
    available = 200
    const { suggestion } = await watched()
    expect(maxFinishRows(3)).toBe(83)
    expect(suggestion()).toMatchObject({ remaining: 83, more: true })
    expect(suggestion()!.program).toHaveLength(249)
    expect(suggestion()!.program.length).toBeLessThanOrEqual(MAX_FINISH_STEPS)
    // One row must fit one batch.
    expect(maxFinishRows(25)).toBe(10)
    expect(maxFinishRows(26)).toBe(0)
    expect(maxFinishRows(1)).toBe(250)
  })

  it('keeps a remainder that fits one program on the single browser_run path', async () => {
    available = 8
    const { learning, request, suggestion } = await watched()
    expect(suggestion()).toMatchObject({ remaining: 8, more: false })
    await learning.runSuggestion('s1')
    // Exactly today's payload: no row size, so the bridge runs it as one browser_run.
    expect(request).toHaveBeenCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: rowSteps(8) }, 30 * 60_000)
    expect(learning.claimSeries('s1', rowSteps(8))).toBe(false)
  })
})
