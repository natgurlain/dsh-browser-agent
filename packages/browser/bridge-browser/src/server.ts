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
 * Frames are authenticated, not encrypted. The token never crosses the wire. A `chrome-extension://` Origin is accepted
 * only for the pinned extension ID (defense in depth on top of the token; any
 * local process can forge an Origin header). Host calls terminate at the
 * bridge-owned Host adapter.
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
 * Tool calls go to the connection a session last prompted from (or that last
 * answered one of its tool calls), else to the most recently active
 * connection that can serve the tool. A `tool.result` is accepted only from
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
  BRIDGE_APPROVAL_ASK_METHOD,
  BRIDGE_APPROVAL_WITHDRAW_METHOD,
  BRIDGE_CLOSE_CODES,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_TOOL_HOLD_METHOD,
  DEVTOOLS_TOOL_NAMES,
  HOST_APPROVALS_CAPS_VERSION,
  MAX_HOST_APPROVAL_REASON_CHARS,
  bridgeClientKey,
  isBridgeHex256,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SESSION_PURGE_METHOD,
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
  parseBridgeFrame,
  type BridgeEndpoint,
  type BridgeFrame,
  type BridgeCaps,
  type BridgeHmac,
  type ClientFrame,
  type ToolErrorCode,
} from './protocol.ts'
import { SessionPurgeError } from './session-purge.ts'
import { verifyToken } from './token.ts'

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
 * @returns true when the handshake may proceed.
 */
export function isAllowedBridgeOrigin(origin: string | undefined, chromeExtensionIds: ReadonlySet<string>): boolean {
  if (origin === undefined || origin === '') return true
  if (origin.startsWith('moz-extension://')) return true
  const chrome = /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin)
  return chrome !== null && chromeExtensionIds.has(chrome[1]!)
}

/** Native HMAC-SHA256 for the node half (same bytes as protocol.hmacSha256). */
const nodeHmac: BridgeHmac = (key, message) => createHmac('sha256', key).update(message).digest()

/** Largest message an unauthenticated socket may send (a `hello` is < 1 KiB). */
export const PRE_AUTH_MAX_PAYLOAD = 64 * 1024

/** Sockets allowed to sit in the handshake at once; the oldest is evicted as busy. */
export const MAX_PENDING_SOCKETS = 16

