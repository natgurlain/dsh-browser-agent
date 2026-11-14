/**
 * Wire contract between the dsh bridge plugin and the browser extension.
 *
 * Zero-dependency module (pure types, constants, and a parser): both the
 * plugin (node) and the Chrome extension (browser bundle) import this file, so
 * the frame shapes can never drift between the two halves.
 *
 * Frames are one JSON object per WebSocket message, discriminated by `t`.
 * Correlation ids (`id`) are minted by the requestor and echoed by the
 * responder; they are opaque strings, never parsed.
 *
 * @module
 */

/** WebSocket pathname the bridge plugin registers on the host webserver. */
export const BRIDGE_PATH = '/ext/bridge'

/** Zero-config discovery endpoint: returns `{ wsUrl }` for the extension. */
export const BRIDGE_CONFIG_PATH = '/ext/bridge-config'

/**
 * Fixed loopback ports the plugin's discovery beacon tries, in order.
 *
 * DSH Desktop launches its host with `--port 0`, so every launch lands on a
 * different OS-assigned port and no fixed list of real ports can find it. The
 * beacon binds the first free port of this range and answers
 * {@link BRIDGE_CONFIG_PATH} with the real bridge URL, which turns discovery
 * into a handful of bounded probes. 43189 is the port older deployment notes
 * already recommended pinning by hand.
 */
export const BEACON_PORTS = [43189, 43190, 43191, 43192, 43193, 43194, 43195, 43196, 43197, 43198] as const

/**
 * Ports a local dsh may serve on without the beacon: the CLI default and the
 * ports operators historically picked. Probed after any remembered URL.
 */
export const LEGACY_BRIDGE_PORTS = [3080, 3081, 3090, 14389] as const

/** Internal RPC used after an explicit tab handoff to seed the Agent's next step. */
export const BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD = 'bridge.injectBrowserSnapshot'

/** Internal RPC used by the panel to permanently delete one session's durable storage. */
export const BRIDGE_SESSION_PURGE_METHOD = 'bridge.session.purge'

/**
 * Seconds a fresh socket may take to present `hello` before it is closed.
 * Short on purpose: an unauthenticated socket holds server resources, and the
 * handshake costs the client two HMACs.
 */
export const HELLO_TIMEOUT_MS = 3_000

/**
 * Wire version of the authentication handshake. Version 1 sent the raw bearer
 * token in `hello`; version 2 was a mutual HMAC challenge-response that a
 * local relay could forward unchanged. Version 3 binds the dialed endpoint
 * into both proofs and authenticates every later frame with a per-connection
 * key and a strict per-direction sequence number (see {@link BridgeFrameChannel}).
 * Both halves reject any other version with {@link BRIDGE_CLOSE_CODES.versionMismatch}.
 */
export const BRIDGE_PROTOCOL_VERSION = 3

/** WebSocket close codes the bridge uses; the reason string carries human text. */
export const BRIDGE_CLOSE_CODES = {
  /** Another authenticated connection took the single active slot. */
  replaced: 4000,
  /** No valid `hello` within {@link HELLO_TIMEOUT_MS}. */
  helloTimeout: 4001,
  /**
   * The peer's proof did not verify: a wrong or missing token, an endpoint
   * mismatch (a relay in the middle), or a frame whose MAC or sequence
   * number failed after the handshake.
   */
  authFailed: 4002,
  /** The client speaks a different handshake version (e.g. a v2 extension). */
  versionMismatch: 4003,
  /** The WebSocket Origin is not an allowed extension. */
  originRejected: 4004,
  /** Too many sockets are waiting to authenticate; retry later. */
  busy: 4005,
} as const

/**
 * Chrome extension ID of the dsh browser extension, fixed by the public key in
 * `extensions/dsh-browser/manifest.json` (`key`). The bridge accepts
 * `chrome-extension://` origins only for this ID unless the plugin config
 * names additional IDs (development builds, a Web Store listing).
 */
export const PINNED_CHROME_EXTENSION_ID = 'klmdgljhcjbbpjcplbanjeclilghnaoh'

/** Nonces and proofs are 32 bytes rendered as lowercase hex. */
const HEX_256 = /^[0-9a-f]{64}$/u

