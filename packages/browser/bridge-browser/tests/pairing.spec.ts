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
  parseBridgeFrame,
  type BridgeFrame,
} from '../src/protocol.ts'
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_PRIME_HEX,
  createPairingShare,
  derivePairingKeys,
  formatPairingCode,
  generatePairingCode,
  isPairingShare,
  normalizePairingCode,
  openPairingToken,
  pairingClientConfirmation,
  sealPairingToken,
  verifyPairingClientConfirmation,
  type PairingContext,
} from '../src/pairing.ts'
import {
  MAX_PAIRED_EXTENSION_IDS,
  PAIRING_COOLDOWN_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_WINDOW_MS,
  PairingWindows,
  chromeExtensionIdOfOrigin,
  isPairableOrigin,
  readPairedExtensionIds,
  writePairedExtensionIds,
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

const CODE = 'ABCDEFGH'
const CONTEXT: PairingContext = {
  code: CODE,
  serverNonce: 'a'.repeat(64),
  clientNonce: 'b'.repeat(64),
  endpoint: { host: '127.0.0.1', port: 3080 },
  origin: STORE_ORIGIN,
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

type PairOutcome =
  | { ok: true; token: string; frames: BridgeFrame[] }
  | { ok: false; code: number; reason: string; frames: BridgeFrame[] }

/**
 * Run the client half of a pairing exchange the way the extension does.
 * @param options.origin - Origin header the socket presents (a browser sets it; a local process can forge it).
 * @param options.as - the origin this client believes it is (defaults to `origin`); differs for a relay.
 * @param options.claim - the origin written into `pair.hello` (defaults to `as`).
 */
async function pair(
  url: string,
  code: string,
  options: { origin?: string; as?: string; claim?: string } = {},
): Promise<PairOutcome> {
  let socket: TestSocket
  try {
    socket = await openSocket(url, options.origin)
  } catch (error) {
    return { ok: false, code: 0, reason: String(error), frames: [] }
  }
  const serverNonce = await challengeOf(socket).catch(() => undefined)
  // Refused before the challenge (the Origin check).
  if (serverNonce === undefined) return { ok: false, ...(await socket.closed), frames: socket.frames }
  const origin = options.as ?? options.origin ?? ''
  const context: PairingContext = { code, serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(socket.ws), origin }
  const own = createPairingShare(context)
  socket.ws.send(JSON.stringify({
    t: 'pair.hello', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint: context.endpoint, origin: options.claim ?? origin, share: own.share,
  }))
  await waitFor(() => socket.frames.some(frame => frame.t === 'pair.share') || socket.ws.readyState !== WebSocket.OPEN)
  const share = socket.frames.find(frame => frame.t === 'pair.share') as Extract<BridgeFrame, { t: 'pair.share' }> | undefined
  if (share === undefined) return { ok: false, ...(await socket.closed), frames: socket.frames }
  const keys = derivePairingKeys(context, own.secret, own.share, share.share, 'client')!
  socket.ws.send(JSON.stringify({ t: 'pair.confirm', mac: pairingClientConfirmation(keys) }))
  const closed = await socket.closed
  const ok = socket.frames.find(frame => frame.t === 'pair.ok') as Extract<BridgeFrame, { t: 'pair.ok' }> | undefined
  const token = ok === undefined ? undefined : openPairingToken(keys, ok.box, ok.mac)
  return token === undefined ? { ok: false, ...closed, frames: socket.frames } : { ok: true, token, frames: socket.frames }
}

describe('pairing exchange (pairing.ts)', () => {
  it('uses the RFC 3526 3072-bit group', () => {
    expect(PAIRING_PRIME_HEX).toBe(getDiffieHellman('modp15').getPrime().toString('hex'))
  })

  it('generates, formats and normalizes codes', () => {
    const code = generatePairingCode()
    expect(code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`, 'u'))
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32)
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(normalizePairingCode(' abcd-efgh ')).toBe('ABCDEFGH')
    expect(normalizePairingCode('ABCD EFG')).toBeUndefined()
    // Look-alikes are not code symbols and are never guessed.
    expect(normalizePairingCode('ABCD-EFG0')).toBeUndefined()
    expect(normalizePairingCode('ABCD-EFG1')).toBeUndefined()
    expect(new Set(Array.from({ length: 20 }, generatePairingCode)).size).toBe(20)
  })

  it('gives both halves the same keys and carries the token only to a half with the code', () => {
    const client = createPairingShare(CONTEXT)
    const server = createPairingShare(CONTEXT)
    const clientKeys = derivePairingKeys(CONTEXT, client.secret, client.share, server.share, 'client')!
    const serverKeys = derivePairingKeys(CONTEXT, server.secret, client.share, server.share, 'server')!
    expect(verifyPairingClientConfirmation(serverKeys, pairingClientConfirmation(clientKeys))).toBe(true)
    const sealed = sealPairingToken(serverKeys, TEST_TOKEN)
    expect(sealed.box).not.toContain(Buffer.from(TEST_TOKEN).toString('hex'))
    expect(openPairingToken(clientKeys, sealed.box, sealed.mac)).toBe(TEST_TOKEN)
    // A flipped ciphertext bit or a foreign MAC is refused, never decrypted.
    const flipped = `${sealed.box.slice(0, -1)}${sealed.box.endsWith('0') ? '1' : '0'}`
    expect(openPairingToken(clientKeys, flipped, sealed.mac)).toBeUndefined()
    expect(openPairingToken(clientKeys, sealed.box, 'f'.repeat(64))).toBeUndefined()
    // Fresh shares every run: nothing repeats for an observer to correlate.
    expect(createPairingShare(CONTEXT).share).not.toBe(client.share)
  })

  it.each([
    ['another code', { code: 'ABCDEFGJ' }],
    ['another extension origin', { origin: OTHER_ORIGIN }],
    ['another endpoint', { endpoint: { host: '127.0.0.1', port: 3081 } }],
    ['another server nonce', { serverNonce: 'c'.repeat(64) }],
    ['another client nonce', { clientNonce: 'd'.repeat(64) }],
  ])('fails the confirmation when the client is keyed with %s', (_label, difference) => {
    const clientContext = { ...CONTEXT, ...difference }
    const client = createPairingShare(clientContext)
    const server = createPairingShare(CONTEXT)
    const clientKeys = derivePairingKeys(clientContext, client.secret, client.share, server.share, 'client')!
    const serverKeys = derivePairingKeys(CONTEXT, server.secret, client.share, server.share, 'server')!
    expect(verifyPairingClientConfirmation(serverKeys, pairingClientConfirmation(clientKeys))).toBe(false)
    const sealed = sealPairingToken(serverKeys, TEST_TOKEN)
    expect(openPairingToken(clientKeys, sealed.box, sealed.mac)).toBeUndefined()
  })

  it('refuses shares that would fix the key', () => {
    const p = BigInt(`0x${PAIRING_PRIME_HEX}`)
    const hex = (value: bigint): string => value.toString(16).padStart(768, '0')
    for (const degenerate of [0n, 1n, p - 1n, p]) expect(isPairingShare(hex(degenerate))).toBe(false)
    expect(isPairingShare(hex(2n))).toBe(true)
    expect(isPairingShare('12')).toBe(false)
    const own = createPairingShare(CONTEXT)
    expect(derivePairingKeys(CONTEXT, own.secret, hex(1n), own.share, 'server')).toBeUndefined()
    expect(derivePairingKeys(CONTEXT, own.secret, own.share, hex(p - 1n), 'client')).toBeUndefined()
  })

  it('does not let a reflected client share stand in for the bridge', () => {
    // An impostor without the code echoes the client's own share and confirmation back.
    const client = createPairingShare(CONTEXT)
    const keys = derivePairingKeys(CONTEXT, client.secret, client.share, client.share, 'client')!
    expect(openPairingToken(keys, 'ab', pairingClientConfirmation(keys))).toBeUndefined()
  })

  it('parses pairing frames strictly', () => {
    const share = createPairingShare(CONTEXT).share
    const hello = { t: 'pair.hello', v: 1, nonce: 'a'.repeat(64), endpoint: CONTEXT.endpoint, origin: STORE_ORIGIN, share }
    expect(parseBridgeFrame(JSON.stringify(hello))).toEqual(hello)
    expect(parseBridgeFrame(JSON.stringify({ ...hello, v: 2 }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ ...hello, share: share.slice(2) }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ ...hello, origin: 'x'.repeat(300) }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.confirm', mac: 'nope' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.share', share }))).toEqual({ t: 'pair.share', share })
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.ok', box: 'abc', mac: 'a'.repeat(64) }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.ok', box: 'ab'.repeat(2000), mac: 'a'.repeat(64) }))).toBeUndefined()
  })
})

describe('pairing window (pairing-host.ts)', () => {
  it('is closed until started, and closes after one use', () => {
    const time = clock()
    const windows = new PairingWindows(time.now, () => CODE)
    expect(windows.status()).toEqual({ state: 'idle' })
    expect(windows.isOpen()).toBe(false)
    expect(windows.attempt()).toBeUndefined()

    const started = windows.start()
    expect(started).toEqual({ ok: true, code: CODE, expiresAt: time.now() + PAIRING_WINDOW_MS })
    expect(windows.status()).toEqual({ state: 'open', expiresAt: time.now() + PAIRING_WINDOW_MS, attemptsLeft: PAIRING_MAX_ATTEMPTS })
    const ticket = windows.attempt()!
    expect(ticket.code).toBe(CODE)
    expect(windows.complete(ticket, STORE_ORIGIN)).toBe(true)
    expect(windows.status()).toEqual({ state: 'paired', at: time.now(), origin: STORE_ORIGIN })
    // Used: neither a new attempt nor a second completion of the same one.
    expect(windows.attempt()).toBeUndefined()
    expect(windows.complete(ticket, OTHER_ORIGIN)).toBe(false)
  })

  it('expires, and an attempt that began in time cannot complete late', () => {
    const time = clock()
    const windows = new PairingWindows(time.now, () => CODE)
    windows.start()
    const ticket = windows.attempt()!
    time.advance(PAIRING_WINDOW_MS)
    expect(windows.isOpen()).toBe(false)
    expect(windows.complete(ticket, STORE_ORIGIN)).toBe(false)
    expect(windows.status()).toEqual({ state: 'closed', reason: 'expired' })
  })

  it('caps attempts, then cools down before a new window', () => {
    const time = clock()
    const windows = new PairingWindows(time.now)
    windows.start()
    for (let index = 0; index < PAIRING_MAX_ATTEMPTS; index += 1) {
      const ticket = windows.attempt()!
      expect(ticket).toBeDefined()
      windows.fail(ticket)
    }
    expect(windows.attempt()).toBeUndefined()
    expect(windows.status()).toEqual({ state: 'closed', reason: 'attempts' })
    expect(windows.start()).toEqual({ ok: false, retryAt: time.now() + PAIRING_COOLDOWN_MS })
    time.advance(PAIRING_COOLDOWN_MS)
    expect(windows.start().ok).toBe(true)
  })

  it('lets the last admitted attempt finish, but admits no further one', () => {
    const windows = new PairingWindows(clock().now)
    windows.start()
    const tickets = Array.from({ length: PAIRING_MAX_ATTEMPTS }, () => windows.attempt()!)
    expect(windows.isOpen()).toBe(false)
    expect(windows.attempt()).toBeUndefined()
    for (const ticket of tickets.slice(1)) windows.fail(ticket)
    expect(windows.complete(tickets[0]!, STORE_ORIGIN)).toBe(true)
  })

  it('replaces and cancels windows: an old code or ticket stops working', () => {
    const codes = ['AAAAAAAA', 'BBBBBBBB']
    const windows = new PairingWindows(clock().now, () => codes.shift()!)
    windows.start()
    const stale = windows.attempt()!
    expect(windows.start()).toMatchObject({ ok: true, code: 'BBBBBBBB' })
    expect(windows.complete(stale, STORE_ORIGIN)).toBe(false)
    windows.fail(stale)
    expect(windows.status()).toMatchObject({ state: 'open', attemptsLeft: PAIRING_MAX_ATTEMPTS })
    windows.cancel()
    expect(windows.status()).toEqual({ state: 'closed', reason: 'cancelled' })
    expect(windows.attempt()).toBeUndefined()
    windows.cancel()
    expect(windows.status()).toEqual({ state: 'closed', reason: 'cancelled' })
  })

  it('classifies origins that may pair', () => {
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
    const windows = new PairingWindows(time.now)
    const onPaired = vi.fn()
    const started = await startTestBridge({ pairing: windows, onPaired, ...overrides })
    return { ...started, windows, onPaired, time }
  }
  const codeOf = (windows: PairingWindows): string => {
    const started = windows.start()
    if (!started.ok) throw new Error('pairing is cooling down')
    return started.code
  }

  it('pairs a store-installed extension: token delivered, ID allowed, window closed', async () => {
    const h = await startPairingBridge()
    // Before pairing the store build is refused at the Origin check, as ever.
    const refused = await openSocket(h.url, STORE_ORIGIN)
    expect((await refused.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)

    const code = codeOf(h.windows)
    // The user may type the code as displayed.
    const outcome = await pair(h.url, normalizePairingCode(formatPairingCode(code).toLowerCase())!, { origin: STORE_ORIGIN })
    expect(outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    expect(h.windows.status()).toMatchObject({ state: 'paired', origin: STORE_ORIGIN })

    // The paired build now authenticates with the ordinary handshake.
    const client = await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
    expect(client.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
    expect(h.bridge.connectionCount()).toBe(1)
  })

  it('never puts the code or the token on the wire, and nothing in a recorded run is reusable', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    const outcome = await pair(h.url, code, { origin: STORE_ORIGIN })
    expect(outcome.ok).toBe(true)
    const wire = JSON.stringify(outcome.frames)
    expect(wire).not.toContain(TEST_TOKEN)
    expect(wire).not.toContain(Buffer.from(TEST_TOKEN).toString('hex'))
    expect(wire).not.toContain(code)
    // An eavesdropper replays the bridge's recorded frames at a fresh client: the
    // nonces differ, so the recorded pair.ok does not verify under the new keys.
    const recorded = outcome.frames.find(frame => frame.t === 'pair.ok') as Extract<BridgeFrame, { t: 'pair.ok' }>
    const recordedShare = outcome.frames.find(frame => frame.t === 'pair.share') as Extract<BridgeFrame, { t: 'pair.share' }>
    const context: PairingContext = { ...CONTEXT, code }
    const victim = createPairingShare(context)
    const keys = derivePairingKeys(context, victim.secret, victim.share, recordedShare.share, 'client')!
    expect(openPairingToken(keys, recorded.box, recorded.mac)).toBeUndefined()
  })

  it('refuses a wrong code without revealing anything, and counts the attempt', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    const wrong = code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`
    const outcome = await pair(h.url, wrong, { origin: STORE_ORIGIN })
    expect(outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(outcome.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).not.toHaveBeenCalled()
    expect(h.windows.status()).toMatchObject({ state: 'open', attemptsLeft: PAIRING_MAX_ATTEMPTS - 1 })
    // Not allowed either: the wrong guess bought nothing.
    h.windows.cancel()
    expect((await (await openSocket(h.url, STORE_ORIGIN)).closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('refuses a replayed code: it works exactly once', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    expect((await pair(h.url, code, { origin: STORE_ORIGIN })).ok).toBe(true)
    // A second extension that learned the code afterwards is not even let in...
    expect(await pair(h.url, code, { origin: OTHER_ORIGIN })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    // ...and neither a client without an Origin nor the paired extension can use it again.
    expect(await pair(h.url, code)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(await pair(h.url, code, { origin: STORE_ORIGIN })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(h.onPaired).toHaveBeenCalledTimes(1)
  })

  it('refuses an expired code', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    h.time.advance(PAIRING_WINDOW_MS)
    expect(await pair(h.url, code)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(await pair(h.url, code, { origin: STORE_ORIGIN })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    expect(h.windows.status()).toEqual({ state: 'closed', reason: 'expired' })
  })

  it('caps attempts: after the last wrong guess even the right code is refused', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    const wrong = code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`
    for (let index = 0; index < PAIRING_MAX_ATTEMPTS; index += 1) {
      expect(await pair(h.url, wrong)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    }
    expect(h.windows.status()).toEqual({ state: 'closed', reason: 'attempts' })
    expect(await pair(h.url, code)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    // Reopening is rate limited, so guesses stay bounded per unit of time.
    expect(h.windows.start().ok).toBe(false)
    h.time.advance(PAIRING_COOLDOWN_MS)
    expect(h.windows.start().ok).toBe(true)
  })

  it('counts an abandoned exchange as an attempt', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    const socket = await openSocket(h.url)
    const serverNonce = await challengeOf(socket)
    const context: PairingContext = { code: 'ZZZZZZZZ', serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(socket.ws), origin: '' }
    socket.ws.send(JSON.stringify({ t: 'pair.hello', v: 1, nonce: context.clientNonce, endpoint: context.endpoint, origin: '', share: createPairingShare(context).share }))
    await waitFor(() => socket.frames.some(frame => frame.t === 'pair.share'))
    // The bridge's share alone tells a guesser nothing; walking away still costs the attempt.
    socket.ws.terminate()
    await waitFor(() => (h.windows.status() as { attemptsLeft?: number }).attemptsLeft === PAIRING_MAX_ATTEMPTS - 1)
    expect((await pair(h.url, code)).ok).toBe(true)
  })

  it('does not let a second extension ride on a pairing started for another', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    // The other extension relays the real one's exchange over its own socket.
    // Claiming the real origin contradicts the socket's Origin header...
    expect(await pair(h.url, code, { origin: OTHER_ORIGIN, as: STORE_ORIGIN })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    // ...and claiming its own makes the two halves confirm different transcripts.
    const relayed = await pair(h.url, code, { origin: OTHER_ORIGIN, as: STORE_ORIGIN, claim: OTHER_ORIGIN })
    expect(relayed).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(relayed.frames.some(frame => frame.t === 'pair.ok')).toBe(false)
    expect(h.onPaired).not.toHaveBeenCalled()

    // The intended extension pairs; the window it used admits nobody else.
    expect((await pair(h.url, code, { origin: STORE_ORIGIN })).ok).toBe(true)
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    expect((await (await openSocket(h.url, OTHER_ORIGIN)).closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
    // Even with the token (say it leaked), the other extension's ID is not on the allowlist.
    const other = await openSocket(h.url, OTHER_ORIGIN)
    await sendHello(other.ws, TEST_TOKEN, TEST_CAPS)
    expect((await other.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('lets a pairing-only socket pair and nothing else', async () => {
    const h = await startPairingBridge()
    codeOf(h.windows)
    // While the window is open an unknown extension is let in, but a `hello`
    // from it is refused even with the right token.
    const socket = await openSocket(h.url, OTHER_ORIGIN)
    await sendHello(socket.ws, TEST_TOKEN, TEST_CAPS)
    expect((await socket.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
    expect(h.bridge.connectionCount()).toBe(0)
    expect(h.windows.status()).toMatchObject({ state: 'open', attemptsLeft: PAIRING_MAX_ATTEMPTS })
  })

  it('pairs nobody while no window is open', async () => {
    const h = await startPairingBridge()
    // Never started: an Origin-less local process and an allowed extension reach
    // the frame check and are told the window is closed; nothing is computed.
    expect(await pair(h.url, CODE)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(await pair(h.url, CODE, { origin: PINNED_ORIGIN })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(await pair(h.url, CODE, { origin: STORE_ORIGIN })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    // Cancelled: the code that was shown stops working.
    const code = codeOf(h.windows)
    h.windows.cancel()
    expect(await pair(h.url, code)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(h.onPaired).not.toHaveBeenCalled()
    // A bridge built without pairing behaves the same.
    const plain = await startTestBridge()
    expect(await pair(plain.url, CODE)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
  })

  it('refuses web pages even while a window is open', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    for (const origin of ['https://evil.example', 'http://127.0.0.1:3080', 'null']) {
      expect(await pair(h.url, code, { origin })).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    }
    expect(h.windows.status()).toMatchObject({ state: 'open', attemptsLeft: PAIRING_MAX_ATTEMPTS })
  })

  it('refuses an exchange relayed from another port before it costs an attempt', async () => {
    const h = await startPairingBridge({ localEndpointOverride: { host: '127.0.0.1', port: 1 } })
    const code = codeOf(h.windows)
    expect(await pair(h.url, code)).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed, reason: 'pairing failed: endpoint mismatch' })
    expect(h.windows.status()).toMatchObject({ state: 'open', attemptsLeft: PAIRING_MAX_ATTEMPTS })
  })

  it('rejects out-of-order and repeated pairing frames', async () => {
    const h = await startPairingBridge()
    const code = codeOf(h.windows)
    const early = await openSocket(h.url)
    await challengeOf(early)
    early.ws.send(JSON.stringify({ t: 'pair.confirm', mac: 'a'.repeat(64) }))
    expect((await early.closed).code).toBe(1008)

    const twice = await openSocket(h.url)
    const serverNonce = await challengeOf(twice)
    const context: PairingContext = { code, serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(twice.ws), origin: '' }
    const hello = JSON.stringify({ t: 'pair.hello', v: 1, nonce: context.clientNonce, endpoint: context.endpoint, origin: '', share: createPairingShare(context).share })
    twice.ws.send(hello)
    twice.ws.send(hello)
    expect((await twice.closed).code).toBe(1008)

    // A hello after pair.hello does not turn the socket into a connection.
    const mixed = await openSocket(h.url)
    const nonce = await challengeOf(mixed)
    const mixedContext: PairingContext = { code, serverNonce: nonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(mixed.ws), origin: '' }
    mixed.ws.send(JSON.stringify({ t: 'pair.hello', v: 1, nonce: mixedContext.clientNonce, endpoint: mixedContext.endpoint, origin: '', share: createPairingShare(mixedContext).share }))
    await sendHello(mixed.ws, TEST_TOKEN, TEST_CAPS)
    expect((await mixed.closed).code).toBe(1008)
    expect(h.bridge.connectionCount()).toBe(0)
  })

  it('leaves already-paired extensions alone: handshake, connection and allowlist are unchanged', async () => {
    const h = await startPairingBridge()
    const before = await connectClient(h.url, TEST_CAPS, { origin: PINNED_ORIGIN })
    const code = codeOf(h.windows)
    // With a window open the installed extension still connects with the same handshake...
    const during = await connectClient(h.url, { ...TEST_CAPS, client: { id: 'second-install', browser: 'chrome' } }, { origin: PINNED_ORIGIN })
    expect(during.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
    // ...a wrong token is still refused...
    const wrong = await openSocket(h.url, PINNED_ORIGIN)
    await sendHello(wrong.ws, 'f'.repeat(32), TEST_CAPS)
    expect((await wrong.closed).code).toBe(BRIDGE_CLOSE_CODES.authFailed)
    // ...and another extension pairing does not disturb live connections.
    expect((await pair(h.url, code, { origin: STORE_ORIGIN })).ok).toBe(true)
    expect(h.bridge.connectionCount()).toBe(2)
    expect((await before.rpc('session.list', {})).ok).toBe(true)
    expect(before.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('pairs a Firefox extension and a client without an Origin (nothing to allowlist)', async () => {
    const h = await startPairingBridge()
    expect(await pair(h.url, codeOf(h.windows), { origin: 'moz-extension://per-install-uuid' })).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenLastCalledWith({ origin: 'moz-extension://per-install-uuid' })
    expect(await pair(h.url, codeOf(h.windows))).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenLastCalledWith({ origin: '' })
  })

  it('survives a throwing pairing observer', async () => {
    const h = await startPairingBridge({ onPaired: () => { throw new Error('disk full') } })
    expect((await pair(h.url, codeOf(h.windows), { origin: STORE_ORIGIN })).ok).toBe(true)
    await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
  })
})

describe('host-side pairing controls (pairing-mount.ts)', () => {
  const post = (body: unknown): Request => new Request(`http://127.0.0.1${PAIRING_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  it('starts, reports and cancels a window through the control route', async () => {
    const time = clock()
    const windows = new PairingWindows(time.now, () => CODE)
    const idle = await handlePairingControl(windows, post({ action: 'status' }))
    expect(await idle.json()).toEqual({ ok: true, status: { state: 'idle' } })

    const started = await handlePairingControl(windows, post({ action: 'start' }))
    expect(started.headers.get('cache-control')).toBe('no-store')
    expect(await started.json()).toEqual({
      ok: true, code: 'ABCD-EFGH', expiresAt: time.now() + PAIRING_WINDOW_MS, ttlMs: PAIRING_WINDOW_MS,
      status: { state: 'open', expiresAt: time.now() + PAIRING_WINDOW_MS, attemptsLeft: PAIRING_MAX_ATTEMPTS },
    })
    // Status never repeats the code.
    expect(JSON.stringify(await (await handlePairingControl(windows, post({ action: 'status' }))).json())).not.toContain('ABCD')

    const cancelled = await handlePairingControl(windows, post({ action: 'cancel' }))
    expect(await cancelled.json()).toEqual({ ok: true, status: { state: 'closed', reason: 'cancelled' } })
    expect(windows.isOpen()).toBe(false)
  })

  it('answers 400 to anything else and 429 while cooling down', async () => {
    const time = clock()
    const windows = new PairingWindows(time.now)
    expect((await handlePairingControl(windows, post({ action: 'pair' }))).status).toBe(400)
    expect((await handlePairingControl(windows, post('not json'))).status).toBe(400)
    expect((await handlePairingControl(windows, post('null'))).status).toBe(400)
    expect(windows.isOpen()).toBe(false)
    windows.start()
    for (let index = 0; index < PAIRING_MAX_ATTEMPTS; index += 1) windows.fail(windows.attempt()!)
    const cooling = await handlePairingControl(windows, post({ action: 'start' }))
    expect(cooling.status).toBe(429)
    expect(await cooling.json()).toMatchObject({ ok: false, error: 'cooldown', retryAt: time.now() + PAIRING_COOLDOWN_MS })
  })

  it('runs /browser-pair', () => {
    const time = clock()
    const windows = new PairingWindows(time.now, () => CODE)
    const shown = runPairingCommand(windows, '', time.now)
    expect(shown.kind).toBe('success')
    expect(shown.text).toContain('ABCD-EFGH')
    expect(windows.isOpen()).toBe(true)
    expect(runPairingCommand(windows, ' now ', time.now)).toMatchObject({ kind: 'error' })
    expect(runPairingCommand(windows, ' cancel ', time.now).kind).toBe('success')
    expect(windows.isOpen()).toBe(false)
    windows.start()
    for (let index = 0; index < PAIRING_MAX_ATTEMPTS; index += 1) windows.fail(windows.attempt()!)
    expect(runPairingCommand(windows, '', time.now)).toEqual({
      kind: 'error', text: 'Too many wrong pairing codes were tried. Wait 30 s, then run /browser-pair again.',
    })
  })

  it('registers the route and the command only where the composition has them', async () => {
    const windows = new PairingWindows(clock().now, () => CODE)
    expect(mountPairingControls(windows, {})).toEqual([])
    const routes: Array<Parameters<NonNullable<Parameters<typeof mountPairingControls>[1]['fetch']>['register']>[0]> = []
    const commands: Array<Parameters<NonNullable<Parameters<typeof mountPairingControls>[1]['commands']>['register']>[0]> = []
    const disposeRoute = vi.fn()
    const disposeCommand = vi.fn()
    const disposers = mountPairingControls(windows, {
      fetch: { register: (route) => { routes.push(route); return disposeRoute } },
      commands: { register: (definition) => { commands.push(definition); return disposeCommand } },
    })
    expect(disposers).toEqual([disposeRoute, disposeCommand])
    expect(routes[0]).toMatchObject({ path: PAIRING_API_PATH, methods: ['POST'], requestBody: 'buffered' })
    expect(commands[0]).toMatchObject({ name: PAIRING_COMMAND_NAME })
    expect(commands[0]!.handler({ rawInput: '' })).toMatchObject({ kind: 'success' })
    expect(await (await routes[0]!.fetch(post({ action: 'status' }))).json()).toMatchObject({ status: { state: 'open' } })
  })
})
