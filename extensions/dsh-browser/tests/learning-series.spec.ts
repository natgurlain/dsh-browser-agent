// @vitest-environment jsdom
/**
 * "Do the remaining N" beyond one program, extension learning runtime: what
 * is offered, what is sent, which program may raise a series card, and how a
 * run that stopped part-way is continued.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LearningRuntime, type LearningDeps } from '../src/background/learning.ts'
import { detectRepetition, looksLikeStep, MAX_FINISH_STEPS, maxFinishRows, nameShape, parseStepTarget, type StepTarget, type WatchEvent } from '../src/shared/repetition.ts'
import { memoryStorage } from './support/chrome.ts'

const ORIGIN = 'https://crm.example'
const sendMessage = vi.fn()
/** Further rows on the page, and how the page describes one step's element (tests relabel rows through it). */
let available = 38
let describe_: (row: number, position: number) => StepTarget | undefined
let tabUrl = `${ORIGIN}/people`
let documentId = 'doc-1'

const defaultTarget = (row: number, position: number): StepTarget => [
  { tag: 'input', role: 'textbox', name: `Email ${String(row)}`, row: `Person ${String(row)}` },
  { tag: 'button', role: 'button', name: 'Invite', row: `Person ${String(row)}` },
  { tag: 'button', role: 'button', name: 'Confirm', row: `Person ${String(row)}` },
][position]!

/** The program for `rows` rows starting at table row `from`, as the runtime builds it. */
const program = (rows: number, from = 3, withTargets = true): Array<{ tool: string; args: Record<string, unknown>; target?: StepTarget }> => Array.from({ length: rows }, (_unused, at) => {
  const row = at + from
  const steps = [
    { tool: 'browser_type', args: { selector: `#people > tr:nth-child(${String(row)}) input`, text: 'x', replace: true } },
    { tool: 'browser_click', args: { selector: `#people > tr:nth-child(${String(row)}) .invite` } },
    { tool: 'browser_click', args: { selector: `#people > tr:nth-child(${String(row)}) .confirm` } },
  ]
  return withTargets ? steps.map((step, position) => ({ ...step, target: defaultTarget(row, position) })) : steps
}).flat()

beforeEach(() => {
  available = 38
  describe_ = defaultTarget
  tabUrl = `${ORIGIN}/people`
  documentId = 'doc-1'
  sendMessage.mockReset()
  // The page: rows 3 … 2 + available exist; a row whose element has no description (hidden, gone) ends the probe.
  sendMessage.mockImplementation(async (_tab: number, message: { type: string; selectors?: string[][] }) => {
    if (message.type !== 'DSH_WATCH_PROBE') return { ok: true }
    const rows: string[][] = []
    const targets: StepTarget[][] = []
    for (const set of (message.selectors ?? [])) {
      const row = Number(/nth-child\((\d+)\)/u.exec(set[0]!)![1])
      if (row > 2 + available) break
      const described = set.map((_selector, position) => describe_(row, position))
      if (described.some((target) => target === undefined)) break
      rows.push([`Person ${String(row)}`, '', ''])
      targets.push(described as StepTarget[])
    }
    return { ok: true, result: { rows, targets } }
  })
  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: { sendMessage, get: vi.fn(async (id: number) => ({ id, url: tabUrl, windowId: 1, title: 'CRM' })) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId, url: tabUrl }]) },
    permissions: { contains: vi.fn(async () => false) },
    storage: { local: memoryStorage().area },
  }
})

const answer = (value: unknown) => ({ type: 'server-response', result: { ok: true, value } })
const completed = (rows: number) => answer({ report: { status: 'completed', steps: Array.from({ length: rows * 3 }, () => ({})), rows: { done: rows, total: rows, steps: rows * 3 } }, text: `Done: all ${String(rows)} rows.` })
const stopped = (done: number, total: number) => answer({ report: { status: 'failed', steps: Array.from({ length: done * 3 + 1 }, () => ({})), rows: { done, total, steps: total * 3 } }, text: `Stopped after ${String(done)} of ${String(total)} rows. Row ${String(done + 1)}: it no longer looks like the rows you approved (was “Invite”, now “Delete”). Nothing was done to it.` })

