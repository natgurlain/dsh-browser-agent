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
 * beyond its own batch, and every step carries `target`: what its element
 * looked like (tag, role, accessible name, the row's identity). The card
 * states the true total, shows one line per row in a person's words, and
 * binds every step and target; it is answered in the browser only. Each later
 * batch arrives as its own `browser_run` call with `continues: <series id>`;
 * it raises no card and is accepted only when
 *
 * - every step of the batch before it was reported done (`settle`): a failed,
 *   denied, cancelled or expired step ends the series and its batch;
 * - its steps and targets hash to exactly the next approved ones;
 * - it is the same session and tab, on the same document and path the card
 *   was approved on (any top-frame navigation of the tab ends the series; so
 *   does a path change without a new document);
 * - no other tool call that may change the page reached that tab or session
 *   in between (`endsSeries`), the user did not take over, and the kill
 *   switch was not used;
 * - it is within the series' lifetime, which also caps every batch.
 *
 * Just before a series step acts, the content script compares its element
 * with the step's target; any difference fails the step (and so ends the
 * series) with nothing done to the page. Anything else revokes the series;
 * there is no fallback card. A series is accepted only when this extension
 * itself built it from the user's demonstration, on the tab and document the
 * user demonstrated on (`allowSeries`), holds only selector-targeted
 * click/type/select steps, and at most MAX_SERIES_STEPS of them. Each batch is
 * a program grant, so every step keeps the checks above, and the continuation
 * call waits at the pause gate like any call.
 *
 * @module
 */

import { approvalBinding, canonicalJson, sha256Hex } from '../security/payload-binding.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { frameDocumentKey, frameOrigin, type TabFrame } from './frames.ts'
import type { ToolCall } from './tools.ts'
import { httpOrigin, isRecord } from '../security/web-url.ts'
import { cancelledAnswer, notApprovedAnswer, type SettledAnswer } from './answers.ts'
import { getUiLocale } from '../i18n.ts'
import { parseStepTarget, type StepTarget } from '../shared/repetition.ts'

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

/** Tools that only look: a call to one of them leaves a series' page as its card showed it. */
const SERIES_NEUTRAL_TOOLS: ReadonlySet<string> = new Set([
  'browser_snapshot', 'browser_get_text', 'browser_wait', 'browser_screenshot', 'browser_pdf_text', 'browser_list_tabs', 'browser_watches',
])

/**
 * Whether a tool call that is not a step of a program may have changed the
 * page (or is about to): such a call ends a series on its tab or in its
 * session, because the rows are no longer known to be what the card showed.
 */
export function endsSeries(call: Pick<ToolCall, 'name' | 'args' | 'program'>): boolean {
  if (call.program !== undefined) return false
  if (call.name === 'browser_run') return call.args.continues === undefined
  return !SERIES_NEUTRAL_TOOLS.has(call.name)
}

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
  /** A series step only: what its element looked like when the offer was built. */
  target?: StepTarget
}

/** Keys that name an object's prototype machinery: never a tool argument. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Whether any object inside `value` has an own key from {@link UNSAFE_KEYS}. */
export function hasUnsafeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.keys(value).some((key) => UNSAFE_KEYS.has(key) || hasUnsafeKey((value as Record<string, unknown>)[key]))
}

/**
 * Validate a `browser_run` call's steps (the bridge validated them too).
 * @param raw - the `steps` argument.
 * @param targets - keep each step's `target` (a series); otherwise it is dropped.
 * @returns the steps, or an error message.
 */
export function parseProgramSteps(raw: unknown, targets = false): ProgramStepInput[] | string {
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
    // The card shows these as JSON and hashes them: a key the two could disagree on is refused.
    if (hasUnsafeKey(args) || hasUnsafeKey(entry.expect)) return `browser_run step ${String(index + 1)} has an argument name a program cannot carry.`
    const target = targets ? parseStepTarget(entry.target) : undefined
    steps.push({ tool: entry.tool, args, ...(entry.expect === undefined ? {} : { expect: entry.expect as Record<string, unknown> }), ...(target === undefined ? {} : { target }) })
  }
  return steps
}

