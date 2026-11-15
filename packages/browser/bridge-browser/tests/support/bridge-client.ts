/**
 * Test-side bridge plumbing shared by the WebSocket specs: a real
 * `BridgeServer` on an ephemeral loopback port, and a client that answers the
 * challenge the way the extension does (proof over the token, then sealed
 * frames).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { vi } from 'vitest'
import WebSocket from 'ws'
import { BridgeServer } from '../../src/server.ts'
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeFrameChannel,
  bridgeEndpointOfUrl,
  computeBridgeProof,
  createBridgeNonce,
  type BridgeFrame,
} from '../../src/protocol.ts'
import type { BrowserHostApi } from '../../src/host-api.ts'

/** The shared secret every spec bridge uses unless it passes its own. */
export const TEST_TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'
/** Extension caps of a plain hello. */
export const TEST_CAPS = { textOnly: true as const, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }

/** Poll until `predicate` holds (real timers). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 10): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, intervalMs) })
  }
}

/** A Host API that answers every call `ok` and has no events. */
export function testHostApi(overrides: Partial<BrowserHostApi> = {}): BrowserHostApi {
  return {
    call: async () => ({ ok: true, value: 'ok' }),
    async *events() {},
    respond: async () => ({ accepted: true }),
    ...overrides,
  }
}

/** A running bridge on 127.0.0.1. */
export interface TestBridge {
  bridge: BridgeServer
  server: Server
  port: number
  url: string
}

const running: TestBridge[] = []
const openSockets = new Set<WebSocket>()

/**
 * Start a bridge with test defaults (token, 1 s tool timeout, plain caps,
 * no-op injection and purge). Closed by {@link closeTestBridges}.
 */
export async function startTestBridge(overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<TestBridge> {
  const bridge = new BridgeServer({
    token: TEST_TOKEN,
    api: testHostApi(),
    toolTimeoutMs: 1_000,
    caps: { ...TEST_CAPS },
    injectBrowserSnapshot: vi.fn(),
    purgeSession: vi.fn(async () => {}),
    ...overrides,
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const started = { bridge, server, port, url: `ws://127.0.0.1:${String(port)}/ext/bridge` }
  running.push(started)
  return started
}

/** Terminate every test socket and close every bridge started here (call from `afterEach`). */
export async function closeTestBridges(): Promise<void> {
  for (const ws of [...openSockets]) ws.terminate()
  openSockets.clear()
  for (const started of running.splice(0)) {
    await started.bridge.close()
    await new Promise<void>((resolve) => { started.server.close(() => { resolve() }) })
  }
}

/** Frames, close info and frame channel per test socket. */
const framesBySocket = new WeakMap<WebSocket, BridgeFrame[]>()
const closeBySocket = new WeakMap<WebSocket, { code: number; reason: string }>()
const channelBySocket = new WeakMap<WebSocket, BridgeFrameChannel>()

/** An open (not yet authenticated) socket. */
export interface TestSocket {
  ws: WebSocket
  /** Every frame received; sealed frames are unsealed once the hello set a channel. */
  frames: BridgeFrame[]
  closed: Promise<{ code: number; reason: string }>
}

/** Open a socket, optionally presenting an `Origin`. */
export function openSocket(url: string, origin?: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === undefined ? undefined : { headers: { origin } })
    openSockets.add(ws)
    const frames: BridgeFrame[] = []
    framesBySocket.set(ws, frames)
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.on('close', (code, reason) => {
        openSockets.delete(ws)
        const info = { code, reason: reason.toString() }
        closeBySocket.set(ws, info)
        done(info)
      })
    })
    ws.on('message', (data) => {
      const text = data.toString()
      const channel = channelBySocket.get(ws)
      const parsed = JSON.parse(text) as { t?: unknown }
      if (channel !== undefined && parsed.t === 'sealed') {
        const frame = channel.open(text)
        if (frame === undefined) throw new Error('the bridge sent a frame that does not verify')
        frames.push(frame)
        return
      }
      frames.push(parsed as BridgeFrame)
    })
    ws.once('error', reject)
    ws.once('open', () => { resolve({ ws, frames, closed }) })
  })
}