async function watched() {
  const request = vi.fn(async (_method: string, _payload: unknown, _timeout?: number): Promise<unknown> => completed(1))
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
    const cells = [`Person ${String(row)}`, '', '']
    await learning.onWatchEvent(7, 0, { kind: 'type', css: `#people > tr:nth-child(${String(row)}) input`, value: 'x', label: `Email ${String(row)}`, tag: 'input', role: 'textbox', cells })
    await learning.onWatchEvent(7, 0, { kind: 'click', css: `#people > tr:nth-child(${String(row)}) .invite`, label: 'Invite', tag: 'button', role: 'button', cells })
    await learning.onWatchEvent(7, 0, { kind: 'click', css: `#people > tr:nth-child(${String(row)}) .confirm`, label: 'Confirm', tag: 'button', role: 'button', cells })
  }
  type Offer = { remaining: number; more: boolean; period: number; program: ReturnType<typeof program> }
  const state = () => learning.snapshot() as { suggestion: Offer | null; resume: { rows: number } | null }
  const sent = () => request.mock.calls.filter(([method]) => method === 'bridge.learning.program.run').map(([, payload]) => payload as { steps: ReturnType<typeof program>; rowSteps?: number; sessionId?: string })
  return { learning, request, state, sent }
}

describe('the offer', () => {
  it('offers all 38 remaining rows (114 steps), each step with what its element looks like, and sends them as one run with the row size', async () => {
    const { learning, request, state } = await watched()
    expect(state().suggestion).toMatchObject({ remaining: 38, more: false, period: 3 })
    expect(state().suggestion!.program).toEqual(program(38))
    request.mockResolvedValueOnce(completed(38))
    await learning.runSuggestion('s1')
    expect(request).toHaveBeenCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: program(38), rowSteps: 3 }, 30 * 60_000)
    expect(state().resume).toBeNull()
  })

  it('counts only rows that look like the ones the user did: the first hidden, missing or different row ends the offer', async () => {
    // Row 13 has a "Delete" button where the user clicked "Invite".
    describe_ = (row, position) => row === 13 && position === 1 ? { ...defaultTarget(row, position), name: 'Delete' } : defaultTarget(row, position)
    expect((await watched()).state().suggestion).toMatchObject({ remaining: 10 })
    // A link where the user clicked a button.
    describe_ = (row, position) => row === 20 && position === 2 ? { ...defaultTarget(row, position), tag: 'a', role: 'link' } : defaultTarget(row, position)
    expect((await watched()).state().suggestion).toMatchObject({ remaining: 17 })
    // The content script reports nothing for a hidden row (probeRowTargets stops there).
    describe_ = (row, position) => row === 6 ? undefined : defaultTarget(row, position)
    const short = await watched()
    expect(short.state().suggestion).toMatchObject({ remaining: 3 })
    // Within one program nothing changes: no element descriptions travel.
    expect(short.state().suggestion!.program).toEqual(program(3, 3, false))
    // A name that only differs by the row's own text or number is the same shape.
    expect(nameShape('Email 3')).toBe(nameShape('Email 41'))
    expect(nameShape('Invite Ada Lovelace', ['Ada Lovelace', 'ada@example.org'])).toBe(nameShape('Invite Linus', ['Linus']))
    expect(nameShape('Invite')).not.toBe(nameShape('Delete'))
    const events: WatchEvent[] = [1, 2].map((row) => ({ kind: 'click' as const, css: `#r${String(row)} button`, label: `Archive invoice ${String(row)}`, tag: 'button', role: 'button' }))
    const step = detectRepetition(events)!.steps[0]!
    expect(step).toMatchObject({ tag: 'button', role: 'button', shape: 'Archive invoice #' })
    expect(looksLikeStep(step, { tag: 'button', role: 'button', name: 'Archive invoice 77', row: '' }, [])).toBe(true)
    expect(looksLikeStep(step, { tag: 'button', role: 'button', name: 'Delete invoice 77', row: '' }, [])).toBe(false)
    expect(looksLikeStep(step, { tag: 'a', role: 'button', name: 'Archive invoice 77', row: '' }, [])).toBe(false)
  })

  it('does not go beyond one program when the page reports no element descriptions', async () => {
    sendMessage.mockImplementation(async (_tab: number, message: { type: string; selectors?: string[][] }) => message.type === 'DSH_WATCH_PROBE'
      ? { ok: true, result: { rows: (message.selectors ?? []).slice(0, 38).map(() => ['Person', '', '']) } }
      : { ok: true })
    const { state } = await watched()
    expect(state().suggestion).toMatchObject({ remaining: 8 })
    expect(state().suggestion!.program).toHaveLength(24)
  })

  it('caps one run at 250 steps and says rows are left over', async () => {
    available = 200
    const { state } = await watched()
    expect(maxFinishRows(3)).toBe(83)
    expect(state().suggestion).toMatchObject({ remaining: 83, more: true })
    expect(state().suggestion!.program).toHaveLength(249)
    expect(state().suggestion!.program.length).toBeLessThanOrEqual(MAX_FINISH_STEPS)
    // One row must fit one batch.
    expect(maxFinishRows(25)).toBe(10)
    expect(maxFinishRows(26)).toBe(0)
    expect(maxFinishRows(1)).toBe(250)
  })

  it('keeps a remainder that fits one program on the single browser_run path, unchanged', async () => {
    available = 8
    const { learning, request, state } = await watched()
    expect(state().suggestion).toMatchObject({ remaining: 8, more: false })
    const probes = sendMessage.mock.calls.filter(([, message]) => (message as { type: string }).type === 'DSH_WATCH_PROBE').length
    await learning.runSuggestion('s1')
    // Exactly the old payload: no row size, no element descriptions, and no second probe.
    expect(request).toHaveBeenCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: program(8, 3, false) }, 30 * 60_000)
    expect(sendMessage.mock.calls.filter(([, message]) => (message as { type: string }).type === 'DSH_WATCH_PROBE')).toHaveLength(probes)
    expect(learning.claimSeries('s1', program(8, 3, false), 7, 'doc-1')).toBe(false)
  })

  it('accepts only a well-formed element description', () => {
    expect(parseStepTarget({ tag: 'button', role: 'button', name: 'Invite', row: 'Ada' })).toEqual({ tag: 'button', role: 'button', name: 'Invite', row: 'Ada' })
    for (const bad of [null, 'button', [], { tag: 'button', role: 'button', name: 'Invite' }, { tag: '', role: '', name: '', row: '' }, { tag: 'button', role: 'button', name: 7, row: '' }, { tag: 'button', role: 'button', name: 'x', row: 'y', extra: 1 }, { tag: 'button', role: 'button', name: 'x'.repeat(201), row: '' }]) {
      expect(parseStepTarget(bad)).toBeUndefined()
    }
  })
})

