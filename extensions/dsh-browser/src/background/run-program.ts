/**
 * `browser_run` on the extension side: the one approval card for a whole
 * program, and the grants that let that card stand in for a step's ordinary
 * action card.
 *
 * The bridge sends the program once as a `browser_run` call (shown as one
 * card with every step's full payload, bound by a hash of the program, the
 * page's origins, and its document), then sends each step as an ordinary
 * `tool.call` tagged with `{ program: { id, step } }`. Every step still runs
 * the whole dispatch chain (pause gate, site policy, taint, kill switch,
 * commit gate, audit). The program approval covers a step's card only when:
 *
 * - the step is the next unexecuted step of a program this session approved,
 *   and its tool name and arguments hash to the approved step;
 * - the card is an ordinary action card: not forced by site policy, taint, or
 *   strict mode, not per-call-only, not developer tools, no risky URL, no
 *   browser permission request;
 * - every origin on the card was named on the program card;
 * - the step runs on the tab the program was approved on;
 * - once the program has navigated, the step targets its element by selector
 *   (or locator), never by a raw snapshot index from a page the card never
 *   showed.
 *
 * Anything else asks as usual. Reads follow the normal read rules. A step that
 * does not match its program revokes the program's grant.
 *
 * Series ("do the remaining N" over more rows than one program holds): the
 * first `browser_run` call carries `series: { rowSteps, later }`, every step
 * beyond its own batch. Its card states the true total (rows and steps),
 * lists every step of every batch, and binds them all. Each later batch then
 * arrives as its own `browser_run` call with `continues: <series id>`; it
 * raises no card and is accepted only when the batch before it ran to its
 * last step and its steps hash to exactly the next approved ones, on the same
 * tab and origin, in the same session, within the series' lifetime. Anything
 * else revokes the series; there is no fallback card. A series is accepted
 * only when this extension itself built it from the user's demonstration
 * (`allowSeries`), holds only selector-targeted click/type/select steps, and
 * at most MAX_SERIES_STEPS of them. Each batch is an ordinary program grant,
 * so every step keeps the checks above, and the continuation call waits at the
 * pause gate like any call: pause, take over and the kill switch act between
 * batches and before every step.
 *
 * @module
 */

import { approvalBinding, canonicalJson, sha256Hex } from '../security/payload-binding.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { frameDocumentKey, frameOrigin, type TabFrame } from './frames.ts'
import type { ToolCall } from './tools.ts'
import { httpOrigin, isRecord } from '../security/web-url.ts'
import { cancelledAnswer, notApprovedAnswer, type SettledAnswer } from './answers.ts'

/** Mirrors the bridge's PROGRAM_STEP_TOOLS (a spec keeps the two equal). */
export const PROGRAM_STEP_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_select',
  'browser_hover',
  'browser_drag',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_wait',
  'browser_snapshot',
  'browser_get_text',
  'browser_dialog',
])

export const MAX_PROGRAM_STEPS = 25
/** How long an approved program may take to run. */
export const PROGRAM_GRANT_TTL_MS = 15 * 60_000
/** Most steps one series (one card, several batches) may hold in total; mirrors the bridge. */
export const MAX_SERIES_STEPS = 250
/** How long an approved series may take from its card to its last batch's start. */
export const SERIES_GRANT_TTL_MS = 30 * 60_000
/** Mirrors the bridge's SERIES_STEP_TOOLS: selector-targeted input only. */
export const SERIES_STEP_TOOLS: ReadonlySet<string> = new Set(['browser_click', 'browser_type', 'browser_select'])

/** The rest of a series, as the first `browser_run` call carries it. */
export interface ProgramSeriesInput {
  /** Steps per repetition (row); every batch holds whole repetitions. */
  rowSteps: number
  /** Every step after the first batch, in order. */
  later: ProgramStepInput[]
}

/** One step as the extension receives it. */
export interface ProgramStepInput {
  tool: string
  args: Record<string, unknown>
  expect?: Record<string, unknown>
}

/**
 * Validate a `browser_run` call's steps (the bridge validated them too).
 * @returns the steps, or an error message.
 */
