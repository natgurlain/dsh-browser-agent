// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  PINNED_CHROME_EXTENSION_ID,
  bridgeEndpointOfUrl,
  createBridgeNonce,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  createPairingShare,
  derivePairingKeys,
  formatPairingCode,
  sealPairingToken,
  verifyPairingClientConfirmation,
  type PairingContext,
} from '@natgurlain/dsh-bridge-browser/src/pairing.ts'
import {
  PAIRING_COOLDOWN_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_WINDOW_MS,
  PairingWindows,
} from '@natgurlain/dsh-bridge-browser/src/pairing-host.ts'
import {
  TEST_CAPS,
  TEST_TOKEN,
  closeTestBridges,
  connectClient,
  openSocket,
  startTestBridge,
  webSocketWithOrigin,
} from '../../../packages/browser/bridge-browser/tests/support/bridge-client.ts'
import { extensionOrigin, pairWithAnyBridge, pairWithBridge, type PairingResult } from '../src/background/pairing.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'

/** A store build: a Chrome extension ID the bridge has never been told about. */
const STORE_ID = 'abcdefghijklmnopabcdefghijklmnop'
const STORE_ORIGIN = `chrome-extension://${STORE_ID}`
const OTHER_ORIGIN = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'
const URL_A = 'ws://127.0.0.1:3080/ext/bridge'

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
  await closeTestBridges()
})

/** A real bridge with a pairing window the spec controls, and a clock it moves. */
async function startBridge() {
  let at = 5_000_000
  const windows = new PairingWindows(() => at)
  const onPaired = vi.fn()
  const started = await startTestBridge({ pairing: windows, onPaired })
  const begin = (): string => {
    const result = windows.start()
    if (!result.ok) throw new Error('pairing is cooling down')
    return result.code
  }
  return { ...started, windows, onPaired, begin, advance: (ms: number) => { at += ms } }
}

/** Run the extension's pairing client the way a browser would: its sockets carry `origin`. */
function pairAs(origin: string | undefined, url: string, code: string, believed: string = origin ?? ''): Promise<PairingResult> {
  vi.stubGlobal('WebSocket', webSocketWithOrigin(origin))
  return pairWithBridge(url, code, believed)
}

