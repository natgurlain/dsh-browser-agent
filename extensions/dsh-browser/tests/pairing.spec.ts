// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  PAIRING_BROWSER_NAMES,
  PINNED_CHROME_EXTENSION_ID,
  bridgeEndpointOfUrl,
  createBridgeNonce,
} from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import {
  PAIRING_PRIME_HEX,
  createPairingShare,
  derivePairingKeys,
  normalizePairingCode,
  openPairingToken,
  pairingClientConfirmation,
  pairingShareFor,
  sealPairingToken,
  verifyPairingClientConfirmation,
  verifyPairingDone,
  type PairingContext,
} from '@natgurlain/dsh-browser-agent/src/pairing.ts'
import { PAIRING_REQUEST_TTL_MS, PairingDesk } from '@natgurlain/dsh-browser-agent/src/pairing-host.ts'
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

/** A real bridge whose pairing desk the spec operates, and a clock it moves. */
async function startBridge() {
  let at = 5_000_000
  const desk = new PairingDesk(() => at)
  const onPaired = vi.fn()
  const started = await startTestBridge({ pairing: desk, onPaired, pairingStepTimeoutMs: 400 })
  return { ...started, desk, onPaired, advance: (ms: number) => { at += ms } }
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
  it('shows a code, and pairs once the user types that code into DSH', async () => {
    const h = await startBridge()
    const asking = askAs(STORE_ORIGIN, h.url)
    const code = await asking.shown
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/u)
    await waitFor(() => h.desk.status().waiting === 1)
    // The host knows a browser waits and what it says it is; it holds no code.
    expect(h.desk.status()).toMatchObject({ waiting: 1, requests: [{ origin: STORE_ORIGIN, name: 'Brave', official: false }] })

    expect(await h.desk.enter(code.toLowerCase())).toBe('paired')
    const result = await asking.result
    expect(result).toEqual({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    const client = await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN, token: (result as { token: string }).token })
    expect(client.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
  })

  it('learns no token from a wrong code or from no code at all, and its code is spent', async () => {
    const h = await startBridge()
    const mistyped = askAs(STORE_ORIGIN, h.url)
    const code = await mistyped.shown
    await waitFor(() => h.desk.status().waiting === 1)
    const wrong = code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`
    expect(await h.desk.enter(wrong)).toBe('no-match')
    expect(await mistyped.result).toEqual({ ok: false, reason: 'wrong-code' })
    // The right code now finds nobody: one request, one try.
    expect(await h.desk.enter(code)).toBe('none-waiting')

    const ignored = askAs(STORE_ORIGIN, h.url)
    const second = await ignored.shown
    expect(second).not.toBe(code)
    await waitFor(() => h.desk.status().waiting === 1)
    h.advance(PAIRING_REQUEST_TTL_MS)
    expect(await h.desk.enter(second)).toBe('none-waiting')
    expect(await ignored.result).toEqual({ ok: false, reason: 'expired' })
    expect(h.onPaired).not.toHaveBeenCalled()
    // Not allowed afterwards either.
    const hello = await openSocket(h.url, STORE_ORIGIN)
    await sendHello(hello.ws, TEST_TOKEN, TEST_CAPS)
    expect((await hello.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('is the only one paired when another requester waits beside it', async () => {
    const h = await startBridge()
    const attacker = askAs(OTHER_ORIGIN, h.url)
    await attacker.shown
    const genuine = askAs(STORE_ORIGIN, h.url)
    const code = await genuine.shown
    await waitFor(() => h.desk.status().waiting === 2)
    expect(await h.desk.enter(code)).toBe('paired')
    expect((await genuine.result).ok).toBe(true)
    expect(await attacker.result).toEqual({ ok: false, reason: 'wrong-code' })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
  })

  it('does not complete through another extension: the exchange is bound to the origin that asks', async () => {
    const h = await startBridge()
    // Another extension carries this extension's request on its own socket
    // while this code believes it is the store build: the bridge sees the
    // other Origin and refuses the request outright.
    const relayed = askAs(OTHER_ORIGIN, h.url, { believed: STORE_ORIGIN })
    expect(await relayed.result).toEqual({ ok: false, reason: 'untrusted' })
    expect(h.desk.status().waiting).toBe(0)
    expect(h.onPaired).not.toHaveBeenCalled()
  })

  it('reports a paused desk, withdraws its request when cancelled, and reports a bridge that does not pair', async () => {
    const h = await startBridge()
    const controller = new AbortController()
    const asking = askAs(STORE_ORIGIN, h.url, { signal: controller.signal })
    const code = await asking.shown
    await waitFor(() => h.desk.status().waiting === 1)
    controller.abort()
    expect(await asking.result).toEqual({ ok: false, reason: 'cancelled' })
    await waitFor(() => h.desk.status().waiting === 0)
    expect(await h.desk.enter(code)).toBe('none-waiting')

    const waiting = askAs(STORE_ORIGIN, h.url)
    await waiting.shown
    await waitFor(() => h.desk.status().waiting === 1)
    h.desk.pausePairing('user')
    expect(await waiting.result).toEqual({ ok: false, reason: 'paused' })
    expect(await askAs(STORE_ORIGIN, h.url).result).toEqual({ ok: false, reason: 'paused' })

    const plain = await startTestBridge()
    expect(await askAs(STORE_ORIGIN, plain.url).result).toEqual({ ok: false, reason: 'unsupported' })
    expect(await askAs(`chrome-extension://${PINNED_CHROME_EXTENSION_ID}`, plain.url).result).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('leaves a connected, already-paired extension untouched while another one pairs', async () => {
    const h = await startBridge()
    const pinned = await connectClient(h.url, TEST_CAPS, { origin: `chrome-extension://${PINNED_CHROME_EXTENSION_ID}` })
    const asking = askAs(STORE_ORIGIN, h.url)
    const code = await asking.shown
    await waitFor(() => h.desk.status().waiting === 1)
    expect(await h.desk.enter(code)).toBe('paired')
    expect((await asking.result).ok).toBe(true)
    expect(h.bridge.connectionCount()).toBe(1)
    expect((await pinned.rpc('session.list', {})).ok).toBe(true)
  })
})

