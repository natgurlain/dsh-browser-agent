import { createHmac, getDiffieHellman } from 'node:crypto'
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  BRIDGE_CLOSE_CODES,
  PAIRING_BROWSER_NAMES,
  PAIRING_PROTOCOL_VERSION,
  PINNED_CHROME_EXTENSION_ID,
  createBridgeNonce,
  isPairingName,
  isPairingOrigin,
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
  pairingDoneMac,
  pairingShareFor,
  sealPairingToken,
  verifyPairingClientConfirmation,
  verifyPairingDone,
  type PairingContext,
} from '../src/pairing.ts'
import {
  FAILURE_WINDOW_MS,
  MAX_FAILED_CONFIRMATIONS,
  MAX_PAIRED_EXTENSION_IDS,
  MAX_PENDING_PAIRINGS,
  MAX_PENDING_PER_ORIGIN,
  MAX_REQUESTS_PER_MINUTE,
  MAX_REQUESTS_PER_ORIGIN_PER_MINUTE,
  PAIRING_REQUEST_TTL_MS,
  PairingDesk,
  chromeExtensionIdOfOrigin,
  filePairedExtensions,
  type PairingAttemptOutcome,
  type PairingDropReason,
} from '../src/pairing-host.ts'
import {
  PAIRING_API_PATH,
  PAIRING_COMMAND_NAME,
  handlePairingControl,
  mountPairingControls,
  runPairingCommand,
  type PairingControls,
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
const FIREFOX_ORIGIN = 'moz-extension://0f8fad5b-d9cb-469f-a165-70867728950e'
/** A fresh, well-formed Chrome extension origin per index (a local process can forge any). */
const forgedOrigin = (index: number): string => `chrome-extension://${'a'.repeat(31)}${String.fromCharCode(98 + index)}`

const CODE = 'ABCDEF'
const CONTEXT: PairingContext = {
  code: CODE,
  serverNonce: 'a'.repeat(64),
  clientNonce: 'b'.repeat(64),
  endpoint: { host: '127.0.0.1', port: 3080 },
  origin: STORE_ORIGIN,
  name: 'Brave',
}
const P = BigInt(`0x${PAIRING_PRIME_HEX}`)
const hex = (value: bigint): string => value.toString(16).padStart(768, '0')

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

/** A pairing request as the extension runs it. */
interface Asking {
  /** The code this client displays (and keyed its share with). */
  code: string
  outcome: Promise<Outcome>
  socket: TestSocket
  /** Whether the bridge kept the request (it is waiting for a code). */
  sent: boolean
}

/**
 * Run the client half of a pairing exchange the way the extension does: send
 * the request keyed by its own code, then answer the bridge's share with a
 * confirmation and acknowledge a `pair.ok` that verifies.
 * @param options.origin - Origin header the socket presents (a browser sets it; a local process can forge it).
 * @param options.as - the origin this client believes it is (defaults to `origin`); differs for a relay.
 * @param options.claim - the origin written into `pair.request` (defaults to `as`).
 * @param options.acknowledge - false: never send `pair.done`.
 */
async function ask(
  url: string,
  options: { origin?: string; as?: string; claim?: string; name?: string; code?: string; acknowledge?: boolean } = {},
): Promise<Asking> {
  const code = options.code ?? generatePairingCode()
  const socket = await openSocket(url, options.origin)
  const refused = (): Asking => ({
    code, socket, sent: false,
    outcome: socket.closed.then(closed => ({ ok: false as const, ...closed, frames: socket.frames })),
  })
  const serverNonce = await challengeOf(socket).catch(() => undefined)
  // Refused before the challenge (the Origin check).
  if (serverNonce === undefined) return refused()
  const origin = options.as ?? options.origin ?? ''
  const context: PairingContext = { code, serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(socket.ws), origin, name: options.name ?? 'Brave' }
  const own = createPairingShare(context)
  let token: string | undefined
  socket.ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as BridgeFrame
    if (frame.t === 'pair.share') {
      const keys = derivePairingKeys(context, own.secret, own.share, frame.share, 'client')!
      socket.ws.send(JSON.stringify({ t: 'pair.confirm', mac: pairingClientConfirmation(keys) }))
      socket.ws.once('message', (answer) => {
        const ok = JSON.parse(answer.toString()) as BridgeFrame
        if (ok.t !== 'pair.ok') return
        token = openPairingToken(keys, ok.box, ok.mac)
        if (token !== undefined && options.acknowledge !== false) socket.ws.send(JSON.stringify({ t: 'pair.done', mac: pairingDoneMac(keys) }))
      })
    }
  })
  socket.ws.send(JSON.stringify({
    t: 'pair.request', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint: context.endpoint,
    origin: options.claim ?? origin, name: context.name, share: own.share,
  }))
  return {
    code, socket, sent: true,
    outcome: socket.closed.then(closed => token === undefined
      ? { ok: false as const, ...closed, frames: socket.frames }
      : { ok: true as const, token, frames: socket.frames }),
  }
}

