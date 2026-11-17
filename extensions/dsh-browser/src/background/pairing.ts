/**
 * Extension half of one-step pairing: obtain the bridge token for a build
 * that has no installer-written `bridge-token` file (Web Store, Brave,
 * Firefox).
 *
 * The extension picks a random six-character code and shows it in its own
 * panel; the user types it into DSH. The code keys a password-authenticated
 * key exchange (see the bridge's pairing.ts), so:
 *
 * - the code never leaves this extension except through the user's eyes: the
 *   request carries a key share that says nothing about it;
 * - a peer that was not given the code (a process squatting on a probed
 *   port, another extension relaying frames) cannot produce a `pair.ok` that
 *   verifies, so nothing it sends is ever stored;
 * - such a peer gets one guess at the code per request, and a request's code
 *   is never reused.
 *
 * The token is stored only after `pair.ok` verified under the exchange key.
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
  isPairingName,
  isServerFrame,
  parseBridgeFrame,
  type ClientFrame,
} from 'dsh-browser-agent/src/protocol.ts'
import {
  createPairingShare,
  derivePairingKeys,
  formatPairingCode,
  generatePairingCode,
  openPairingToken,
  pairingClientConfirmation,
  pairingDoneMac,
  type PairingContext,
  type PairingKeys,
} from 'dsh-browser-agent/src/pairing.ts'

/** How long each step of the exchange may take (reaching the bridge; its answer to our confirmation). */
export const PAIRING_EXCHANGE_TIMEOUT_MS = 8_000

/**
 * How long the request waits for the user to enter the code. Slightly longer
 * than the bridge's own limit (two minutes), which normally ends the wait first.
 */
export const PAIRING_ANSWER_TIMEOUT_MS = 125_000

/**
 * Why pairing did not produce a token:
 * - `wrong-code`: a code was entered in DSH, and it was not this request's;
 * - `expired`: no code was entered in time;
 * - `replaced`: another request took this one's place in the bridge's queue
 *   (something else on the computer is asking to pair);
 * - `busy`: the bridge is receiving too many requests, or does not pair;
 * - `paused`: pairing is paused in DSH;
 * - `unreachable`: nothing answered at the address, or DSH went away;
 * - `unsupported`: the bridge is too old to pair, or pairing is switched off;
 * - `version-mismatch`: the bridge speaks another handshake version, so a
 *   token would not help;
 * - `untrusted`: the peer did not prove it knows the code, or the exchange
 *   was altered on the way;
 * - `cancelled`: the panel withdrew the request;
 * - `has-token`: this install already holds a token and the user did not ask
 *   to pair again (reported by the background, never by the exchange);
 * - `auto-limit`: the panel asked by itself too often in one sitting; the
 *   next request needs the user's click (reported by the background).
 */
export type PairingFailure =
  | 'wrong-code' | 'expired' | 'replaced' | 'busy' | 'paused' | 'unreachable' | 'unsupported' | 'version-mismatch' | 'untrusted' | 'cancelled' | 'has-token' | 'auto-limit'

/** Outcome of one pairing request. */
export type PairingResult = { ok: true; token: string } | { ok: false; reason: PairingFailure }

/** What one pairing request needs besides the address. */
export interface PairingOptions {
  /** This extension's origin (see {@link extensionOrigin}). */
  origin: string
  /** Browser name, a hint for the host (see {@link browserName}). */
  name: string
  /** Called once, with the formatted code to display, when the request is waiting for the user to enter it in DSH. */
  onCode: (code: string, answerTimeoutMs: number) => void
  /** Aborting withdraws the request. */
  signal?: AbortSignal
  /** Budgets; the defaults are the constants above. */
  exchangeTimeoutMs?: number
  answerTimeoutMs?: number
}

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

/** Browser brands as they appear in `navigator.userAgentData.brands`, most specific first. */
const BRANDS = ['Brave', 'Microsoft Edge', 'Opera', 'Vivaldi', 'Google Chrome', 'Chromium'] as const

/**
 * The browser's name as the user knows it, one of the names the bridge
 * accepts. It is a hint for the host ("says it is Brave"), not an identity.
 * @param nav - where to read it from (the worker's own navigator by default).
 */
