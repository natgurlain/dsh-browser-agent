/**
 * Loopback MCP endpoint (Streamable HTTP, JSON responses) that lets other
 * agent harnesses — Claude Code, Cursor, Codex — drive the user's browser
 * through this bridge.
 *
 * Every MCP client connection (one `initialize`, one `Mcp-Session-Id`) maps to
 * a bridge-owned external session (`mcp-…`, recorded in the session ledger).
 * Tool calls run through the very same registered browser tool definitions as
 * DSH Agents (mcp-tools.ts), so the extension's pause gate, site policy,
 * taint, kill switch, payload-bound approval cards (labelled with the
 * client's self-reported name) and the bridge's audit log all apply.
 *
 * Hardening (the endpoint is reachable by every local process and, through
 * DNS rebinding, potentially by web pages):
 * - binds 127.0.0.1 only, and refuses non-loopback peers;
 * - a separate bearer token (0600 file under the dsh home), compared in
 *   constant time, on every request;
 * - any `Origin` header is refused (browsers always send one on cross-origin
 *   POSTs; MCP clients never do), and `Host` must name the loopback address
 *   and the bound port exactly (defeats DNS rebinding);
 * - JSON content type only (no form-encoded "simple" requests), bounded
 *   bodies, bounded sessions with idle expiry, no JSON-RPC batches.
 *
 * Only the tools capability is offered; there is no server-initiated stream
 * (GET answers 405), which the Streamable HTTP transport permits.
 *
 * @module
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isLoopbackAddress } from './server.ts'
import { errorMessage } from './host-api.ts'

/** URL path of the MCP endpoint. */
export const MCP_PATH = '/mcp'

/** Protocol revisions this endpoint speaks (newest first). */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** Default cap on concurrent MCP sessions (client connections). */
export const DEFAULT_MCP_MAX_SESSIONS = 16

/** Default idle time after which an MCP session is forgotten. */
export const DEFAULT_MCP_IDLE_MS = 60 * 60_000

/** Default cap on one request body. */
export const DEFAULT_MCP_MAX_BODY_BYTES = 1024 * 1024

/** One tool as MCP `tools/list` reports it. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** One MCP content block (the subset this bridge produces). */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** A `tools/call` result. */
export interface McpCallResult {
  content: McpContent[]
  isError?: boolean
}

/** Identity one MCP session acts under. */
export interface McpCaller {
  /** Bridge-owned external session id (`mcp-…`). */
  sessionId: string
  /** Sanitized client label shown on approval cards. */
  requester: string
}

/** What the endpoint needs from the bridge. */
export interface McpToolHost {
  /** Tools to advertise right now (devtools come and go with the extension). */
  list(): McpTool[]
  /** Whether a tool name is served. */
  has(name: string): boolean
  /** Run one call for a caller; failures are returned as `isError` results. */
  call(name: string, args: Record<string, unknown>, caller: McpCaller, signal: AbortSignal): Promise<McpCallResult>
}

/** Options for {@link McpHttpServer}. */
export interface McpHttpServerOptions {
  /** Bearer token every request must carry. */
  token: string
  /** The tool surface. */
  tools: McpToolHost
  /**
   * Mint the external session for a new client connection (records it in the
   * ledger). `clientName` is untrusted and already sanitized.
   */
  openSession: (clientName: string) => Promise<McpCaller>
  /** Server identity reported in `initialize`. */
  serverInfo: { name: string; version: string }
  /** Short usage note returned as `instructions`. */
  instructions?: string
  maxSessions?: number
  idleMs?: number
  maxBodyBytes?: number
  /** Clock seam for tests. */
  now?: () => number
  /** Test seam: force the peer address seen by the loopback gate. */
  remoteAddressOverride?: string
  /** Diagnostics sink. */
  log?: (message: string) => void
}

interface McpSession {
  id: string
  caller: McpCaller
  protocolVersion: string
  lastSeen: number
  /** In-flight `tools/call` requests by JSON-RPC id, for `notifications/cancelled`. */
  inflight: Map<string, AbortController>
}

type JsonRpcId = string | number

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: JsonRpcId | null
  method?: string
  params?: unknown
}

/** JSON-RPC error codes used here. */
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

/** The loopback Streamable HTTP MCP endpoint. */
export class McpHttpServer {
  private readonly sessions = new Map<string, McpSession>()
  private server: Server | undefined
  private port: number | undefined
  private readonly tokenDigest: Buffer

  constructor(private readonly options: McpHttpServerOptions) {
    if (options.token.length < 32) throw new Error('the MCP token must be at least 32 characters')
    this.tokenDigest = digest(options.token)
  }