describe('pairing exchange (pairing.ts)', () => {
  it('uses the RFC 3526 3072-bit group', () => {
    expect(PAIRING_PRIME_HEX).toBe(getDiffieHellman('modp15').getPrime().toString('hex'))
  })

  it('generates, formats and normalizes codes', () => {
    const code = generatePairingCode()
    expect(code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{6}$`, 'u'))
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32)
    expect(formatPairingCode('ABCDEF')).toBe('ABC-DEF')
    expect(normalizePairingCode(' abc-def ')).toBe('ABCDEF')
    expect(normalizePairingCode('ABC DE')).toBeUndefined()
    // Look-alikes are not code symbols and are never guessed.
    expect(normalizePairingCode('ABC-DE0')).toBeUndefined()
    expect(normalizePairingCode('ABC-DE1')).toBeUndefined()
    expect(new Set(Array.from({ length: 20 }, generatePairingCode)).size).toBe(20)
  })

  it('gives both halves the same keys when they hold the same code, and carries the token only then', () => {
    const client = createPairingShare(CONTEXT)
    const server = createPairingShare(CONTEXT)
    const clientKeys = derivePairingKeys(CONTEXT, client.secret, client.share, server.share, 'client')!
    const serverKeys = derivePairingKeys(CONTEXT, server.secret, client.share, server.share, 'server')!
    expect(verifyPairingClientConfirmation(serverKeys, pairingClientConfirmation(clientKeys))).toBe(true)
    expect(verifyPairingDone(serverKeys, pairingDoneMac(clientKeys))).toBe(true)
    // The three MACs are under separate keys: one cannot stand in for another.
    expect(verifyPairingDone(serverKeys, pairingClientConfirmation(clientKeys))).toBe(false)
    const sealed = sealPairingToken(serverKeys, TEST_TOKEN)
    expect(sealed.mac).not.toBe(pairingClientConfirmation(clientKeys))
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
    ['another code', { code: 'ABCDEG' }],
    ['another extension origin', { origin: OTHER_ORIGIN }],
    ['another browser name', { name: 'Chrome' }],
    ['another endpoint', { endpoint: { host: '127.0.0.1', port: 3081 } }],
    ['another server nonce', { serverNonce: 'c'.repeat(64) }],
    ['another client nonce', { clientNonce: 'd'.repeat(64) }],
  ])('fails both confirmations when the client holds %s', (_label, difference) => {
    const clientContext = { ...CONTEXT, ...difference }
    const client = createPairingShare(clientContext)
    const server = createPairingShare(CONTEXT)
    const clientKeys = derivePairingKeys(clientContext, client.secret, client.share, server.share, 'client')!
    const serverKeys = derivePairingKeys(CONTEXT, server.secret, client.share, server.share, 'server')!
    expect(verifyPairingClientConfirmation(serverKeys, pairingClientConfirmation(clientKeys))).toBe(false)
    const sealed = sealPairingToken(serverKeys, TEST_TOKEN)
    expect(openPairingToken(clientKeys, sealed.box, sealed.mac)).toBeUndefined()
  })

  it('matches an independent derivation with node crypto (fixed vector)', () => {
    // Fixed exponents, so the extension's copy of this vector (pairing.spec there) pins the same bytes.
    const a = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn
    const b = 0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321n
    const clientShare = pairingShareFor(CONTEXT, a)
    const serverShare = pairingShareFor(CONTEXT, b)
    const keys = derivePairingKeys(CONTEXT, a, clientShare, serverShare, 'client')!

    // The same computation, written again with node's HMAC and BigInt.
    const hmac = (key: Buffer | string, data: Buffer | string): Buffer => createHmac('sha256', key).update(data).digest()
    const label = 'dsh-pair/v1'
    const context = `${CONTEXT.serverNonce}|${CONTEXT.clientNonce}|127.0.0.1|3080|${String(STORE_ORIGIN.length)}:${STORE_ORIGIN}|5:Brave`
    const message = Buffer.from(`6:${CODE}|${context}`)
    const wide = Buffer.concat(Array.from({ length: 13 }, (_, counter) => hmac(`${label}|generator`, Buffer.concat([Buffer.of(counter), message]))))
    const base = BigInt(`0x${wide.toString('hex')}`) % P
    const g = base * base % P
    const pow = (x: bigint, e: bigint): bigint => { let r = 1n; let f = x % P; for (let k = e; k > 0n; k >>= 1n) { if (k & 1n) r = r * f % P; f = f * f % P } return r }
    expect(clientShare).toBe(hex(pow(g, a)))
    expect(serverShare).toBe(hex(pow(g, b)))
    const transcript = `${label}|${context}|${clientShare}|${serverShare}`
    const master = hmac(`${label}|master`, Buffer.concat([Buffer.from(hex(pow(g, a * b)), 'hex'), Buffer.from(transcript)]))
    expect(pairingClientConfirmation(keys)).toBe(hmac(hmac(master, 'confirm|client'), transcript).toString('hex'))
    expect(pairingDoneMac(keys)).toBe(hmac(hmac(master, 'done'), transcript).toString('hex'))
    // The value the extension suite pins.
    expect(pairingClientConfirmation(keys)).toBe(VECTOR_CLIENT_CONFIRMATION)
  })

  it('accepts only shares in the prime-order subgroup', () => {
    for (const degenerate of [0n, 1n, P - 1n, P]) expect(isPairingShare(hex(degenerate))).toBe(false)
    expect(isPairingShare('12')).toBe(false)
    // The subgroup is the squares. 4 is one; p - 4 is not (p ≡ 3 mod 4, so -1 is a non-residue).
    expect(isPairingShare(hex(4n))).toBe(true)
    expect(isPairingShare(hex(P - 4n))).toBe(false)
    // The membership test agrees with the definition (y^q = 1) on shares and their negations.
    const q = (P - 1n) / 2n
    const pow = (x: bigint, e: bigint): bigint => { let r = 1n; let f = x % P; for (let k = e; k > 0n; k >>= 1n) { if (k & 1n) r = r * f % P; f = f * f % P } return r }
    for (let index = 0; index < 3; index += 1) {
      const share = BigInt(`0x${createPairingShare({ ...CONTEXT, code: generatePairingCode() }).share}`)
      expect(pow(share, q)).toBe(1n)
      expect(isPairingShare(hex(share))).toBe(true)
      expect(pow(P - share, q)).toBe(P - 1n)
      expect(isPairingShare(hex(P - share))).toBe(false)
    }
    const own = createPairingShare(CONTEXT)
    expect(derivePairingKeys(CONTEXT, own.secret, hex(P - 4n), own.share, 'server')).toBeUndefined()
    expect(derivePairingKeys(CONTEXT, own.secret, own.share, hex(1n), 'client')).toBeUndefined()
  })

  it('does not let a reflected client share stand in for the bridge', () => {
    // An impostor without the code echoes the client's own share and confirmation back.
    const client = createPairingShare(CONTEXT)
    const keys = derivePairingKeys(CONTEXT, client.secret, client.share, client.share, 'client')!
    expect(openPairingToken(keys, 'ab', pairingClientConfirmation(keys))).toBeUndefined()
  })

  it('parses pairing frames strictly: exact origins, listed names', () => {
    const share = createPairingShare(CONTEXT).share
    const request = { t: 'pair.request', v: 1, nonce: 'a'.repeat(64), endpoint: CONTEXT.endpoint, origin: STORE_ORIGIN, name: 'Brave', share }
    expect(parseBridgeFrame(JSON.stringify(request))).toEqual(request)
    expect(parseBridgeFrame(JSON.stringify({ ...request, origin: FIREFOX_ORIGIN, name: 'Firefox' }))).toMatchObject({ origin: FIREFOX_ORIGIN })
    expect(parseBridgeFrame(JSON.stringify({ ...request, v: 2 }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ ...request, share: share.slice(2) }))).toBeUndefined()
    for (const origin of [
      '', 'https://evil.example', 'chrome-extension://short', `${STORE_ORIGIN}/`, `${STORE_ORIGIN}\u009b[2J`,
      'moz-extension://per-install-uuid', `moz-extension://${'x'.repeat(200)}`, `${FIREFOX_ORIGIN} approved by DSH`,
      `chrome-extension://${'A'.repeat(32)}`,
    ]) {
      expect(isPairingOrigin(origin), origin).toBe(false)
      expect(parseBridgeFrame(JSON.stringify({ ...request, origin }))).toBeUndefined()
    }
    expect(isPairingOrigin(undefined)).toBe(false)
    // The name is a hint from a fixed list; nothing else reaches a screen or a terminal.
    for (const name of ['', 'Chrome - code verified by DSH', 'brave', '<b>Brave</b>', 'Brave\n', 'Brave\u009b[2J', 7]) {
      expect(isPairingName(name)).toBe(false)
      expect(parseBridgeFrame(JSON.stringify({ ...request, name }))).toBeUndefined()
    }
    for (const name of PAIRING_BROWSER_NAMES) expect(isPairingName(name)).toBe(true)
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.confirm', mac: 'nope' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.done', mac: 'a'.repeat(64) }))).toEqual({ t: 'pair.done', mac: 'a'.repeat(64) })
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.share', share }))).toEqual({ t: 'pair.share', share })
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.ok', box: 'abc', mac: 'a'.repeat(64) }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pair.ok', box: 'ab'.repeat(2000), mac: 'a'.repeat(64) }))).toBeUndefined()
  })
})

