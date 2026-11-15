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
 * @module
 */

import { approvalBinding, canonicalJson, sha256Hex } from '../security/payload-binding.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { frameDocumentKey, frameOrigin, type TabFrame } from './frames.ts'
import type { ToolCall } from './tools.ts'
import { httpOrigin, isRecord } from '../security/web-url.ts'

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
export function programApprovalPrompt(steps: ProgramStepInput[], frames: TabFrame[]): ApprovalPrompt {
  const origins = programOrigins(steps, frames)
  const top = frames.find((frame) => frame.frameId === 0)
  return {
    kind: 'action',
    action: 'browser_run',
    summary: `Run a ${String(steps.length)}-step browser program on ${origins.join(', ') || 'the controlled tab'} without asking between ordinary steps. Steps that site rules, a tainted session, or strict mode protect still ask on their own.`,
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
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Record an approved program under its approval call's id. */
  approve(id: string, sessionId: string | undefined, steps: ProgramStepInput[], origins: string[], tabId?: number): void {
    this.sweep()
    this.grants.set(id, {
      sessionId,
      ...(tabId === undefined ? {} : { tabId }),
      navigated: false,
      digests: steps.map((step) => stepDigest(step.tool, step.args)),
      origins: new Set(origins),
      next: 0,
      expiresAt: this.now() + PROGRAM_GRANT_TTL_MS,
    })
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
      return undefined
    }
    grant.next += 1
    if (grant.next >= grant.digests.length) this.grants.delete(ref.id)
    const origins = grant.origins
    // An index names an element of a snapshot; after a navigation that is a page the card never showed.
    const indexAfterNavigation = grant.navigated && usesSnapshotIndex(call.args)
    if (NAVIGATION_STEP_TOOLS.has(call.name)) grant.navigated = true
    return {
      covers: (prompt) => !indexAfterNavigation && ordinaryActionCard(prompt) && prompt.origins.length > 0 && prompt.origins.every((origin) => origins.has(origin)),
    }
  }

  /** Drop every grant (kill switch, bridge loss). */
  clear(): void {
    this.grants.clear()
  }

  /** Number of live grants (tests). */
  get size(): number {
    this.sweep()
    return this.grants.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id)
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
}

/** The wire answer shape (structurally a ToolAnswer). */
export type ProgramAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: 'bad-args' | 'action-failed' | 'timeout' | 'no-active-tab'; message: string } }

const CANCELLED: ProgramAnswer = { ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } }

/**
 * Show the program card and, once approved for this exact page, record the
 * grant its steps will claim.
 */
export async function approveProgram(call: ToolCall, deps: ProgramApprovalDeps): Promise<ProgramAnswer> {
  const steps = parseProgramSteps(call.args.steps)
  if (typeof steps === 'string') return { ok: false, error: { code: 'bad-args', message: steps } }
  const tab = await deps.resolveTab()
  if ('ok' in tab) return { ok: false, error: { code: 'no-active-tab', message: tab.error?.message ?? 'No controlled tab for the program.' } }
  if (tab.id === undefined) return { ok: false, error: { code: 'no-active-tab', message: 'No controlled tab for the program.' } }
  if (deps.signal.aborted) return CANCELLED
  const prompt = programApprovalPrompt(steps, await deps.listFrames(tab.id, tab.url))
  const authorization = await deps.authorize(prompt, tab.windowId ?? 0)
  if (deps.signal.aborted) return CANCELLED
  if (authorization !== 'approved') {
    return {
      ok: false,
      error: {
        code: authorization === 'timed-out' ? 'timeout' : 'action-failed',
        message: authorization === 'denied' ? 'The user denied the browser program.' : `The browser program was not approved (${authorization}).`,
      },
    }
  }
  // The card is bound to the page it was approved on.
  const current = await deps.resolveTab()
  if ('ok' in current || current.id !== tab.id) {
    return { ok: false, error: { code: 'action-failed', message: 'The controlled tab changed while the program card was open.' } }
  }
  const refreshed = programApprovalPrompt(steps, await deps.listFrames(tab.id, current.url))
  if (refreshed.binding !== prompt.binding) {
    return { ok: false, error: { code: 'action-failed', message: 'The page changed while the program card was open. Call browser_snapshot again before retrying.' } }
  }
  deps.grants.approve(call.id, call.sessionId, steps, prompt.origins, tab.id)
  return { ok: true, result: { text: `Program of ${String(steps.length)} steps approved.`, programId: call.id } }
}