describe('pairing against a real bridge', () => {
  it('pairs a store-installed extension with the code the host shows, then connects normally', async () => {
    const h = await startBridge()
    // Typed the way it is displayed, in lower case.
    const result = await pairAs(STORE_ORIGIN, h.url, formatPairingCode(h.begin()).toLowerCase())
    expect(result).toEqual({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    const client = await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN, token: (result as { token: string }).token })
    expect(client.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
  })

  it('reports a wrong code and learns no token', async () => {
    const h = await startBridge()
    const code = h.begin()
    const wrong = code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`
    expect(await pairAs(STORE_ORIGIN, h.url, wrong)).toEqual({ ok: false, reason: 'wrong-code' })
    expect(h.onPaired).not.toHaveBeenCalled()
    expect(h.windows.status()).toMatchObject({ state: 'open', attemptsLeft: PAIRING_MAX_ATTEMPTS - 1 })
  })

  it('cannot pair when no window is open, with a used code, or with an expired one', async () => {
    const h = await startBridge()
    // Nothing started on the host: an unknown extension is refused at the Origin check.
    expect(await pairAs(STORE_ORIGIN, h.url, 'ABCDEFGH')).toEqual({ ok: false, reason: 'closed' })
    // The pinned (developer) build reaches the bridge and is told the same.
    expect(await pairAs(`chrome-extension://${PINNED_CHROME_EXTENSION_ID}`, h.url, 'ABCDEFGH')).toEqual({ ok: false, reason: 'closed' })

    const code = h.begin()
    expect((await pairAs(STORE_ORIGIN, h.url, code)).ok).toBe(true)
    // Replayed: by the same extension and by another one.
    expect(await pairAs(STORE_ORIGIN, h.url, code)).toEqual({ ok: false, reason: 'closed' })
    expect(await pairAs(OTHER_ORIGIN, h.url, code)).toEqual({ ok: false, reason: 'closed' })

    const late = h.begin()
    h.advance(PAIRING_WINDOW_MS)
    expect(await pairAs(OTHER_ORIGIN, h.url, late)).toEqual({ ok: false, reason: 'closed' })
    expect(h.onPaired).toHaveBeenCalledTimes(1)
  })

  it('stops being offered an exchange once the attempts are used up', async () => {
    const h = await startBridge()
    const code = h.begin()
    const wrong = code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`
    for (let index = 0; index < PAIRING_MAX_ATTEMPTS; index += 1) {
      expect(await pairAs(STORE_ORIGIN, h.url, wrong)).toEqual({ ok: false, reason: 'wrong-code' })
    }
    expect(await pairAs(STORE_ORIGIN, h.url, code)).toEqual({ ok: false, reason: 'closed' })
    expect(h.windows.start().ok).toBe(false)
    h.advance(PAIRING_COOLDOWN_MS)
    expect((await pairAs(STORE_ORIGIN, h.url, h.begin())).ok).toBe(true)
  })

  it('does not complete through another extension: the exchange is bound to the origin that runs it', async () => {
    const h = await startBridge()
    const code = h.begin()
    // Another extension carries this extension's exchange on its own socket
    // (the bridge sees the other Origin; this code believes it is the store build).
    expect(await pairAs(OTHER_ORIGIN, h.url, code, STORE_ORIGIN)).toEqual({ ok: false, reason: 'untrusted' })
    expect(h.onPaired).not.toHaveBeenCalled()
    // The other extension is not allowed afterwards either.
    h.windows.cancel()
    expect((await (await openSocket(h.url, OTHER_ORIGIN)).closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('leaves a connected, already-paired extension untouched while another one pairs', async () => {
    const h = await startBridge()
    const pinned = await connectClient(h.url, TEST_CAPS, { origin: `chrome-extension://${PINNED_CHROME_EXTENSION_ID}` })
    expect((await pairAs(STORE_ORIGIN, h.url, h.begin())).ok).toBe(true)
    expect(h.bridge.connectionCount()).toBe(1)
    expect((await pinned.rpc('session.list', {})).ok).toBe(true)
  })
})

/** Play the bridge half of an exchange on a fake socket, keyed with `code`. */
async function playBridge(socket: FakeWebSocket, code: string, token: string, origin = ''): Promise<boolean> {
  const serverNonce = createBridgeNonce()
  socket.open()
  socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  const hello = await vi.waitFor(() => {
    const frame = socket.sent.find((sent): sent is { t: 'pair.hello'; nonce: string; share: string; origin: string } => (sent as { t?: unknown }).t === 'pair.hello')
    expect(frame).toBeDefined()
    return frame!
  })
  expect(hello.origin).toBe(origin)
  const context: PairingContext = { code, serverNonce, clientNonce: hello.nonce, endpoint: bridgeEndpointOfUrl(socket.url)!, origin }
  const own = createPairingShare(context)
  const keys = derivePairingKeys(context, own.secret, hello.share, own.share, 'server')!
  socket.receive({ t: 'pair.share', share: own.share })
  const confirm = await vi.waitFor(() => {
    const frame = socket.sent.find((sent): sent is { t: 'pair.confirm'; mac: string } => (sent as { t?: unknown }).t === 'pair.confirm')
    expect(frame).toBeDefined()
    return frame!
  })
  if (!verifyPairingClientConfirmation(keys, confirm.mac)) {
    socket.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: the code did not match')
    return false
  }
  socket.receive({ t: 'pair.ok', ...sealPairingToken(keys, token) })
  return true
}

describe('pairing client', () => {
  it('refuses input that cannot be a code without dialing', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    expect(await pairWithBridge(URL_A, 'ABCD', '')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(await pairWithBridge(URL_A, 'ABCD-EFG0', '')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(await pairWithBridge('not a url', 'ABCDEFGH', '')).toEqual({ ok: false, reason: 'unreachable' })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('accepts the token only from a peer that proves the same code', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const paired = pairWithBridge(URL_A, 'abcd-efgh', '')
    expect(await playBridge(FakeWebSocket.instances[0]!, 'ABCDEFGH', 'the-real-bridge-token')).toBe(true)
    expect(await paired).toEqual({ ok: true, token: 'the-real-bridge-token' })
    // The code is never sent, in any frame.
    expect(JSON.stringify(FakeWebSocket.instances[0]!.sent)).not.toMatch(/ABCDEFGH|abcd-efgh/u)
  })

  it('rejects a squatter that answers without knowing the code', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // The impostor runs the exchange with a guess and hands over a token of its own.
    const guessed = pairWithBridge(URL_A, 'ABCDEFGH', '')
    const socket = FakeWebSocket.instances[0]!
    const serverNonce = createBridgeNonce()
    socket.open()
    socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
    const hello = await vi.waitFor(() => {
      const frame = socket.sent.find((sent): sent is { t: 'pair.hello'; nonce: string; share: string } => (sent as { t?: unknown }).t === 'pair.hello')
      expect(frame).toBeDefined()
      return frame!
    })
    const context: PairingContext = { code: 'ZZZZZZZZ', serverNonce, clientNonce: hello.nonce, endpoint: bridgeEndpointOfUrl(URL_A)!, origin: '' }
    const own = createPairingShare(context)
    const keys = derivePairingKeys(context, own.secret, hello.share, own.share, 'server')!
    socket.receive({ t: 'pair.share', share: own.share })
    await vi.waitFor(() => { expect(socket.sent.some(sent => (sent as { t?: unknown }).t === 'pair.confirm')).toBe(true) })
    socket.receive({ t: 'pair.ok', ...sealPairingToken(keys, 'attacker-chosen-token') })
    expect(await guessed).toEqual({ ok: false, reason: 'untrusted' })

    // One that reflects the client's own share back gets no further.
    const reflected = pairWithBridge(URL_A, 'ABCDEFGH', '')
    const mirror = FakeWebSocket.instances[1]!
    mirror.open()
    mirror.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    await vi.waitFor(() => { expect(mirror.sent).toHaveLength(1) })
    mirror.receive({ t: 'pair.share', share: (mirror.sent[0] as { share: string }).share })
    await vi.waitFor(() => { expect(mirror.sent).toHaveLength(2) })
    mirror.receive({ t: 'pair.ok', box: 'abcd', mac: (mirror.sent[1] as { mac: string }).mac })
    expect(await reflected).toEqual({ ok: false, reason: 'untrusted' })

    // A degenerate share (1) would fix the key: refused before confirming anything.
    const degenerate = pairWithBridge(URL_A, 'ABCDEFGH', '')
    const fixed = FakeWebSocket.instances[2]!
    fixed.open()
    fixed.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    await vi.waitFor(() => { expect(fixed.sent).toHaveLength(1) })
    fixed.receive({ t: 'pair.share', share: '1'.padStart(768, '0') })
    expect(await degenerate).toEqual({ ok: false, reason: 'untrusted' })
    expect(fixed.sent).toHaveLength(1)
  })

  it('maps what the bridge says to a reason the panel can explain', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const run = async (act: (socket: FakeWebSocket) => void | Promise<void>): Promise<PairingResult> => {
      const before = FakeWebSocket.instances.length
      const result = pairWithBridge(URL_A, 'ABCDEFGH', '')
      await act(FakeWebSocket.instances[before]!)
      return result
    }
    const afterHello = async (socket: FakeWebSocket): Promise<void> => {
      socket.open()
      socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
      await vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
    }
    // Nothing listening.
    expect(await run((socket) => { socket.close(1006) })).toEqual({ ok: false, reason: 'unreachable' })
    // Refused at the Origin check (unknown extension, no window open).
    expect(await run((socket) => { socket.open(); socket.close(BRIDGE_CLOSE_CODES.originRejected) })).toEqual({ ok: false, reason: 'closed' })
    expect(await run(async (socket) => { await afterHello(socket); socket.close(BRIDGE_CLOSE_CODES.pairingClosed) })).toEqual({ ok: false, reason: 'closed' })
    // The request itself was refused (endpoint or origin did not describe the socket).
    expect(await run(async (socket) => { await afterHello(socket); socket.close(BRIDGE_CLOSE_CODES.pairingFailed) })).toEqual({ ok: false, reason: 'untrusted' })
    // A bridge that predates pairing does not know the frame.
    expect(await run(async (socket) => { await afterHello(socket); socket.close(1008, 'unparseable frame') })).toEqual({ ok: false, reason: 'unsupported' })
    // Another handshake version: a token would not help.
    expect(await run((socket) => {
      socket.open()
      socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION + 1, nonce: createBridgeNonce() })
    })).toEqual({ ok: false, reason: 'version-mismatch' })
  })

  it('gives up after its time budget', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const silent = pairWithBridge(URL_A, 'ABCDEFGH', '', 1_000)
    FakeWebSocket.instances[0]!.open()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await silent).toEqual({ ok: false, reason: 'timeout' })
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED)
    const absent = pairWithBridge(URL_A, 'ABCDEFGH', '', 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await absent).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('reads its own origin only when it is an extension origin', () => {
    expect(extensionOrigin()).toBe('')
    expect(extensionOrigin(undefined)).toBe('')
    expect(extensionOrigin({ origin: 'https://example.com' })).toBe('')
    expect(extensionOrigin({ origin: STORE_ORIGIN })).toBe(STORE_ORIGIN)
    expect(extensionOrigin({ origin: 'moz-extension://per-install-uuid' })).toBe('moz-extension://per-install-uuid')
  })
})

