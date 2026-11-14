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
 *   submissions) continue at once when no agent call is in flight on the tab
 *   (nor ended within {@link AGENT_TURN_GRACE_MS}) — the user is driving;
 * - writes during an agent turn pause behind an approval card: "This will send
 *   <fields, sensitive ones masked> to <origin/path>". Allow continues the
 *   request; anything else (deny, timeout, panel gone, error) fails it with
 *   `BlockedByClient`. Every paused request is settled exactly once.
 *
 * Fail closed: before each agent call on a strict tab the gate is (re)armed;
 * when the debugger cannot attach, or was detached by another feature, the
 * call is refused instead of running unguarded.
 *
 * Limits (documented, not bugs): WebSocket frames and `navigator.sendBeacon`
 * are not interceptable here; out-of-process iframes (cross-site frames under
 * site isolation) and service-worker-initiated requests are not paused by a
 * page-target Fetch session; the debugger shows Chrome's "being debugged" bar;
 * Firefox has no debugger API, so strict mode is unavailable there.
 *
 * @module
 */

import type { DebuggerBroker, DebuggerLease } from './debugger-broker.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { approvalBinding, sha256Hex } from '../security/payload-binding.ts'

/** How long after an agent call ends its page writes still count as the agent's. */
export const AGENT_TURN_GRACE_MS = 3_000
/** Longest field value shown on the card before it is shortened. */
const MAX_VALUE_CHARS = 120
/** Longest raw text body shown on the card. */
const MAX_TEXT_BODY_CHARS = 600

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

function shorten(value: string): string {
  const inline = value.replace(/\s+/g, ' ')
  return inline.length <= MAX_VALUE_CHARS ? inline : `${inline.slice(0, MAX_VALUE_CHARS - 1)}…`
}

function field(name: string, value: string): { line: string; sensitive: boolean } {
  const sensitive = SENSITIVE_FIELD.test(name)
  return { line: `${name} = ${sensitive ? '•••• (masked)' : JSON.stringify(shorten(value))}`, sensitive }
}

/** Human-readable body summary with sensitive fields masked. */
export interface BodySummary {
  text: string
  fields: number
  sensitive: boolean
}

/**
 * Summarize a request body for the approval card: form, JSON, and multipart
 * bodies become `name = value` lines (sensitive names masked); other text is
 * shown shortened; binary or unavailable bodies are described by size.
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
  const lines: Array<{ line: string; sensitive: boolean }> = []
  if (contentType.includes('application/x-www-form-urlencoded')) {
    for (const [name, value] of new URLSearchParams(body)) lines.push(field(name, value))
  } else if (contentType.includes('json') || /^\s*[[{]/.test(body)) {
    try {
      flattenJson(JSON.parse(body), '', lines, 0)
    } catch {
      lines.push({ line: shorten(body.slice(0, MAX_TEXT_BODY_CHARS)), sensitive: false })
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
    return printable
      ? { text: shorten(body.slice(0, MAX_TEXT_BODY_CHARS)), fields: 0, sensitive: SENSITIVE_FIELD.test(body) }
      : { text: `${body.length} bytes of ${contentType || 'binary data'}`, fields: 0, sensitive: false }
  }
  if (lines.length === 0) return { text: '(empty body)', fields: 0, sensitive: false }
  return { text: lines.map((entry) => entry.line).join('\n'), fields: lines.length, sensitive: lines.some((entry) => entry.sensitive) }
}

function flattenJson(value: unknown, path: string, lines: Array<{ line: string; sensitive: boolean }>, depth: number): void {
  if (lines.length >= 40) return
  if (value !== null && typeof value === 'object' && depth < 3) {
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
    summary: `This will send ${what} to ${destination} (${method}${body.sensitive ? ', includes masked sensitive fields' : ''})`,
    origins: origin === undefined || origin === 'null' ? [] : [origin],
    canTrust: false,
    forced: true,
    perCallOnly: true,
    details: [
      { kind: 'text', value: body.text, masked: false, label: `${method} ${paused.request.url}` },
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
  armed: boolean
  inFlight: number
  lastCallEnd: number
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
      entry = { armed: false, inFlight: 0, lastCallEnd: Number.NEGATIVE_INFINITY }
      this.tabs.set(tabId, entry)
    }
    return entry
  }

  /** Whether the gate is intercepting this tab's requests now. */
  isArmed(tabId: number): boolean {
    return this.tabs.get(tabId)?.armed === true
  }

  /** An agent call on the tab starts / ends (agent-turn detection). */
  callStarted(tabId: number): void {
    this.tab(tabId).inFlight += 1
  }

  callEnded(tabId: number): void {
    const entry = this.tab(tabId)
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    entry.lastCallEnd = this.now()
  }

  /** Whether page writes on the tab currently belong to an agent turn. */
  agentTurnActive(tabId: number): boolean {
    const entry = this.tabs.get(tabId)
    if (entry === undefined) return false
    return entry.inFlight > 0 || this.now() - entry.lastCallEnd < AGENT_TURN_GRACE_MS
  }

  /**
   * Arm (or keep armed) interception for a tab under strict mode. Throws when
   * it cannot: the caller must then refuse the agent call.
   */
  async arm(tabId: number): Promise<void> {
    const entry = this.tab(tabId)
    if (entry.armed && entry.lease?.session.isAttached === true) return
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
          // Another feature (kill switch, devtools revoke) dropped the
          // attachment: the next agent call re-arms or is refused.
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
    const lease = entry.lease
    entry.armed = false
    entry.lease = undefined
    if (lease === undefined) return
    await lease.session.send('Fetch.disable', {}).catch(() => undefined)
    await lease.release({ immediate: true }).catch(() => undefined)
  }

  forget(tabId: number): void {
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