/** Authenticated connections kept at once; the least recently active is evicted beyond it. */
export const MAX_READY_CONNECTIONS = 8

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
  /** Shared secret both sides prove knowledge of during the handshake. */
  token: string
  /**
   * Chrome extension IDs whose `chrome-extension://` Origin may connect.
   * Defaults to {@link PINNED_CHROME_EXTENSION_ID}.
   */
  allowedChromeExtensionIds?: readonly string[]
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
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * Permanently delete one session's durable storage. Callers archive the
   * session through the gateway first; this only removes files.
   */
  purgeSession: (sessionId: string) => Promise<void>
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
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
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
  /** Clock seam for tests. */
  now?: () => number
}

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
  /** Capabilities the extension advertised in its `hello`. */
  clientCaps: BridgeCaps
  /** Per-connection frame integrity (sealing and verification). */
  channel: BridgeFrameChannel
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
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
  /** Session → client key that last prompted it or answered one of its tool calls. */
  private readonly sessionAffinity = new Map<string, string>()
  private connectionSerial = 0
  private readonly serverCaps: BridgeCaps
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false
  /** Sockets still in the handshake, oldest first. */
  private readonly pendingSockets = new Set<WebSocket>()
  private readonly chromeExtensionIds: ReadonlySet<string>

  constructor(private readonly deps: BridgeServerDeps) {
    this.chromeExtensionIds = new Set(deps.allowedChromeExtensionIds ?? [PINNED_CHROME_EXTENSION_ID])
    const { hostApprovals: _hostApprovals, client: _client, ...caps } = deps.caps
    this.serverCaps = deps.requestHostApproval === undefined
      ? caps
      : { ...caps, hostApprovals: HOST_APPROVALS_CAPS_VERSION }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
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
  ): Promise<unknown> {
    const conn = this.pickConnection(name, sessionId)
    if (conn === undefined) {
      throw new BridgeToolError('bridge-closed', this.connections.size === 0
        ? 'no browser extension is connected to the bridge'
        : `no connected browser extension can serve "${name}"`)
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const startedAt = this.now()
    const expiresAt = startedAt + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const settle = (error: BridgeToolError): void => {
        clearTimeout(entry.timer)
        this.dropPendingTool(id)
        signal.removeEventListener('abort', onAbort)
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
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, entry)
      conn.ws.send(conn.channel.seal({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
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
    for (const conn of [...this.connections.values()]) this.dropConnection(conn, 'the bridge closed')
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

  /**
   * Choose the connection for one tool call: the session's affine client
   * when it is connected and can serve the tool, else the most recently
   * active capable connection.
   */
  private pickConnection(name: string, sessionId: string | undefined): ReadyConnection | undefined {
    const capable = (conn: ReadyConnection): boolean =>
      conn.ws.readyState === WebSocket.OPEN
      && (!DEVTOOLS_TOOLS.has(name) || isDevToolsCaps(conn.clientCaps.devTools))
    if (sessionId !== undefined) {
      const key = this.sessionAffinity.get(sessionId)
      const affine = key === undefined ? undefined : this.connections.get(key)
      if (affine !== undefined && capable(affine)) return affine
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
    if (!isAllowedBridgeOrigin(origin, this.chromeExtensionIds)) {
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
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        if (local === undefined || !this.endpointAccepted(frame.endpoint, local)) {
          // The client dialed somewhere else: a relay is forwarding this
          // handshake (or the bridge sits behind a port forward, unsupported).
          ws.close(BRIDGE_CLOSE_CODES.authFailed, 'authentication failed: endpoint mismatch')
          return
        }
        const expected = bridgeProof(this.deps.token, 'client', serverNonce, frame.nonce, frame.endpoint, { client: frame.caps }, nodeHmac)
        if (frame.nonce === serverNonce || !verifyToken(expected, frame.mac)) {
          ws.close(BRIDGE_CLOSE_CODES.authFailed, 'authentication failed')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        leavePending()
        if (limited) setSocketMaxPayload(ws, this.wss.options.maxPayload ?? 100 * 1024 * 1024)
        channel = BridgeFrameChannel.derive(this.deps.token, 'server', serverNonce, frame.nonce, frame.endpoint, nodeHmac)
        ready = this.promote(ws, remoteAddress, frame.caps, channel,
          bridgeProof(this.deps.token, 'server', frame.nonce, serverNonce, frame.endpoint, { client: frame.caps, server: this.serverCaps }, nodeHmac))
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
    clientCaps: BridgeCaps,
    channel: BridgeFrameChannel,
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
      clientCaps,
      channel,
      abort,
      pump,
      ping,
    }
    this.connections.set(key, conn)
    sendHandshakeFrame(ws, { t: 'hello.ok', caps: this.serverCaps, mac: serverMac })
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
    // The browser a session is driven from is where its tools should act.
    if (frame.method === 'session.prompt' || frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      this.sessionAffinity.set(sessionId, conn.key)
    }
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
    const forbidden = PRIVILEGED_METHODS.has(frame.method) && !isLoopbackAddress(conn.remoteAddress)
    if (forbidden) {
      sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
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
        sendFrame(conn, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'forbidden', message: `session ${JSON.stringify(sessionId)} is not available to the browser bridge` },
        })
        return
      }
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        sendFrame(conn, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        sendFrame(conn, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = purgeSessionPayload(frame.payload)
      if (sessionId === undefined) {
        sendFrame(conn, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId must be a non-empty string' },
        })
        return
      }
      try {
        await this.deps.purgeSession(sessionId)
        sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: true, result: { purged: true } })
      } catch (error: unknown) {
        const code = error instanceof SessionPurgeError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: false, error: { code, message } })
      }
      return
    }
    try {
      const result = await this.deps.api.call({
        rpcId: frame.id,
        method: frame.method,
        payload: frame.payload,
        signal: conn.abort.signal,
      })
      sendFrame(conn, {
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: { type: 'server-response', rpcId: frame.id, result },
      })
    } catch (error: unknown) {
      sendFrame(conn, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
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
    if (tool.sessionId === undefined) {
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
    if (frame.ok) {
      if (pending.sessionId !== undefined) this.sessionAffinity.set(pending.sessionId, conn.key)
      pending.resolve(frame.result)
    } else {
      pending.reject(new BridgeToolError(frame.error.code, frame.error.message || 'browser action failed'))
    }
  }

  /** Forget one pending call and withdraw any approval it forwarded to dsh. */
  private dropPendingTool(id: string): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    this.pendingTools.delete(id)
    for (const controller of pending.approvals.values()) controller.abort()
    pending.approvals.clear()
  }

  /** Close one connection and settle only its own in-flight calls. */
  private dropConnection(conn: ReadyConnection, reason: string): void {
    if (this.connections.get(conn.key) === conn) this.connections.delete(conn.key)
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(BRIDGE_CLOSE_CODES.replaced, 'replaced')
    }
    for (const [id, pending] of [...this.pendingTools]) {
      if (pending.conn !== conn) continue
      clearTimeout(pending.timer)
      this.dropPendingTool(id)
      pending.reject(new BridgeToolError('bridge-closed', reason))
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

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
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
