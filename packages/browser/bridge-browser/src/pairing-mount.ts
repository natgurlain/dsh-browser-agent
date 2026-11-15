/**
 * Where the user starts pairing: the two host-side controls that may open a
 * pairing window (pairing-host.ts).
 *
 * - `POST /api/bridge-browser.pairing` — an exact route on dsh's shared `/api`
 *   channel, used by the bridge's row in DSH Web settings (client.js). dsh
 *   admits a request there only from an authenticated owner (its signed
 *   browser cookie or API credential) that passed the Host/Origin checks, so
 *   a web page, another extension or a local process that merely reaches the
 *   port gets 401/403 and never sees a code.
 * - `/browser-pair` — a human slash command, for the CLI and for shells whose
 *   page is not same-origin with the host. Commands run only for an
 *   authenticated owner as well, and their result never becomes a model
 *   message.
 *
 * Neither is reachable from the unauthenticated `/ext/bridge` socket, and the
 * public discovery route says nothing about pairing.
 *
 * @module
 */

import { formatPairingCode } from './pairing.ts'
import { PAIRING_WINDOW_MS, type PairingStatus, type PairingWindows } from './pairing-host.ts'

/** Path of the pairing control route on dsh's authenticated `/api` channel. */
export const PAIRING_API_PATH = '/api/bridge-browser.pairing'

/** Name of the slash command that opens a pairing window. */
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

/** The slice of `ctx.commands` this module uses. */
export interface PairingCommandRegistry {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { rawInput: string }) => { kind: 'success'; text?: string } | { kind: 'error'; text: string }
  }): () => unknown
}

/** What the control route answers. */
export type PairingControlReply =
  | { ok: true; code: string; expiresAt: number; ttlMs: number; status: PairingStatus }
  | { ok: true; status: PairingStatus }
  | { ok: false; error: 'cooldown'; retryAt: number; status: PairingStatus }
  | { ok: false; error: 'bad-request' }

function json(body: PairingControlReply, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Handle one request of the pairing control route. dsh has already
 * authenticated the caller as the host's owner.
 * @param windows - the bridge's pairing window.
 * @param request - a POST whose JSON body is `{ action: 'start' | 'cancel' | 'status' }`.
 */
export async function handlePairingControl(windows: PairingWindows, request: Request): Promise<Response> {
  let action: unknown
  try {
    action = ((await request.json()) as { action?: unknown } | null)?.action
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400)
  }
  if (action === 'start') {
    const started = windows.start()
    if (!started.ok) return json({ ok: false, error: 'cooldown', retryAt: started.retryAt, status: windows.status() }, 429)
    return json({ ok: true, code: formatPairingCode(started.code), expiresAt: started.expiresAt, ttlMs: PAIRING_WINDOW_MS, status: windows.status() })
  }
  if (action === 'cancel') {
    windows.cancel()
    return json({ ok: true, status: windows.status() })
  }
  if (action === 'status') return json({ ok: true, status: windows.status() })
  return json({ ok: false, error: 'bad-request' }, 400)
}

/**
 * Run `/browser-pair [cancel]`.
 * @param windows - the bridge's pairing window.
 * @param rawInput - everything after the command name.
 */
export function runPairingCommand(
  windows: PairingWindows,
  rawInput: string,
  now: () => number = Date.now,
): { kind: 'success'; text: string } | { kind: 'error'; text: string } {
  const input = rawInput.trim().toLowerCase()
  if (input === 'cancel') {
    windows.cancel()
    return { kind: 'success', text: 'Browser pairing cancelled. No pairing code is valid now.' }
  }
  if (input !== '') return { kind: 'error', text: `Usage: /${PAIRING_COMMAND_NAME} (or /${PAIRING_COMMAND_NAME} cancel)` }
  const started = windows.start()
  if (!started.ok) {
    const seconds = Math.max(1, Math.ceil((started.retryAt - now()) / 1000))
    return { kind: 'error', text: `Too many wrong pairing codes were tried. Wait ${String(seconds)} s, then run /${PAIRING_COMMAND_NAME} again.` }
  }
  return {
    kind: 'success',
    text: `Browser pairing code: ${formatPairingCode(started.code)}\n`
      + `Open the DSH browser extension, go to Settings → Pair with DSH, and enter this code within ${String(Math.round(PAIRING_WINDOW_MS / 60_000))} minutes. `
      + `The code works once. Enter it only in the extension's own panel; /${PAIRING_COMMAND_NAME} cancel withdraws it.`,
  }
}

/**
 * Register the host-side pairing controls that this composition supports.
 * @param windows - the bridge's pairing window.
 * @param services - the route and command registries, when present.
 * @returns disposers, in registration order.
 */
export function mountPairingControls(
  windows: PairingWindows,
  services: { fetch?: PairingFetchRegistry; commands?: PairingCommandRegistry },
): Array<() => unknown> {
  const disposers: Array<() => unknown> = []
  if (typeof services.fetch?.register === 'function') {
    disposers.push(services.fetch.register({
      path: PAIRING_API_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handlePairingControl(windows, request),
    }))
  }
  if (typeof services.commands?.register === 'function') {
    disposers.push(services.commands.register({
      name: PAIRING_COMMAND_NAME,
      description: 'Show a one-time code that pairs a DSH browser extension with this host',
      input: { hint: '[cancel]' },
      handler: invocation => runPairingCommand(windows, invocation.rawInput),
    }))
  }
  return disposers
}
