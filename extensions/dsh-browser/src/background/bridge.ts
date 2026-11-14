/**
 * Bridge WebSocket client (background side): connects to the dsh bridge,
 * runs the mutual challenge-response handshake, keeps the connection alive
 * with exponential-backoff reconnects, and answers protocol pings.
 *
 * Handshake (protocol v2): the bridge opens with `challenge { nonce: Ns }`;
 * the client answers `hello { nonce: Nc, mac: HMAC(token, client|Ns|Nc) }`;
 * the bridge answers `hello.ok { mac: HMAC(token, server|Nc|Ns) }`. Nothing
 * from the socket is trusted, and nothing but `hello` is sent, until that
 * server proof verifies, so a local process squatting on a probed port cannot
 * learn the token or impersonate the bridge. The token itself never crosses
 * the wire. The channel is plain `ws://` without per-frame integrity, so a
 * local relay that forwards the handshake to the real bridge is not prevented.
 *
 * Token source: the user's settings field when filled in (Firefox, custom
 * deployments), otherwise the `bridge-token` file the installer and the dsh
 * plugin keep inside the unpacked Chrome extension directory. That file is not
 * a web-accessible resource, so pages and other extensions cannot read it.
 *
 * The reconnect policy mirrors the dsh GUI's own ConnectionController: base
 * 500ms, ×2 per attempt, capped at 10s, jittered 0.5–1×.
 *
 * @module
 */

import type { BridgeCaps, ClientFrame, ServerFrame } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  computeBridgeProof,
  constantTimeEqual,
  createBridgeNonce,
  isServerFrame,
  parseBridgeFrame,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'

/** Extension-relative path of the token file provisioned for zero-config installs. */
export const INSTALLED_TOKEN_PATH = 'bridge-token'

/** Resolve the shared bridge token when settings leave it empty. */
export type BridgeTokenSource = () => Promise<string>

/**
 * Read the token the installer (and the dsh plugin on each start) writes into
 * the unpacked extension directory. Absent or malformed files yield `''`.
 * @returns the token, or an empty string when none is provisioned.
 */
export async function loadInstalledToken(): Promise<string> {
  try {
    const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } }).chrome?.runtime
    if (typeof runtime?.getURL !== 'function') return ''
    const response = await fetch(runtime.getURL(INSTALLED_TOKEN_PATH), { cache: 'no-store' })
    if (!response.ok) return ''
    const token = (await response.text()).trim()
    return /^[\x21-\x7e]{1,1024}$/u.test(token) ? token : ''
  } catch {
    return ''
  }
}

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/** Frame/state sinks owned by the background assembly. */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps): void
}

/** Resolve whether opening a WebSocket is expected to succeed. */
type BridgeProbe = (url: string) => Promise<boolean>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
const HELLO_ACK_TIMEOUT_MS = 5_000

