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

import type { AutoReviewTool, ReviewCode } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { Assessment } from '../security/auto-review.ts'
import type { TargetKind } from '../shared/target-description.ts'

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
  /**
   * Names and dictated texts already used by an Auto approval under one user
   * message (`turn` = that message's marker): each authorises one approval.
   */
  consumed?: { turn: string; items: string[] }
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

/** What is stored: the conversations, and the review attempts of the last hour (a worker restart must not reset the cost bound). */
export interface AutoReviewStored {
  v: 2
  sessions: Record<string, AutoReviewSession>
  attempts: Record<string, number[]>
}

interface Store {
  read(): Promise<unknown>
  write(value: AutoReviewStored): Promise<void>
}

function readAttempts(raw: unknown): Map<string, number[]> {
  const out = new Map<string, number[]>()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const times = value.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)).slice(-AUTO_REVIEW_ATTEMPT_LIMIT)
    if (times.length > 0) out.set(id, times)
  }
  return out
}

function readSessions(stored: unknown): Record<string, AutoReviewSession> {
  // Version 2 wraps the sessions; version 1 was the sessions object itself.
  const raw = typeof stored === 'object' && stored !== null && (stored as { v?: unknown }).v === 2 ? (stored as { sessions?: unknown }).sessions : stored
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
      ...(() => {
        const consumed = entry.consumed as { turn?: unknown; items?: unknown } | undefined
        return typeof consumed?.turn === 'string' && Array.isArray(consumed.items)
          ? { consumed: { turn: consumed.turn, items: consumed.items.filter((item): item is string => typeof item === 'string').slice(-200) } }
          : {}
      })(),
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
      const attempts = readAttempts(typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 2 ? (raw as { attempts?: unknown }).attempts : undefined)
      for (const [id, times] of attempts) {
        const live = this.attempts.get(id) ?? []
        this.attempts.set(id, [...times, ...live].slice(-AUTO_REVIEW_ATTEMPT_LIMIT))
      }
      for (const [id, entry] of Object.entries(loaded)) {
        if (entry.enabledAt <= this.endedAllAt || entry.enabledAt <= (this.endedAt.get(id) ?? Number.NEGATIVE_INFINITY)) delete loaded[id]
      }
      this.sessions = { ...loaded, ...this.sessions }
    }, () => {})
  }

  private persist(): void {
    const since = this.now() - ATTEMPT_WINDOW_MS
    const attempts: Record<string, number[]> = {}
    for (const [id, times] of this.attempts) {
      const recent = times.filter((at) => at > since)
      if (recent.length > 0) attempts[id] = recent
    }
    void this.store.write({ v: 2, sessions: { ...this.sessions }, attempts }).catch(() => {})
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
    this.persist()
  }

  /** Whether any of these names or texts was already used by an Auto approval under this user message. */
  isConsumed(sessionId: string, turn: string, items: readonly string[]): boolean {
    const consumed = this.sessions[sessionId]?.consumed
    return consumed !== undefined && consumed.turn === turn && items.some((item) => consumed.items.includes(item))
  }

  /** An Auto approval used these names or texts under this user message. */
  consume(sessionId: string, turn: string, items: readonly string[]): void {
    const entry = this.sessions[sessionId]
    if (entry === undefined || items.length === 0) return
    const before = entry.consumed?.turn === turn ? entry.consumed.items : []
    entry.consumed = { turn, items: [...before, ...items].slice(-200) }
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

/** What the card's sentence is about: the action, as the extension's rules saw it. */
export interface ReviewSubject {
  tool: AutoReviewTool
  /** The element's kind, when there is one. */
  kind?: TargetKind
  assessment: Pick<Assessment, 'rule' | 'mustName' | 'mustContext' | 'exactText' | 'exactToken' | 'commitClass'>
}

/** What a control is called on the card's sentence (EN, ZH). */
function controlWord(kind: TargetKind | undefined): [string, string] {
  switch (kind) {
    case 'checkbox': return ['checkbox', '复选框']
    case 'switch': return ['switch', '开关']
    case 'radio':
    case 'option': return ['option', '选项']
    case 'menuitem': return ['menu item', '菜单项']
    case 'tab': return ['tab', '标签页']
    case 'link': return ['link', '链接']
    default: return ['button', '按钮']
  }
}

/**
 * Teach the rule that held a `named` action back: which words the user's
 * message would have needed, in the words the user would say.
 */
function notNamedSentence(subject: ReviewSubject, zh: boolean): string {
  const { tool, assessment } = subject
  const names = assessment.mustName ?? []
  if (tool === 'browser_type') {
    if (assessment.exactToken === true) {
      return zh
        ? '自动审核请您决定：您的消息里没有原样写出要填写的这个收件人、地址、链接或金额。下次在消息中原样写出它即可放行。'
        : 'Auto review asked: your message did not contain this exact recipient, address, link or amount. Write it out exactly in your message to let it through next time.'
    }
    return zh
      ? '自动审核请您决定：您的消息里没有用引号给出要输入的完整文字。下次把要输入的全部文字放进引号（例如 输入“你好”）即可放行。'
      : 'Auto review asked: your message did not give the text to type in quotes. Put the whole text in quotes (type "hello world") to let it through next time.'
  }
  if (assessment.mustContext !== undefined && names.length === 1) {
    return zh
      ? `自动审核请您决定：页面上有多个“${names[0]}”，您的消息没有说明是哪一个。下次说“点击${assessment.mustContext}的${names[0]}”即可放行。`
      : `Auto review asked: there is more than one “${names[0]}” here and your message did not say which. Say “click ${names[0]} on ${assessment.mustContext}” to let it through next time.`
  }
  if (tool === 'browser_select') {
    const list = names.join(zh ? '、' : ', ')
    return zh
      ? `自动审核请您决定：您的消息没有说出要选择的每个选项。下次说“选择${list}”即可放行。`
      : `Auto review asked: your message did not name every option to choose. Say “select ${list}” to let it through next time.`
  }
  if (tool === 'browser_drag' && names.length === 2) {
    return zh
      ? `自动审核请您决定：您的消息没有说出拖动的起点和终点。下次说“把${names[0]}拖到${names[1]}”即可放行。`
      : `Auto review asked: your message did not name both ends of this drag. Say “drag ${names[0]} to ${names[1]}” to let it through next time.`
  }
  const [en, cn] = controlWord(subject.kind)
  const name = names[0] ?? ''
  return zh
    ? `自动审核请您决定：您的消息没有说出这个${cn}的名称。下次说“点击${name}”即可放行。`
    : `Auto review asked: your message did not name this ${en}. Say “click ${name}” to let it through next time.`
}

/**
 * The card's one Auto review line: a FIXED sentence chosen by code from the
 * bridge's outcome code and the extension's own facts (the names in it are
 * the ones the card already shows). The reviewer's own words never reach the
 * card the user decides on.
 */
export function autoReviewSentence(code: ReviewCode | 'turn-limit' | 'message-limit' | 'attempt-limit' | 'changed' | 'already-used' | 'ambiguous', subject: ReviewSubject, zh: boolean): string {
  switch (code) {
    case 'already-used': return zh
      ? '自动审核请您决定：您的消息点名的这一项已经自动批准过一次。每次点名只放行一次；想再做一次请再说一遍。'
      : 'Auto review asked: what your message named was already used once. Each name lets one action through; say it again to repeat it.'
    case 'ambiguous': return zh
      ? '自动审核请您决定：页面上有多个同名控件，无法判断您指的是哪一个。'
      : 'Auto review asked: several controls on this page have this name, and there is no row or section to tell them apart.'
    case 'high-risk': return zh ? '自动审核请您决定：支付、购买、安全与账户设置始终需要您本人确认。' : 'Auto review asked: payments, purchases, security and account settings always need you.'
    case 'not-named': return notNamedSentence(subject, zh)
    case 'restricted': return zh ? '自动审核请您决定：您最新的消息要求先不要动手（例如“不要”“只看”“草拟”）。' : 'Auto review asked: your latest message asked to hold back (“don’t”, “only read”, “draft”…), so you decide.'
    case 'model-ask': return zh ? '自动审核请您决定：审核模型认为这不一定符合您的请求。' : 'Auto review asked: the reviewer was not sure this fits your request.'
    case 'no-user-message': return zh ? '自动审核请您决定：您在此面板中发送的消息里没有授权页面操作的内容。' : 'Auto review asked: no message you sent from this panel authorizes page actions.'
    case 'timeout': return zh ? '自动审核未能及时回答。' : 'Auto review did not answer in time.'
    case 'turn-limit': return zh ? '自从您上一条消息以来，自动审核已批准 25 个操作。批准此操作即可让它继续。' : 'Auto review has approved 25 actions since your last message. Approve this one to let it continue.'
    case 'message-limit': return zh ? '自动审核已暂停，直到您发送新消息。' : 'Auto review is paused until you send a message.'
    case 'attempt-limit': return zh ? '自动审核在这一小时内的审核次数已达上限，此后的操作由您决定。' : 'Auto review reached its review limit for this hour; you decide the next actions.'
    case 'changed': return zh ? '自动审核请您决定：审核期间情况发生了变化。' : 'Auto review asked: something changed while it was reviewing.'
    default: return zh ? '自动审核未能做出判断。' : 'Auto review could not decide.'
  }
}