export function parseProgramSteps(raw: unknown): ProgramStepInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'browser_run needs a non-empty steps array.'
  if (raw.length > MAX_PROGRAM_STEPS) return `browser_run holds at most ${String(MAX_PROGRAM_STEPS)} steps.`
  const steps: ProgramStepInput[] = []
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.tool !== 'string' || !PROGRAM_STEP_TOOLS.has(entry.tool)) {
      return `browser_run step ${String(index + 1)} names a tool a program cannot run.`
    }
    const args = entry.args ?? {}
    if (!isRecord(args)) return `browser_run step ${String(index + 1)} has invalid args.`
    if (entry.expect !== undefined && !isRecord(entry.expect)) return `browser_run step ${String(index + 1)} has an invalid expect.`
    steps.push({ tool: entry.tool, args, ...(entry.expect === undefined ? {} : { expect: entry.expect as Record<string, unknown> }) })
  }
  return steps
}

/**
 * Validate the `series` of a first `browser_run` call against its first batch.
 * @returns the series, or an error message.
 */
export function parseProgramSeries(raw: unknown, first: ProgramStepInput[]): ProgramSeriesInput | string {
  if (!isRecord(raw)) return 'browser_run series must be an object.'
  const rowSteps = raw.rowSteps
  if (typeof rowSteps !== 'number' || !Number.isInteger(rowSteps) || rowSteps < 1 || rowSteps > MAX_PROGRAM_STEPS) return 'browser_run series needs rowSteps.'
  if (!Array.isArray(raw.later) || raw.later.length === 0) return 'browser_run series needs its later steps.'
  if (first.length + raw.later.length > MAX_SERIES_STEPS) return `A browser_run series holds at most ${String(MAX_SERIES_STEPS)} steps in total.`
  const later: ProgramStepInput[] = []
  for (const entry of raw.later as unknown[]) {
    if (!isRecord(entry) || typeof entry.tool !== 'string' || !isRecord(entry.args) || entry.expect !== undefined) return 'browser_run series has an invalid step.'
    later.push({ tool: entry.tool, args: entry.args })
  }
  if (first.length % rowSteps !== 0 || later.length % rowSteps !== 0) return 'A browser_run series holds whole repetitions only.'
  for (const step of [...first, ...later]) {
    if (!SERIES_STEP_TOOLS.has(step.tool) || step.expect !== undefined || typeof step.args.selector !== 'string' || step.args.selector === '' || step.args.index !== undefined) {
      return 'A browser_run series holds only selector-targeted click, type and select steps.'
    }
  }
  return { rowSteps, later }
}

/** Hash of one step as executed: tool name plus canonical arguments. */
export function stepDigest(tool: string, args: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ tool, args }))
}

/**
 * Origins a program may act on: the controlled page's, plus every page a
 * navigate step names (shown on the card).
 */
export function programOrigins(steps: ProgramStepInput[], frames: TabFrame[]): string[] {
  const origins = new Set<string>()
  const top = frames.find((frame) => frame.frameId === 0)
  if (top !== undefined) origins.add(frameOrigin(top))
  for (const step of steps) {
    if (step.tool !== 'browser_navigate') continue
    const origin = httpOrigin(step.args.url)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins]
}

/**
 * The single card for a whole program. Every step's full payload is shown
 * verbatim, one detail per step; the binding covers the steps, the origins,
 * and the controlled page's document.
 */
export function programApprovalPrompt(steps: ProgramStepInput[], frames: TabFrame[], series?: ProgramSeriesInput): ApprovalPrompt {
  const origins = programOrigins(steps, frames)
  const top = frames.find((frame) => frame.frameId === 0)
  // A series card covers every batch: it states and lists the whole run.
  const all = series === undefined ? steps : [...steps, ...series.later]
  const where = origins.join(', ') || 'the controlled tab'
  const still = 'Steps that site rules, a tainted session, or strict mode protect still ask on their own.'
  return {
    kind: 'action',
    action: 'browser_run',
    summary: series === undefined
      ? `Run a ${String(steps.length)}-step browser program on ${where} without asking between ordinary steps. ${still}`
      : `Repeat a ${String(series.rowSteps)}-step action on ${String(all.length / series.rowSteps)} rows: ${String(all.length)} steps in total on ${where}, without asking between ordinary steps. It runs in batches of up to ${String(MAX_PROGRAM_STEPS)} steps, stops at the first step that fails, and never does more than the steps listed here. ${still}`,
    origins,
    canTrust: false,
    details: all.map((step, index) => ({
      kind: 'text' as const,
      label: series === undefined
        ? `Step ${String(index + 1)}: ${step.tool}`
        : `Row ${String(Math.floor(index / series.rowSteps) + 1)} of ${String(all.length / series.rowSteps)}, step ${String(index + 1)} of ${String(all.length)}: ${step.tool}`,
      masked: false,
      value: JSON.stringify(step.expect === undefined ? step.args : { ...step.args, expect: step.expect }, null, 2),
    })),
    binding: approvalBinding({
      action: 'browser_run',
      args: series === undefined ? { steps } : { steps, series },
      origins,
      ...(top === undefined ? {} : { frameId: 0, documentKey: frameDocumentKey(top) }),
    }),
  }
}

