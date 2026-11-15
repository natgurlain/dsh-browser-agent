import { getDiffieHellman } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  BRIDGE_CLOSE_CODES,
  PAIRING_PROTOCOL_VERSION,
  PINNED_CHROME_EXTENSION_ID,
  createBridgeNonce,
  isPairingName,
  parseBridgeFrame,
  type BridgeFrame,
} from '../src/protocol.ts'
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_PRIME_HEX,
  createPairingOpening,
  createPairingShare,
  derivePairingSession,
  formatPairingCode,
  isPairingShare,
  normalizePairingCode,
  openPairingToken,
  pairingCommitment,
  sealPairingToken,
  verifyPairingCommitment,
  type PairingContext,
  type PairingSession,
} from '../src/pairing.ts'
import {
  MAX_PAIRED_EXTENSION_IDS,
  MAX_PAIRING_REQUESTS_PER_MINUTE,
  MAX_PENDING_PAIRINGS,
  PAIRING_REQUEST_TTL_MS,
  PairingRequests,
  chromeExtensionIdOfOrigin,
  isPairableOrigin,
  readPairedExtensionIds,
  writePairedExtensionIds,
  type PairingDecision,
} from '../src/pairing-host.ts'
import {
  PAIRING_API_PATH,
  PAIRING_COMMAND_NAME,
  handlePairingControl,
  mountPairingControls,
  runPairingCommand,
} from '../src/pairing-mount.ts'
import {
  TEST_CAPS,
  TEST_TOKEN,
  closeTestBridges,
  connectClient,
  endpointOf,
  openSocket,
  sendHello,
  startTestBridge,
  waitFor,
  type TestSocket,
} from './support/bridge-client.ts'
import { tempDirs } from './support/tmp.ts'

const PINNED_ORIGIN = `chrome-extension://${PINNED_CHROME_EXTENSION_ID}`
/** A store build: a real Chrome extension the bridge has never heard of. */
const STORE_ID = 'abcdefghijklmnopabcdefghijklmnop'
const STORE_ORIGIN = `chrome-extension://${STORE_ID}`
/** Some other extension installed in the same browser. */
const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const OTHER_ORIGIN = `chrome-extension://${OTHER_ID}`

const CONTEXT: PairingContext = {
  serverNonce: 'a'.repeat(64),
  clientNonce: 'b'.repeat(64),
  endpoint: { host: '127.0.0.1', port: 3080 },
  origin: STORE_ORIGIN,
  name: 'Brave',
}

const newDir = tempDirs('dsh-pairing-')

afterEach(closeTestBridges)

/** A clock the spec moves by hand. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms) => { at += ms } }
}

async function challengeOf(socket: TestSocket): Promise<string> {
  await waitFor(() => socket.frames.some(frame => frame.t === 'challenge') || socket.ws.readyState !== WebSocket.OPEN)
  const challenge = socket.frames.find(frame => frame.t === 'challenge') as Extract<BridgeFrame, { t: 'challenge' }> | undefined
  if (challenge === undefined) throw new Error('the bridge closed before its challenge')
  return challenge.nonce
}

type Outcome =
  | { ok: true; token: string; frames: BridgeFrame[] }
  | { ok: false; code: number; reason: string; frames: BridgeFrame[] }

/** A pairing request as the extension runs it: the code it shows, and how it ends. */
interface Asking {
  /** The code this client displays; undefined when the bridge refused before one existed. */
  code: string | undefined
  outcome: Promise<Outcome>
  socket: TestSocket | undefined
}

/**
 * Run the client half of a pairing exchange up to the point where the
 * extension shows its code.
 * @param options.origin - Origin header the socket presents (a browser sets it; a local process can forge it).
 * @param options.as - the origin this client believes it is (defaults to `origin`); differs for a relay.
 * @param options.claim - the origin written into `pair.request` (defaults to `as`).
 */
