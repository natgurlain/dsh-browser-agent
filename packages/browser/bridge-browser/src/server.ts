/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC dispatch, per-connection event pump, and tool-call dispatch to the
 * connected browser extension.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE the /api trust
 * fence (which only guards the client-connection routes), so the bridge brings
 * its own authentication, required from every client including loopback ones:
 *
 *   1. server → `challenge { v, nonce: Ns }` as soon as the socket opens;
 *   2. client → `hello { v, nonce: Nc, endpoint: E, mac: HMAC(token, client|Ns|Nc|E|Cc), caps: Cc }`
 *      within HELLO_TIMEOUT_MS, where E is the host and port the client dialed;
 *   3. server → `hello.ok { caps: Cs, mac: HMAC(token, server|Nc|Ns|E|Cc|Cs) }` after
 *      checking E against the local address and port this socket was accepted
 *      on, which the extension verifies before trusting anything else;
 *   4. every later frame, both directions, is sealed with a per-connection,
 *      per-direction key derived from token, Ns, Nc and E, and a strict
 *      sequence number (protocol.BridgeFrameChannel). Any unsealed, replayed,
 *      reordered or forged frame closes the connection.
 *
 * A local process that relays the handshake from another port therefore
 * fails step 3, and one that rides an authenticated socket fails step 4; the
 * caps (Cc, Cs as canonical JSON) are bound too, so a relay cannot toggle the
 * developer-tools group. Configured `forwardedPorts` are the exception: a
 * forward listening there is trusted (`allowForwardedPorts`) and can read
 * every frame. Unauthenticated sockets that time out or are evicted are
 * terminated, not closed politely.
 * Frames are authenticated, not encrypted. The token never crosses the wire
 * in the handshake. A `chrome-extension://` Origin is accepted
 * only for an allowed extension ID: the pinned one, configured ones, and ones
 * that paired (defense in depth on top of the token; any
 * local process can forge an Origin header). Host calls terminate at the
 * bridge-owned Host adapter.
 *
 * Pairing (pairing.ts, pairing-host.ts) is the one other thing an
 * unauthenticated socket may do: instead of `hello` an extension sends
 * `pair.request` with a key share made under the code it displays. The
 * request then waits, bounded in number, rate and time, until the user types
 * a code on the host. The bridge answers with its own share under the typed
 * code (`pair.share`), and releases the token (`pair.ok`, encrypted, with
 * its own key confirmation) only to a requester whose `pair.confirm`
 * verifies, that is, one that holds the code the user typed. Its Chrome
 * extension ID then joins the allowlist and it reconnects with the ordinary
 * handshake. A requester without the code receives one group element and a
 * close. A socket admitted only to ask (a Chrome extension that is not on the
 * allowlist) is refused the moment it sends `hello`.
 * Methods the /api carrier pins to loopback (`PRIVILEGED_METHODS`)
 * stay loopback-only here regardless of the token, defense in depth for
 * `--host 0.0.0.0` deployments.
 *
 * Several authenticated connections at once, one per client identity
 * (`caps.client`: a per-install id plus browser and profile, bound into the
 * handshake proofs). The same identity reconnecting replaces only its own
 * predecessor, whose in-flight tool calls settle as `bridge-closed`; clients
 * without an identity share one legacy slot. At most MAX_READY_CONNECTIONS
 * stay open: the least recently active one is evicted beyond that.
 * Tool calls go to the connection a session is bound to (the one it was last
 * prompted from or had a snapshot injected from; a connection that answered
 * one of its calls binds it only while it is unbound; an MCP session binds at
 * its first dispatch), else to the most recently active connection that can
 * serve the tool. A `tool.result` is accepted only from
 * the connection the call was sent to.
 *
 * Panel-independent approvals: while a call waits on the user, the owning
 * connection may hold its deadline (`bridge.tool.hold`, capped by
 * `maxApprovalHoldMs`) and forward the approval to dsh's approval service
 * (`bridge.approval.ask`), which any owner client can answer. The session and
 * tool are taken from the bridge's own record of the call.
 *
 * @module
 */

import { createHmac, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { BrowserHostApi } from './host-api.ts'
import {
  AUTO_REVIEW_CAPS_VERSION,
  BRIDGE_APPROVAL_ASK_METHOD,
  BRIDGE_APPROVAL_WITHDRAW_METHOD,
  BRIDGE_CLOSE_CODES,
  BRIDGE_REVIEW_ASK_METHOD,
  BRIDGE_REVIEW_CANCEL_METHOD,
  BRIDGE_REVIEW_STATUS_METHOD,
  parseReviewAction,
  type PanelUserRequest,
  type ReviewAction,
  type ReviewUnavailableReason,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_TOOL_HOLD_METHOD,
  DEVTOOLS_TOOL_NAMES,
  HOST_APPROVALS_CAPS_VERSION,
  MAX_HOST_APPROVAL_REASON_CHARS,
  bridgeClientKey,
  isBridgeHex256,
  isPairingOrigin,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SESSION_PURGE_METHOD,
  BRIDGE_STANDING_EVENT_METHOD,
  STANDING_WORK_CAPS_VERSION,
  canonicalJson,
  isStandingWork,
  HELLO_TIMEOUT_MS,
  PINNED_CHROME_EXTENSION_ID,
  BridgeFrameChannel,
  bridgeEndpointMatches,
  bridgeProof,
  canonicalBridgeHost,
  createBridgeNonce,
  helloProtocolVersion,
  PING_INTERVAL_MS,
  isDevToolsCaps,
  isExternalSessionId,
  parseBridgeFrame,
  type BridgeEndpoint,
  type BridgeFrame,
  type BridgeCaps,
  type BridgeHmac,
  type ClientFrame,
  type ProgramStepRef,
  type StandingWork,
  type ToolErrorCode,
} from './protocol.ts'
import { SessionPurgeError } from './session-purge.ts'
import type { BridgeAuditObserver } from './audit-log.ts'
import { reviewAnswer, type ReviewRecord } from './auto-review.ts'
import { handleAuditRpc } from './audit-rpc.ts'
import { verifyToken } from './token.ts'
import {
  createPairingShare,
  derivePairingKeys,
  isPairingShare,
  sealPairingToken,
  verifyPairingClientConfirmation,
  verifyPairingDone,
  type PairingContext,
} from './pairing.ts'
import { chromeExtensionIdOfOrigin, PAIRING_REQUEST_TTL_MS, type PairingAttemptOutcome, type PairingDesk } from './pairing-host.ts'
import { errorMessage } from './host-api.ts'

/**
 * Gateway methods the /api carrier pins to loopback (mirror of
 * client-connection's PRIVILEGED_METHODS; kept verbatim so the two fences
 * cannot drift). The bridge rejects these for non-loopback remotes even with
 * a valid token.
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.state',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Whether a WebSocket Origin may attempt the handshake at all. Web pages are
 * refused outright; Chrome extensions only under an allowed ID; Firefox
 * `moz-extension://` origins carry a per-install UUID (no identity), and
 * Origin-less local clients prove themselves with the token alone.
 * @param origin - the upgrade request's Origin header.
 * @param chromeExtensionIds - allowed Chrome extension IDs.
 * @param revokedOrigins - Firefox origins the user unpaired (refused although Firefox origins are otherwise accepted).
 * @returns true when the handshake may proceed.
 */
export function isAllowedBridgeOrigin(
  origin: string | undefined,
  chromeExtensionIds: ReadonlySet<string>,
  revokedOrigins: ReadonlySet<string> = new Set(),
): boolean {
  if (origin === undefined || origin === '') return true
  if (origin.startsWith('moz-extension://')) return !revokedOrigins.has(origin)
  const chrome = /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin)
  return chrome !== null && chromeExtensionIds.has(chrome[1]!)
}

/** Native HMAC-SHA256 for the node half (same bytes as protocol.hmacSha256). */
const nodeHmac: BridgeHmac = (key, message) => createHmac('sha256', key).update(message).digest()

/** Largest message an unauthenticated socket may send (a `hello` is < 1 KiB). */
export const PRE_AUTH_MAX_PAYLOAD = 64 * 1024

/** Sockets allowed to sit in the handshake at once; beyond that the oldest is terminated. */
export const MAX_PENDING_SOCKETS = 16

/** Authenticated connections kept at once; the least recently active is evicted beyond it. */
export const MAX_READY_CONNECTIONS = 8