/** Whether a step targets an element by a raw snapshot index (`index`, or drag's `from`/`to: { index }`). */
export function usesSnapshotIndex(args: Record<string, unknown>): boolean {
  const indexed = (value: unknown): boolean => isRecord(value) && typeof value.index === 'number' && typeof value.selector !== 'string'
  return (typeof args.index === 'number' && typeof args.selector !== 'string') || indexed(args.from) || indexed(args.to)
}

/** Steps after which the page the program card showed is gone. */
const NAVIGATION_STEP_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_back', 'browser_forward', 'browser_reload'])

interface ProgramGrant {
  sessionId: string | undefined
  /** The tab the program was approved on; steps elsewhere revoke the grant. */
  tabId?: number
  /** A navigation step already ran: later index-targeted steps ask. */
  navigated: boolean
  digests: string[]
  origins: Set<string>
  next: number
  expiresAt: number
  /** The series this batch belongs to, while later batches remain. */
  series?: string
}

/** The not-yet-started batches of an approved series. */
interface SeriesGrant {
  sessionId: string | undefined
  tabId?: number
  origins: Set<string>
  rowSteps: number
  /** Digests of the approved steps no batch has claimed yet, in order. */
  digests: string[]
  /** The batch in flight; the next one is accepted only once every step of it was claimed. */
  running?: string
  expiresAt: number
}

/** What an approved program covers for one claimed step. */
export interface ProgramCover {
  covers(prompt: ApprovalPrompt): boolean
}

/** Whether an approval card is an ordinary action card the program card can stand in for. */
export function ordinaryActionCard(prompt: ApprovalPrompt): boolean {
  return prompt.kind === 'action'
    && prompt.forced !== true
    && prompt.perCallOnly !== true
    && prompt.devTools !== true
    && prompt.urlRisk !== true
    && prompt.permission === undefined
}

/** Approved programs of this worker's lifetime (never persisted). */
export class ProgramGrants {
  private readonly grants = new Map<string, ProgramGrant>()
  private readonly series = new Map<string, SeriesGrant>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Record an approved program under its approval call's id.
   * @param series - the later batches the same card approved, if any.
   */
  approve(id: string, sessionId: string | undefined, steps: ProgramStepInput[], origins: string[], tabId?: number, series?: ProgramSeriesInput): void {
    this.sweep()
    this.grants.set(id, {
      sessionId,
      ...(tabId === undefined ? {} : { tabId }),
      navigated: false,
      digests: steps.map((step) => stepDigest(step.tool, step.args)),
      origins: new Set(origins),
      next: 0,
      expiresAt: this.now() + PROGRAM_GRANT_TTL_MS,
      ...(series === undefined ? {} : { series: id }),
    })
    if (series === undefined) return
    this.series.set(id, {
      sessionId,
      ...(tabId === undefined ? {} : { tabId }),
      origins: new Set(origins),
      rowSteps: series.rowSteps,
      digests: series.later.map((step) => stepDigest(step.tool, step.args)),
      running: id,
      expiresAt: this.now() + SERIES_GRANT_TTL_MS,
    })
  }