/** Whether a value is a well-formed handshake nonce or proof (64 lowercase hex digits). */
export function isBridgeHex256(value: unknown): value is string {
  return typeof value === 'string' && HEX_256.test(value)
}

/**
 * The transport endpoint a handshake is bound to: the host literal the client
 * dialed and the port it reached. The server compares it with the address
 * and port its own socket was accepted on, so a relay listening on another
 * port (or another loopback address) cannot complete a handshake it forwards.
 */
export interface BridgeEndpoint {
  host: string
  port: number
}

const HOST_CHARS = /^[a-z0-9.:-]{1,253}$/u
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u

/**
 * Canonical form of a host as both halves bind it: lowercase, IPv6 brackets
 * and the IPv4-mapped prefix stripped, `localhost` pinned to `127.0.0.1`
 * (the client dials that literal too, see {@link bridgeDialUrl}).
 * @param host - hostname or address literal.
 * @returns the canonical host, or `undefined` when it is not usable.
 */
export function canonicalBridgeHost(host: string): string | undefined {
  let value = host.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value === 'localhost') return '127.0.0.1'
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)
  if (mapped !== null) value = mapped[1]!
  if (value === '0:0:0:0:0:0:0:1') value = '::1'
  return HOST_CHARS.test(value) ? value : undefined
}

/** Whether a canonical host is an address literal (not a DNS name). */
function isAddressLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(':')
}

function isLoopbackHost(host: string): boolean {
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
}

/** Whether a value is a well-formed endpoint as carried in `hello`. */
export function isBridgeEndpoint(value: unknown): value is BridgeEndpoint {
  if (typeof value !== 'object' || value === null) return false
  const { host, port } = value as Record<string, unknown>
  return typeof host === 'string' && canonicalBridgeHost(host) === host
    && typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
}

/**
 * URL the client should actually dial: `localhost` is rewritten to
 * `127.0.0.1`, so a process listening on `[::1]` with the same port cannot
 * be reached by name resolution while the proof names IPv4.
 * @param url - configured or discovered bridge URL.
 * @returns the URL to open.
 */
export function bridgeDialUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() !== 'localhost') return url
    parsed.hostname = '127.0.0.1'
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * Endpoint a client binds into its proof for the URL it dials.
 * @param url - the URL passed to `new WebSocket` (after {@link bridgeDialUrl}).
 * @returns the endpoint, or `undefined` when the URL is not a ws/wss URL.
 */
export function bridgeEndpointOfUrl(url: string): BridgeEndpoint | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return undefined
  const host = canonicalBridgeHost(parsed.hostname)
  const port = parsed.port === '' ? (parsed.protocol === 'wss:' ? 443 : 80) : Number(parsed.port)
  return host === undefined ? undefined : { host, port }
}

/**
 * Server-side check of the endpoint a client claims to have dialed against
 * the local address and port the socket was accepted on. Address literals
 * must match exactly; a DNS name (a remote deployment the user configured
 * by hand) is accepted only on a non-loopback local address, because no
 * discovery path ever hands the extension a name.
 * @param claimed - the endpoint from `hello`.
 * @param local - the server socket's local address and port.
 * @returns true when the claim describes this socket.
 */
export function bridgeEndpointMatches(claimed: BridgeEndpoint, local: BridgeEndpoint): boolean {
  if (claimed.port !== local.port) return false
  const localHost = canonicalBridgeHost(local.host)
  if (localHost === undefined) return false
  if (isAddressLiteral(claimed.host)) return claimed.host === localHost
  return !isLoopbackHost(localHost)
}

/**
 * Exact bytes one side authenticates. The role label keeps a client proof from
 * being reflected as a server proof; both nonces are fixed-length hex and the
 * endpoint fields cannot contain `|`, so no field can be smuggled into another.
 * @param role - which side produces the proof.
 * @param first - for the client, the server nonce; for the server, the client nonce.
 * @param second - the other nonce.
 * @param endpoint - the endpoint the client dialed.
 * @returns the message to MAC.
 */