/** The fixed vector's client confirmation; the extension suite checks the same constant. */
const VECTOR_CLIENT_CONFIRMATION = 'cce5bb508133bd5b892ca32c9ea16a8bbd8ca80ac28fd7b1183b6fda888efc42'

describe('pairing desk (pairing-host.ts)', () => {
  /** A waiting request whose attempts and drops the spec observes. */
  function waiting(desk: PairingDesk, origin: string, holds?: string, name = 'Brave') {
    const attempt = vi.fn(async (code: string): Promise<PairingAttemptOutcome> => code === holds ? 'paired' : 'failed')
    const drop = vi.fn<(reason: PairingDropReason) => void>()
    expect(desk.admit(origin)).toBeUndefined()
    const queued = desk.enqueue({ origin, name }, attempt, drop)
    return { attempt, drop, withdraw: queued.withdraw }
  }

  it('holds requests until a code is entered, and tries one code once against all of them', async () => {
    const time = clock()
    const log = vi.fn()
    const desk = new PairingDesk(time.now, log)
    expect(desk.status()).toEqual({ paused: false, waiting: 0, hints: [], failures: 0 })
    expect(await desk.enter('ABC-DEF')).toBe('none-waiting')

    const real = waiting(desk, STORE_ORIGIN, 'ABCDEF')
    const other = waiting(desk, OTHER_ORIGIN, 'ZZZZZZ', 'Chrome')
    // The host knows how many wait and what they say they are; never a code.
    expect(desk.status()).toEqual({ paused: false, waiting: 2, hints: ['Brave', 'Chrome'], failures: 0 })
    expect(real.attempt).not.toHaveBeenCalled()

    expect(await desk.enter(' abc-def ')).toBe('paired')
    expect(real.attempt).toHaveBeenCalledExactlyOnceWith('ABCDEF')
    // The other request was tried with the same code, failed, and is gone too.
    expect(other.attempt).toHaveBeenCalledExactlyOnceWith('ABCDEF')
    expect(desk.status()).toEqual({ paused: false, waiting: 0, hints: [], failures: 1, paired: { origin: STORE_ORIGIN, name: 'Brave', at: time.now() } })
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`a request from ${OTHER_ORIGIN} did not hold the entered code`))
    // Replayed: the code finds nothing to pair with.
    expect(await desk.enter('ABC-DEF')).toBe('none-waiting')
    expect(real.attempt).toHaveBeenCalledTimes(1)
  })

  it('reports a wrong code, input that is no code, and an unacknowledged token', async () => {
    const desk = new PairingDesk(clock().now)
    const real = waiting(desk, STORE_ORIGIN, 'ABCDEF')
    expect(await desk.enter('nope')).toBe('invalid')
    expect(await desk.enter('ABC-DE0')).toBe('invalid')
    expect(real.attempt).not.toHaveBeenCalled()
    expect(desk.status().waiting).toBe(1)
    // A wrong code consumes the request: it never sees a second code.
    expect(await desk.enter('ZZZ-ZZZ')).toBe('no-match')
    expect(await desk.enter('ABC-DEF')).toBe('none-waiting')
    expect(real.attempt).toHaveBeenCalledExactlyOnceWith('ZZZZZZ')
    expect(desk.status().failures).toBe(1)

    expect(desk.admit(STORE_ORIGIN)).toBeUndefined()
    desk.enqueue({ origin: STORE_ORIGIN, name: 'Brave' }, async () => 'unconfirmed', () => {})
    expect(await desk.enter('ABC-DEF')).toBe('unconfirmed')
    expect(desk.status().failures).toBe(1)
    // A throwing attempt counts as failed, never as paired.
    expect(desk.admit(STORE_ORIGIN)).toBeUndefined()
    desk.enqueue({ origin: STORE_ORIGIN, name: 'Brave' }, async () => { throw new Error('socket died') }, () => {})
    expect(await desk.enter('ABC-DEF')).toBe('no-match')
  })

  it('refuses a second code while one is being tried', async () => {
    const desk = new PairingDesk(clock().now)
    let finish!: (outcome: PairingAttemptOutcome) => void
    expect(desk.admit(STORE_ORIGIN)).toBeUndefined()
    desk.enqueue({ origin: STORE_ORIGIN, name: 'Brave' }, () => new Promise((resolve) => { finish = resolve }), () => {})
    const first = desk.enter('ABC-DEF')
    expect(await desk.enter('ABC-DEG')).toBe('busy')
    finish('paired')
    expect(await first).toBe('paired')
  })

  it('expires and withdraws requests without an attempt', async () => {
    const time = clock()
    const desk = new PairingDesk(time.now)
    const stale = waiting(desk, STORE_ORIGIN, 'ABCDEF')
    const gone = waiting(desk, OTHER_ORIGIN, 'ABCDEF')
    gone.withdraw()
    time.advance(PAIRING_REQUEST_TTL_MS)
    expect(await desk.enter('ABC-DEF')).toBe('none-waiting')
    expect(stale.drop).toHaveBeenCalledExactlyOnceWith('expired')
    expect(stale.attempt).not.toHaveBeenCalled()
    expect(gone.attempt).not.toHaveBeenCalled()
    expect(gone.drop).not.toHaveBeenCalled()
  })

  it('pauses after too many failed confirmations, visibly, until the user resumes', async () => {
    const time = clock()
    const log = vi.fn()
    const desk = new PairingDesk(time.now, log)
    for (let index = 0; index < MAX_FAILED_CONFIRMATIONS - 1; index += 1) {
      waiting(desk, forgedOrigin(index), 'QQQQQQ')
      expect(await desk.enter('ABC-DEF')).toBe('no-match')
    }
    expect(desk.status()).toMatchObject({ paused: false, failures: MAX_FAILED_CONFIRMATIONS - 1 })
    const last = waiting(desk, forgedOrigin(7), 'QQQQQQ')
    const bystander = waiting(desk, STORE_ORIGIN, 'HHHHHH')
    expect(await desk.enter('ABC-DEF')).toBe('no-match')
    expect(last.attempt).toHaveBeenCalledOnce()
    expect(bystander.attempt).toHaveBeenCalledOnce()
    expect(desk.status()).toMatchObject({ paused: true, pauseReason: 'failures', waiting: 0 })
    expect(log).toHaveBeenCalledWith('pairing: paused (too many failed attempts)')
    // Paused: no request is taken, no code is tried.
    expect(desk.admit(STORE_ORIGIN)).toBe('paused')
    expect(await desk.enter('ABC-DEF')).toBe('paused')
    // Time alone does not resume it.
    time.advance(FAILURE_WINDOW_MS * 2)
    expect(desk.admit(STORE_ORIGIN)).toBe('paused')
    desk.resumePairing()
    expect(desk.status()).toEqual({ paused: false, waiting: 0, hints: [], failures: 0 })
    const again = waiting(desk, STORE_ORIGIN, 'ABCDEF')
    expect(await desk.enter('ABC-DEF')).toBe('paired')
    expect(again.attempt).toHaveBeenCalledOnce()
  })

  it('forgets failures older than the window', async () => {
    const time = clock()
    const desk = new PairingDesk(time.now)
    for (let index = 0; index < MAX_FAILED_CONFIRMATIONS - 1; index += 1) {
      waiting(desk, forgedOrigin(index), 'QQQQQQ')
      await desk.enter('ABC-DEF')
    }
    time.advance(FAILURE_WINDOW_MS)
    waiting(desk, STORE_ORIGIN, 'QQQQQQ')
    expect(await desk.enter('ABC-DEF')).toBe('no-match')
    expect(desk.status()).toMatchObject({ paused: false, failures: 1 })
  })

  it('pauses on request and drops what was waiting', () => {
    const desk = new PairingDesk(clock().now)
    const request = waiting(desk, STORE_ORIGIN, 'ABCDEF')
    desk.pausePairing('user')
    expect(request.drop).toHaveBeenCalledExactlyOnceWith('paused')
    expect(desk.status()).toEqual({ paused: true, pauseReason: 'user', waiting: 0, hints: [], failures: 0 })
    expect(desk.admit(STORE_ORIGIN)).toBe('paused')
  })

  it('keeps one requester from starving the others', () => {
    const time = clock()
    const log = vi.fn()
    const desk = new PairingDesk(time.now, log)
    // One Origin: its third request replaces its own oldest, nobody else's.
    const mine = [waiting(desk, STORE_ORIGIN), waiting(desk, STORE_ORIGIN)]
    const victim = waiting(desk, OTHER_ORIGIN)
    expect(MAX_PENDING_PER_ORIGIN).toBe(2)
    waiting(desk, STORE_ORIGIN)
    expect(mine[0]!.drop).toHaveBeenCalledExactlyOnceWith('replaced')
    expect(victim.drop).not.toHaveBeenCalled()
    expect(desk.status().waiting).toBe(3)
    // One Origin's rate runs out; another Origin is still admitted.
    for (let index = 3; index < MAX_REQUESTS_PER_ORIGIN_PER_MINUTE; index += 1) expect(desk.admit(STORE_ORIGIN)).toBeUndefined()
    expect(desk.admit(STORE_ORIGIN)).toBe('rate')
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`refused a request from ${STORE_ORIGIN}`))
    expect(desk.admit(FIREFOX_ORIGIN)).toBeUndefined()
    time.advance(60_000)
    expect(desk.admit(STORE_ORIGIN)).toBeUndefined()
  })

  it('lets a newcomer in when forged origins fill the queue, at the cost of the busiest origin\'s oldest', () => {
    const time = clock()
    const desk = new PairingDesk(time.now)
    const flood = []
    for (let index = 0; index < MAX_PENDING_PAIRINGS; index += 1) flood.push(waiting(desk, forgedOrigin(index >> 1)))
    expect(desk.status().waiting).toBe(MAX_PENDING_PAIRINGS)
    const real = waiting(desk, STORE_ORIGIN, 'ABCDEF')
    expect(desk.status().waiting).toBe(MAX_PENDING_PAIRINGS)
    expect(flood[0]!.drop).toHaveBeenCalledExactlyOnceWith('replaced')
    expect(real.drop).not.toHaveBeenCalled()
    // The global rate still bounds a flood that forges a new Origin every time.
    for (let index = MAX_PENDING_PAIRINGS + 1; index < MAX_REQUESTS_PER_MINUTE; index += 1) expect(desk.admit(forgedOrigin(index % 12))).not.toBe('paused')
    expect(desk.admit('chrome-extension://cccccccccccccccccccccccccccccccc')).toBe('rate')
  })

  it('reads the paired-extension record only when it can be trusted, and persists changes privately', async () => {
    const dir = newDir()
    const file = join(dir, 'paired.json')
    const record = await filePairedExtensions(file)
    expect(record.list()).toEqual([])
    await record.add(STORE_ID)
    await record.add('not-an-id')
    await record.add(STORE_ID)
    await record.add(OTHER_ID)
    expect(record.list()).toEqual([STORE_ID, OTHER_ID])
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, chromeExtensionIds: [STORE_ID, OTHER_ID] })
    expect((await filePairedExtensions(file)).list()).toEqual([STORE_ID, OTHER_ID])

    expect(await record.remove(STORE_ID)).toBe(true)
    expect(await record.remove(STORE_ID)).toBe(false)
    expect((await filePairedExtensions(file)).list()).toEqual([OTHER_ID])

    // A file someone else could have written grants nothing.
    if (process.platform !== 'win32') {
      await chmod(file, 0o666)
      const warn = vi.fn()
      expect((await filePairedExtensions(file, warn)).list()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('writable by group or others'))
      const link = join(dir, 'link.json')
      await chmod(file, 0o600)
      await symlink(file, link)
      expect((await filePairedExtensions(link, warn)).list()).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('symlink'))
    }
    await writeFile(file, '{"chromeExtensionIds":"nope"}', { mode: 0o600 })
    expect((await filePairedExtensions(file)).list()).toEqual([])
    await writeFile(file, 'not json', { mode: 0o600 })
    expect((await filePairedExtensions(file)).list()).toEqual([])
    const full = await filePairedExtensions(join(dir, 'many.json'))
    const many = Array.from({ length: MAX_PAIRED_EXTENSION_IDS + 3 }, (_, index) => `${'a'.repeat(30)}${String.fromCharCode(97 + (index >> 4))}${String.fromCharCode(97 + (index & 15))}`)
    for (const id of many) await full.add(id)
    expect(full.list()).toEqual(many.slice(-MAX_PAIRED_EXTENSION_IDS))
    expect(chromeExtensionIdOfOrigin(STORE_ORIGIN)).toBe(STORE_ID)
    expect(chromeExtensionIdOfOrigin(FIREFOX_ORIGIN)).toBeUndefined()
  })
})

