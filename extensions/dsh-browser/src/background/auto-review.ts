/**
 * Auto approve's per-conversation state in the background
 * (docs/auto-approve-design.md §6): which conversations the user switched on
 * or off, the reviews in flight (so turning Auto off or the kill switch
 * aborts them), and a runaway guard that never trips in normal use.
 *
 * A conversation the user never switched follows the Setting "Start
 * conversations in Auto approve". An explicit choice, on or off, is kept in
 * `chrome.storage.local`, so it survives a service-worker or browser restart:
 * Auto stays on for the conversation without re-arming, and a conversation
 * the user switched off stays off even when the Setting is on.
 *
 * @module
 */

import type { ReviewCode } from 'dsh-browser-agent/src/protocol.ts'

/** `chrome.storage.local` key of the explicit choices. */
export const AUTO_APPROVE_STORAGE_KEY = 'dshAutoApprove'
/** `chrome.storage.session` key of the side-panel conversations (kept across worker restarts; a new prompt adds one again). */
export const AUTO_APPROVE_PANEL_KEY = 'dshAutoApprovePanel'
/** Most conversations whose choice is kept (the oldest choice is dropped first). */
export const AUTO_APPROVE_KEPT = 500
/**
 * Runaway guard: more Auto approvals than this in {@link RUNAWAY_WINDOW_MS}
 * in one conversation, and the next action shows its card. An agent waits
 * for each page action to settle, so a real task does a few per second at
 * most; this only stops a loop gone wrong.
 */
export const RUNAWAY_LIMIT = 300
export const RUNAWAY_WINDOW_MS = 60_000

/** What is stored. */
export interface AutoApproveStored {
  v: 1
  /** Conversation id → the user's explicit choice (true: on, false: off). */
  sessions: Record<string, boolean>
}

interface Store {
  read(): Promise<unknown>
  write(value: AutoApproveStored): Promise<void>
}

/**
 * Where the side-panel conversations are kept: only these follow "Start
 * conversations in Auto approve" (a DSH session driven from the terminal,
 * the CLI or another app never starts in Auto approve).
 */
interface PanelStore {
  read(): Promise<unknown>
  write(ids: string[]): Promise<void>
}

function readPanel(list: unknown): Set<string> {
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && id !== '' && id.length <= 256).slice(-AUTO_APPROVE_KEPT) : [])
}

function readStored(raw: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return out
  const sessions = (raw as { sessions?: unknown }).sessions
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return out
  for (const [id, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof value === 'boolean' && id !== '' && id.length <= 256) out.set(id, value)
  }
  return out
}

