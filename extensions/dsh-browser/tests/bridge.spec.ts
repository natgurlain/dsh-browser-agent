// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  computeBridgeProof,
  createBridgeNonce,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, INSTALLED_TOKEN_PATH, loadInstalledToken, type BridgeState } from '../src/background/bridge.ts'
import { completeHandshake, TEST_BRIDGE_TOKEN } from './support/bridge-handshake.ts'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly sent: unknown[] = []
  closedWith: { code: number; reason: string } | undefined

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.closedWith = { code, reason }
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('BridgeClient connection probe', () => {
  it('waits without opening a WebSocket while the local bridge is unavailable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const probe = vi.fn(async () => false)
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, probe)

    client.start('ws://127.0.0.1:3080/ext/bridge', TEST_BRIDGE_TOKEN)
    await vi.advanceTimersByTimeAsync(0)

    expect(probe).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(states.at(-1)).toBe('reconnecting')
    client.stop()
  })

  it('opens the WebSocket after the probe succeeds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true)

    client.start('ws://127.0.0.1:3080/ext/bridge', TEST_BRIDGE_TOKEN)
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('does not retry after the bridge explicitly replaces this connection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    })

    client.start('ws://127.0.0.1:3080/ext/bridge', TEST_BRIDGE_TOKEN)
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: () => { expect(states.at(-1)).toBe('connected') } })

    socket.close(4000, 'replaced')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('stops reconnecting after its user-owned lease disappears', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let active = true
    const states: BridgeState[] = []
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => active)

    client.start('ws://127.0.0.1:3080/ext/bridge', TEST_BRIDGE_TOKEN)
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]!
    active = false
    socket.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(states.at(-1)).toBe('stopped')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('bridge capability advertisement', () => {
  /** Capture the first frame the client sends, which is always `hello` (answering the challenge). */
  async function firstFrame(capabilities: { devTools?: { version: 1 } }): Promise<Record<string, unknown>> {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({
      onStateChange: () => {},
      onFrame: () => {},
      onHelloOk: () => {},
    }, async () => true, () => true, capabilities)
    client.start('ws://127.0.0.1:3080/ext/bridge', 'token')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    await completeHandshake(socket, { token: 'token' })
    client.stop()
    return socket.sent[0] as Record<string, unknown>
  }

  it('advertises the developer-tools capability the host needs to register its group', async () => {
    const frame = await firstFrame({ devTools: { version: 1 } })
    expect(frame).toMatchObject({
      t: 'hello',
      v: BRIDGE_PROTOCOL_VERSION,
      caps: {
        textOnly: true,
        snapshotMaxChars: 32_000,
        maxInteractiveItems: 60,
        devTools: { version: 1 },
      },
    })
  })

  it('omits the capability on a platform that cannot serve it', async () => {
    const frame = await firstFrame({})
    const caps = frame.caps as Record<string, unknown>
    expect(caps.textOnly).toBe(true)
    // An absent field is what keeps the host from registering unusable tools.
    expect('devTools' in caps).toBe(false)
  })
})

