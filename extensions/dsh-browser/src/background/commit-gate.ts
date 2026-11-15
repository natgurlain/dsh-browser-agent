/**
 * Strict mode: a commit-point gate on outgoing writes (Phase 2.3).
 *
 * When strict mode covers a tab (a strict site pattern matches its page, or
 * the user turned strict mode on for the agent session), the tab's debugger
 * enables the CDP Fetch domain at the Request stage. Every paused request is
 * classified:
 *
 * - reads (GET, HEAD, OPTIONS) continue at once;
 * - writes (POST, PUT, PATCH, DELETE, and any other method, which covers form
 *   submissions) continue at once when the tab is outside an agent turn — the
 *   user is driving. A turn starts with an agent call on the tab and lasts
 *   until the extension sees the turn end (`turn/end`, or a takeover) plus
 *   {@link AGENT_TURN_GRACE_MS}; unseen, it lasts {@link AGENT_TURN_MAX_IDLE_MS}
 *   after the last call, so page timers cannot simply wait out a fixed grace;
 * - tabs the controlled tab opens during a turn (Shift/Ctrl-click,
 *   `target=_blank`, `window.open`) are armed too and share the turn
 *   ({@link CommitGate.adoptOpened});
 * - writes during an agent turn pause behind an approval card: "This will send
 *   <fields> to <origin/path>", listing every field in full (scrollable), with
 *   sensitive ones in a separate block masked until the user reveals them. Allow continues the
 *   request; anything else (deny, timeout, panel gone, error) fails it with
 *   `BlockedByClient`. Every paused request is settled exactly once.
 *
 * Fail closed: before each agent call on a strict tab the gate is (re)armed;
 * when the debugger cannot attach, or was detached by another feature, the
 * call is refused instead of running unguarded.
 *
 * Limits (documented, not bugs): WebSocket frames and `navigator.sendBeacon`
 * are not interceptable here; a write a page timer fires after the turn and
 * its grace have ended is treated as the user's; a new tab's very first
 * request can race the gate's attachment (a POST navigation `target=_blank`
 * form may slip through); out-of-process iframes (cross-site frames under
 * site isolation) and service-worker-initiated requests are not paused by a
 * page-target Fetch session; the debugger shows Chrome's "being debugged" bar;
 * Firefox has no debugger API, so strict mode is unavailable there.
 *
 * @module
 */

import type { DebuggerBroker, DebuggerLease } from './debugger-broker.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { approvalBinding, sha256Hex } from '../security/payload-binding.ts'

/** How long after the agent's turn ends its page writes still count as the agent's. */
export const AGENT_TURN_GRACE_MS = 3_000
/**
 * Upper bound on an agent turn the gate has not seen end (no `turn/end`
 * reached the extension): writes up to this long after the last agent call
 * still count as the agent's, so a page timer cannot outwait a fixed 3 s.
 */
export const AGENT_TURN_MAX_IDLE_MS = 60_000
/**
 * Longest raw text body or field value shown on the card. Beyond it the card
 * says how much was left out, so nothing is ever dropped silently.
 */
const MAX_SHOWN_CHARS = 64 * 1024
/** Most fields listed on the card; the rest are counted, never dropped silently. */
const MAX_FIELDS = 2_000

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SENSITIVE_FIELD = /pass|pwd|secret|token|auth|session|cookie|card|cc-?num|cvv|cvc|csc|ssn|iban|routing|account.?num|pin\b|otp|2fa|mfa|private|api.?key|credential/i

export const STRICT_MODE_UNAVAILABLE = 'Strict mode needs the Chrome debugger (CDP Fetch); it is unavailable in this browser (Firefox has no debugger API).'

/** The subset of a CDP `Fetch.requestPaused` event the gate reads. */
export interface PausedRequest {
  requestId: string
  request: {
    url: string
    method: string
    headers?: Record<string, string>
    postData?: string
    hasPostData?: boolean
  }
  resourceType?: string
}

/** Whether a method sends data that can change server state. */
export function isMutatingMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase())
}