  /**
   * Start the next batch of an approved series under `id`, with no new card.
   * False (and the series revoked) unless the batch before it was claimed to
   * its last step and these are exactly the next approved steps, in whole
   * repetitions, for the same session and tab, on an origin the card named.
   */
  continueSeries(seriesId: string, id: string, sessionId: string | undefined, steps: ProgramStepInput[], tabId: number | undefined, origin: string | undefined): boolean {
    this.sweep()
    const series = this.series.get(seriesId)
    if (series === undefined) return false
    const valid = series.sessionId === sessionId
      && (series.tabId === undefined || series.tabId === tabId)
      && origin !== undefined && series.origins.has(origin)
      && series.running === undefined
      && steps.length > 0 && steps.length <= MAX_PROGRAM_STEPS && steps.length <= series.digests.length
      && steps.length % series.rowSteps === 0
      && steps.every((step, index) => SERIES_STEP_TOOLS.has(step.tool) && step.expect === undefined && series.digests[index] === stepDigest(step.tool, step.args))
    if (!valid) {
      this.series.delete(seriesId)
      return false
    }
    const digests = series.digests.splice(0, steps.length)
    const last = series.digests.length === 0
    if (last) this.series.delete(seriesId)
    else series.running = id
    this.grants.set(id, {
      sessionId,
      ...(series.tabId === undefined ? {} : { tabId: series.tabId }),
      navigated: false,
      digests,
      origins: series.origins,
      next: 0,
      expiresAt: this.now() + PROGRAM_GRANT_TTL_MS,
      ...(last ? {} : { series: seriesId }),
    })
    return true
  }

  /**
   * Claim the program step a call says it is. Undefined (and the grant
   * revoked) when it is not the next approved step of that session's program.
   */
  claim(call: Pick<ToolCall, 'name' | 'args' | 'sessionId' | 'program'>, tabId?: number): ProgramCover | undefined {
    const ref = call.program
    if (ref === undefined) return undefined
    const grant = this.grants.get(ref.id)
    if (grant === undefined) return undefined
    const valid = grant.expiresAt > this.now()
      && grant.sessionId === call.sessionId
      && (grant.tabId === undefined || grant.tabId === tabId)
      && ref.step === grant.next
      && grant.digests[ref.step] === stepDigest(call.name, call.args)
    if (!valid) {
      this.grants.delete(ref.id)
      // A batch that broke its approval ends the whole series.
      if (grant.series !== undefined) this.series.delete(grant.series)
      return undefined
    }
    grant.next += 1
    if (grant.next >= grant.digests.length) {
      this.grants.delete(ref.id)
      // Every step of this batch was claimed: the series may continue.
      const series = grant.series === undefined ? undefined : this.series.get(grant.series)
      if (series?.running === ref.id) delete series.running
    }
    const origins = grant.origins
    // An index names an element of a snapshot; after a navigation that is a page the card never showed.
    const indexAfterNavigation = grant.navigated && usesSnapshotIndex(call.args)
    if (NAVIGATION_STEP_TOOLS.has(call.name)) grant.navigated = true
    return {
      covers: (prompt) => !indexAfterNavigation && ordinaryActionCard(prompt) && prompt.origins.length > 0 && prompt.origins.every((origin) => origins.has(origin)),
    }
  }

  /** Drop every grant (the kill switch). */
  clear(): void {
    this.grants.clear()
    this.series.clear()
  }

  /** Number of live grants (tests). */
  get size(): number {
    this.sweep()
    return this.grants.size
  }

  /** Number of series with batches still to start (tests). */
  get seriesSize(): number {
    this.sweep()
    return this.series.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id)
    for (const [id, series] of this.series) if (series.expiresAt <= now) this.series.delete(id)
  }
}

/**
 * Let an approved program stand in for a step's ordinary action card.
 * @param cover - the claimed step's cover, if any.
 * @param authorize - the normal authorizer (shows the card).
 * @param onCovered - told when the program approval was used instead of a card.
 */