describe('bridge mutual authentication', () => {
  const CAPS = { textOnly: true as const, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

  function recordingClient(token = TEST_BRIDGE_TOKEN, tokenSource?: () => Promise<string>) {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    const frames: unknown[] = []
    const helloOk = vi.fn()
    const client = new BridgeClient({
      onStateChange: (state) => { states.push(state) },
      onFrame: (frame) => { frames.push(frame) },
      onHelloOk: helloOk,
    }, async () => true, () => true, {}, tokenSource)
    client.start('ws://127.0.0.1:3080/ext/bridge', token)
    return { client, states, frames, helloOk }
  }

  async function openSocket(): Promise<FakeWebSocket> {
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0) })
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    return socket
  }

  /** Send the challenge until the client answers; return the client's hello. */
  async function challenge(socket: FakeWebSocket, nonce: string): Promise<{ nonce: string; mac: string }> {
    let hello: { t: string; nonce: string; mac: string } | undefined
    await vi.waitFor(() => {
      hello = socket.sent.find((frame) => (frame as { t: string }).t === 'hello') as typeof hello
      if (hello === undefined) socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce })
      expect(hello).toBeDefined()
    }, { interval: 5 })
    return hello!
  }

  it('sends nothing before the challenge and never sends the token', async () => {
    const { client } = recordingClient()
    const socket = await openSocket()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(socket.sent).toEqual([])
    const serverNonce = createBridgeNonce()
    const hello = await challenge(socket, serverNonce)
    expect(hello.mac).toBe(await computeBridgeProof(TEST_BRIDGE_TOKEN, 'client', serverNonce, hello.nonce))
    expect(JSON.stringify(socket.sent)).not.toContain(TEST_BRIDGE_TOKEN)
    client.stop()
  })

  it('refuses a bridge whose hello.ok proof does not verify and forwards none of its frames', async () => {
    const { client, states, frames, helloOk } = recordingClient()
    const socket = await openSocket()
    const serverNonce = createBridgeNonce()
    const hello = await challenge(socket, serverNonce)
    // An impostor that does not know the token can only guess the proof.
    socket.receive({ t: 'hello.ok', caps: CAPS, mac: await computeBridgeProof('wrong-token', 'server', hello.nonce, serverNonce) })
    socket.receive({ t: 'tool.call', id: 'evil', name: 'browser_navigate', args: { url: 'https://evil.example' }, expiresAt: Date.now() + 10_000 })
    await vi.waitFor(() => { expect(socket.closedWith?.code).toBe(BRIDGE_CLOSE_CODES.authFailed) })
    expect(helloOk).not.toHaveBeenCalled()
    expect(frames).toEqual([])
    expect(states).not.toContain('connected')
    // Only the hello itself was ever sent to the impostor.
    expect(socket.sent.map((frame) => (frame as { t: string }).t)).toEqual(['hello'])
    client.stop()
  })

  it('rejects a reflected client proof as the server proof', async () => {
    const { client, helloOk } = recordingClient()
    const socket = await openSocket()
    const hello = await challenge(socket, createBridgeNonce())
    socket.receive({ t: 'hello.ok', caps: CAPS, mac: hello.mac })
    await vi.waitFor(() => { expect(socket.closedWith?.code).toBe(BRIDGE_CLOSE_CODES.authFailed) })
    expect(helloOk).not.toHaveBeenCalled()
    client.stop()
  })

  it('ignores every frame before authentication, then delivers frames queued during verification in order', async () => {
    const { client, states, frames, helloOk } = recordingClient()
    const socket = await openSocket()
    // Unauthenticated noise before the handshake completes is dropped.
    socket.receive({ t: 'event', frame: { rpcId: 'early', method: 'session/state', payload: {} } })
    socket.receive({ t: 'error', code: 'x', message: 'forged' })
    const serverNonce = createBridgeNonce()
    const hello = await challenge(socket, serverNonce)
    socket.receive({ t: 'rpc.result', id: 'r', ok: true, result: {} })
    socket.receive({ t: 'hello.ok', caps: CAPS, mac: await computeBridgeProof(TEST_BRIDGE_TOKEN, 'server', hello.nonce, serverNonce) })
    // Sent by the real bridge right after hello.ok, before the client verified it.
    socket.receive({ t: 'event', frame: { rpcId: 'e1', method: 'session/subscribed', payload: {} } })
    socket.receive({ t: 'ping' })
    socket.receive({ t: 'event', frame: { rpcId: 'e2', method: 'session/queue', payload: {} } })
    await vi.waitFor(() => { expect(states.at(-1)).toBe('connected') })
    expect(helloOk).toHaveBeenCalledWith(CAPS)
    expect(frames).toEqual([
      { t: 'event', frame: { rpcId: 'e1', method: 'session/subscribed', payload: {} } },
      { t: 'event', frame: { rpcId: 'e2', method: 'session/queue', payload: {} } },
    ])
    expect(socket.sent).toContainEqual({ t: 'pong' })
    client.stop()
  })

  it('closes a bridge that speaks another handshake version', async () => {
    const { client, helloOk } = recordingClient()
    const socket = await openSocket()
    await vi.waitFor(() => {
      if (socket.closedWith === undefined) socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION + 1, nonce: createBridgeNonce() })
      expect(socket.closedWith?.code).toBe(BRIDGE_CLOSE_CODES.versionMismatch)
    }, { interval: 5 })
    expect(socket.sent).toEqual([])
    expect(helloOk).not.toHaveBeenCalled()
    client.stop()
  })

  it('opens no socket while no token is configured or provisioned', async () => {
    const tokenSource = vi.fn(async () => '')
    const { client, states } = recordingClient('', tokenSource)
    await vi.waitFor(() => { expect(tokenSource).toHaveBeenCalled() })
    await vi.waitFor(() => { expect(states.at(-1)).toBe('reconnecting') })
    expect(FakeWebSocket.instances).toHaveLength(0)
    client.stop()
  })

  it('falls back to the provisioned token when settings leave it empty', async () => {
    const tokenSource = vi.fn(async () => 'provisioned-token')
    const { client, states } = recordingClient('', tokenSource)
    const socket = await openSocket()
    await completeHandshake(socket, { token: 'provisioned-token', until: () => { expect(states.at(-1)).toBe('connected') } })
    client.stop()
  })

  it('prefers a token typed into settings over the provisioned one', async () => {
    const tokenSource = vi.fn(async () => 'provisioned-token')
    const { client, states } = recordingClient('typed-token', tokenSource)
    const socket = await openSocket()
    await completeHandshake(socket, { token: 'typed-token', until: () => { expect(states.at(-1)).toBe('connected') } })
    expect(tokenSource).not.toHaveBeenCalled()
    client.stop()
  })
})

describe('loadInstalledToken', () => {
  it('reads the provisioned file from the extension package without caching', async () => {
    const fetchMock = vi.fn(async () => new Response(`${'f'.repeat(64)}\n`, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } })
    await expect(loadInstalledToken()).resolves.toBe('f'.repeat(64))
    expect(fetchMock).toHaveBeenCalledWith(`chrome-extension://id/${INSTALLED_TOKEN_PATH}`, { cache: 'no-store' })
  })

  it('treats a missing, unreadable, or malformed file as no token', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    await expect(loadInstalledToken()).resolves.toBe('')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(loadInstalledToken()).resolves.toBe('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('two words', { status: 200 })))
    await expect(loadInstalledToken()).resolves.toBe('')
    vi.stubGlobal('chrome', undefined)
    await expect(loadInstalledToken()).resolves.toBe('')
  })
})
