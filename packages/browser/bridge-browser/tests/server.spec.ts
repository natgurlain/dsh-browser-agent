import { connect as connectTcp, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  BridgeServer, BridgeToolError, MAX_PENDING_SOCKETS, PRE_AUTH_MAX_PAYLOAD, isAllowedBridgeOrigin, isLoopbackAddress, messageToText,
} from '../src/server.ts'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  PINNED_CHROME_EXTENSION_ID,
  computeBridgeProof,
  createBridgeNonce,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  BRIDGE_AUDIT_EXPORT_METHOD,
  BRIDGE_AUDIT_RECORD_METHOD,
  DEVTOOLS_CAPS_VERSION,
  type BridgeFrame,
} from '../src/protocol.ts'
import { SessionPurgeError } from '../src/session-purge.ts'
import type { BrowserHostApi, HostEventFrame } from '../src/host-api.ts'
import {
  closeOf,
  closeTestBridges,
  endpointOf,
  openSocket,
  sendFrame,
  sendHello,
  startTestBridge,
  testHostApi,
  waitFor,
  type TestBridge,
} from './support/bridge-client.ts'

const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

/** Origin of the pinned (manifest-keyed) Chrome extension. */
const EXT_ORIGIN = `chrome-extension://${PINNED_CHROME_EXTENSION_ID}`
/** Any other installed Chrome extension presents a real, but foreign, Origin. */
const OTHER_EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const FIREFOX_EXT_ORIGIN = 'moz-extension://per-install-uuid'

/** Extension caps used by every hello in this suite. */
const CAPS = { textOnly: true as const, snapshotMaxChars: 12_000, maxInteractiveItems: 60 }

interface Harness extends TestBridge {
  callMock: ReturnType<typeof vi.fn>
  respondMock: ReturnType<typeof vi.fn>
}

