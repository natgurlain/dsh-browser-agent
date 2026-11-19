/**
 * Panel ↔ background port client. The panel never touches the bridge or the
 * gateway directly; everything goes through the service worker's port.
 *
 * @module
 */

import type { BridgeCaps, RespondResult } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import type { ServerFrame } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import type { BridgeFailure, BridgeState } from '../background/bridge.ts'
import type { Settings } from '../background/index.ts'
import type { TabAffinityDecision, TabAffinityState } from '../background/tab-affinity.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { parsePageSelection, type PageSelection } from '../selection.ts'
import { getUiLocale } from '../i18n.ts'

/** Panel-side subset of the extension settings. */
export type PanelSettings = Settings

interface RpcFailurePayload {
  code?: unknown
  message?: unknown
  details?: unknown
}

interface RpcResultMessage {
  type: 'rpc.result'
  id: string
  ok: boolean
  result?: unknown
  error?: RpcFailurePayload
}

interface RespondResultMessage {
  type: 'respond.result'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface SettingsResultMessage {
  type: 'settings.result'
  id: string
  ok: boolean
  error?: { message?: unknown }
}

/** Discovery state the background reports alongside the transport state. */
export type DiscoveryStatus = 'idle' | 'running' | 'found' | 'not-found'

/** Where one discovered instance came from. */
export type BridgeInstanceSource = 'fixed' | 'beacon'

/** One local dsh instance the background found. */
export interface BridgeInstance {
  wsUrl: string
  port: number
  sources: BridgeInstanceSource[]
  pid?: number
  startedAt?: string
}

/** Progress of one manual detection pass. */
export interface DiscoveryProgress {
  done: number
  total: number
  instances: BridgeInstance[]
}

/** Unattended work that keeps the browser connected with no panel open (background standing-work.ts). */
export interface StandingStatus {
  watchers: number
  schedules: number
  mcp: boolean
}

/** Read the status payload's `standing`; anything malformed or empty is "none". */
export function parseStandingStatus(value: unknown): StandingStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { watchers, schedules, mcp } = value as Record<string, unknown>
  const count = (raw: unknown): number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0
  const standing = { watchers: count(watchers), schedules: count(schedules), mcp: mcp === true }
  return standing.watchers > 0 || standing.schedules > 0 || standing.mcp ? standing : undefined
}

interface StatusMessage {
  type: 'status'
  state: BridgeState
  caps: BridgeCaps | null
  discovery?: DiscoveryStatus
  address?: string
  /** Why the bridge refused the last attempt (token, version, extension ID). */
  failure?: BridgeFailure
  standing?: unknown
}

interface DiscoveryProgressMessage {
  type: 'discovery.progress'
  id: string
  done: number
  total: number
  instances: BridgeInstance[]
}

interface DiscoveryResultMessage {
  type: 'discovery.result'
  id: string
  ok: boolean
  instances?: BridgeInstance[]
  error?: { code?: unknown; message?: unknown }
}

interface PairCodeMessage {
  type: 'pair.code'
  id: string
  /** The code to display while the request waits for the user to enter it in DSH. */
  code: string
}

interface PairResultMessage {
  type: 'pair.result'
  id: string
  ok: boolean
  /** A `PairingFailure` from the background (pairing.ts). */
  reason?: unknown
}

interface EventMessage {
  type: 'event'
  frame: ServerFrame
}

interface ApprovalRequestMessage {
  type: 'approval.request'
  request: ApprovalRequest
}

interface ApprovalResolvedMessage {
  type: 'approval.resolved'
  id: string
}

interface TabAffinityMessage {
  type: 'tab-affinity'
  state: TabAffinityState
}

interface TabAffinityRebindResultMessage {
  type: 'tab-affinity.rebind.result'
  id: string
  ok: boolean
  error?: { code: string; message: string }
}

interface TabAffinityReturnResultMessage {
  type: 'tab-affinity.return.result'
  id: string
  ok: boolean
  error?: { code: string; message: string }
}

