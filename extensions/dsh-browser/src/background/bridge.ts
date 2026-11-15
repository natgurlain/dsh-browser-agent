/**
 * Bridge WebSocket client (background side): connects to the dsh bridge,
 * runs the mutual challenge-response handshake, keeps the connection alive
 * with exponential-backoff reconnects, and answers protocol pings.
 *
 * Handshake (protocol v4): the bridge opens with `challenge { nonce: Ns }`;
 * the client answers `hello { nonce: Nc, endpoint: E, mac: HMAC(token, client|Ns|Nc|E) }`
 * where E is the address and port it dialed; the bridge checks E against the
 * socket it accepted and answers `hello.ok { mac: HMAC(token, server|Nc|Ns|E) }`.
 * Nothing from the socket is trusted, and nothing but `hello` is sent, until
 * that server proof verifies, so a local process squatting on a probed port
 * cannot learn the token or impersonate the bridge, and one that relays the
 * handshake to the real bridge from another port fails the endpoint check.
 * Every later frame, both ways, is sealed by a per-connection channel
 * (protocol.BridgeFrameChannel): a frame that is not the next authentic one
 * closes the socket. Frames are authenticated, not encrypted. The token itself
 * never crosses the wire.
 *
 * Token source: the settings field when filled in (typed by the user, or
 * stored there by one-step pairing, see pairing.ts), otherwise the `bridge-token` file the installer and the dsh
 * plugin keep inside the unpacked Chrome extension directory. That file is not
 * a web-accessible resource, so pages and other extensions cannot read it.
 *
 * The reconnect policy mirrors the dsh GUI's own ConnectionController: base
 * 500ms, ×2 per attempt, capped at 10s, jittered 0.5–1×.
 *
 * @module
 */

import type { BridgeCaps, BridgeEndpoint, ClientFrame, ServerFrame } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  BridgeFrameChannel,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  bridgeDialUrl,
  bridgeEndpointOfUrl,
  bridgeProof,
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
 * The installer's `bridge-token` file is there but could not be read as a
 * token (empty, malformed, or the read itself failed). That is not "this
 * install has no token": the caller retries, and nothing pairs by itself.
 */
export class InstalledTokenUnreadableError extends Error {
  constructor() {
    super('the installed bridge token could not be read')
    this.name = 'InstalledTokenUnreadableError'
  }
}

/**
 * Read the token the installer (and the dsh plugin on each start) writes into
 * the unpacked extension directory.
 *
 * "No token file" is reported only when the file is known to be missing: the
 * fetch answers 404, or it fails while another packaged file (the manifest)
 * can be fetched. Chrome rejects the fetch of a packaged file that does not
 * exist instead of answering 404, so a rejection alone cannot tell "missing"
 * from "unreadable"; the manifest read is what tells them apart.
 * @returns the token, or an empty string when no token file is provisioned.
 * @throws InstalledTokenUnreadableError when a file is there but yields no token, or nothing can be read at all.
 */
export async function loadInstalledToken(): Promise<string> {
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (path: string) => string } } }).chrome?.runtime
  if (typeof runtime?.getURL !== 'function') return ''
  let response: Response
  try {
    response = await fetch(runtime.getURL(INSTALLED_TOKEN_PATH), { cache: 'no-store' })
  } catch {
    const manifest = await fetch(runtime.getURL('manifest.json'), { cache: 'no-store' }).then(answer => answer.ok, () => false)
    if (manifest) return ''
    throw new InstalledTokenUnreadableError()
  }
  if (response.status === 404) return ''
  if (!response.ok) throw new InstalledTokenUnreadableError()
  const token = await response.text().then(text => text.trim(), () => '')
  if (!/^[\x21-\x7e]{1,1024}$/u.test(token)) throw new InstalledTokenUnreadableError()
  return token
}

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/**
 * Why the last attempt was refused, for a specific panel message:
 * - `token-mismatch`: a proof or frame MAC failed (wrong token, or something
 *   relaying the connection);
 * - `version-mismatch`: the plugin and extension speak different protocols;
 * - `origin-rejected`: the bridge does not allow this extension's ID;
 * - `busy`: the bridge is refusing unauthenticated sockets for now;
 * - `no-token`: a bridge answers, but this install has no token yet (a store
 *   build before pairing): nothing was dialed;
 * - `token-unreadable`: the installer's token file is there but could not be
 *   read this time: nothing was dialed, and the next attempt reads it again.
 */