type Sent = { t?: string; nonce: string; share: string; origin: string; name: string; mac: string }
const sentFrame = (socket: FakeWebSocket, t: string): Promise<Sent> => vi.waitFor(() => {
  const frame = socket.sent.find(sent => (sent as Sent).t === t)
  expect(frame).toBeDefined()
  return frame as Sent
})

/** Open a fake bridge socket: challenge the client and read its request. */
async function openBridge(socket: FakeWebSocket) {
  const serverNonce = createBridgeNonce()
  socket.open()
  socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  return { serverNonce, request: await sentFrame(socket, 'pair.request') }
}

/**
 * Continue as a bridge whose user typed `typed`: send the share and read the
 * client's confirmation.
 * @returns whether the client confirmed, and how to send `pair.ok` with `token`.
 */
async function answerBridge(socket: FakeWebSocket, opened: Awaited<ReturnType<typeof openBridge>>, typed: string, token: string) {
  const { serverNonce, request } = opened
  const context: PairingContext = { code: normalizePairingCode(typed)!, serverNonce, clientNonce: request.nonce, endpoint: bridgeEndpointOfUrl(socket.url)!, origin: request.origin, name: request.name }
  const own = createPairingShare(context)
  const keys = derivePairingKeys(context, own.secret, request.share, own.share, 'server')!
  socket.receive({ t: 'pair.share', share: own.share })
  const confirm = await sentFrame(socket, 'pair.confirm')
  const confirmed = verifyPairingClientConfirmation(keys, confirm.mac)
  return { request, keys, confirmed, sendOk: () => { socket.receive({ t: 'pair.ok', ...sealPairingToken(keys, token) }) } }
}

