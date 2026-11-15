/**
 * Where the user answers a pairing request: the two host-side controls that
 * can approve or deny one (pairing-host.ts).
 *
 * - `POST /api/bridge-browser.pairing` — an exact route on dsh's shared `/api`
 *   channel, used by the bridge's row in DSH settings (client.js). dsh admits
 *   a request there only from an authenticated owner that passed its
 *   Host/Origin checks, so a web page, another extension or a local process
 *   that merely reaches the port gets 401/403: it can neither see the waiting
 *   requests nor approve one.
 * - `/browser-pair` — a human slash command, for the CLI and for shells that
 *   do not load the settings row. Commands run only for an authenticated
 *   owner as well, and their result never becomes a model message.
 *
 * Neither is reachable from the unauthenticated `/ext/bridge` socket, and the
 * public discovery route says nothing about pairing.
 *
 * @module
 */

import { formatPairingCode } from './pairing.ts'
import type { PairedNotice, PairingRequests, PendingPairing } from './pairing-host.ts'

/** Path of the pairing control route on dsh's authenticated `/api` channel. */
export const PAIRING_API_PATH = '/api/bridge-browser.pairing'

/** Name of the slash command that lists and answers pairing requests. */
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

/** One waiting request as the control route reports it (the code is formatted for display). */
export type PairingRequestView = Omit<PendingPairing, 'expiresAt'> & { expiresInMs: number }

/** What the control route answers. */
export type PairingControlReply =
  | { ok: true; requests: PairingRequestView[]; paired?: PairedNotice }
  | { ok: false; error: 'bad-request' | 'gone'; requests?: PairingRequestView[] }

function json(body: PairingControlReply, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function view(requests: PairingRequests, now: () => number): { requests: PairingRequestView[]; paired?: PairedNotice } {
  const paired = requests.lastPaired()
  return {
    requests: requests.list().map(({ expiresAt, code, ...request }) => ({
      ...request, code: formatPairingCode(code), expiresInMs: Math.max(0, expiresAt - now()),
    })),
    ...(paired === undefined ? {} : { paired }),
  }
}

/**
 * Handle one request of the pairing control route. dsh has already
 * authenticated the caller as the host's owner.
 * @param requests - the bridge's pairing requests.
 * @param request - a POST whose JSON body is `{ action: 'list' }` or `{ action: 'approve' | 'deny', id }`.
 * @param now - clock (for the remaining time of each request).
 */
export async function handlePairingControl(requests: PairingRequests, request: Request, now: () => number = Date.now): Promise<Response> {
  let body: { action?: unknown; id?: unknown } | null
  try {
    body = (await request.json()) as { action?: unknown; id?: unknown } | null
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400)
  }
  const action = body?.action
  if (action === 'list') return json({ ok: true, ...view(requests, now) })
  if ((action === 'approve' || action === 'deny') && typeof body?.id === 'string') {
    const done = action === 'approve' ? requests.approve(body.id) : requests.deny(body.id)
    // Gone: answered elsewhere, expired, or the browser closed its request.
    return done ? json({ ok: true, ...view(requests, now) }) : json({ ok: false, error: 'gone', requests: view(requests, now).requests }, 409)
  }
  return json({ ok: false, error: 'bad-request' }, 400)
}

function describe(request: PendingPairing): string {
  return `${request.name}${request.origin === '' ? '' : ` (${request.origin})`} wants to connect, code ${formatPairingCode(request.code)}`
}

/**
 * Run `/browser-pair`, `/browser-pair approve <code>`, `/browser-pair deny`.
 * Approving by code makes the user read the code off their browser.
 * @param requests - the bridge's pairing requests.
 * @param rawInput - everything after the command name.
 */
export function runPairingCommand(
  requests: PairingRequests,
  rawInput: string,
): { kind: 'success'; text: string } | { kind: 'error'; text: string } {
  const words = rawInput.trim().split(/\s+/u).filter(word => word !== '')
  const usage = `Usage: /${PAIRING_COMMAND_NAME} | /${PAIRING_COMMAND_NAME} approve <code> | /${PAIRING_COMMAND_NAME} deny`
  if (words.length === 0) {
    const waiting = requests.list()
    if (waiting.length === 0) {
      return { kind: 'success', text: 'No browser is asking to connect. Open the DSH browser extension; it shows a code and asks here.' }
    }
    return {
      kind: 'success',
      text: `${waiting.map(describe).join('\n')}\n`
        + `Approve only a code that your own browser shows: /${PAIRING_COMMAND_NAME} approve <code>. `
        + `/${PAIRING_COMMAND_NAME} deny refuses every request.`,
    }
  }
  const verb = words[0]!.toLowerCase()
  if (verb === 'deny' && words.length === 1) {
    const count = requests.list().length
    requests.denyAll()
    return { kind: 'success', text: count === 0 ? 'No browser was asking to connect.' : `Denied ${String(count)} pairing request${count === 1 ? '' : 's'}.` }
  }
  if (verb === 'approve' && words.length >= 2) {
    const outcome = requests.approveCode(words.slice(1).join(''))
    if (outcome === 'approved') {
      const paired = requests.lastPaired()
      return { kind: 'success', text: `Paired with ${paired?.name ?? 'the browser'}. It connects by itself now.` }
    }
    return {
      kind: 'error',
      text: outcome === 'ambiguous'
        ? 'More than one request shows that code, so none was approved. Deny them and ask again from the browser.'
        : 'No waiting request shows that code. Check the code in the browser extension (requests expire after 2 minutes).',
    }
  }
  return { kind: 'error', text: usage }
}

/**
 * Register the host-side pairing controls that this composition supports.
 * @param requests - the bridge's pairing requests.
 * @param services - the route and command registries, when present.
 * @returns disposers, in registration order.
 */
export function mountPairingControls(
  requests: PairingRequests,
  services: { fetch?: PairingFetchRegistry; commands?: PairingCommandRegistry },
): Array<() => unknown> {
  const disposers: Array<() => unknown> = []
  if (typeof services.fetch?.register === 'function') {
    disposers.push(services.fetch.register({
      path: PAIRING_API_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handlePairingControl(requests, request),
    }))
  }
  if (typeof services.commands?.register === 'function') {
    disposers.push(services.commands.register({
      name: PAIRING_COMMAND_NAME,
      description: 'Approve or deny a DSH browser extension that asks to connect to this host',
      input: { hint: '[approve <code> | deny]' },
      handler: invocation => runPairingCommand(requests, invocation.rawInput),
    }))
  }
  return disposers
}
