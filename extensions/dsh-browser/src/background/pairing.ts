/**
 * Extension half of one-step pairing: obtain the bridge token with the short
 * code the user read off their DSH host, for builds that have no
 * installer-written `bridge-token` file (Web Store, Brave, Firefox).
 *
 * The exchange is a password-authenticated key exchange keyed by the code
 * (see the bridge's pairing.ts). Nothing received on the socket is trusted
 * until the peer's `pair.ok` verifies under the exchange key, which only a
 * peer holding the same code can produce: a process squatting on a probed
 * port cannot hand this extension a token of its choosing, and learns nothing
 * about the code it could test offline. The transcript binds this extension's
 * own origin and the endpoint it dialed, so the exchange cannot be relayed
 * through another extension or another port.
 *
 * @module
 */

import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  PAIRING_PROTOCOL_VERSION,
  bridgeDialUrl,
  bridgeEndpointOfUrl,
  createBridgeNonce,
  isServerFrame,
  parseBridgeFrame,
  type ClientFrame,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  createPairingShare,
  derivePairingKeys,
  normalizePairingCode,
  openPairingToken,
  pairingClientConfirmation,
  type PairingContext,
  type PairingKeys,
} from '@natgurlain/dsh-bridge-browser/src/pairing.ts'

/** How long one exchange may take end to end. */
export const PAIRING_TIMEOUT_MS = 8_000

/**
 * Why pairing did not produce a token:
 * - `invalid-code`: what was typed cannot be a pairing code;
 * - `closed`: the bridge has no pairing window open (not started on the host,
 *   expired, already used, or out of attempts);
 * - `wrong-code`: the bridge ran the exchange and the code did not match;
 * - `unreachable`: nothing answered at the address;
 * - `unsupported`: the bridge is too old to pair;
 * - `version-mismatch`: the bridge speaks another handshake version, so a
 *   token would not help;
 * - `untrusted`: the peer could not prove the code, or the exchange was
 *   altered on the way;
 * - `timeout`: the exchange did not finish in time.
 */
export type PairingFailure =
  | 'invalid-code' | 'closed' | 'wrong-code' | 'unreachable' | 'unsupported' | 'version-mismatch' | 'untrusted' | 'timeout'

/** Outcome of one pairing attempt. */
export type PairingResult = { ok: true; token: string } | { ok: false; reason: PairingFailure }

/**
 * This extension's own origin (`chrome-extension://<id>` or
 * `moz-extension://<uuid>`), which is also the Origin the browser puts on its
 * sockets. Anything else (a test page) reads as no origin.
 * @param location - where to read it from (the worker's own location by default).
 */
export function extensionOrigin(
  location: { origin?: unknown } | undefined = (globalThis as { location?: { origin?: unknown } }).location,
): string {
  const origin = location?.origin
  return typeof origin === 'string' && /^(?:chrome|moz)-extension:\/\//u.test(origin) ? origin : ''
}

/**
 * Run one pairing exchange against one bridge.
 * @param url - bridge WebSocket URL.
 * @param codeInput - the code as the user typed it.
 * @param origin - this extension's origin (see {@link extensionOrigin}).
 * @param timeoutMs - budget for the whole exchange.
 * @returns the token, or why there is none. Never throws.
 */
