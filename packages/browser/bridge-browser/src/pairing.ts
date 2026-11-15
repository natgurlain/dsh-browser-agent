/**
 * One-step pairing: how an extension without a bridge token (a Web Store or
 * Brave build, Firefox) obtains it after the user approves it on the DSH host.
 *
 * The extension asks; the user answers on the host. What ties the two
 * together is a short code that both sides compute and display, and that the
 * user compares before approving. The exchange is a Diffie-Hellman key
 * agreement with a short authentication string, in the prime-order subgroup
 * of the RFC 3526 3072-bit MODP group:
 *
 *   client → commit = HMAC(opening, Yc)              (Yc = g^a, not yet shown)
 *   bridge → Ys = g^b
 *   client → Yc, opening                              (the bridge checks the commitment)
 *   K = (Ys^2)^a = (Yc^2)^b
 *   master = HMAC(label, K ‖ transcript)
 *   code   = 30 bits of HMAC(master, "code")          (shown by the extension and by the host)
 *
 * The transcript names both nonces, the endpoint the client dialed, the
 * extension origin and browser name as each half sees them, and both shares.
 * Someone in the middle (a local process on the port the extension probed,
 * another extension relaying frames) ends up with two different keys, hence
 * two different codes, and cannot steer them to match: the client is bound
 * to its share before it sees the bridge's, and the bridge sends its share
 * before it sees the client's. A match by luck has probability 2^-30 per
 * request, and every request needs the user's own approval.
 *
 * Only after approval does the bridge send the token, encrypted and
 * authenticated under keys derived from the same master, so an observer of
 * the loopback traffic reads nothing, and nobody but the approved socket's
 * peer can decrypt it.
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
 * squares form a subgroup of prime order q. pairing.spec checks these digits
 * against node's built-in `modp15`.
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
/** 4 = 2^2 is a square, so it generates the subgroup of prime order q. */
const G = 4n
const LABEL = `dsh-pair/v${String(PAIRING_PROTOCOL_VERSION)}`
const utf8 = new TextEncoder()
const CODE_SHAPE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${String(PAIRING_CODE_LENGTH)}}$`, 'u')

/** The public facts one exchange is bound to; both halves must agree on every field. */
export interface PairingContext {
  /** The bridge's `challenge` nonce. */
  serverNonce: string
  /** The client's `pair.request` nonce. */
  clientNonce: string
  /** The endpoint the client dialed (the bridge checks it against its socket). */
  endpoint: BridgeEndpoint
  /** The client's extension origin (`chrome-extension://<id>`, `moz-extension://<uuid>`, or empty). */
  origin: string
  /** The browser name the host shows on its approval prompt. */
  name: string
}

/** One half's secret exponent and the share it sends. */
export interface PairingShare {
  secret: bigint
  share: string
}

/** What both halves derive from a completed exchange. */
export interface PairingSession {
  /** The code both sides display, unformatted. */
  code: string
  /** Canonical transcript the token MAC covers. */
  transcript: string
  macKey: Uint8Array
  tokenKey: Uint8Array
}

/**
 * Canonical form of a code as typed (the `/browser-pair approve` path): case,
 * spaces and dashes are ignored; nothing is guessed.
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

function shareHex(value: bigint): string {
  return value.toString(16).padStart(PAIRING_SHARE_HEX_LENGTH, '0')
}

function randomHex256(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes)
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
 * @returns a fresh 256-bit secret and the share to send.
 */
export function createPairingShare(): PairingShare {
  const secret = BigInt(`0x${randomHex256()}`) + 2n
  return { secret, share: shareHex(modPow(G, secret, P)) }
}

/** A fresh opening value for {@link pairingCommitment} (32 random bytes, hex). */
export function createPairingOpening(): string {
  return randomHex256()
}

/**
 * The client's commitment to its share. It hides the share (the opening is
 * 256 random bits) and binds the client to it (HMAC-SHA256 under a key the
 * committer chose still has to collide to open two ways).
 * @param share - the client's share.
 * @param opening - the opening value, revealed with the share.
 */
export function pairingCommitment(share: string, opening: string): string {
  return toHex(hmacSha256(fromHex(opening), utf8.encode(`${LABEL}|commit|${share}`)))
}

/** Whether a revealed share and opening match the commitment sent first. */
export function verifyPairingCommitment(commit: string, share: string, opening: string): boolean {
  return isBridgeHex256(commit) && isBridgeHex256(opening) && isPairingShareHex(share)
    && constantTimeEqual(pairingCommitment(share, opening), commit)
}