export function bridgeProofMessage(role: 'client' | 'server', first: string, second: string, endpoint: BridgeEndpoint): string {
  return `dsh-bridge/v${String(BRIDGE_PROTOCOL_VERSION)}|${role}|${first}|${second}|${endpoint.host}|${String(endpoint.port)}`
}

/**
 * Fresh 32-byte nonce from the platform CSPRNG (WebCrypto, available in both
 * node and extension contexts).
 * @returns 64 lowercase hex digits.
 */
export function createBridgeNonce(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/** Synchronous HMAC-SHA256 over byte strings (node passes its native one). */
export type BridgeHmac = (key: Uint8Array, message: Uint8Array) => Uint8Array

const utf8 = new TextEncoder()

/**
 * HMAC-SHA256 proof over {@link bridgeProofMessage}, keyed by the token's UTF-8
 * bytes (configured tokens need not be hex).
 * @param token - shared bridge token; must be non-empty.
 * @param role - which side produces the proof.
 * @param first - see {@link bridgeProofMessage}.
 * @param second - see {@link bridgeProofMessage}.
 * @param endpoint - see {@link bridgeProofMessage}.
 * @param hmac - HMAC implementation (defaults to the portable one).
 * @returns the proof as 64 lowercase hex digits.
 */
export function bridgeProof(
  token: string,
  role: 'client' | 'server',
  first: string,
  second: string,
  endpoint: BridgeEndpoint,
  hmac: BridgeHmac = hmacSha256,
): string {
  if (token === '') throw new Error('bridge token is empty')
  return toHex(hmac(utf8.encode(token), utf8.encode(bridgeProofMessage(role, first, second, endpoint))))
}

/**
 * Promise form of {@link bridgeProof}, kept for callers that await it.
 * @returns the proof as 64 lowercase hex digits.
 */
export async function computeBridgeProof(
  token: string,
  role: 'client' | 'server',
  first: string,
  second: string,
  endpoint: BridgeEndpoint,
): Promise<string> {
  return bridgeProof(token, role, first, second, endpoint)
}

/**
 * Integrity for every frame after `hello.ok`. Each direction has its own key,
 * derived from the token, both handshake nonces, and the bound endpoint, and
 * its own counter starting at 0. A frame travels as
 * `{ t: 'sealed', seq, body, mac }` where `body` is the frame's JSON text and
 * `mac = HMAC(key, seq|body)` over those exact bytes. A receiver accepts only
 * the next sequence number with a valid MAC; anything else is a protocol
 * violation that must close the connection. The channel is not encrypted:
 * a local observer of loopback traffic can still read frames, but cannot
 * inject, replay, reorder, or drop them undetected.
 */
export class BridgeFrameChannel {
  private sendSeq = 0
  private receiveSeq = 0

  private constructor(
    private readonly sendKey: Uint8Array,
    private readonly receiveKey: Uint8Array,
    private readonly hmac: BridgeHmac,
  ) {}

  /**
   * Derive one side's channel after a verified handshake.
   * @param token - shared bridge token.
   * @param role - the side this channel belongs to.
   * @param serverNonce - the challenge nonce.
   * @param clientNonce - the hello nonce.
   * @param endpoint - the endpoint bound into both proofs.
   * @param hmac - HMAC implementation (defaults to the portable one).
   * @returns the channel.
   */
  static derive(
    token: string,
    role: 'client' | 'server',
    serverNonce: string,
    clientNonce: string,
    endpoint: BridgeEndpoint,
    hmac: BridgeHmac = hmacSha256,
  ): BridgeFrameChannel {
    if (token === '') throw new Error('bridge token is empty')
    const key = (direction: 'c2s' | 's2c'): Uint8Array => hmac(
      utf8.encode(token),
      utf8.encode(`dsh-bridge/v${String(BRIDGE_PROTOCOL_VERSION)}|key|${direction}|${serverNonce}|${clientNonce}|${endpoint.host}|${String(endpoint.port)}`),
    )
    const c2s = key('c2s')
    const s2c = key('s2c')
    return role === 'client' ? new BridgeFrameChannel(c2s, s2c, hmac) : new BridgeFrameChannel(s2c, c2s, hmac)
  }

  /**
   * Seal one outgoing frame; each call consumes the next sequence number.
   * @param frame - the frame to send.
   * @returns the wire text.
   */
  seal(frame: BridgeFrame): string {
    const body = JSON.stringify(frame)
    const seq = this.sendSeq
    this.sendSeq += 1
    return JSON.stringify({ t: 'sealed', seq, body, mac: this.mac(this.sendKey, seq, body) })
  }

  /**
   * Verify and parse one incoming wire message.
   * @param text - raw message text.
   * @returns the frame, or `undefined` when the message is not the next
   *   authentic frame (the caller must close the connection).
   */
  open(text: string): BridgeFrame | undefined {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return undefined
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const { t, seq, body, mac } = value as Record<string, unknown>
    if (t !== 'sealed' || seq !== this.receiveSeq || typeof body !== 'string' || !isBridgeHex256(mac)) return undefined
    if (!constantTimeEqual(this.mac(this.receiveKey, seq, body), mac)) return undefined
    const frame = parseBridgeFrame(body)
    if (frame === undefined) return undefined
    this.receiveSeq += 1
    return frame
  }

  private mac(key: Uint8Array, seq: number, body: string): string {
    return toHex(this.hmac(key, utf8.encode(`${String(seq)}|${body}`)))
  }
}

/**
 * Compare two strings without an early exit on the first differing byte.
 * Lengths are not secret here (proofs are fixed-length hex).
 * @returns true only for equal, non-empty strings.
 */
export function constantTimeEqual(expected: string, actual: string): boolean {
  if (expected.length === 0 || expected.length !== actual.length) return false
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  }
  return diff === 0
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/**
 * Portable synchronous SHA-256 (FIPS 180-4). The extension needs a
 * synchronous MAC so frame order on the socket equals call order.
 * @param data - message bytes.
 * @returns the 32-byte digest.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const bitLength = data.length * 8
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(padded.length - 4, bitLength >>> 0)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!
      const b = w[i - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h[0]!; let b = h[1]!; let c = h[2]!; let d = h[3]!
    let e = h[4]!; let f = h[5]!; let g = h[6]!; let k = h[7]!
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (k + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      k = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + k) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]!)
  return out
}

/**
 * Portable synchronous HMAC-SHA256 (RFC 2104).
 * @param key - key bytes.
 * @param message - message bytes.
 * @returns the 32-byte MAC.
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? sha256(key) : key)
  const inner = new Uint8Array(64 + message.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i += 1) {
    inner[i] = block[i]! ^ 0x36
    outer[i] = block[i]! ^ 0x5c
  }
  inner.set(message, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

/**
 * Handshake version a raw `hello` message claims, read before full parsing so
 * an outdated client gets a version-mismatch close instead of a parse error.
 * A `hello` without `v` is the version-1 (raw token) shape.
 * @param text - raw message text.
 * @returns the claimed version, or `undefined` when the message is not a `hello`.
 */
export function helloProtocolVersion(text: string): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (frame.t !== 'hello') return undefined
  return typeof frame.v === 'number' ? frame.v : 1
}

