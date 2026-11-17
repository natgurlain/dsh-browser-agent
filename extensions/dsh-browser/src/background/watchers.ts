/**
 * Standing page watchers (`browser_watch`, `browser_watches`).
 *
 * Off by default behind the "Allow the agent to watch pages" setting. Creating
 * a watcher always shows its own card (forced: no trusted origin, session
 * grant, or unrestricted access skips it) naming the page, the condition, the
 * prompt, the lifetime, and the number of fires. Approved watchers persist in
 * `chrome.storage.session` (watcher-runtime.ts), so they survive worker
 * restarts but not the browser session their tab ids belong to, and are re-armed in
 * their tab's content script (content/watch.ts) after every navigation.
 *
 * When a condition is met the content script reports it; the background
 * checks the watcher is live, the tab and origin still match, the kill switch
 * is off and the agent is not paused, and the per-watcher and global rate
 * limits, then asks the bridge (`bridge.watch.fire`) to wake the owning
 * session. Matched page text is cut short and dropped entirely when page
 * sharing is off; the bridge wraps it in the untrusted-content boundary.
 *
 * @module
 */

import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { approvalBinding } from '../security/payload-binding.ts'
import type { CallPolicyHook, ToolCall } from './tools.ts'
import { httpOrigin, isRecord } from '../security/web-url.ts'
import { cancelledAnswer, fail, notApprovedAnswer, type SettledAnswer } from './answers.ts'

/** Storage key of the persisted watchers. */
export const WATCHERS_STORAGE_KEY = 'dshPageWatchers'
/** Panel port for the watcher list. */
export const WATCHERS_PORT_NAME = 'dsh-watchers'
/** Most active watchers at once (all sessions). */
export const MAX_ACTIVE_WATCHERS = 10
export const MAX_WATCH_MINUTES = 24 * 60
export const DEFAULT_WATCH_MINUTES = 60
export const MAX_FIRES = 10
/** Minimum spacing between two fires of one watcher. */
export const WATCHER_COOLDOWN_MS = 30_000
/** Most fires across all watchers per minute. */
export const GLOBAL_FIRES_PER_MINUTE = 5
/** Matched page text forwarded to the bridge. */
export const MAX_MATCHED_CHARS = 300
const MAX_PATTERN_CHARS = 500
const MAX_PROMPT_CHARS = 2_000

/** What a watcher waits for (exactly one kind). */
export type WatchCondition =
  | { kind: 'selector'; selector: string; gone: boolean }
  | { kind: 'text'; text: string; gone: boolean }
  | { kind: 'url'; pattern: string }
  | { kind: 'network'; pattern: string }

/** One persisted watcher. */
export interface PageWatcher {
  id: string
  /** Owning Agent session; the bridge refuses any session it does not own. */
  sessionId: string
  tabId: number
  /** The page's origin when the watcher was approved; it fires only on that origin. */
  origin: string
  url: string
  condition: WatchCondition
  prompt: string
  createdAt: number
  expiresAt: number
  maxFires: number
  fires: number
  /** Last fire or missed wake attempt (cooldown clock). */
  lastFiredAt?: number
  /** Set when a wake could not be delivered (session not running, rate limit). */
  lastMiss?: string
}