interface SelectionMessage {
  type: 'selection'
  selection: unknown
}

interface SessionResumeHintMessage {
  type: 'session.resume-hint'
  sessionId: string | null
}

/** Developer-tools availability and attachment state reported by the background. */
export interface DevToolsStatus {
  supported: boolean
  enabled: boolean
  attached: boolean
  tabId?: number
  error?: string
}

interface DevToolsStatusMessage extends DevToolsStatus {
  type: 'devtools.status'
}

/** Kill-switch state: engaged means every agent capability is cut off. */
interface KillSwitchMessage {
  type: 'kill-switch'
  engaged: boolean
}

/** Auto approve (docs/auto-approve-design.md) as the background reports it. */
export interface AutoReviewState {
  /** Auto approve can be used (settings loaded, not turned off by the administrator). */
  offered: boolean
  /** Why not, when it is not offered. */
  unavailable?: 'managed' | 'loading'
  /** "Start conversations in Auto approve": conversations without a choice are on. */
  startOn: boolean
  /** The bridge can review consequential steps now. */
  reviewer: boolean
  /** The user's explicit choice per conversation (true: on). */
  sessions: Record<string, boolean>
  /** Conversations prompted or created from the side panel: only these follow `startOn`. */
  panel: string[]
}

/** A review is running (or finished) for one step. */
export interface AutoReviewing {
  sessionId: string
  toolCallId?: string
  label: string
  active: boolean
}

/** Read the background's Auto approve state defensively. */
export function parseAutoReviewState(value: unknown): AutoReviewState {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const sessions: AutoReviewState['sessions'] = {}
  if (typeof raw.sessions === 'object' && raw.sessions !== null) {
    for (const [id, on] of Object.entries(raw.sessions as Record<string, unknown>)) {
      if (typeof on === 'boolean') sessions[id] = on
    }
  }
  const unavailable = raw.unavailable
  return {
    offered: raw.offered === true,
    ...unavailable === 'managed' || unavailable === 'loading' ? { unavailable } : {},
    startOn: raw.startOn === true,
    reviewer: raw.reviewer === true,
    sessions,
    panel: Array.isArray(raw.panel) ? raw.panel.filter((id): id is string => typeof id === 'string') : [],
  }
}

/** Pause / take-over state of the agent's browser actions. */
export interface AgentPauseState {
  mode: 'running' | 'paused' | 'taken-over' | 'resuming'
  since?: number
  tookOver?: boolean
  held: Array<{ id: string; name: string; sessionId?: string; heldAt: number }>
}

interface PauseStateMessage {
  type: 'agent.pause-state'
  state: AgentPauseState
}

/** Parse a pause state from the background, falling back to running. */
export function parsePauseState(value: unknown): AgentPauseState {
  if (typeof value !== 'object' || value === null) return { mode: 'running', held: [] }
  const raw = value as { mode?: unknown; since?: unknown; tookOver?: unknown; held?: unknown }
  const mode = raw.mode === 'paused' || raw.mode === 'taken-over' || raw.mode === 'resuming' ? raw.mode : 'running'
  const held = Array.isArray(raw.held)
    ? raw.held.filter((entry): entry is AgentPauseState['held'][number] => typeof entry === 'object' && entry !== null
      && typeof (entry as { id?: unknown }).id === 'string' && typeof (entry as { name?: unknown }).name === 'string')
    : []
  return {
    mode,
    ...(typeof raw.since === 'number' ? { since: raw.since } : {}),
    ...(raw.tookOver === true ? { tookOver: true } : {}),
    held,
  }
}

interface DevToolsDetachResultMessage {
  type: 'devtools.detach.result'
  id: string
  ok: boolean
  error?: { message?: unknown }
}