/** Server-side ping cadence; the client answers `pong` to prove liveness. */
export const PING_INTERVAL_MS = 30_000

/** Default rendered-snapshot character budget. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 32_000

/** Smallest snapshot budget that can carry both trust boundaries and page text. */
export const MIN_SNAPSHOT_MAX_CHARS = 500

/** Error codes a tool call may settle with. Open set: consumers must tolerate unknown codes. */
export type ToolErrorCode =
  | 'no-active-tab'
  | 'content-unavailable'
  | 'action-failed'
  | 'timeout'
  | 'bridge-closed'
  | 'bad-args'
  | 'internal'
  /** The platform has no trustworthy input channel (no `chrome.debugger`). */
  | 'input-unavailable'

/** One tool-call failure: stable machine code plus human text for the model. */
export interface ToolError {
  code: ToolErrorCode
  message: string
}

/** Result sent for a pending host interaction such as ask_user_question. */
export type RespondResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/**
 * Developer-tools capability the extension advertises when it can drive a
 * debugger session (Chrome only: `chrome.debugger`). Absent for platforms and
 * builds without it, which keeps the devtools tools unregistered there.
 */
export interface DevToolsCaps {
  /** Wire version of the devtools tool group. */
  version: typeof DEVTOOLS_CAPS_VERSION
}