function header(headers: Record<string, string> | undefined, name: string): string {
  if (headers === undefined) return ''
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
  return key === undefined ? '' : headers[key] ?? ''
}

function capped(value: string): string {
  return value.length <= MAX_SHOWN_CHARS
    ? value
    : `${value.slice(0, MAX_SHOWN_CHARS)}… (${value.length - MAX_SHOWN_CHARS} more characters not shown)`
}

interface FieldLine { line: string; sensitive: boolean }

function field(name: string, value: string): FieldLine {
  return { line: `${name} = ${JSON.stringify(capped(value))}`, sensitive: SENSITIVE_FIELD.test(name) }
}

/**
 * Human-readable body summary. `text` lists every ordinary field in full;
 * `sensitiveText` lists the sensitive ones (password, card, token…), which
 * the card shows masked until the user reveals them.
 */
export interface BodySummary {
  text: string
  sensitiveText?: string
  fields: number
  sensitive: boolean
}

/**
 * Summarize a request body for the approval card: form, JSON, and multipart
 * bodies become `name = value` lines (sensitive names masked); other text is
 * shown in full (up to a stated cap); binary or unavailable bodies are described by size.
 */
export function summarizeRequestBody(request: PausedRequest['request']): BodySummary {
  const contentType = header(request.headers, 'content-type').toLowerCase()
  const body = request.postData
  if (body === undefined) {
    return {
      text: request.hasPostData === true
        ? 'The request body is not available for inspection (large or streamed upload); allowing sends it unseen.'
        : '(no body)',
      fields: 0,
      sensitive: request.hasPostData === true,
    }
  }
  const lines: FieldLine[] = []
  if (contentType.includes('application/x-www-form-urlencoded')) {
    for (const [name, value] of new URLSearchParams(body)) lines.push(field(name, value))
  } else if (contentType.includes('json') || /^\s*[[{]/.test(body)) {
    try {
      flattenJson(JSON.parse(body), '', lines, 0)
    } catch {
      lines.push({ line: capped(body), sensitive: SENSITIVE_FIELD.test(body) })
    }
  } else if (contentType.includes('multipart/form-data')) {
    for (const part of body.split(/\r?\n--/)) {
      const name = /name="([^"]*)"/i.exec(part)?.[1]
      if (name === undefined) continue
      const filename = /filename="([^"]*)"/i.exec(part)?.[1]
      const value = part.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/\r?\n$/, '')
      lines.push(filename === undefined ? field(name, value) : { line: `${name} = file ${JSON.stringify(filename)} (${value.length} bytes)`, sensitive: false })
    }
  } else {
    const printable = /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(body)
    if (!printable) return { text: `${body.length} bytes of ${contentType || 'binary data'}`, fields: 0, sensitive: false }
    return SENSITIVE_FIELD.test(body)
      ? { text: '(raw text body, shown masked below)', sensitiveText: capped(body), fields: 0, sensitive: true }
      : { text: capped(body), fields: 0, sensitive: false }
  }
  if (lines.length === 0) return { text: '(empty body)', fields: 0, sensitive: false }
  const shown = lines.slice(0, MAX_FIELDS)
  const more = lines.length - shown.length
  const plain = shown.filter((entry) => !entry.sensitive).map((entry) => entry.line)
  const secret = shown.filter((entry) => entry.sensitive).map((entry) => entry.line)
  if (more > 0) plain.push(`… ${more} more field(s) not shown`)
  if (secret.length > 0) plain.push(`(${secret.length} sensitive field(s) shown masked below)`)
  return {
    text: plain.length === 0 ? '(only sensitive fields)' : plain.join('\n'),
    ...secret.length === 0 ? {} : { sensitiveText: secret.join('\n') },
    fields: lines.length,
    sensitive: secret.length > 0,
  }
}

function flattenJson(value: unknown, path: string, lines: FieldLine[], depth: number): void {
  if (value !== null && typeof value === 'object' && depth < 8) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenJson(child, path === '' ? key : `${path}.${key}`, lines, depth + 1)
    }
    return
  }
  const name = path === '' ? '(body)' : path
  lines.push(field(name, typeof value === 'string' ? value : JSON.stringify(value)))
}