/** Whether a step is one a series may hold: selector-targeted click/type/select with its element's description. */
function seriesStep(step: ProgramStepInput): boolean {
  return SERIES_STEP_TOOLS.has(step.tool) && step.expect === undefined && step.target !== undefined
    && typeof step.args.selector === 'string' && step.args.selector !== '' && step.args.index === undefined
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
    if (!isRecord(entry) || typeof entry.tool !== 'string' || !isRecord(entry.args) || entry.expect !== undefined || hasUnsafeKey(entry.args)) return 'browser_run series has an invalid step.'
    const target = parseStepTarget(entry.target)
    later.push({ tool: entry.tool, args: entry.args, ...(target === undefined ? {} : { target }) })
  }
  if (first.length % rowSteps !== 0 || later.length % rowSteps !== 0) return 'A browser_run series holds whole repetitions only.'
  if (![...first, ...later].every(seriesStep)) return 'A browser_run series holds only selector-targeted click, type and select steps, each with its element\'s description.'
  return { rowSteps, later }
}

/** Hash of one step as executed: tool name plus canonical arguments. */
export function stepDigest(tool: string, args: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ tool, args }))
}

/** Hash of one series step as approved: tool, arguments, and what its element must look like. */
function seriesStepDigest(step: ProgramStepInput): string {
  return sha256Hex(canonicalJson({ tool: step.tool, args: step.args, target: step.target ?? null }))
}

/** Origin and path of a page: what a series stays on (query and fragment may change). */
export function pageLocation(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return undefined
  }
}

const quoted = (text: string): string => `“${text}”`

/** One row of a series as a person reads it: "Type “Email 3” ← “Linus” → Click “Invite” — Linus". */
export function describeSeriesRow(steps: readonly ProgramStepInput[], zh = getUiLocale() === 'zh'): string {
  const verbs = zh
    ? { browser_click: '点击', browser_type: '输入', browser_select: '选择' }
    : { browser_click: 'Click', browser_type: 'Type into', browser_select: 'Select in' }
  const parts = steps.map((step) => {
    const name = step.target === undefined ? '' : step.target.name !== '' ? step.target.name : step.target.role !== '' ? step.target.role : step.target.tag
    const value = step.tool === 'browser_type' ? step.args.text : step.tool === 'browser_select' ? step.args.value : undefined
    return `${verbs[step.tool as keyof typeof verbs] ?? step.tool} ${quoted(name)}${typeof value === 'string' ? ` ← ${quoted(value)}` : ''}`
  })
  const row = steps.find((step) => step.target !== undefined && step.target.row !== '')?.target?.row
  return `${parts.join(' → ')}${row === undefined ? '' : ` — ${row}`}`
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
  const where = origins.join(', ') || 'the controlled tab'
  const still = 'Steps that site rules, a tainted session, or strict mode protect still ask on their own.'
  if (series !== undefined) return seriesApprovalPrompt(steps, series, origins, top)
  return {
    kind: 'action',
    action: 'browser_run',
    summary: `Run a ${String(steps.length)}-step browser program on ${where} without asking between ordinary steps. ${still}`,
    origins,
    canTrust: false,
    details: steps.map((step, index) => ({
      kind: 'text' as const,
      label: `Step ${String(index + 1)}: ${step.tool}`,
      masked: false,
      value: JSON.stringify(step.expect === undefined ? step.args : { ...step.args, expect: step.expect }, null, 2),
    })),
    binding: approvalBinding({
      action: 'browser_run',
      args: { steps },
      origins,
      ...(top === undefined ? {} : { frameId: 0, documentKey: frameDocumentKey(top) }),
    }),
  }
}

/**
 * The single card of a series. It covers every batch, so it states the whole
 * run: the true total of rows and steps, and one line per row in the words a
 * person would use (what is done to which element, and which row). Each row's
 * raw steps (selectors, values, the element description that is checked again
 * before the step) sit behind it. The binding covers every step and every
 * element description. Answered in the browser only: no other surface shows
 * the rows.
 */