/** How long a pairing requester may take to confirm, and then to acknowledge the token. */
export const PAIRING_STEP_TIMEOUT_MS = 5_000

/** Default ceiling on how long an approval may hold a tool call past its own budget. */
export const DEFAULT_MAX_APPROVAL_HOLD_MS = 15 * 60_000

/** Outcome vocabulary of dsh's approval service (`ctx.approval.request`). */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One approval the bridge forwards to dsh on behalf of a pending tool call. */
export interface HostApprovalRequest {
  /** Agent session the tool call belongs to (from the bridge's own record). */
  sessionId: string
  /** The model's tool call id, so a UI can attach the question to that call. */
  callId?: string
  /** Tool the approval is about. */
  toolName: string
  /** Human-readable question, including the full payload the user approves. */
  reason: string
  /** Aborted when the approval is answered elsewhere or the call settles. */
  signal: AbortSignal
}

const DEVTOOLS_TOOLS: ReadonlySet<string> = new Set(DEVTOOLS_TOOL_NAMES)

/**
 * The trailing `callId` argument for {@link BridgeServer.requestTool}, read
 * from a tool execution (empty when the executor supplied none).
 */
export function toolCallIdArg(exec: object): [] | [string] {
  const callId = (exec as { callId?: unknown }).callId
  return typeof callId === 'string' && callId !== '' ? [callId] : []
}

/**
 * Lower or restore one socket's inbound message limit. `ws` sets `maxPayload`
 * per server; its receiver keeps a per-socket copy that this adjusts. Returns
 * false (and changes nothing) if a future `ws` drops that field, in which case
 * only the server-wide limit, the pending-socket cap, and the hello timeout apply.
 */
function setSocketMaxPayload(ws: WebSocket, bytes: number): boolean {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: unknown } | null })._receiver
  if (receiver === undefined || receiver === null || typeof receiver._maxPayload !== 'number') return false
  receiver._maxPayload = bytes
  return true
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Shared secret both sides prove knowledge of during the handshake. Replaceable at run time ({@link BridgeServer.resetToken}). */
  token: string
  /** Firefox extension origins the user unpaired: refused at the Origin check. */
  revokedOrigins?: readonly string[]
  /**
   * Chrome extension IDs whose `chrome-extension://` Origin may connect.
   * Defaults to {@link PINNED_CHROME_EXTENSION_ID}.
   */
  allowedChromeExtensionIds?: readonly string[]
  /**
   * The pairing desk (pairing-host.ts). Absent: this bridge never pairs, and
   * a Chrome extension that is not on the allowlist is refused at the Origin
   * check.
   */
  pairing?: PairingDesk
  /** Milliseconds a pairing requester may take for each of its two answers; defaults to PAIRING_STEP_TIMEOUT_MS. */
  pairingStepTimeoutMs?: number
  /**
   * Told after an extension paired, with its Origin and (for Chrome) the
   * extension ID that was just added to the allowlist, so the plugin can
   * persist it. Observer only: a throw is ignored.
   */
  onPaired?: (paired: { origin: string; chromeExtensionId?: string }) => void
  /**
   * Session scope for the bridge's own session-targeted methods (snapshot
   * injection, purge). Absent means unrestricted (unit tests only).
   */
  sessionScope?: {
    allowsSession(sessionId: string, signal: AbortSignal, access?: 'read' | 'own' | 'write'): Promise<boolean>
  }
  /** Active dsh Host adapter used for unary calls, events, and waterfalls. */
  api: BrowserHostApi
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /**
   * Called after each accepted `hello`, with the capabilities that connection
   * advertised. The plugin re-evaluates the developer-tools tool group here.
   */
  onCapsChange?: (clientCaps: BridgeCaps) => void
  /** Seed a followed-page snapshot into a live or deferred Agent session. */
  injectBrowserSnapshot: (sessionId: string, snapshot: string, reason?: 'follow' | 'resume', taintExempt?: boolean, taintExemptLocal?: boolean) => void | Promise<void>
  /**
   * Permanently delete one session's durable storage. Callers archive the
   * session through the gateway first; this only removes files.
   */
  purgeSession: (sessionId: string) => Promise<void>
  /** Audit observer told about every tool call's dispatch, annotations, and outcome. */
  audit?: BridgeAuditObserver
  /** Read and verify one session's audit log (undefined: agentless calls). */
  exportAudit?: (sessionId: string | undefined) => Promise<unknown>
  /** The extension reported its kill switch (`bridge.audit.record { event: 'kill-switch' }`). */
  onKillSwitch?: (connection: string | undefined) => void
  /**
   * Bridge-internal RPCs owned by plugin modules (page watchers, learning).
   * Returns undefined for a method it does not own; checked after the audit
   * RPCs and before anything reaches the Host API. A rejection is answered
   * as an `internal` error.
   */
  extraRpc?: (method: string, payload: unknown, context: { connection: string; signal: AbortSignal }) =>
    Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }> | undefined
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /**
   * Test seam: force the local endpoint the handshake is checked against
   * (production reads the accepted socket's local address and port).
   */
  localEndpointOverride?: BridgeEndpoint
  /**
   * Loopback ports that forward to this bridge (a Docker `-p` mapping, an SSH
   * tunnel, a test proxy). A client that dialed one of them on a loopback
   * address passes the endpoint check whatever address the forward delivers
   * to (inside a container that is the container's own address). Opt-in: any
   * local process that binds such a port while it is free can relay the
   * handshake through it.
   */
  forwardedPorts?: readonly number[]
  /** Milliseconds a fresh socket may take to present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
  /**
   * Ask dsh's approval service to decide one browser approval (any owner
   * client may answer; the first answer wins). Absent disables forwarding and
   * the `hostApprovals` cap. Must fail closed: anything but `allowed-once` is
   * treated as no grant.
   */
  requestHostApproval?: (request: HostApprovalRequest) => Promise<HostApprovalOutcome>
  /** Upper bound on one call's approval hold; defaults to DEFAULT_MAX_APPROVAL_HOLD_MS. */
  maxApprovalHoldMs?: number
  /**
   * Auto review (auto-review.ts). Absent, or `supported()` false: no
   * `autoReview` cap, and the review RPCs are refused as unsupported.
   */
  autoReview?: AutoReviewService
  /**
   * The extension's panel submitted a prompt (`session.prompt`) that the Host
   * accepted, with the request id DSH stamps on its user source. Auto review
   * trusts only these prompts as the user's own words.
   */
  onPanelPrompt?: (sessionId: string, requestId: string, text: string) => void
  /** The Host refused or failed a panel prompt recorded by {@link onPanelPrompt}: it is not the user's newest message. */
  onPanelPromptRejected?: (sessionId: string, requestId: string) => void
  /** Clock seam for tests. */
  now?: () => number
  /**
   * Session lineage and Host-side taint (session-taint.ts). A subagent or
   * fork without its own browser affinity is routed to its nearest
   * ancestor's install, and a call from a session the Host holds tainted
   * (itself or an ancestor) carries `tainted: true` to the extension.
   */
  sessionLineage?: {
    parentOf(sessionId: string): string | undefined
    isTainted(sessionId: string): boolean
    /** A tool call is about to ask the extension for one result (taint exemption, session-taint.ts). */
    expectResult?(sessionId: string, callId: string): void
    /** The extension answered it; `exempt` is the frame's `taintExempt` flag, `local` its `taintExemptLocal`. */
    noteResult?(sessionId: string, callId: string, exempt: boolean, local?: boolean): void
    /** The call was refused before it reached any browser (no extension connected, cancelled before dispatch). */
    noteUndelivered?(sessionId: string, callId: string): void
    /** Whether an ancestor of the session read taint-exempt pages (sent as `inheritedExemptReads`). */
    inheritsExemptReads?(sessionId: string): boolean
  }
  /** Told when an authenticated connection goes away (learning features drop its switches). */
  onDisconnect?: (connection: string) => void
  /**
   * Unattended work the Host holds for one install (client key): sent in that
   * connection's `hello.ok` caps, and again through
   * {@link BridgeServer.notifyStandingWork} when it changes. Absent: no hint
   * is sent at all (the extension then keeps its usual idle rule).
   */
  standingWork?: (connection: string) => StandingWork
}

