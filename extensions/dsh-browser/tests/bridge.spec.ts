// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  BridgeFrameChannel,
  computeBridgeProof,
  createBridgeNonce,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, INSTALLED_TOKEN_PATH, InstalledTokenUnreadableError, loadInstalledToken, type BridgeState } from '../src/background/bridge.ts'
import { challengeUntilHello, completeHandshake, TEST_BRIDGE_TOKEN } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'

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
  /** The endpoint every recordingClient dials. */
  const ENDPOINT = { host: '127.0.0.1', port: 3080 }

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

  const challenge = challengeUntilHello

  it('sends nothing before the challenge and never sends the token', async () => {
    const { client } = recordingClient()
    const socket = await openSocket()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(socket.sent).toEqual([])
    const serverNonce = createBridgeNonce()
    const hello = await challenge(socket, serverNonce)
    expect(hello.mac).toBe(await computeBridgeProof(TEST_BRIDGE_TOKEN, 'client', serverNonce, hello.nonce, ENDPOINT, { client: hello.caps }))
    expect(JSON.stringify(socket.sent)).not.toContain(TEST_BRIDGE_TOKEN)
    client.stop()
  })

  it('refuses a bridge whose hello.ok proof does not verify and forwards none of its frames', async () => {
    const { client, states, frames, helloOk } = recordingClient()
    const socket = await openSocket()
    const serverNonce = createBridgeNonce()
    const hello = await challenge(socket, serverNonce)
    // An impostor that does not know the token can only guess the proof.
    socket.receive({ t: 'hello.ok', caps: CAPS, mac: await computeBridgeProof('wrong-token', 'server', hello.nonce, serverNonce, ENDPOINT, { client: hello.caps, server: CAPS }) })
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

  it('ignores every frame before authentication, then delivers sealed frames queued before release in order', async () => {
    const { client, states, frames, helloOk } = recordingClient()
    const socket = await openSocket()
    // Unauthenticated noise before the handshake completes is dropped.
    socket.receive({ t: 'event', frame: { rpcId: 'early', method: 'session/state', payload: {} } })
    socket.receive({ t: 'error', code: 'x', message: 'forged' })
    const serverNonce = createBridgeNonce()
    const hello = await challenge(socket, serverNonce)
    socket.receive({ t: 'rpc.result', id: 'r', ok: true, result: {} })
    const channel = BridgeFrameChannel.derive(TEST_BRIDGE_TOKEN, 'server', serverNonce, hello.nonce, ENDPOINT)
    socket.receive({ t: 'hello.ok', caps: CAPS, mac: await computeBridgeProof(TEST_BRIDGE_TOKEN, 'server', hello.nonce, serverNonce, ENDPOINT, { client: hello.caps, server: CAPS }) })
    // Sent by the real bridge right after hello.ok, before the loop released the socket.
    socket.receiveRaw(channel.seal({ t: 'event', frame: { rpcId: 'e1', method: 'session/subscribed', payload: {} } }))
    socket.receiveRaw(channel.seal({ t: 'ping' }))
    socket.receiveRaw(channel.seal({ t: 'event', frame: { rpcId: 'e2', method: 'session/queue', payload: {} } }))
    await vi.waitFor(() => { expect(states.at(-1)).toBe('connected') })
    expect(helloOk).toHaveBeenCalledWith(CAPS)
    expect(frames).toEqual([
      { t: 'event', frame: { rpcId: 'e1', method: 'session/subscribed', payload: {} } },
      { t: 'event', frame: { rpcId: 'e2', method: 'session/queue', payload: {} } },
    ])
    const pong = socket.sent.find((frame) => (frame as { t?: unknown }).t === 'sealed')
    expect(channel.open(JSON.stringify(pong))).toEqual({ t: 'pong' })
    client.stop()
  })

  it('drops the connection on an unsealed or replayed frame after hello.ok and reports it', async () => {
    for (const attack of ['unsealed', 'replayed'] as const) {
      FakeWebSocket.instances.length = 0
      const { client, frames } = recordingClient()
      const socket = await openSocket()
      const serverNonce = createBridgeNonce()
      const hello = await challenge(socket, serverNonce)
      const channel = BridgeFrameChannel.derive(TEST_BRIDGE_TOKEN, 'server', serverNonce, hello.nonce, ENDPOINT)
      socket.receive({ t: 'hello.ok', caps: CAPS, mac: await computeBridgeProof(TEST_BRIDGE_TOKEN, 'server', hello.nonce, serverNonce, ENDPOINT, { client: hello.caps, server: CAPS }) })
      const first = channel.seal({ t: 'event', frame: { rpcId: 'e1', method: 'session/queue', payload: {} } })
      socket.receiveRaw(first)
      if (attack === 'unsealed') {
        socket.receive({ t: 'tool.call', id: 'evil', name: 'browser_navigate', args: { url: 'https://evil.example' }, expiresAt: Date.now() + 10_000 })
      } else {
        socket.receiveRaw(first)
      }
      await vi.waitFor(() => { expect(socket.closedWith?.code).toBe(BRIDGE_CLOSE_CODES.authFailed) })
      expect(frames.filter((frame) => (frame as { t: string }).t === 'tool.call')).toEqual([])
      expect(client.failure).toBe('token-mismatch')
      expect(client.send({ t: 'pong' })).toBe(false)
      client.stop()
    }
  })

  it('dials localhost as 127.0.0.1 and binds that endpoint into its proof', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const client = new BridgeClient({ onStateChange: () => {}, onFrame: () => {}, onHelloOk: () => {} }, async () => true)
    client.start('ws://localhost:3080/ext/bridge', TEST_BRIDGE_TOKEN)
    const socket = await openSocket()
    expect(socket.url).toBe('ws://127.0.0.1:3080/ext/bridge')
    const hello = await challenge(socket, createBridgeNonce())
    expect((hello as unknown as { endpoint: unknown }).endpoint).toEqual({ host: '127.0.0.1', port: 3080 })
    client.stop()
  })

  it('closes a bridge that never challenges within the handshake timeout (G26)', async () => {
    vi.useFakeTimers()
    const { client, states, helloOk } = recordingClient()
    const socket = await openSocket()
    await vi.advanceTimersByTimeAsync(4_900)
    expect(socket.closedWith).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(socket.closedWith).toEqual({ code: BRIDGE_CLOSE_CODES.helloTimeout, reason: 'handshake timed out' })
    expect(helloOk).not.toHaveBeenCalled()
    expect(states).not.toContain('connected')
    client.stop()
  })

  it('reports a specific refusal for token, version, and extension-ID closes and backs off', async () => {
    vi.useFakeTimers()
    for (const [code, failure] of [
      [BRIDGE_CLOSE_CODES.authFailed, 'token-mismatch'],
      [BRIDGE_CLOSE_CODES.versionMismatch, 'version-mismatch'],
      [BRIDGE_CLOSE_CODES.originRejected, 'origin-rejected'],
    ] as const) {
      FakeWebSocket.instances.length = 0
      vi.stubGlobal('WebSocket', FakeWebSocket)
      const states: BridgeState[] = []
      const client = new BridgeClient({ onStateChange: (state) => { states.push(state) }, onFrame: () => {}, onHelloOk: () => {} }, async () => true)
      client.start('ws://127.0.0.1:3080/ext/bridge', TEST_BRIDGE_TOKEN)
      const socket = await openSocket()
      socket.close(code, 'refused')
      await vi.waitFor(() => { expect(states.at(-1)).toBe('reconnecting') })
      expect(client.failure).toBe(failure)
      // No fast retry loop: the next attempt waits the refused-retry delay.
      await vi.advanceTimersByTimeAsync(1_000)
      expect({ code, n: FakeWebSocket.instances.length }).toEqual({ code, n: 1 })
      client.stop()
    }
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

  it('reports "no token file" only when the file is known to be missing', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    await expect(loadInstalledToken()).resolves.toBe('')
    // Chrome rejects the fetch of a packaged file that does not exist; the manifest still reads.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/manifest.json')) return new Response('{}', { status: 200 })
      throw new TypeError('Failed to fetch')
    }))
    await expect(loadInstalledToken()).resolves.toBe('')
    vi.stubGlobal('chrome', undefined)
    await expect(loadInstalledToken()).resolves.toBe('')
  })

  it('regression (review 2, L6): a file that is there but yields no token is "unreadable", never "no token"', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://id/${path}` } })
    // Caught mid-rewrite (empty), malformed, a server error, or nothing readable at all.
    for (const answer of [
      async () => new Response('', { status: 200 }),
      async () => new Response('two words', { status: 200 }),
      async () => new Response(null, { status: 500 }),
      async () => { throw new TypeError('Failed to fetch') },
    ]) {
      vi.stubGlobal('fetch', vi.fn(answer))
      await expect(loadInstalledToken()).rejects.toBeInstanceOf(InstalledTokenUnreadableError)
    }
  })

  it('an unreadable token file keeps the client retrying with its own status, and dials nothing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const states: BridgeState[] = []
    let readable = false
    const client = new BridgeClient({ onStateChange: (state) => { states.push(state) }, onFrame: () => {}, onHelloOk: () => {} },
      async () => true, () => true, {}, async () => {
        if (!readable) throw new InstalledTokenUnreadableError()
        return TEST_BRIDGE_TOKEN
      })
    client.start('ws://127.0.0.1:3080/ext/bridge', '')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.failure).toBe('token-unreadable')
    expect(states.at(-1)).toBe('reconnecting')
    expect(FakeWebSocket.instances).toHaveLength(0)
    // The next attempt reads the file again, at the ordinary cadence.
    readable = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })
})
