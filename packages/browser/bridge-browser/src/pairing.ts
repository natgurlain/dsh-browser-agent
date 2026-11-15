/**
 * One-step pairing: how an extension without a bridge token (a Web Store or
 * Brave build, Firefox) obtains it. The extension shows a short random code;
 * the user types that code once into DSH.
 *
 * The code is short (6 symbols, 30 bits), so it must never be testable
 * offline, by a rogue bridge or by a rogue requester. Both halves therefore
 * run a balanced PAKE keyed by the code (CPace-style, in the prime-order
 * subgroup of the RFC 3526 3072-bit MODP group, p = 2q + 1):
 *
 *   g  = H(code, Ns, Nc, endpoint, origin)^2 mod p       (the code picks the generator)
 *   Yc = g^a   (extension, sent with the request)         Ys = g'^b   (bridge, after the user typed code')
 *   K  = Ys^a = Yc^b                                      (equal exactly when code' = code)
 *   master = HMAC(label, K ‖ transcript)
 *   keys   = HMAC(master, "confirm|client" | "confirm|server" | "token" | "done")
 *
 * A share is a uniformly distributed element of the subgroup whatever the
 * code, so seeing shares tests nothing. Each run lets one active party check
 * exactly one guess: the generator it committed to with its own share. The
 * extension confirms first (`pair.confirm`); the bridge answers only a
 * confirmation that verifies, so a requester that holds another code
 * receives one group element and a close, nothing keyed. The bridge's own
 * confirmation travels with the token (`pair.ok`), and the extension stores
 * nothing unless it verifies: a peer that was never given the code cannot
 * make the extension accept a token.
 *
 * The transcript both confirmations cover names both nonces, the endpoint
 * the client dialed, the extension origin as each half sees it, the browser
 * name, and both shares, so the exchange cannot be relayed through another
 * extension or another port.
 *
 * Portable: runs unchanged in node and in the extension's service worker
 * (BigInt, the synchronous SHA-256 of protocol.ts, WebCrypto randomness).
 *
 * @module
 */

import {
  PAIRING_PROTOCOL_VERSION,
  PAIRING_SHARE_HEX_LENGTH,
  constantTimeEqual,
  hmacSha256,
  isBridgeHex256,
  isPairingShareHex,
  type BridgeEndpoint,
} from './protocol.ts'

/** Symbols of a pairing code: 32 of them, without the look-alikes I, O, 0 and 1. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Symbols in one pairing code (5 bits each: 30 bits). */
export const PAIRING_CODE_LENGTH = 6

/** Longest token a pairing exchange carries (matches the extension's own token bound). */
export const PAIRING_TOKEN_MAX_BYTES = 1024

/**
 * RFC 3526 group 15: a 3072-bit safe prime (p = 2q + 1 with q prime), so the
 * squares form the subgroup of prime order q. pairing.spec checks these
 * digits against node's built-in `modp15`.
 */
export const PAIRING_PRIME_HEX = [
  'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404dd',
  'ef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed',
  'ee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f',
  '83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3b',
  'e39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa0510',
  '15728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7',
  'abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200c',
  'bbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff',
].join('')