async function ask(url: string, options: { origin?: string; as?: string; claim?: string; name?: string } = {}): Promise<Asking> {
  const socket = await openSocket(url, options.origin)
  const refused = (): Asking => ({
    code: undefined,
    socket,
    outcome: socket.closed.then(closed => ({ ok: false as const, ...closed, frames: socket.frames })),
  })
  const serverNonce = await challengeOf(socket).catch(() => undefined)
  // Refused before the challenge (the Origin check).
  if (serverNonce === undefined) return refused()
  const origin = options.as ?? options.origin ?? ''
  const context: PairingContext = { serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(socket.ws), origin, name: options.name ?? 'Brave' }
  const own = createPairingShare()
  const opening = createPairingOpening()
  socket.ws.send(JSON.stringify({
    t: 'pair.request', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint: context.endpoint,
    origin: options.claim ?? origin, name: context.name, commit: pairingCommitment(own.share, opening),
  }))
  await waitFor(() => socket.frames.some(frame => frame.t === 'pair.share') || socket.ws.readyState !== WebSocket.OPEN)
  const share = socket.frames.find(frame => frame.t === 'pair.share') as Extract<BridgeFrame, { t: 'pair.share' }> | undefined
  if (share === undefined) return refused()
  const session = derivePairingSession(context, own.secret, own.share, share.share, 'client')!
  socket.ws.send(JSON.stringify({ t: 'pair.reveal', share: own.share, opening }))
  return {
    code: session.code,
    socket,
    outcome: socket.closed.then((closed) => {
      const ok = socket.frames.find(frame => frame.t === 'pair.ok') as Extract<BridgeFrame, { t: 'pair.ok' }> | undefined
      const token = ok === undefined ? undefined : openPairingToken(session, ok.box, ok.mac)
      return token === undefined ? { ok: false as const, ...closed, frames: socket.frames } : { ok: true as const, token, frames: socket.frames }
    }),
  }
}

