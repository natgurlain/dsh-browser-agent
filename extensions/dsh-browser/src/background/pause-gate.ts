/**
 * Pause, take over, resume.
 *
 * While the user has paused the agent ("Pause after this step") or taken over
 * the browser, every new tool call is held here before it reaches tab
 * resolution or approval. The bridge keeps the call pending, so the model sees
 * a step still in progress rather than a failure. A held call settles when:
 *
 * - the user resumes: it is released (or failed when the page changed under an
 *   element-addressed action), after the resume delta has been injected;
 * - its caller cancels it or the kill switch fires;
 * - it gets close to its bridge deadline: it fails closed with a clear message
 *   instead of the bridge's generic timeout, and nothing runs.
 *
 * Calls already executing when the user pauses finish normally.
 *
 * @module
 */

import { wrapUntrustedContent } from '../security/untrusted.ts'

/** User-visible gate mode. */
export type PauseMode = 'running' | 'paused' | 'taken-over' | 'resuming'

/** How the user asked to stop. */
export type PauseRequest = 'after-step' | 'take-over'

/** One held call, as the panel shows it. */
export interface HeldCallView {
  id: string
  name: string
  sessionId?: string
  heldAt: number
}

/** What a held call carries into the resume decision. */
export interface HeldCall extends HeldCallView {
  args: Record<string, unknown>
}

/** Snapshot broadcast to panels. */
export interface PauseState {
  mode: PauseMode
  since?: number
  /** Whether resuming came from a takeover (for the banner and delta). */
  tookOver?: boolean
  held: HeldCallView[]
}

/** How one hold ended. */
export type HoldOutcome =
  | { kind: 'not-held' }
  | { kind: 'released'; heldMs: number }
  | { kind: 'failed'; heldMs: number; message: string }
  | { kind: 'expired'; heldMs: number }
  | { kind: 'cancelled' }

/** The persisted part of the state (held calls do not survive a worker restart). */
export interface PersistedPause {
  mode: 'paused' | 'taken-over'
  since: number
}

interface Waiter {
  call: HeldCall
  settle: (outcome: HoldOutcome) => void
}

/** Default time a call may be held when the bridge sent no deadline. */
const DEFAULT_MAX_HOLD_MS = 10 * 60_000
/** Fail a held call this long before its bridge deadline. */
const DEFAULT_MARGIN_MS = 1_500

export interface PauseGateOptions {
  onChange?: (state: PauseState) => void
  maxHoldMs?: number
  marginMs?: number
}

/** Holds tool calls while the user has paused the agent. */
export class PauseGate {
  private mode: PauseMode = 'running'
  private since: number | undefined
  private tookOver = false
  private readonly waiters = new Map<string, Waiter>()
  private readonly maxHoldMs: number
  private readonly marginMs: number
  /** Suppresses per-call notifications while many holds settle at once. */
  private batching = false

  constructor(private readonly options: PauseGateOptions = {}) {
    this.maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS
    this.marginMs = options.marginMs ?? DEFAULT_MARGIN_MS
  }

  /** Current state for panels. */
  state(): PauseState {
    return {
      mode: this.mode,
      ...(this.since === undefined ? {} : { since: this.since }),
      ...(this.tookOver ? { tookOver: true } : {}),
      held: [...this.waiters.values()].map(({ call }) => ({
        id: call.id,
        name: call.name,
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        heldAt: call.heldAt,
      })),
    }
  }

  /** Whether new calls are held right now. */
  holding(): boolean {
    return this.mode !== 'running'
  }

  /** What to persist so a worker restart keeps the agent paused. */
  persisted(): PersistedPause | undefined {
    if (this.mode === 'paused' || this.mode === 'taken-over') return { mode: this.mode, since: this.since ?? Date.now() }
    return undefined
  }