/** The background's Auto approve registry. */
export class AutoApproveRegistry {
  private choices = new Map<string, boolean>()
  private panel = new Set<string>()
  /** The stored choices have loaded: until then nothing counts as on unless chosen in this worker. */
  private loaded = false
  private readonly reviews = new Map<string, Set<AbortController>>()
  private readonly approvals = new Map<string, number[]>()
  readonly ready: Promise<void>

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly changed: () => void = () => {},
    private readonly panelStore?: PanelStore,
  ) {
    this.ready = Promise.all([
      store.read().then((raw) => {
        // Choices made while the stored ones loaded win.
        const loaded = readStored(raw)
        for (const [id, on] of this.choices) loaded.set(id, on)
        this.choices = loaded
      }, () => {}),
      (panelStore?.read() ?? Promise.resolve(undefined)).then((raw) => {
        const panel = readPanel(raw)
        for (const id of this.panel) { panel.delete(id); panel.add(id) }
        this.panel = panel
      }, () => {}),
    ]).then(() => {}).finally(() => { this.loaded = true })
  }

  private persist(): void {
    // Over the bound, drop the oldest "on" first: a dropped "off" would fall
    // back to the Setting and could turn Auto approve on again.
    while (this.choices.size > AUTO_APPROVE_KEPT) {
      let victim: string | undefined
      for (const [id, on] of this.choices) {
        if (on) { victim = id; break }
      }
      this.choices.delete(victim ?? this.choices.keys().next().value!)
    }
    void this.store.write({ v: 1, sessions: Object.fromEntries(this.choices) }).catch(() => {})
    this.changed()
  }

  private persistPanel(): void {
    while (this.panel.size > AUTO_APPROVE_KEPT) this.panel.delete(this.panel.values().next().value!)
    void this.panelStore?.write([...this.panel]).catch(() => {})
    this.changed()
  }

  /** The user's explicit choice for one conversation, if any. */
  choice(sessionId: string): boolean | undefined {
    return this.choices.get(sessionId)
  }

  /**
   * Whether Auto approve is on for one conversation: its explicit choice,
   * else the Setting, which applies only to conversations prompted from the
   * side panel. Before the stored choices load, only a choice made in this
   * worker counts (a stored "off" must not read as the Setting's "on").
   */
  isOn(sessionId: string | undefined, startOn: boolean): boolean {
    if (sessionId === undefined || sessionId === '') return false
    const choice = this.choices.get(sessionId)
    if (choice !== undefined) return choice
    return this.loaded && startOn && this.panel.has(sessionId)
  }

  /** The user prompted this conversation from the side panel: the Setting applies to it. */
  notePanel(sessionId: string): void {
    if (this.panel.has(sessionId)) return
    this.panel.add(sessionId)
    this.persistPanel()
  }

  /** Conversations prompted from the side panel (the panel's toggle reads it). */
  panelSessions(): string[] {
    return [...this.panel]
  }

  /** Every explicit choice, for the panel. */
  views(): Record<string, boolean> {
    return Object.fromEntries(this.choices)
  }

  /** The user switched Auto on or off for one conversation. Off aborts its reviews in flight (their cards show). */
  set(sessionId: string, on: boolean): void {
    this.choices.delete(sessionId)
    this.choices.set(sessionId, on)
    if (!on) this.abortReviews(sessionId)
    this.persist()
  }

  /** The conversation was deleted: its choice goes with it. */
  forget(sessionId: string): void {
    this.abortReviews(sessionId)
    if (this.choices.delete(sessionId)) this.persist()
    if (this.panel.delete(sessionId)) this.persistPanel()
    this.approvals.delete(sessionId)
  }

  /** A review is about to run: `controller` is aborted by {@link set} (off), {@link forget} and {@link abortAll}. */
  track(sessionId: string, controller: AbortController): () => void {
    let set = this.reviews.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.reviews.set(sessionId, set)
    }
    set.add(controller)
    return () => {
      const current = this.reviews.get(sessionId)
      current?.delete(controller)
      if (current?.size === 0) this.reviews.delete(sessionId)
    }
  }

  /** Abort every review in flight of one conversation. */
  abortReviews(sessionId: string): void {
    for (const controller of this.reviews.get(sessionId) ?? []) controller.abort()
  }

  /** Abort every review in flight (the kill switch). */
  abortAll(): void {
    for (const id of [...this.reviews.keys()]) this.abortReviews(id)
  }

  /** Reviews in flight (tests, runtime keeper). */
  pending(sessionId?: string): number {
    if (sessionId !== undefined) return this.reviews.get(sessionId)?.size ?? 0
    let total = 0
    for (const set of this.reviews.values()) total += set.size
    return total
  }

  /** Whether the runaway guard holds the next Auto approval of this conversation back. */
  runaway(sessionId: string): boolean {
    const since = this.now() - RUNAWAY_WINDOW_MS
    const recent = (this.approvals.get(sessionId) ?? []).filter((at) => at > since)
    this.approvals.set(sessionId, recent)
    return recent.length >= RUNAWAY_LIMIT
  }

  /** Auto approved one action (with or without a review). */
  noteApproved(sessionId: string): void {
    const list = this.approvals.get(sessionId) ?? []
    list.push(this.now())
    if (list.length > RUNAWAY_LIMIT * 2) list.splice(0, list.length - RUNAWAY_LIMIT)
    this.approvals.set(sessionId, list)
  }
}

/** Why Auto approve left a card to the user, for its one line. */
export type AutoNoteCode = ReviewCode | 'runaway' | 'no-reviewer' | 'changed'

/**
 * The card's one Auto approve line. A reviewer's "deny" carries its own
 * one-line reason (model text, sanitized and capped by the bridge, shown
 * attributed); every other outcome is a fixed sentence.
 */
export function autoApproveNote(code: AutoNoteCode, reason: string | undefined, zh: boolean): string {
  const said = (reason ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200)
  switch (code) {
    case 'denied': return said === ''
      ? zh ? '自动批准的审核模型请您决定。' : 'Auto approve\'s reviewer asked you to decide.'
      : zh ? `自动批准的审核模型请您决定：${said}` : `Auto approve's reviewer asked you: ${said}`
    case 'timeout': return zh ? '自动批准的审核模型没有及时回答，请您决定。' : 'Auto approve\'s reviewer did not answer in time, so you decide.'
    case 'runaway': return zh ? '自动批准已暂停：一分钟内的操作异常多。' : 'Auto approve paused: unusually many actions in one minute.'
    case 'no-reviewer': return zh ? '这是一个重要操作，而审核模型当前不可用，请您决定。' : 'This step matters and Auto approve\'s reviewer is not available, so you decide.'
    case 'changed': return zh ? '审核期间情况发生了变化，请您决定。' : 'Something changed while Auto approve reviewed this step, so you decide.'
    default: return zh ? '自动批准无法审核这一步，请您决定。' : 'Auto approve could not review this step, so you decide.'
  }
}