/** The part of a watcher the content script sees (no prompt, no session). */
export interface ArmedWatch {
  id: string
  condition: WatchCondition
  createdAt: number
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Validate a pattern written as plain text or /regex/flags. */
export function patternMatcher(pattern: string): ((value: string) => boolean) | undefined {
  const regex = /^\/(.+)\/([dimsuv]*)$/u.exec(pattern)
  if (regex !== null) {
    try {
      const compiled = new RegExp(regex[1]!, regex[2]!.replace(/[gy]/gu, ''))
      return (value) => compiled.test(value)
    } catch {
      // Not a valid regex: match it as plain text.
    }
  }
  return (value) => value.includes(pattern)
}

/** Parse `condition`; a string is the error. */
export function parseWatchCondition(raw: unknown): WatchCondition | string {
  if (!isRecord(raw)) return 'condition must be an object.'
  const kinds = (['selector', 'text', 'urlMatches', 'networkRequest'] as const).filter((key) => raw[key] !== undefined)
  if (kinds.length !== 1) return 'condition needs exactly one of selector, text, urlMatches, networkRequest.'
  const kind = kinds[0]!
  const value = raw[kind]
  if (!nonEmpty(value) || value.length > MAX_PATTERN_CHARS) return `condition.${kind} must be a non-empty string of at most ${String(MAX_PATTERN_CHARS)} characters.`
  const gone = raw.gone === true
  if (gone && (kind === 'urlMatches' || kind === 'networkRequest')) return 'gone applies to selector or text only.'
  switch (kind) {
    case 'selector':
      return { kind: 'selector', selector: value, gone }
    case 'text':
      return { kind: 'text', text: value, gone }
    case 'urlMatches':
    case 'networkRequest':
      if (patternMatcher(value) === undefined) return `condition.${kind} is not a valid /regex/.`
      return { kind: kind === 'urlMatches' ? 'url' : 'network', pattern: value }
  }
}

/** One-line description of a condition (shown on cards, in the panel, and to the model). */
export function describeCondition(condition: WatchCondition): string {
  switch (condition.kind) {
    case 'selector':
      return `element ${condition.selector} ${condition.gone ? 'disappears' : 'appears'}`
    case 'text':
      return `text "${condition.text}" ${condition.gone ? 'disappears' : 'appears'}`
    case 'url':
      return `URL matches ${condition.pattern}`
    case 'network':
      return `a network request matches ${condition.pattern}`
  }
}

/** Validated `browser_watch` arguments. */
export interface WatchRequest {
  tabId?: number
  condition: WatchCondition
  prompt: string
  expiresInMinutes: number
  maxFires: number
}

/** Parse `browser_watch` arguments; a string is the error. */
export function parseWatchRequest(args: Record<string, unknown>): WatchRequest | string {
  const condition = parseWatchCondition(args.condition)
  if (typeof condition === 'string') return condition
  if (!nonEmpty(args.prompt) || args.prompt.length > MAX_PROMPT_CHARS) return `prompt must be a non-empty string of at most ${String(MAX_PROMPT_CHARS)} characters.`
  const minutes = args.expiresInMinutes ?? DEFAULT_WATCH_MINUTES
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WATCH_MINUTES) {
    return `expiresInMinutes must be between 1 and ${String(MAX_WATCH_MINUTES)}.`
  }
  const maxFires = args.maxFires ?? 1
  if (typeof maxFires !== 'number' || !Number.isInteger(maxFires) || maxFires < 1 || maxFires > MAX_FIRES) {
    return `maxFires must be an integer between 1 and ${String(MAX_FIRES)}.`
  }
  if (args.tabId !== undefined && (typeof args.tabId !== 'number' || !Number.isSafeInteger(args.tabId))) return 'tabId must be a tab id.'
  return {
    ...(typeof args.tabId === 'number' ? { tabId: args.tabId } : {}),
    condition,
    prompt: args.prompt.trim(),
    expiresInMinutes: minutes,
    maxFires,
  }
}

/**
 * The creation card: always its own decision (forced), naming the page, the
 * condition, the prompt that will be sent back, and how long it lasts.
 */
export function watchApprovalPrompt(request: WatchRequest, page: { url: string; origin: string; title?: string }, forced: { reasons: readonly string[]; causes?: ReadonlyArray<'site-ask' | 'taint'> } = { reasons: [] }): ApprovalPrompt {
  const lifetime = request.expiresInMinutes >= 60
    ? `${String(Math.round(request.expiresInMinutes / 6) / 10)} h`
    : `${String(Math.round(request.expiresInMinutes))} min`
  return {
    kind: 'action',
    action: 'browser_watch',
    summary: `Watch ${page.title === undefined || page.title === '' ? page.url : `"${page.title}" (${page.url})`} for ${lifetime} and wake the agent when ${describeCondition(request.condition)}`
      + ` (at most ${String(request.maxFires)} time${request.maxFires === 1 ? '' : 's'}).`,
    origins: [page.origin],
    canTrust: false,
    forced: true,
    perCallOnly: true,
    // A site set to "Always ask" (or taint) also forced it: Auto approve leaves a site-ask card to the user.
    ...forced.causes === undefined || forced.causes.length === 0 ? {} : { forcedBy: [...new Set(forced.causes)] },
    details: [
      { kind: 'text', label: 'Why this needs your approval', masked: false, value: ['A watcher keeps reading this page in the background and can start the agent later, without a new message from you.', ...forced.reasons].join('\n') },
      { kind: 'text', label: 'Page', masked: false, value: page.url },
      { kind: 'text', label: 'Condition', masked: false, value: describeCondition(request.condition) },
      { kind: 'text', label: 'Prompt sent to the agent when it fires', masked: false, value: request.prompt },
    ],
    binding: approvalBinding({
      action: 'browser_watch',
      args: { condition: request.condition, prompt: request.prompt, expiresInMinutes: request.expiresInMinutes, maxFires: request.maxFires },
      origins: [page.origin],
    }),
  }
}

