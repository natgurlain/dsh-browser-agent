// @vitest-environment jsdom
/**
 * Program series: "do the remaining N" over more steps than one `browser_run`
 * holds. One card states and binds the whole run (every step and what its
 * element looks like); later batches continue it without a card, only on the
 * page it was approved on, only after every earlier step was done, and never
 * beyond what the card listed.
 *
 * The tests named P1–P5 are the regression tests for the review of the first
 * version (each demonstrated the flaw it now rules out).
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_SERIES_STEPS as BRIDGE_MAX_SERIES_STEPS, MAX_PROGRAM_STEPS as BRIDGE_MAX_PROGRAM_STEPS, SERIES_STEP_TOOLS as BRIDGE_SERIES_STEP_TOOLS } from '@natgurlain/dsh-bridge-browser/src/run-program.ts'
import {
  approveProgram,
  describeSeriesRow,
  endsSeries,
  MAX_PROGRAM_STEPS,
  MAX_SERIES_STEPS,
  parseProgramSeries,
  parseProgramSteps,
  PROGRAM_GRANT_TTL_MS,
  programApprovalPrompt,
  ProgramGrants,
  SERIES_GRANT_TTL_MS,
  SERIES_STEP_TOOLS,
  stepDigest,
  type ProgramStepInput,
} from '../src/background/run-program.ts'
import { approvalNotificationClass, hostApprovalReason } from '../src/background/approval-notifications.ts'
import { verifyStepTarget } from '../src/background/tools.ts'
import { canonicalJson } from '../src/security/payload-binding.ts'
import { MAX_FINISH_STEPS, RUN_BATCH_STEPS, type StepTarget } from '../src/shared/repetition.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { TabFrame } from '../src/background/frames.ts'

const ORIGIN = 'https://crm.example'
const frames: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: `${ORIGIN}/people` }]

/** `rows` repetitions of type → click → click on consecutive table rows, each step with its element's description. */
const rowSteps = (rows: number, from = 3): ProgramStepInput[] => Array.from({ length: rows }, (_unused, at) => {
  const row = at + from
  const person = `Person ${String(row)}`
  return [
    { tool: 'browser_type', args: { selector: `#people > tr:nth-child(${String(row)}) input`, text: person, replace: true }, target: { tag: 'input', role: 'textbox', name: `Email ${String(row)}`, row: person } },
    { tool: 'browser_click', args: { selector: `#people > tr:nth-child(${String(row)}) .invite` }, target: { tag: 'button', role: 'button', name: 'Invite', row: person } },
    { tool: 'browser_click', args: { selector: `#people > tr:nth-child(${String(row)}) .confirm` }, target: { tag: 'button', role: 'button', name: 'Confirm', row: person } },
  ]
}).flat()