export type BridgeFailure = 'token-mismatch' | 'version-mismatch' | 'origin-rejected' | 'busy' | 'no-token' | 'token-unreadable'

/** Map a bridge close code to a {@link BridgeFailure}. */
export function failureOfCloseCode(code: number): BridgeFailure | undefined {
  switch (code) {
    case BRIDGE_CLOSE_CODES.authFailed: return 'token-mismatch'
    case BRIDGE_CLOSE_CODES.versionMismatch: return 'version-mismatch'
    case BRIDGE_CLOSE_CODES.originRejected: return 'origin-rejected'
    case BRIDGE_CLOSE_CODES.busy: return 'busy'
    default: return undefined
  }
}

/** Frame/state sinks owned by the background assembly. */
export interface BridgeSinks {
  onStateChange(state: BridgeState): void
  onFrame(frame: ServerFrame): void
  onHelloOk(caps: BridgeCaps): void
  /**
   * The peer at `url` answered the handshake but could not prove knowledge of
   * the token (we closed it with 4002). Whatever is listening there is not our
   * bridge — typically a local process squatting on a probed port — so the
   * owner should stop preferring that address.
   */
  onServerProofRejected?(url: string): void
}

/** Client-side hello caps beyond the snapshot contract. */
export type BridgeClientCaps = Pick<BridgeCaps, 'devTools' | 'client' | 'standingUpdates'>

/** Resolve whether opening a WebSocket is expected to succeed. */
type BridgeProbe = (url: string) => Promise<boolean>

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
/**
 * Retry delay after a refusal that only a user action can fix (token, version,
 * extension ID): retrying fast would only repeat the refusal.
 */