/** Minimal storage area (chrome.storage.local or a test double). */
export interface WatchStorage {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** Persisted watcher registry. */
export class WatcherRegistry {
  private watchers = new Map<string, PageWatcher>()
  readonly ready: Promise<void>
  private readonly recentFires: number[] = []

  constructor(
    private readonly storage: WatchStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      const stored = (await this.storage.get(WATCHERS_STORAGE_KEY))[WATCHERS_STORAGE_KEY]
      if (Array.isArray(stored)) {
        for (const entry of stored) {
          if (isValidWatcher(entry)) this.watchers.set(entry.id, entry)
        }
      }
    } catch {
      // Storage unavailable: start empty.
    }
    this.prune()
  }

  private async save(): Promise<void> {
    try {
      await this.storage.set({ [WATCHERS_STORAGE_KEY]: [...this.watchers.values()] })
    } catch {
      // Best effort; the in-memory list stays authoritative for this worker.
    }
  }

  /** Drop expired and spent watchers; returns whether anything changed. */
  prune(): boolean {
    const now = this.now()
    let changed = false
    for (const [id, watcher] of this.watchers) {
      if (watcher.expiresAt <= now || watcher.fires >= watcher.maxFires) {
        this.watchers.delete(id)
        changed = true
      }
    }
    if (changed) void this.save()
    return changed
  }

  list(sessionId?: string): PageWatcher[] {
    this.prune()
    return [...this.watchers.values()].filter((watcher) => sessionId === undefined || watcher.sessionId === sessionId)
  }

  get(id: string): PageWatcher | undefined {
    this.prune()
    return this.watchers.get(id)
  }

  forTab(tabId: number): PageWatcher[] {
    return this.list().filter((watcher) => watcher.tabId === tabId)
  }

  /** Whether another watcher fits under the cap. */
  hasRoom(): boolean {
    return this.list().length < MAX_ACTIVE_WATCHERS
  }

  async add(watcher: PageWatcher): Promise<void> {
    this.watchers.set(watcher.id, watcher)
    await this.save()
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.watchers.delete(id)
    if (removed) await this.save()
    return removed
  }

  async removeTab(tabId: number): Promise<boolean> {
    let changed = false
    for (const [id, watcher] of this.watchers) {
      if (watcher.tabId === tabId) {
        this.watchers.delete(id)
        changed = true
      }
    }
    if (changed) await this.save()
    return changed
  }

  async clear(): Promise<void> {
    this.watchers.clear()
    await this.save()
  }

  /**
   * Whether a fire may go out now (per-watcher cooldown, global rate). A
   * fire that may go is counted against the global rate immediately.
   */
  admitFire(watcher: PageWatcher): { ok: true } | { ok: false; reason: string } {
    const now = this.now()
    if (watcher.lastFiredAt !== undefined && now - watcher.lastFiredAt < WATCHER_COOLDOWN_MS) return { ok: false, reason: 'cooldown' }
    while (this.recentFires.length > 0 && now - this.recentFires[0]! >= 60_000) this.recentFires.shift()
    if (this.recentFires.length >= GLOBAL_FIRES_PER_MINUTE) return { ok: false, reason: 'rate-limited' }
    this.recentFires.push(now)
    return { ok: true }
  }