/** The approval card for one paused write. */
export function commitApprovalPrompt(paused: PausedRequest): ApprovalPrompt {
  let target: URL | undefined
  try { target = new URL(paused.request.url) } catch { /* shown raw */ }
  const destination = target === undefined ? paused.request.url : `${target.origin}${target.pathname}`
  const origin = target?.origin
  const body = summarizeRequestBody(paused.request)
  const method = paused.request.method.toUpperCase()
  const what = body.fields > 0 ? `${body.fields} field(s)` : body.text === '(no body)' ? 'an empty request' : 'data'
  return {
    kind: 'action',
    action: 'network_commit',
    summary: `This will send ${what} to ${destination} (${method}${body.sensitive ? ', includes sensitive fields: reveal to check them' : ''})`,
    origins: origin === undefined || origin === 'null' ? [] : [origin],
    canTrust: false,
    forced: true,
    perCallOnly: true,
    details: [
      { kind: 'text', value: body.text, masked: false, label: `${method} ${paused.request.url}` },
      ...body.sensitiveText === undefined
        ? []
        : [{ kind: 'text' as const, value: body.sensitiveText, masked: true, label: 'Sensitive fields (masked; reveal to check)' }],
    ],
    binding: approvalBinding({
      action: 'network_commit',
      args: { method, url: paused.request.url, body: sha256Hex(paused.request.postData ?? '') },
      origins: origin === undefined ? [] : [origin],
    }),
  }
}

export interface CommitGateOptions {
  broker: DebuggerBroker
  /** Ask the user (forced card) on behalf of the tab's agent session. */
  ask: (prompt: ApprovalPrompt, tabId: number) => Promise<ApprovalAuthorization>
  now?: () => number
}

interface GateTab {
  lease?: DebuggerLease
  /** The arm in progress: overlapping callers share it instead of taking a second lease. */
  arming?: Promise<void>
  armed: boolean
  inFlight: number
  lastCallEnd: number
  /** An agent call ran here and the agent's turn has not been seen to end. */
  turnOpen: boolean
  /** Tab that opened this one during an agent turn (its turn covers this tab). */
  opener?: number
}

/** Per-tab commit gate over the shared debugger broker. */
export class CommitGate {
  private readonly tabs = new Map<number, GateTab>()
  private readonly now: () => number

  constructor(private readonly options: CommitGateOptions) {
    this.now = options.now ?? Date.now
  }

  private tab(tabId: number): GateTab {
    let entry = this.tabs.get(tabId)
    if (entry === undefined) {
      entry = { armed: false, inFlight: 0, lastCallEnd: Number.NEGATIVE_INFINITY, turnOpen: false }
      this.tabs.set(tabId, entry)
    }
    return entry
  }

  /** Whether the gate is intercepting this tab's requests now. */
  isArmed(tabId: number): boolean {
    return this.tabs.get(tabId)?.armed === true
  }

  /**
   * An agent call on the tab starts / ends (agent-turn detection).
   * `turn`: the call belongs to an agent session whose turn end the
   * extension can observe; calls without one (probes) keep only the grace.
   */
  callStarted(tabId: number, turn = true): void {
    const entry = this.tab(tabId)
    entry.inFlight += 1
    if (turn) entry.turnOpen = true
  }

  callEnded(tabId: number): void {
    const entry = this.tab(tabId)
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    entry.lastCallEnd = this.now()
  }

  /**
   * The agent's turn ended (or the user took over): from now on only the
   * short grace applies. Without this signal a turn counts as open for up to
   * {@link AGENT_TURN_MAX_IDLE_MS} after its last call.
   */
  turnEnded(tabId: number): void {
    const entry = this.tabs.get(tabId)
    if (entry === undefined || !entry.turnOpen) return
    entry.turnOpen = false
    entry.lastCallEnd = Math.max(entry.lastCallEnd, this.now())
  }