export const REFUSED_RETRY_MS = 30_000
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
  /** Frame channel of the authenticated socket; undefined until hello.ok verifies. */
  private channel: BridgeFrameChannel | undefined
  /** Why the most recent attempt was refused; cleared by a successful connection. */
  failure: BridgeFailure | undefined
  /** The bridge handed this install's slot to another connection (close code 4000); cleared by `start`. */
  replaced = false

  constructor(
    readonly sinks: BridgeSinks,
    private readonly probe: BridgeProbe = async () => true,
    /** Whether a disconnected client still has an active user-owned lease. */
    private readonly shouldReconnect: () => boolean = () => true,
    /**
     * Capabilities this build can serve beyond the text snapshot contract,
     * plus this install's client identity. Read on every `hello`: the host
     * registers the developer-tools group only for an extension that claims
     * it (the user's own setting still gates every call), and keeps one
     * connection per identity.
     */
    private readonly capabilities: BridgeClientCaps | (() => BridgeClientCaps) = {},
    /** Token fallback when settings carry none (zero-config Chrome installs). */
    private readonly tokenSource: BridgeTokenSource = loadInstalledToken,
  ) {}

  /** Current coarse state (mirrors the last emitted sink value). */
  state: BridgeState = 'stopped'

  /**
   * Connect (or reconnect) to the bridge. Idempotent: calling again with the
   * same url/token restarts the loop from attempt 0.
   *
   * A restart reports `stopped` first, which listeners take as the end of
   * this connection (the panel drops its conversation). The exception is a
   * client that is only waiting to retry this very address and token: it
   * retries now and stays `reconnecting`, because nothing ended.
   * @param url - bridge WebSocket URL (e.g. ws://127.0.0.1:3080/ext/bridge).
   * @param token - shared token from settings; empty falls back to the
   *   provisioned `bridge-token` file, re-read on every attempt.
   */
  start(url: string, token: string): void {
    if (this.running && this.state === 'reconnecting' && this.ws === null
      && url === this.url && token === this.token) {
      // The superseded loop sees the new generation when its wait ends.
      this.attempt = 0
      this.generation += 1
      void this.loop(this.generation)
      return
    }
    // A new start is a new verdict: the stop below must not report the old one.
    this.failure = undefined
    this.replaced = false
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
    this.channel = undefined
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

  /**
   * Send one sealed liveness frame. The bridge ignores unsolicited `pong`s,
   * but the traffic keeps an MV3 service worker from being stopped as idle.
   * @returns false when no authenticated socket exists.
   */
  heartbeat(): boolean {
    return this.send({ t: 'pong' })
  }

  /** Whether the connect loop is running (connecting, connected, or waiting to retry). */
  get active(): boolean {
    return this.running
  }

  /** Whether a frame can be sent right now (an authenticated, open socket). */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.channel !== undefined
  }

  /**
   * Send one client frame, sealed for this connection.
   * @param frame - frame to send.
   * @returns false when no authenticated socket exists.
   */
  send(frame: ClientFrame): boolean {
    const socket = this.ws
    const channel = this.channel
    if (socket === null || socket.readyState !== WebSocket.OPEN || channel === undefined) return false
    socket.send(channel.seal(frame))
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

      let unreadable = false
      const token = this.token !== '' ? this.token : await this.tokenSource().catch((error: unknown) => {
        unreadable = error instanceof InstalledTokenUnreadableError
        return ''
      })
      if (!this.running || generation !== this.generation) return
      if (unreadable) {
        // A token exists but was not readable just now (the plugin may be rewriting the file): try again, never pair.
        console.warn('dsh bridge: the installed bridge token could not be read; retrying')
        this.failure = 'token-unreadable'
        if (!this.retryAllowed()) return
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }
      if (token === '') {
        // Without a secret the handshake cannot succeed; wait for the installer
        // or the dsh plugin to provision it (or for the user to paste one).
        console.warn('dsh bridge: no bridge token is configured or provisioned; skipping connection attempt')
        // Reported so the panel can offer pairing instead of a bare "reconnecting".
        this.failure = 'no-token'
        if (!this.retryAllowed()) return
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }

      // Dial the literal the proof binds (`localhost` → 127.0.0.1).
      const dialUrl = bridgeDialUrl(this.url)
      const endpoint = bridgeEndpointOfUrl(dialUrl)
      if (endpoint === undefined) {
        console.warn(`dsh bridge: ${dialUrl} is not a ws:// or wss:// URL`)
        this.emitState('reconnecting')
        await this.waitBeforeRetry()
        continue
      }
      this.channel = undefined
      const socket = new WebSocket(dialUrl)
      this.ws = socket
      // A replacement is an ownership handoff, not a transient transport
      // failure. Yield permanently so two open profiles cannot reconnect in a
      // tight loop and repeatedly evict one another.
      socket.addEventListener('close', (event) => {
        // A refusal only a user action can fix is reported to the panel.
        const failure = failureOfCloseCode(event.code)
        if (failure !== undefined && this.ws === socket) this.failure = failure
        if (event.code !== BRIDGE_CLOSE_CODES.replaced || this.ws !== socket || !this.running) return
        this.running = false
        this.replaced = true
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

      const session = this.authenticate(socket, token, endpoint)
      const accepted = await session.accepted
      if (!accepted || !this.running || generation !== this.generation || socket.readyState !== WebSocket.OPEN) {
        await this.fail(socket)
        continue
      }

      this.attempt = 0
      this.failure = undefined
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
   * frame except the expected handshake step is dropped; afterwards every
   * message must be the next sealed frame of this connection's channel, or
   * the socket is closed. Frames that arrive before {@link release} queue.
   */
  private authenticate(
    socket: WebSocket,
    token: string,
    endpoint: BridgeEndpoint,
  ): { accepted: Promise<boolean>; release: () => void } {
    const url = this.url
    type Stage = 'challenge' | 'awaiting-ok' | 'accepted' | 'ready' | 'failed'
    let stage: Stage = 'challenge'
    let serverNonce = ''
    let clientNonce = ''
    let helloCaps: BridgeCaps | undefined
    let channel: BridgeFrameChannel | undefined
    const queued: ServerFrame[] = []
    let settle!: (accepted: boolean) => void
    const accepted = new Promise<boolean>((resolve) => { settle = resolve })
    const finish = (ok: boolean): void => {
      if (stage === 'accepted' || stage === 'ready' || stage === 'failed') return
      stage = ok ? 'accepted' : 'failed'
      this.clearAckTimer()
      settle(ok)
    }
    const reject = (code: number, reason: string, failure?: BridgeFailure): void => {
      console.warn(`dsh bridge: ${reason}`)
      if (failure !== undefined) this.failure = failure
      if (stage === 'accepted' || stage === 'ready') stage = 'failed'
      finish(false)
      if (this.channel === channel) this.channel = undefined
      if (socket.readyState === WebSocket.OPEN) socket.close(code, reason)
    }
    const deliver = (frame: ServerFrame): void => {
      if (frame.t === 'ping') {
        if (socket.readyState === WebSocket.OPEN && channel !== undefined) socket.send(channel.seal({ t: 'pong' }))
        return
      }
      this.sinks.onFrame(frame)
    }

    socket.addEventListener('message', (event: MessageEvent) => {
      const text = String(event.data)
      if (stage === 'accepted' || stage === 'ready') {
        const opened = channel?.open(text)
        if (opened === undefined || !isServerFrame(opened)) {
          reject(BRIDGE_CLOSE_CODES.authFailed, 'a bridge frame failed authentication; dropping the connection', 'token-mismatch')
          return
        }
        if (stage === 'ready') deliver(opened)
        else queued.push(opened)
        return
      }
      const frame = parseBridgeFrame(text)
      if (frame === undefined || !isServerFrame(frame)) return
      switch (stage) {
        case 'challenge': {
          if (frame.t !== 'challenge') return
          if (frame.v !== BRIDGE_PROTOCOL_VERSION) {
            reject(BRIDGE_CLOSE_CODES.versionMismatch,
              `protocol version mismatch: extension speaks v${String(BRIDGE_PROTOCOL_VERSION)}, bridge sent v${String(frame.v)}`,
              'version-mismatch')
            return
          }
          serverNonce = frame.nonce
          clientNonce = createBridgeNonce()
          helloCaps = {
            textOnly: true,
            snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS,
            maxInteractiveItems: 60,
            ...typeof this.capabilities === 'function' ? this.capabilities() : this.capabilities,
          }
          let mac: string
          try {
            mac = bridgeProof(token, 'client', serverNonce, clientNonce, endpoint, { client: helloCaps })
          } catch {
            reject(BRIDGE_CLOSE_CODES.authFailed, 'could not compute the handshake proof')
            return
          }
          socket.send(JSON.stringify({
            t: 'hello',
            v: BRIDGE_PROTOCOL_VERSION,
            nonce: clientNonce,
            mac,
            endpoint,
            caps: helloCaps,
          } satisfies ClientFrame))
          stage = 'awaiting-ok'
          return
        }
        case 'awaiting-ok': {
          if (frame.t !== 'hello.ok') return
          const expected = bridgeProof(token, 'server', clientNonce, serverNonce, endpoint, { client: helloCaps, server: frame.caps })
          if (!constantTimeEqual(expected, frame.mac)) {
            reject(BRIDGE_CLOSE_CODES.authFailed,
              'the bridge did not prove knowledge of the token for this address; refusing to trust it', 'token-mismatch')
            // Not our bridge (e.g. a squatter on a probed port): let the owner forget it.
            this.sinks.onServerProofRejected?.(url)
            return
          }
          channel = BridgeFrameChannel.derive(token, 'client', serverNonce, clientNonce, endpoint)
          this.channel = channel
          finish(true)
          this.sinks.onHelloOk(frame.caps)
          return
        }
        case 'failed':
          return
      }
    })
    socket.addEventListener('close', () => {
      if (this.channel === channel) this.channel = undefined
      finish(false)
    }, { once: true })
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
    if (this.ws === socket) {
      this.ws = null
      this.channel = undefined
    }
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
    // A missing token keeps the ordinary cadence: the installer or a pairing may provide it any moment.
    const transient = this.failure === undefined || this.failure === 'busy' || this.failure === 'no-token' || this.failure === 'token-unreadable'
    const ceiling = transient ? BACKOFF_MAX_MS : REFUSED_RETRY_MS
    const cap = transient
      ? Math.min(ceiling, BACKOFF_BASE_MS * 2 ** Math.max(0, this.attempt - 1))
      : ceiling
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