const P = BigInt(`0x${PAIRING_PRIME_HEX}`)
const LABEL = `dsh-pair/v${String(PAIRING_PROTOCOL_VERSION)}`
const utf8 = new TextEncoder()
const CODE_SHAPE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${String(PAIRING_CODE_LENGTH)}}$`, 'u')

/** What one exchange is bound to; both halves must agree on every field. */
export interface PairingContext {
  /** The pairing code (normalized). The extension's own; on the bridge, what the user typed. */
  code: string
  /** The bridge's `challenge` nonce. */
  serverNonce: string
  /** The client's `pair.request` nonce. */
  clientNonce: string
  /** The endpoint the client dialed (the bridge checks it against its socket). */
  endpoint: BridgeEndpoint
  /** The client's extension origin; on the bridge, the socket's Origin header. */
  origin: string
  /** The browser name carried by the request (a hint, bound so it cannot be swapped). */
  name: string
}

/** One half's secret exponent and the share it sends. */
export interface PairingShare {
  secret: bigint
  share: string
}

/** Keys both halves derive from a completed exchange. */
export interface PairingKeys {
  /** Canonical transcript every MAC covers. */
  transcript: string
  clientConfirmKey: Uint8Array
  serverConfirmKey: Uint8Array
  tokenKey: Uint8Array
  doneKey: Uint8Array
}

/**
 * A fresh pairing code from the platform CSPRNG.
 * @returns {@link PAIRING_CODE_LENGTH} symbols of {@link PAIRING_CODE_ALPHABET}.
 */
export function generatePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let code = ''
  // 256 is a multiple of 32, so the low five bits are uniform.
  for (const byte of bytes) code += PAIRING_CODE_ALPHABET[byte & 31]
  return code
}

/**
 * Canonical form of a code as the user typed it: case, spaces and dashes are
 * ignored. Nothing is guessed (a `0` or `1` is simply not a code symbol).
 * @returns the code, or `undefined` when the input cannot be one.
 */
export function normalizePairingCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/gu, '').toUpperCase()
  return CODE_SHAPE.test(code) ? code : undefined
}

/** A code as shown to the user: two groups of three. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = base % modulus
  let rest = exponent
  while (rest > 0n) {
    if ((rest & 1n) === 1n) result = result * factor % modulus
    factor = factor * factor % modulus
    rest >>= 1n
  }
  return result
}

/**
 * Jacobi symbol (a/n) for odd n > 0. For the prime p it is the Legendre
 * symbol: 1 exactly for the nonzero squares, which are the subgroup of order q.
 */
function jacobi(value: bigint, modulus: bigint): number {
  let a = value % modulus
  let n = modulus
  let sign = 1
  while (a !== 0n) {
    while ((a & 1n) === 0n) {
      a >>= 1n
      const r = n & 7n
      if (r === 3n || r === 5n) sign = -sign
    }
    const swap = a
    a = n
    n = swap
    if ((a & 3n) === 3n && (n & 3n) === 3n) sign = -sign
    a %= n
  }
  return n === 1n ? sign : 0
}

function shareHex(value: bigint): string {
  return value.toString(16).padStart(PAIRING_SHARE_HEX_LENGTH, '0')
}

/** Fields that cannot contain `|` are joined bare; the origin and the name are length-prefixed. */
function contextText(context: PairingContext): string {
  return `${context.serverNonce}|${context.clientNonce}|${context.endpoint.host}|${String(context.endpoint.port)}`
    + `|${String(context.origin.length)}:${context.origin}|${String(context.name.length)}:${context.name}`
}

/**
 * The generator one code selects for one exchange: a hash of the code and the
 * exchange's public context, reduced into the group and squared into the
 * prime-order subgroup. 416 hash bytes (128 bits more than the prime) keep
 * the reduction's bias negligible. Nobody knows the discrete logarithm of
 * one code's generator to another's.
 */
function pairingGenerator(context: PairingContext): bigint {
  const message = utf8.encode(`${String(context.code.length)}:${context.code}|${contextText(context)}`)
  const key = utf8.encode(`${LABEL}|generator`)
  const blocks: Uint8Array[] = []
  for (let counter = 0; counter < 13; counter += 1) blocks.push(hmacSha256(key, concat(Uint8Array.of(counter), message)))
  const reduced = BigInt(`0x${toHex(concat(...blocks))}`) % P
  // 0, 1 and p - 1 square to 0 or 1; a hash lands there with negligible probability.
  const base = reduced < 2n || reduced === P - 1n ? 2n : reduced
  return base * base % P
}

/**
 * Whether a received share is usable: well-formed, in range, and a member of
 * the prime-order subgroup other than the identity. Anything else could
 * confine the key to a small set whatever the code.
 * @param share - the peer's share as received.
 */
export function isPairingShare(share: unknown): share is string {
  if (!isPairingShareHex(share)) return false
  const value = BigInt(`0x${share}`)
  return value > 1n && value < P - 1n && jacobi(value, P) === 1
}

/**
 * One half's contribution, from a given secret (exposed for test vectors;
 * callers use {@link createPairingShare}).
 * @param context - what the exchange is bound to, including the code.
 * @param secret - the exponent.
 */
export function pairingShareFor(context: PairingContext, secret: bigint): string {
  return shareHex(modPow(pairingGenerator(context), secret, P))
}

/**
 * One half's contribution to an exchange.
 * @param context - what the exchange is bound to (this half's view, including the code).
 * @returns a fresh 256-bit secret and the share to send.
 */
export function createPairingShare(context: PairingContext): PairingShare {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  // Never 0 or 1: the share must not be the identity or the bare generator.
  const secret = BigInt(`0x${toHex(bytes)}`) + 2n
  return { secret, share: pairingShareFor(context, secret) }
}

/**
 * Derive the exchange keys from this half's secret and the peer's share.
 * @param context - what the exchange is bound to (this half's view).
 * @param secret - this half's secret.
 * @param clientShare - the share the client sent.
 * @param serverShare - the share the bridge sent.
 * @param role - which half is deriving (it uses the other one's share).
 * @returns the keys, or `undefined` when a share is unusable.
 */
export function derivePairingKeys(
  context: PairingContext,
  secret: bigint,
  clientShare: string,
  serverShare: string,
  role: 'client' | 'server',
): PairingKeys | undefined {
  const peer = role === 'client' ? serverShare : clientShare
  if (!isPairingShare(peer) || !isPairingShareHex(clientShare) || !isPairingShareHex(serverShare)) return undefined
  const shared = modPow(BigInt(`0x${peer}`), secret, P)
  /* v8 ignore next -- a subgroup member other than 1 has prime order: its powers by a nonzero exponent below q are never 1 */
  if (shared <= 1n) return undefined
  const transcript = `${LABEL}|${contextText(context)}|${clientShare}|${serverShare}`
  const master = hmacSha256(utf8.encode(`${LABEL}|master`), concat(fromHex(shareHex(shared)), utf8.encode(transcript)))
  return {
    transcript,
    clientConfirmKey: hmacSha256(master, utf8.encode('confirm|client')),
    serverConfirmKey: hmacSha256(master, utf8.encode('confirm|server')),
    tokenKey: hmacSha256(master, utf8.encode('token')),
    doneKey: hmacSha256(master, utf8.encode('done')),
  }
}

/** The client's key confirmation (`pair.confirm.mac`). */
export function pairingClientConfirmation(keys: PairingKeys): string {
  return toHex(hmacSha256(keys.clientConfirmKey, utf8.encode(keys.transcript)))
}

/** Whether a received `pair.confirm.mac` proves the client derived the same keys. */
export function verifyPairingClientConfirmation(keys: PairingKeys, mac: string): boolean {
  return isBridgeHex256(mac) && constantTimeEqual(pairingClientConfirmation(keys), mac)
}

/** The client's receipt (`pair.done.mac`): it verified `pair.ok`. */
export function pairingDoneMac(keys: PairingKeys): string {
  return toHex(hmacSha256(keys.doneKey, utf8.encode(keys.transcript)))
}

/** Whether a received `pair.done.mac` is the receipt of this exchange. */
export function verifyPairingDone(keys: PairingKeys, mac: string): boolean {
  return isBridgeHex256(mac) && constantTimeEqual(pairingDoneMac(keys), mac)
}

function keystream(key: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let block = 0; block * 32 < length; block += 1) {
    const counter = Uint8Array.of(block >>> 24, (block >>> 16) & 255, (block >>> 8) & 255, block & 255)
    out.set(hmacSha256(key, concat(utf8.encode('stream|'), counter)).subarray(0, length - block * 32), block * 32)
  }
  return out
}

function serverConfirmation(keys: PairingKeys, box: string): string {
  return toHex(hmacSha256(keys.serverConfirmKey, utf8.encode(`${keys.transcript}|${box}`)))
}

/**
 * The bridge's `pair.ok`: its key confirmation and the token, encrypted. The
 * key is used for this one message only (it comes from fresh shares), so a
 * keystream XOR with a MAC over the ciphertext is sufficient. Call it only
 * after the client's confirmation verified.
 * @param keys - the exchange keys.
 * @param token - the bridge token.
 */
export function sealPairingToken(keys: PairingKeys, token: string): { box: string; mac: string } {
  const plain = utf8.encode(token)
  if (plain.length === 0 || plain.length > PAIRING_TOKEN_MAX_BYTES) throw new Error('bridge token is empty or too long to pair')
  const stream = keystream(keys.tokenKey, plain.length)
  const box = toHex(plain.map((byte, index) => byte ^ stream[index]!))
  return { box, mac: serverConfirmation(keys, box) }
}

/**
 * Verify the bridge's confirmation and decrypt the token.
 * @param keys - the exchange keys.
 * @param box - `pair.ok.box`.
 * @param mac - `pair.ok.mac`.
 * @returns the token, or `undefined` when the peer did not prove the code
 *   (it is not a bridge whose user typed this extension's code) or the token is malformed.
 */
export function openPairingToken(keys: PairingKeys, box: string, mac: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/u.test(box) || box.length > PAIRING_TOKEN_MAX_BYTES * 2) return undefined
  if (!isBridgeHex256(mac) || !constantTimeEqual(serverConfirmation(keys, box), mac)) return undefined
  const cipher = fromHex(box)
  const stream = keystream(keys.tokenKey, cipher.length)
  const token = new TextDecoder().decode(cipher.map((byte, index) => byte ^ stream[index]!))
  return /^[\x21-\x7e]{1,1024}$/u.test(token) ? token : undefined
}
