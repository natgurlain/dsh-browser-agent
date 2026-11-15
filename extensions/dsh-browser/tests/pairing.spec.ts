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
  derivePairingSession,
  formatPairingCode,
  sealPairingToken,
  verifyPairingCommitment,
  type PairingContext,
} from '@natgurlain/dsh-bridge-browser/src/pairing.ts'
import {
  MAX_PENDING_PAIRINGS,
  PAIRING_REQUEST_TTL_MS,
  PairingRequests,
} from '@natgurlain/dsh-bridge-browser/src/pairing-host.ts'
import {
  TEST_CAPS,
  TEST_TOKEN,
  closeTestBridges,
  connectClient,
  openSocket,
  sendHello,
  startTestBridge,
  waitFor,
  webSocketWithOrigin,
} from '../../../packages/browser/bridge-browser/tests/support/bridge-client.ts'
import { browserName, extensionOrigin, pairWithBridge, type PairingResult } from '../src/background/pairing.ts'
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

/** A real bridge whose pairing requests the spec answers, and a clock it moves. */
async function startBridge() {
  let at = 5_000_000
  const requests = new PairingRequests(() => at)
  const onPaired = vi.fn()
  const started = await startTestBridge({ pairing: requests, onPaired })
  return { ...started, requests, onPaired, advance: (ms: number) => { at += ms } }
}

/**
 * Run the extension's pairing client the way a browser would: its sockets
 * carry `origin`. Resolves `shown` with the code the panel would display.
 */