describe('pairing on the bridge socket (server.ts)', () => {
  async function startPairingBridge(overrides: Partial<Parameters<typeof startTestBridge>[0]> = {}) {
    const time = clock()
    const log = vi.fn()
    const desk = new PairingDesk(time.now, log)
    const onPaired = vi.fn()
    const started = await startTestBridge({ pairing: desk, onPaired, pairingStepTimeoutMs: 400, ...overrides })
    /** Wait until the bridge holds `count` requests. */
    const waitingFor = (count = 1) => waitFor(() => desk.status().waiting >= count)
    return { ...started, desk, onPaired, time, log, waitingFor }
  }
  /** Frames a peer received that carry anything keyed (a MAC or a box). */
  const keyed = (frames: BridgeFrame[]): BridgeFrame[] => frames.filter(frame => 'mac' in frame || 'box' in frame)

  it('pairs a store-installed extension once the user types the code its panel shows', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN, name: 'Brave' })
    await h.waitingFor()
    // Waiting: the host knows a browser is there and what it says it is. Nothing was sent to it.
    expect(h.desk.status()).toMatchObject({ waiting: 1, hints: ['Brave'] })
    expect(asking.socket.frames.map(frame => frame.t)).toEqual(['challenge'])
    expect(h.onPaired).not.toHaveBeenCalled()
    const early = await openSocket(h.url, STORE_ORIGIN)
    await sendHello(early.ws, TEST_TOKEN, TEST_CAPS)
    expect((await early.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)

    expect(await h.desk.enter(formatPairingCode(asking.code).toLowerCase())).toBe('paired')
    expect(await asking.outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    expect(h.desk.status()).toMatchObject({ waiting: 0, failures: 0, paired: { origin: STORE_ORIGIN, name: 'Brave' } })

    // The paired build now authenticates with the ordinary handshake.
    const client = await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
    expect(client.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
    expect(h.bridge.connectionCount()).toBe(1)
  })

  it('never puts the code or the token on the wire, and a recorded run is not reusable', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    expect(await h.desk.enter(asking.code)).toBe('paired')
    const outcome = await asking.outcome
    expect(outcome.ok).toBe(true)
    const wire = JSON.stringify(outcome.frames)
    expect(wire).not.toContain(TEST_TOKEN)
    expect(wire).not.toContain(Buffer.from(TEST_TOKEN).toString('hex'))
    expect(wire).not.toContain(asking.code)
    // An eavesdropper replays the bridge's recorded frames at a fresh client that
    // even knows the code: without the bridge's secret no key opens the recorded box.
    const recorded = outcome.frames.find(frame => frame.t === 'pair.ok') as Extract<BridgeFrame, { t: 'pair.ok' }>
    const recordedShare = outcome.frames.find(frame => frame.t === 'pair.share') as Extract<BridgeFrame, { t: 'pair.share' }>
    const context: PairingContext = { ...CONTEXT, code: asking.code }
    const victim = createPairingShare(context)
    const keys = derivePairingKeys(context, victim.secret, victim.share, recordedShare.share, 'client')!
    expect(openPairingToken(keys, recorded.box, recorded.mac)).toBeUndefined()
  })

  it('regression (review PoC): a forged-Origin requester gets no token without the code, whatever is entered', async () => {
    const h = await startPairingBridge()
    // A local process forges the pinned extension's Origin and asks; it does not know any code the user will type.
    const forged = await ask(h.url, { origin: PINNED_ORIGIN, name: 'Chrome', code: 'QQQQQQ' })
    await h.waitingFor()
    // There is nothing to click: the only host action is entering a code, and the user's code is not the forger's.
    expect(await h.desk.enter('ABC-DEF')).toBe('no-match')
    const outcome = await forged.outcome
    expect(outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    // All it ever received: the challenge and one group element. Nothing keyed by the user's code.
    expect(outcome.frames.map(frame => frame.t)).toEqual(['challenge', 'pair.share'])
    expect(keyed(outcome.frames)).toEqual([])
    expect(h.onPaired).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`a request from ${PINNED_ORIGIN} did not hold the entered code`))
  })

  it('pairs only the genuine request when an attacker\'s request is waiting too, and the attacker learns nothing keyed', async () => {
    const h = await startPairingBridge()
    const attacker = await ask(h.url, { origin: OTHER_ORIGIN, code: 'QQQQQQ' })
    const genuine = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor(2)
    expect(await h.desk.enter(genuine.code)).toBe('paired')
    expect(await genuine.outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    const lost = await attacker.outcome
    expect(lost).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(lost.frames.map(frame => frame.t)).toEqual(['challenge', 'pair.share'])
    expect(keyed(lost.frames)).toEqual([])
    // Its one group element is a valid subgroup member, like any other: by itself it tests no code.
    expect(isPairingShare((lost.frames[1] as Extract<BridgeFrame, { t: 'pair.share' }>).share)).toBe(true)
    expect(h.onPaired).toHaveBeenCalledExactlyOnceWith({ origin: STORE_ORIGIN, chromeExtensionId: STORE_ID })
    expect(h.desk.status().failures).toBe(1)
    // The attacker's extension is still unknown to the bridge.
    const hello = await openSocket(h.url, OTHER_ORIGIN)
    await sendHello(hello.ws, TEST_TOKEN, TEST_CAPS)
    expect((await hello.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('offers no offline oracle: an unconfirmed peer is never sent a MAC, and its transcript fits every code', async () => {
    const h = await startPairingBridge()
    // A requester that stops after the bridge's share (it wants something to brute-force at home).
    const socket = await openSocket(h.url, OTHER_ORIGIN)
    const serverNonce = await challengeOf(socket)
    const context: PairingContext = { code: 'QQQQQQ', serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(socket.ws), origin: OTHER_ORIGIN, name: 'Chrome' }
    const own = createPairingShare(context)
    socket.ws.send(JSON.stringify({ t: 'pair.request', v: 1, nonce: context.clientNonce, endpoint: context.endpoint, origin: OTHER_ORIGIN, name: 'Chrome', share: own.share }))
    await h.waitingFor()
    const entered = h.desk.enter('ABC-DEF')
    await waitFor(() => socket.frames.some(frame => frame.t === 'pair.share'))
    // It never confirms: the step times out, the socket is closed, the attempt counts.
    expect(await entered).toBe('no-match')
    expect((await socket.closed).code).toBe(BRIDGE_CLOSE_CODES.pairingFailed)
    expect(socket.frames.map(frame => frame.t)).toEqual(['challenge', 'pair.share'])
    expect(keyed(socket.frames)).toEqual([])
    // What it holds: its own secret and the bridge's share. For ANY candidate code there is a bridge
    // secret that explains that share (the share is in the subgroup every code's generator spans),
    // so the transcript rules no code out. Shown here for two candidates by the group's structure:
    const share = (socket.frames[1] as Extract<BridgeFrame, { t: 'pair.share' }>).share
    for (const candidate of ['ABCDEF', 'ZZZZZZ']) {
      const generator = pairingShareFor({ ...context, code: candidate }, 1n)
      expect(isPairingShare(generator)).toBe(true)
      expect(isPairingShare(share)).toBe(true)
    }
    expect(h.desk.status().failures).toBe(1)
  })

  it('consumes a request with one wrong code: the right code typed afterwards finds nothing', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    const wrong = asking.code.startsWith('A') ? `B${asking.code.slice(1)}` : `A${asking.code.slice(1)}`
    expect(await h.desk.enter(wrong)).toBe('no-match')
    expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(await h.desk.enter(asking.code)).toBe('none-waiting')
    expect(h.onPaired).not.toHaveBeenCalled()
    // Replay of a used code after a success pairs nobody either.
    const second = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    expect(await h.desk.enter(second.code)).toBe('paired')
    const third = await ask(h.url, { origin: OTHER_ORIGIN, code: 'QQQQQQ' })
    await h.waitingFor()
    expect(await h.desk.enter(second.code)).toBe('no-match')
    expect((await third.outcome).ok).toBe(false)
    expect(h.onPaired).toHaveBeenCalledTimes(1)
  })

  it('expires a request nobody entered a code for, and removes one whose browser went away', async () => {
    const h = await startPairingBridge()
    const stale = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    h.time.advance(PAIRING_REQUEST_TTL_MS)
    expect(await h.desk.enter(stale.code)).toBe('none-waiting')
    expect(await stale.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed, reason: 'the pairing request expired' })

    const gone = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    gone.socket.ws.terminate()
    await waitFor(() => h.desk.status().waiting === 0)
    expect(await h.desk.enter(gone.code)).toBe('none-waiting')
    expect(h.onPaired).not.toHaveBeenCalled()
  })

  it('pauses after repeated wrong codes and refuses requests until resumed', async () => {
    const h = await startPairingBridge()
    for (let index = 0; index < MAX_FAILED_CONFIRMATIONS; index += 1) {
      const guess = await ask(h.url, { origin: forgedOrigin(index), code: 'QQQQQQ' })
      await h.waitingFor()
      expect(await h.desk.enter('ABC-DEF')).toBe('no-match')
      expect((await guess.outcome).ok).toBe(false)
    }
    expect(h.desk.status()).toMatchObject({ paused: true, pauseReason: 'failures' })
    const refused = await ask(h.url, { origin: STORE_ORIGIN })
    expect(await refused.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingPaused })
    expect(await h.desk.enter(refused.code)).toBe('paused')
    h.desk.resumePairing()
    const again = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    expect(await h.desk.enter(again.code)).toBe('paired')
    expect((await again.outcome).ok).toBe(true)
  })

  it('closes waiting requests when the user pauses pairing', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    h.desk.pausePairing('user')
    expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingPaused })
  })

  it('does not let one flooding requester keep the genuine one out', async () => {
    const h = await startPairingBridge()
    const flood = []
    for (let index = 0; index < MAX_PENDING_PAIRINGS; index += 1) flood.push(await ask(h.url, { origin: forgedOrigin(index >> 1), code: 'QQQQQQ' }))
    await h.waitingFor(MAX_PENDING_PAIRINGS)
    const genuine = await ask(h.url, { origin: STORE_ORIGIN })
    await waitFor(() => flood[0]!.socket.ws.readyState === WebSocket.CLOSED)
    expect(await flood[0]!.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
    expect(await h.desk.enter(genuine.code)).toBe('paired')
    expect((await genuine.outcome).ok).toBe(true)
    // The flood's requests rode on that one code, failed, and paused pairing.
    for (const one of flood.slice(1)) expect((await one.outcome).ok).toBe(false)
    expect(h.desk.status()).toMatchObject({ paused: true, pauseReason: 'failures' })
    expect(h.onPaired).toHaveBeenCalledTimes(1)
  })

  it('does not let a second extension ride on a pairing meant for another', async () => {
    const h = await startPairingBridge()
    // The other extension relays the real one's exchange over its own socket.
    // Claiming the real origin contradicts the socket's Origin header...
    const forged = await ask(h.url, { origin: OTHER_ORIGIN, as: STORE_ORIGIN })
    expect(await forged.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(h.desk.status().waiting).toBe(0)
    // ...and claiming its own makes the two halves key different exchanges,
    // even though the real extension's code is the one the user types.
    const relayed = await ask(h.url, { origin: OTHER_ORIGIN, as: STORE_ORIGIN, claim: OTHER_ORIGIN })
    await h.waitingFor()
    expect(await h.desk.enter(relayed.code)).toBe('no-match')
    const outcome = await relayed.outcome
    expect(outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed })
    expect(keyed(outcome.frames)).toEqual([])
    expect(h.onPaired).not.toHaveBeenCalled()
  })

  it('takes requests only from extension origins that describe the socket', async () => {
    const h = await startPairingBridge()
    // Web pages and anything that is not exactly an extension origin are refused before a frame is read.
    for (const origin of ['https://evil.example', 'http://127.0.0.1:3080', 'null']) {
      const asking = await ask(h.url, { origin })
      expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    }
    // A Firefox-looking Origin that is not exactly an extension origin reaches the frame check and fails it.
    expect(await (await ask(h.url, { origin: 'moz-extension://per-install-uuid extra' })).outcome).toMatchObject({ ok: false, code: 1008 })
    // A client without an Origin (a local process that does not bother to forge one) cannot pair.
    const socket = await openSocket(h.url)
    const serverNonce = await challengeOf(socket)
    const context: PairingContext = { ...CONTEXT, serverNonce, clientNonce: createBridgeNonce(), endpoint: endpointOf(socket.ws) }
    socket.ws.send(JSON.stringify({ t: 'pair.request', v: 1, nonce: context.clientNonce, endpoint: context.endpoint, origin: STORE_ORIGIN, name: 'Brave', share: createPairingShare(context).share }))
    expect((await socket.closed).code).toBe(BRIDGE_CLOSE_CODES.pairingFailed)
    // A share outside the subgroup is refused.
    const odd = await openSocket(h.url, STORE_ORIGIN)
    const nonce = await challengeOf(odd)
    odd.ws.send(JSON.stringify({ t: 'pair.request', v: 1, nonce: createBridgeNonce(), endpoint: endpointOf(odd.ws), origin: STORE_ORIGIN, name: 'Brave', share: hex(P - 4n) }))
    expect(await odd.closed).toMatchObject({ code: BRIDGE_CLOSE_CODES.pairingFailed, reason: 'pairing failed: malformed share' })
    expect(nonce).toHaveLength(64)
    expect(h.desk.status().waiting).toBe(0)

    // A bridge without pairing admits no unknown extension at all.
    const plain = await startTestBridge()
    expect(await (await ask(plain.url, { origin: STORE_ORIGIN })).outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.originRejected })
    expect(await (await ask(plain.url, { origin: PINNED_ORIGIN })).outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingClosed })
  })

  it('refuses a request relayed from another port', async () => {
    const h = await startPairingBridge({ localEndpointOverride: { host: '127.0.0.1', port: 1 } })
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    expect(await asking.outcome).toMatchObject({ ok: false, code: BRIDGE_CLOSE_CODES.pairingFailed, reason: 'pairing failed: endpoint mismatch' })
    expect(h.desk.status().waiting).toBe(0)
  })

  it('lets a pairing socket pair and nothing else', async () => {
    const h = await startPairingBridge()
    // An unknown extension that sends hello is refused, right token or not.
    const socket = await openSocket(h.url, OTHER_ORIGIN)
    await sendHello(socket.ws, TEST_TOKEN, TEST_CAPS)
    expect((await socket.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)

    // Out of order: a confirmation nobody asked for.
    const early = await openSocket(h.url, STORE_ORIGIN)
    await challengeOf(early)
    early.ws.send(JSON.stringify({ t: 'pair.confirm', mac: 'a'.repeat(64) }))
    expect((await early.closed).code).toBe(1008)

    // A waiting request that sends anything else (a second request, a hello) is closed, never promoted.
    const twice = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    twice.socket.ws.send(JSON.stringify({ t: 'pair.confirm', mac: 'a'.repeat(64) }))
    expect(await twice.outcome).toMatchObject({ ok: false, code: 1008 })
    const waitingSocket = await ask(h.url, { origin: STORE_ORIGIN })
    await waitFor(() => h.desk.status().waiting === 1)
    await sendHello(waitingSocket.socket.ws, TEST_TOKEN, TEST_CAPS)
    expect(await waitingSocket.outcome).toMatchObject({ ok: false, code: 1008 })
    await waitFor(() => h.desk.status().waiting === 0)
    expect(h.bridge.connectionCount()).toBe(0)
  })

  it('says "unconfirmed" when the requester held the code but never acknowledged the token', async () => {
    const h = await startPairingBridge()
    const asking = await ask(h.url, { origin: STORE_ORIGIN, acknowledge: false })
    await h.waitingFor()
    expect(await h.desk.enter(asking.code)).toBe('unconfirmed')
    expect((await asking.outcome).ok).toBe(true)
  })

  it('leaves already-paired extensions alone: handshake, connection and allowlist are unchanged', async () => {
    const h = await startPairingBridge()
    const before = await connectClient(h.url, TEST_CAPS, { origin: PINNED_ORIGIN })
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    // While another extension waits the installed one still connects with the same handshake...
    const during = await connectClient(h.url, { ...TEST_CAPS, client: { id: 'second-install', browser: 'chrome' } }, { origin: PINNED_ORIGIN })
    expect(during.frames.some(frame => frame.t === 'hello.ok')).toBe(true)
    // ...a wrong token is still refused...
    const wrong = await openSocket(h.url, PINNED_ORIGIN)
    await sendHello(wrong.ws, 'f'.repeat(32), TEST_CAPS)
    expect((await wrong.closed).code).toBe(BRIDGE_CLOSE_CODES.authFailed)
    // ...and the pairing does not disturb live connections.
    expect(await h.desk.enter(asking.code)).toBe('paired')
    expect((await asking.outcome).ok).toBe(true)
    expect(h.bridge.connectionCount()).toBe(2)
    expect((await before.rpc('session.list', {})).ok).toBe(true)
    expect(before.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('pairs a Firefox extension (nothing to allowlist) and unpairs a Chrome one', async () => {
    const h = await startPairingBridge()
    const firefox = await ask(h.url, { origin: FIREFOX_ORIGIN, name: 'Firefox' })
    await h.waitingFor()
    expect(await h.desk.enter(firefox.code)).toBe('paired')
    expect(await firefox.outcome).toMatchObject({ ok: true, token: TEST_TOKEN })
    expect(h.onPaired).toHaveBeenLastCalledWith({ origin: FIREFOX_ORIGIN })

    const chrome = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    expect(await h.desk.enter(chrome.code)).toBe('paired')
    await chrome.outcome
    await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
    // Unpaired: its next handshake is refused at the Origin check, token or not.
    expect(h.bridge.revokeChromeExtensionId(STORE_ID)).toBe(true)
    expect(h.bridge.revokeChromeExtensionId(STORE_ID)).toBe(false)
    const hello = await openSocket(h.url, STORE_ORIGIN)
    await sendHello(hello.ws, TEST_TOKEN, TEST_CAPS)
    expect((await hello.closed).code).toBe(BRIDGE_CLOSE_CODES.originRejected)
  })

  it('survives a throwing pairing observer', async () => {
    const h = await startPairingBridge({ onPaired: () => { throw new Error('disk full') } })
    const asking = await ask(h.url, { origin: STORE_ORIGIN })
    await h.waitingFor()
    expect(await h.desk.enter(asking.code)).toBe('paired')
    await connectClient(h.url, TEST_CAPS, { origin: STORE_ORIGIN })
  })
})

describe('host-side pairing controls (pairing-mount.ts)', () => {
  const post = (body: unknown, contentType = 'application/json'): Request => new Request(`http://127.0.0.1${PAIRING_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  function controls(desk = new PairingDesk(clock().now)): PairingControls & { ids: string[] } {
    const ids = [STORE_ID]
    return {
      desk,
      ids,
      pairedIds: () => [...ids],
      unpair: async (id) => {
        const index = ids.indexOf(id)
        if (index >= 0) ids.splice(index, 1)
        return index >= 0
      },
    }
  }
  const holding = (desk: PairingDesk, code: string, origin = STORE_ORIGIN, name = 'Brave') => {
    const attempt = vi.fn(async (typed: string): Promise<PairingAttemptOutcome> => typed === code ? 'paired' : 'failed')
    desk.admit(origin)
    desk.enqueue({ origin, name }, attempt, () => {})
    return attempt
  }

  it('reports status without any code, and enters, pauses, resumes and unpairs through the control route', async () => {
    const control = controls()
    const idle = await handlePairingControl(control, post({ action: 'status' }))
    expect(idle.headers.get('cache-control')).toBe('no-store')
    expect(await idle.json()).toEqual({ ok: true, paused: false, waiting: 0, hints: [], failures: 0, pairedIds: [STORE_ID] })

    holding(control.desk, 'ABCDEF')
    const waiting = await (await handlePairingControl(control, post({ action: 'status' }))).json()
    expect(waiting).toMatchObject({ waiting: 1, hints: ['Brave'] })
    expect(JSON.stringify(waiting)).not.toMatch(/ABC|origin/u)

    const wrong = await (await handlePairingControl(control, post({ action: 'enter', code: 'zzz-zzz' }))).json()
    expect(wrong).toMatchObject({ ok: true, result: 'no-match', waiting: 0, failures: 1 })
    holding(control.desk, 'ABCDEF')
    const right = await (await handlePairingControl(control, post({ action: 'enter', code: 'abc-def' }))).json()
    expect(right).toMatchObject({ ok: true, result: 'paired', paired: { origin: STORE_ORIGIN, name: 'Brave' } })
    expect((await (await handlePairingControl(control, post({ action: 'enter', code: 'abc-def' }))).json())).toMatchObject({ result: 'none-waiting' })

    expect(await (await handlePairingControl(control, post({ action: 'pause' }))).json()).toMatchObject({ paused: true, pauseReason: 'user' })
    expect(await (await handlePairingControl(control, post({ action: 'enter', code: 'abc-def' }))).json()).toMatchObject({ result: 'paused' })
    expect(await (await handlePairingControl(control, post({ action: 'resume' }))).json()).toMatchObject({ paused: false })

    expect(await (await handlePairingControl(control, post({ action: 'unpair', id: STORE_ID }))).json()).toMatchObject({ ok: true, pairedIds: [] })
    expect((await handlePairingControl(control, post({ action: 'unpair', id: STORE_ID }))).status).toBe(404)
  })

  it('answers 400/415 to anything else and attempts nothing', async () => {
    const control = controls()
    const attempt = holding(control.desk, 'ABCDEF')
    for (const body of [{ action: 'approve', id: 'p1' }, { action: 'enter' }, { action: 'enter', code: 7 }, { action: 'enter', code: 'A'.repeat(100) }, { action: 'unpair' }, 'not json', 'null']) {
      expect((await handlePairingControl(control, post(body))).status).toBe(400)
    }
    // A form or plain-text post (what a page can send without a preflight) is not read at all.
    expect((await handlePairingControl(control, post({ action: 'enter', code: 'ABC-DEF' }, 'text/plain'))).status).toBe(415)
    expect((await handlePairingControl(control, post('action=enter&code=ABCDEF', 'application/x-www-form-urlencoded'))).status).toBe(415)
    expect(attempt).not.toHaveBeenCalled()
    expect(control.desk.status().waiting).toBe(1)
  })

  it('runs /browser-pair and never echoes what was typed', async () => {
    const control = controls()
    expect(await runPairingCommand(control, '')).toEqual({
      kind: 'success',
      text: `No browser is waiting. Open the DSH browser extension; it shows a code.\nPaired extensions: ${STORE_ID} (/browser-pair unpair <id> removes one).`,
    })
    holding(control.desk, 'ABCDEF')
    expect((await runPairingCommand(control, '  ')).text).toContain('1 browser is waiting. Enter the code your browser shows: /browser-pair <code>.')
    expect(await runPairingCommand(control, 'not\u009b[2Ja-code')).toEqual({ kind: 'error', text: 'A pairing code has 6 letters and digits, like ABC-DEF.' })
    expect(await runPairingCommand(control, 'ZZZ-ZZZ')).toMatchObject({ kind: 'error', text: expect.stringContaining('No waiting browser shows that code') })
    expect(await runPairingCommand(control, 'ABC-DEF')).toMatchObject({ kind: 'error', text: expect.stringContaining('No browser is waiting') })
    holding(control.desk, 'ABCDEF')
    expect(await runPairingCommand(control, 'abc def')).toEqual({ kind: 'success', text: 'Paired. The browser connects by itself now.' })

    expect((await runPairingCommand(control, 'pause')).kind).toBe('success')
    expect((await runPairingCommand(control, '')).text).toContain('Pairing is paused.')
    expect(await runPairingCommand(control, 'ABC-DEF')).toMatchObject({ kind: 'error', text: expect.stringContaining('/browser-pair resume') })
    expect((await runPairingCommand(control, 'Resume')).kind).toBe('success')
    expect(await runPairingCommand(control, `unpair ${STORE_ID}`)).toMatchObject({ kind: 'success', text: expect.stringContaining('still holds the bridge token') })
    expect(await runPairingCommand(control, `unpair ${STORE_ID}`)).toEqual({ kind: 'error', text: 'That is not a paired extension ID.' })
    expect((await runPairingCommand(control, '')).text).toContain('No extension has been paired.')
  })

  it('registers the route and the command only where the composition has them', async () => {
    const control = controls()
    expect(mountPairingControls(control, {})).toEqual([])
    const routes: Array<Parameters<NonNullable<Parameters<typeof mountPairingControls>[1]['fetch']>['register']>[0]> = []
    const commands: Array<Parameters<NonNullable<Parameters<typeof mountPairingControls>[1]['commands']>['register']>[0]> = []
    const disposeRoute = vi.fn()
    const disposeCommand = vi.fn()
    const disposers = mountPairingControls(control, {
      fetch: { register: (route) => { routes.push(route); return disposeRoute } },
      commands: { register: (definition) => { commands.push(definition); return disposeCommand } },
    })
    expect(disposers).toEqual([disposeRoute, disposeCommand])
    expect(routes[0]).toMatchObject({ path: PAIRING_API_PATH, methods: ['POST'], requestBody: 'buffered' })
    // The typed code stays out of the session log.
    expect(commands[0]).toMatchObject({ name: PAIRING_COMMAND_NAME, recordInput: false })
    expect(await commands[0]!.handler({ rawInput: '' })).toMatchObject({ kind: 'success' })
    expect(await (await routes[0]!.fetch(post({ action: 'status' }))).json()).toMatchObject({ ok: true, waiting: 0 })
  })
})