  /** Re-apply a persisted pause (ignored unless well formed). */
  restore(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const { mode, since } = value as { mode?: unknown; since?: unknown }
    if (mode !== 'paused' && mode !== 'taken-over') return
    this.mode = mode
    this.tookOver = mode === 'taken-over'
    this.since = typeof since === 'number' && Number.isFinite(since) ? since : Date.now()
    this.changed()
  }

  /** Pause after the current step, or take over (which also pauses). */
  pause(request: PauseRequest): void {
    const next: PauseMode = request === 'take-over' ? 'taken-over' : 'paused'
    if (this.mode === next) return
    if (this.mode === 'running' || this.mode === 'resuming') this.since = Date.now()
    if (next === 'taken-over') this.tookOver = true
    this.mode = next
    this.changed()
  }

  /**
   * Hold one call while paused.
   * @returns `not-held` at once when running; otherwise how the hold ended.
   */
  hold(
    call: { id: string; name: string; sessionId?: string; args?: Record<string, unknown>; expiresAt?: number },
    signal: AbortSignal,
  ): Promise<HoldOutcome> {
    if (!this.holding()) return Promise.resolve({ kind: 'not-held' })
    if (signal.aborted) return Promise.resolve({ kind: 'cancelled' })
    const heldAt = Date.now()
    const held: HeldCall = {
      id: call.id,
      name: call.name,
      args: call.args ?? {},
      heldAt,
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
    }
    return new Promise<HoldOutcome>((resolve) => {
      const deadline = call.expiresAt === undefined
        ? heldAt + this.maxHoldMs
        : Math.min(heldAt + this.maxHoldMs, call.expiresAt - this.marginMs)
      const timer = setTimeout(() => { finish({ kind: 'expired', heldMs: Date.now() - heldAt }) }, Math.max(0, deadline - heldAt))
      const onAbort = (): void => { finish({ kind: 'cancelled' }) }
      const waiter: Waiter = { call: held, settle: (outcome) => { finish(outcome) } }
      const finish = (outcome: HoldOutcome): void => {
        if (this.waiters.get(call.id) !== waiter) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(call.id)
        resolve(outcome)
        this.changed()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.get(call.id)?.settle({ kind: 'cancelled' })
      this.waiters.set(call.id, waiter)
      this.changed()
    })
  }

  /**
   * Resume: let `prepare` inject what changed (new calls keep being held
   * meanwhile), then release every held call except those it names, which
   * fail with the given message. A failing `prepare` still resumes.
   */
  async resume(prepare: (held: HeldCall[], context: { tookOver: boolean; pausedMs: number }) => Promise<Map<string, string> | void>): Promise<void> {
    if (this.mode === 'running' || this.mode === 'resuming') return
    const context = { tookOver: this.tookOver, pausedMs: Date.now() - (this.since ?? Date.now()) }
    this.mode = 'resuming'
    this.changed()
    let failures: Map<string, string> | void = undefined
    try {
      failures = await prepare([...this.waiters.values()].map(({ call }) => call), context)
    } catch { /* a missing delta must not keep the agent paused */ }
    if (this.mode !== 'resuming') return
    this.mode = 'running'
    this.since = undefined
    this.tookOver = false
    const now = Date.now()
    this.settleAll((call) => {
      const message = failures instanceof Map ? failures.get(call.id) : undefined
      return message === undefined
        ? { kind: 'released', heldMs: now - call.heldAt }
        : { kind: 'failed', heldMs: now - call.heldAt, message }
    })
  }

  /** Kill switch: cancel every held call and drop the pause. */
  cancelAll(): void {
    this.mode = 'running'
    this.since = undefined
    this.tookOver = false
    this.settleAll(() => ({ kind: 'cancelled' }))
  }

  private settleAll(outcome: (call: HeldCall) => HoldOutcome): void {
    this.batching = true
    try {
      for (const waiter of [...this.waiters.values()]) waiter.settle(outcome(waiter.call))
    } finally {
      this.batching = false
    }
    this.changed()
  }

  private changed(): void {
    if (this.batching) return
    this.options.onChange?.(this.state())
  }
}

/** Whether a held call addresses page elements that may be gone after a change. */
export function heldCallStale(call: { name: string; args: Record<string, unknown> }, pageChanged: boolean): boolean {
  if (!pageChanged) return false
  return ['index', 'selector', 'from', 'to', 'fromIndex', 'toIndex', 'ref'].some((key) => call.args[key] !== undefined)
}

/** Message for a held call that ran into its deadline while paused. */
export const HOLD_EXPIRED_MESSAGE = 'The user paused the agent and did not resume before this browser action\'s time limit, so the action was not performed. Wait for the user to resume, then retry.'

/** Message for a held call whose page changed while paused. */
export const HOLD_STALE_MESSAGE = 'The user changed the page while the agent was paused, so this action was not performed. Read the browser update you received and take a fresh browser_snapshot before retrying.'

/** Page facts captured at pause and resume. */
export interface PageFacts {
  url?: string
  title?: string
}

/** Inputs of {@link describeResumeDelta}. */
export interface ResumeDeltaInput {
  mode: 'paused' | 'taken-over'
  pausedMs: number
  before: PageFacts | undefined
  /** Undefined when the controlled tab is gone. */
  after: PageFacts | undefined
  openedFromControlled: number
  newTabs: number
  /** Rendered `browser_snapshot { delta: true }`, when sharing allowed it. */
  pageDelta?: string
  /** False when page-content sharing is off: report only that things changed. */
  shareDetails: boolean
  /**
   * The page now open is one the agent may not read (blocked site, outside
   * the managed allowlist): its address and title are withheld.
   */
  redactAfter?: boolean
}

/** Room for the fenced URL/title change lines of one resume delta. */
const RESUME_FACTS_MAX_CHARS = 6_000

/** Compact, model-facing summary of what changed while the agent was paused. */
export function describeResumeDelta(input: ResumeDeltaInput): string {
  const seconds = Math.max(1, Math.round(input.pausedMs / 1000))
  const lines = [input.mode === 'taken-over'
    ? `The user took over the browser for ${seconds}s and has handed control back.`
    : `The user paused the agent for ${seconds}s and has now resumed it.`]
  if (input.after === undefined) {
    lines.push('- The controlled tab is no longer available.')
  } else {
    const urlChanged = input.before?.url !== input.after.url
    const titleChanged = input.before?.title !== input.after.title
    if ((urlChanged || titleChanged) && input.redactAfter === true) {
      lines.push('- The tab now shows a site the agent may not read (site policy): its address and title are withheld.')
    } else if ((urlChanged || titleChanged) && input.shareDetails) {
      // Titles and URLs are page-authored: they ride inside the untrusted boundary.
      const changes: string[] = []
      if (urlChanged) changes.push(`URL changed: ${input.before?.url ?? '(unknown)'} → ${input.after.url ?? '(unknown)'}`)
      if (titleChanged) changes.push(`Title changed: "${input.before?.title ?? ''}" → "${input.after.title ?? ''}"`)
      lines.push('- The page changed:', wrapUntrustedContent(changes.join('\n'), RESUME_FACTS_MAX_CHARS))
    } else {
      if (urlChanged) lines.push('- The page URL changed.')
      if (titleChanged) lines.push('- The page title changed.')
    }
    if (!urlChanged && !titleChanged && input.newTabs === 0 && (input.pageDelta ?? '').trim() === '') {
      lines.push('- Nothing changed in the controlled tab.')
    }
  }
  if (input.newTabs > 0) {
    const fromControlled = input.openedFromControlled === 1 ? '1 new tab was' : `${input.openedFromControlled} new tabs were`
    lines.push(`- ${fromControlled} opened from the controlled tab (${input.newTabs} new tab${input.newTabs === 1 ? '' : 's'} in total). Use browser_list_tabs to inspect them.`)
  }
  if (input.pageDelta !== undefined && input.pageDelta.trim() !== '') {
    lines.push('', 'Page changes since your last snapshot:', input.pageDelta.trim())
  }
  return lines.join('\n')
}
