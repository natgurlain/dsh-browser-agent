/**
 * One-step pairing: how an extension without a bridge token (a Web Store or
 * Brave build, Firefox) obtains it from a short code the user reads off the
 * DSH host.
 *
 * The code is short (8 symbols, 40 bits), so it must never be testable
 * offline. Both halves therefore run a balanced PAKE (CPace-style, in the
 * prime-order subgroup of the RFC 3526 3072-bit MODP group):
 *
 *   g  = H(code, Ns, Nc, endpoint, origin)^2 mod p      (the code picks the generator)
 *   Yc = g^a,  Ys = g^b                                  (fresh secrets a, b)
 *   K  = (Ys^2)^a = (Yc^2)^b
 *   keys = HMAC(K-derived master, label)                 (confirm-client, confirm-server, token)
 *
 * Someone who sees or takes part in an exchange without the code learns
 * nothing they can test guesses against: a share is a uniformly distributed
 * group element whatever the code, and each run lets an active party check
 * exactly one guess (its own generator). The bridge caps the runs per code
 * (pairing-host.ts). The client confirms first, so the bridge reveals nothing
 * derived from the code until a client has proven it; the token then travels
 * encrypted under a key only the two halves hold.
 *
 * The transcript both confirmations cover names both nonces, the endpoint the
 * client dialed, the extension origin as each half sees it, and both shares,
 * so a relay (another extension, a local process on another port) cannot
 * splice itself between the halves.
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

/** Symbols in one pairing code (5 bits each: 40 bits). */
export const PAIRING_CODE_LENGTH = 8

/** Longest token a pairing exchange carries (matches the extension's own token bound). */
export const PAIRING_TOKEN_MAX_BYTES = 1024

/**
 * RFC 3526 group 15: a 3072-bit safe prime (p = 2q + 1 with q prime), so the
 * squares form a subgroup of prime order q and every element except 1 and
 * p - 1 has order q or 2q. pairing.spec checks these digits against node's
 * built-in `modp15`.
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
  /** The normalized pairing code. */
  code: string
  /** The bridge's `challenge` nonce. */
  serverNonce: string
  /** The client's `pair.hello` nonce. */
  clientNonce: string
  /** The endpoint the client dialed (the bridge checks it against its socket). */
  endpoint: BridgeEndpoint
  /** The client's extension origin (`chrome-extension://<id>`, `moz-extension://<uuid>`, or empty). */
  origin: string
}

/** One half's secret exponent and the share it sends. */
export interface PairingShare {
  secret: bigint
  share: string
}

/** Keys both halves derive from a completed exchange. */
export interface PairingKeys {
  /** Canonical transcript both confirmations cover. */
  transcript: string
  clientConfirmKey: Uint8Array
  serverConfirmKey: Uint8Array
  tokenKey: Uint8Array
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
 * @param input - what the user typed or pasted.
 * @returns the code, or `undefined` when it cannot be one.
 */
export function normalizePairingCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/gu, '').toUpperCase()
  return CODE_SHAPE.test(code) ? code : undefined
}

/** A code as shown to the user: two groups of four. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
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

function shareHex(value: bigint): string {
  return value.toString(16).padStart(PAIRING_SHARE_HEX_LENGTH, '0')
}

/** Fields that cannot contain `|` are joined bare; the origin is length-prefixed. */
function contextText(context: PairingContext): string {
  return `${context.serverNonce}|${context.clientNonce}|${context.endpoint.host}|${String(context.endpoint.port)}|${String(context.origin.length)}:${context.origin}`
}

/**
 * The generator one code selects for one exchange: a hash of the code and the
 * exchange's public context, reduced into the group and squared into the
 * prime-order subgroup. 416 hash bytes (128 bits more than the prime) keep
 * the reduction's bias negligible.
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
 * Whether a received share is usable: well-formed and neither 0, 1 nor p - 1
 * (the elements whose square is trivial, which would fix the key).
 * @param share - the peer's share as received.
 */
export function isPairingShare(share: unknown): share is string {
  if (!isPairingShareHex(share)) return false
  const value = BigInt(`0x${share}`)
  return value > 1n && value < P - 1n
}

/**
 * One half's contribution to an exchange.
 * @param context - what the exchange is bound to (this half's view).
 * @returns a fresh 256-bit secret and the share to send.
 */
export function createPairingShare(context: PairingContext): PairingShare {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  // Never 0 or 1: the share must not be the identity or the bare generator.
  const secret = BigInt(`0x${toHex(bytes)}`) + 2n
  return { secret, share: shareHex(modPow(pairingGenerator(context), secret, P)) }
}

/**
 * Derive the exchange keys from this half's secret and the peer's share.
 * @param context - what the exchange is bound to (this half's view).
 * @param secret - this half's secret from {@link createPairingShare}.
 * @param clientShare - the share the client sent.
 * @param serverShare - the share the bridge sent.
 * @param role - which half is deriving (it uses the other one's share).
 * @returns the keys, or `undefined` when the peer's share is unusable.
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
  const value = BigInt(`0x${peer}`)
  // Squaring first puts any share into the prime-order subgroup.
  const shared = modPow(value * value % P, secret, P)
  if (shared <= 1n) return undefined
  const transcript = `${LABEL}|${contextText(context)}|${clientShare}|${serverShare}`
  const master = hmacSha256(utf8.encode(`${LABEL}|master`), concat(fromHex(shareHex(shared)), utf8.encode(transcript)))
  return {
    transcript,
    clientConfirmKey: hmacSha256(master, utf8.encode('confirm|client')),
    serverConfirmKey: hmacSha256(master, utf8.encode('confirm|server')),
    tokenKey: hmacSha256(master, utf8.encode('token')),
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
 * Encrypt the bridge token for the client that just confirmed. The key is
 * used for this one message only (it is derived from fresh shares), so a
 * keystream XOR with a MAC over the ciphertext is sufficient.
 * @param keys - the exchange keys.
 * @param token - the bridge token.
 * @returns the `pair.ok` fields.
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
 *   (it is not the bridge the user started pairing on) or the token is malformed.
 */
export function openPairingToken(keys: PairingKeys, box: string, mac: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/u.test(box) || box.length > PAIRING_TOKEN_MAX_BYTES * 2) return undefined
  if (!isBridgeHex256(mac) || !constantTimeEqual(serverConfirmation(keys, box), mac)) return undefined
  const cipher = fromHex(box)
  const stream = keystream(keys.tokenKey, cipher.length)
  const token = new TextDecoder().decode(cipher.map((byte, index) => byte ^ stream[index]!))
  return /^[\x21-\x7e]{1,1024}$/u.test(token) ? token : undefined
}