describe('the run', () => {
  it('probes the page again when the user clicks, so the card shows the rows as they are then', async () => {
    const { learning, request, state, sent } = await watched()
    expect(state().suggestion).toMatchObject({ remaining: 38 })
    // Between the offer and the click, row 30 became a "Delete" row and the rows after it are no longer alike.
    describe_ = (row, position) => row === 30 && position === 1 ? { ...defaultTarget(row, position), name: 'Delete' } : defaultTarget(row, position)
    request.mockResolvedValueOnce(completed(27))
    await learning.runSuggestion('s1')
    expect(sent()).toEqual([{ sessionId: 's1', steps: program(27), rowSteps: 3 }])
    // Nothing left that looks like the user's rows: nothing is sent.
    const gone = await watched()
    describe_ = () => undefined
    await expect(gone.learning.runSuggestion('s1')).rejects.toThrow(/rows changed since the offer/)
    expect(gone.sent()).toEqual([])
    // Shrunk to one program: the ordinary single run.
    describe_ = defaultTarget
    const shrunk = await watched()
    available = 5
    await shrunk.learning.runSuggestion('s1')
    expect(shrunk.sent()).toEqual([{ sessionId: 's1', steps: program(5, 3, false) }])
  })

  it('lets exactly that program raise a series card: once, for that session, on the tab and document the user demonstrated on, only while the run is in flight', async () => {
    const { learning, request } = await watched()
    const steps = program(38)
    // Nothing is armed before the user asks.
    expect(learning.claimSeries('s1', steps, 7, 'doc-1')).toBe(false)
    let release!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const running = learning.runSuggestion('s1')
    await vi.waitFor(() => { expect(request).toHaveBeenCalled() })
    // Another session, another tab (the session's controlled tab is not the one the user showed), another document.
    expect(learning.claimSeries('s2', steps, 7, 'doc-1')).toBe(false)
    expect(learning.claimSeries(undefined, steps, 7, 'doc-1')).toBe(false)
    expect(learning.claimSeries('s1', steps, 9, 'doc-1')).toBe(false)
    expect(learning.claimSeries('s1', steps, 7, 'doc-2')).toBe(false)
    expect(learning.claimSeries('s1', steps, undefined, undefined)).toBe(false)
    // A changed step, a changed element description, more rows, fewer rows.
    expect(learning.claimSeries('s1', [...steps.slice(0, -1), { ...steps.at(-1)!, args: { selector: '#delete-all' } }], 7, 'doc-1')).toBe(false)
    expect(learning.claimSeries('s1', [...steps.slice(0, -1), { ...steps.at(-1)!, target: { ...steps.at(-1)!.target!, name: 'Delete' } }], 7, 'doc-1')).toBe(false)
    expect(learning.claimSeries('s1', [...steps, ...program(1, 41)], 7, 'doc-1')).toBe(false)
    expect(learning.claimSeries('s1', steps.slice(0, -3), 7, 'doc-1')).toBe(false)
    expect(learning.claimSeries('s1', steps, 7, 'doc-1')).toBe(true)
    expect(learning.claimSeries('s1', steps, 7, 'doc-1')).toBe(false)
    release(completed(38))
    await running
    expect(learning.claimSeries('s1', steps, 7, 'doc-1')).toBe(false)
  })

  it('disarms when the run ends without the card having been raised, and on the kill switch (which also ends the wait)', async () => {
    const failed = await watched()
    failed.request.mockRejectedValueOnce(new Error('bridge gone'))
    await expect(failed.learning.runSuggestion('s1')).rejects.toThrow()
    expect(failed.learning.claimSeries('s1', program(38), 7, 'doc-1')).toBe(false)
    // The bridge never answers once the kill switch dropped it: the run must not stay armed for its 30-minute timeout.
    const killed = await watched()
    killed.request.mockImplementationOnce(() => new Promise(() => {}))
    const running = killed.learning.runSuggestion('s1')
    await vi.waitFor(() => { expect(killed.request).toHaveBeenCalled() })
    killed.learning.disarmSeries()
    await expect(running).rejects.toThrow(/Stopped/)
    expect(killed.learning.claimSeries('s1', program(38), 7, 'doc-1')).toBe(false)
  })

  it('refuses when the watched tab left the site', async () => {
    const { learning, sent } = await watched()
    tabUrl = 'https://other.example/people'
    await expect(learning.runSuggestion('s1')).rejects.toThrow(/left the page/)
    expect(sent()).toEqual([])
  })
})