describe('pairing with one of several local bridges', () => {
  const urls = ['ws://127.0.0.1:3080/ext/bridge', 'ws://127.0.0.1:43189/ext/bridge', 'ws://127.0.0.1:43190/ext/bridge']

  it('asks each bridge until one has the window open for this code', async () => {
    const pairOne = vi.fn(async (url: string): Promise<PairingResult> => url === urls[1]
      ? { ok: true, token: 'token-of-second' }
      : { ok: false, reason: 'closed' })
    expect(await pairWithAnyBridge(urls, 'ABCDEFGH', STORE_ORIGIN, pairOne)).toEqual({ ok: true, token: 'token-of-second', url: urls[1] })
    expect(pairOne.mock.calls.map(call => call[0])).toEqual(urls.slice(0, 2))
    expect(pairOne).toHaveBeenCalledWith(urls[0], 'ABCDEFGH', STORE_ORIGIN)
  })

  it('stops at a wrong code, skips squatters, and reports the most telling failure', async () => {
    const wrong = vi.fn(async (url: string): Promise<PairingResult> => ({ ok: false, reason: url === urls[1] ? 'wrong-code' : 'untrusted' }))
    expect(await pairWithAnyBridge(urls, 'ABCDEFGH', '', wrong)).toEqual({ ok: false, reason: 'wrong-code' })
    expect(wrong).toHaveBeenCalledTimes(2)

    const none = vi.fn(async (url: string): Promise<PairingResult> => ({ ok: false, reason: url === urls[0] ? 'untrusted' : url === urls[1] ? 'closed' : 'unreachable' }))
    expect(await pairWithAnyBridge(urls, 'ABCDEFGH', '', none)).toEqual({ ok: false, reason: 'closed' })
    expect(none).toHaveBeenCalledTimes(3)

    expect(await pairWithAnyBridge([], 'ABCDEFGH', '', none)).toEqual({ ok: false, reason: 'unreachable' })
    expect(await pairWithAnyBridge(urls, 'nope', '', none)).toEqual({ ok: false, reason: 'invalid-code' })
    expect(none).toHaveBeenCalledTimes(3)
  })
})