function askAs(origin: string | undefined, url: string, options: { believed?: string; name?: string; signal?: AbortSignal } = {}) {
  vi.stubGlobal('WebSocket', webSocketWithOrigin(origin))
  let show!: (code: string) => void
  const shown = new Promise<string>((resolve) => { show = resolve })
  const result = pairWithBridge(url, {
    origin: options.believed ?? origin ?? '',
    name: options.name ?? 'Brave',
    onCode: show,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return { shown, result }
}

describe('pairing against a real bridge', () => {
  it('shows the code the host shows, and pairs once the user approves it there', async () => {
    const h = await startBridge()
    const asking = askAs(STORE_ORIGIN, h.url)
    const code = await asking.shown
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/u)
    // "Brave wants to connect, code …" on the host: the same code.
    await waitFor(() => h.requests.list().length === 1)
    const [prompt] = h.requests.list()
    expect(prompt).toMatchObject({ origin: STORE_ORIGIN, name: 'Brave' })
    expect(formatPairingCode(prompt!.code)).toBe(code)

    h.requests.approve(prompt!.id)
    const result = await asking.result
    expect(result).toEqual({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    const client = await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN, token: (result as { token: string }).token })
    expect(client.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
  })

  it('learns no token from a denied or an unanswered request', async () => {
    const h = await startBridge()
    const denied = askAs(STORE_ORIGIN, h.url)
    await denied.shown
    await waitFor(() => h.requests.list().length === 1)
    h.requests.deny(h.requests.list()[0]!.id)
    expect(await denied.result).toEqual({ ok: false, reason: 'denied' })

    const ignored = askAs(STORE_ORIGIN, h.url)
    await ignored.shown
    await waitFor(() => h.requests.list().length === 1)
    h.advance(PAIRING_REQUEST_TTL_MS)
    // The bridge's own clock ran out; reading the queue settles the expiry.
    expect(h.requests.list()).toEqual([])
    expect(await ignored.result).toEqual({ ok: false, reason: 'expired' })
    expect(h.onPaired).not.toHaveBeenCalled()
    // Neither is allowed afterwards.
    const hello = await openSocket(h.url, STORE_ORIGIN)
    await sendHello(hello.ws, TEST_TOKEN, TEST_CAPS)
    expect((await hello.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('is approved at most once: a replayed approval, by id or by code, pairs nobody', async () => {
    const h = await startBridge()
    const first = askAs(STORE_ORIGIN, h.url)
    const code = await first.shown
    await waitFor(() => h.requests.list().length === 1)
    const [prompt] = h.requests.list()
    expect(h.requests.approveCode('ZZZ-ZZZ')).toBe('none')
    expect(h.requests.approveCode(code)).toBe('approved')
    expect((await first.result).ok).toBe(true)

    const second = askAs(OTHER_ORIGIN, h.url)
    const otherCode = await second.shown
    await waitFor(() => h.requests.list().length === 1)
    expect(otherCode).not.toBe(code)
    expect(h.requests.approve(prompt!.id)).toBe(false)
    expect(h.requests.approveCode(code)).toBe('none')
    h.requests.denyAll()
    expect(await second.result).toEqual({ ok: false, reason: 'denied' })
    expect(h.onPaired).toHaveBeenCalledTimes(1)
  })

  it('is turned away while the host already has its fill of waiting requests', async () => {
    const h = await startBridge()
    const flood = []
    for (let index = 0; index < MAX_PENDING_PAIRINGS; index += 1) {
      const one = askAs(OTHER_ORIGIN, h.url)
      await one.shown
      flood.push(one)
    }
    const real = askAs(STORE_ORIGIN, h.url)
    expect(await real.result).toEqual({ ok: false, reason: 'busy' })
    h.requests.denyAll()
    for (const one of flood) expect(await one.result).toEqual({ ok: false, reason: 'denied' })
    // With the queue cleared the real extension gets its prompt.
    const again = askAs(STORE_ORIGIN, h.url)
    await again.shown
    await waitFor(() => h.requests.list().length === 1)
    h.requests.approve(h.requests.list()[0]!.id)
    expect((await again.result).ok).toBe(true)
  })

  it('does not complete through another extension: the code is bound to the origin that asks', async () => {
    const h = await startBridge()
    // Another extension carries this extension's exchange on its own socket
    // while this code believes it is the store build: the bridge sees the
    // other Origin and refuses the request outright.
    const relayed = askAs(OTHER_ORIGIN, h.url, { believed: STORE_ORIGIN })
    expect(await relayed.result).toEqual({ ok: false, reason: 'untrusted' })
    expect(h.requests.list()).toEqual([])
    expect(h.onPaired).not.toHaveBeenCalled()
  })

  it('withdraws its request from the host when the panel cancels', async () => {
    const h = await startBridge()
    const controller = new AbortController()
    const asking = askAs(STORE_ORIGIN, h.url, { signal: controller.signal })
    await asking.shown
    await waitFor(() => h.requests.list().length === 1)
    const [prompt] = h.requests.list()
    controller.abort()
    expect(await asking.result).toEqual({ ok: false, reason: 'cancelled' })
    await waitFor(() => h.requests.list().length === 0)
    expect(h.requests.approve(prompt!.id)).toBe(false)
  })

  it('leaves a connected, already-paired extension untouched while another one pairs', async () => {
    const h = await startBridge()
    const pinned = await connectClient(h.url, TEST_CAPS, { origin: `chrome-extension://${PINNED_CHROME_EXTENSION_ID}` })
    const asking = askAs(STORE_ORIGIN, h.url)
    await asking.shown
    await waitFor(() => h.requests.list().length === 1)
    h.requests.approve(h.requests.list()[0]!.id)
    expect((await asking.result).ok).toBe(true)
    expect(h.bridge.connectionCount()).toBe(1)
    expect((await pinned.rpc('session.list', {})).ok).toBe(true)
  })

  it('reports a bridge that does not pair', async () => {
    const plain = await startTestBridge()
    expect(await askAs(STORE_ORIGIN, plain.url).result).toEqual({ ok: false, reason: 'unsupported' })
  })
})

type Sent = { t?: string; nonce: string; commit: string; share: string; opening: string; origin: string; name: string }
const sentFrame = (socket: FakeWebSocket, t: string): Promise<Sent> => vi.waitFor(() => {
  const frame = socket.sent.find(sent => (sent as Sent).t === t)
  expect(frame).toBeDefined()
  return frame as Sent
})

/** Play the bridge half up to the waiting state; returns how to approve with `token`. */
async function playBridge(socket: FakeWebSocket) {
  const serverNonce = createBridgeNonce()
  socket.open()
  socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  const request = await sentFrame(socket, 'pair.request')
  const own = createPairingShare()
  socket.receive({ t: 'pair.share', share: own.share })
  const reveal = await sentFrame(socket, 'pair.reveal')
  expect(verifyPairingCommitment(request.commit, reveal.share, reveal.opening)).toBe(true)
  const context: PairingContext = { serverNonce, clientNonce: request.nonce, endpoint: bridgeEndpointOfUrl(socket.url)!, origin: request.origin, name: request.name }
  const session = derivePairingSession(context, own.secret, reveal.share, own.share, 'server')!
  return { request, session, approve: (token: string) => { socket.receive({ t: 'pair.ok', ...sealPairingToken(session, token) }) } }
}

describe('pairing client', () => {
  const options = (extra: Partial<Parameters<typeof pairWithBridge>[1]> = {}) => ({ origin: '', name: 'Brave', onCode: vi.fn(), ...extra })

  it('commits before it sees the bridge\'s share and accepts the token only from the peer of its exchange', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const settings = options({ name: 'Brave' })
    const paired = pairWithBridge(URL_A, settings)
    const socket = FakeWebSocket.instances[0]!
    const bridge = await playBridge(socket)
    // The request carried a commitment and no share; the share came only after the bridge's.
    expect(bridge.request).not.toHaveProperty('share')
    expect(bridge.request.name).toBe('Brave')
    await vi.waitFor(() => { expect(settings.onCode).toHaveBeenCalledExactlyOnceWith(formatPairingCode(bridge.session.code), expect.any(Number)) })
    // The code is displayed, never sent.
    expect(JSON.stringify(socket.sent)).not.toContain(bridge.session.code)
    bridge.approve('the-real-bridge-token')
    expect(await paired).toEqual({ ok: true, token: 'the-real-bridge-token' })
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('rejects a token that does not come from its own exchange', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // A squatter completes the exchange (so a code is shown, which the host
    // never shows) and then replays a pair.ok recorded from another exchange.
    const victim = pairWithBridge(URL_A, options())
    await playBridge(FakeWebSocket.instances[0]!)
    const elsewhere = pairWithBridge(URL_A, options())
    const other = await playBridge(FakeWebSocket.instances[1]!)
    FakeWebSocket.instances[0]!.receive({ t: 'pair.ok', ...sealPairingToken(other.session, 'attacker-chosen-token') })
    expect(await victim).toEqual({ ok: false, reason: 'untrusted' })
    other.approve('fine')
    expect(await elsewhere).toEqual({ ok: true, token: 'fine' })

    // A degenerate share (1) would fix the key: refused, nothing revealed, no code shown.
    const settings = options()
    const degenerate = pairWithBridge(URL_A, settings)
    const fixed = FakeWebSocket.instances[2]!
    fixed.open()
    fixed.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    await sentFrame(fixed, 'pair.request')
    fixed.receive({ t: 'pair.share', share: '1'.padStart(768, '0') })
    expect(await degenerate).toEqual({ ok: false, reason: 'untrusted' })
    expect(fixed.sent).toHaveLength(1)
    expect(settings.onCode).not.toHaveBeenCalled()
  })

  it('maps what the bridge says to a reason the panel can explain', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const run = async (act: (socket: FakeWebSocket) => void | Promise<void>): Promise<PairingResult> => {
      const before = FakeWebSocket.instances.length
      const result = pairWithBridge(URL_A, options())
      await act(FakeWebSocket.instances[before]!)
      return result
    }
    const requested = async (socket: FakeWebSocket): Promise<void> => {
      socket.open()
      socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
      await sentFrame(socket, 'pair.request')
    }
    expect(await run((socket) => { socket.close(1006) })).toEqual({ ok: false, reason: 'unreachable' })
    // A bridge without pairing refuses an unknown extension at the Origin check; an older one does not know the frame.
    expect(await run((socket) => { socket.open(); socket.close(BRIDGE_CLOSE_CODES.originRejected) })).toEqual({ ok: false, reason: 'unsupported' })
    expect(await run(async (socket) => { await requested(socket); socket.close(1008, 'unparseable frame') })).toEqual({ ok: false, reason: 'unsupported' })
    // Too many requests waiting.
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingClosed) })).toEqual({ ok: false, reason: 'busy' })
    // The request did not describe the socket (something sits in between).
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingFailed) })).toEqual({ ok: false, reason: 'untrusted' })
    // Answers while waiting.
    expect(await run(async (socket) => { await playBridge(socket); socket.close(BRIDGE_CLOSE_CODES.pairingDenied) })).toEqual({ ok: false, reason: 'denied' })
    expect(await run(async (socket) => { await playBridge(socket); socket.close(BRIDGE_CLOSE_CODES.pairingClosed) })).toEqual({ ok: false, reason: 'expired' })
    expect(await run(async (socket) => { await playBridge(socket); socket.close(1006) })).toEqual({ ok: false, reason: 'unreachable' })
    // Another handshake version: a token would not help.
    expect(await run((socket) => {
      socket.open()
      socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION + 1, nonce: createBridgeNonce() })
    })).toEqual({ ok: false, reason: 'version-mismatch' })
    expect(await pairWithBridge('not a url', options())).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('gives up after its time budgets and when cancelled', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // Nothing answers the exchange.
    const silent = pairWithBridge(URL_A, options({ exchangeTimeoutMs: 1_000 }))
    FakeWebSocket.instances[0]!.open()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await silent).toEqual({ ok: false, reason: 'unreachable' })
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    // Nobody answers the prompt.
    const settings = options({ exchangeTimeoutMs: 1_000, answerTimeoutMs: 5_000 })
    const unanswered = pairWithBridge(URL_A, settings)
    const socket = FakeWebSocket.instances[1]!
    socket.open()
    socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    socket.receive({ t: 'pair.share', share: createPairingShare().share })
    expect(settings.onCode).toHaveBeenCalledWith(expect.stringMatching(/^.{3}-.{3}$/u), 5_000)
    // The exchange budget no longer applies once the code is shown.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    await vi.advanceTimersByTimeAsync(1)
    expect(await unanswered).toEqual({ ok: false, reason: 'expired' })

    const controller = new AbortController()
    controller.abort()
    expect(await pairWithBridge(URL_A, options({ signal: controller.signal }))).toEqual({ ok: false, reason: 'cancelled' })
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reads its own origin only when it is an extension origin', () => {
    expect(extensionOrigin()).toBe('')
    expect(extensionOrigin(undefined)).toBe('')
    expect(extensionOrigin({ origin: 'https://example.com' })).toBe('')
    expect(extensionOrigin({ origin: STORE_ORIGIN })).toBe(STORE_ORIGIN)
    expect(extensionOrigin({ origin: 'moz-extension://per-install-uuid' })).toBe('moz-extension://per-install-uuid')
  })

  it('names the browser the way the user knows it', () => {
    const chromium = (brand: string) => ({ userAgentData: { brands: [{ brand: 'Not_A Brand' }, { brand: 'Chromium' }, { brand }] }, userAgent: 'Mozilla/5.0 Chrome/140.0' })
    expect(browserName({ brave: {}, ...chromium('Chromium') })).toBe('Brave')
    expect(browserName(chromium('Brave'))).toBe('Brave')
    expect(browserName(chromium('Google Chrome'))).toBe('Chrome')
    expect(browserName(chromium('Microsoft Edge'))).toBe('Edge')
    expect(browserName(chromium('Chromium'))).toBe('Chromium')
    expect(browserName({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' })).toBe('Firefox')
    expect(browserName({ userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36' })).toBe('Chrome')
    expect(browserName({})).toBe('Browser')
    expect(browserName(undefined)).toBe('Browser')
  })
})