/** Capabilities negotiated in `hello`/`hello.ok`. The extension performs its own actions; these bounds shape page snapshots. */
export interface BridgeCaps {
  /** The extension renders page state as text only (no screenshots). */
  textOnly: true
  /** Upper bound on one rendered snapshot's characters (plugin config, minimum 500). */
  snapshotMaxChars: number
  /** Upper bound on interactive inventory items per snapshot (plugin config). */
  maxInteractiveItems: number
  /** Present only when the connected extension supports the developer-tools group. */
  devTools?: DevToolsCaps
}

/** Version of the developer-tools tool group this plugin speaks. */
export const DEVTOOLS_CAPS_VERSION = 1

/**
 * The developer-tools group's wire action names (tool name == action name).
 * Registered only while the connected extension advertises `caps.devTools`.
 */
export const DEVTOOLS_TOOL_NAMES = [
  'browser_devtools_elements',
  'browser_devtools_set_element_style',
  'browser_devtools_set_element_attribute',
  'browser_console_eval',
  'browser_console_logs',
  'browser_devtools_network',
  'browser_devtools_list_requests',
  'browser_devtools_get_request',
  'browser_devtools_request_body',
] as const

/** Frames sent by the extension to the bridge plugin. */
export type ClientFrame =
  /**
   * Answer to `challenge`, within HELLO_TIMEOUT_MS of socket open. `mac` is
   * {@link bridgeProof}(token, 'client', serverNonce, nonce, endpoint); the
   * token itself never crosses the wire. `endpoint` is what the client dialed.
   */
  | { t: 'hello'; v: typeof BRIDGE_PROTOCOL_VERSION; nonce: string; mac: string; endpoint: BridgeEndpoint; caps: BridgeCaps }
  /** Unary call projected by the active dsh Host adapter. */
  | { t: 'rpc'; id: string; method: string; payload: unknown }
  /** Answer or cancel a pending Host interaction waterfall. */
  | { t: 'respond'; id: string; rpcId: string; result: RespondResult }
  /** Result of a previously dispatched tool call. */
  | { t: 'tool.result'; id: string; ok: true; result: unknown }
  | { t: 'tool.result'; id: string; ok: false; error: ToolError }
  /** Liveness reply. */
  | { t: 'pong' }

/** Frames sent by the bridge plugin to the extension. */
export type ServerFrame =
  /** First frame on every socket: the handshake version and a fresh server nonce. */
  | { t: 'challenge'; v: number; nonce: string }
  /**
   * Accepted after a valid `hello`. `mac` is
   * {@link bridgeProof}(token, 'server', clientNonce, serverNonce, endpoint); the
   * extension must verify it before trusting any other frame. Every later
   * frame in both directions travels sealed by a {@link BridgeFrameChannel}.
   */
  | { t: 'hello.ok'; caps: BridgeCaps; mac: string }
  /** Reply to an `rpc` frame; `result` is the bridge's stable ServerResponse envelope. */
  | { t: 'rpc.result'; id: string; ok: true; result: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: { code: string; message: string } }
  /** Receipt for a `respond` frame (normally `{ accepted: boolean }`). */
  | { t: 'respond.result'; id: string; ok: true; result: unknown }
  | { t: 'respond.result'; id: string; ok: false; error: { code: string; message: string } }
  /** One bridge-owned event envelope projected from Remote streams and waterfalls. */
  | { t: 'event'; frame: { rpcId: string; method: string; payload: unknown } }
  /** A model-requested browser action to execute in the user-controlled tab. */
  | { t: 'tool.call'; id: string; name: string; args: Record<string, unknown>; expiresAt: number; sessionId?: string }
  /** Withdraw a tool call that timed out or whose caller was cancelled. */
  | { t: 'tool.cancel'; id: string }
  /** Liveness probe. */
  | { t: 'ping' }
  /** Fatal connection error; the client should re-authenticate. */
  | { t: 'error'; code: string; message: string }

/** Any frame on the wire. */
export type BridgeFrame = ClientFrame | ServerFrame