/** What the server needs from the Host's reviewer (auto-review.ts `AutoReviewer`). */
export interface AutoReviewService {
  supported(): boolean
  status(sessionId: string, external: boolean): { available: true; model: string } | { available: false; reason: ReviewUnavailableReason }
  review(sessionId: string, action: ReviewAction, signal: AbortSignal, panelAction?: PanelUserRequest): Promise<ReviewRecord>
}

/** Longest review id accepted. */
const MAX_REVIEW_ID_CHARS = 128

/** Longest parent chain followed when resolving inherited affinity. */
const MAX_AFFINITY_DEPTH = 32

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  /** The connection the call was sent to: the only one allowed to answer it. */
  conn: ReadyConnection
  name: string
  sessionId: string | undefined
  /** The model's tool call id, when the executor supplied one. */
  callId: string | undefined
  /** Latest deadline a hold may reach (call start + budget + max hold). */
  holdCeiling: number
  expiresAt: number
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  /** Re-arm the deadline timer to `expiresAt`. */
  rearm: () => void
  timer: NodeJS.Timeout
  /** Forwarded approvals still waiting on dsh, by extension approval id. */
  approvals: Map<string, AbortController>
  /** Auto reviews in flight for this call, by extension review id. */
  reviews: Map<string, AbortController>
  /**
   * The user's click in the panel that started this very call (a Watch me
   * run's own `browser_run` approval call only). Read once by its review.
   */
  panelAction?: PanelUserRequest
}

/** A socket that passed authentication and owns its client identity's slot. */
interface ReadyConnection {
  /** Registry key derived from `caps.client`. */
  key: string
  /** Last time this connection sent a non-liveness frame (routing fallback). */
  lastActiveAt: number
  /** Promotion order, the tie-breaker for equally recent connections. */
  serial: number
  ws: WebSocket
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  /** The Origin header the socket was accepted with (undefined for a non-browser client). */
  origin: string | undefined
  /** Capabilities the extension advertised in its `hello`. */
  clientCaps: BridgeCaps
  /** Per-connection frame integrity (sealing and verification). */
  channel: BridgeFrameChannel
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
  /** The standing-work hint this connection was last told (canonical JSON). */
  standing: string | undefined
}