function seriesApprovalPrompt(steps: ProgramStepInput[], series: ProgramSeriesInput, origins: string[], top: TabFrame | undefined): ApprovalPrompt {
  const zh = getUiLocale() === 'zh'
  const all = [...steps, ...series.later]
  const rows = all.length / series.rowSteps
  const where = origins.join(', ') || (zh ? '受控标签页' : 'the controlled tab')
  return {
    kind: 'action',
    action: 'browser_run',
    summary: zh
      ? `在 ${where} 的 ${String(rows)} 行上重复同一个 ${String(series.rowSteps)} 步操作：共 ${String(all.length)} 步，普通步骤之间不再询问。按每批最多 ${String(MAX_PROGRAM_STEPS)} 步执行；任何一步失败，或某一行与下面列出的不再一致，就会停止；绝不会执行此处未列出的步骤。受站点规则、受污染会话或严格模式保护的步骤仍会单独询问。`
      : `Repeat a ${String(series.rowSteps)}-step action on ${String(rows)} rows: ${String(all.length)} steps in total on ${where}, without asking between ordinary steps. It runs in batches of up to ${String(MAX_PROGRAM_STEPS)} steps, stops at the first step that fails or the first row that no longer looks as listed below, and never does more than the steps listed here. Steps that site rules, a tainted session, or strict mode protect still ask on their own.`,
    origins,
    canTrust: false,
    browserOnly: true,
    details: [{
      kind: 'rows' as const,
      rows: Array.from({ length: rows }, (_unused, row) => {
        const own = all.slice(row * series.rowSteps, (row + 1) * series.rowSteps)
        return { label: describeSeriesRow(own, zh), payload: JSON.stringify(own.map((step) => ({ tool: step.tool, args: step.args, target: step.target })), null, 2) }
      }),
    }],
    binding: approvalBinding({
      action: 'browser_run',
      args: { steps, series },
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
  /** The series this batch belongs to (every batch of a series, the last included). */
  series?: string
  /** A series batch: steps whose outcome was reported as done. The next step is claimable only when this equals `next`. */
  settled: number
  /** A series batch: what each step's element must look like just before it runs. */
  targets?: Array<StepTarget | undefined>
}

/** The page a series was approved on. */
export interface SeriesPage {
  /** The top document (frameDocumentKey). */
  documentKey: string
  /** Its origin and path ({@link pageLocation}). */
  location: string
}

/** An approved series: its batches still to start, and the one in flight. */
interface SeriesGrant {
  sessionId: string | undefined
  tabId?: number
  origins: Set<string>
  rowSteps: number
  page: SeriesPage
  /** The approved steps no batch has started yet, in order. */
  later: Array<{ digest: string; approved: string; target: StepTarget | undefined }>
  /** The batch in flight; the next one starts only once its last step settled as done. */
  running?: string
  expiresAt: number
}

/** What an approved program covers for one claimed step. */
export interface ProgramCover {
  covers(prompt: ApprovalPrompt): boolean
  /** A series step: what its element must still look like, checked in the page just before it runs. */
  target?: StepTarget
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
  approve(id: string, sessionId: string | undefined, steps: ProgramStepInput[], origins: string[], tabId?: number, series?: ProgramSeriesInput, page?: SeriesPage): void {
    this.sweep()
    if (series !== undefined && page === undefined) return
    this.grants.set(id, {
      sessionId,
      ...(tabId === undefined ? {} : { tabId }),
      navigated: false,
      digests: steps.map((step) => stepDigest(step.tool, step.args)),
      origins: new Set(origins),
      next: 0,
      settled: 0,
      expiresAt: this.now() + PROGRAM_GRANT_TTL_MS,
      ...(series === undefined ? {} : { series: id, targets: steps.map((step) => step.target) }),
    })
    if (series === undefined || page === undefined) return
    this.series.set(id, {
      sessionId,
      ...(tabId === undefined ? {} : { tabId }),
      origins: new Set(origins),
      rowSteps: series.rowSteps,
      page,
      later: series.later.map((step) => ({ digest: stepDigest(step.tool, step.args), approved: seriesStepDigest(step), target: step.target })),
      running: id,
      expiresAt: this.now() + SERIES_GRANT_TTL_MS,
    })
  }

  /**
   * Start the next batch of an approved series under `id`, with no new card.
   * False (and the series revoked, with any batch still in flight) unless the
   * batch before it ran to its last step with every step reported done, and
   * these are exactly the next approved steps (element descriptions
   * included), in whole repetitions, for the same session and tab, on the
   * document and path the card was approved on.
   */
  continueSeries(seriesId: string, id: string, sessionId: string | undefined, steps: ProgramStepInput[], tabId: number | undefined, page: SeriesPage | undefined): boolean {
    this.sweep()
    const series = this.series.get(seriesId)
    if (series === undefined) return false
    const valid = series.sessionId === sessionId
      && (series.tabId === undefined || series.tabId === tabId)
      && page !== undefined && page.documentKey === series.page.documentKey && page.location === series.page.location
      && series.running === undefined
      && steps.length > 0 && steps.length <= MAX_PROGRAM_STEPS && steps.length <= series.later.length
      && steps.length % series.rowSteps === 0
      && steps.every((step, index) => seriesStep(step) && series.later[index]!.approved === seriesStepDigest(step))
    if (!valid) {
      this.revokeSeries(seriesId)
      return false
    }
    const batch = series.later.splice(0, steps.length)
    series.running = id
    this.grants.set(id, {
      sessionId,
      ...(series.tabId === undefined ? {} : { tabId: series.tabId }),
      navigated: false,
      digests: batch.map((step) => step.digest),
      targets: batch.map((step) => step.target),
      origins: series.origins,
      next: 0,
      settled: 0,
      // A batch never outlives the series it belongs to.
      expiresAt: Math.min(this.now() + PROGRAM_GRANT_TTL_MS, series.expiresAt),
      series: seriesId,
    })
    return true
  }

  /**
   * Claim the program step a call says it is. Undefined (and the grant
   * revoked) when it is not the next approved step of that session's program.
   * A series step must also follow a step that was reported done, on the
   * path the series was approved on.
   * @param url - the tab's current URL, when known.
   */
  claim(call: Pick<ToolCall, 'name' | 'args' | 'sessionId' | 'program'>, tabId?: number, url?: string): ProgramCover | undefined {
    const ref = call.program
    if (ref === undefined) return undefined
    const grant = this.grants.get(ref.id)
    if (grant === undefined) return undefined
    const series = grant.series === undefined ? undefined : this.series.get(grant.series)
    const valid = grant.expiresAt > this.now()
      && grant.sessionId === call.sessionId
      && (grant.tabId === undefined || grant.tabId === tabId)
      && ref.step === grant.next
      && grant.digests[ref.step] === stepDigest(call.name, call.args)
      && (grant.series === undefined || (
        series !== undefined && series.expiresAt > this.now() && series.running === ref.id
        && grant.settled === grant.next
        && (url === undefined || pageLocation(url) === series.page.location)
      ))
    if (!valid) {
      this.grants.delete(ref.id)
      // A batch that broke its approval ends the whole series.
      if (grant.series !== undefined) this.revokeSeries(grant.series)
      return undefined
    }
    grant.next += 1
    // A series batch stays until its last step's outcome is known (settle).
    if (grant.next >= grant.digests.length && grant.series === undefined) this.grants.delete(ref.id)
    const origins = grant.origins
    const expiresAt = grant.expiresAt
    const target = grant.targets?.[ref.step]
    // An index names an element of a snapshot; after a navigation that is a page the card never showed.
    const indexAfterNavigation = grant.navigated && usesSnapshotIndex(call.args)
    if (NAVIGATION_STEP_TOOLS.has(call.name)) grant.navigated = true
    return {
      // The approval's lifetime also ends a step that waited (a pause, a card) past it.
      covers: (prompt) => this.now() < expiresAt && !indexAfterNavigation && ordinaryActionCard(prompt) && prompt.origins.length > 0 && prompt.origins.every((origin) => origins.has(origin)),
      ...(target === undefined ? {} : { target }),
    }
  }

  /**
   * Report how a claimed step ended. Only a step that was done lets a series
   * go on: the next step, and after the last step the next batch. A failed,
   * denied, cancelled or expired step ends the series and its batch.
   */
  settle(ref: { id: string; step: number }, ok: boolean): void {
    const grant = this.grants.get(ref.id)
    if (grant === undefined || grant.series === undefined) return
    if (!ok || ref.step !== grant.settled || ref.step >= grant.next) {
      this.revokeSeries(grant.series)
      return
    }
    grant.settled += 1
    if (grant.settled < grant.digests.length) return
    this.grants.delete(ref.id)
    const series = this.series.get(grant.series)
    if (series === undefined || series.running !== ref.id) return
    delete series.running
    if (series.later.length === 0) this.series.delete(grant.series)
  }

  /** End a series: its remaining batches and the batch in flight. */
  revokeSeries(seriesId: string): void {
    this.series.delete(seriesId)
    for (const [id, grant] of this.grants) if (grant.series === seriesId) this.grants.delete(id)
  }

  /** End every series matching `match` (all of them when absent). */
  private revokeSeriesWhere(match: (series: SeriesGrant) => boolean): void {
    for (const [id, series] of [...this.series]) if (match(series)) this.revokeSeries(id)
  }

  /**
   * The top frame of a tab navigated. A new document ends the tab's series; a
   * same-document update (history API, fragment) ends it when the path changed.
   */
  onTopFrameNavigation(tabId: number, url: string | undefined, sameDocument: boolean): void {
    this.revokeSeriesWhere((series) => series.tabId === tabId && (!sameDocument || pageLocation(url) !== series.page.location))
  }

  /**
   * A tool call that may change the page, and is not a step of the series,
   * arrived for its session or its tab ({@link endsSeries}): the page is no
   * longer known to be what the card showed.
   */
  onForeignAction(sessionId: string | undefined, tabId: number | undefined): void {
    this.revokeSeriesWhere((series) => series.sessionId === sessionId || (tabId !== undefined && series.tabId === tabId))
  }

  /** The user took over the page: nothing continues blind afterwards. */
  onTakeOver(): void {
    this.revokeSeriesWhere(() => true)
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
    for (const [id, series] of [...this.series]) if (series.expiresAt <= now) this.revokeSeries(id)
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
   * Whether this exact series (all its steps and element descriptions, in
   * order) is one the extension itself built for the user's "do the remaining
   * N" request in this session, and `tabId` / `documentKey` are the tab and
   * document the user demonstrated on. One-shot. Absent: no series is ever accepted.
   */
  allowSeries?: (sessionId: string | undefined, steps: ProgramStepInput[], tabId: number, documentKey: string | undefined) => boolean
  /** Told when a batch continued an approved series instead of raising a card (audit). */
  onContinued?: () => void
}

/** Why a continuation was refused, in the user's terms (the panel shows it). */
export const SERIES_ENDED = 'the approval no longer applies: the page was reloaded or left, something else acted on it, you took over, or too much time passed. Nothing more was done.'

/** The wire answer shape (structurally a ToolAnswer). */
export type ProgramAnswer = SettledAnswer

/**
 * Show the program card and, once approved for this exact page, record the
 * grant its steps will claim.
 */
export async function approveProgram(call: ToolCall, deps: ProgramApprovalDeps): Promise<ProgramAnswer> {
  const inSeries = call.args.continues !== undefined || call.args.series !== undefined
  const steps = parseProgramSteps(call.args.steps, inSeries)
  if (typeof steps === 'string') return { ok: false, error: { code: 'bad-args', message: steps } }
  if (call.args.continues !== undefined && call.args.series !== undefined) return { ok: false, error: { code: 'bad-args', message: 'browser_run cannot both start and continue a series.' } }
  let series: ProgramSeriesInput | undefined
  if (call.args.series !== undefined) {
    const parsed = parseProgramSeries(call.args.series, steps)
    if (typeof parsed === 'string') return { ok: false, error: { code: 'bad-args', message: parsed } }
    series = parsed
  }
  const tab = await deps.resolveTab()
  if ('ok' in tab) return { ok: false, error: { code: 'no-active-tab', message: tab.error?.message ?? 'No controlled tab for the program.' } }
  if (tab.id === undefined) return { ok: false, error: { code: 'no-active-tab', message: 'No controlled tab for the program.' } }
  if (deps.signal.aborted) return cancelledAnswer()
  const frames = await deps.listFrames(tab.id, tab.url)
  const top = frames.find((frame) => frame.frameId === 0)
  const location = top === undefined ? undefined : pageLocation(top.url)
  const page: SeriesPage | undefined = top === undefined || location === undefined ? undefined : { documentKey: frameDocumentKey(top), location }
  if (call.args.continues !== undefined) {
    // A later batch of a series: no card, and nothing beyond what its card approved.
    if (deps.signal.aborted) return cancelledAnswer()
    const continued = typeof call.args.continues === 'string'
      && deps.grants.continueSeries(call.args.continues, call.id, call.sessionId, steps, tab.id, page)
    if (!continued) {
      return { ok: false, error: { code: 'action-failed', message: SERIES_ENDED } }
    }
    deps.onContinued?.()
    return { ok: true, result: { text: `Next ${String(steps.length)} steps of the approved program.`, programId: call.id } }
  }
  // A series runs only as the extension built it, on the tab and document the user demonstrated on.
  if (series !== undefined && (page === undefined || deps.allowSeries?.(call.sessionId, [...steps, ...series.later], tab.id, page.documentKey) !== true)) {
    return { ok: false, error: { code: 'bad-args', message: 'A browser_run series runs only for the user\'s own "Do the remaining" request, on the tab it was shown on.' } }
  }
  const prompt = programApprovalPrompt(steps, frames, series)
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
  deps.grants.approve(call.id, call.sessionId, steps, prompt.origins, tab.id, series, page)
  return { ok: true, result: { text: `Program of ${String(steps.length + (series?.later.length ?? 0))} steps approved.`, programId: call.id } }
}