/**
 * Type guard: is this frame one the SERVER may send? Client-only shapes
 * (hello/tool.result/pong) narrow out, so server-side consumers never
 * dispatch on their own request vocabulary.
 * @param frame - parsed frame.
 * @returns true for server-sendable frames.
 */
export function isServerFrame(frame: BridgeFrame): frame is ServerFrame {
  return frame.t === 'challenge'
    || frame.t === 'hello.ok'
    || frame.t === 'rpc.result'
    || frame.t === 'respond.result'
    || frame.t === 'event'
    || frame.t === 'tool.call'
    || frame.t === 'tool.cancel'
    || frame.t === 'ping'
    || frame.t === 'error'
}

/**
 * Parse one WebSocket message into a frame.
 * @param text - raw message text.
 * @returns the frame, or `undefined` when the message is not a valid frame.
 */
export function parseBridgeFrame(text: string): BridgeFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (typeof frame.t !== 'string') return undefined
  switch (frame.t) {
    case 'hello':
      return frame.v === BRIDGE_PROTOCOL_VERSION
        && isBridgeHex256(frame.nonce)
        && isBridgeHex256(frame.mac)
        && isBridgeEndpoint(frame.endpoint)
        && isCaps(frame.caps)
        ? {
            t: 'hello',
            v: BRIDGE_PROTOCOL_VERSION,
            nonce: frame.nonce,
            mac: frame.mac,
            endpoint: { host: frame.endpoint.host, port: frame.endpoint.port },
            caps: frame.caps,
          }
        : undefined
    case 'challenge':
      return typeof frame.v === 'number' && Number.isInteger(frame.v) && isBridgeHex256(frame.nonce)
        ? { t: 'challenge', v: frame.v, nonce: frame.nonce }
        : undefined
    case 'rpc':
      return typeof frame.id === 'string' && typeof frame.method === 'string'
        ? { t: 'rpc', id: frame.id, method: frame.method, payload: frame.payload }
        : undefined
    case 'respond':
      return typeof frame.id === 'string' && typeof frame.rpcId === 'string' && isRespondResult(frame.result)
        ? { t: 'respond', id: frame.id, rpcId: frame.rpcId, result: frame.result }
        : undefined
    case 'tool.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'tool.result', id: frame.id, ok: true, result: frame.result }
      }
      return isToolError(frame.error)
        ? { t: 'tool.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'pong':
      return { t: 'pong' }
    case 'hello.ok':
      return isCaps(frame.caps) && isBridgeHex256(frame.mac)
        ? { t: 'hello.ok', caps: frame.caps, mac: frame.mac }
        : undefined
    case 'rpc.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'rpc.result', id: frame.id, ok: true, result: frame.result }
      }
      return typeof frame.error === 'object' && frame.error !== null
        ? { t: 'rpc.result', id: frame.id, ok: false, error: frame.error as { code: string; message: string } }
        : undefined
    case 'respond.result':
      if (typeof frame.id !== 'string') return undefined
      if (frame.ok === true && 'result' in frame) {
        return { t: 'respond.result', id: frame.id, ok: true, result: frame.result }
      }
      return isWireError(frame.error)
        ? { t: 'respond.result', id: frame.id, ok: false, error: frame.error }
        : undefined
    case 'event':
      return typeof frame.frame === 'object' && frame.frame !== null
        ? { t: 'event', frame: frame.frame as ServerFrame extends { t: 'event' } ? ServerFrame['frame'] : never }
        : undefined
    case 'tool.call':
      if (frame.sessionId !== undefined
        && (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '')) return undefined
      return typeof frame.id === 'string' && typeof frame.name === 'string'
        && typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
        && typeof frame.expiresAt === 'number' && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0
        ? {
            t: 'tool.call',
            id: frame.id,
            name: frame.name,
            args: frame.args as Record<string, unknown>,
            expiresAt: frame.expiresAt,
            ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          }
        : undefined
    case 'tool.cancel':
      return typeof frame.id === 'string' ? { t: 'tool.cancel', id: frame.id } : undefined
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof frame.code === 'string' && typeof frame.message === 'string'
        ? { t: 'error', code: frame.code, message: frame.message }
        : undefined
    default:
      return undefined
  }
}