  /** Record a delivered fire; the watcher ends after its last one. */
  async recordFire(id: string): Promise<PageWatcher | undefined> {
    const watcher = this.watchers.get(id)
    if (watcher === undefined) return undefined
    watcher.fires += 1
    watcher.lastFiredAt = this.now()
    delete watcher.lastMiss
    if (watcher.fires >= watcher.maxFires) this.watchers.delete(id)
    await this.save()
    return watcher
  }

  /** Record that a wake could not be delivered. */
  async recordMiss(id: string, reason: string): Promise<void> {
    const watcher = this.watchers.get(id)
    if (watcher === undefined) return
    watcher.lastMiss = reason
    watcher.lastFiredAt = this.now()
    await this.save()
  }
}

function isValidWatcher(value: unknown): value is PageWatcher {
  if (!isRecord(value)) return false
  return nonEmpty(value.id) && nonEmpty(value.sessionId) && typeof value.tabId === 'number'
    && typeof value.origin === 'string' && typeof value.url === 'string' && typeof value.prompt === 'string'
    && typeof value.expiresAt === 'number' && typeof value.maxFires === 'number' && typeof value.fires === 'number'
    && typeof value.createdAt === 'number' && typeof parseWatchConditionShape(value.condition) === 'object'
}

function parseWatchConditionShape(value: unknown): WatchCondition | undefined {
  if (!isRecord(value)) return undefined
  switch (value.kind) {
    case 'selector':
      return nonEmpty(value.selector) ? { kind: 'selector', selector: value.selector, gone: value.gone === true } : undefined
    case 'text':
      return nonEmpty(value.text) ? { kind: 'text', text: value.text, gone: value.gone === true } : undefined
    case 'url':
    case 'network':
      return nonEmpty(value.pattern) ? { kind: value.kind, pattern: value.pattern } : undefined
    default:
      return undefined
  }
}

/** A tool answer (watchers.ts lanes always settle one way or the other). */
export type WatchAnswer = SettledAnswer

/** What the tool handlers need from the background worker. */
export interface WatchToolDeps {
  registry: WatcherRegistry
  enabled: () => boolean
  /** The session's controlled tab, or a failure. */
  resolveTab: (sessionId: string | undefined) => Promise<{ id?: number; url?: string; title?: string; windowId?: number } | { ok: boolean; error?: { message: string } }>
  /** Whether this session may read the given tab (its controlled tab, or one bound to it). */
  allowsTab: (tabId: number, sessionId: string | undefined) => boolean
  getTab: (tabId: number) => Promise<{ id?: number; url?: string; title?: string; windowId?: number } | undefined>
  authorize: (prompt: ApprovalPrompt, windowId: number) => Promise<ApprovalAuthorization>
  /** Push the tab's armed watchers to its content script. */
  arm: (tabId: number) => Promise<void>
  /** Tell open panels the list changed. */
  changed: () => void
  /** Site policy hides the page from the agent (blocked / managed-disallowed). */
  pageHidden?: (url: string) => boolean
  /** Site policy, managed policy and taint for the watched page (a watcher reads it): deny refuses, force adds its reasons. */
  policy?: CallPolicyHook
  /**
   * Check a selector's syntax in the tab's page (the worker has no DOM):
   * resolves an error message for one that can never match, else undefined.
   */
  validateSelector?: (tabId: number, selector: string) => Promise<string | undefined>
  newId?: () => string
  now?: () => number
  signal: AbortSignal
}

/**
 * Page-side syntax check of a watcher selector (run through
 * chrome.scripting in the watched tab). Accepts the shadow-piercing
 * `host >>> inner` form the locator hands out: every part must parse.
 * Must stay self-contained (serialized into the page).
 */
export function selectorSyntaxError(selector: string): string | undefined {
  const parts = selector.split('>>>').map((part) => part.trim())
  if (parts.some((part) => part === '')) return 'has an empty part around >>>'
  for (const part of parts) {
    try {
      document.createDocumentFragment().querySelector(part)
    } catch {
      return `is not a valid CSS selector (${part})`
    }
  }
  return undefined
}

const failed = fail