describe('continuing a run that stopped part-way', () => {
  it('offers the rows that are left and continues from the page as it is now, with a new approval', async () => {
    const { learning, request, state, sent } = await watched()
    // Row 21 of 38 was relabelled after the card: the run stopped after 20 rows.
    request.mockResolvedValueOnce(stopped(20, 38))
    const first = await learning.runSuggestion('s1') as { text: string }
    expect(first.text).toMatch(/^Stopped after 20 of 38 rows\. Row 21: it no longer looks like the rows you approved \(was “Invite”, now “Delete”\)/)
    expect(state().resume).toEqual({ rows: 18 })
    // The user put the row right and continues: the next run starts at that row (table row 23), all 18 rows, a fresh series card.
    request.mockResolvedValueOnce(completed(18))
    await learning.continueRemaining('s1')
    expect(sent().at(-1)).toEqual({ sessionId: 's1', steps: program(18, 23), rowSteps: 3 })
    expect(state().resume).toBeNull()
    await expect(learning.continueRemaining('s1')).rejects.toThrow(/nothing to continue/)
  })

  it('passes over the row that no longer looks like the others, says so, and never runs on the old approval', async () => {
    const { learning, request, state, sent } = await watched()
    request.mockResolvedValueOnce(stopped(20, 38))
    await learning.runSuggestion('s1')
    // The row is still a "Delete" row.
    describe_ = (row, position) => row === 23 && position === 1 ? { ...defaultTarget(row, position), name: 'Delete' } : defaultTarget(row, position)
    request.mockResolvedValueOnce(completed(17))
    const result = await learning.continueRemaining('s1') as { text: string }
    expect(sent().at(-1)).toEqual({ sessionId: 's1', steps: program(17, 24), rowSteps: 3 })
    expect(result.text).toMatch(/^One row was passed over: it no longer looks like the rows you did\./)
    // The continuation is its own request: only its own program can raise a card.
    expect(learning.claimSeries('s1', program(18, 23), 7, 'doc-1')).toBe(false)
    expect(state().resume).toBeNull()
  })

  it('offers nothing when the card was denied, when the run finished, after a new demonstration, or after the kill switch', async () => {
    const denied = await watched()
    denied.request.mockResolvedValueOnce(answer({ report: { status: 'failed', steps: [], rows: { done: 0, total: 38, steps: 114 } }, text: 'Not run: The user denied the browser program..' }))
    await denied.learning.runSuggestion('s1')
    expect(denied.state().resume).toBeNull()
    const done = await watched()
    done.request.mockResolvedValueOnce(completed(38))
    await done.learning.runSuggestion('s1')
    expect(done.state().resume).toBeNull()
    const again = await watched()
    again.request.mockResolvedValueOnce(stopped(20, 38))
    await again.learning.runSuggestion('s1')
    expect(again.state().resume).toEqual({ rows: 18 })
    await again.learning.startWatching(7)
    expect(again.state().resume).toBeNull()
    const killed = await watched()
    killed.request.mockResolvedValueOnce(stopped(20, 38))
    await killed.learning.runSuggestion('s1')
    killed.learning.disarmSeries()
    expect(killed.state().resume).toBeNull()
    // Nothing left that looks like the user's rows: say so, run nothing.
    const none = await watched()
    none.request.mockResolvedValueOnce(stopped(20, 38))
    await none.learning.runSuggestion('s1')
    describe_ = () => undefined
    await expect(none.learning.continueRemaining('s1')).rejects.toThrow(/no longer look like the ones you did/)
    expect(none.sent()).toHaveLength(1)
  })
})