/** Fixed-format fields are joined bare; free text is length-prefixed so it cannot bleed into a neighbour. */
function transcriptOf(context: PairingContext, clientShare: string, serverShare: string): string {
  return `${LABEL}|${context.serverNonce}|${context.clientNonce}|${context.endpoint.host}|${String(context.endpoint.port)}`
    + `|${String(context.origin.length)}:${context.origin}|${String(context.name.length)}:${context.name}|${clientShare}|${serverShare}`
}

/**
 * Derive the code and the token keys from this half's secret and the peer's share.
 * @param context - what the exchange is bound to (this half's view).
 * @param secret - this half's secret from {@link createPairingShare}.
 * @param clientShare - the share the client revealed.
 * @param serverShare - the share the bridge sent.
 * @param role - which half is deriving (it uses the other one's share).
 * @returns the session, or `undefined` when the peer's share is unusable.
 */
export function derivePairingSession(
  context: PairingContext,
  secret: bigint,
  clientShare: string,
  serverShare: string,
  role: 'client' | 'server',
): PairingSession | undefined {
  const peer = role === 'client' ? serverShare : clientShare
  if (!isPairingShare(peer) || !isPairingShareHex(clientShare) || !isPairingShareHex(serverShare)) return undefined
  const value = BigInt(`0x${peer}`)
  // Squaring first puts any share into the prime-order subgroup.
  const shared = modPow(value * value % P, secret, P)
  if (shared <= 1n) return undefined
  const transcript = transcriptOf(context, clientShare, serverShare)
  const master = hmacSha256(utf8.encode(`${LABEL}|master`), concat(fromHex(shareHex(shared)), utf8.encode(transcript)))
  const digest = hmacSha256(master, utf8.encode('code'))
  let code = ''
  // 256 is a multiple of 32, so the low five bits of each byte are uniform.
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) code += PAIRING_CODE_ALPHABET[digest[index]! & 31]
  return {
    code,
    transcript,
    macKey: hmacSha256(master, utf8.encode('token-mac')),
    tokenKey: hmacSha256(master, utf8.encode('token-key')),
  }
}

function keystream(key: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let block = 0; block * 32 < length; block += 1) {
    const counter = Uint8Array.of(block >>> 24, (block >>> 16) & 255, (block >>> 8) & 255, block & 255)
    out.set(hmacSha256(key, concat(utf8.encode('stream|'), counter)).subarray(0, length - block * 32), block * 32)
  }
  return out
}

function tokenMac(session: PairingSession, box: string): string {
  return toHex(hmacSha256(session.macKey, utf8.encode(`${session.transcript}|${box}`)))
}

/**
 * Encrypt the bridge token for the approved client. The key is used for this
 * one message only (it comes from fresh shares), so a keystream XOR with a
 * MAC over the ciphertext is sufficient.
 * @param session - the exchange's session.
 * @param token - the bridge token.
 * @returns the `pair.ok` fields.
 */
export function sealPairingToken(session: PairingSession, token: string): { box: string; mac: string } {
  const plain = utf8.encode(token)
  if (plain.length === 0 || plain.length > PAIRING_TOKEN_MAX_BYTES) throw new Error('bridge token is empty or too long to pair')
  const stream = keystream(session.tokenKey, plain.length)
  const box = toHex(plain.map((byte, index) => byte ^ stream[index]!))
  return { box, mac: tokenMac(session, box) }
}

/**
 * Verify and decrypt the token of a `pair.ok`.
 * @param session - the exchange's session.
 * @param box - `pair.ok.box`.
 * @param mac - `pair.ok.mac`.
 * @returns the token, or `undefined` when the message was not produced by the
 *   peer of this exchange or the token is malformed.
 */
export function openPairingToken(session: PairingSession, box: string, mac: string): string | undefined {
  if (!/^(?:[0-9a-f]{2})+$/u.test(box) || box.length > PAIRING_TOKEN_MAX_BYTES * 2) return undefined
  if (!isBridgeHex256(mac) || !constantTimeEqual(tokenMac(session, box), mac)) return undefined
  const cipher = fromHex(box)
  const stream = keystream(session.tokenKey, cipher.length)
  const token = new TextDecoder().decode(cipher.map((byte, index) => byte ^ stream[index]!))
  return /^[\x21-\x7e]{1,1024}$/u.test(token) ? token : undefined
}