/** `browser_watch`: approve and record one watcher. */
export async function createWatcher(call: ToolCall, deps: WatchToolDeps): Promise<WatchAnswer> {
  if (!deps.enabled()) {
    return failed('Page watchers are off. The user can turn on "Allow the agent to watch pages" in the extension settings.')
  }
  if (call.sessionId === undefined) return failed('browser_watch needs an agent session to wake.', 'bad-args')
  const request = parseWatchRequest(call.args)
  if (typeof request === 'string') return failed(request, 'bad-args')
  await deps.registry.ready
  if (!deps.registry.hasRoom()) {
    return failed(`At most ${String(MAX_ACTIVE_WATCHERS)} page watchers can be active. Cancel one with browser_watches first.`)
  }
  let tab: { id?: number; url?: string; title?: string; windowId?: number } | undefined
  if (request.tabId !== undefined) {
    if (!deps.allowsTab(request.tabId, call.sessionId)) return failed('That tab is not controlled by this session. Use browser_follow_tab first.')
    tab = await deps.getTab(request.tabId)
    if (tab === undefined) return failed('No tab with that tabId is open.', 'no-active-tab')
  } else {
    const resolved = await deps.resolveTab(call.sessionId)
    if ('ok' in resolved) return failed(resolved.error?.message ?? 'No controlled tab to watch.', 'no-active-tab')
    tab = resolved
  }
  const origin = httpOrigin(tab.url)
  if (tab.id === undefined || tab.url === undefined || origin === undefined) return failed('Only http and https pages can be watched.')
  // A page site policy hides cannot be watched; its address is not echoed back.
  if (deps.pageHidden?.(tab.url) === true) return failed('This page is blocked by site policy, so it cannot be watched.')
  // A selector that can never parse would show a dead watcher until it expires: refuse it before the card.
  if (request.condition.kind === 'selector' && deps.validateSelector !== undefined) {
    const invalid = await deps.validateSelector(tab.id, request.condition.selector)
    if (invalid !== undefined) return failed(`condition.selector ${invalid}.`, 'bad-args')
  }
  // A watcher reads the page: the page's site rules apply like to any read.
  const decision = deps.policy?.(call, { reads: [origin], acts: [], urls: [tab.url], pageOrigin: origin }) ?? { kind: 'default' as const }
  if (decision.kind === 'deny') return failed(decision.message)
  const page = { url: tab.url, origin, ...(tab.title === undefined ? {} : { title: tab.title }) }
  const prompt = watchApprovalPrompt(request, page, decision.kind === 'force' ? { reasons: decision.reasons, ...decision.causes === undefined ? {} : { causes: decision.causes } } : { reasons: [] })
  const authorization = await deps.authorize(prompt, tab.windowId ?? 0)
  if (deps.signal.aborted) return cancelledAnswer()
  if (authorization !== 'approved') return notApprovedAnswer('The user declined the page watcher.', 'The page watcher', authorization)
  if (!deps.registry.hasRoom()) return failed(`At most ${String(MAX_ACTIVE_WATCHERS)} page watchers can be active.`)
  const now = (deps.now ?? Date.now)()
  const watcher: PageWatcher = {
    id: `w-${(deps.newId ?? (() => crypto.randomUUID()))().slice(0, 8)}`,
    sessionId: call.sessionId,
    tabId: tab.id,
    origin,
    url: tab.url,
    condition: request.condition,
    prompt: request.prompt,
    createdAt: now,
    expiresAt: now + request.expiresInMinutes * 60_000,
    maxFires: request.maxFires,
    fires: 0,
  }
  await deps.registry.add(watcher)
  await deps.arm(tab.id).catch(() => {})
  deps.changed()
  return {
    ok: true,
    result: {
      text: `Watching ${tab.url}: ${describeCondition(watcher.condition)}. Watcher ${watcher.id} wakes this session with your prompt when it fires `
        + `(at most ${String(watcher.maxFires)} time${watcher.maxFires === 1 ? '' : 's'}, until ${new Date(watcher.expiresAt).toISOString()}).`,
      watchId: watcher.id,
      expiresAt: watcher.expiresAt,
    },
  }
}

