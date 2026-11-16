/**
 * Where the user pairs a browser: the two host-side controls that can enter
 * a pairing code, pause pairing, or unpair an extension (pairing-host.ts).
 *
 * - `POST /api/bridge-browser.pairing` — an exact route on dsh's shared `/api`
 *   channel, used by the bridge's card and settings row in the DSH app
 *   (client.js). dsh admits a request there only from an authenticated owner
 *   that passed its Host/Origin checks, so a web page, another extension or
 *   a local process that merely reaches the port gets 401/403.
 * - `/browser-pair` — a human slash command, for the CLI and for shells that
 *   do not load the card. It is refused when it arrives through the browser
 *   bridge itself (bridge-policy.ts): a paired extension cannot pair another.
 *
 * Neither is reachable from the unauthenticated `/ext/bridge` socket, and the
 * public discovery route says nothing about pairing. Neither ever shows a
 * code: the code exists only in the extension's panel and in what the user types.
 *
 * @module
 */

import type { PairingDesk, PairingDeskStatus, PairingEnterResult } from './pairing-host.ts'

/** Path of the pairing control route on dsh's authenticated `/api` channel. */
export const PAIRING_API_PATH = '/api/bridge-browser.pairing'

/** Name of the slash command that enters a pairing code. */
export const PAIRING_COMMAND_NAME = 'browser-pair'

/** The slice of `ctx.connection.fetch` this module uses. */
export interface PairingFetchRegistry {
  register(route: {
    readonly path: string
    readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
    readonly requestBody: 'buffered' | 'streaming'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => unknown
}

/** A slash command's outcome. */
export type PairingCommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string }

/** The slice of `ctx.commands` this module uses. */
export interface PairingCommandRegistry {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    /** False keeps the typed code out of the session log. */
    recordInput?: boolean
    handler: (invocation: { rawInput: string }) => Promise<PairingCommandResult>
  }): () => unknown
}

/** What the controls act on. */
export interface PairingControls {
  desk: PairingDesk
  /** Extension origins that paired (the ones the user can unpair). */
  pairedOrigins: () => string[]
  /**
   * Unpair one origin: it is refused from now on and its connections are closed.
   * @returns whether it was paired.
   */
  unpair: (origin: string) => Promise<boolean>
  /**
   * Replace the bridge token and close every connection. Absent when the
   * token is pinned in the plugin config (it cannot be replaced from here).
   */
  resetToken?: () => Promise<void>
}

/** What the control route answers: the desk's state and the paired extensions, never a code. */
export type PairingControlReply =
  | ({ ok: true; result?: PairingEnterResult; pairedOrigins: string[]; canResetToken: boolean } & PairingDeskStatus)
  | { ok: false; error: 'bad-request' | 'not-paired' | 'token-pinned' }

function json(body: PairingControlReply, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

const view = (controls: PairingControls): { pairedOrigins: string[]; canResetToken: boolean } & PairingDeskStatus =>
  ({ ...controls.desk.status(), pairedOrigins: controls.pairedOrigins(), canResetToken: controls.resetToken !== undefined })

/**
 * Handle one request of the pairing control route. dsh has already
 * authenticated the caller as the host's owner.
 * @param controls - the desk and the paired-extension record.
 * @param request - a POST with a JSON body: `{ action: 'status' | 'pause' | 'resume' }`,
 *   `{ action: 'enter', code }`, `{ action: 'unpair', origin }` or `{ action: 'reset-token' }`.
 */
export async function handlePairingControl(controls: PairingControls, request: Request): Promise<Response> {
  // A JSON content type is not a "simple" cross-origin request: a page cannot send it without a preflight.
  if (!/^application\/json\b/iu.test(request.headers.get('content-type') ?? '')) return json({ ok: false, error: 'bad-request' }, 415)
  let body: { action?: unknown; code?: unknown; origin?: unknown } | null
  try {
    body = (await request.json()) as { action?: unknown; code?: unknown; origin?: unknown } | null
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400)
  }
  const action = body?.action
  if (action === 'status') return json({ ok: true, ...view(controls) })
  if (action === 'enter' && typeof body?.code === 'string' && body.code.length <= 64) {
    const result = await controls.desk.enter(body.code)
    return json({ ok: true, result, ...view(controls) })
  }
  if (action === 'pause') {
    controls.desk.pausePairing('user')
    return json({ ok: true, ...view(controls) })
  }
  if (action === 'resume') {
    controls.desk.resumePairing()
    return json({ ok: true, ...view(controls) })
  }
  if (action === 'unpair' && typeof body?.origin === 'string') {
    return await controls.unpair(body.origin) ? json({ ok: true, ...view(controls) }) : json({ ok: false, error: 'not-paired' }, 404)
  }
  if (action === 'reset-token') {
    if (controls.resetToken === undefined) return json({ ok: false, error: 'token-pinned' }, 409)
    await controls.resetToken()
    return json({ ok: true, ...view(controls) })
  }
  return json({ ok: false, error: 'bad-request' }, 400)
}