  /**
   * A tab was opened by `openerTabId` (Shift/Ctrl-click, `target=_blank`,
   * `window.open`). When the opener is armed and inside an agent turn, the new
   * tab belongs to that turn: returns true, and the caller must arm it.
   */
  adoptOpened(tabId: number, openerTabId: number): boolean {
    if (!this.isArmed(openerTabId) || !this.agentTurnActive(openerTabId)) return false
    this.tab(tabId).opener = openerTabId
    return true
  }

  /** Whether page writes on the tab currently belong to an agent turn. */
  agentTurnActive(tabId: number, seen = new Set<number>()): boolean {
    const entry = this.tabs.get(tabId)
    if (entry === undefined || seen.has(tabId)) return false
    seen.add(tabId)
    const idle = this.now() - entry.lastCallEnd
    if (entry.inFlight > 0 || idle < AGENT_TURN_GRACE_MS || (entry.turnOpen && idle < AGENT_TURN_MAX_IDLE_MS)) return true
    return entry.opener !== undefined && this.agentTurnActive(entry.opener, seen)
  }

  /**
   * Arm (or keep armed) interception for a tab under strict mode. Throws when
   * it cannot: the caller must then refuse the agent call.
   */
  arm(tabId: number): Promise<void> {
    const entry = this.tab(tabId)
    if (entry.armed && entry.lease?.session.isAttached === true) return Promise.resolve()
    entry.arming ??= this.doArm(tabId, entry).finally(() => { entry.arming = undefined })
    return entry.arming
  }

  private async doArm(tabId: number, entry: GateTab): Promise<void> {
    entry.armed = false
    if (entry.lease !== undefined) {
      await entry.lease.release({ immediate: false }).catch(() => undefined)
      entry.lease = undefined
    }
    const lease = await this.options.broker.acquire(tabId, 'commit-gate', {
      listeners: {
        onCdpEvent: (method, params) => {
          if (method === 'Fetch.requestPaused') void this.onPaused(tabId, params as PausedRequest)
        },
        onDetached: () => {
          // Chrome dropped the attachment (the user closed the "being
          // debugged" bar, devtools opened, the tab crashed). Broker-initiated
          // detaches (kill switch) clear owner listeners first and never land
          // here; arm() checks isAttached for those. The next agent call
          // re-arms or is refused.
          const current = this.tabs.get(tabId)
          if (current !== undefined) {
            current.armed = false
            current.lease = undefined
          }
        },
      },
    })
    try {
      await lease.session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    } catch (error: unknown) {
      await lease.release({ immediate: true }).catch(() => undefined)
      throw error
    }
    entry.lease = lease
    entry.armed = true
  }

  /** Stop intercepting a tab (strict mode no longer covers it, or the tab closed). */
  async disarm(tabId: number): Promise<void> {
    const entry = this.tabs.get(tabId)
    if (entry === undefined) return
    // An arm in progress finishes first, so its lease is the one released.
    await entry.arming?.catch(() => undefined)
    const lease = entry.lease
    entry.armed = false
    entry.lease = undefined
    if (lease === undefined) return
    await lease.session.send('Fetch.disable', {}).catch(() => undefined)
    await lease.release({ immediate: true }).catch(() => undefined)
  }

  /** The tab closed: release its lease and drop its turn state. */
  async forget(tabId: number): Promise<void> {
    await this.disarm(tabId)
    this.tabs.delete(tabId)
  }

  private async onPaused(tabId: number, paused: PausedRequest): Promise<void> {
    const session = this.tabs.get(tabId)?.lease?.session ?? this.options.broker.attachedSession(tabId)
    if (session === undefined) return
    const settle = async (allow: boolean): Promise<void> => {
      try {
        await session.send(allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', allow
          ? { requestId: paused.requestId }
          : { requestId: paused.requestId, errorReason: 'BlockedByClient' })
      } catch { /* the request or the attachment is already gone */ }
    }
    if (!isMutatingMethod(paused.request.method) || !this.agentTurnActive(tabId)) {
      await settle(true)
      return
    }
    let authorization: ApprovalAuthorization
    try {
      authorization = await this.options.ask(commitApprovalPrompt(paused), tabId)
    } catch {
      authorization = 'unavailable'
    }
    await settle(authorization === 'approved')
  }
}