/** A bridge that types `typed` without ever having been shown the client's code. */
const playBridge = async (socket: FakeWebSocket, typed: string, token: string) => answerBridge(socket, await openBridge(socket), typed, token)

describe('pairing client', () => {
  const options = (extra: Partial<Omit<Parameters<typeof pairWithBridge>[1], 'onCode'>> = {}) => ({ origin: STORE_ORIGIN, name: 'Brave', onCode: vi.fn<(code: string, answerTimeoutMs: number) => void>(), ...extra })
  const shownCode = (settings: ReturnType<typeof options>): string => settings.onCode.mock.calls[0]![0]

  it('sends a request that says nothing about its code, and accepts the token only from a peer that was given it', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const settings = options()
    const paired = pairWithBridge(URL_A, settings)
    const socket = FakeWebSocket.instances[0]!
    const opened = await openBridge(socket)
    expect(Object.keys(opened.request).sort()).toEqual(['endpoint', 'name', 'nonce', 'origin', 'share', 't', 'v'])
    expect(settings.onCode).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/u), expect.any(Number))
    const code = shownCode(settings)
    // Nothing more is sent until the bridge answers: no MAC, nothing keyed.
    expect(socket.sent).toHaveLength(1)
    expect(JSON.stringify(socket.sent)).not.toContain(normalizePairingCode(code))

    // The user types the code into DSH; this bridge now holds it.
    const bridge = await answerBridge(socket, opened, code, 'the-real-bridge-token')
    expect(bridge.confirmed).toBe(true)
    bridge.sendOk()
    expect(await paired).toEqual({ ok: true, token: 'the-real-bridge-token' })
    // It acknowledged the token under the exchange key.
    expect(verifyPairingDone(bridge.keys, (await sentFrame(socket, 'pair.done')).mac)).toBe(true)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)

    // A fresh code per request.
    const next = options()
    void pairWithBridge(URL_A, next)
    await openBridge(FakeWebSocket.instances[1]!)
    expect(shownCode(next)).not.toBe(code)
    FakeWebSocket.instances[1]!.close(1006)
  })

  it('regression (review PoC): a squatter that answers without the code makes the extension store nothing', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // The squatter plays bridge with a guess, and sends pair.ok sealing a token of its own choosing.
    const guessed = pairWithBridge(URL_A, options())
    const squatter = await playBridge(FakeWebSocket.instances[0]!, 'ZZZ-ZZZ', 'attacker-chosen-token-0123456789abcdef')
    expect(squatter.confirmed).toBe(false)
    squatter.sendOk()
    expect(await guessed).toEqual({ ok: false, reason: 'untrusted' })
    expect(FakeWebSocket.instances[0]!.sent.some(sent => (sent as Sent).t === 'pair.done')).toBe(false)

    // pair.ok at once, before any share (the 537e9ef PoC's shortcut): ignored, then timed out; never accepted.
    vi.useFakeTimers()
    const immediate = pairWithBridge(URL_A, options({ answerTimeoutMs: 2_000 }))
    const eager = FakeWebSocket.instances[1]!
    eager.open()
    eager.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    eager.receive({ t: 'pair.ok', box: 'abcd', mac: 'a'.repeat(64) })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await immediate).toEqual({ ok: false, reason: 'expired' })
    vi.useRealTimers()

    // One that reflects the client's own share and confirmation back gets no further.
    const reflected = pairWithBridge(URL_A, options())
    const mirror = FakeWebSocket.instances[2]!
    mirror.open()
    mirror.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    const request = await sentFrame(mirror, 'pair.request')
    mirror.receive({ t: 'pair.share', share: request.share })
    const confirm = await sentFrame(mirror, 'pair.confirm')
    mirror.receive({ t: 'pair.ok', box: 'abcd', mac: confirm.mac })
    expect(await reflected).toEqual({ ok: false, reason: 'untrusted' })

    // Shares outside the prime-order subgroup (the identity, a non-residue) are refused before anything keyed is sent.
    const p = BigInt(`0x${PAIRING_PRIME_HEX}`)
    for (const share of [1n, p - 4n]) {
      const before = FakeWebSocket.instances.length
      const degenerate = pairWithBridge(URL_A, options())
      const fixed = FakeWebSocket.instances[before]!
      await openBridge(fixed)
      fixed.receive({ t: 'pair.share', share: share.toString(16).padStart(768, '0') })
      expect(await degenerate).toEqual({ ok: false, reason: 'untrusted' })
      expect(fixed.sent).toHaveLength(1)
    }
  })

  it('gives a wrong peer one test of one code and nothing else', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const settings = options()
    const run = pairWithBridge(URL_A, settings)
    const socket = FakeWebSocket.instances[0]!
    const squatter = await playBridge(socket, 'ZZZ-ZZZ', 'x'.repeat(40))
    // What the squatter holds after the run: the client's share and one confirmation MAC.
    expect(socket.sent.map(sent => (sent as Sent).t)).toEqual(['pair.request', 'pair.confirm'])
    // The MAC is keyed by the squatter's own generator raised to the client's secret: it verifies
    // only for the one code the squatter committed to, which was not the client's.
    expect(squatter.confirmed).toBe(false)
    const real = normalizePairingCode(shownCode(settings))!
    expect(real).not.toBe('ZZZZZZ')
    socket.close(BRIDGE_CLOSE_CODES.pairingFailed)
    expect(await run).toEqual({ ok: false, reason: 'wrong-code' })
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
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingClosed, 'this bridge does not pair') })).toEqual({ ok: false, reason: 'unsupported' })
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingClosed, 'too many pairing requests; try again in a minute') })).toEqual({ ok: false, reason: 'busy' })
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingClosed, 'the pairing request expired') })).toEqual({ ok: false, reason: 'expired' })
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingPaused) })).toEqual({ ok: false, reason: 'paused' })
    // Pushed out of the bridge's queue by another request.
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingReplaced) })).toEqual({ ok: false, reason: 'replaced' })
    // The request did not describe the socket (something sits in between).
    expect(await run(async (socket) => { await requested(socket); socket.close(BRIDGE_CLOSE_CODES.pairingFailed) })).toEqual({ ok: false, reason: 'untrusted' })
    expect(await run(async (socket) => { await requested(socket); socket.close(1006) })).toEqual({ ok: false, reason: 'unreachable' })
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
    // Nothing answers.
    const silent = pairWithBridge(URL_A, options({ exchangeTimeoutMs: 1_000 }))
    FakeWebSocket.instances[0]!.open()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await silent).toEqual({ ok: false, reason: 'unreachable' })
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    // Nobody enters the code: the waiting budget applies, not the exchange budget.
    const settings = options({ exchangeTimeoutMs: 1_000, answerTimeoutMs: 5_000 })
    const unanswered = pairWithBridge(URL_A, settings)
    const socket = FakeWebSocket.instances[1]!
    socket.open()
    socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
    expect(settings.onCode).toHaveBeenCalledWith(expect.stringMatching(/^.{3}-.{3}$/u), 5_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    await vi.advanceTimersByTimeAsync(1)
    expect(await unanswered).toEqual({ ok: false, reason: 'expired' })

    // A peer that takes the confirmation and goes silent.
    const stalled = pairWithBridge(URL_A, options({ exchangeTimeoutMs: 1_000, answerTimeoutMs: 5_000 }))
    const quiet = FakeWebSocket.instances[2]!
    quiet.open()
    const nonce = createBridgeNonce()
    quiet.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce })
    const request = quiet.sent[0] as Sent
    const context: PairingContext = { code: 'ZZZZZZ', serverNonce: nonce, clientNonce: request.nonce, endpoint: bridgeEndpointOfUrl(URL_A)!, origin: STORE_ORIGIN, name: 'Brave' }
    quiet.receive({ t: 'pair.share', share: createPairingShare(context).share })
    expect(quiet.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await stalled).toEqual({ ok: false, reason: 'untrusted' })

    const controller = new AbortController()
    controller.abort()
    expect(await pairWithBridge(URL_A, options({ signal: controller.signal }))).toEqual({ ok: false, reason: 'cancelled' })
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('derives the same bytes as the bridge suite for the fixed vector (one implementation, two runtimes)', () => {
    const context: PairingContext = {
      code: 'ABCDEF', serverNonce: 'a'.repeat(64), clientNonce: 'b'.repeat(64),
      endpoint: { host: '127.0.0.1', port: 3080 }, origin: STORE_ORIGIN, name: 'Brave',
    }
    const a = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn
    const b = 0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321n
    const clientShare = pairingShareFor(context, a)
    const serverShare = pairingShareFor(context, b)
    const client = derivePairingKeys(context, a, clientShare, serverShare, 'client')!
    const server = derivePairingKeys(context, b, clientShare, serverShare, 'server')!
    // The constant the bridge suite checks against an independent node-crypto derivation.
    expect(pairingClientConfirmation(client)).toBe('cce5bb508133bd5b892ca32c9ea16a8bbd8ca80ac28fd7b1183b6fda888efc42')
    expect(verifyPairingClientConfirmation(server, pairingClientConfirmation(client))).toBe(true)
    // The bridge's pair.ok for the same vector: the encrypted token and its confirmation.
    const token = 'vector-bridge-token-0123456789abcdef0123456789abcdef'
    expect(sealPairingToken(server, token)).toEqual({
      box: '3b40cda4453c5c14915391de5c777cfe741e0d49633b979855ab0e61ec5a093bd4b6f7618e77fbcfac805e954b9a22a5a7b21456',
      mac: 'f4559ead079fe6aaf2fcd9b5dc5bebf3b787924f69a69c2210461a10ceae547f',
    })
    expect(openPairingToken(client, '3b40cda4453c5c14915391de5c777cfe741e0d49633b979855ab0e61ec5a093bd4b6f7618e77fbcfac805e954b9a22a5a7b21456',
      'f4559ead079fe6aaf2fcd9b5dc5bebf3b787924f69a69c2210461a10ceae547f')).toBe(token)
    // Another code: another key.
    const other = { ...context, code: 'ABCDEG' }
    const wrong = derivePairingKeys(other, a, pairingShareFor(other, a), serverShare, 'client')!
    expect(verifyPairingClientConfirmation(server, pairingClientConfirmation(wrong))).toBe(false)
  })

  it('reads its own origin only when it is an extension origin', () => {
    expect(extensionOrigin()).toBe('')
    expect(extensionOrigin(undefined)).toBe('')
    expect(extensionOrigin({ origin: 'https://example.com' })).toBe('')
    expect(extensionOrigin({ origin: STORE_ORIGIN })).toBe(STORE_ORIGIN)
    expect(extensionOrigin({ origin: 'moz-extension://0f8fad5b-d9cb-469f-a165-70867728950e' })).toBe('moz-extension://0f8fad5b-d9cb-469f-a165-70867728950e')
  })

  it('names the browser with one of the names the bridge accepts', () => {
    const chromium = (brand: string) => ({ userAgentData: { brands: [{ brand: 'Not_A Brand' }, { brand: 'Chromium' }, { brand }] }, userAgent: 'Mozilla/5.0 Chrome/140.0' })
    const names = [
      browserName({ brave: {}, ...chromium('Chromium') }), browserName(chromium('Brave')), browserName(chromium('Google Chrome')),
      browserName(chromium('Microsoft Edge')), browserName(chromium('Chromium')), browserName(chromium('Opera')), browserName(chromium('Vivaldi')),
      browserName({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }),
      browserName({ userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36' }), browserName({}), browserName(undefined),
    ]
    expect(names).toEqual(['Brave', 'Brave', 'Chrome', 'Edge', 'Chromium', 'Opera', 'Vivaldi', 'Firefox', 'Chrome', 'Browser', 'Browser'])
    for (const name of names) expect(PAIRING_BROWSER_NAMES).toContain(name)
  })
})