function isCaps(value: unknown): value is BridgeCaps {
  if (typeof value !== 'object' || value === null) return false
  const caps = value as Record<string, unknown>
  return caps.textOnly === true
    && typeof caps.snapshotMaxChars === 'number'
    && Number.isInteger(caps.snapshotMaxChars)
    && caps.snapshotMaxChars >= MIN_SNAPSHOT_MAX_CHARS
    && typeof caps.maxInteractiveItems === 'number' && caps.maxInteractiveItems > 0
    // Optional: an older extension omits it and simply gets no devtools tools.
    && (caps.devTools === undefined || isDevToolsCaps(caps.devTools))
}

/** Validate the optional developer-tools capability; unknown versions are unusable. */
export function isDevToolsCaps(value: unknown): value is DevToolsCaps {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).version === DEVTOOLS_CAPS_VERSION
}

function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

function isWireError(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
}

export function isRespondResult(value: unknown): value is RespondResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) return result.error === undefined
  return result.ok === false && isRespondError(result.error)
}

function isRespondError(value: unknown): value is Extract<RespondResult, { ok: false }>['error'] {
  return isWireError(value)
    && typeof (value as Record<string, unknown>).details === 'object'
    && (value as Record<string, unknown>).details !== null
    && !Array.isArray((value as Record<string, unknown>).details)
}

/**
 * Answer of the discovery endpoint ({@link BRIDGE_CONFIG_PATH}), served by the
 * host route and by the fixed-port beacon.
 *
 * `pid` and `startedAt` are optional instance metadata: the extension's
 * instance picker shows them, and an older plugin simply omits them.
 */
export interface BridgeConfigPayload {
  /** Bridge WebSocket URL the extension should open. */
  wsUrl: string
  /** Set when a fixed-port discovery beacon (not the host route) answered. */
  beacon?: true
  /** Host process id, for telling several local instances apart. */
  pid?: number
  /** Host start time as an ISO 8601 string. */
  startedAt?: string
}

/** Instance metadata the discovery endpoints advertise. */
export interface BridgeInstanceInfo {
  pid?: number
  startedAt?: string
}

/**
 * Build a discovery answer naming the host's real bridge URL.
 * @param hostPort - port the host webserver actually bound.
 * @param info - optional instance metadata.
 * @param beacon - mark the answer as coming from a beacon.
 * @returns the payload to serialize.
 */
export function bridgeConfigPayload(
  hostPort: number,
  info: BridgeInstanceInfo = {},
  beacon = false,
): BridgeConfigPayload {
  return {
    wsUrl: `ws://127.0.0.1:${String(hostPort)}${BRIDGE_PATH}`,
    ...(beacon ? { beacon: true as const } : {}),
    ...(info.pid === undefined ? {} : { pid: info.pid }),
    ...(info.startedAt === undefined ? {} : { startedAt: info.startedAt }),
  }
}

/**
 * Whether a URL names the local bridge: `ws:` on a loopback host with the
 * bridge path. Discovered answers must satisfy this, so a stray local service
 * that happens to answer the path cannot send the extension off-machine.
 */
export function isLoopbackBridgeUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'ws:') return false
  const hostname = parsed.hostname.toLowerCase()
  const loopback = hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '[::1]'
    || hostname === '::1'
  return loopback && parsed.pathname === BRIDGE_PATH
}

/**
 * Parse a discovery answer. Unknown fields are ignored and instance metadata
 * is only kept when well formed; an answer that does not name the local bridge
 * is rejected outright.
 * @param value - parsed JSON body of the discovery response.
 * @returns the normalized payload, or `undefined` when it is not usable.
 */
export function parseBridgeConfigPayload(value: unknown): BridgeConfigPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as Record<string, unknown>
  if (typeof body.wsUrl !== 'string' || !isLoopbackBridgeUrl(body.wsUrl)) return undefined
  return {
    wsUrl: body.wsUrl,
    ...(body.beacon === true ? { beacon: true as const } : {}),
    ...(typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0 ? { pid: body.pid } : {}),
    ...(typeof body.startedAt === 'string' && body.startedAt !== '' ? { startedAt: body.startedAt } : {}),
  }
}
