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

import type { CommitClass, ReviewCode } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'

/** How long Auto stays on after it was turned on; then the user turns it on again. */
export const AUTO_REVIEW_TTL_MS = 60 * 60_000
/** Auto-approved actions per user turn; the next eligible card asks to continue. */
export const AUTO_REVIEW_TURN_LIMIT = 25
/** Auto-approved actions without any new user message; then Auto pauses until one arrives. */
export const AUTO_REVIEW_MESSAGE_LIMIT = 100
/** Reviews (model calls) per conversation per hour, approved or not: a cost bound. */
export const AUTO_REVIEW_ATTEMPT_LIMIT = 120
const ATTEMPT_WINDOW_MS = 60 * 60_000
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
export type AutoReviewBudget = 'ok' | 'turn-limit' | 'message-limit' | 'attempt-limit'

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
  private readonly attempts = new Map<string, number[]>()
  /**
   * Ends that happened before the stored state finished loading: the load
   * must not bring those conversations back (a kill switch or take-over that
   * arrives while the worker starts).
   */
  private readonly endedAt = new Map<string, number>()
  private endedAllAt = Number.NEGATIVE_INFINITY
  readonly ready: Promise<void>

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly changed: () => void = () => {},
  ) {
    this.ready = store.read().then((raw) => {
      const loaded = readSessions(raw)
      for (const [id, entry] of Object.entries(loaded)) {
        if (entry.enabledAt <= this.endedAllAt || entry.enabledAt <= (this.endedAt.get(id) ?? Number.NEGATIVE_INFINITY)) delete loaded[id]
      }
      this.sessions = { ...loaded, ...this.sessions }
    }, () => {})
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
    this.endedAt.set(sessionId, this.now())
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
    this.endedAllAt = this.now()
    for (const id of Object.keys(this.sessions)) this.end(id, cause)
    for (const id of [...this.reviews.keys()]) this.abortReviews(id)
  }

  /** Whether another Auto approval is allowed now. */
  budget(sessionId: string): AutoReviewBudget {
    const entry = this.get(sessionId)
    if (entry === undefined) return 'ok'
    if (entry.sinceMessage >= AUTO_REVIEW_MESSAGE_LIMIT) return 'message-limit'
    const since = this.now() - ATTEMPT_WINDOW_MS
    if ((this.attempts.get(sessionId) ?? []).filter((at) => at > since).length >= AUTO_REVIEW_ATTEMPT_LIMIT) return 'attempt-limit'
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

  /** One review (a model call) is about to be made. */
  noteAttempt(sessionId: string): void {
    const since = this.now() - ATTEMPT_WINDOW_MS
    this.attempts.set(sessionId, [...(this.attempts.get(sessionId) ?? []).filter((at) => at > since), this.now()])
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

/** What each commit class means, for the card's fixed sentence (EN, ZH). */
const COMMIT_CLASS_PHRASES: Record<CommitClass, [string, string]> = {
  none: ['a page action', '一个页面操作'],
  send: ['sending something', '发送内容'],
  delete: ['deleting, removing or archiving something', '删除、移除或归档内容'],
  save: ['saving a change', '保存更改'],
  submit: ['submitting a form or posting something', '提交表单或发布内容'],
  share: ['sharing something or changing who can see it', '分享内容或更改可见范围'],
  account: ['an account action (signing in or out, following, subscribing)', '账户操作（登录或退出、关注、订阅）'],
  change: ['changing a setting, moving or approving something', '更改设置、移动或批准内容'],
  confirm: ['confirming something', '确认某项操作'],
  unknown: ['pressing a button whose effect is not clear from its name', '点击一个名称看不出作用的按钮'],
  type: ['typing text into a site this conversation has read', '向本对话读取过的网站输入文本'],
  address: ['entering a recipient, address, link or amount', '填写收件人、地址、链接或金额'],
}

/**
 * The card's one Auto review line: a FIXED sentence chosen by code from the
 * bridge's outcome code and the extension's own commit class. The reviewer's
 * own words never reach the card the user decides on.
 */
export function autoReviewSentence(code: ReviewCode | 'turn-limit' | 'message-limit' | 'attempt-limit' | 'changed', commitClass: CommitClass, zh: boolean): string {
  const phrase = COMMIT_CLASS_PHRASES[commitClass][zh ? 1 : 0]
  switch (code) {
    case 'high-risk': return zh ? '自动审核请您决定：支付、购买、安全与账户设置始终需要您本人确认。' : 'Auto review asked: payments, purchases, security and account settings always need you.'
    case 'under-rated':
    case 'no-instruction': return zh ? `自动审核请您决定：这看起来是${phrase}，而您最新的消息没有要求这样做。` : `Auto review asked: this looks like ${phrase}, and your latest message did not ask for that.`
    case 'restricted': return zh ? '自动审核请您决定：您最新的消息要求不要做出更改。' : 'Auto review asked: your latest message asked not to make changes.'
    case 'model-ask': return zh ? '自动审核请您决定：审核模型不确定这是否符合您的请求。' : 'Auto review asked: the reviewer was not sure this fits your request.'
    case 'no-user-message': return zh ? '自动审核请您决定：您在此面板中发送的消息里没有授权页面操作的内容。' : 'Auto review asked: no message you sent from this panel authorizes page actions.'
    case 'timeout': return zh ? '自动审核未能及时回答。' : 'Auto review did not answer in time.'
    case 'turn-limit': return zh ? '自从您上一条消息以来，自动审核已批准 25 个操作。批准此操作即可让它继续。' : 'Auto review has approved 25 actions since your last message. Approve this one to let it continue.'
    case 'message-limit': return zh ? '自动审核已暂停，直到您发送新消息。' : 'Auto review is paused until you send a message.'
    case 'attempt-limit': return zh ? '自动审核在这一小时内的审核次数已达上限，此后的操作由您决定。' : 'Auto review reached its review limit for this hour; you decide the next actions.'
    case 'changed': return zh ? '自动审核请您决定：审核期间情况发生了变化。' : 'Auto review asked: something changed while it was reviewing.'
    default: return zh ? '自动审核未能做出判断。' : 'Auto review could not decide.'
  }
}

