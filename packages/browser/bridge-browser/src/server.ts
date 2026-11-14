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
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
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
  BRIDGE_CLOSE_CODES,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
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
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
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
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false
  /** Sockets still in the handshake, oldest first. */
  private readonly pendingSockets = new Set<WebSocket>()
  private readonly chromeExtensionIds: ReadonlySet<string>

  constructor(private readonly deps: BridgeServerDeps) {
    this.chromeExtensionIds = new Set(deps.allowedChromeExtensionIds ?? [PINNED_CHROME_EXTENSION_ID])
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
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
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
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
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
    // Capture the live pump BEFORE replaceConnection nulls the connection.
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
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
    return this.current !== null
  }

  /**
   * Whether the connected extension can serve the developer-tools group.
   * Read by the plugin when it (re)registers that tool group.
   * @returns true only for a live connection whose `hello` advertised devtools.
   */
  devToolsSupported(): boolean {
    return isDevToolsCaps(this.current?.clientCaps.devTools)
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
        this.promote(ws, remoteAddress, frame.caps, channel,
          bridgeProof(this.deps.token, 'server', frame.nonce, serverNonce, frame.endpoint, { client: frame.caps, server: this.deps.caps }, nodeHmac))
        return
      }
      const frame = channel?.open(text)
      if (frame === undefined) {
        ws.close(BRIDGE_CLOSE_CODES.authFailed, 'frame authentication failed')
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      leavePending()
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
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

  /** Promote an authenticated socket to the single active slot. */
  private promote(
    ws: WebSocket,
    remoteAddress: string | undefined,
    clientCaps: BridgeCaps,
    channel: BridgeFrameChannel,
    serverMac: string,
  ): void {
    this.replaceConnection()
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
    this.current = { ws, remoteAddress, clientCaps, channel, abort, pump, ping }
    sendHandshakeFrame(ws, { t: 'hello.ok', caps: this.deps.caps, mac: serverMac })
    // Notify only after the new connection owns the slot, so a listener reading
    // `devToolsSupported()` sees the capability that just arrived.
    this.deps.onCapsChange?.(clientCaps)
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame)
        break
      case 'respond':
        void this.handleRespond(frame)
        break
      case 'tool.result':
        this.settleTool(frame)
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
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame),
      () => this.handleRpc(frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- replacement race: a frame can land between a socket
    replacement and the next promotion; the re-check keeps the handler total */
    if (conn === null) return
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

  /** Relay a pending Host waterfall response through the active adapter. */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>): Promise<void> {
    const conn = this.current
    /* v8 ignore next -- replacement race; a closed socket simply drops the receipt */
    if (conn === null) return
    try {
      const result = await this.deps.api.respond(frame.rpcId, frame.result, conn.abort.signal)
      sendFrame(conn, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(frame: Extract<ClientFrame, { t: 'tool.result' }>): void {
    const pending = this.pendingTools.get(frame.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(frame.id)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(new BridgeToolError(frame.error.code, frame.error.message || 'browser action failed'))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(BRIDGE_CLOSE_CODES.replaced, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
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