describe('pairing exchange (pairing.ts)', () => {
  it('uses the RFC 3526 3072-bit group', () => {
    expect(PAIRING_PRIME_HEX).toBe(getDiffieHellman('modp15').getPrime().toString('hex'))
  })

  it('formats and normalizes codes', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32)
    expect(formatPairingCode('ABCDEF')).toBe('ABC-DEF')
    expect(normalizePairingCode(' abc-def ')).toBe('ABCDEF')
    expect(normalizePairingCode('ABC DE')).toBeUndefined()
    // Look-alikes are not code symbols and are never guessed.
    expect(normalizePairingCode('ABC-DE0')).toBeUndefined()
    expect(normalizePairingCode('ABC-DE1')).toBeUndefined()
  })

  function exchange(clientContext: PairingContext = CONTEXT, serverContext: PairingContext = CONTEXT): { client: PairingSession; server: PairingSession } {
    const client = createPairingShare()
    const server = createPairingShare()
    return {
      client: derivePairingSession(clientContext, client.secret, client.share, server.share, 'client')!,
      server: derivePairingSession(serverContext, server.secret, client.share, server.share, 'server')!,
    }
  }

  it('gives both halves the same code and carries the token only to the peer of the exchange', () => {
    const { client, server } = exchange()
    expect(client.code).toBe(server.code)
    expect(client.code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{6}$`, 'u'))
    const sealed = sealPairingToken(server, TEST_TOKEN)
    expect(sealed.box).not.toContain(Buffer.from(TEST_TOKEN).toString('hex'))
    expect(openPairingToken(client, sealed.box, sealed.mac)).toBe(TEST_TOKEN)
    // A flipped ciphertext bit or a foreign MAC is refused, never decrypted.
    const flipped = `${sealed.box.slice(0, -1)}${sealed.box.endsWith('0') ? '1' : '0'}`
    expect(openPairingToken(client, flipped, sealed.mac)).toBeUndefined()
    expect(openPairingToken(client, sealed.box, 'f'.repeat(64))).toBeUndefined()
    // Another exchange cannot read it, whatever it observed.
    expect(openPairingToken(exchange().client, sealed.box, sealed.mac)).toBeUndefined()
    // Fresh shares every run: codes do not repeat.
    expect(new Set(Array.from({ length: 8 }, () => exchange().client.code)).size).toBeGreaterThan(6)
  })

  it.each([
    ['another extension origin', { origin: OTHER_ORIGIN }],
    ['another browser name', { name: 'Chrome' }],
    ['another endpoint', { endpoint: { host: '127.0.0.1', port: 3081 } }],
    ['another server nonce', { serverNonce: 'c'.repeat(64) }],
    ['another client nonce', { clientNonce: 'd'.repeat(64) }],
  ])('shows different codes, and opens no token, when the halves disagree on %s', (_label, difference) => {
    // 30-bit codes: one comparison can collide by luck once in a billion runs.
    const { client, server } = exchange({ ...CONTEXT, ...difference })
    expect(client.code).not.toBe(server.code)
    const sealed = sealPairingToken(server, TEST_TOKEN)
    expect(openPairingToken(client, sealed.box, sealed.mac)).toBeUndefined()
  })

  it('gives someone in the middle two unrelated codes', () => {
    // The attacker runs one exchange with the extension and another with the bridge.
    const extension = createPairingShare()
    const bridge = createPairingShare()
    const towardExtension = createPairingShare()
    const towardBridge = createPairingShare()
    const shown = derivePairingSession(CONTEXT, extension.secret, extension.share, towardExtension.share, 'client')!
    const prompted = derivePairingSession(CONTEXT, bridge.secret, towardBridge.share, bridge.share, 'server')!
    expect(shown.code).not.toBe(prompted.code)
    // Even approved by mistake, the bridge's token is sealed for the attacker's
    // exchange, never for a key the extension holds.
    const sealed = sealPairingToken(prompted, TEST_TOKEN)
    expect(openPairingToken(shown, sealed.box, sealed.mac)).toBeUndefined()
  })

  it('binds the client to its share before it sees the bridge\'s', () => {
    const own = createPairingShare()
    const opening = createPairingOpening()
    const commit = pairingCommitment(own.share, opening)
    expect(verifyPairingCommitment(commit, own.share, opening)).toBe(true)
    // Opening the same commitment to another share, or with another opening, fails.
    expect(verifyPairingCommitment(commit, createPairingShare().share, opening)).toBe(false)
    expect(verifyPairingCommitment(commit, own.share, createPairingOpening())).toBe(false)
    expect(verifyPairingCommitment('nope', own.share, opening)).toBe(false)
    // The commitment says nothing about the share: the same share commits differently every time.
    expect(pairingCommitment(own.share, createPairingOpening())).not.toBe(commit)
  })

  it('refuses shares that would fix the key', () => {
    const p = BigInt(`0x${PAIRING_PRIME_HEX}`)
    const hex = (value: bigint): string => value.toString(16).padStart(768, '0')
    for (const degenerate of [0n, 1n, p - 1n, p]) expect(isPairingShare(hex(degenerate))).toBe(false)
    expect(isPairingShare(hex(2n))).toBe(true)
    expect(isPairingShare('12')).toBe(false)
    const own = createPairingShare()
    expect(derivePairingSession(CONTEXT, own.secret, hex(1n), own.share, 'server')).toBeUndefined()
    expect(derivePairingSession(CONTEXT, own.secret, own.share, hex(p - 1n), 'client')).toBeUndefined()
  })

  it('parses pairing frames strictly', () => {
    const share = createPairingShare().share
    const request = { t: 'pair.request', v: 1, nonce: 'a'.repeat(64), endpoint: CONTEXT.endpoint, origin: STORE_ORIGIN, name: 'Brave', commit: 'c'.repeat(64) }
    expect(parseBridgeFrame(JSON.stringify(request))).toEqual(request)
    expect(parseBridgeFrame(JSON.stringify({ ...request, v: 2 }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ ...request, commit: 'short' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ ...request, origin: 'x'.repeat(300) }))).toBeUndefined()
    // The name is shown on the host's prompt: short plain text only.
    for (const name of ['', '<b>Brave</b>', 'Brave\nApprove me', 'x'.repeat(33), ' Brave', 7]) {
      expect(parseBridgeFrame(JSON.stringify({ ...request, name }))).toBeUndefined()
      expect(isPairingName(name)).toBe(false)
    }
    expect(isPairingName('Microsoft Edge')).toBe(true)
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.reveal', share, opening: 'd'.repeat(64) }))).toEqual({ t: 'pair.reveal', share, opening: 'd'.repeat(64) })
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.reveal', share: share.slice(2), opening: 'd'.repeat(64) }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.share', share }))).toEqual({ t: 'pair.share', share })
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.ok', box: 'abc', mac: 'a'.repeat(64) }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.ok', box: 'ab'.repeat(2000), mac: 'a'.repeat(64) }))).toBeUndefined()
  })
})

describe('pairing requests (pairing-host.ts)', () => {
  const request = (code = 'ABCDEF', origin = STORE_ORIGIN, name = 'Brave') => ({ code, origin, name })

  it('holds a request until the user answers, and an answer works once', () => {
    const time = clock()
    const requests = new PairingRequests(time.now)
    expect(requests.list()).toEqual([])
    const settle = vi.fn<(decision: PairingDecision) => void>()
    const queued = requests.submit(request(), settle)!
    expect(queued.expiresAt).toBe(time.now() + PAIRING_REQUEST_TTL_MS)
    const [pending] = requests.list()
    expect(pending).toEqual({ id: expect.any(String), code: 'ABCDEF', origin: STORE_ORIGIN, name: 'Brave', expiresAt: queued.expiresAt })
    // Nothing happens without an answer.
    expect(settle).not.toHaveBeenCalled()
    expect(requests.lastPaired()).toBeUndefined()

    expect(requests.approve(pending!.id)).toBe(true)
    expect(settle).toHaveBeenCalledExactlyOnceWith('approved')
    expect(requests.lastPaired()).toEqual({ origin: STORE_ORIGIN, name: 'Brave', at: time.now() })
    // Replayed approval, or a late denial: the request is gone.
    expect(requests.approve(pending!.id)).toBe(false)
    expect(requests.deny(pending!.id)).toBe(false)
    expect(requests.approveCode('ABC-DEF')).toBe('none')
    expect(settle).toHaveBeenCalledTimes(1)
    expect(requests.list()).toEqual([])
  })

  it('denies, expires and withdraws requests without ever approving them', () => {
    const time = clock()
    const requests = new PairingRequests(time.now)
    const denied = vi.fn<(decision: PairingDecision) => void>()
    const expired = vi.fn<(decision: PairingDecision) => void>()
    const withdrawn = vi.fn<(decision: PairingDecision) => void>()
    requests.submit(request('AAAAAA'), denied)
    requests.submit(request('BBBBBB'), expired)
    const gone = requests.submit(request('CCCCCC'), withdrawn)!
    expect(requests.deny(requests.list()[0]!.id)).toBe(true)
    expect(denied).toHaveBeenCalledExactlyOnceWith('denied')
    // The browser closed its request: it leaves the prompt and can no longer be approved.
    gone.withdraw()
    expect(requests.approveCode('CCCCCC')).toBe('none')
    expect(withdrawn).not.toHaveBeenCalled()

    const late = requests.list()[0]!
    time.advance(PAIRING_REQUEST_TTL_MS)
    expect(requests.approve(late.id)).toBe(false)
    expect(expired).toHaveBeenCalledExactlyOnceWith('expired')
    expect(requests.list()).toEqual([])
    expect(requests.lastPaired()).toBeUndefined()
  })

  it('approves by code only when exactly one waiting request shows it', () => {
    const requests = new PairingRequests(clock().now)
    const first = vi.fn<(decision: PairingDecision) => void>()
    const second = vi.fn<(decision: PairingDecision) => void>()
    requests.submit(request('ABCDEF'), first)
    requests.submit(request('ABCDEF', OTHER_ORIGIN, 'Chrome'), second)
    expect(requests.approveCode('ZZZZZZ')).toBe('none')
    expect(requests.approveCode('not a code')).toBe('none')
    expect(requests.approveCode('abc-def')).toBe('ambiguous')
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    requests.deny(requests.list()[1]!.id)
    expect(requests.approveCode('abc def')).toBe('approved')
    expect(first).toHaveBeenCalledExactlyOnceWith('approved')
  })

  it('bounds what unauthenticated requesters can make it hold', () => {
    const time = clock()
    const requests = new PairingRequests(time.now)
    const settles = Array.from({ length: MAX_PENDING_PAIRINGS }, () => vi.fn<(decision: PairingDecision) => void>())
    for (const settle of settles) {
      expect(requests.admit()).toBe(true)
      expect(requests.submit(request(), settle)).toBeDefined()
    }
    // Full: no further exchange is started, and none can be queued.
    expect(requests.admit()).toBe(false)
    expect(requests.submit(request(), vi.fn())).toBeUndefined()
    requests.denyAll()
    for (const settle of settles) expect(settle).toHaveBeenCalledExactlyOnceWith('denied')

    // Rate: a requester that never queues anything still runs out of exchanges.
    for (let index = MAX_PENDING_PAIRINGS; index < MAX_PAIRING_REQUESTS_PER_MINUTE; index += 1) expect(requests.admit()).toBe(true)
    expect(requests.admit()).toBe(false)
    time.advance(59_999)
    expect(requests.admit()).toBe(false)
    time.advance(1)
    expect(requests.admit()).toBe(true)
  })

  it('classifies origins that may ask', () => {
    expect(isPairableOrigin(undefined)).toBe(true)
    expect(isPairableOrigin('')).toBe(true)
    expect(isPairableOrigin(STORE_ORIGIN)).toBe(true)
    expect(isPairableOrigin('moz-extension://per-install-uuid')).toBe(true)
    expect(isPairableOrigin('https://evil.example')).toBe(false)
    expect(isPairableOrigin('http://127.0.0.1:3080')).toBe(false)
    expect(isPairableOrigin('chrome-extension://short')).toBe(false)
    expect(chromeExtensionIdOfOrigin(STORE_ORIGIN)).toBe(STORE_ID)
    expect(chromeExtensionIdOfOrigin('moz-extension://x')).toBeUndefined()
  })

  it('persists paired extension IDs privately and ignores junk', async () => {
    const file = join(newDir(), 'paired.json')
    expect(await readPairedExtensionIds(file)).toEqual([])
    await writePairedExtensionIds(file, [STORE_ID, 'not-an-id', STORE_ID, OTHER_ID])
    expect(await readPairedExtensionIds(file)).toEqual([STORE_ID, OTHER_ID])
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, chromeExtensionIds: [STORE_ID, OTHER_ID] })
    await writeFile(file, '{"chromeExtensionIds":"nope"}')
    expect(await readPairedExtensionIds(file)).toEqual([])
    await writeFile(file, 'not json')
    expect(await readPairedExtensionIds(file)).toEqual([])
    const many = Array.from({ length: MAX_PAIRED_EXTENSION_IDS + 3 }, (_, index) => `${'a'.repeat(30)}${String.fromCharCode(97 + (index >> 4))}${String.fromCharCode(97 + (index & 15))}`)
    await writePairedExtensionIds(file, many)
    expect(await readPairedExtensionIds(file)).toEqual(many.slice(-MAX_PAIRED_EXTENSION_IDS))
  })
})

describe('pairing on the bridge socket (server.ts)', () => {
  async function startPairingBridge(overrides: Partial<Parameters<typeof startTestBridge>[0]> = {}) {
    const time = clock()
    const requests = new PairingRequests(time.now)
    const onPaired = vi.fn()
    const started = await startTestBridge({ pairing: requests, onPaired, ...overrides })
    /** The request the host shows, once the bridge has queued `count` of them. */
    const prompts = async (count = 1) => {
      await waitFor(() => requests.list().length >= count)
      return requests.list()
    }
    return { ...started, requests, onPaired, time, prompts }
  }

  it('pairs a store-installed extension once the user approves the code both sides show', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN, name: 'Brave' })
    const [prompt] = await h.prompts()
    // "Brave wants to connect, code …": the same code the extension shows.
    expect(prompt).toMatchObject({ code: asking.code, origin: STORE_ORIGIN, name: 'Brave' })
    // Until the user answers: no token, no allowlist entry, no connection.
    expect(asking.socket!.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).not.toHaveBeenCalled()
    const early = await openSocket(h.url, STORE_ORIGIN)
    await sendHello(early.ws, TEST_TOKEN, TEST_CAPS)
    expect((await early.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)

    expect(h.requests.approve(prompt!.id)).toBe(true)
    expect(await asking.outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    expect(h.requests.list()).toEqual([])

    // The paired build now authenticates with the ordinary handshake.
    const client = await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
    expect(client.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
    expect(h.bridge.connectionCount()).toBe(1)
  })

  it('never puts the token or the code on the wire, and a recorded run is not reusable', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    h.requests.approve((await h.prompts())[0]!.id)
    const outcome = await asking.outcome
    expect(outcome.ok).toBe(true)
    const wire = JSON.stringify(outcome.frames)
    expect(wire).not.toContain(TEST_TOKEN)
    expect(wire).not.toContain(Buffer.from(TEST_TOKEN).toString('hex'))
    expect(wire).not.toContain(asking.code)
    // An eavesdropper replays the bridge's recorded frames at a fresh client:
    // without the bridge's secret there is no key that opens the recorded box.
    const recorded = outcome.frames.find(frame => frame.t === 'pair.ok') as Extract<BridgeFrame, { t: 'pair.ok' }>
    const recordedShare = outcome.frames.find(frame => frame.t === 'pair.share') as Extract<BridgeFrame, { t: 'pair.share' }>
    const victim = createPairingShare()
    const session = derivePairingSession(CONTEXT, victim.secret, victim.share, recordedShare.share, 'client')!
    expect(openPairingToken(session, recorded.box, recorded.mac)).toBeUndefined()
  })

  it('gives nothing to a request the user denies', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    expect(h.requests.deny((await h.prompts())[0]!.id)).toBe(true)
    const outcome = await asking.outcome
    expect(outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingDenied })
    expect(outcome.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).not.toHaveBeenCalled()
    // Denied means not allowed: the ordinary handshake still refuses it.
    const hello = await openSocket(h.url, STORE_ORIGIN)
    await sendHello(hello.ws, TEST_TOKEN, TEST_CAPS)
    expect((await hello.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('approves by typed code only for the code a waiting request shows (wrong and replayed codes do nothing)', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.prompts()
    const wrong = asking.code!.startsWith('A') ? `B${asking.code!.slice(1)}` : `A${asking.code!.slice(1)}`
    expect(h.requests.approveCode(wrong)).toBe('none')
    expect(asking.socket!.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).not.toHaveBeenCalled()

    expect(h.requests.approveCode(formatPairingCode(asking.code!).toLowerCase())).toBe('approved')
    expect((await asking.outcome).ok).toBe(true)
    // The same code again approves nobody: not the paired extension, not a newcomer.
    const newcomer = await ask(h.url, { origin: OTHER_ORIGIN })
    await h.prompts()
    expect(h.requests.approveCode(asking.code!)).toBe('none')
    expect(newcomer.socket!.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).toHaveBeenCalledTimes(1)
  })

  it('expires a request nobody answered', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    const [prompt] = await h.prompts()
    h.time.advance(PAIRING_REQUEST_TTL_MS)
    // Too late: the approval finds nothing, and the requester is told it expired.
    expect(h.requests.approve(prompt!.id)).toBe(false)
    expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed, reason: 'the pairing request expired' })
    expect(h.onPaired).not.toHaveBeenCalled()
  })

  it('removes a request from the prompt when its browser goes away', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    const [prompt] = await h.prompts()
    asking.socket!.ws.terminate()
    await waitFor(() => h.requests.list().length === 0)
    expect(h.requests.approve(prompt!.id)).toBe(false)
    expect(h.onPaired).not.toHaveBeenCalled()
  })

  it('caps waiting requests and the rate of exchanges', async () => {
    const h = await startPairingBridge()
    const waiting = []
    for (let index = 0; index < MAX_PENDING_PAIRINGS; index += 1) waiting.push(await ask(h.url, { origin: OTHER_ORIGIN }))
    await h.prompts(MAX_PENDING_PAIRINGS)
    // A fifth requester is turned away before the bridge computes anything for it.
    const extra = await ask(h.url, { origin: STORE_ORIGIN })
    expect(extra.code).toBeUndefined()
    expect(await extra.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(h.requests.list()).toHaveLength(MAX_PENDING_PAIRINGS)
    // The user clears them; the flood has also used up most of this minute's exchanges.
    h.requests.denyAll()
    for (const asking of waiting) expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingDenied })
    for (let index = MAX_PENDING_PAIRINGS; index < MAX_PAIRING_REQUESTS_PER_MINUTE; index += 1) {
      const abandoned = await ask(h.url)
      abandoned.socket!.ws.terminate()
      await waitFor(() => h.requests.list().length === 0)
    }
    expect(await (await ask(h.url, { origin: STORE_ORIGIN })).outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    h.time.advance(60_000)
    const later = await ask(h.url, { origin: STORE_ORIGIN })
    h.requests.approve((await h.prompts())[0]!.id)
    expect((await later.outcome).ok).toBe(true)
  })

  it('does not let a second extension ride on a pairing meant for another', async () => {
    const h = await startPairingBridge()
    // The other extension relays the real one's exchange over its own socket.
    // Claiming the real origin contradicts the socket's Origin header...
    const forged = await ask(h.url, { origin: OTHER_ORIGIN, as: STORE_ORIGIN })
    expect(await forged.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(h.requests.list()).toEqual([])
    // ...and claiming its own makes the host show another code, under the
    // other extension's identity, than the one the real extension displays.
    const relayed = await ask(h.url, { origin: OTHER_ORIGIN, as: STORE_ORIGIN, claim: OTHER_ORIGIN })
    const [prompt] = await h.prompts()
    expect(prompt!.origin).toBe(OTHER_ORIGIN)
    expect(prompt!.code).not.toBe(relayed.code)
    // Even approved by mistake, the token is sealed for a key the real extension never had.
    h.requests.approve(prompt!.id)
    expect((await relayed.outcome).ok).toBe(false)

    // Two extensions asking at once are two prompts; approving one pairs only that one.
    const real = await ask(h.url, { origin: STORE_ORIGIN, name: 'Brave' })
    const rider = await ask(h.url, { origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Brave' })
    const both = await h.prompts(2)
    expect(both.map(entry => entry.code).sort()).toEqual([real.code, rider.code].sort())
    expect(h.requests.approveCode(real.code!)).toBe('approved')
    expect((await real.outcome).ok).toBe(true)
    expect(rider.socket!.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).toHaveBeenLastCalledWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    h.requests.denyAll()
    expect(await rider.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingDenied })
    // The rider is still unknown to the bridge: a hello from it is refused, token or not.
    const hello = await openSocket(h.url, 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    await sendHello(hello.ws, TEST_TOKEN, TEST_CAPS)
    expect((await hello.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('refuses a reveal that does not open the commitment (no steering the code)', async () => {
    const h = await startPairingBridge()
    const socket = await openSocket(h.url, STORE_ORIGIN)
    const serverNonce = await challengeOf(socket)
    const committed = createPairingShare()
    socket.ws.send(JSON.stringify({
      t: 'pair.request', v: 1, nonce: createBridgeNonce(), endpoint: endpointOf(socket.ws), origin: STORE_ORIGIN, name: 'Brave',
      commit: pairingCommitment(committed.share, createPairingOpening()),
    }))
    await waitFor(() => socket.frames.some(frame => frame.t === 'pair.share'))
    // Having seen the bridge's share, the client tries to reveal a different one.
    socket.ws.send(JSON.stringify({ t: 'pair.reveal', share: createPairingShare().share, opening: createPairingOpening() }))
    expect((await socket.closed).code).toBe(BRIDGE_CLOSE_CODES.pairingFailed)
    expect(h.requests.list()).toEqual([])
    expect(serverNonce).toHaveLength(64)
  })

  it('never pairs a web page, and a bridge without pairing admits no unknown extension', async () => {
    const h = await startPairingBridge()
    for (const origin of ['https://evil.example', 'http://127.0.0.1:3080', 'null']) {
      const asking = await ask(h.url, { origin })
      expect(asking.code).toBeUndefined()
      expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    }
    expect(h.requests.list()).toEqual([])
    const plain = await startTestBridge()
    expect(await (await ask(plain.url, { origin: STORE_ORIGIN })).outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    expect(await (await ask(plain.url)).outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
  })

  it('refuses a request relayed from another port', async () => {
    const h = await startPairingBridge({ localEndpointOverride: { host: '127.0.0.1', port: 1 } })
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed, reason: 'pairing failed: endpoint mismatch' })
    expect(h.requests.list()).toEqual([])
  })

  it('lets a pairing socket pair and nothing else', async () => {
    const h = await startPairingBridge()
    // An unknown extension that sends hello is refused, right token or not.
    const socket = await openSocket(h.url, OTHER_ORIGIN)
    await sendHello(socket.ws, TEST_TOKEN, TEST_CAPS)
    expect((await socket.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)

    // Out of order, repeated, or mixed with hello: closed, never promoted.
    const early = await openSocket(h.url)
    await challengeOf(early)
    early.ws.send(JSON.stringify({ t: 'pair.reveal', share: createPairingShare().share, opening: 'a'.repeat(64) }))
    expect((await early.closed).code).toBe(1008)

    const waiting = await ask(h.url)
    await h.prompts()
    await sendHello(waiting.socket!.ws, TEST_TOKEN, TEST_CAPS)
    expect(await waiting.outcome).toMatchObject({ ok: false, code: 1008 })
    await waitFor(() => h.requests.list().length === 0)
    expect(h.bridge.connectionCount()).toBe(0)
  })

  it('leaves already-paired extensions alone: handshake, connection and allowlist are unchanged', async () => {
    const h = await startPairingBridge()
    const before = await connectClient(h.url, TEST_CAPS, { origin: PINNED_ORIGIN })
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.prompts()
    // While another extension waits for approval the installed one still connects with the same handshake...
    const during = await connectClient(h.url, { ...TEST_CAPS, client: { id: 'second-install', browser: 'chrome' } }, { origin: PINNED_ORIGIN })
    expect(during.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
    // ...a wrong token is still refused...
    const wrong = await openSocket(h.url, PINNED_ORIGIN)
    await sendHello(wrong.ws, 'f'.repeat(32), TEST_CAPS)
    expect((await wrong.closed).code).toBe(BRIDGE_CLOSE_CODES.authFailed)
    // ...and the approval does not disturb live connections.
    h.requests.approve(h.requests.list()[0]!.id)
    expect((await asking.outcome).ok).toBe(true)
    expect(h.bridge.connectionCount()).toBe(2)
    expect((await before.rpc('session.list', {})).ok).toBe(true)
    expect(before.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('pairs a Firefox extension and a client without an Origin (nothing to allowlist)', async () => {
    const h = await startPairingBridge()
    const firefox = await ask(h.url, { origin: 'moz-extension://per-install-uuid', name: 'Firefox' })
    h.requests.approve((await h.prompts())[0]!.id)
    expect(await firefox.outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenLastCalledWith({ origin: 'moz-extension://per-install-uuid' })
    const local = await ask(h.url)
    h.requests.approve((await h.prompts())[0]!.id)
    expect(await local.outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenLastCalledWith({ origin: '' })
  })

  it('survives a throwing pairing observer', async () => {
    const h = await startPairingBridge({ onPaired: () => { throw new Error('disk full') } })
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    h.requests.approve((await h.prompts())[0]!.id)
    expect((await asking.outcome).ok).toBe(true)
    await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
  })
})

describe('host-side pairing controls (pairing-mount.ts)', () => {
  const post = (body: unknown): Request => new Request(`http://127.0.0.1${PAIRING_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const pending = (requests: PairingRequests, code: string, origin = STORE_ORIGIN, name = 'Brave') => {
    const settle = vi.fn<(decision: PairingDecision) => void>()
    requests.submit({ code, origin, name }, settle)
    return settle
  }

  it('lists, approves and denies requests through the control route', async () => {
    const time = clock()
    const requests = new PairingRequests(time.now)
    const empty = await handlePairingControl(requests, post({ action: 'list' }), time.now)
    expect(empty.headers.get('cache-control')).toBe('no-store')
    expect(await empty.json()).toEqual({ ok: true, requests: [] })

    const brave = pending(requests, 'ABCDEF')
    const other = pending(requests, 'GHJKLM', OTHER_ORIGIN, 'Chrome')
    time.advance(30_000)
    const listed = await (await handlePairingControl(requests, post({ action: 'list' }), time.now)).json() as { requests: Array<{ id: string }> }
    expect(listed).toEqual({
      ok: true,
      requests: [
        { id: expect.any(String), code: 'ABC-DEF', origin: STORE_ORIGIN, name: 'Brave', expiresInMs: PAIRING_REQUEST_TTL_MS - 30_000 },
        { id: expect.any(String), code: 'GHJ-KLM', origin: OTHER_ORIGIN, name: 'Chrome', expiresInMs: PAIRING_REQUEST_TTL_MS - 30_000 },
      ],
    })

    const approved = await handlePairingControl(requests, post({ action: 'approve', id: listed.requests[0]!.id }), time.now)
    expect(await approved.json()).toMatchObject({ ok: true, requests: [{ code: 'GHJ-KLM' }], paired: { origin: STORE_ORIGIN, name: 'Brave' } })
    expect(brave).toHaveBeenCalledExactlyOnceWith('approved')
    // Approving it again finds nothing (409), and approves nobody else.
    const again = await handlePairingControl(requests, post({ action: 'approve', id: listed.requests[0]!.id }), time.now)
    expect(again.status).toBe(409)
    expect(other).not.toHaveBeenCalled()

    const denied = await handlePairingControl(requests, post({ action: 'deny', id: listed.requests[1]!.id }), time.now)
    expect(await denied.json()).toMatchObject({ ok: true, requests: [] })
    expect(other).toHaveBeenCalledExactlyOnceWith('denied')
  })

  it('answers 400 to anything else and approves nothing', async () => {
    const requests = new PairingRequests(clock().now)
    const settle = pending(requests, 'ABCDEF')
    for (const body of [{ action: 'start' }, { action: 'approve' }, { action: 'approve', id: 7 }, { action: 'approve-all' }, 'not json', 'null']) {
      expect((await handlePairingControl(requests, post(body))).status).toBe(400)
    }
    expect((await handlePairingControl(requests, post({ action: 'approve', id: 'p999' }))).status).toBe(409)
    expect(settle).not.toHaveBeenCalled()
  })

  it('runs /browser-pair', () => {
    const requests = new PairingRequests(clock().now)
    expect(runPairingCommand(requests, '')).toMatchObject({ kind: 'success', text: expect.stringContaining('No browser is asking') })
    const brave = pending(requests, 'ABCDEF')
    const other = pending(requests, 'GHJKLM', '', 'Chrome')
    const listed = runPairingCommand(requests, '  ')
    expect(listed.text).toContain(`Brave (${STORE_ORIGIN}) wants to connect, code ABC-DEF`)
    expect(listed.text).toContain('Chrome wants to connect, code GHJ-KLM')
    expect(runPairingCommand(requests, 'approve')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage') })
    expect(runPairingCommand(requests, 'allow ABC-DEF')).toMatchObject({ kind: 'error' })
    expect(runPairingCommand(requests, 'approve ZZZ-ZZZ')).toMatchObject({ kind: 'error', text: expect.stringContaining('No waiting request shows that code') })
    expect(brave).not.toHaveBeenCalled()
    expect(runPairingCommand(requests, 'Approve abc def')).toEqual({ kind: 'success', text: 'Paired with Brave. It connects by itself now.' })
    expect(brave).toHaveBeenCalledExactlyOnceWith('approved')
    expect(runPairingCommand(requests, 'deny')).toEqual({ kind: 'success', text: 'Denied 1 pairing request.' })
    expect(other).toHaveBeenCalledExactlyOnceWith('denied')
    expect(runPairingCommand(requests, 'deny')).toEqual({ kind: 'success', text: 'No browser was asking to connect.' })
  })

  it('registers the route and the command only where the composition has them', async () => {
    const requests = new PairingRequests(clock().now)
    expect(mountPairingControls(requests, {})).toEqual([])
    const routes: Array<Parameters<NonNullable<Parameters<typeof mountPairingControls>[1]['fetch']>['register']>[0]> = []
    const commands: Array<Parameters<NonNullable<Parameters<typeof mountPairingControls>[1]['commands']>['register']>[0]> = []
    const disposeRoute = vi.fn()
    const disposeCommand = vi.fn()
    const disposers = mountPairingControls(requests, {
      fetch: { register: (route) => { routes.push(route); return disposeRoute } },
      commands: { register: (definition) => { commands.push(definition); return disposeCommand } },
    })
    expect(disposers).toEqual([disposeRoute, disposeCommand])
    expect(routes[0]).toMatchObject({ path: PAIRING_API_PATH, methods: ['POST'], requestBody: 'buffered' })
    expect(commands[0]).toMatchObject({ name: PAIRING_COMMAND_NAME })
    expect(commands[0]!.handler({ rawInput: '' })).toMatchObject({ kind: 'success' })
    expect(await (await routes[0]!.fetch(post({ action: 'list' }))).json()).toEqual({ ok: true, requests: [] })
  })
})