  /**
   * Listen on 127.0.0.1 (never another interface).
   * @param port - requested port; 0 picks a free one.
   * @returns the bound address, port and URL of the MCP endpoint.
   */
  async listen(port = 0): Promise<{ address: string; port: number; url: string }> {
    if (this.server !== undefined) throw new Error('the MCP endpoint is already listening')
    const server = createServer((req, res) => { void this.handle(req, res) })
    server.headersTimeout = 10_000
    server.requestTimeout = 0
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    const bound = server.address() as AddressInfo
    this.port = bound.port
    // Report what the socket is actually bound to, not what was asked for.
    return { address: bound.address, port: this.port, url: `http://${bound.address}:${String(this.port)}${MCP_PATH}` }
  }

  /** Stop listening and abort every in-flight call. */
  async close(): Promise<void> {
    for (const session of this.sessions.values()) for (const call of session.inflight.values()) call.abort()
    this.sessions.clear()
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }

  /** Number of live MCP sessions (tests and diagnostics). */
  sessionCount(): number {
    return this.sessions.size
  }

  /**
   * Handle one HTTP request. Public so the gate order is unit-testable with
   * plain request objects; production only reaches it through `listen()`.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const refusal = this.gate(req)
      if (refusal !== undefined) {
        reply(res, refusal.status, refusal.body, refusal.headers)
        return
      }
      this.expireIdle()
      if (req.method === 'DELETE') {
        const id = header(req, 'mcp-session-id')
        const session = id === undefined ? undefined : this.sessions.get(id)
        if (session === undefined) {
          reply(res, 404, { error: 'unknown MCP session' })
          return
        }
        this.endSession(session)
        reply(res, 204)
        return
      }
      if (req.method === 'GET') {
        reply(res, 405, { error: 'this endpoint has no server-initiated stream' }, { allow: 'POST, DELETE' })
        return
      }
      if (req.method !== 'POST') {
        reply(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' })
        return
      }
      const type = header(req, 'content-type') ?? ''
      if (!/^application\/json\s*(;|$)/iu.test(type)) {
        reply(res, 415, { error: 'content-type must be application/json' })
        return
      }
      const version = header(req, 'mcp-protocol-version')
      if (version !== undefined && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        reply(res, 400, rpcError(null, INVALID_REQUEST, `unsupported MCP-Protocol-Version ${JSON.stringify(version)}`))
        return
      }
      const body = await readBody(req, this.options.maxBodyBytes ?? DEFAULT_MCP_MAX_BODY_BYTES)
      if (body === undefined) {
        reply(res, 413, rpcError(null, INVALID_REQUEST, 'request body too large'))
        return
      }
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        reply(res, 400, rpcError(null, PARSE_ERROR, 'invalid JSON'))
        return
      }
      if (Array.isArray(message)) {
        reply(res, 400, rpcError(null, INVALID_REQUEST, 'JSON-RPC batches are not supported'))
        return
      }
      if (!isRpcMessage(message)) {
        reply(res, 400, rpcError(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 message'))
        return
      }
      await this.dispatch(req, res, message)
    } catch (error: unknown) {
      this.options.log?.(`browser bridge MCP: request failed: ${errorMessage(error)}`)
      if (!res.headersSent) reply(res, 500, rpcError(null, -32603, 'internal error'))
      else res.end()
    }
  }

  /** Transport-level refusals, checked before the body is read. */
  private gate(req: IncomingMessage): { status: number; body: unknown; headers?: Record<string, string> } | undefined {
    const remote = this.options.remoteAddressOverride ?? req.socket.remoteAddress
    if (!isLoopbackAddress(remote)) return { status: 403, body: { error: 'loopback clients only' } }
    // Browsers attach Origin to every cross-origin POST/DELETE; MCP clients
    // (Node, Python, Rust processes) do not. Refusing any Origin closes the
    // browser-CSRF path even before the token check.
    if (req.headers.origin !== undefined) return { status: 403, body: { error: 'browser origins are not allowed' } }
    if (!this.allowedHost(header(req, 'host'))) return { status: 403, body: { error: 'unexpected Host header' } }
    const url = (req.url ?? '').split('?')[0]
    if (url !== MCP_PATH) return { status: 404, body: { error: 'not found' } }
    const auth = header(req, 'authorization')
    const match = auth === undefined ? null : /^Bearer\s+(\S+)\s*$/u.exec(auth)
    if (match === null || !timingSafeEqual(digest(match[1]!), this.tokenDigest)) {
      return { status: 401, body: { error: 'missing or wrong bearer token' }, headers: { 'www-authenticate': 'Bearer' } }
    }
    return undefined
  }