/** One sentence per outcome of entering a code. */
export function describeEnterResult(result: PairingEnterResult): PairingCommandResult {
  switch (result) {
    case 'paired': return { kind: 'success', text: 'Paired. The browser connects by itself now.' }
    case 'unconfirmed': return { kind: 'success', text: 'The code matched and the browser was sent what it needs, but it did not confirm. If its panel does not connect, ask again from the browser.' }
    case 'no-match': return { kind: 'error', text: 'No waiting browser shows that code. A code works for one try: in the browser, choose Ask again and enter the new code.' }
    case 'none-waiting': return { kind: 'error', text: 'No browser is waiting. Open the DSH browser extension first; it shows the code to enter here.' }
    case 'invalid': return { kind: 'error', text: 'A pairing code has 6 letters and digits, like ABC-DEF.' }
    case 'paused': return { kind: 'error', text: `Pairing is paused. Run /${PAIRING_COMMAND_NAME} resume to allow it again.` }
    case 'busy': return { kind: 'error', text: 'Another code is being checked. Try again in a moment.' }
  }
}

/**
 * Run `/browser-pair [<code> | pause | resume | unpair <extension> | reset-token]`.
 * @param controls - the desk and the paired-extension record.
 * @param rawInput - everything after the command name.
 */
export async function runPairingCommand(controls: PairingControls, rawInput: string): Promise<PairingCommandResult> {
  const words = rawInput.trim().split(/\s+/u).filter(word => word !== '')
  const verb = (words[0] ?? '').toLowerCase()
  if (words.length === 0) {
    const status = controls.desk.status()
    const waiting = status.waiting === 0
      ? 'No browser is waiting. Open the DSH browser extension; it shows a code.'
      : `${String(status.waiting)} browser${status.waiting === 1 ? ' is' : 's are'} waiting. Enter the code your browser shows: /${PAIRING_COMMAND_NAME} <code>.`
    const paired = controls.pairedOrigins()
    return {
      kind: 'success',
      text: [
        status.paused
          ? `Pairing is paused${status.pauseReason === 'failures' ? ' after too many wrong codes' : ''}. /${PAIRING_COMMAND_NAME} resume allows it again.`
          : waiting,
        ...status.requests.map(request => `  ${request.official ? 'dsh Browser Agent (official)' : 'Unknown extension, not the published DSH extension'}: ${request.origin} (says it is ${request.name})`),
        paired.length === 0 ? 'No extension has been paired.' : `Paired extensions: ${paired.join(', ')} (/${PAIRING_COMMAND_NAME} unpair <extension> removes one).`,
      ].join('\n'),
    }
  }
  if (verb === 'pause' && words.length === 1) {
    controls.desk.pausePairing('user')
    return { kind: 'success', text: `Pairing is paused: no browser can ask to pair until /${PAIRING_COMMAND_NAME} resume.` }
  }
  if (verb === 'resume' && words.length === 1) {
    controls.desk.resumePairing()
    return { kind: 'success', text: 'Pairing is allowed again.' }
  }
  if (verb === 'unpair' && words.length === 2) {
    // A bare Chrome extension ID is accepted for the origin.
    const origin = /^[a-p]{32}$/u.test(words[1]!) ? `chrome-extension://${words[1]!}` : words[1]!
    return await controls.unpair(origin)
      ? { kind: 'success', text: `Unpaired. That extension is refused from now on and its connection was closed. It still holds the bridge token: /${PAIRING_COMMAND_NAME} reset-token replaces it if the browser is not yours any more.` }
      : { kind: 'error', text: 'That is not a paired extension.' }
  }
  if (verb === 'reset-token' && words.length === 1) {
    if (controls.resetToken === undefined) {
      return { kind: 'error', text: 'The bridge token is pinned in the plugin config. Change it there (and in every browser that uses it), then restart DSH.' }
    }
    await controls.resetToken()
    return { kind: 'success', text: 'The bridge token was replaced and every browser was disconnected. The installed developer extension picks the new token up by itself; paired browsers pair again.' }
  }
  // Anything else is a code; what cannot be one is answered as such, without echoing the input.
  return describeEnterResult(await controls.desk.enter(words.join('')))
}

/**
 * Register the host-side pairing controls that this composition supports.
 * @param controls - the desk and the paired-extension record.
 * @param services - the route and command registries, when present.
 * @returns disposers, in registration order.
 */
export function mountPairingControls(
  controls: PairingControls,
  services: { fetch?: PairingFetchRegistry; commands?: PairingCommandRegistry },
): Array<() => unknown> {
  const disposers: Array<() => unknown> = []
  if (typeof services.fetch?.register === 'function') {
    disposers.push(services.fetch.register({
      path: PAIRING_API_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handlePairingControl(controls, request),
    }))
  }
  if (typeof services.commands?.register === 'function') {
    disposers.push(services.commands.register({
      name: PAIRING_COMMAND_NAME,
      description: 'Pair a DSH browser extension: enter the code its panel shows',
      input: { hint: '<code>' },
      recordInput: false,
      handler: invocation => runPairingCommand(controls, invocation.rawInput),
    }))
  }
  return disposers
}