async function startBridge(overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<Harness> {
  const callMock = vi.fn(async () => ({ ok: true as const, value: 'ok' }))
  const respondMock = vi.fn(async () => ({ accepted: true }))
  const events: AsyncIterable<HostEventFrame> = {
    async *[Symbol.asyncIterator]() {
      yield { rpcId: 'e1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } }
      yield { rpcId: 'e2', method: 'session/queue', payload: { type: 'session/queue', sessionId: 's1', items: [] } }
    },
  }
  const started = await startTestBridge({ api: { call: callMock, events: () => events, respond: respondMock }, ...overrides })
  return { ...started, callMock, respondMock }
}

const hostApi = testHostApi

/** Close code and reason each test socket observed. */
const socketClose = { get: closeOf }

/** Open a socket; `done` settles when it closes. */
async function connect(url: string, origin?: string): Promise<{ ws: WebSocket; frames: BridgeFrame[]; done: Promise<void> }> {
  const socket = await openSocket(url, origin)
  return { ws: socket.ws, frames: socket.frames, done: socket.closed.then(() => {}) }
}

const send = sendFrame

afterEach(closeTestBridges)

describe('BridgeServer', () => {
  it('decodes every ws message delivery shape', () => {
    expect(messageToText([Buffer.from('a'), Buffer.from('b')])).toBe('ab')
    expect(messageToText(Buffer.from('hi'))).toBe('hi')
    expect(messageToText(new TextEncoder().encode('x').buffer)).toBe('x')
  })

  it('reports negotiated developer-tools support and notifies on each hello', async () => {
    const onCapsChange = vi.fn()
    const h = await startBridge({ onCapsChange })
    // No connection yet: the capability is unsupported.
    expect(h.bridge.devToolsSupported()).toBe(false)

    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    await sendHello(ws, TOKEN, { ...CAPS, devTools: { version: DEVTOOLS_CAPS_VERSION } })
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    expect(onCapsChange).toHaveBeenCalledWith(expect.objectContaining({ devTools: { version: DEVTOOLS_CAPS_VERSION } }))
    expect(h.bridge.devToolsSupported()).toBe(true)

    // A reconnecting extension without the capability retracts it again.
    const { ws: legacy } = await connect(h.url, EXT_ORIGIN)
    await sendHello(legacy, TOKEN, CAPS)
    await waitFor(() => h.bridge.devToolsSupported() === false)
    expect(onCapsChange).toHaveBeenLastCalledWith(CAPS)
    ws.close()
    legacy.close()
  })

  it('authenticates a valid hello and proves its own knowledge of the token back', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    const clientNonce = await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const challenge = frames[0] as Extract<BridgeFrame, { t: 'challenge' }>
    expect(challenge).toMatchObject({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION })
    expect(frames.find((f) => f.t === 'hello.ok')).toEqual({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 },
      mac: await computeBridgeProof(TOKEN, 'server', clientNonce, challenge.nonce, endpointOf(ws), {
        client: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 },
        server: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 },
      }),
    })
    ws.close()
  })

  it('never puts the token on the wire', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(JSON.stringify(frames)).not.toContain(TOKEN)
    ws.close()
  })

  it('issues a fresh challenge per socket so a captured proof cannot be replayed', async () => {
    const h = await startBridge()
    const first = await connect(h.url, EXT_ORIGIN)
    await waitFor(() => first.frames.some((f) => f.t === 'challenge'))
    const firstChallenge = first.frames[0] as Extract<BridgeFrame, { t: 'challenge' }>
    const nonce = createBridgeNonce()
    const capturedMac = await computeBridgeProof(TOKEN, 'client', firstChallenge.nonce, nonce, endpointOf(first.ws), { client: CAPS })
    first.ws.close()
    // Replay the exact hello a valid client sent on an earlier socket.
    const replay = await connect(h.url, EXT_ORIGIN)
    await waitFor(() => replay.frames.some((f) => f.t === 'challenge'))
    const replayChallenge = replay.frames[0] as Extract<BridgeFrame, { t: 'challenge' }>
    expect(replayChallenge.nonce).not.toBe(firstChallenge.nonce)
    replay.ws.send(JSON.stringify({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, mac: capturedMac, endpoint: endpointOf(replay.ws), caps: CAPS }))
    await replay.done
    expect(socketClose.get(replay.ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('rejects a Chrome-extension Origin without a valid proof (an Origin header is forgeable)', async () => {
    const h = await startBridge()
    const { ws, frames, done } = await connect(h.url, EXT_ORIGIN)
    await sendHello(ws, '', CAPS)
    await done
    expect(frames.some((f) => f.t === 'hello.ok')).toBe(false)
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
    expect(h.bridge.hasConnection()).toBe(false)
  })

  it('rejects a proof made with the wrong token', async () => {
    const h = await startBridge()
    const { ws, done } = await connect(h.url, EXT_ORIGIN)
    await sendHello(ws, 'not-the-token', CAPS)
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('rejects a foreign Chrome extension before the handshake', async () => {
    const h = await startBridge()
    const { ws, frames, done } = await connect(h.url, OTHER_EXT_ORIGIN)
    await done
    expect(frames).toEqual([])
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('accepts additional Chrome extension IDs named by configuration', async () => {
    const other = OTHER_EXT_ORIGIN.slice('chrome-extension://'.length)
    const h = await startBridge({ allowedChromeExtensionIds: [PINNED_CHROME_EXTENSION_ID, other] })
    const { ws, frames } = await connect(h.url, OTHER_EXT_ORIGIN)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    ws.close()
  })

  it('classifies WebSocket origins', () => {
    const pinned = new Set([PINNED_CHROME_EXTENSION_ID])
    expect(isAllowedBridgeOrigin(undefined, pinned)).toBe(true)
    expect(isAllowedBridgeOrigin(EXT_ORIGIN, pinned)).toBe(true)
    expect(isAllowedBridgeOrigin(FIREFOX_EXT_ORIGIN, pinned)).toBe(true)
    expect(isAllowedBridgeOrigin(OTHER_EXT_ORIGIN, pinned)).toBe(false)
    expect(isAllowedBridgeOrigin(`${EXT_ORIGIN}.evil.example`, pinned)).toBe(false)
    expect(isAllowedBridgeOrigin('https://evil.example', pinned)).toBe(false)
    expect(isAllowedBridgeOrigin('null', pinned)).toBe(false)
  })

  it('closes a version-1 client (raw token in hello) with a version-mismatch code', async () => {
    const h = await startBridge()
    const { ws, frames, done } = await connect(h.url, EXT_ORIGIN)
    await waitFor(() => frames.some((f) => f.t === 'challenge'))
    ws.send(JSON.stringify({ t: 'hello', token: TOKEN, caps: CAPS }))
    await done
    expect(socketClose.get(ws)).toEqual({
      code: BRIDGE_CLOSE_CODES.versionMismatch,
      reason: expect.stringContaining('protocol version mismatch'),
    })
    expect(frames.some((f) => f.t === 'hello.ok')).toBe(false)
  })

  it('closes a client claiming a newer handshake version', async () => {
    const h = await startBridge()
    const { ws, done } = await connect(h.url)
    ws.send(JSON.stringify({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION + 1, nonce: createBridgeNonce(), mac: createBridgeNonce(), caps: CAPS }))
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.versionMismatch)
  })

  it('rejects a hello that echoes the server nonce as its own', async () => {
    const h = await startBridge()
    const { ws, frames, done } = await connect(h.url)
    await waitFor(() => frames.some((f) => f.t === 'challenge'))
    const challenge = frames[0] as Extract<BridgeFrame, { t: 'challenge' }>
    const mac = await computeBridgeProof(TOKEN, 'client', challenge.nonce, challenge.nonce, endpointOf(ws), { client: CAPS })
    ws.send(JSON.stringify({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: challenge.nonce, mac, endpoint: endpointOf(ws), caps: CAPS }))
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('requires a token from Firefox extension origins because their UUID is not an extension identity', async () => {
    const h = await startBridge()
    const { ws, done } = await connect(h.url, FIREFOX_EXT_ORIGIN)
    await sendHello(ws, '', CAPS)
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('accepts an authenticated Firefox extension origin', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url, FIREFOX_EXT_ORIGIN)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(frames.find((f) => f.t === 'hello.ok')).toBeDefined()
    ws.close()
  })

  it('rejects loopback connections without a token when Origin is not an extension (malicious page)', async () => {
    const h = await startBridge()
    const { ws, done } = await connect(h.url, 'https://evil.example')
    await sendHello(ws, '', CAPS)
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('rejects loopback connections without a token and without any Origin', async () => {
    const h = await startBridge()
    const { ws, done } = await connect(h.url)
    await sendHello(ws, '', CAPS)
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('still requires the token from non-loopback remotes', async () => {
    const h = await startBridge({ remoteAddressOverride: '192.168.1.5' })
    const { ws, done } = await connect(h.url)
    await sendHello(ws, '', CAPS)
    await done
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('terminates unauthenticated TCP connections that never answer the close handshake (relay3 pre-auth)', async () => {
    const h = await startBridge({ helloTimeoutMs: 200 })
    const { port } = new URL(h.url)
    const sockets: Socket[] = []
    const closed = new Set<Socket>()
    for (let index = 0; index < MAX_PENDING_SOCKETS + 8; index += 1) {
      const socket = connectTcp(Number(port), '127.0.0.1')
      socket.on('error', () => {})
      socket.on('close', () => { closed.add(socket) })
      socket.resume()
      socket.write('GET /ext/bridge HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      sockets.push(socket)
    }
    // Neither the evicted nor the timed-out sockets linger waiting for a close reply.
    await vi.waitFor(() => { expect(closed.size).toBe(sockets.length) }, { timeout: 3_000 })
    for (const socket of sockets) socket.destroy()
  })

  it('closes sockets that never present hello', async () => {
    const h = await startBridge({ helloTimeoutMs: 500 })
    const { ws, done } = await connect(h.url)
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects frames before hello', async () => {
    const h = await startBridge()
    const { ws, done } = await connect(h.url)
    send(ws, { t: 'pong' })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('passes rpc frames to the Host adapter and relays a server-response envelope', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-1', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result'))
    const result = frames.find((f) => f.t === 'rpc.result')
    expect(result).toMatchObject({ t: 'rpc.result', id: 'rpc-1', ok: true })
    expect(result).toMatchObject({
      result: { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: 'ok' } },
    })
    expect(h.callMock).toHaveBeenCalledWith({
      rpcId: 'rpc-1', method: 'session.list', payload: {}, signal: expect.any(AbortSignal),
    })
    ws.close()
  })

  it('reports unexpected Host adapter failures as rpc.result errors', async () => {
    const h = await startBridge({ api: hostApi({ call: async () => { throw new Error('boom') } }) })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-2', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-2'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-2'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-2', ok: false, error: { code: 'internal', message: 'Error: boom' } })
    ws.close()
  })

  it('injects followed-page snapshots without forwarding the internal RPC to the gateway', async () => {
    const injectBrowserSnapshot = vi.fn()
    const h = await startBridge({ injectBrowserSnapshot })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc',
      id: 'snapshot-1',
      method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: 'session-1', snapshot: 'Page: Other target' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'snapshot-1'))

    expect(injectBrowserSnapshot).toHaveBeenCalledWith('session-1', 'Page: Other target')
    expect(h.callMock).not.toHaveBeenCalled()
    expect(frames).toContainEqual({
      t: 'rpc.result', id: 'snapshot-1', ok: true, result: { accepted: true },
    })

    send(ws, {
      t: 'rpc',
      id: 'snapshot-invalid',
      method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: '', snapshot: '' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'snapshot-invalid'))
    expect(frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'snapshot-invalid', ok: false, error: expect.objectContaining({ code: 'bad-request' }),
    }))
    ws.close()
  })

  it('refuses snapshot injection and purge for sessions outside the extension scope', async () => {
    const purgeSession = vi.fn(async () => {})
    const injectBrowserSnapshot = vi.fn()
    const allowsSession = vi.fn(async (sessionId: string) => sessionId === 'mine')
    const h = await startBridge({ purgeSession, injectBrowserSnapshot, sessionScope: { allowsSession } })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, { t: 'rpc', id: 'purge-other', method: BRIDGE_SESSION_PURGE_METHOD, payload: { sessionId: 'desktop' } })
    send(ws, { t: 'rpc', id: 'inject-other', method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, payload: { sessionId: 'desktop', snapshot: 'x' } })
    send(ws, { t: 'rpc', id: 'purge-mine', method: BRIDGE_SESSION_PURGE_METHOD, payload: { sessionId: 'mine' } })
    await waitFor(() => ['purge-other', 'inject-other', 'purge-mine'].every((id) => frames.some((frame) => frame.t === 'rpc.result' && frame.id === id)))

    for (const id of ['purge-other', 'inject-other']) {
      expect(frames.find((frame) => frame.t === 'rpc.result' && frame.id === id)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(purgeSession).toHaveBeenCalledExactlyOnceWith('mine')
    expect(injectBrowserSnapshot).not.toHaveBeenCalled()
    ws.close()
  })

  it('purges sessions through the internal RPC without forwarding it to the gateway', async () => {
    const purgeSession = vi.fn(async () => {})
    const h = await startBridge({ purgeSession })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc',
      id: 'purge-1',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: 'session-82222a77-aab5-4c0b-b33e-6376973ec93d' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-1'))

    expect(purgeSession).toHaveBeenCalledWith('session-82222a77-aab5-4c0b-b33e-6376973ec93d')
    expect(h.callMock).not.toHaveBeenCalled()
    expect(frames).toContainEqual({
      t: 'rpc.result', id: 'purge-1', ok: true, result: { purged: true },
    })

    send(ws, {
      t: 'rpc',
      id: 'purge-invalid',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: '' },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-invalid'))
    expect(frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'purge-invalid', ok: false, error: expect.objectContaining({ code: 'bad-request' }),
    }))

    const failing = vi.fn(async () => { throw new SessionPurgeError('running', 'cancel it first') })
    const failureBridge = await startBridge({ purgeSession: failing })
    const failure = await connect(failureBridge.url)
    await sendHello(failure.ws, TOKEN, CAPS)
    await waitFor(() => failure.frames.some((frame) => frame.t === 'hello.ok'))
    send(failure.ws, {
      t: 'rpc',
      id: 'purge-running',
      method: BRIDGE_SESSION_PURGE_METHOD,
      payload: { sessionId: 'session-82222a77-aab5-4c0b-b33e-6376973ec93d' },
    })
    await waitFor(() => failure.frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'purge-running'))
    expect(failure.frames).toContainEqual(expect.objectContaining({
      t: 'rpc.result', id: 'purge-running', ok: false, error: { code: 'running', message: 'cancel it first' },
    }))
    ws.close()
    failure.ws.close()
  })

  it('finishes snapshot injection before forwarding a prompt for the same session', async () => {
    let releaseInjection!: () => void
    const injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve })
    const injectBrowserSnapshot = vi.fn(async () => { await injectionGate })
    const h = await startBridge({ injectBrowserSnapshot })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc', id: 'snapshot', method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
      payload: { sessionId: 'session-ordered', snapshot: 'Current page' },
    })
    send(ws, {
      t: 'rpc', id: 'prompt-after-snapshot', method: 'session.prompt',
      payload: { sessionId: 'session-ordered', mode: 'queue', content: [] },
    })

    await waitFor(() => injectBrowserSnapshot.mock.calls.length === 1)
    expect(h.callMock).not.toHaveBeenCalled()
    releaseInjection()
    await waitFor(() => h.callMock.mock.calls.length === 1)
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'prompt-after-snapshot'))
    expect(frames.filter((frame) => frame.t === 'rpc.result').map((frame) => frame.id)).toEqual([
      'snapshot',
      'prompt-after-snapshot',
    ])
    ws.close()
  })

  it('orders prompt before cancel for one session without blocking other sessions', async () => {
    let releasePrompt!: () => void
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve })
    const calls: Array<{ method: string; sessionId: string }> = []
    const call = vi.fn(async (request: Parameters<BrowserHostApi['call']>[0]) => {
      const sessionId = (request.payload as { sessionId: string }).sessionId
      calls.push({ method: request.method, sessionId })
      if (request.method === 'session.prompt' && sessionId === 'provisional') await promptGate
      return { ok: true as const, value: { accepted: true } }
    })
    const h = await startBridge({ api: hostApi({ call }) })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))

    send(ws, {
      t: 'rpc', id: 'prompt', method: 'session.prompt',
      payload: { sessionId: 'provisional', mode: 'queue', content: [] },
    })
    send(ws, { t: 'rpc', id: 'cancel', method: 'session.cancel', payload: { sessionId: 'provisional' } })
    send(ws, { t: 'rpc', id: 'other-cancel', method: 'session.cancel', payload: { sessionId: 'other' } })

    await waitFor(() => calls.some((call) => call.sessionId === 'other'))
    expect(calls).toContainEqual({ method: 'session.prompt', sessionId: 'provisional' })
    expect(calls).toContainEqual({ method: 'session.cancel', sessionId: 'other' })
    expect(calls).not.toContainEqual({ method: 'session.cancel', sessionId: 'provisional' })

    releasePrompt()
    await waitFor(() => calls.some((call) => call.method === 'session.cancel' && call.sessionId === 'provisional'))
    expect(calls.filter((call) => call.sessionId === 'provisional')).toEqual([
      { method: 'session.prompt', sessionId: 'provisional' },
      { method: 'session.cancel', sessionId: 'provisional' },
    ])
    await waitFor(() => frames.filter((frame) => frame.t === 'rpc.result').length === 3)
    ws.close()
  })

  it('relays interaction responses to the Host adapter with the original rpcId', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    send(ws, {
      t: 'respond',
      id: 'response-1',
      rpcId: 'question-1',
      result: { ok: true, value: { sessionId: 'session-1', answer: { answers: [{ id: 'db', selected: ['SQLite'] }] } } },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'respond.result'))

    expect(frames).toContainEqual(expect.objectContaining({
      t: 'respond.result', id: 'response-1', ok: true,
    }))
    expect(h.respondMock).toHaveBeenCalledWith(
      'question-1',
      { ok: true, value: { sessionId: 'session-1', answer: { answers: [{ id: 'db', selected: ['SQLite'] }] } } },
      expect.any(AbortSignal),
    )
    ws.close()
  })

  it('returns Host response failures to the extension', async () => {
    const h = await startBridge({ api: hostApi({ respond: async () => { throw new Error('response rejected') } }) })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    send(ws, {
      t: 'respond', id: 'response-2', rpcId: 'question-2',
      result: { ok: false, error: { code: 'cancelled', message: 'user dismissed the question', details: {} } },
    })
    await waitFor(() => frames.some((frame) => frame.t === 'respond.result' && frame.id === 'response-2'))
    expect(frames).toContainEqual({
      t: 'respond.result', id: 'response-2', ok: false,
      error: { code: 'internal', message: 'Error: response rejected' },
    })
    ws.close()
  })

  it('rejects privileged methods from non-loopback remotes', async () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('dispatches tool calls and resolves on tool.result', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.name).toBe('browser_click')
    expect(call.args).toEqual({ index: 1 })
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'clicked' } })
    await expect(result).resolves.toEqual({ text: 'clicked' })
    ws.close()
  })

  it('rejects tool calls whose signal is already aborted before dispatch', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url, EXT_ORIGIN)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    abort.abort()
    expect(() => h.bridge.requestTool('browser_click', {}, abort.signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    // No tool.call was sent
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(frames.some((f) => f.t === 'tool.call')).toBe(false)
    ws.close()
  })

  it('rejects tool calls when no extension is connected', async () => {
    const h = await startBridge()
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
  })

  it('times out tool calls that never settle', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    await expect(h.bridge.requestTool('browser_wait', {}, new AbortController().signal, 30))
      .rejects.toMatchObject({ code: 'timeout' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it.each([
    ['blocked', 'blocked'],
    ['', 'browser action failed'],
  ])('propagates the extension-reported tool error %j', async (message, expectedMessage) => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const result = h.bridge.requestTool('browser_navigate', { url: 'https://x' }, new AbortController().signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((f) => f.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    send(ws, { t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message } })
    await expect(result).rejects.toBeInstanceOf(BridgeToolError)
    await expect(result).rejects.toMatchObject({ code: 'action-failed', message: expectedMessage })
    ws.close()
  })

  it('settles pending tool calls when a replacement connection arrives', async () => {
    const h = await startBridge()
    const first = await connect(h.url)
    await sendHello(first.ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => first.frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: the replacement below settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => first.frames.some((f) => f.t === 'tool.call'))

    const second = await connect(h.url)
    await sendHello(second.ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))

    await pendingAssertion
    first.ws.close()
    second.ws.close()
  })

  it('aborts tool calls when the caller signal fires', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const abort = new AbortController()
    const pending = h.bridge.requestTool('browser_click', {}, abort.signal)
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await waitFor(() => frames.some((frame) => frame.t === 'tool.cancel'))
    expect(frames).toContainEqual({ t: 'tool.cancel', id: call.id })
    ws.close()
  })

  it('forwards the owning session with a tool call', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool(
      'browser_click',
      {},
      new AbortController().signal,
      1_000,
      'session-browser',
    )
    await waitFor(() => frames.some((f) => f.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(call.sessionId).toBe('session-browser')
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'done' } })
    await expect(pending).resolves.toEqual({ text: 'done' })
    ws.close()
  })

  it('pumps event frames to the connected extension', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    await waitFor(() => frames.filter((f) => f.t === 'event').length >= 2)
    const events = frames.filter((f) => f.t === 'event') as Extract<BridgeFrame, { t: 'event' }>[]
    expect(events.map((e) => e.frame.method)).toEqual(['session/subscribed', 'session/queue'])
    ws.close()
  })

  it('settles pending tool calls when the send fails mid-flight', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Tear the socket down immediately: the in-flight send reports a write
    // failure (or the close path wins — either settles as bridge-closed).
    const assertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    ws.terminate()
    await assertion
  })

  it('closes cleanly twice (second close is a no-op on the acceptor)', async () => {
    const h = await startBridge()
    await h.bridge.close()
    await expect(h.bridge.close()).resolves.toBeUndefined()
    expect(h.bridge.connectionCount()).toBe(0)
  })

  it('sends protocol pings on the configured cadence and the client answers pong', async () => {
    const h = await startBridge({ pingIntervalMs: 50 })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'ping'))
    send(ws, { t: 'pong' })
    // Answered pings keep the connection: a later ping still arrives on the open socket.
    await waitFor(() => frames.filter((f) => f.t === 'ping').length >= 3)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(h.bridge.connectionCount()).toBe(1)
    ws.close()
  })

  it('stops the stream-failed arm when the pump fails after the socket closed', async () => {
    const lateFailEvents: AsyncIterable<HostEventFrame> = {
      async *[Symbol.asyncIterator]() {
        yield { rpcId: 'l1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } }
        await new Promise((resolve) => { setTimeout(resolve, 120) })
        throw new Error('late failure')
      },
    }
    const h = await startBridge({ api: hostApi({ events: () => lateFailEvents }) })
    const { ws, frames, done } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    ws.close()
    await done
    // The pump fails after the close: the abort flag suppresses the error frame.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    expect(frames.some((f) => f.t === 'error')).toBe(false)
  })

  it('closes cleanly and rejects pending work', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    const pending = h.bridge.requestTool('browser_click', {}, new AbortController().signal)
    // Attach the assertion eagerly: close() settles it before the final await.
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'bridge-closed' })
    await h.bridge.close()
    await pendingAssertion
    expect(() => h.bridge.requestTool('browser_click', {}, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: 'bridge-closed' }))
    ws.close()
  })

  it('tracks connection state through auth, close, and replacement', async () => {
    const h = await startBridge()
    expect(h.bridge.hasConnection()).toBe(false)
    const { ws, frames, done } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    expect(h.bridge.hasConnection()).toBe(true)
    ws.close()
    await done
    // The server processes the close asynchronously; poll for the outcome.
    await expect.poll(() => h.bridge.hasConnection()).toBe(false)
  })

  it('bounds unauthenticated sockets: small pre-auth messages, a pending cap, then the normal limit', async () => {
    const h = await startBridge({ helloTimeoutMs: 10_000 })
    // A pre-auth message larger than PRE_AUTH_MAX_PAYLOAD is refused by the receiver.
    const big = await connect(h.url)
    big.ws.send('x'.repeat(PRE_AUTH_MAX_PAYLOAD + 1))
    await big.done
    expect(socketClose.get(big.ws)?.code).toBe(1009)
    // At most MAX_PENDING_SOCKETS wait in the handshake; a newcomer evicts the
    // oldest, so a squatter holding the pool cannot lock the extension out.
    const waiting = []
    for (let index = 0; index < MAX_PENDING_SOCKETS; index += 1) {
      const socket = await connect(h.url)
      await waitFor(() => socket.frames.some((f) => f.t === 'challenge'))
      waiting.push(socket)
    }
    const extra = await connect(h.url)
    await waiting[0]!.done
    // Evicted with terminate(): no close handshake a squatter could stall.
    expect(socketClose.get(waiting[0]!.ws)?.code).toBe(1006)
    // The newcomer authenticates, leaves the pool, and regains the server limit.
    await sendHello(extra.ws, TOKEN, CAPS)
    await waitFor(() => extra.frames.some((f) => f.t === 'hello.ok'))
    send(extra.ws, { t: 'rpc', id: 'big', method: 'session.list', payload: { pad: 'x'.repeat(PRE_AUTH_MAX_PAYLOAD * 2) } })
    await waitFor(() => extra.frames.some((f) => f.t === 'rpc.result' && f.id === 'big'))
    expect(waiting[1]!.ws.readyState).toBe(WebSocket.OPEN)
    for (const socket of [...waiting, extra]) socket.ws.close()
  })

  it('closes sockets on unparseable frames and ignores client-only frames when ready', async () => {
    const h = await startBridge()
    const { ws, frames, done } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Client-only shapes after ready are ignored (no error frame, no close).
    send(ws, { t: 'pong' })
    send(ws, { t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce(), mac: createBridgeNonce(), endpoint: endpointOf(ws), caps: CAPS })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    // Garbage (anything not sealed by the channel) is a violation and closes the socket.
    ws.send('not-json')
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    expect(socketClose.get(ws)?.code).toBe(BRIDGE_CLOSE_CODES.authFailed)
  })

  it('relays business failures inside the server-response and isolates thrown adapter errors', async () => {
    const h = await startBridge({
      api: hostApi({ call: async () => ({
        ok: false,
        error: { code: 'session-not-found', message: 'missing', details: {} },
      }) }),
    })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'rpc-3', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-3'))
    const businessFailure = frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-3')!
    expect(businessFailure).toMatchObject({
      t: 'rpc.result', id: 'rpc-3', ok: true,
      result: { type: 'server-response', result: { ok: false, error: { code: 'session-not-found' } } },
    })
    ws.close()

    const throwing = await startBridge({
      api: hostApi({ call: async () => { throw new Error('boom') } }),
    })
    const second = await connect(throwing.url)
    await sendHello(second.ws, TOKEN, CAPS)
    await waitFor(() => second.frames.some((f) => f.t === 'hello.ok'))
    send(second.ws, { t: 'rpc', id: 'rpc-4', method: 'session.list', payload: {} })
    await waitFor(() => second.frames.some((f) => f.t === 'rpc.result' && f.id === 'rpc-4'))
    expect(second.frames.find((f) => f.t === 'rpc.result' && f.id === 'rpc-4'))
      .toMatchObject({ t: 'rpc.result', id: 'rpc-4', ok: false, error: { code: 'internal', message: 'Error: boom' } })
    second.ws.close()
  })

  it('ignores tool results with unknown ids', async () => {
    const h = await startBridge()
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    // Unknown id: ignored, connection stays healthy.
    send(ws, { t: 'tool.result', id: 'nope', ok: true, result: {} })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('rejects privileged methods from non-loopback remotes over a real socket', async () => {
    // The sandbox cannot bind arbitrary loopback literals, so the remote
    // address is forced through the test seam; the socket itself is real.
    const h = await startBridge({ remoteAddressOverride: '192.168.1.5' })
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'hello.ok'))
    send(ws, { t: 'rpc', id: 'priv-1', method: 'settings.describe', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'priv-1'))
    expect(frames.find((f) => f.t === 'rpc.result' && f.id === 'priv-1'))
      .toMatchObject({ t: 'rpc.result', id: 'priv-1', ok: false, error: { code: 'forbidden' } })
    // Non-privileged methods still pass for the same remote.
    send(ws, { t: 'rpc', id: 'priv-2', method: 'session.list', payload: {} })
    await waitFor(() => frames.some((f) => f.t === 'rpc.result' && f.id === 'priv-2'))
    const allowed = frames.find((f): f is Extract<BridgeFrame, { t: 'rpc.result' }> => f.t === 'rpc.result' && f.id === 'priv-2')!
    expect(allowed.ok).toBe(true)
    ws.close()
  })

  it('reports a failed event stream and closes the generation for reconnect', async () => {
    const failingEvents: AsyncIterable<HostEventFrame> = {
      async *[Symbol.asyncIterator]() {
        yield { rpcId: 'f1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 } }
        throw new Error('stream broke')
      },
    }
    const h = await startBridge({ api: hostApi({ events: () => failingEvents }) })
    const { ws, frames, done } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((f) => f.t === 'error' && f.code === 'stream-failed'))
    expect(frames.find((f) => f.t === 'error')).toMatchObject({ t: 'error', code: 'stream-failed' })
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('stops pumping events once the socket closes mid-stream', async () => {
    const slowEvents: AsyncIterable<HostEventFrame> = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 100; i += 1) {
          yield { rpcId: `s${i}`, method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: i } }
          await new Promise((resolve) => { setTimeout(resolve, 10) })
        }
      },
    }
    const h = await startBridge({ api: hostApi({ events: () => slowEvents }) })
    const { ws, frames, done } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.filter((f) => f.t === 'event').length >= 2)
    ws.close()
    await done
    // The pump must stop sending after close instead of writing to a dead socket.
    const countBefore = frames.filter((f) => f.t === 'event').length
    await new Promise((resolve) => { setTimeout(resolve, 80) })
    expect(frames.filter((f) => f.t === 'event').length).toBe(countBefore)
  })
})