  /** Host must be the loopback literal (or localhost) and the bound port. */
  private allowedHost(host: string | undefined): boolean {
    if (host === undefined || this.port === undefined) return false
    const port = String(this.port)
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, message: JsonRpcMessage): Promise<void> {
    const isRequest = message.id !== undefined && message.id !== null
    if (message.method === 'initialize') {
      if (!isRequest) {
        reply(res, 400, rpcError(null, INVALID_REQUEST, 'initialize must be a request'))
        return
      }
      await this.initialize(res, message)
      return
    }
    const sessionId = header(req, 'mcp-session-id')
    if (sessionId === undefined) {
      reply(res, 400, rpcError(message.id ?? null, INVALID_REQUEST, 'missing Mcp-Session-Id; send initialize first'))
      return
    }
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      reply(res, 404, rpcError(message.id ?? null, INVALID_REQUEST, 'unknown or expired MCP session; initialize again'))
      return
    }
    session.lastSeen = this.now()
    if (!isRequest) {
      if (message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId
        if (typeof requestId === 'string' || typeof requestId === 'number') session.inflight.get(String(requestId))?.abort()
      }
      // Notifications and client responses are accepted without a body.
      reply(res, 202)
      return
    }
    const id = message.id as JsonRpcId
    switch (message.method) {
      case 'ping':
        reply(res, 200, { jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        reply(res, 200, { jsonrpc: '2.0', id, result: { tools: this.options.tools.list() } })
        return
      case 'tools/call':
        await this.callTool(res, session, id, message.params)
        return
      default:
        reply(res, 200, rpcError(id, METHOD_NOT_FOUND, `method ${JSON.stringify(message.method)} is not supported`))
    }
  }

  private async initialize(res: ServerResponse, message: JsonRpcMessage): Promise<void> {
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as {
      protocolVersion?: unknown
      clientInfo?: { name?: unknown; title?: unknown }
    }
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
    const protocolVersion = requested !== undefined && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : MCP_PROTOCOL_VERSIONS[0]
    if (!this.makeRoom()) {
      reply(res, 503, rpcError(message.id ?? null, -32000, 'too many MCP sessions with calls in flight; try again later'))
      return
    }
    const rawName = params.clientInfo?.title ?? params.clientInfo?.name
    const caller = await this.options.openSession(typeof rawName === 'string' ? rawName : '')
    const session: McpSession = {
      id: randomUUID(),
      caller,
      protocolVersion,
      lastSeen: this.now(),
      inflight: new Map(),
    }
    this.sessions.set(session.id, session)
    reply(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: this.options.serverInfo,
        ...(this.options.instructions === undefined ? {} : { instructions: this.options.instructions }),
      },
    }, { 'mcp-session-id': session.id })
  }

  private async callTool(res: ServerResponse, session: McpSession, id: JsonRpcId, params: unknown): Promise<void> {
    if (typeof params !== 'object' || params === null) {
      reply(res, 200, rpcError(id, INVALID_PARAMS, 'tools/call needs params'))
      return
    }
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown }
    if (typeof name !== 'string' || !this.options.tools.has(name)) {
      reply(res, 200, rpcError(id, INVALID_PARAMS, `unknown tool ${JSON.stringify(name)}`))
      return
    }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      reply(res, 200, rpcError(id, INVALID_PARAMS, 'arguments must be an object'))
      return
    }
    const controller = new AbortController()
    const key = String(id)
    session.inflight.get(key)?.abort()
    session.inflight.set(key, controller)
    // A client that drops the HTTP request has stopped waiting: withdraw the
    // call (and any approval card it raised) instead of acting later.
    const onClose = (): void => { if (!res.writableFinished) controller.abort() }
    res.on('close', onClose)
    try {
      const result = await this.options.tools.call(name, (args ?? {}) as Record<string, unknown>, session.caller, controller.signal)
      reply(res, 200, { jsonrpc: '2.0', id, result })
    } finally {
      res.off('close', onClose)
      if (session.inflight.get(key) === controller) session.inflight.delete(key)
      session.lastSeen = this.now()
    }
  }

  /** Make room for one more session: evict the least recently used idle one. */
  private makeRoom(): boolean {
    const max = this.options.maxSessions ?? DEFAULT_MCP_MAX_SESSIONS
    if (this.sessions.size < max) return true
    let oldest: McpSession | undefined
    for (const session of this.sessions.values()) {
      if (session.inflight.size > 0) continue
      if (oldest === undefined || session.lastSeen < oldest.lastSeen) oldest = session
    }
    if (oldest === undefined) return false
    this.endSession(oldest)
    return true
  }

  private expireIdle(): void {
    const idleMs = this.options.idleMs ?? DEFAULT_MCP_IDLE_MS
    const now = this.now()
    for (const session of [...this.sessions.values()]) {
      if (session.inflight.size === 0 && now - session.lastSeen > idleMs) this.endSession(session)
    }
  }

  private endSession(session: McpSession): void {
    for (const call of session.inflight.values()) call.abort()
    this.sessions.delete(session.id)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function isRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message.jsonrpc !== '2.0') return false
  if (message.id !== undefined && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number') return false
  // Client responses (to server requests we never send) carry no method.
  return message.method === undefined ? message.id !== undefined : typeof message.method === 'string'
}

function rpcError(id: JsonRpcId | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(text)
}

/** Read a body up to `limit` bytes; undefined when it is larger. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const declared = Number(header(req, 'content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    req.resume()
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > limit) {
      req.resume()
      return undefined
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