type BackgroundMessage = RpcResultMessage | RespondResultMessage | SettingsResultMessage | StatusMessage | EventMessage | ApprovalRequestMessage | ApprovalResolvedMessage | TabAffinityMessage | TabAffinityRebindResultMessage | TabAffinityReturnResultMessage | SelectionMessage | SessionResumeHintMessage | DevToolsStatusMessage | DevToolsDetachResultMessage | DiscoveryProgressMessage | DiscoveryResultMessage | PairCodeMessage | PairResultMessage | KillSwitchMessage | PauseStateMessage | AutoReviewStateMessage | AutoReviewingMessage

interface AutoReviewStateMessage {
  type: 'auto-review.state'
  offered?: unknown
  unavailable?: unknown
  startOn?: unknown
  reviewer?: unknown
  sessions?: unknown
}

interface AutoReviewingMessage {
  type: 'auto-review.reviewing'
  sessionId?: unknown
  toolCallId?: unknown
  label?: unknown
  active?: unknown
}

/** Structured gateway failure retained for product-level error handling. */
export class PanelRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = {},
  ) {
    super(message)
    this.name = 'PanelRpcError'
  }
}

function panelRpcError(failure: RpcFailurePayload | undefined, fallbackMessage: string): PanelRpcError {
  return new PanelRpcError(
    typeof failure?.code === 'string' ? failure.code : 'rpc-failed',
    typeof failure?.message === 'string' ? failure.message : fallbackMessage,
    failure?.details ?? {},
  )
}

/** The panel API surface. */
export interface PanelApi {
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
  respond(rpcId: string, result: RespondResult): Promise<unknown>
  onStatus(callback: (state: BridgeState, caps: BridgeCaps | null, discovery: DiscoveryStatus, address?: string, failure?: BridgeFailure, standing?: StandingStatus) => void): () => void
  onEvent(callback: (frame: ServerFrame) => void): () => void
  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void
  onApprovalResolved(callback: (id: string) => void): () => void
  onTabAffinity(callback: (state: TabAffinityState) => void): () => void
  onSelection(callback: (selection: PageSelection | null) => void): () => void
  onSessionResumeHint(callback: (sessionId: string | null) => void): () => void
  onDevToolsStatus(callback: (status: DevToolsStatus) => void): () => void
  /** Detach the debugger now, keeping the developer-tools setting as it is. */
  detachDevTools(): Promise<void>
  respondToApproval(id: string, decision: ApprovalDecision): Promise<void>
  resolveTabAffinity(revision: number, decision: TabAffinityDecision, sessionId: string | null): Promise<void>
  rebindTabAffinity(): Promise<void>
  /**
   * Move the user's visible tab back to the page the assistant is bound to.
   *
   * `revision` is the affinity state the panel acted on; the background refuses
   * a stale value so an outdated button cannot jump the user's page, and the
   * rejection carries `code: 'stale-revision'` for the caller to ignore.
   */
  returnToControlledTab(revision: number): Promise<void>
  /** Clear all selection state, or only the exact selection supplied. */
  clearSelection(selection?: PageSelection): Promise<void>
  /** Enumerate every local dsh instance; progress streams through {@link onDiscoveryProgress}. */
  startDiscovery(): Promise<BridgeInstance[]>
  /** Abort a running scan; the pending {@link startDiscovery} rejects as cancelled. */
  cancelDiscovery(): Promise<void>
  onDiscoveryProgress(callback: (progress: DiscoveryProgress) => void): () => void
  /**
   * Ask the local DSH host to pair. `onCode` receives the code to display
   * while the request waits for the user to type it into DSH. Resolves once
   * the token is stored; rejects with a {@link PanelRpcError} whose `code` is
   * the background's `PairingFailure`. An install that already holds a token
   * is refused (`has-token`) unless `again` is set, which the panel does only
   * after the user confirmed "Pair again…". `auto` marks a request nobody
   * clicked for; the background allows only a few of those per sitting.
   */
  pair(onCode: (code: string) => void, options?: { again?: boolean; auto?: boolean }): Promise<void>
  /** Withdraw a pairing request that is still waiting. */
  cancelPairing(): Promise<void>
  /** Scope this panel's selections to its own browser window. */
  registerWindow(windowId: number): Promise<void>
  setActiveSession(sessionId: string, isNew?: boolean): Promise<void>
  updateSettings(settings: Partial<PanelSettings>): Promise<void>
  requestStatus(): Promise<void>
  /**
   * Stop the agent now: cancel approvals and in-flight tool calls, revoke
   * session trust and developer-tools grants, detach the debugger, and drop
   * the bridge until {@link releaseKillSwitch}.
   */
  engageKillSwitch(): Promise<void>
  /** Clear an engaged kill switch and reconnect. */
  releaseKillSwitch(): Promise<void>
  onKillSwitch(callback: (engaged: boolean) => void): () => void
  /** Hold the next browser action ("after-step") or hand the page to the user ("take-over"). */
  pauseAgent(mode: 'after-step' | 'take-over'): Promise<void>
  /** Tell the agent what changed while paused, then release held actions. */
  resumeAgent(): Promise<void>
  onPauseState(callback: (state: AgentPauseState) => void): () => void
  /** Turn Auto approve on or off for one conversation. */
  setAutoReview(sessionId: string, enabled: boolean): Promise<void>
  onAutoReviewState(callback: (state: AutoReviewState) => void): () => void
  onAutoReviewing(callback: (reviewing: AutoReviewing) => void): () => void
}