/** The close code and reason a test socket saw, once closed. */
export function closeOf(ws: WebSocket): { code: number; reason: string } | undefined {
  return closeBySocket.get(ws)
}

/** The endpoint a test socket dialed. */
export function endpointOf(ws: WebSocket): NonNullable<ReturnType<typeof bridgeEndpointOfUrl>> {
  return bridgeEndpointOfUrl(ws.url)!
}

/** Send one frame, sealed once the socket has authenticated. */
export function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  const channel = channelBySocket.get(ws)
  ws.send(channel === undefined ? JSON.stringify(frame) : channel.seal(frame))
}

/**
 * Answer the bridge's challenge the way the extension does. An empty token
 * stands for a client that does not know the secret: it can only guess.
 * @param options.macCaps - caps to sign instead of the ones sent (a relay rewriting them).
 * @returns the client nonce the hello carried.
 */
export async function sendHello(ws: WebSocket, token: string, caps: Record<string, unknown>, options: { macCaps?: Record<string, unknown> } = {}): Promise<string> {
  const frames = framesBySocket.get(ws)!
  await waitFor(() => frames.some((frame) => frame.t === 'challenge') || ws.readyState !== WebSocket.OPEN)
  const challenge = frames.find((frame) => frame.t === 'challenge') as Extract<BridgeFrame, { t: 'challenge' }> | undefined
  const nonce = createBridgeNonce()
  if (challenge === undefined || ws.readyState !== WebSocket.OPEN) return nonce
  const endpoint = endpointOf(ws)
  const mac = token === ''
    ? createBridgeNonce()
    : await computeBridgeProof(token, 'client', challenge.nonce, nonce, endpoint, { client: options.macCaps ?? caps })
  if (token !== '') channelBySocket.set(ws, BridgeFrameChannel.derive(token, 'client', challenge.nonce, nonce, endpoint))
  ws.send(JSON.stringify({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, mac, endpoint, caps }))
  return nonce
}

/** An authenticated client. */
export interface TestClient extends TestSocket {
  send(frame: BridgeFrame): void
  /** Send one rpc and wait for its result. */
  rpc(method: string, payload: unknown, timeoutMs?: number): Promise<Extract<BridgeFrame, { t: 'rpc.result' }>>
}

/** Open, authenticate and (unless `expectReady: false`) wait for `hello.ok`. */
export async function connectClient(
  url: string,
  caps: Record<string, unknown> = TEST_CAPS,
  options: { token?: string; origin?: string; macCaps?: Record<string, unknown>; expectReady?: boolean; readyTimeoutMs?: number } = {},
): Promise<TestClient> {
  const socket = await openSocket(url, options.origin)
  await sendHello(socket.ws, options.token ?? TEST_TOKEN, caps, options.macCaps === undefined ? {} : { macCaps: options.macCaps })
  if (options.expectReady !== false) {
    await Promise.race([
      waitFor(() => socket.frames.some((frame) => frame.t === 'hello.ok'), options.readyTimeoutMs ?? 2_000),
      socket.closed.then(({ code, reason }) => {
        throw new Error(`the bridge closed before hello.ok (${String(code)} ${reason}): ${JSON.stringify(socket.frames)}`)
      }),
    ])
  }
  let serial = 0
  const client: TestClient = {
    ...socket,
    send: (frame) => { sendFrame(socket.ws, frame) },
    rpc: async (method, payload, timeoutMs = 3_000) => {
      const id = `rpc-${String(++serial)}-${String(Math.random())}`
      client.send({ t: 'rpc', id, method, payload })
      await waitFor(() => socket.frames.some((frame) => frame.t === 'rpc.result' && frame.id === id), timeoutMs)
      return socket.frames.find((frame) => frame.t === 'rpc.result' && frame.id === id) as Extract<BridgeFrame, { t: 'rpc.result' }>
    },
  }
  return client
}

/** The `tool.call` frames a client received. */
export function toolCallsOf(frames: readonly BridgeFrame[]): Array<Extract<BridgeFrame, { t: 'tool.call' }>> {
  return frames.filter((frame): frame is Extract<BridgeFrame, { t: 'tool.call' }> => frame.t === 'tool.call')
}