/** `browser_watches`: list or cancel this session's watchers. */
export async function manageWatchers(call: ToolCall, deps: Pick<WatchToolDeps, 'registry' | 'changed' | 'arm' | 'pageHidden'>): Promise<WatchAnswer> {
  await deps.registry.ready
  const action = call.args.action ?? 'list'
  const mine = deps.registry.list().filter((watcher) => watcher.sessionId === call.sessionId)
  if (action === 'cancel') {
    const id = call.args.id
    const watcher = mine.find((candidate) => candidate.id === id)
    if (watcher === undefined) return failed('No watcher of this session has that id.', 'bad-args')
    await deps.registry.remove(watcher.id)
    await deps.arm(watcher.tabId).catch(() => {})
    deps.changed()
    return { ok: true, result: { text: `Cancelled watcher ${watcher.id}.` } }
  }
  if (action !== 'list') return failed('action must be list or cancel.', 'bad-args')
  if (mine.length === 0) return { ok: true, result: { text: 'This session has no active page watchers.' } }
  return {
    ok: true,
    result: {
      text: mine.map((watcher) => `${watcher.id}: ${describeCondition(watcher.condition)} on ${deps.pageHidden?.(watcher.url) === true ? 'a page blocked by site policy (suspended)' : watcher.url}; fired ${String(watcher.fires)}/${String(watcher.maxFires)}; `
        + `expires ${new Date(watcher.expiresAt).toISOString()}${watcher.lastMiss === undefined ? '' : `; last wake missed (${watcher.lastMiss})`}`).join('\n'),
    },
  }
}

/** What the hit handler needs. */
export interface WatchHitDeps {
  registry: WatcherRegistry
  enabled: () => boolean
  /** Kill switch engaged or agent paused / taken over: hold fires. */
  blocked: () => boolean
  /** Whether page content may leave the page. */
  shareContent: () => boolean
  /**
   * Whether site policy hides this page from the agent entirely (blocked, or
   * outside the managed allowlist). Such a watcher is suspended there: it
   * does not fire and its URL is not disclosed.
   */
  pageHidden?: (url: string) => boolean
  /** Ask the bridge to wake the session; resolves with its answer. */
  fire: (payload: Record<string, unknown>) => Promise<unknown>
  /**
   * Give a reconnecting bridge a moment to come back (bounded by the caller).
   * Runs only for a hit that already passed the watcher, sender and
   * enabled/blocked checks, and every one of those checks runs again after
   * it, so nothing is decided on state from before the wait.
   */
  connected?: () => Promise<void>
  /**
   * The tab's address as of now (undefined: the tab is gone or unreadable).
   * Read after {@link connected}: the tab may have navigated during the wait,
   * and the content script's report names the page it was sent from.
   */
  currentUrl?: (tabId: number) => Promise<string | undefined>
  changed: () => void
}

/** Outcome of one reported hit (returned to the content script). */
export interface HitOutcome {
  accepted: boolean
  reason?: string
}

/**
 * A content script (or the URL listener) reported that a watcher's condition
 * holds. Validate everything again here: the content script runs beside an
 * untrusted page.
 */