export function pairWithBridge(
  url: string,
  codeInput: string,
  origin: string,
  timeoutMs: number = PAIRING_TIMEOUT_MS,
): Promise<PairingResult> {
  const code = normalizePairingCode(codeInput)
  if (code === undefined) return Promise.resolve({ ok: false, reason: 'invalid-code' })
  const dialUrl = bridgeDialUrl(url)
  const endpoint = bridgeEndpointOfUrl(dialUrl)
  if (endpoint === undefined) return Promise.resolve({ ok: false, reason: 'unreachable' })

  return new Promise<PairingResult>((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(dialUrl)
    } catch {
      resolve({ ok: false, reason: 'unreachable' })
      return
    }
    type Stage = 'challenge' | 'share' | 'ok' | 'done'
    let stage: Stage = 'challenge'
    let opened = false
    let context: PairingContext | undefined
    let own: ReturnType<typeof createPairingShare> | undefined
    let keys: PairingKeys | undefined
    const finish = (result: PairingResult): void => {
      if (stage === 'done') return
      stage = 'done'
      clearTimeout(timer)
      resolve(result)
      try { socket.close() } catch { /* already closed */ }
    }
    const timer = setTimeout(() => { finish({ ok: false, reason: opened ? 'timeout' : 'unreachable' }) }, timeoutMs)
    const send = (frame: ClientFrame): void => { socket.send(JSON.stringify(frame)) }

    socket.addEventListener('open', () => { opened = true })
    socket.addEventListener('message', (event: MessageEvent) => {
      if (stage === 'done') return
      const frame = parseBridgeFrame(String(event.data))
      if (frame === undefined || !isServerFrame(frame)) return
      try {
        if (stage === 'challenge' && frame.t === 'challenge') {
          if (frame.v !== BRIDGE_PROTOCOL_VERSION) {
            finish({ ok: false, reason: 'version-mismatch' })
            return
          }
          context = { code, serverNonce: frame.nonce, clientNonce: createBridgeNonce(), endpoint, origin }
          own = createPairingShare(context)
          send({ t: 'pair.hello', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint, origin, share: own.share })
          stage = 'share'
        } else if (stage === 'share' && frame.t === 'pair.share' && context !== undefined && own !== undefined) {
          keys = derivePairingKeys(context, own.secret, own.share, frame.share, 'client')
          if (keys === undefined) {
            finish({ ok: false, reason: 'untrusted' })
            return
          }
          send({ t: 'pair.confirm', mac: pairingClientConfirmation(keys) })
          stage = 'ok'
        } else if (stage === 'ok' && frame.t === 'pair.ok' && keys !== undefined) {
          // Only a peer that derived the same keys from the same code can
          // produce this; anything else is not the bridge the user is pairing with.
          const token = openPairingToken(keys, frame.box, frame.mac)
          finish(token === undefined ? { ok: false, reason: 'untrusted' } : { ok: true, token })
        }
      } catch {
        finish({ ok: false, reason: 'untrusted' })
      }
    })
    socket.addEventListener('close', (event: CloseEvent) => {
      if (stage === 'done') return
      const confirmed = stage === 'ok'
      switch (event.code) {
        case BRIDGE_CLOSE_CODES.pairingClosed:
        // An extension the bridge does not know yet is refused at the Origin
        // check unless a pairing window is open.
        case BRIDGE_CLOSE_CODES.originRejected:
          finish({ ok: false, reason: 'closed' })
          return
        case BRIDGE_CLOSE_CODES.pairingFailed:
          // After our confirmation: the code. Before it: the request itself
          // did not describe this socket (something sits in between).
          finish({ ok: false, reason: confirmed ? 'wrong-code' : 'untrusted' })
          return
        case 1008:
          // A bridge that predates pairing closes on the unknown first frame.
          finish({ ok: false, reason: stage === 'challenge' ? 'unreachable' : 'unsupported' })
          return
        default:
          finish({ ok: false, reason: opened ? 'untrusted' : 'unreachable' })
      }
    })
    socket.addEventListener('error', () => {
      if (!opened) finish({ ok: false, reason: 'unreachable' })
    })
  })
}

/** Rank of a failure when several bridges were tried: the most telling one is reported. */
const FAILURE_RANK: Record<PairingFailure, number> = {
  'wrong-code': 7,
  'closed': 6,
  'version-mismatch': 5,
  'unsupported': 4,
  'untrusted': 3,
  'timeout': 2,
  'unreachable': 1,
  'invalid-code': 0,
}

/**
 * Pair with whichever of several local bridges has a pairing window open for
 * this code. A bridge that verified the exchange and found the code wrong
 * ends the search: the remaining ones are not asked.
 * @param urls - candidate bridge URLs, in order of preference.
 * @param codeInput - the code as the user typed it.
 * @param origin - this extension's origin.
 * @param pairOne - one exchange (injectable for tests).
 * @returns the token and the bridge that issued it, or the most telling failure.
 */
export async function pairWithAnyBridge(
  urls: readonly string[],
  codeInput: string,
  origin: string,
  pairOne: (url: string, code: string, origin: string) => Promise<PairingResult> = pairWithBridge,
): Promise<{ ok: true; token: string; url: string } | { ok: false; reason: PairingFailure }> {
  if (normalizePairingCode(codeInput) === undefined) return { ok: false, reason: 'invalid-code' }
  let reason: PairingFailure = 'unreachable'
  for (const url of urls) {
    const result = await pairOne(url, codeInput, origin)
    if (result.ok) return { ok: true, token: result.token, url }
    if (FAILURE_RANK[result.reason] > FAILURE_RANK[reason]) reason = result.reason
    if (result.reason === 'wrong-code') break
  }
  return { ok: false, reason }
}