/**
 * Owns one WebSocket connection generation and the reconnect loop.
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private attempt = 0
  private running = false
  /** Per-start generation token: a new start() invalidates any in-flight loop. */
  private generation = 0
  private url = ''
  private token = ''
  private ackTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** Whether a disconnected client still has an active user-owned lease. */
    private readonly shouldReconnect: () => boolean = () => true,
    /**
     * Capabilities this build can serve beyond the text snapshot contract.
     * Advertised on every `hello`: the host registers the developer-tools group
     * only for an extension that claims it, and the user's own setting still
     * gates every call.
     */
    private readonly capabilities: Pick<BridgeCaps, 'devTools'> = {},
    /** Token fallback when settings carry none (zero-config Chrome installs). */
    private readonly tokenSource: BridgeTokenSource = loadInstalledToken,
  ) {}

  /** Current coarse state (mirrors the last emitted sink value). */
  state: BridgeState = 'stopped'

  /**
   * Connect (or reconnect) to the bridge. Idempotent: calling again with the
   * same url/token restarts the loop from attempt 0.
   * @param url - bridge WebSocket URL (e.g. ws://127.0.0.1:3080/ext/bridge).
   * @param token - shared token from settings; empty falls back to the
   *   provisioned `bridge-token` file, re-read on every attempt.
   */
  start(url: string, token: string): void {
    this.stop()
    this.url = url
    this.token = token
    this.running = true
    this.attempt = 0
    this.generation += 1
    void this.loop(this.generation)
  }

  /** Stop the loop and close the current socket. */
  stop(): void {
    this.running = false
    this.clearAckTimer()
    this.ws?.close()
    this.ws = null
    this.emitState('stopped')
  }

  /**
   * Drop an in-progress reconnect when its UI lease disappears, while keeping
   * an authenticated socket alive for background approvals already enabled by
   * the user. A later socket loss will still consult shouldReconnect().
   */
  suspendReconnect(): void {
    if (this.state === 'connected') return
    this.stop()
  }

  /** Whether a frame can be sent right now. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Send one client frame.
   * @param frame - frame to send.
   * @returns false when no live socket exists.
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      if (!this.retryAllowed()) return
      const reachable = await this.probe(this.url).catch(() => false)
      if (!this.running || generation !== this.generation) return
      if (!this.retryAllowed()) return
      if (!reachable) {
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }

      const token = this.token !== '' ? this.token : await this.tokenSource().catch(() => '')
      if (!this.running || generation !== this.generation) return
      if (token === '') {
        // Without a secret the handshake cannot succeed; wait for the installer
        // or the dsh plugin to provision it (or for the user to paste one).
        console.warn('dsh bridge: no bridge token is configured or provisioned; skipping connection attempt')
        if (!this.retryAllowed()) return
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }

      const socket = new WebSocket(this.url)
      this.ws = socket
      // A replacement is an ownership handoff, not a transient transport
      // failure. Yield permanently so two open profiles cannot reconnect in a
      // tight loop and repeatedly evict one another.
      socket.addEventListener('close', (event) => {
        if (event.code !== BRIDGE_CLOSE_CODES.replaced || this.ws !== socket || !this.running) return
        this.running = false
        this.clearAckTimer()
        this.ws = null
        this.emitState('stopped')
      }, { once: true })
      this.emitState('connecting')

      await new Promise<void>((resolve) => {
        socket.addEventListener('open', () => { resolve() }, { once: true })
        socket.addEventListener('close', () => { resolve() }, { once: true })
        socket.addEventListener('error', () => { resolve() }, { once: true })
      })
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      const session = this.authenticate(socket, token)
      const accepted = await session.accepted
      if (!accepted || !this.running || generation !== this.generation) {
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      this.emitState('connected')
      // Frames that arrived while the server proof was being verified are
      // delivered now, in order, ahead of anything newer.
      session.release()

      if (socket.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          socket.addEventListener('close', () => resolve(), { once: true })
          socket.addEventListener('error', () => resolve(), { once: true })
        })
      }
      if (!this.running || generation !== this.generation) {
        socket.close()
        return
      }
      await this.fail(socket)
    }
  }

  /**
   * Run the client half of the handshake on an open socket. One listener owns
   * the socket for its whole life: before the server proof verifies every
   * frame except the expected handshake step is dropped; while it verifies,
   * frames queue; after {@link release} they flow to the sinks.
   */
  private authenticate(socket: WebSocket, token: string): { accepted: Promise<boolean>; release: () => void } {
    type Stage = 'challenge' | 'proving' | 'awaiting-ok' | 'verifying' | 'accepted' | 'ready' | 'failed'
    let stage: Stage = 'challenge'
    let serverNonce = ''
    let clientNonce = ''
    const queued: ServerFrame[] = []
    let settle!: (accepted: boolean) => void
    const accepted = new Promise<boolean>((resolve) => { settle = resolve })
    const finish = (ok: boolean): void => {
      if (stage === 'accepted' || stage === 'ready' || stage === 'failed') return
      stage = ok ? 'accepted' : 'failed'
      this.clearAckTimer()
      settle(ok)
    }
    const reject = (code: number, reason: string): void => {
      console.warn(`dsh bridge: ${reason}`)
      finish(false)
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
    }
    const deliver = (frame: ServerFrame): void => {
      if (frame.t === 'ping') {
        socket.send(JSON.stringify({ t: 'pong' } satisfies ClientFrame))
        return
      }
      this.sinks.onFrame(frame)
    }

    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = parseBridgeFrame(String(event.data))
      if (frame === undefined || !isServerFrame(frame)) return
      switch (stage) {
        case 'challenge': {
          if (frame.t !== 'challenge') return
          if (frame.v !== BRIDGE_PROTOCOL_VERSION) {
            reject(BRIDGE_CLOSE_CODES.versionMismatch,
              `protocol version mismatch: extension speaks v${String(BRIDGE_PROTOCOL_VERSION)}, bridge sent v${String(frame.v)}`)
            return
          }
          stage = 'proving'
          serverNonce = frame.nonce
          clientNonce = createBridgeNonce()
          void computeBridgeProof(token, 'client', serverNonce, clientNonce).then((mac) => {
            if (stage !== 'proving' || socket.readyState !== WebSocket.OPEN) return
            socket.send(JSON.stringify({
              t: 'hello',
              v: BRIDGE_PROTOCOL_VERSION,
              nonce: clientNonce,
              mac,
              caps: {
                textOnly: true,
                snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS,
                maxInteractiveItems: 60,
                ...this.capabilities,
              },
            } satisfies ClientFrame))
            stage = 'awaiting-ok'
          }, () => { reject(BRIDGE_CLOSE_CODES.authFailed, 'could not compute the handshake proof') })
          return
        }
        case 'awaiting-ok': {
          if (frame.t !== 'hello.ok') return
          stage = 'verifying'
          const caps = frame.caps
          void computeBridgeProof(token, 'server', clientNonce, serverNonce).then((expected) => {
            if (stage !== 'verifying') return
            if (!constantTimeEqual(expected, frame.mac)) {
              reject(BRIDGE_CLOSE_CODES.authFailed, 'the bridge did not prove knowledge of the token; refusing to trust it')
              return
            }
            finish(true)
            this.sinks.onHelloOk(caps)
          }, () => { reject(BRIDGE_CLOSE_CODES.authFailed, 'could not verify the bridge proof') })
          return
        }
        case 'verifying':
        case 'accepted':
          queued.push(frame)
          return
        case 'ready':
          deliver(frame)
          return
        case 'proving':
        case 'failed':
          return
      }
    })
    socket.addEventListener('close', () => { finish(false) }, { once: true })
    this.ackTimer = setTimeout(() => { reject(BRIDGE_CLOSE_CODES.helloTimeout, 'handshake timed out') }, HELLO_ACK_TIMEOUT_MS)
    return {
      accepted,
      release: () => {
        if (stage !== 'accepted') return
        stage = 'ready'
        for (const frame of queued.splice(0)) deliver(frame)
      },
    }
  }

  private async fail(socket: WebSocket): Promise<void> {
    if (this.ws === socket) this.ws = null
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (!this.running) return
    if (!this.retryAllowed()) return
    this.emitState('reconnecting')
    await this.waitBeforeRetry()
  }

  private retryAllowed(): boolean {
    if (this.shouldReconnect()) return true
    this.running = false
    this.emitState('stopped')
    return false
  }

  private async waitBeforeRetry(): Promise<void> {
    this.attempt += 1
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
    const delay = cap / 2 + Math.random() * (cap / 2)
    await new Promise<void>((resolve) => { setTimeout(resolve, delay) })
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer)
      this.ackTimer = undefined
    }
  }

  private emitState(state: BridgeState): void {
    this.state = state
    this.sinks.onStateChange(state)
  }
}
