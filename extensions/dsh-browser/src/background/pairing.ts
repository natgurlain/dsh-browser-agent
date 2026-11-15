/**
 * Extension half of one-step pairing: ask the local DSH host for the bridge
 * token, for builds that have no installer-written `bridge-token` file (Web
 * Store, Brave, Firefox).
 *
 * The extension asks; the user answers in DSH. Both sides display a short
 * code derived from a key agreement (see the bridge's pairing.ts), and the
 * user approves in DSH only when the two codes are the same. A process
 * squatting on a probed port, or anything relaying the exchange, ends up
 * with a different code on the host side, so the user's approval never
 * reaches it; and the token arrives encrypted under a key that only the
 * approved exchange's two ends hold. Nothing received on the socket is
 * stored unless it opens under that key.
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
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  createPairingOpening,
  createPairingShare,
  derivePairingSession,
  formatPairingCode,
  openPairingToken,
  pairingCommitment,
  type PairingContext,
  type PairingSession,
} from '@natgurlain/dsh-bridge-browser/src/pairing.ts'

/** How long the exchange may take before the code exists. */
export const PAIRING_EXCHANGE_TIMEOUT_MS = 8_000

/**
 * How long the request waits for the user's answer. Slightly longer than the
 * bridge's own limit (two minutes), which normally ends the wait first.
 */
export const PAIRING_ANSWER_TIMEOUT_MS = 125_000

/**
 * Why pairing did not produce a token:
 * - `denied`: the user denied the request in DSH;
 * - `expired`: nobody answered in time;
 * - `busy`: the bridge has too many requests waiting, or does not pair;
 * - `unreachable`: nothing answered at the address, or DSH went away;
 * - `unsupported`: the bridge is too old to pair;
 * - `version-mismatch`: the bridge speaks another handshake version, so a
 *   token would not help;
 * - `untrusted`: the exchange was altered on the way, or the answer did not
 *   come from the peer of this exchange;
 * - `cancelled`: the panel withdrew the request.
 */
export type PairingFailure =
  | 'denied' | 'expired' | 'busy' | 'unreachable' | 'unsupported' | 'version-mismatch' | 'untrusted' | 'cancelled'

/** Outcome of one pairing request. */
export type PairingResult = { ok: true; token: string } | { ok: false; reason: PairingFailure }

/** What one pairing request needs besides the address. */
export interface PairingOptions {
  /** This extension's origin (see {@link extensionOrigin}). */
  origin: string
  /** Browser name for the prompt in DSH (see {@link browserName}). */
  name: string
  /** Called once, with the formatted code to display, when the request is waiting for the user's answer. */
  onCode: (code: string, answerTimeoutMs: number) => void
  /** Aborting withdraws the request (the prompt disappears in DSH). */
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
 * The browser's name as the user knows it, for the prompt in DSH ("Brave
 * wants to connect"). It is a label, not an identity: the code is what the
 * user compares.
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
 * Run one pairing request against one bridge: exchange keys, show the code,
 * wait for the user's answer in DSH.
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

  return new Promise<PairingResult>((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(dialUrl)
    } catch {
      resolve({ ok: false, reason: 'unreachable' })
      return
    }
    type Stage = 'challenge' | 'share' | 'waiting' | 'done'
    let stage: Stage = 'challenge'
    let opened = false
    let context: PairingContext | undefined
    const own = createPairingShare()
    const opening = createPairingOpening()
    let session: PairingSession | undefined
    const onAbort = (): void => { finish({ ok: false, reason: 'cancelled' }) }
    const finish = (result: PairingResult): void => {
      if (stage === 'done') return
      stage = 'done'
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
      try { socket.close() } catch { /* already closed */ }
    }
    let timer = setTimeout(() => { finish({ ok: false, reason: 'unreachable' }) }, options.exchangeTimeoutMs ?? PAIRING_EXCHANGE_TIMEOUT_MS)
    options.signal?.addEventListener('abort', onAbort, { once: true })
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
          context = { serverNonce: frame.nonce, clientNonce: createBridgeNonce(), endpoint, origin: options.origin, name }
          // Committed before the bridge's share is known, revealed after.
          send({
            t: 'pair.request', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint, origin: options.origin, name,
            commit: pairingCommitment(own.share, opening),
          })
          stage = 'share'
        } else if (stage === 'share' && frame.t === 'pair.share' && context !== undefined) {
          session = derivePairingSession(context, own.secret, own.share, frame.share, 'client')
          if (session === undefined) {
            finish({ ok: false, reason: 'untrusted' })
            return
          }
          send({ t: 'pair.reveal', share: own.share, opening })
          stage = 'waiting'
          clearTimeout(timer)
          timer = setTimeout(() => { finish({ ok: false, reason: 'expired' }) }, answerTimeoutMs)
          options.onCode(formatPairingCode(session.code), answerTimeoutMs)
        } else if (stage === 'waiting' && frame.t === 'pair.ok' && session !== undefined) {
          // Only the peer of this exchange can produce a box that opens.
          const token = openPairingToken(session, frame.box, frame.mac)
          finish(token === undefined ? { ok: false, reason: 'untrusted' } : { ok: true, token })
        }
      } catch {
        finish({ ok: false, reason: 'untrusted' })
      }
    })
    socket.addEventListener('close', (event: CloseEvent) => {
      if (stage === 'done') return
      const waiting = stage === 'waiting'
      switch (event.code) {
        case BRIDGE_CLOSE_CODES.pairingDenied:
          finish({ ok: false, reason: 'denied' })
          return
        case BRIDGE_CLOSE_CODES.pairingClosed:
          finish({ ok: false, reason: waiting ? 'expired' : 'busy' })
          return
        case BRIDGE_CLOSE_CODES.pairingFailed:
          finish({ ok: false, reason: 'untrusted' })
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
      if (!opened) finish({ ok: false, reason: 'unreachable' })
    })
  })
}