export function browserName(
  nav: { brave?: unknown; userAgent?: unknown; userAgentData?: { brands?: unknown } } | undefined = (globalThis as { navigator?: object }).navigator,
): string {
  if (nav?.brave !== undefined) return 'Brave'
  const brands = Array.isArray(nav?.userAgentData?.brands)
    ? (nav.userAgentData.brands as Array<{ brand?: unknown }>).map(entry => entry?.brand).filter((brand): brand is string => typeof brand === 'string')
    : []
  const brand = BRANDS.find(candidate => brands.includes(candidate))
  if (brand !== undefined) return brand === 'Google Chrome' ? 'Chrome' : brand === 'Microsoft Edge' ? 'Edge' : brand
  const agent = typeof nav?.userAgent === 'string' ? nav.userAgent : ''
  if (/\bFirefox\//u.test(agent)) return 'Firefox'
  if (/\bEdg\//u.test(agent)) return 'Edge'
  if (/\bChrome\//u.test(agent)) return 'Chrome'
  return 'Browser'
}

/**
 * Run one pairing request against one bridge: pick a code, send the request,
 * show the code, and complete the exchange once the user entered it in DSH.
 * @param url - bridge WebSocket URL.
 * @param options - identity, the code callback, cancellation.
 * @returns the token, or why there is none. Never throws.
 */
export function pairWithBridge(url: string, options: PairingOptions): Promise<PairingResult> {
  const dialUrl = bridgeDialUrl(url)
  const endpoint = bridgeEndpointOfUrl(dialUrl)
  if (endpoint === undefined) return Promise.resolve({ ok: false, reason: 'unreachable' })
  if (options.signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'cancelled' })
  const name = isPairingName(options.name) ? options.name : 'Browser'
  const answerTimeoutMs = options.answerTimeoutMs ?? PAIRING_ANSWER_TIMEOUT_MS
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? PAIRING_EXCHANGE_TIMEOUT_MS
  // Fresh for this request and never reused: whoever answers gets one guess at it.
  const code = generatePairingCode()

  return new Promise<PairingResult>((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(dialUrl)
    } catch {
      resolve({ ok: false, reason: 'unreachable' })
      return
    }
    type Stage = 'challenge' | 'waiting' | 'confirmed' | 'done'
    let stage: Stage = 'challenge'
    let context: PairingContext | undefined
    let own: ReturnType<typeof createPairingShare> | undefined
    let keys: PairingKeys | undefined
    const onAbort = (): void => { finish({ ok: false, reason: 'cancelled' }) }
    const finish = (result: PairingResult): void => {
      if (stage === 'done') return
      stage = 'done'
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
      try { socket.close() } catch { /* already closed */ }
    }
    let timer = setTimeout(() => { finish({ ok: false, reason: 'unreachable' }) }, exchangeTimeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const send = (frame: ClientFrame): void => { socket.send(JSON.stringify(frame)) }

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
          context = { code, serverNonce: frame.nonce, clientNonce: createBridgeNonce(), endpoint, origin: options.origin, name }
          own = createPairingShare(context)
          // The share is a uniformly distributed group element: it says nothing about the code.
          send({ t: 'pair.request', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint, origin: options.origin, name, share: own.share })
          stage = 'waiting'
          clearTimeout(timer)
          timer = setTimeout(() => { finish({ ok: false, reason: 'expired' }) }, answerTimeoutMs)
          options.onCode(formatPairingCode(code), answerTimeoutMs)
        } else if (stage === 'waiting' && frame.t === 'pair.share' && context !== undefined && own !== undefined) {
          keys = derivePairingKeys(context, own.secret, own.share, frame.share, 'client')
          if (keys === undefined) {
            finish({ ok: false, reason: 'untrusted' })
            return
          }
          // This confirmation is the one thing a wrong peer can test, against the
          // single code it committed to with its share; the code is spent either way.
          send({ t: 'pair.confirm', mac: pairingClientConfirmation(keys) })
          stage = 'confirmed'
          clearTimeout(timer)
          timer = setTimeout(() => { finish({ ok: false, reason: 'untrusted' }) }, exchangeTimeoutMs)
        } else if (stage === 'confirmed' && frame.t === 'pair.ok' && keys !== undefined) {
          // Only a peer that holds this request's code can produce this.
          const token = openPairingToken(keys, frame.box, frame.mac)
          if (token === undefined) {
            finish({ ok: false, reason: 'untrusted' })
            return
          }
          send({ t: 'pair.done', mac: pairingDoneMac(keys) })
          finish({ ok: true, token })
        }
      } catch {
        finish({ ok: false, reason: 'untrusted' })
      }
    })
    socket.addEventListener('close', (event: CloseEvent) => {
      if (stage === 'done') return
      switch (event.code) {
        case BRIDGE_CLOSE_CODES.pairingPaused:
          finish({ ok: false, reason: 'paused' })
          return
        case BRIDGE_CLOSE_CODES.pairingReplaced:
          finish({ ok: false, reason: 'replaced' })
          return
        case BRIDGE_CLOSE_CODES.pairingClosed:
          finish({ ok: false, reason: stage === 'confirmed' ? 'untrusted' : pendingCloseReason(event.reason) })
          return
        case BRIDGE_CLOSE_CODES.pairingFailed:
          // After our confirmation: the code entered in DSH was another one.
          // Before it: the request itself did not describe this socket.
          finish({ ok: false, reason: stage === 'confirmed' ? 'wrong-code' : 'untrusted' })
          return
        // A bridge that does not pair refuses an unknown extension at the
        // Origin check; one that predates pairing closes on the unknown frame.
        case BRIDGE_CLOSE_CODES.originRejected:
        case 1008:
          finish({ ok: false, reason: 'unsupported' })
          return
        default:
          finish({ ok: false, reason: 'unreachable' })
      }
    })
    socket.addEventListener('error', () => {
      if (stage === 'challenge') finish({ ok: false, reason: 'unreachable' })
    })
  })
}

/**
 * Why the bridge closed a request it had not attempted: it does not pair
 * (`unsupported`), it is receiving too many requests (`busy`), or the request
 * timed out (`expired`). The reason text only
 * picks the message shown; nothing is trusted on its strength.
 */
function pendingCloseReason(reason: string): PairingFailure {
  if (/does not pair/iu.test(reason)) return 'unsupported'
  return /too many/iu.test(reason) ? 'busy' : 'expired'
}
