/**
 * Per-conversation Auto review state in the background (docs/auto-review-design.md §7):
 * which conversations have it on and until when, the per-turn and
 * consecutive limits, one review at a time per conversation, and the abort
 * paths (off, kill switch, take-over, new user message, conversation gone).
 *
 * The state lives in `chrome.storage.session` (memory only: gone when the
 * browser restarts) so a service-worker restart does not silently drop it.
 *
 * @module
 */

/** How long Auto stays on after it was turned on; then the user turns it on again. */
export const AUTO_REVIEW_TTL_MS = 60 * 60_000
/** Auto-approved actions per user turn; the next eligible card asks to continue. */
export const AUTO_REVIEW_TURN_LIMIT = 25
/** Auto-approved actions without any new user message; then Auto pauses until one arrives. */
export const AUTO_REVIEW_MESSAGE_LIMIT = 100
/** `chrome.storage.session` key of the state. */
export const AUTO_REVIEW_STORAGE_KEY = 'dshAutoReview'
/** Labels of recent Auto approvals kept per conversation (sent to the reviewer, capped there too). */
const RECENT_KEPT = 3

/** Why Auto ended for a conversation (shown by the panel). */
export type AutoReviewEnd = 'user' | 'expired' | 'kill-switch' | 'take-over' | 'conversation-ended' | 'managed' | 'setting'

/** One conversation's state. */
export interface AutoReviewSession {
  enabledAt: number
  expiresAt: number
  /** Auto approvals since the user's last message or "continue" card. */
  turnCount: number
  /** Auto approvals since the user's last message. */
  sinceMessage: number
  /** Opaque marker of the newest user message the bridge reported. */
  userTurn?: string
  recent: string[]
}

/** What the panel is told per conversation. */
export interface AutoReviewView {
  on: boolean
  expiresAt?: number
  /** Why it is off, when it ended rather than never started. */
  ended?: AutoReviewEnd
}

/** Whether a further Auto approval is allowed now. */
export type AutoReviewBudget = 'ok' | 'turn-limit' | 'message-limit'

interface Store {
  read(): Promise<unknown>
  write(value: Record<string, AutoReviewSession>): Promise<void>
}

function readSessions(raw: unknown): Record<string, AutoReviewSession> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, AutoReviewSession> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const num = (key: string): number | undefined => typeof entry[key] === 'number' && Number.isFinite(entry[key]) ? entry[key] as number : undefined
    const enabledAt = num('enabledAt')
    const expiresAt = num('expiresAt')
    if (enabledAt === undefined || expiresAt === undefined || expiresAt - enabledAt > AUTO_REVIEW_TTL_MS) continue
    out[id] = {
      enabledAt,
      expiresAt,
      turnCount: Math.max(0, num('turnCount') ?? 0),
      sinceMessage: Math.max(0, num('sinceMessage') ?? 0),
      ...typeof entry.userTurn === 'string' ? { userTurn: entry.userTurn } : {},
      recent: Array.isArray(entry.recent) ? entry.recent.filter((label): label is string => typeof label === 'string').slice(-RECENT_KEPT) : [],
    }
  }
  return out
}