export async function handleWatchHit(
  hit: { watchId: unknown; matched?: unknown },
  sender: { tabId: number | undefined; url: string | undefined; frameId: number | undefined; urlWatcher?: boolean },
  deps: WatchHitDeps,
): Promise<HitOutcome> {
  await deps.registry.ready
  const watchId = hit.watchId
  if (typeof watchId !== 'string') return { accepted: false, reason: 'bad-request' }
  /** Where the tab is: the reporting page, replaced by the tab's own address after a wait. */
  let senderUrl = sender.url
  /** The watcher this hit may fire, as of now (an expired or spent one is gone from the registry); or why not. */
  const admit = (): PageWatcher | HitOutcome => {
    const found = deps.registry.get(watchId)
    if (found === undefined) return { accepted: false, reason: 'unknown' }
    if (sender.tabId !== found.tabId || (sender.frameId !== undefined && sender.frameId !== 0)) return { accepted: false, reason: 'wrong-tab' }
    // A URL watcher reports from the background and may follow the tab to another site;
    // every other watcher fires only on the origin the user approved.
    if (sender.urlWatcher === true ? found.condition.kind !== 'url' : (found.condition.kind === 'url' || httpOrigin(senderUrl) !== found.origin)) {
      return { accepted: false, reason: 'other-origin' }
    }
    if (!deps.enabled()) return { accepted: false, reason: 'disabled' }
    if (deps.blocked()) return { accepted: false, reason: 'paused' }
    return found
  }
  let watcher = admit()
  if ('accepted' in watcher) return watcher
  if (deps.connected !== undefined) {
    await deps.connected().catch(() => {})
    // The wait took time: the watcher may be gone or expired, the setting off,
    // the agent stopped, and the tab may show another page. Everything below
    // (origin, site policy, the URL sent to the bridge) uses where the tab is now.
    if (deps.currentUrl !== undefined) {
      const current = await deps.currentUrl(watcher.tabId).catch(() => undefined)
      if (current === undefined) return { accepted: false, reason: 'tab-gone' }
      senderUrl = current
    }
    watcher = admit()
    if ('accepted' in watcher) return watcher
  }
  // Site policy as of now, not as of approval: a blocked page suspends the watcher.
  const pageUrl = senderUrl ?? watcher.url
  // A network watcher's match is a request URL, possibly to another (blocked) origin.
  const matchedHidden = watcher.condition.kind !== 'selector' && watcher.condition.kind !== 'text'
    && typeof hit.matched === 'string' && deps.pageHidden?.(hit.matched) === true
  if (deps.pageHidden?.(pageUrl) === true || deps.pageHidden?.(watcher.url) === true || matchedHidden) {
    await deps.registry.recordMiss(watcher.id, 'suspended: the page is blocked by site policy')
    deps.changed()
    return { accepted: false, reason: 'blocked-site' }
  }
  const admitted = deps.registry.admitFire(watcher)
  if (!admitted.ok) return { accepted: false, reason: admitted.reason }
  const matched = deps.shareContent() && typeof hit.matched === 'string' ? hit.matched.slice(0, MAX_MATCHED_CHARS) : undefined
  let answer: unknown
  try {
    answer = await deps.fire({
      watchId: watcher.id,
      sessionId: watcher.sessionId,
      prompt: watcher.prompt,
      condition: describeCondition(watcher.condition),
      url: pageUrl,
      fires: watcher.fires + 1,
      maxFires: watcher.maxFires,
      ...(matched === undefined ? {} : { matched }),
    })
  } catch (error: unknown) {
    await deps.registry.recordMiss(watcher.id, error instanceof Error ? error.message.slice(0, 120) : 'bridge unavailable')
    deps.changed()
    return { accepted: false, reason: 'bridge' }
  }
  const woken = isRecord(answer) && answer.woken === true
  if (!woken) {
    await deps.registry.recordMiss(watcher.id, isRecord(answer) && typeof answer.reason === 'string' ? answer.reason : 'not delivered')
    deps.changed()
    return { accepted: false, reason: isRecord(answer) && typeof answer.reason === 'string' ? answer.reason : 'not-delivered' }
  }
  await deps.registry.recordFire(watcher.id)
  deps.changed()
  return { accepted: true }
}

/** The watchers a tab's content script should observe (URL watchers run in the background). */
export function armedFor(registry: WatcherRegistry, tabId: number, url: string | undefined): ArmedWatch[] {
  const origin = httpOrigin(url)
  return registry.forTab(tabId)
    .filter((watcher) => watcher.origin === origin && watcher.condition.kind !== 'url')
    .map((watcher) => ({ id: watcher.id, condition: watcher.condition, createdAt: watcher.createdAt }))
}

/** URL watchers of a tab whose pattern matches its new URL. */
export function urlHits(registry: WatcherRegistry, tabId: number, url: string): PageWatcher[] {
  return registry.forTab(tabId).filter((watcher) => watcher.condition.kind === 'url' && patternMatcher(watcher.condition.pattern)?.(url) === true)
}

/** What the panel shows for one watcher. */
export function panelView(watcher: PageWatcher): Record<string, unknown> {
  return {
    id: watcher.id,
    sessionId: watcher.sessionId,
    url: watcher.url,
    condition: describeCondition(watcher.condition),
    prompt: watcher.prompt,
    expiresAt: watcher.expiresAt,
    fires: watcher.fires,
    maxFires: watcher.maxFires,
    ...(watcher.lastMiss === undefined ? {} : { lastMiss: watcher.lastMiss }),
  }
}