/** Send one unsealed handshake frame (challenge, hello.ok). */
function sendHandshakeFrame(ws: WebSocket, frame: BridgeFrame): void {
  /* v8 ignore next -- teardown race: the socket can die before the write */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/** Send one sealed frame on an authenticated connection. */
function sendFrame(conn: Pick<ReadyConnection, 'ws' | 'channel'>, frame: BridgeFrame): void {
  /* v8 ignore next -- teardown race: the socket can die between a pump's
  readiness check and this write; the guard refuses writes on dead sockets */
  if (conn.ws.readyState !== WebSocket.OPEN) return
  conn.ws.send(conn.channel.seal(frame))
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  /** Authenticated connections by client key. */
  private readonly connections = new Map<string, ReadyConnection>()
  /** Session → client key it is bound to (see the class doc for when a binding is set). */
  private readonly sessionAffinity = new Map<string, string>()
  private connectionSerial = 0
  private readonly serverCaps: BridgeCaps
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false
  /** Sockets still in the handshake, oldest first. */
  private readonly pendingSockets = new Set<WebSocket>()
  /** Allowed Chrome extension IDs: configured ones, plus every ID that paired since. */
  private readonly chromeExtensionIds: Set<string>
  /** Firefox extension origins the user unpaired. */
  private readonly revokedOrigins: Set<string>
  /** The token in force (the configured one until {@link resetToken}). */
  private token: string

  constructor(private readonly deps: BridgeServerDeps) {
    this.chromeExtensionIds = new Set(deps.allowedChromeExtensionIds ?? [PINNED_CHROME_EXTENSION_ID])
    this.revokedOrigins = new Set(deps.revokedOrigins ?? [])
    this.token = deps.token
    const { hostApprovals: _hostApprovals, autoReview: _autoReview, client: _client, standing: _standing, standingUpdates: _standingUpdates, ...caps } = deps.caps
    this.serverCaps = deps.requestHostApproval === undefined
      ? caps
      : { ...caps, hostApprovals: HOST_APPROVALS_CAPS_VERSION }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The standing-work hint for one install, or undefined when the plugin supplies none (or a malformed one). */
  private standingFor(key: string): StandingWork | undefined {
    const work = this.deps.standingWork?.(key)
    return isStandingWork(work) ? { schedules: work.schedules, mcp: work.mcp } : undefined
  }

  /** The caps one connection's `hello.ok` carries: the shared ones plus that install's standing work. */
  private capsFor(key: string): BridgeCaps {
    const standing = this.standingFor(key)
    // Decided per connection: the Host's LLM service can come and go with its plugins.
    const review = this.reviewSupported() ? { autoReview: AUTO_REVIEW_CAPS_VERSION } : {}
    return standing === undefined ? { ...this.serverCaps, ...review } : { ...this.serverCaps, ...review, standing }
  }

  private reviewSupported(): boolean {
    try {
      return this.deps.autoReview?.supported() === true
    } catch {
      return false
    }
  }

  /**
   * The Host's standing work changed (a schedule was created, cancelled or
   * revoked): tell each connected extension whose hint differs from the one
   * it last received. Sent sealed, and only to extensions that advertised
   * `standingUpdates`.
   */
  notifyStandingWork(): void {
    for (const conn of this.connections.values()) {
      if (conn.clientCaps.standingUpdates !== STANDING_WORK_CAPS_VERSION) continue
      const standing = this.standingFor(conn.key)
      if (standing === undefined) continue
      const text = canonicalJson(standing)
      if (text === conn.standing) continue
      conn.standing = text
      sendFrame(conn, { t: 'event', frame: { rpcId: '', method: BRIDGE_STANDING_EVENT_METHOD, payload: standing } })
    }
  }

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    // The address and port this socket was actually accepted on, never the
    // Host header (a relay controls that). The client binds what it dialed.
    const local = this.deps.localEndpointOverride ?? localEndpointOf(req.socket)
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin, local) })
  }

  /**
   * Request one browser action from the connected extension.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @param callId - the model's tool call id (presented with forwarded approvals).
   * @param program - marks the call as one step of an approved `browser_run` program.
   * @param requester - external (MCP) client label for an external session's call.
   * @returns the extension's action result.
   * @throws BridgeToolError when no extension is connected, the call times
   *   out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
    callId?: string,
    program?: ProgramStepRef,
    requester?: string,
    panelAction?: PanelUserRequest,
  ): Promise<unknown> {
    // Refusals before dispatch reached no browser, so their error text quotes no page:
    // they are recorded as such and do not taint the session (session-taint.ts).
    const undelivered = (error: unknown): never => {
      if (sessionId !== undefined && callId !== undefined) this.noteLineage(lineage => { lineage.noteUndelivered?.(sessionId, callId) })
      throw error
    }
    let conn: ReadyConnection | undefined
    try {
      conn = this.pickConnection(name, sessionId)
    } catch (error) {
      return undelivered(error)
    }
    if (conn === undefined) {
      return undelivered(new BridgeToolError('bridge-closed', this.connections.size === 0
        ? 'no browser extension is connected to the bridge'
        : `no connected browser extension can serve "${name}"`))
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      return undelivered(new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch'))
    }
    // An MCP client's external session binds to the first install it reaches,
    // at dispatch: it never falls back to another browser profile afterwards.
    if (sessionId !== undefined && isExternalSessionId(sessionId) && this.affinityOf(sessionId) === undefined) {
      this.sessionAffinity.set(sessionId, conn.key)
    }
    const id = randomUUID()
    const startedAt = this.now()
    const expiresAt = startedAt + timeoutMs
    this.auditSafely(audit => {
      audit.dispatched({
        id, name, args, connection: conn.key,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(callId === undefined ? {} : { toolCallId: callId }),
        ...(program === undefined ? {} : { program }),
      })
    })
    return new Promise<unknown>((resolve, reject) => {
      const settle = (error: BridgeToolError): void => {
        clearTimeout(entry.timer)
        this.dropPendingTool(id)
        signal.removeEventListener('abort', onAbort)
        this.auditSettled(id, error)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      const onExpire = (): void => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${String(entry.expiresAt - startedAt)}ms`))
      }
      const entry: PendingTool = {
        conn,
        name,
        sessionId,
        callId,
        holdCeiling: expiresAt + (this.deps.maxApprovalHoldMs ?? DEFAULT_MAX_APPROVAL_HOLD_MS),
        expiresAt,
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
        rearm: () => {
          clearTimeout(entry.timer)
          entry.timer = setTimeout(onExpire, Math.max(0, entry.expiresAt - this.now()))
        },
        timer: setTimeout(onExpire, timeoutMs),
        approvals: new Map(),
        reviews: new Map(),
        ...panelAction === undefined ? {} : { panelAction },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, entry)
      if (sessionId !== undefined && callId !== undefined) this.noteLineage(lineage => { lineage.expectResult?.(sessionId, callId) })
      conn.ws.send(conn.channel.seal({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(sessionId !== undefined && this.sessionTainted(sessionId) ? { tainted: true as const } : {}),
        ...(sessionId !== undefined && this.inheritsExemptReads(sessionId) ? { inheritedExemptReads: true as const } : {}),
        ...(program === undefined ? {} : { program }),
        ...(requester === undefined || sessionId === undefined ? {} : { requester }),
        ...(callId === undefined ? {} : { toolCallId: callId }),
      } satisfies BridgeFrame), (error) => {
        /* v8 ignore next -- teardown race: when the write fails, the socket's
        close handler settles the same call with the same code; the callback
        path is a defensive second settle, covered via the close path */
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    // Capture the live pumps BEFORE dropConnection forgets the connections.
    const pumps = [...this.connections.values()].map((conn) => conn.pump)
    // Not `replaced`: nothing took these clients' slots, and a client told so stops for good.
    for (const conn of [...this.connections.values()]) this.dropConnection(conn, 'the bridge closed', BRIDGE_CLOSE_CODES.closing)
    for (const socket of this.wss.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor close cannot fail: close() is idempotent
        and the noServer acceptor only reports teardown of already-terminated clients */
        if (error === undefined) resolve()
        /* v8 ignore next -- same unreachable arm */
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether an authenticated extension is currently connected. */
  hasConnection(): boolean {
    return this.connections.size > 0
  }

  /** @returns how many authenticated extensions are connected right now. */
  connectionCount(): number {
    return this.connections.size
  }

  /**
   * Whether some connected extension can serve the developer-tools group.
   * Read by the plugin when it (re)registers that tool group; calls in that
   * group are routed only to connections that advertised it.
   * @returns true when at least one live connection's `hello` advertised devtools.
   */
  devToolsSupported(): boolean {
    for (const conn of this.connections.values()) {
      if (isDevToolsCaps(conn.clientCaps.devTools)) return true
    }
    return false
  }

  /** Tell the lineage about a result; a failure there only costs the exemption. */
  private noteLineage(note: (lineage: NonNullable<BridgeServerDeps['sessionLineage']>) => void): void {
    if (this.deps.sessionLineage === undefined) return
    try {
      note(this.deps.sessionLineage)
    } catch { /* no voucher recorded: the result taints */ }
  }

  /** Whether an ancestor of the session read exempt pages; fails closed (says yes) when the lineage throws. */
  private inheritsExemptReads(sessionId: string): boolean {
    try {
      return this.deps.sessionLineage?.inheritsExemptReads?.(sessionId) === true
    } catch {
      return true
    }
  }

  /** Whether the session (or an ancestor) is tainted; fails closed when the lineage throws. */
  private sessionTainted(sessionId: string): boolean {
    try {
      return this.deps.sessionLineage?.isTainted(sessionId) === true
    } catch {
      return true
    }
  }

  /**
   * Forget a purged session's install binding. The caller decides whether
   * that is safe (no child session inherits the binding through it).
   */
  forgetSession(sessionId: string): void {
    this.sessionAffinity.delete(sessionId)
  }

  /**
   * The install a session is bound to: its own affinity, else its nearest
   * ancestor's (a subagent or fork acts in the browser its parent drives).
   */
  private affinityOf(sessionId: string): string | undefined {
    let current: string | undefined = sessionId
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current) && seen.size < MAX_AFFINITY_DEPTH) {
      const key = this.sessionAffinity.get(current)
      if (key !== undefined) return key
      seen.add(current)
      current = this.deps.sessionLineage?.parentOf(current)
    }
    return undefined
  }

  /**
   * Choose the connection for one tool call. A session bound to an install
   * (directly or through its parent) is served only there: when that install
   * is down or cannot serve the tool the call fails rather than acting in a
   * different browser profile. Unbound sessions go to the most recently
   * active capable connection.
   * @throws BridgeToolError (`bridge-closed`) for a bound session whose install cannot serve the call.
   */
  private pickConnection(name: string, sessionId: string | undefined): ReadyConnection | undefined {
    const capable = (conn: ReadyConnection): boolean =>
      conn.ws.readyState === WebSocket.OPEN
      && (!DEVTOOLS_TOOLS.has(name) || isDevToolsCaps(conn.clientCaps.devTools))
    if (sessionId !== undefined) {
      const key = this.affinityOf(sessionId)
      if (key !== undefined) {
        const affine = this.connections.get(key)
        if (affine === undefined || affine.ws.readyState !== WebSocket.OPEN) {
          throw new BridgeToolError('bridge-closed', 'the browser this session is bound to is not connected; '
            + 'reconnect that browser (the call is not sent to another browser profile)')
        }
        if (!capable(affine)) {
          throw new BridgeToolError('bridge-closed', `the browser this session is bound to cannot serve "${name}"; `
            + 'enable it there (the call is not sent to another browser profile)')
        }
        return affine
      }
    }
    let best: ReadyConnection | undefined
    for (const conn of this.connections.values()) {
      if (!capable(conn)) continue
      if (best === undefined
        || conn.lastActiveAt > best.lastActiveAt
        || (conn.lastActiveAt === best.lastActiveAt && conn.serial > best.serial)) best = conn
    }
    return best
  }

  private attach(
    ws: WebSocket,
    remoteAddress: string | undefined,
    origin: string | undefined,
    local: BridgeEndpoint | undefined,
  ): void {
    // A Chrome extension that is not on the allowlist may do one thing only:
    // ask to pair. Web pages (http/https Origins) are refused outright.
    const pairOnly = !isAllowedBridgeOrigin(origin, this.chromeExtensionIds, this.revokedOrigins)
    if (pairOnly && !(isPairingOrigin(origin) && this.deps.pairing !== undefined)) {
      ws.close(BRIDGE_CLOSE_CODES.originRejected, 'origin not allowed')
      return
    }
    // Evict the oldest waiting socket rather than refusing the newest, so a
    // local process holding the pool full cannot lock the extension out: a
    // real handshake completes in milliseconds.
    if (this.pendingSockets.size >= MAX_PENDING_SOCKETS) {
      const oldest = this.pendingSockets.values().next().value as WebSocket
      this.pendingSockets.delete(oldest)
      // terminate(), not close(): a client that never answers the close
      // handshake would otherwise keep its TCP connection (and memory).
      oldest.terminate()
    }
    this.pendingSockets.add(ws)
    const leavePending = (): void => { this.pendingSockets.delete(ws) }
    // Pre-auth bound: a hello is tiny; the server limit returns once proven.
    const limited = setSocketMaxPayload(ws, PRE_AUTH_MAX_PAYLOAD)
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      leavePending()
      ws.terminate()
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    const serverNonce = createBridgeNonce()
    let channel: BridgeFrameChannel | undefined
    /**
     * A pairing request on this socket. `withdraw` takes it out of the queue;
     * `expect` is the one frame the exchange is waiting for, if any.
     */
    let pairing: {
      withdraw: () => void
      timer: NodeJS.Timeout
      expect?: { t: 'pair.confirm' | 'pair.done'; resolve: (mac: string | undefined) => void }
    } | undefined
    /** The socket is going away: its request leaves the queue, and a waiting step ends unanswered. */
    const abandonPairing = (): void => {
      if (pairing === undefined) return
      clearTimeout(pairing.timer)
      pairing.withdraw()
      pairing.expect?.resolve(undefined)
      pairing = undefined
    }

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      if (helloTimer !== undefined) {
        // A hello racing an eviction or close is ignored, never promoted.
        if (ws.readyState !== WebSocket.OPEN) return
        // Pending state: only a v2 `hello` answering this socket's challenge
        // is legal. Every client authenticates, loopback included — an Origin
        // header is forgeable by any local process and proves nothing alone.
        const version = helloProtocolVersion(text)
        if (version !== undefined && version !== BRIDGE_PROTOCOL_VERSION) {
          ws.close(
            BRIDGE_CLOSE_CODES.versionMismatch,
            `protocol version mismatch: bridge speaks v${String(BRIDGE_PROTOCOL_VERSION)}, client sent v${String(version)}; update the extension and dsh plugin together`,
          )
          return
        }
        const frame = parseBridgeFrame(text)
        if (frame === undefined) {
          ws.close(1008, 'unparseable frame')
          return
        }
        if (frame.t === 'pair.request' && pairing === undefined) {
          const queued = this.queuePairing(ws, frame, serverNonce, origin, local, (t, timeoutMs) => new Promise((resolve) => {
            /* v8 ignore next 4 -- the socket's close handler ends the exchange first */
            if (pairing === undefined) {
              resolve(undefined)
              return
            }
            const exchange = pairing
            const timer = setTimeout(() => { settle(undefined) }, timeoutMs)
            const settle = (mac: string | undefined): void => {
              clearTimeout(timer)
              if (exchange.expect?.resolve === settle) delete exchange.expect
              resolve(mac)
            }
            exchange.expect = { t, resolve: settle }
          }))
          if (queued === undefined) return
          // The request now waits for the user, not for the handshake timer;
          // it is bounded by the pairing queue instead of the pending-socket pool.
          clearTimeout(helloTimer)
          leavePending()
          pairing = {
            withdraw: queued.withdraw,
            // Real-time backstop for the queue's own expiry.
            timer: setTimeout(() => {
              // An exchange in progress is past the queue: its own step timeouts end it.
              if (pairing?.expect !== undefined) return
              queued.withdraw()
              ws.close(BRIDGE_CLOSE_CODES.pairingClosed, 'the pairing request expired')
            }, PAIRING_REQUEST_TTL_MS),
          }
          return
        }
        if ((frame.t === 'pair.confirm' || frame.t === 'pair.done') && pairing?.expect?.t === frame.t) {
          pairing.expect.resolve(frame.mac)
          return
        }
        if (frame.t === 'pair.request' || frame.t === 'pair.confirm' || frame.t === 'pair.done') {
          ws.close(1008, 'unexpected pairing frame')
          return
        }
        if (frame.t !== 'hello' || pairing !== undefined) {
          ws.close(1008, 'hello first')
          return
        }
        if (pairOnly) {
          // This Origin was let in to ask for pairing, not to authenticate.
          ws.close(BRIDGE_CLOSE_CODES.originRejected, 'origin not allowed')
          return
        }
        if (local === undefined || !this.endpointAccepted(frame.endpoint, local)) {
          // The client dialed somewhere else: a relay is forwarding this
          // handshake (or the bridge sits behind a port forward, unsupported).
          ws.close(BRIDGE_CLOSE_CODES.authFailed, 'authentication failed: endpoint mismatch')
          return
        }
        const expected = bridgeProof(this.token, 'client', serverNonce, frame.nonce, frame.endpoint, { client: frame.caps }, nodeHmac)
        if (frame.nonce === serverNonce || !verifyToken(expected, frame.mac)) {
          ws.close(BRIDGE_CLOSE_CODES.authFailed, 'authentication failed')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        leavePending()
        if (limited) setSocketMaxPayload(ws, this.wss.options.maxPayload ?? 100 * 1024 * 1024)
        channel = BridgeFrameChannel.derive(this.token, 'server', serverNonce, frame.nonce, frame.endpoint, nodeHmac)
        const serverCaps = this.capsFor(bridgeClientKey(frame.caps.client))
        ready = this.promote(ws, remoteAddress, origin, frame.caps, channel, serverCaps,
          bridgeProof(this.token, 'server', frame.nonce, serverNonce, frame.endpoint, { client: frame.caps, server: serverCaps }, nodeHmac))
        return
      }
      const frame = channel?.open(text)
      if (frame === undefined) {
        ws.close(BRIDGE_CLOSE_CODES.authFailed, 'frame authentication failed')
        return
      }
      const conn = ready
      /* v8 ignore next -- a sealed frame can only follow promotion on this socket */
      if (conn === undefined) return
      this.handleReadyFrame(conn, frame)
    }
    let ready: ReadyConnection | undefined
    const onClose = (): void => {
      leavePending()
      abandonPairing()
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (ready !== undefined && this.connections.get(ready.key) === ready) {
        this.dropConnection(ready, 'the extension connection closed')
      }
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
    sendHandshakeFrame(ws, { t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  }

  /**
   * Take a pairing request: check that it describes this socket, apply the
   * limits, and keep it until the user enters a code. Nothing is computed or
   * sent for the requester here.
   * @param awaitFrame - resolves with the MAC of the requester's next `pair.confirm` / `pair.done`, or undefined.
   * @returns how to withdraw the request when the socket goes away, or `undefined` when the socket was closed.
   */
  private queuePairing(
    ws: WebSocket,
    request: Extract<ClientFrame, { t: 'pair.request' }>,
    serverNonce: string,
    origin: string | undefined,
    local: BridgeEndpoint | undefined,
    awaitFrame: (t: 'pair.confirm' | 'pair.done', timeoutMs: number) => Promise<string | undefined>,
  ): { withdraw: () => void } | undefined {
    const desk = this.deps.pairing
    if (desk === undefined) {
      ws.close(BRIDGE_CLOSE_CODES.pairingClosed, 'this bridge does not pair')
      return undefined
    }
    // Only an extension may ask, under the Origin the browser gave its socket.
    // The same relay defenses as the handshake apply: the request names the
    // endpoint the client dialed and the origin it is, and both must describe this socket.
    if (!isPairingOrigin(origin) || request.origin !== origin || request.nonce === serverNonce) {
      ws.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: the request does not describe this connection')
      return undefined
    }
    if (local === undefined || !this.endpointAccepted(request.endpoint, local)) {
      ws.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: endpoint mismatch')
      return undefined
    }
    const refusal = desk.admit(origin)
    if (refusal !== undefined) {
      if (refusal === 'paused') ws.close(BRIDGE_CLOSE_CODES.pairingPaused, 'pairing is paused on the host')
      else ws.close(BRIDGE_CLOSE_CODES.pairingClosed, 'too many pairing requests; try again in a minute')
      return undefined
    }
    // Checked after the rate limit: the subgroup test is the one costly step.
    if (!isPairingShare(request.share)) {
      ws.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: malformed share')
      return undefined
    }
    const stepMs = this.deps.pairingStepTimeoutMs ?? PAIRING_STEP_TIMEOUT_MS
    const attempt = async (code: string): Promise<PairingAttemptOutcome> => {
      if (ws.readyState !== WebSocket.OPEN) return 'failed'
      const context: PairingContext = { code, serverNonce, clientNonce: request.nonce, endpoint: request.endpoint, origin, name: request.name }
      const own = createPairingShare(context)
      const keys = derivePairingKeys(context, own.secret, request.share, own.share, 'server')
      /* v8 ignore next 4 -- the share was validated above */
      if (keys === undefined) {
        ws.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed')
        return 'failed'
      }
      // The requester must confirm first. Until it does, it has been sent
      // one group element and nothing keyed by the code.
      const confirmation = awaitFrame('pair.confirm', stepMs)
      sendHandshakeFrame(ws, { t: 'pair.share', share: own.share })
      const mac = await confirmation
      if (mac === undefined || !verifyPairingClientConfirmation(keys, mac)) {
        ws.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: the code entered on the host is not this request\'s code')
        return 'failed'
      }
      let sealed: { box: string; mac: string }
      try {
        sealed = sealPairingToken(keys, this.token)
      } catch {
        // A token too long to carry: pairing cannot deliver it (paste it instead).
        ws.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: this bridge token cannot be delivered by pairing')
        return 'failed'
      }
      const chromeExtensionId = chromeExtensionIdOfOrigin(origin)
      if (chromeExtensionId !== undefined) this.chromeExtensionIds.add(chromeExtensionId)
      // A Firefox origin the user had unpaired is paired again.
      this.revokedOrigins.delete(origin)
      try {
        this.deps.onPaired?.({ origin, ...(chromeExtensionId === undefined ? {} : { chromeExtensionId }) })
      } catch { /* observer only */ }
      const receipt = awaitFrame('pair.done', stepMs)
      sendHandshakeFrame(ws, { t: 'pair.ok', ...sealed })
      const done = await receipt
      ws.close(1000, 'paired')
      return done !== undefined && verifyPairingDone(keys, done) ? 'paired' : 'unconfirmed'
    }
    return desk.enqueue({ origin, name: request.name }, attempt, (reason) => {
      if (reason === 'paused') ws.close(BRIDGE_CLOSE_CODES.pairingPaused, 'pairing is paused on the host')
      else if (reason === 'replaced') ws.close(BRIDGE_CLOSE_CODES.pairingReplaced, 'another pairing request took this one\'s place')
      else ws.close(BRIDGE_CLOSE_CODES.pairingClosed, 'the pairing request expired')
    })
  }

  /**
   * The user unpaired an extension: refuse its Origin from now on and close
   * every connection it has. A Chrome extension ID leaves the allowlist
   * (unless `keepAllowed`: the plugin config allows it too, and unpairing
   * undoes pairing, not configuration); a Firefox origin joins the refusal
   * list. The extension still holds the token: {@link resetToken} takes that away.
   * @returns how many live connections were closed.
   */
  revokeOrigin(origin: string, options: { keepAllowed?: boolean } = {}): number {
    const chromeExtensionId = chromeExtensionIdOfOrigin(origin)
    if (chromeExtensionId !== undefined) {
      if (options.keepAllowed !== true) this.chromeExtensionIds.delete(chromeExtensionId)
    } else {
      this.revokedOrigins.add(origin)
    }
    let closed = 0
    for (const conn of [...this.connections.values()]) {
      if (conn.origin !== origin) continue
      this.dropConnection(conn, 'the extension was unpaired', BRIDGE_CLOSE_CODES.originRejected)
      closed += 1
    }
    return closed
  }

  /**
   * Replace the token. Every connection is closed (each was authenticated
   * with the old one), and from here on only the new token passes the handshake.
   * @param token - the new token.
   * @returns how many live connections were closed.
   */
  resetToken(token: string): number {
    if (token === '') throw new Error('bridge token is empty')
    this.token = token
    const live = [...this.connections.values()]
    for (const conn of live) this.dropConnection(conn, 'the bridge token was reset', BRIDGE_CLOSE_CODES.authFailed)
    return live.length
  }

  /** The dialed endpoint is this socket, or a configured loopback forward to it. */
  private endpointAccepted(claimed: BridgeEndpoint, local: BridgeEndpoint): boolean {
    if (bridgeEndpointMatches(claimed, local)) return true
    const forwarded = this.deps.forwardedPorts ?? []
    return forwarded.includes(claimed.port) && isLoopbackHost(claimed.host)
  }

  /**
   * Promote an authenticated socket into its client identity's slot,
   * replacing only a previous connection with the same identity.
   */
  private promote(
    ws: WebSocket,
    remoteAddress: string | undefined,
    origin: string | undefined,
    clientCaps: BridgeCaps,
    channel: BridgeFrameChannel,
    serverCaps: BridgeCaps,
    serverMac: string,
  ): ReadyConnection {
    const key = bridgeClientKey(clientCaps.client)
    const previous = this.connections.get(key)
    if (previous !== undefined) this.dropConnection(previous, 'the extension connection was replaced')
    if (this.connections.size >= MAX_READY_CONNECTIONS) {
      let stalest: ReadyConnection | undefined
      for (const conn of this.connections.values()) {
        if (stalest === undefined || conn.lastActiveAt < stalest.lastActiveAt
          || (conn.lastActiveAt === stalest.lastActiveAt && conn.serial < stalest.serial)) stalest = conn
      }
      /* v8 ignore next -- the map is non-empty here */
      if (stalest !== undefined) this.dropConnection(stalest, 'the extension connection was evicted')
    }
    const abort = new AbortController()
    const target = { ws, channel }
    const ping = setInterval(() => { sendFrame(target, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const frame of this.deps.api.events(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          // The bridge's own event methods are never projected from a Host stream.
          if (frame.method === BRIDGE_STANDING_EVENT_METHOD) continue
          sendFrame(target, {
            t: 'event',
            frame,
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(target, { t: 'error', code: 'stream-failed', message: String(error) })
          // An authenticated socket without its Remote streams is unusable but
          // otherwise appears healthy to the extension. Closing the generation
          // activates its bounded reconnect loop and rebuilds every follower.
          ws.close(1011, 'event stream failed')
        }
      }
    })()
    const conn: ReadyConnection = {
      key,
      lastActiveAt: this.now(),
      serial: ++this.connectionSerial,
      ws,
      remoteAddress,
      origin,
      clientCaps,
      channel,
      abort,
      pump,
      ping,
      standing: serverCaps.standing === undefined ? undefined : canonicalJson(serverCaps.standing),
    }
    this.connections.set(key, conn)
    sendHandshakeFrame(ws, { t: 'hello.ok', caps: serverCaps, mac: serverMac })
    // Notify only after the new connection owns the slot, so a listener reading
    // `devToolsSupported()` sees the capability that just arrived.
    this.deps.onCapsChange?.(clientCaps)
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
    return conn
  }

  private handleReadyFrame(conn: ReadyConnection, frame: BridgeFrame): void {
    // Liveness replies (and client heartbeats, which reuse `pong`) do not
    // count as activity: every connection answers pings.
    if (frame.t !== 'pong') conn.lastActiveAt = this.now()
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(conn, frame)
        break
      case 'respond':
        void this.handleRespond(conn, frame)
        break
      case 'tool.result':
        this.settleTool(conn, frame)
        break
      case 'pong':
      case 'hello':
      case 'challenge':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
      case 'pair.request':
      case 'pair.confirm':
      case 'pair.done':
      case 'pair.share':
      case 'pair.ok':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the extension is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, the
   * first prompt may still be materializing a provisional session; its cancel
   * must not reach the gateway until that admission has completed.
   */
  private routeRpc(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(conn, frame)
      return
    }
    // The browser a session is driven from is where its tools should act;
    // handleRpc binds it only once the Host (or session scope) accepted it.
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(conn, frame),
      () => this.handleRpc(conn, frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    if (frame.method === BRIDGE_TOOL_HOLD_METHOD) {
      this.handleToolHold(conn, frame)
      return
    }
    if (frame.method === BRIDGE_APPROVAL_ASK_METHOD) {
      await this.handleApprovalAsk(conn, frame)
      return
    }
    if (frame.method === BRIDGE_APPROVAL_WITHDRAW_METHOD) {
      this.handleApprovalWithdraw(conn, frame)
      return
    }
    if (frame.method === BRIDGE_REVIEW_ASK_METHOD) {
      await this.handleReviewAsk(conn, frame)
      return
    }
    if (frame.method === BRIDGE_REVIEW_CANCEL_METHOD) {
      this.handleReviewCancel(conn, frame)
      return
    }
    if (frame.method === BRIDGE_REVIEW_STATUS_METHOD) {
      await this.handleReviewStatus(conn, frame)
      return
    }
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      this.rpcError(conn, frame.id, 'forbidden', 'method is loopback-only')
      return
    }
    const audited = handleAuditRpc(frame.method, frame.payload, {
      connection: conn.key,
      // Only the connection a call was sent to may annotate it.
      ownsCall: (callId: string) => this.pendingTools.get(callId)?.conn === conn,
      ...(this.deps.audit === undefined ? {} : { audit: this.deps.audit }),
      ...(this.deps.exportAudit === undefined ? {} : { exportAudit: this.deps.exportAudit }),
      ...(this.deps.onKillSwitch === undefined ? {} : { onKillSwitch: this.deps.onKillSwitch }),
      ...(this.deps.sessionScope === undefined
        ? {}
        : { allowsSession: (sessionId: string) => this.deps.sessionScope!.allowsSession(sessionId, conn.abort.signal, 'read') }),
    })
    const internal = audited ?? this.deps.extraRpc?.(frame.method, frame.payload, { connection: conn.key, signal: conn.abort.signal })
    if (internal !== undefined) {
      const answer = await internal.catch((error: unknown) => ({ ok: false as const, error: { code: 'internal', message: errorMessage(error) } }))
      if (answer.ok) sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { type: 'server-response', rpcId: frame.id, result: { ok: true, value: answer.result } } })
      else this.rpcError(conn, frame.id, answer.error.code, answer.error.message)
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD || frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = frame.method === BRIDGE_SESSION_PURGE_METHOD
        ? purgeSessionPayload(frame.payload)
        : browserSnapshotPayload(frame.payload)?.sessionId
      if (sessionId !== undefined && this.deps.sessionScope !== undefined
        // Injection acts in the session (bridge-created, not full access);
        // purge needs ownership only.
        && !await this.deps.sessionScope.allowsSession(
          sessionId,
          conn.abort.signal,
          frame.method === BRIDGE_SESSION_PURGE_METHOD ? 'own' : 'write',
        ).catch(() => false)) {
        this.rpcError(conn, frame.id, 'forbidden', `session ${JSON.stringify(sessionId)} is not available to the browser bridge`)
        return
      }
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        this.rpcError(conn, frame.id, 'bad-request', 'sessionId and snapshot must be non-empty strings')
        return
      }
      try {
        await (payload.taintExempt
          ? this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot, payload.reason, true, payload.taintExemptLocal)
          : payload.reason === undefined
            ? this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
            : this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot, payload.reason))
        this.sessionAffinity.set(payload.sessionId, conn.key)
        sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        this.rpcError(conn, frame.id, 'internal', String(error))
      }
      return
    }
    if (frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = purgeSessionPayload(frame.payload)
      if (sessionId === undefined) {
        this.rpcError(conn, frame.id, 'bad-request', 'sessionId must be a non-empty string')
        return
      }
      try {
        await this.deps.purgeSession(sessionId)
        sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { purged: true } })
      } catch (error: unknown) {
        this.rpcError(conn, frame.id, error instanceof SessionPurgeError ? error.code : 'internal', errorMessage(error))
      }
      return
    }
    // A panel prompt: the bridge mints the request id DSH stamps on its user
    // source (overwriting any the payload carries), so the id Auto review trusts
    // is never the caller's choice.
    const minted = frame.method === 'session.prompt' && this.deps.onPanelPrompt !== undefined
      && typeof frame.payload === 'object' && frame.payload !== null && !Array.isArray(frame.payload)
      ? randomUUID()
      : undefined
    // Recorded before the Host runs the prompt (its turn may raise cards before
    // the call returns); an id that never reaches the history trusts nothing.
    const panelSession = minted === undefined ? undefined : orderedSessionId(frame)
    if (panelSession !== undefined && minted !== undefined) {
      const content = (frame.payload as { content?: unknown }).content
      const text = Array.isArray(content)
        ? content.filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string').map((block) => block.text).join('\n')
        : ''
      try { this.deps.onPanelPrompt?.(panelSession, minted, text) } catch { /* observer only */ }
    }
    try {
      const result = await this.deps.api.call({
        rpcId: frame.id,
        method: frame.method,
        payload: minted === undefined ? frame.payload : { ...(frame.payload as Record<string, unknown>), requestId: minted },
        signal: conn.abort.signal,
      })
      // Bind the session to this browser only once the Host accepted the
      // prompt (an unauthorized prompt must not steer another session's tools).
      const prompted = frame.method === 'session.prompt' ? orderedSessionId(frame) : undefined
      if (prompted !== undefined && result.ok) this.sessionAffinity.set(prompted, conn.key)
      if (!result.ok && panelSession !== undefined && minted !== undefined) {
        try { this.deps.onPanelPromptRejected?.(panelSession, minted) } catch { /* observer only */ }
      }
      sendFrame(conn, {
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: { type: 'server-response', rpcId: frame.id, result },
      })
    } catch (error: unknown) {
      if (panelSession !== undefined && minted !== undefined) {
        try { this.deps.onPanelPromptRejected?.(panelSession, minted) } catch { /* observer only */ }
      }
      this.rpcError(conn, frame.id, 'internal', String(error))
    }
  }

  /** The pending call `payload.toolCallId` names, if this connection owns it. */
  private ownedTool(conn: ReadyConnection, payload: unknown): PendingTool | undefined {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const id = (payload as Record<string, unknown>).toolCallId
    if (typeof id !== 'string') return undefined
    const tool = this.pendingTools.get(id)
    // Another client must not hold, or raise approvals for, a call it was not sent.
    return tool !== undefined && tool.conn === conn ? tool : undefined
  }

  private rpcError(conn: ReadyConnection, id: string, code: string, message: string): void {
    sendFrame(conn, { t: 'rpc.result', id, ok: false, error: { code, message } })
  }

  /** Extend one owned call's deadline while its approval is outstanding. */
  private handleToolHold(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const tool = this.ownedTool(conn, frame.payload)
    if (tool === undefined) {
      this.rpcError(conn, frame.id, 'not-found', 'no pending tool call with that id on this connection')
      return
    }
    const holdMs = (frame.payload as Record<string, unknown>).holdMs
    if (typeof holdMs !== 'number' || !Number.isFinite(holdMs) || holdMs <= 0) {
      this.rpcError(conn, frame.id, 'bad-request', 'holdMs must be a positive number')
      return
    }
    const target = Math.min(this.now() + holdMs, tool.holdCeiling)
    if (target > tool.expiresAt) {
      tool.expiresAt = target
      tool.rearm()
    }
    sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { expiresAt: tool.expiresAt } })
  }

  /** Forward one approval for an owned call to dsh's approval service. */
  private async handleApprovalAsk(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const request = this.deps.requestHostApproval
    if (request === undefined) {
      this.rpcError(conn, frame.id, 'unsupported', 'this bridge does not forward approvals')
      return
    }
    const tool = this.ownedTool(conn, frame.payload)
    if (tool === undefined) {
      this.rpcError(conn, frame.id, 'not-found', 'no pending tool call with that id on this connection')
      return
    }
    const { approvalId, binding, reason } = frame.payload as Record<string, unknown>
    if (typeof approvalId !== 'string' || approvalId === '' || approvalId.length > 128
      || (binding !== undefined && !isBridgeHex256(binding))
      || typeof reason !== 'string' || reason.trim() === '') {
      this.rpcError(conn, frame.id, 'bad-request', 'approvalId, reason and an optional SHA-256 binding are required')
      return
    }
    if (reason.length > MAX_HOST_APPROVAL_REASON_CHARS) {
      // Never truncate what the user approves: refuse instead.
      this.rpcError(conn, frame.id, 'too-large', 'the approval is too large to forward; review it in the browser')
      return
    }
    if (tool.approvals.has(approvalId)) {
      this.rpcError(conn, frame.id, 'bad-request', 'that approval is already forwarded')
      return
    }
    const echo = { approvalId, ...(binding === undefined ? {} : { binding }) }
    // An external (MCP client) session has no DSH turn to put a question to:
    // its approvals are answered in the browser only.
    if (tool.sessionId === undefined || isExternalSessionId(tool.sessionId)) {
      sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { ...echo, decision: 'unavailable' } })
      return
    }
    const controller = new AbortController()
    tool.approvals.set(approvalId, controller)
    let outcome: HostApprovalOutcome
    try {
      outcome = await request({
        sessionId: tool.sessionId,
        toolName: tool.name,
        ...(tool.callId === undefined ? {} : { callId: tool.callId }),
        reason,
        signal: controller.signal,
      })
    } catch {
      outcome = 'unavailable'
    } finally {
      tool.approvals.delete(approvalId)
    }
    // Only a grant to the still-pending call counts; everything else fails closed.
    const decision = controller.signal.aborted
      ? 'cancelled'
      : outcome === 'allowed-once' ? 'allow-once'
      : outcome === 'rejected' ? 'deny'
      : outcome === 'cancelled' ? 'cancelled'
      : 'unavailable'
    sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { ...echo, decision } })
  }

  /**
   * The silent review of one consequential action of an owned pending call
   * while Auto approve is on (docs/auto-approve-design.md §5). The session and
   * tool come from this bridge's own record of the call; the payload's tool
   * must agree with it. Every failure answers "deny" or an RPC error: the
   * extension shows the card.
   */
  private async handleReviewAsk(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const service = this.deps.autoReview
    if (service === undefined || !this.reviewSupported()) {
      this.rpcError(conn, frame.id, 'unsupported', 'this bridge does not review approvals')
      return
    }
    const tool = this.ownedTool(conn, frame.payload)
    if (tool === undefined) {
      this.rpcError(conn, frame.id, 'not-found', 'no pending tool call with that id on this connection')
      return
    }
    const { toolCallId, reviewId, binding, action: rawAction } = frame.payload as Record<string, unknown>
    const action = parseReviewAction(rawAction)
    if (typeof reviewId !== 'string' || reviewId === '' || reviewId.length > MAX_REVIEW_ID_CHARS
      || !isBridgeHex256(binding) || action === undefined) {
      this.rpcError(conn, frame.id, 'bad-request', 'reviewId, a SHA-256 binding and a valid action are required')
      return
    }
    if (action.tool !== tool.name) {
      this.rpcError(conn, frame.id, 'bad-request', 'the action does not match the pending call')
      return
    }
    // An external (MCP client) session has no user instruction source.
    if (tool.sessionId === undefined || isExternalSessionId(tool.sessionId)) {
      this.rpcError(conn, frame.id, 'unavailable', 'this call has no conversation to review against')
      return
    }
    if (tool.reviews.size > 0) {
      this.rpcError(conn, frame.id, 'bad-request', 'a review for this call is already running')
      return
    }
    const callId = toolCallId as string
    const controller = new AbortController()
    tool.reviews.set(reviewId, controller)
    // The user's click that started this very call: the bridge's own record, read once.
    const panelAction = tool.panelAction
    delete tool.panelAction
    let record: ReviewRecord
    try {
      record = await (panelAction === undefined
        ? service.review(tool.sessionId, action, controller.signal)
        : service.review(tool.sessionId, action, controller.signal, panelAction))
    } catch (error: unknown) {
      record = { decision: 'deny', reason: 'The reviewer could not decide.', code: 'failed', latencyMs: 0, failure: errorMessage(error) }
    } finally {
      if (tool.reviews.get(reviewId) === controller) tool.reviews.delete(reviewId)
    }
    // Only a review of the still-pending, unaborted call may allow.
    if (controller.signal.aborted || this.pendingTools.get(callId) !== tool) {
      record = { ...record, decision: 'deny', reason: 'The review was cancelled.', code: 'cancelled', failure: record.failure ?? 'cancelled' }
    }
    this.auditSafely(audit => {
      audit.reviewed?.(callId, {
        decision: record.decision,
        reason: record.reason,
        ...(record.model === undefined ? {} : { model: record.model }),
        latencyMs: record.latencyMs,
        binding,
        code: record.code,
        ...(record.failure === undefined ? {} : { failure: record.failure }),
      })
    })
    sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: reviewAnswer(reviewId, binding, record) })
  }

  /** Abort one in-flight review (Auto turned off, the kill switch, the call cancelled). */
  private handleReviewCancel(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const tool = this.ownedTool(conn, frame.payload)
    const reviewId = tool === undefined ? undefined : (frame.payload as Record<string, unknown>).reviewId
    const controller = tool === undefined || typeof reviewId !== 'string' ? undefined : tool.reviews.get(reviewId)
    controller?.abort()
    sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { cancelled: controller !== undefined } })
  }

  /** Whether one conversation can be reviewed (the panel's toggle); grants nothing. */
  private async handleReviewStatus(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const payload = frame.payload
    const sessionId = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).sessionId : undefined
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 256) {
      this.rpcError(conn, frame.id, 'bad-request', 'sessionId must be a non-empty string')
      return
    }
    const service = this.deps.autoReview
    if (service === undefined || !this.reviewSupported()) {
      sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { available: false, reason: 'host-unsupported' } })
      return
    }
    if (this.deps.sessionScope !== undefined && !isExternalSessionId(sessionId)
      && !await this.deps.sessionScope.allowsSession(sessionId, conn.abort.signal, 'read').catch(() => false)) {
      this.rpcError(conn, frame.id, 'forbidden', `session ${JSON.stringify(sessionId)} is not available to the browser bridge`)
      return
    }
    let status: ReturnType<AutoReviewService['status']>
    try {
      status = service.status(sessionId, isExternalSessionId(sessionId))
    } catch {
      status = { available: false, reason: 'host-unsupported' }
    }
    sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: status })
  }

  /** Withdraw a forwarded approval once the browser has settled it. */
  private handleApprovalWithdraw(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const tool = this.ownedTool(conn, frame.payload)
    const approvalId = tool === undefined ? undefined : (frame.payload as Record<string, unknown>).approvalId
    const controller = tool === undefined || typeof approvalId !== 'string'
      ? undefined
      : tool.approvals.get(approvalId)
    controller?.abort()
    sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { withdrawn: controller !== undefined } })
  }

  /** Relay a pending Host waterfall response through the active adapter. */
  private async handleRespond(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'respond' }>): Promise<void> {
    try {
      const result = await this.deps.api.respond(frame.rpcId, frame.result, conn.abort.signal)
      sendFrame(conn, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(conn: ReadyConnection, frame: Extract<ClientFrame, { t: 'tool.result' }>): void {
    const pending = this.pendingTools.get(frame.id)
    // Only the connection the call was sent to may answer it.
    if (pending === undefined || pending.conn !== conn) return
    clearTimeout(pending.timer)
    this.dropPendingTool(frame.id)
    // Only an answer from the extension can vouch for a result (never a timeout or cancel).
    const { sessionId, callId } = pending
    if (sessionId !== undefined && callId !== undefined) {
      this.noteLineage(lineage => { lineage.noteResult?.(sessionId, callId, frame.taintExempt === true, frame.taintExemptLocal === true) })
    }
    if (frame.ok) {
      // An unbound session that a browser served is bound there from now on
      // (never rebinds: a bound session is only ever routed to its install).
      if (pending.sessionId !== undefined && !this.sessionAffinity.has(pending.sessionId)) {
        this.sessionAffinity.set(pending.sessionId, conn.key)
      }
      this.auditSafely(audit => { audit.settled(frame.id, { ok: true, result: frame.result }) })
      pending.resolve(frame.result)
    } else {
      const error = new BridgeToolError(frame.error.code, frame.error.message || 'browser action failed')
      this.auditSettled(frame.id, error)
      pending.reject(error)
    }
  }

  /** Record a failed or withdrawn call; auditing never affects the call itself. */
  private auditSettled(id: string, error: BridgeToolError): void {
    this.auditSafely(audit => { audit.settled(id, { ok: false, error: { code: error.code, message: error.message } }) })
  }

  private auditSafely(record: (audit: BridgeAuditObserver) => void): void {
    if (this.deps.audit === undefined) return
    try {
      record(this.deps.audit)
    } catch { /* the audit observer owns its own failures */ }
  }

  /** Forget one pending call and withdraw any approval it forwarded to dsh. */
  private dropPendingTool(id: string): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    this.pendingTools.delete(id)
    for (const controller of pending.approvals.values()) controller.abort()
    pending.approvals.clear()
    for (const controller of pending.reviews.values()) controller.abort()
    pending.reviews.clear()
  }

  /** Close one connection and settle only its own in-flight calls. */
  private dropConnection(conn: ReadyConnection, reason: string, closeCode: number = BRIDGE_CLOSE_CODES.replaced): void {
    if (this.connections.get(conn.key) === conn) {
      this.connections.delete(conn.key)
      try { this.deps.onDisconnect?.(conn.key) } catch { /* observer only */ }
    }
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(closeCode, closeCode === BRIDGE_CLOSE_CODES.replaced ? 'replaced' : reason)
    }
    for (const [id, pending] of [...this.pendingTools]) {
      if (pending.conn !== conn) continue
      clearTimeout(pending.timer)
      this.dropPendingTool(id)
      const error = new BridgeToolError('bridge-closed', reason)
      this.auditSettled(id, error)
      pending.reject(error)
    }
    if (!this.closed) this.deps.onCapsChange?.(conn.clientCaps)
  }
}

function isLoopbackHost(host: string): boolean {
  const canonical = canonicalBridgeHost(host)
  return canonical === '::1' || (canonical !== undefined && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(canonical))
}

/** The address and port an accepted socket is bound to. */
function localEndpointOf(socket: Socket): BridgeEndpoint | undefined {
  const { localAddress, localPort } = socket
  if (typeof localAddress !== 'string' || typeof localPort !== 'number') return undefined
  return { host: localAddress, port: localPort }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string; reason?: 'follow' | 'resume'; taintExempt: boolean; taintExemptLocal: boolean } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot, reason, taintExempt, taintExemptLocal } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  if (reason !== undefined && reason !== 'follow' && reason !== 'resume') return undefined
  // `taintExempt`: the extension vouches that every frame in the snapshot is exempt from taint (session-taint.ts).
  return { sessionId, snapshot, ...(reason === undefined ? {} : { reason }), taintExempt: taintExempt === true, taintExemptLocal: taintExemptLocal === true }
}

function purgeSessionPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  return sessionId
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}