export function coverByProgram(
  cover: ProgramCover | undefined,
  authorize: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  onCovered: () => void,
): (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization> {
  if (cover === undefined) return authorize
  return async (prompt) => {
    if (cover.covers(prompt)) {
      onCovered()
      return 'approved'
    }
    return authorize(prompt)
  }
}

/** What {@link approveProgram} needs from the background worker. */
export interface ProgramApprovalDeps {
  grants: ProgramGrants
  /** The session's controlled tab, or a failure answer. */
  resolveTab: () => Promise<{ id?: number; url?: string; windowId?: number } | { ok: boolean; error?: { message: string } }>
  listFrames: (tabId: number, url: string | undefined) => Promise<TabFrame[]>
  /** The normal authorizer (gate, card, audit decision). */
  authorize: (prompt: ApprovalPrompt, windowId: number) => Promise<ApprovalAuthorization>
  signal: AbortSignal
  /**
   * Whether this exact series (all its steps, in order) is one the extension
   * itself built for the user's "do the remaining N" request in this session.
   * One-shot. Absent: no series is ever accepted.
   */
  allowSeries?: (sessionId: string | undefined, steps: ProgramStepInput[]) => boolean
  /** Told when a batch continued an approved series instead of raising a card (audit). */
  onContinued?: () => void
}

/** The wire answer shape (structurally a ToolAnswer). */
export type ProgramAnswer = SettledAnswer

/**
 * Show the program card and, once approved for this exact page, record the
 * grant its steps will claim.
 */
export async function approveProgram(call: ToolCall, deps: ProgramApprovalDeps): Promise<ProgramAnswer> {
  const steps = parseProgramSteps(call.args.steps)
  if (typeof steps === 'string') return { ok: false, error: { code: 'bad-args', message: steps } }
  if (call.args.continues !== undefined && call.args.series !== undefined) return { ok: false, error: { code: 'bad-args', message: 'browser_run cannot both start and continue a series.' } }
  let series: ProgramSeriesInput | undefined
  if (call.args.series !== undefined) {
    const parsed = parseProgramSeries(call.args.series, steps)
    if (typeof parsed === 'string') return { ok: false, error: { code: 'bad-args', message: parsed } }
    if (deps.allowSeries?.(call.sessionId, [...steps, ...parsed.later]) !== true) {
      return { ok: false, error: { code: 'bad-args', message: 'A browser_run series runs only for the user\'s own "Do the remaining" request.' } }
    }
    series = parsed
  }
  const tab = await deps.resolveTab()
  if ('ok' in tab) return { ok: false, error: { code: 'no-active-tab', message: tab.error?.message ?? 'No controlled tab for the program.' } }
  if (tab.id === undefined) return { ok: false, error: { code: 'no-active-tab', message: 'No controlled tab for the program.' } }
  if (deps.signal.aborted) return cancelledAnswer()
  if (call.args.continues !== undefined) {
    // A later batch of a series: no card, and nothing beyond what its card approved.
    const top = (await deps.listFrames(tab.id, tab.url)).find((frame) => frame.frameId === 0)
    if (deps.signal.aborted) return cancelledAnswer()
    const continued = typeof call.args.continues === 'string'
      && deps.grants.continueSeries(call.args.continues, call.id, call.sessionId, steps, tab.id, top === undefined ? undefined : frameOrigin(top))
    if (!continued) {
      return { ok: false, error: { code: 'action-failed', message: 'These steps are not the next part of an approved program, so nothing ran. The approval is withdrawn.' } }
    }
    deps.onContinued?.()
    return { ok: true, result: { text: `Next ${String(steps.length)} steps of the approved program.`, programId: call.id } }
  }
  const prompt = programApprovalPrompt(steps, await deps.listFrames(tab.id, tab.url), series)
  const authorization = await deps.authorize(prompt, tab.windowId ?? 0)
  if (deps.signal.aborted) return cancelledAnswer()
  if (authorization !== 'approved') return notApprovedAnswer('The user denied the browser program.', 'The browser program', authorization)
  // The card is bound to the page it was approved on.
  const current = await deps.resolveTab()
  if ('ok' in current || current.id !== tab.id) {
    return { ok: false, error: { code: 'action-failed', message: 'The controlled tab changed while the program card was open.' } }
  }
  const refreshed = programApprovalPrompt(steps, await deps.listFrames(tab.id, current.url), series)
  if (refreshed.binding !== prompt.binding) {
    return { ok: false, error: { code: 'action-failed', message: 'The page changed while the program card was open. Call browser_snapshot again before retrying.' } }
  }
  deps.grants.approve(call.id, call.sessionId, steps, prompt.origins, tab.id, series)
  return { ok: true, result: { text: `Program of ${String(steps.length + (series?.later.length ?? 0))} steps approved.`, programId: call.id } }
}