/** The background's Auto review registry. */
export class AutoReviewRegistry {
  private sessions: Record<string, AutoReviewSession> = {}
  private readonly ended = new Map<string, AutoReviewEnd>()
  private readonly reviews = new Map<string, Set<AbortController>>()
  private readonly queues = new Map<string, Promise<void>>()
  readonly ready: Promise<void>

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly changed: () => void = () => {},
  ) {
    this.ready = store.read().then((raw) => { this.sessions = { ...readSessions(raw), ...this.sessions } }, () => {})
  }

  private persist(): void {
    void this.store.write({ ...this.sessions }).catch(() => {})
    this.changed()
  }

  /** The live state of one conversation (expired state is dropped here). */
  get(sessionId: string): AutoReviewSession | undefined {
    const entry = this.sessions[sessionId]
    if (entry === undefined) return undefined
    if (this.now() >= entry.expiresAt) {
      this.end(sessionId, 'expired')
      return undefined
    }
    return entry
  }

  isOn(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.get(sessionId) !== undefined
  }

  view(sessionId: string): AutoReviewView {
    const entry = this.get(sessionId)
    if (entry !== undefined) return { on: true, expiresAt: entry.expiresAt }
    const ended = this.ended.get(sessionId)
    return ended === undefined ? { on: false } : { on: false, ended }
  }

  /** Every conversation with Auto on or recently ended, for the panel. */
  views(): Record<string, AutoReviewView> {
    const out: Record<string, AutoReviewView> = {}
    for (const id of new Set([...Object.keys(this.sessions), ...this.ended.keys()])) out[id] = this.view(id)
    return out
  }

  /** Turn Auto on (or renew it) for one conversation, for {@link AUTO_REVIEW_TTL_MS}. */
  enable(sessionId: string): AutoReviewSession {
    const now = this.now()
    const entry: AutoReviewSession = { enabledAt: now, expiresAt: now + AUTO_REVIEW_TTL_MS, turnCount: 0, sinceMessage: 0, recent: [] }
    this.sessions[sessionId] = entry
    this.ended.delete(sessionId)
    this.persist()
    return entry
  }

  /** Turn Auto off for one conversation and abort its in-flight reviews (their cards show). */
  end(sessionId: string, cause: AutoReviewEnd): void {
    const had = this.sessions[sessionId] !== undefined
    delete this.sessions[sessionId]
    this.abortReviews(sessionId)
    if (cause === 'conversation-ended') this.ended.delete(sessionId)
    else if (had || cause === 'user') this.ended.set(sessionId, cause)
    if (had || cause === 'conversation-ended') this.persist()
    else this.changed()
  }

  /** Turn Auto off everywhere (kill switch, take-over, managed policy, Setting off). */
  endAll(cause: AutoReviewEnd): void {
    for (const id of Object.keys(this.sessions)) this.end(id, cause)
    for (const id of [...this.reviews.keys()]) this.abortReviews(id)
  }

  /** Whether another Auto approval is allowed now. */
  budget(sessionId: string): AutoReviewBudget {
    const entry = this.get(sessionId)
    if (entry === undefined) return 'ok'
    if (entry.sinceMessage >= AUTO_REVIEW_MESSAGE_LIMIT) return 'message-limit'
    if (entry.turnCount >= AUTO_REVIEW_TURN_LIMIT) return 'turn-limit'
    return 'ok'
  }

  counts(sessionId: string): { turn: number; recent: readonly string[] } {
    const entry = this.get(sessionId)
    return { turn: entry?.turnCount ?? 0, recent: entry?.recent ?? [] }
  }

  /** The user sent a message in this conversation: counters start again and pending reviews are dropped. */
  noteUserMessage(sessionId: string): void {
    this.abortReviews(sessionId)
    const entry = this.sessions[sessionId]
    if (entry === undefined) return
    entry.turnCount = 0
    entry.sinceMessage = 0
    entry.recent = []
    this.persist()
  }

  /** The bridge reported the newest user message it saw: a new one resets the counters. */
  noteUserTurn(sessionId: string, marker: string | undefined): void {
    const entry = this.sessions[sessionId]
    if (entry === undefined || marker === undefined || marker === entry.userTurn) return
    const first = entry.userTurn === undefined
    entry.userTurn = marker
    if (!first) {
      entry.turnCount = 0
      entry.sinceMessage = 0
      entry.recent = []
    }
    this.persist()
  }

  /** Auto approved one action. */
  noteApproved(sessionId: string, label: string): void {
    const entry = this.sessions[sessionId]
    if (entry === undefined) return
    entry.turnCount += 1
    entry.sinceMessage += 1
    entry.recent = [...entry.recent, label].slice(-RECENT_KEPT)
    this.persist()
  }

  /** The user approved the "continue?" card: another {@link AUTO_REVIEW_TURN_LIMIT} may follow. */
  noteContinued(sessionId: string): void {
    const entry = this.sessions[sessionId]
    if (entry === undefined) return
    entry.turnCount = 0
    this.persist()
  }

  /**
   * Run one review for a conversation after any earlier one finished (one at
   * a time). `controller` is aborted by {@link end}, {@link noteUserMessage}
   * and {@link endAll}.
   */
  async serialized<T>(sessionId: string, controller: AbortController, run: () => Promise<T>): Promise<T> {
    let set = this.reviews.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.reviews.set(sessionId, set)
    }
    set.add(controller)
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => mine)
    this.queues.set(sessionId, tail)
    try {
      await previous
      return await run()
    } finally {
      release()
      set.delete(controller)
      if (set.size === 0) this.reviews.delete(sessionId)
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId)
    }
  }

  /** Abort every in-flight or queued review of one conversation. */
  abortReviews(sessionId: string): void {
    for (const controller of this.reviews.get(sessionId) ?? []) controller.abort()
  }

  /** Reviews in flight or queued (tests, runtime keeper). */
  pending(sessionId?: string): number {
    if (sessionId !== undefined) return this.reviews.get(sessionId)?.size ?? 0
    let total = 0
    for (const set of this.reviews.values()) total += set.size
    return total
  }
}