describe('BridgeServer audit hooks', () => {
  const ready = async (h: Harness): Promise<{ ws: WebSocket; frames: BridgeFrame[] }> => {
    const { ws, frames } = await connect(h.url)
    await sendHello(ws, TOKEN, CAPS)
    await waitFor(() => frames.some((frame) => frame.t === 'hello.ok'))
    return { ws, frames }
  }
  const observer = () => ({ dispatched: vi.fn(), annotated: vi.fn(), settled: vi.fn(), killSwitch: vi.fn() })

  it('reports dispatch, annotation before result, and settlement of every call', async () => {
    const audit = observer()
    const order: string[] = []
    audit.annotated.mockImplementation(() => { order.push('annotated') })
    audit.settled.mockImplementation(() => { order.push('settled') })
    const h = await startBridge({ audit })
    const { ws, frames } = await ready(h)
    const result = h.bridge.requestTool('browser_click', { index: 2 }, new AbortController().signal, 1_000, 'session-a')
    await waitFor(() => frames.some((frame) => frame.t === 'tool.call'))
    const call = frames.find((frame) => frame.t === 'tool.call') as Extract<BridgeFrame, { t: 'tool.call' }>
    expect(audit.dispatched).toHaveBeenCalledWith({ id: call.id, name: 'browser_click', args: { index: 2 }, sessionId: 'session-a', connection: expect.any(String) })
    send(ws, { t: 'rpc', id: 'note', method: BRIDGE_AUDIT_RECORD_METHOD, payload: { callId: call.id, decision: 'allowed', url: 'https://a.test/' } })
    send(ws, { t: 'tool.result', id: call.id, ok: true, result: { text: 'clicked' } })
    await expect(result).resolves.toEqual({ text: 'clicked' })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'note'))
    expect(order).toEqual(['annotated', 'settled'])
    expect(audit.annotated).toHaveBeenCalledWith(call.id, { decision: 'allowed', url: 'https://a.test/' })
    expect(audit.settled).toHaveBeenCalledWith(call.id, { ok: true, result: { text: 'clicked' } })
    expect(h.callMock).not.toHaveBeenCalled()

    const failing = h.bridge.requestTool('browser_type', {}, new AbortController().signal, 30)
    await expect(failing).rejects.toMatchObject({ code: 'timeout' })
    expect(audit.settled).toHaveBeenLastCalledWith(expect.any(String), { ok: false, error: { code: 'timeout', message: expect.stringContaining('timed out') } })

    send(ws, { t: 'rpc', id: 'kill', method: BRIDGE_AUDIT_RECORD_METHOD, payload: { event: 'kill-switch' } })
    send(ws, { t: 'rpc', id: 'bad', method: BRIDGE_AUDIT_RECORD_METHOD, payload: { callId: 'x', heldMs: -1 } })
    await waitFor(() => ['kill', 'bad'].every((id) => frames.some((frame) => frame.t === 'rpc.result' && frame.id === id)))
    expect(audit.killSwitch).toHaveBeenCalledOnce()
    expect(frames.find((frame) => frame.t === 'rpc.result' && frame.id === 'bad')).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    ws.close()
  })

  it('runs the Host kill switch hook for a kill-switch record, with the reporting connection', async () => {
    const onKillSwitch = vi.fn()
    const audit = observer()
    const h = await startBridge({ audit, onKillSwitch })
    const { ws, frames } = await ready(h)
    send(ws, { t: 'rpc', id: 'note', method: BRIDGE_AUDIT_RECORD_METHOD, payload: { callId: 'unknown', decision: 'allowed' } })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'note'))
    expect(onKillSwitch).not.toHaveBeenCalled()
    send(ws, { t: 'rpc', id: 'kill', method: BRIDGE_AUDIT_RECORD_METHOD, payload: { event: 'kill-switch' } })
    await waitFor(() => frames.some((frame) => frame.t === 'rpc.result' && frame.id === 'kill'))
    expect(onKillSwitch).toHaveBeenCalledOnce()
    expect(onKillSwitch).toHaveBeenCalledWith(expect.any(String))
    expect(h.callMock).not.toHaveBeenCalled()
    ws.close()
  })

  it('routes plugin RPCs through extraRpc: answered, thrown, and not handled', async () => {
    const extraRpc = vi.fn((method: string, payload: unknown, context: { connection: string; signal: AbortSignal }) => {
      void context
      if (method === 'bridge.test.answer') return Promise.resolve({ ok: true as const, result: { echoed: payload } })
      if (method === 'bridge.test.throw') return Promise.reject(new Error('handler exploded'))
      return undefined
    })
    const h = await startBridge({ extraRpc })
    const { ws, frames } = await ready(h)
    send(ws, { t: 'rpc', id: 'a', method: 'bridge.test.answer', payload: { n: 1 } })
    send(ws, { t: 'rpc', id: 't', method: 'bridge.test.throw', payload: {} })
    send(ws, { t: 'rpc', id: 'p', method: 'session.list', payload: {} })
    const result = (id: string) => frames.find((frame) => frame.t === 'rpc.result' && frame.id === id)
    await waitFor(() => ['a', 't', 'p'].every((id) => result(id) !== undefined))
    expect(result('a')).toMatchObject({ ok: true, result: { type: 'server-response', result: { ok: true, value: { echoed: { n: 1 } } } } })
    expect(result('t')).toMatchObject({ ok: false, error: { code: 'internal', message: 'handler exploded' } })
    // Not handled: falls through to the Host.
    expect(result('p')).toMatchObject({ ok: true, result: { type: 'server-response' } })
    expect(h.callMock).toHaveBeenCalledOnce()
    expect(h.callMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'session.list' }))
    expect(extraRpc).toHaveBeenCalledWith('bridge.test.answer', { n: 1 }, expect.objectContaining({ connection: expect.any(String) }))
    ws.close()
  })

  it('exports only sessions in the extension scope, and unscoped calls', async () => {
    const exportAudit = vi.fn(async (sessionId: string | undefined) => ({ sessionId: sessionId ?? null, entries: [] }))
    const allowsSession = vi.fn(async (sessionId: string) => sessionId === 'mine')
    const h = await startBridge({ exportAudit, sessionScope: { allowsSession } })
    const { ws, frames } = await ready(h)
    send(ws, { t: 'rpc', id: 'mine', method: BRIDGE_AUDIT_EXPORT_METHOD, payload: { sessionId: 'mine' } })
    send(ws, { t: 'rpc', id: 'other', method: BRIDGE_AUDIT_EXPORT_METHOD, payload: { sessionId: 'desktop' } })
    send(ws, { t: 'rpc', id: 'unscoped', method: BRIDGE_AUDIT_EXPORT_METHOD, payload: {} })
    await waitFor(() => ['mine', 'other', 'unscoped'].every((id) => frames.some((frame) => frame.t === 'rpc.result' && frame.id === id)))
    expect(frames.find((frame) => frame.t === 'rpc.result' && frame.id === 'mine')).toMatchObject({ ok: true, result: { type: 'server-response', result: { ok: true, value: { sessionId: 'mine' } } } })
    expect(frames.find((frame) => frame.t === 'rpc.result' && frame.id === 'other')).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(frames.find((frame) => frame.t === 'rpc.result' && frame.id === 'unscoped')).toMatchObject({ ok: true, result: { result: { value: { sessionId: null } } } })
    expect(exportAudit).toHaveBeenCalledTimes(2)
    ws.close()
  })

  it('passes the resume reason through snapshot injection', async () => {
    const injectBrowserSnapshot = vi.fn()
    const h = await startBridge({ injectBrowserSnapshot })
    const { ws, frames } = await ready(h)
    send(ws, { t: 'rpc', id: 'r', method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, payload: { sessionId: 's', snapshot: 'delta', reason: 'resume' } })
    send(ws, { t: 'rpc', id: 'bad', method: BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, payload: { sessionId: 's', snapshot: 'delta', reason: 'other' } })
    await waitFor(() => ['r', 'bad'].every((id) => frames.some((frame) => frame.t === 'rpc.result' && frame.id === id)))
    expect(injectBrowserSnapshot).toHaveBeenCalledExactlyOnceWith('s', 'delta', 'resume')
    ws.close()
  })
})