/** The first call of a series as the bridge sends it: 8 rows now, the rest as `later`. */
const firstCall = (all: ProgramStepInput[], id = 'run-0') => ({
  id, name: 'browser_run', sessionId: 's1', args: { steps: all.slice(0, 24), series: { rowSteps: 3, later: all.slice(24) } },
})
const nextCall = (steps: ProgramStepInput[], id: string) => ({
  id, name: 'browser_run', sessionId: 's1', args: { steps, continues: 'run-0' } as Record<string, unknown>,
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

const claim = (grants: ProgramGrants, id: string, step: ProgramStepInput, index: number, tabId = 7) =>
  grants.claim({ name: step.tool, args: step.args, sessionId: 's1', program: { id, step: index } }, tabId)

/** Run a batch as the extension sees it: each step arrives (claim) and is reported done (settle) before the next. */
function runBatch(grants: ProgramGrants, id: string, steps: ProgramStepInput[]): boolean {
  return steps.every((step, index) => {
    if (claim(grants, id, step, index) === undefined) return false
    grants.settle({ id, step: index }, true)
    return true
  })
}

/** A series with its first batch done, ready for the next one. */
async function readyForSecondBatch(now?: () => number, rows = 20) {
  const all = rowSteps(rows)
  const d = deps(now === undefined ? {} : { grants: new ProgramGrants(now) })
  expect((await approveProgram(firstCall(all), d)).ok).toBe(true)
  expect(runBatch(d.grants, 'run-0', all.slice(0, 24))).toBe(true)
  return { all, d, next: all.slice(24, 48) }
}

const card = (extra: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({ kind: 'action', action: 'browser_click', summary: 'Click', origins: [ORIGIN], canTrust: true, ...extra })
const refused = { ok: false, error: { code: 'action-failed', message: expect.stringMatching(/approval no longer applies/) } }

describe('series card', () => {
  it('keeps the bridge and extension limits equal', () => {
    expect(MAX_SERIES_STEPS).toBe(BRIDGE_MAX_SERIES_STEPS)
    expect(MAX_PROGRAM_STEPS).toBe(BRIDGE_MAX_PROGRAM_STEPS)
    expect([...SERIES_STEP_TOOLS].sort()).toEqual([...BRIDGE_SERIES_STEP_TOOLS].sort())
    expect(MAX_FINISH_STEPS).toBe(MAX_SERIES_STEPS)
    expect(RUN_BATCH_STEPS).toBe(MAX_PROGRAM_STEPS)
  })

  it('states the true total up front and reads as one line per row with a human label; every step and element description is bound', () => {
    const all = rowSteps(38)
    const series = { rowSteps: 3, later: all.slice(24) }
    const prompt = programApprovalPrompt(all.slice(0, 24), frames, series)
    expect(prompt.summary).toMatch(/^Repeat a 3-step action on 38 rows: 114 steps in total on https:\/\/crm\.example/)
    expect(prompt.summary).toMatch(/batches of up to 25 steps/)
    expect(prompt.summary).toMatch(/stops at the first step that fails or the first row that no longer looks as listed/)
    expect(prompt.summary).toMatch(/never does more than the steps listed here/)
    expect(prompt.summary).toMatch(/site rules, a tainted session, or strict mode protect still ask/)
    expect(prompt.canTrust).toBe(false)
    // One folded list, one line per row: what is done, to which element, on which row.
    expect(prompt.details).toHaveLength(1)
    const detail = prompt.details![0] as { kind: 'rows'; rows: Array<{ label: string; payload: string }> }
    expect(detail.kind).toBe('rows')
    expect(detail.rows).toHaveLength(38)
    expect(detail.rows[0]!.label).toBe('Type into “Email 3” ← “Person 3” → Click “Invite” → Click “Confirm” — Person 3')
    expect(detail.rows[37]!.label).toBe('Type into “Email 40” ← “Person 40” → Click “Invite” → Click “Confirm” — Person 40')
    // The exact steps of a row are behind its line, verbatim.
    expect(JSON.parse(detail.rows[37]!.payload)).toEqual(all.slice(111).map((step) => ({ tool: step.tool, args: step.args, target: step.target })))
    // The binding covers the later batches and every element description.
    const changed = (edit: (later: ProgramStepInput[]) => ProgramStepInput[]) => programApprovalPrompt(all.slice(0, 24), frames, { rowSteps: 3, later: edit(series.later) }).binding
    expect(changed((later) => [...later.slice(0, -1), { ...later.at(-1)!, args: { selector: '#delete-all' } }])).not.toBe(prompt.binding)
    expect(changed((later) => [...later.slice(0, -1), { ...later.at(-1)!, target: { ...later.at(-1)!.target!, name: 'Delete' } }])).not.toBe(prompt.binding)
    expect(changed((later) => later.slice(0, -3))).not.toBe(prompt.binding)
    // A row with no words for its element falls back to its role.
    expect(describeSeriesRow([{ tool: 'browser_click', args: { selector: '#x' }, target: { tag: 'button', role: 'button', name: '', row: '' } }])).toBe('Click “button”')
    expect(describeSeriesRow(all.slice(0, 3), true)).toBe('输入 “Email 3” ← “Person 3” → 点击 “Invite” → 点击 “Confirm” — Person 3')
  })

  it('P5: a series card is answered in the browser only: never forwarded to the Host, and a notification can only open it', () => {
    for (const rows of [9, 83]) {
      const all = rowSteps(rows)
      const prompt = programApprovalPrompt(all.slice(0, 24), frames, { rowSteps: 3, later: all.slice(24) })
      expect(prompt.browserOnly).toBe(true)
      expect(hostApprovalReason({ id: 'x', ...prompt })).toBeUndefined()
      expect(approvalNotificationClass({ id: 'x', ...prompt })).toBe('review')
    }
    // An ordinary program card is unchanged.
    const ordinary = programApprovalPrompt([{ tool: 'browser_click', args: { selector: '#a' } }], frames)
    expect(ordinary.browserOnly).toBeUndefined()
    expect(hostApprovalReason({ id: 'x', ...ordinary })).toContain('Step 1: browser_click')
  })

  it('accepts only bounded, whole repetitions of selector-targeted click/type/select that each describe their element', () => {
    const all = rowSteps(38)
    const first = all.slice(0, 24)
    expect(parseProgramSeries({ rowSteps: 3, later: all.slice(24) }, first)).toMatchObject({ rowSteps: 3 })
    expect(parseProgramSeries({ rowSteps: 3, later: rowSteps(76) }, first)).toMatch(/at most 250 steps in total/)
    expect(parseProgramSeries({ rowSteps: 3, later: all.slice(25) }, first)).toMatch(/whole repetitions/)
    expect(parseProgramSeries({ rowSteps: 0, later: all.slice(24) }, first)).toMatch(/rowSteps/)
    expect(parseProgramSeries({ rowSteps: 3, later: [] }, first)).toMatch(/later steps/)
    expect(parseProgramSeries('all of them', first)).toMatch(/object/)
    const one = rowSteps(1).slice(1, 2)
    const bad = (step: unknown) => parseProgramSeries({ rowSteps: 1, later: [step] }, one)
    const target: StepTarget = { tag: 'button', role: 'button', name: 'Invite', row: 'Ada' }
    expect(bad({ tool: 'browser_click', args: { selector: '#a' }, target })).toMatchObject({ rowSteps: 1 })
    expect(bad({ tool: 'browser_navigate', args: { url: 'https://evil.example' }, target })).toMatch(/only selector-targeted/)
    expect(bad({ tool: 'browser_get_text', args: { selector: '#a' }, target })).toMatch(/only selector-targeted/)
    expect(bad({ tool: 'browser_click', args: { index: 3 }, target })).toMatch(/only selector-targeted/)
    expect(bad({ tool: 'browser_click', args: { selector: '#a' }, target, expect: { text: 'x' } })).toMatch(/invalid step/)
    // No description, or a malformed one: refused.
    expect(bad({ tool: 'browser_click', args: { selector: '#a' } })).toMatch(/element's description/)
    expect(bad({ tool: 'browser_click', args: { selector: '#a' }, target: { ...target, extra: 'x' } })).toMatch(/element's description/)
    expect(bad({ tool: 'browser_click', args: { selector: '#a' }, target: { ...target, name: 'x'.repeat(201) } })).toMatch(/element's description/)
    // The first batch is held to the same rules.
    expect(parseProgramSeries({ rowSteps: 1, later: one }, [{ tool: 'browser_click', args: { selector: '#a' } }])).toMatch(/element's description/)
  })

  it('P4: an own "__proto__" key is part of the digest and the binding, and such arguments are refused outright', () => {
    const plain = JSON.parse('{"selector":"#row-3 .archive"}') as Record<string, unknown>
    const extra = JSON.parse('{"selector":"#row-3 .archive","__proto__":{"index":4,"frame":2}}') as Record<string, unknown>
    expect(Object.keys(extra)).toContain('__proto__')
    // The canonical form keeps the member (it used to vanish into the prototype setter).
    expect(canonicalJson(extra)).toBe('{"__proto__":{"frame":2,"index":4},"selector":"#row-3 .archive"}')
    expect(canonicalJson(JSON.parse('{"a":{"__proto__":1}}'))).toBe('{"a":{"__proto__":1}}')
    expect(stepDigest('browser_click', plain)).not.toBe(stepDigest('browser_click', extra))
    expect(programApprovalPrompt([{ tool: 'browser_click', args: plain }], frames).binding).not.toBe(programApprovalPrompt([{ tool: 'browser_click', args: extra }], frames).binding)
    // And a program may not carry such names at all, at any depth.
    for (const args of [extra, JSON.parse('{"selector":"#a","constructor":1}'), JSON.parse('{"to":{"prototype":{}}}'), JSON.parse('{"list":[{"__proto__":1}]}')] as Array<Record<string, unknown>>) {
      expect(parseProgramSteps([{ tool: 'browser_click', args }])).toMatch(/argument name a program cannot carry/)
    }
    expect(parseProgramSteps([{ tool: 'browser_click', args: { selector: '#a' }, expect: JSON.parse('{"__proto__":{"text":"x"}}') }])).toMatch(/cannot carry/)
    const target: StepTarget = { tag: 'button', role: 'button', name: 'Invite', row: 'Ada' }
    expect(parseProgramSeries({ rowSteps: 1, later: [{ tool: 'browser_click', args: extra, target }] }, [{ tool: 'browser_click', args: plain, target }])).toMatch(/invalid step/)
    expect(parseProgramSteps([{ tool: 'browser_click', args: plain }])).toEqual([{ tool: 'browser_click', args: plain }])
  })
})

describe('series approval', () => {
  it('raises a series card only for the program the extension built, on the tab and document the user demonstrated on', async () => {
    const all = rowSteps(38)
    const none = deps({ allowSeries: undefined })
    expect(await approveProgram(firstCall(all), none)).toMatchObject({ ok: false, error: { code: 'bad-args', message: expect.stringMatching(/only for the user's own/) } })
    const foreign = deps({ allowSeries: vi.fn(() => false) })
    expect(await approveProgram(firstCall(all), foreign)).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    for (const refusedDeps of [none, foreign]) {
      expect(refusedDeps.authorize).not.toHaveBeenCalled()
      expect(refusedDeps.grants.size).toBe(0)
      expect(refusedDeps.grants.seriesSize).toBe(0)
    }
    // The extension is asked about the whole run, in order, and about the tab and document the card would be bound to.
    expect(foreign.allowSeries).toHaveBeenCalledWith('s1', all, 7, 'doc-1')
    // The per-program cap is unchanged: 114 steps in one batch is still refused, with or without a series.
    const d = deps()
    expect(await approveProgram({ id: 'x', name: 'browser_run', sessionId: 's1', args: { steps: all } }, d)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/at most 25 steps/) } })
    expect(await approveProgram({ id: 'x', name: 'browser_run', sessionId: 's1', args: { steps: all.slice(0, 24), series: { rowSteps: 3, later: all.slice(24) }, continues: 'run-0' } }, d)).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(d.authorize).not.toHaveBeenCalled()
    // An ordinary program is exactly as before: no description kept, no series bookkeeping.
    expect(await approveProgram({ id: 'p', name: 'browser_run', sessionId: 's1', args: { steps: all.slice(0, 3) } }, d)).toEqual({ ok: true, result: { text: 'Program of 3 steps approved.', programId: 'p' } })
    expect(d.grants.seriesSize).toBe(0)
    expect(claim(d.grants, 'p', all[0]!, 0)!.target).toBeUndefined()
  })

  it('runs 38 rows (114 steps) on one card: each later batch continues without a card, and nothing runs beyond the approved steps', async () => {
    const all = rowSteps(38)
    const d = deps()
    expect(await approveProgram(firstCall(all), d)).toEqual({ ok: true, result: { text: 'Program of 114 steps approved.', programId: 'run-0' } })
    expect(d.authorize).toHaveBeenCalledTimes(1)
    expect(d.authorize.mock.calls[0]![0].summary).toMatch(/38 rows: 114 steps in total/)
    expect(runBatch(d.grants, 'run-0', all.slice(0, 24))).toBe(true)
    let batch = 1
    for (let offset = 24; offset < all.length; offset += 24) {
      const steps = all.slice(offset, offset + 24)
      const id = `run-${String(batch++)}`
      expect(await approveProgram(nextCall(steps, id), d)).toEqual({ ok: true, result: { text: `Next ${String(steps.length)} steps of the approved program.`, programId: id } })
      expect(runBatch(d.grants, id, steps)).toBe(true)
    }
    expect(batch).toBe(5)
    // One card in total; four continuations were audited as covered by it.
    expect(d.authorize).toHaveBeenCalledTimes(1)
    expect(d.onContinued).toHaveBeenCalledTimes(4)
    // The approval is used up: no further batch, not even a repeat of an approved one.
    expect(d.grants.seriesSize).toBe(0)
    expect(d.grants.size).toBe(0)
    expect(await approveProgram(nextCall(all.slice(0, 24), 'run-9'), d)).toMatchObject(refused)
    expect(await approveProgram(nextCall(rowSteps(1, 41), 'run-10'), d)).toMatchObject(refused)
    expect(d.grants.size).toBe(0)
    expect(d.authorize).toHaveBeenCalledTimes(1)
  })

  it('hands each claimed series step what its element must look like, and keeps the ordinary cover rules (forced and off-origin cards still ask)', async () => {
    const { d, next } = await readyForSecondBatch()
    expect((await approveProgram(nextCall(next, 'run-1'), d)).ok).toBe(true)
    const cover = claim(d.grants, 'run-1', next[0]!, 0)!
    expect(cover.target).toEqual(next[0]!.target)
    expect(cover.covers(card())).toBe(true)
    // Taint, site rules and strict mode force their own card; so does any other origin.
    expect(cover.covers(card({ forced: true }))).toBe(false)
    expect(cover.covers(card({ perCallOnly: true }))).toBe(false)
    expect(cover.covers(card({ origins: ['https://evil.example'] }))).toBe(false)
    d.grants.settle({ id: 'run-1', step: 0 }, true)
    // A step on another tab revokes the batch and what is left of the series.
    expect(claim(d.grants, 'run-1', next[1]!, 1, 9)).toBeUndefined()
    expect(d.grants.seriesSize).toBe(0)
    expect(d.grants.size).toBe(0)
  })

  it('refuses a continuation that is not exactly the next approved steps, and withdraws the approval', async () => {
    const variants: Array<(next: ProgramStepInput[], all: ProgramStepInput[]) => ReturnType<typeof nextCall>> = [
      // One step changed.
      (next) => nextCall([{ ...next[0]!, args: { selector: '#delete-all' } }, ...next.slice(1)], 'run-1'),
      // The same step, but a different element description than the card showed.
      (next) => nextCall([{ ...next[0]!, target: { ...next[0]!.target!, name: 'Delete' } }, ...next.slice(1)], 'run-1'),
      // No element description.
      (next) => nextCall(next.map((step) => ({ tool: step.tool, args: step.args })), 'run-1'),
      // Steps skipped ahead.
      (_next, all) => nextCall(all.slice(27, 51), 'run-1'),
      // Steps the card never listed.
      () => nextCall(rowSteps(8, 100), 'run-1'),
      // A partial row.
      (next) => nextCall(next.slice(0, 23), 'run-1'),
      // Another session.
      (next) => ({ ...nextCall(next, 'run-1'), sessionId: 's2' }),
    ]
    for (const [index, variant] of variants.entries()) {
      const { all, d, next } = await readyForSecondBatch()
      expect(await approveProgram(variant(next, all), d), `variant ${String(index)}`).toMatchObject(refused)
      expect(d.grants.size).toBe(0)
      expect(d.grants.seriesSize).toBe(0)
      expect(d.onContinued).not.toHaveBeenCalled()
      // No card is ever offered in its place, and the right steps do not bring the approval back.
      expect(d.authorize).toHaveBeenCalledTimes(1)
      expect(await approveProgram(nextCall(next, 'run-2'), d)).toMatchObject(refused)
    }
    // An unknown or malformed series id names nothing.
    const { d, next } = await readyForSecondBatch()
    expect(await approveProgram({ ...nextCall(next, 'run-1'), args: { steps: next, continues: 'run-x' } }, d)).toMatchObject(refused)
    expect(await approveProgram({ ...nextCall(next, 'run-1'), args: { steps: next, continues: 7 } }, d)).toMatchObject(refused)
    expect(d.grants.size).toBe(0)
  })

  it('P1: a later batch is refused on another same-origin page or document, and any top-frame navigation of the tab ends the series', async () => {
    // The tab is now on another path with another document (a navigation, or a browser_navigate between batches).
    const moved = await readyForSecondBatch()
    const elsewhere: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'doc-OTHER', url: `${ORIGIN}/billing/payment-methods` }]
    expect(await approveProgram(nextCall(moved.next, 'run-1'), { ...moved.d, resolveTab: async () => ({ id: 7, url: elsewhere[0]!.url, windowId: 1 }), listFrames: async () => elsewhere })).toMatchObject(refused)
    expect(moved.d.authorize).toHaveBeenCalledTimes(1)
    expect(claim(moved.d.grants, 'run-1', moved.next[0]!, 0)).toBeUndefined()
    expect(moved.d.grants.seriesSize).toBe(0)
    // The same path, reloaded: another document.
    const reloaded = await readyForSecondBatch()
    expect(await approveProgram(nextCall(reloaded.next, 'run-1'), { ...reloaded.d, listFrames: async () => [{ ...frames[0]!, documentId: 'doc-2' }] })).toMatchObject(refused)
    // The same document on another path (a single-page app changed route).
    const routed = await readyForSecondBatch()
    expect(await approveProgram(nextCall(routed.next, 'run-1'), { ...routed.d, listFrames: async () => [{ ...frames[0]!, url: `${ORIGIN}/billing` }] })).toMatchObject(refused)
    // Another origin.
    const otherOrigin = await readyForSecondBatch()
    expect(await approveProgram(nextCall(otherOrigin.next, 'run-1'), { ...otherOrigin.d, listFrames: async () => [{ ...frames[0]!, url: 'https://evil.example/people' }] })).toMatchObject(refused)
    // Another tab.
    const otherTab = await readyForSecondBatch()
    expect(await approveProgram(nextCall(otherTab.next, 'run-1'), { ...otherTab.d, resolveTab: async () => ({ id: 9, url: frames[0]!.url, windowId: 1 }) })).toMatchObject(refused)

    // The navigation itself ends the series, even if the tab comes back before the next batch asks.
    const committed = await readyForSecondBatch()
    committed.d.grants.onTopFrameNavigation(7, `${ORIGIN}/people`, false)
    expect(committed.d.grants.seriesSize).toBe(0)
    expect(await approveProgram(nextCall(committed.next, 'run-1'), committed.d)).toMatchObject(refused)
    // ... and it ends the batch in flight too.
    const midBatch = deps()
    const all = rowSteps(20)
    await approveProgram(firstCall(all), midBatch)
    expect(claim(midBatch.grants, 'run-0', all[0]!, 0)).toBeDefined()
    midBatch.grants.settle({ id: 'run-0', step: 0 }, true)
    midBatch.grants.onTopFrameNavigation(7, `${ORIGIN}/people`, false)
    expect(midBatch.grants.size).toBe(0)
    expect(claim(midBatch.grants, 'run-0', all[1]!, 1)).toBeUndefined()
    // A same-document update ends it only when the path changes; another tab's navigation never does.
    const spa = await readyForSecondBatch()
    spa.d.grants.onTopFrameNavigation(7, `${ORIGIN}/people?sort=name#row-9`, true)
    spa.d.grants.onTopFrameNavigation(8, `${ORIGIN}/elsewhere`, false)
    expect(spa.d.grants.seriesSize).toBe(1)
    spa.d.grants.onTopFrameNavigation(7, `${ORIGIN}/people/9`, true)
    expect(spa.d.grants.seriesSize).toBe(0)
  })

  it('P2: a batch continues only after every step was reported done; a step that failed, was denied, or never reported ends the series and its batch', async () => {
    const all = rowSteps(20)
    // Steps merely arriving is not enough: without an outcome the next step is not covered.
    const arrivals = deps()
    await approveProgram(firstCall(all), arrivals)
    expect(claim(arrivals.grants, 'run-0', all[0]!, 0)).toBeDefined()
    expect(claim(arrivals.grants, 'run-0', all[1]!, 1)).toBeUndefined()
    expect(arrivals.grants.size).toBe(0)
    expect(await approveProgram(nextCall(all.slice(24, 48), 'run-1'), arrivals)).toMatchObject(refused)
    // Every step done but the last one's outcome unknown: no next batch, and the batch in flight goes too.
    const unreported = deps()
    await approveProgram(firstCall(all), unreported)
    expect(runBatch(unreported.grants, 'run-0', all.slice(0, 23))).toBe(true)
    expect(claim(unreported.grants, 'run-0', all[23]!, 23)).toBeDefined()
    expect(await approveProgram(nextCall(all.slice(24, 48), 'run-1'), unreported)).toMatchObject(refused)
    expect(unreported.grants.size).toBe(0)
    expect(unreported.grants.seriesSize).toBe(0)
    // A step that failed (an error, a user Deny on a forced card, a cancel, an expiry) ends both.
    for (const failAt of [0, 5, 23]) {
      const failed = deps()
      await approveProgram(firstCall(all), failed)
      expect(runBatch(failed.grants, 'run-0', all.slice(0, failAt))).toBe(true)
      expect(claim(failed.grants, 'run-0', all[failAt]!, failAt)).toBeDefined()
      failed.grants.settle({ id: 'run-0', step: failAt }, false)
      expect(failed.grants.size).toBe(0)
      expect(failed.grants.seriesSize).toBe(0)
      if (failAt < 23) expect(claim(failed.grants, 'run-0', all[failAt + 1]!, failAt + 1)).toBeUndefined()
      expect(await approveProgram(nextCall(all.slice(24, 48), 'run-1'), failed)).toMatchObject(refused)
    }
    // An outcome reported out of turn is not trusted either.
    const outOfTurn = deps()
    await approveProgram(firstCall(all), outOfTurn)
    claim(outOfTurn.grants, 'run-0', all[0]!, 0)
    outOfTurn.grants.settle({ id: 'run-0', step: 3 }, true)
    expect(outOfTurn.grants.seriesSize).toBe(0)
    // A continuation that does not match while a batch is in flight takes that batch with it.
    const inFlight = await readyForSecondBatch()
    expect((await approveProgram(nextCall(inFlight.next, 'run-1'), inFlight.d)).ok).toBe(true)
    expect(claim(inFlight.d.grants, 'run-1', inFlight.next[0]!, 0)).toBeDefined()
    expect(await approveProgram(nextCall(rowSteps(8, 100), 'run-2'), inFlight.d)).toMatchObject(refused)
    expect(inFlight.d.grants.size).toBe(0)
    // An ordinary program has no such bookkeeping (unchanged): its steps need no reports.
    const ordinary = new ProgramGrants()
    ordinary.approve('p', 's1', all.slice(0, 3), [ORIGIN], 7)
    expect(all.slice(0, 3).every((step, index) => claim(ordinary, 'p', step, index) !== undefined)).toBe(true)
    expect(ordinary.size).toBe(0)
  })

  it('P3: nothing is covered after the series lifetime: a late batch ends with the series, and a step held past it loses its cover', async () => {
    let now = 0
    const late = await readyForSecondBatch(() => now)
    now = SERIES_GRANT_TTL_MS - 1
    expect((await approveProgram(nextCall(late.next, 'run-1'), late.d)).ok).toBe(true)
    const cover = claim(late.d.grants, 'run-1', late.next[0]!, 0)!
    expect(cover.covers(card())).toBe(true)
    late.d.grants.settle({ id: 'run-1', step: 0 }, true)
    // One millisecond past the series lifetime (it used to be covered for 15 more minutes).
    now = SERIES_GRANT_TTL_MS + 1
    expect(cover.covers(card())).toBe(false)
    expect(claim(late.d.grants, 'run-1', late.next[1]!, 1)).toBeUndefined()
    expect(late.d.grants.size).toBe(0)
    expect(late.d.grants.seriesSize).toBe(0)
    // A continuation after the lifetime is refused.
    now = 0
    const expired = await readyForSecondBatch(() => now)
    now = SERIES_GRANT_TTL_MS + 1
    expect(await approveProgram(nextCall(expired.next, 'run-1'), expired.d)).toMatchObject(refused)
    // A batch that outlived its own 15 minutes cannot be followed either.
    now = 0
    const stale = deps({ grants: new ProgramGrants(() => now) })
    await approveProgram(firstCall(rowSteps(20)), stale)
    now = PROGRAM_GRANT_TTL_MS + 1
    expect(await approveProgram(nextCall(rowSteps(20).slice(24, 48), 'run-1'), stale)).toMatchObject(refused)
    expect(stale.grants.size).toBe(0)
    // An ordinary program's cover also ends with its approval when the step was held (a pause, a card).
    now = 0
    const ordinary = new ProgramGrants(() => now)
    ordinary.approve('p', 's1', rowSteps(1), [ORIGIN], 7)
    const held = claim(ordinary, 'p', rowSteps(1)[0]!, 0)!
    expect(held.covers(card())).toBe(true)
    now = PROGRAM_GRANT_TTL_MS + 1
    expect(held.covers(card())).toBe(false)
  })

  it('ends when another tool call that may change the page reaches its tab or session; reads do not end it', async () => {
    expect(endsSeries({ name: 'browser_click', args: { selector: '#x' } })).toBe(true)
    expect(endsSeries({ name: 'browser_navigate', args: { url: `${ORIGIN}/x` } })).toBe(true)
    expect(endsSeries({ name: 'browser_console_eval', args: {} })).toBe(true)
    expect(endsSeries({ name: 'browser_run', args: { steps: [] } })).toBe(true)
    // The series' own calls, and calls that only look.
    expect(endsSeries({ name: 'browser_run', args: { steps: [], continues: 'run-0' } })).toBe(false)
    expect(endsSeries({ name: 'browser_click', args: { selector: '#x' }, program: { id: 'run-0', step: 0 } })).toBe(false)
    for (const name of ['browser_snapshot', 'browser_get_text', 'browser_wait', 'browser_screenshot']) expect(endsSeries({ name, args: {} })).toBe(false)

    const sameSession = await readyForSecondBatch()
    sameSession.d.grants.onForeignAction('s1', undefined)
    expect(sameSession.d.grants.seriesSize).toBe(0)
    expect(await approveProgram(nextCall(sameSession.next, 'run-1'), sameSession.d)).toMatchObject(refused)
    const sameTab = await readyForSecondBatch()
    sameTab.d.grants.onForeignAction('another-session', 7)
    expect(sameTab.d.grants.seriesSize).toBe(0)
    const unrelated = await readyForSecondBatch()
    unrelated.d.grants.onForeignAction('another-session', 8)
    expect(unrelated.d.grants.seriesSize).toBe(1)
    expect((await approveProgram(nextCall(unrelated.next, 'run-1'), unrelated.d)).ok).toBe(true)
  })

  it('ends on take over and on the kill switch, with the batch in flight', async () => {
    for (const end of [(grants: ProgramGrants) => { grants.onTakeOver() }, (grants: ProgramGrants) => { grants.clear() }]) {
      const run = await readyForSecondBatch()
      expect((await approveProgram(nextCall(run.next, 'run-1'), run.d)).ok).toBe(true)
      expect(claim(run.d.grants, 'run-1', run.next[0]!, 0)).toBeDefined()
      end(run.d.grants)
      expect(run.d.grants.size).toBe(0)
      expect(run.d.grants.seriesSize).toBe(0)
      expect(claim(run.d.grants, 'run-1', run.next[1]!, 1)).toBeUndefined()
      expect(await approveProgram(nextCall(run.all.slice(48), 'run-2'), run.d)).toMatchObject(refused)
    }
    // A cancelled continuation (a call the kill switch aborted at the pause gate) records nothing.
    const cancelled = await readyForSecondBatch()
    expect(await approveProgram(nextCall(cancelled.next, 'run-1'), { ...cancelled.d, signal: AbortSignal.abort() })).toMatchObject({ ok: false })
    expect(cancelled.d.grants.size).toBe(0)
  })
})

describe('the check just before a series step', () => {
  const frame: TabFrame = { frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: `${ORIGIN}/people` }
  const expected: StepTarget = { tag: 'button', role: 'button', name: 'Archive', row: 'Invoice 1042' }
  const call = { id: 'c', name: 'browser_click', args: { selector: '#row-21 .archive', frame: 0 } }
  const answerWith = (response: unknown) => {
    const sendMessage = vi.fn(async () => response)
    ;(globalThis as { chrome?: unknown }).chrome = { tabs: { sendMessage } }
    return sendMessage
  }

  it('lets the step run when its element still looks as the card showed it', async () => {
    const sendMessage = answerWith({ ok: true, result: { differs: [], now: expected } })
    expect(await verifyStepTarget(7, frame, call, expected)).toBeUndefined()
    // The page is asked about the very element the action would resolve, in the document the step targets.
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'DSH_WATCH_CHECK', args: { selector: '#row-21 .archive' }, target: expected }, { documentId: 'doc-1' })
  })

  it('fails the step, in plain words, when the row was relabelled, replaced, hidden or cannot be checked', async () => {
    answerWith({ ok: true, result: { differs: ['name'], now: { ...expected, name: 'Delete' } } })
    expect(await verifyStepTarget(7, frame, call, expected)).toEqual({ ok: false, error: { code: 'action-failed', message: 'it no longer looks like the rows you approved (was “Archive”, now “Delete”). Nothing was done to it.' } })
    answerWith({ ok: true, result: { differs: ['row'], now: { ...expected, row: 'Invoice 2000' } } })
    expect((await verifyStepTarget(7, frame, call, expected))!.error!.message).toContain('(was “Invoice 1042”, now “Invoice 2000”)')
    answerWith({ ok: true, result: { differs: ['tag', 'role'], now: { ...expected, tag: 'a', role: 'link' } } })
    expect((await verifyStepTarget(7, frame, call, expected))!.error!.message).toContain('(was “button”, now “link”)')
    answerWith({ ok: true, result: { differs: ['missing'] } })
    expect((await verifyStepTarget(7, frame, call, expected))!.error!.message).toBe('its element is gone or hidden. Nothing was done to it.')
    // No answer, a refusal, or a thrown error: never run unchecked.
    for (const response of [undefined, { ok: false }, { ok: true, result: {} }]) {
      answerWith(response)
      expect(await verifyStepTarget(7, frame, call, expected)).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    }
    ;(globalThis as { chrome?: unknown }).chrome = { tabs: { sendMessage: vi.fn(async () => { throw new Error('Receiving end does not exist') }) } }
    expect(await verifyStepTarget(7, frame, call, expected)).toMatchObject({ ok: false })
  })
})