/** Connect to the background service worker and return the panel API. */
export function connectPanel(): PanelApi {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const pendingResponses = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingSettings = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const pendingRebinds = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const pendingReturns = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const statusListeners = new Set<(state: BridgeState, caps: BridgeCaps | null, discovery: DiscoveryStatus, address?: string, failure?: BridgeFailure, standing?: StandingStatus) => void>()
  const discoveryProgressListeners = new Set<(progress: DiscoveryProgress) => void>()
  const pendingScans = new Map<string, { resolve: (instances: BridgeInstance[]) => void; reject: (error: Error) => void }>()
  const pendingPairs = new Map<string, { resolve: () => void; reject: (error: Error) => void; onCode: (code: string) => void }>()
  const eventListeners = new Set<(frame: ServerFrame) => void>()
  const approvalListeners = new Set<(request: ApprovalRequest) => void>()
  const approvalResolvedListeners = new Set<(id: string) => void>()
  const tabAffinityListeners = new Set<(state: TabAffinityState) => void>()
  const selectionListeners = new Set<(selection: PageSelection | null) => void>()
  const sessionResumeHintListeners = new Set<(sessionId: string | null) => void>()
  const devToolsStatusListeners = new Set<(status: DevToolsStatus) => void>()
  const killSwitchListeners = new Set<(engaged: boolean) => void>()
  const autoReviewStateListeners = new Set<(state: AutoReviewState) => void>()
  // The control mounts after the status that carried the state: replay the latest one to it.
  let lastAutoReviewState: AutoReviewState | undefined
  const autoReviewingListeners = new Set<(reviewing: AutoReviewing) => void>()
  const pauseStateListeners = new Set<(state: AgentPauseState) => void>()
  const pendingDetaches = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()

  let port: chrome.runtime.Port | null = null
  let reconnectPromise: Promise<chrome.runtime.Port> | null = null

  function onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const msg = message as BackgroundMessage
    switch (msg.type) {
      case 'rpc.result': {
        const entry = pending.get(msg.id)
        if (entry === undefined) return
        pending.delete(msg.id)
        // The bridge relays the gateway's ServerResponse envelope verbatim
        // ({ type, rpcId, result: { ok, value | error } }); unwrap the value
        // so callers get the business payload, and surface business errors.
        const envelope = msg.result as { result?: { ok?: boolean; value?: unknown; error?: RpcFailurePayload } } | undefined
        const business = envelope?.result
        if (msg.ok && business?.ok !== false) entry.resolve(business?.value)
        else entry.reject(panelRpcError(
          business?.ok === false ? business.error : msg.error,
          getUiLocale() === 'zh' ? 'RPC 请求失败' : 'RPC request failed',
        ))
        break
      }
      case 'respond.result': {
        const entry = pendingResponses.get(msg.id)
        if (entry === undefined) return
        pendingResponses.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error?.message
          ?? (getUiLocale() === 'zh' ? '回答提交失败' : 'Failed to send the answer')))
        break
      }
      case 'settings.result': {
        const entry = pendingSettings.get(msg.id)
        if (entry === undefined) return
        pendingSettings.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new Error(typeof msg.error?.message === 'string'
          ? msg.error.message
          : (getUiLocale() === 'zh' ? '保存设置失败' : 'Failed to save settings')))
        break
      }
      case 'status':
        for (const listener of statusListeners) {
          listener(
            msg.state,
            msg.caps,
            msg.discovery ?? 'idle',
            typeof msg.address === 'string' ? msg.address : undefined,
            typeof msg.failure === 'string' ? msg.failure : undefined,
            parseStandingStatus(msg.standing),
          )
        }
        break
      case 'discovery.progress':
        for (const listener of discoveryProgressListeners) {
          listener({ done: msg.done, total: msg.total, instances: msg.instances })
        }
        break
      case 'discovery.result': {
        const entry = pendingScans.get(msg.id)
        if (entry === undefined) return
        pendingScans.delete(msg.id)
        if (msg.ok) entry.resolve(msg.instances ?? [])
        else entry.reject(new PanelRpcError(
          typeof msg.error?.code === 'string' ? msg.error.code : 'scan-failed',
          typeof msg.error?.message === 'string'
            ? msg.error.message
            : (getUiLocale() === 'zh' ? '自动检测失败' : 'Detection failed'),
        ))
        break
      }
      case 'pair.code':
        if (typeof msg.code === 'string') pendingPairs.get(msg.id)?.onCode(msg.code)
        break
      case 'pair.result': {
        const entry = pendingPairs.get(msg.id)
        if (entry === undefined) return
        pendingPairs.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new PanelRpcError(typeof msg.reason === 'string' ? msg.reason : 'unreachable', 'pairing failed'))
        break
      }
      case 'event':
        for (const listener of eventListeners) listener(msg.frame)
        break
      case 'approval.request':
        for (const listener of approvalListeners) listener(msg.request)
        break
      case 'approval.resolved':
        for (const listener of approvalResolvedListeners) listener(msg.id)
        break
      case 'tab-affinity':
        for (const listener of tabAffinityListeners) listener(msg.state)
        break
      case 'selection': {
        // The page owns this text; validate it again on the way into the UI.
        const selection = parsePageSelection(msg.selection)
        for (const listener of selectionListeners) listener(selection)
        break
      }
      case 'tab-affinity.rebind.result': {
        const entry = pendingRebinds.get(msg.id)
        if (entry === undefined) return
        pendingRebinds.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new Error(msg.error?.message
          ?? (getUiLocale() === 'zh' ? '无法绑定当前标签页' : 'Failed to bind the current tab')))
        break
      }
      case 'tab-affinity.return.result': {
        const entry = pendingReturns.get(msg.id)
        if (entry === undefined) return
        pendingReturns.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new PanelRpcError(
          typeof msg.error?.code === 'string' ? msg.error.code : 'return-failed',
          msg.error?.message
            ?? (getUiLocale() === 'zh' ? '无法跳转回助手页面' : 'Failed to jump back to the assistant page'),
        ))
        break
      }
      case 'session.resume-hint':
        for (const listener of sessionResumeHintListeners) listener(msg.sessionId)
        break
      case 'kill-switch':
        for (const listener of killSwitchListeners) listener(msg.engaged === true)
        break
      case 'auto-review.state': {
        const state = parseAutoReviewState(msg)
        lastAutoReviewState = state
        for (const listener of autoReviewStateListeners) listener(state)
        break
      }
      case 'auto-review.reviewing': {
        if (typeof msg.sessionId !== 'string' || typeof msg.label !== 'string') break
        const reviewing: AutoReviewing = {
          sessionId: msg.sessionId,
          ...typeof msg.toolCallId === 'string' ? { toolCallId: msg.toolCallId } : {},
          label: msg.label,
          active: msg.active === true,
        }
        for (const listener of autoReviewingListeners) listener(reviewing)
        break
      }
      case 'agent.pause-state': {
        const state = parsePauseState(msg.state)
        for (const listener of pauseStateListeners) listener(state)
        break
      }
      case 'devtools.status':
        for (const listener of devToolsStatusListeners) listener({
          supported: msg.supported === true,
          enabled: msg.enabled === true,
          attached: msg.attached === true,
          ...(typeof msg.tabId === 'number' ? { tabId: msg.tabId } : {}),
          ...(typeof msg.error === 'string' ? { error: msg.error } : {}),
        })
        break
      case 'devtools.detach.result': {
        const entry = pendingDetaches.get(msg.id)
        if (entry === undefined) return
        pendingDetaches.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new Error(typeof msg.error?.message === 'string'
          ? msg.error.message
          : (getUiLocale() === 'zh' ? '无法断开调试器' : 'Failed to detach the debugger')))
        break
      }
    }
  }

  function connectionError(cause?: unknown): Error {
    const fallback = getUiLocale() === 'zh' ? '后台连接已断开' : 'Background connection lost'
    return cause instanceof Error ? cause : new Error(fallback)
  }

  function failAll(error: Error, preserve?: { kind: 'rpc' | 'respond' | 'rebind' | 'return' | 'settings' | 'devtools' | 'scan'; id: string }): void {
    for (const [id, entry] of pending) {
      if (preserve?.kind === 'rpc' && preserve.id === id) continue
      entry.reject(error)
      pending.delete(id)
    }
    for (const [id, entry] of pendingResponses) {
      if (preserve?.kind === 'respond' && preserve.id === id) continue
      clearTimeout(entry.timer)
      entry.reject(error)
      pendingResponses.delete(id)
    }
    for (const [id, entry] of pendingRebinds) {
      if (preserve?.kind === 'rebind' && preserve.id === id) continue
      entry.reject(error)
      pendingRebinds.delete(id)
    }
    for (const [id, entry] of pendingReturns) {
      if (preserve?.kind === 'return' && preserve.id === id) continue
      entry.reject(error)
      pendingReturns.delete(id)
    }
    for (const [id, entry] of pendingSettings) {
      if (preserve?.kind === 'settings' && preserve.id === id) continue
      entry.reject(error)
      pendingSettings.delete(id)
    }
    for (const [id, entry] of pendingDetaches) {
      if (preserve?.kind === 'devtools' && preserve.id === id) continue
      entry.reject(error)
      pendingDetaches.delete(id)
    }
    // A pairing cut off with its port is not replayed: the user asks again.
    for (const [id, entry] of pendingPairs) {
      entry.reject(error)
      pendingPairs.delete(id)
    }
    for (const [id, entry] of pendingScans) {
      if (preserve?.kind === 'scan' && preserve.id === id) continue
      entry.reject(error)
      pendingScans.delete(id)
    }
  }

  function attach(next: chrome.runtime.Port): chrome.runtime.Port {
    port = next
    next.onMessage.addListener(onMessage)
    next.onDisconnect.addListener(() => {
      if (port !== next) return
      port = null
      failAll(connectionError())
      // Firefox event pages and extension reloads can invalidate a live Port.
      // Reconnect once while the panel is still open; later sends share the
      // same attempt instead of opening competing ports.
      void ensurePort(150).catch(() => {})
    })
    return next
  }

  function ensurePort(delayMs = 0): Promise<chrome.runtime.Port> {
    if (port !== null) return Promise.resolve(port)
    if (reconnectPromise !== null) return reconnectPromise

    const attempt = new Promise<void>((resolve) => { setTimeout(resolve, delayMs) })
      .then(() => port ?? attach(chrome.runtime.connect({ name: 'dsh-panel' })))
    reconnectPromise = attempt
    void attempt.then(
      () => { if (reconnectPromise === attempt) reconnectPromise = null },
      () => { if (reconnectPromise === attempt) reconnectPromise = null },
    )
    return attempt
  }

  function invalidate(
    stale: chrome.runtime.Port,
    error: Error,
    preserve?: { kind: 'rpc' | 'respond' | 'rebind' | 'return' | 'settings' | 'devtools' | 'scan'; id: string },
  ): void {
    if (port !== stale) return
    port = null
    failAll(error, preserve)
  }

  /**
   * Post once on the live port. Calls made during reconnect wait for the shared
   * replacement; a synchronous stale-port failure retries only the message
   * that is known not to have been accepted. Requests already accepted by the
   * old port are rejected by invalidate() and are never replayed.
   */
  function send(
    message: unknown,
    preserve?: { kind: 'rpc' | 'respond' | 'rebind' | 'return' | 'settings' | 'devtools' | 'scan'; id: string },
  ): Promise<void> {
    const current = port
    if (current !== null) {
      try {
        current.postMessage(message)
        return Promise.resolve()
      } catch (cause) {
        invalidate(current, connectionError(cause), preserve)
      }
    }

    return ensurePort(150).then((next) => {
      try {
        next.postMessage(message)
      } catch (cause) {
        const error = connectionError(cause)
        invalidate(next, error)
        throw error
      }
    })
  }

  try {
    attach(chrome.runtime.connect({ name: 'dsh-panel' }))
  } catch {
    void ensurePort(150).catch(() => {})
  }

  return {
    rpc<T>(method: string, payload?: unknown): Promise<T> {
      const id = crypto.randomUUID()
      return new Promise<T>((resolve, reject) => {
        const entry = { resolve: (value: unknown) => resolve(value as T), reject }
        pending.set(id, entry)
        void send(
          { type: 'rpc', id, method, payload },
          { kind: 'rpc', id },
        ).catch((error: unknown) => {
          if (pending.get(id) !== entry) return
          pending.delete(id)
          reject(connectionError(error))
        })
      })
    },
    respond(rpcId, result) {
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id)
          reject(new Error(getUiLocale() === 'zh' ? '回答提交超时，请重试' : 'Sending the answer timed out. Try again.'))
        }, 35_000)
        const entry = { resolve, reject, timer }
        pendingResponses.set(id, entry)
        void send(
          { type: 'respond', id, rpcId, result },
          { kind: 'respond', id },
        ).catch((error: unknown) => {
          if (pendingResponses.get(id) !== entry) return
          pendingResponses.delete(id)
          clearTimeout(timer)
          reject(connectionError(error))
        })
      })
    },
    onStatus(callback) {
      statusListeners.add(callback)
      return () => { statusListeners.delete(callback) }
    },
    onEvent(callback) {
      eventListeners.add(callback)
      return () => { eventListeners.delete(callback) }
    },
    onApprovalRequest(callback) {
      approvalListeners.add(callback)
      return () => { approvalListeners.delete(callback) }
    },
    onApprovalResolved(callback) {
      approvalResolvedListeners.add(callback)
      return () => { approvalResolvedListeners.delete(callback) }
    },
    onTabAffinity(callback) {
      tabAffinityListeners.add(callback)
      return () => { tabAffinityListeners.delete(callback) }
    },
    onSelection(callback) {
      selectionListeners.add(callback)
      return () => { selectionListeners.delete(callback) }
    },
    onSessionResumeHint(callback) {
      sessionResumeHintListeners.add(callback)
      return () => { sessionResumeHintListeners.delete(callback) }
    },
    onDevToolsStatus(callback) {
      devToolsStatusListeners.add(callback)
      return () => { devToolsStatusListeners.delete(callback) }
    },
    detachDevTools() {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingDetaches.set(id, entry)
        void send(
          { type: 'devtools.detach', id },
          { kind: 'devtools', id },
        ).catch((cause: unknown) => {
          if (pendingDetaches.get(id) !== entry) return
          pendingDetaches.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    respondToApproval(id, decision) {
      return send({ type: 'approval.response', id, decision })
    },
    resolveTabAffinity(revision, decision, sessionId) {
      return send({ type: 'tab-affinity.response', revision, decision, sessionId })
    },
    rebindTabAffinity() {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingRebinds.set(id, entry)
        void send(
          { type: 'tab-affinity.rebind', id },
          { kind: 'rebind', id },
        ).catch((cause: unknown) => {
          if (pendingRebinds.get(id) !== entry) return
          pendingRebinds.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    returnToControlledTab(revision) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingReturns.set(id, entry)
        void send(
          { type: 'tab-affinity.return', id, revision },
          { kind: 'return', id },
        ).catch((cause: unknown) => {
          if (pendingReturns.get(id) !== entry) return
          pendingReturns.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    clearSelection(selection) {
      return send({ type: 'selection.clear', ...(selection === undefined ? {} : { selection }) })
    },
    registerWindow(windowId) {
      return send({ type: 'panel.window', windowId })
    },
    setActiveSession(sessionId, isNew) {
      return send({ type: 'session.active', sessionId, isNew })
    },
    updateSettings(next) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingSettings.set(id, entry)
        void send(
          { type: 'settings', id, settings: next },
          { kind: 'settings', id },
        ).catch((cause: unknown) => {
          if (pendingSettings.get(id) !== entry) return
          pendingSettings.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    requestStatus() {
      return send({ type: 'request-status' })
    },
    engageKillSwitch() {
      return send({ type: 'kill-switch.engage' })
    },
    releaseKillSwitch() {
      return send({ type: 'kill-switch.release' })
    },
    onKillSwitch(callback) {
      killSwitchListeners.add(callback)
      return () => { killSwitchListeners.delete(callback) }
    },
    pauseAgent(mode) {
      return send({ type: 'agent.pause', mode })
    },
    resumeAgent() {
      return send({ type: 'agent.resume' })
    },
    onPauseState(callback) {
      pauseStateListeners.add(callback)
      return () => { pauseStateListeners.delete(callback) }
    },
    setAutoReview(sessionId, enabled) {
      return send({ type: 'auto-review.set', sessionId, enabled })
    },
    onAutoReviewState(callback) {
      autoReviewStateListeners.add(callback)
      if (lastAutoReviewState !== undefined) callback(lastAutoReviewState)
      return () => { autoReviewStateListeners.delete(callback) }
    },
    onAutoReviewing(callback) {
      autoReviewingListeners.add(callback)
      return () => { autoReviewingListeners.delete(callback) }
    },
    startDiscovery() {
      const id = crypto.randomUUID()
      return new Promise<BridgeInstance[]>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingScans.set(id, entry)
        void send(
          { type: 'discovery.start', id },
          { kind: 'scan', id },
        ).catch((cause: unknown) => {
          if (pendingScans.get(id) !== entry) return
          pendingScans.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    cancelDiscovery() {
      return send({ type: 'discovery.cancel' })
    },
    onDiscoveryProgress(callback) {
      discoveryProgressListeners.add(callback)
      return () => { discoveryProgressListeners.delete(callback) }
    },
    pair(onCode, options) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject, onCode }
        pendingPairs.set(id, entry)
        void send({ type: 'pair.start', id, ...(options?.again === true ? { again: true } : {}), ...(options?.auto === true ? { auto: true } : {}) }).catch((cause: unknown) => {
          if (pendingPairs.get(id) !== entry) return
          pendingPairs.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    cancelPairing() {
      return send({ type: 'pair.cancel' })
    },
  }
}
