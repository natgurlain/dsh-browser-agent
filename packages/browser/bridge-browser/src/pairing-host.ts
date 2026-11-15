/**
 * Host half of one-step pairing: the requests waiting for the user's answer,
 * and the record of extensions that were approved.
 *
 * Of the two shapes the design allowed ("the host opens a window and shows a
 * code to type" or "the extension asks and the host approves"), this is the
 * second: the user opens the extension, sees a short code, and answers one
 * prompt in DSH that shows the same code. It costs the user no typing and no
 * terminal. What it costs the bridge is a small amount of state held for
 * unauthenticated sockets, so that state is bounded hard:
 *
 * - nothing is released to a requester before the user approves it: a
 *   request that is never answered gets no token and no allowlist entry;
 * - at most {@link MAX_PENDING_PAIRINGS} requests wait at once, each for at
 *   most {@link PAIRING_REQUEST_TTL_MS}, and only while its socket stays open;
 * - at most {@link MAX_PAIRING_REQUESTS_PER_MINUTE} exchanges are started per
 *   minute, whoever starts them;
 * - an approval is for one request and works once.
 *
 * Approving and denying are host-side controls only (pairing-mount.ts): dsh's
 * authenticated `/api` route and the `/browser-pair` command.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { normalizePairingCode } from './pairing.ts'
import { writePrivateFile } from './private-file.ts'

/** How long a pairing request waits for the user's answer. */
export const PAIRING_REQUEST_TTL_MS = 2 * 60_000

/** Requests that may wait for an answer at once. */
export const MAX_PENDING_PAIRINGS = 4

/** Pairing exchanges the bridge starts per rolling minute. */
export const MAX_PAIRING_REQUESTS_PER_MINUTE = 12

/** Most Chrome extension IDs the pairing record keeps (oldest dropped first). */
export const MAX_PAIRED_EXTENSION_IDS = 32

/** File name (under the dsh home) of the Chrome extension IDs that paired. */
export const PAIRED_EXTENSIONS_FILE_NAME = 'browser-paired-extensions.json'

const CHROME_EXTENSION_ID = /^[a-p]{32}$/u

/** How a pairing request ended. */
export type PairingDecision = 'approved' | 'denied' | 'expired'

/** One request as the host UI shows it. */
export interface PendingPairing {
  /** Handle for approve/deny; unguessable is not required (only host-side controls use it). */
  id: string
  /** The code to compare with the one the browser shows, unformatted. */
  code: string
  /** The requesting extension's origin (empty for a non-browser client). */
  origin: string
  /** The browser name the requester gave. */
  name: string
  /** When the request stops waiting (bridge clock, ms). */
  expiresAt: number
}

/** The last approval, for the host UI's confirmation line. */
export interface PairedNotice {
  origin: string
  name: string
  at: number
}

interface Entry extends PendingPairing {
  settle: (decision: PairingDecision) => void
}

/** The pairing requests of one bridge. */
export class PairingRequests {
  private readonly pending = new Map<string, Entry>()
  private readonly started: number[] = []
  private serial = 0
  private last: PairedNotice | undefined

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Whether a new exchange may start now; counts it when it may. Called
   * before the bridge does any work for the requester.
   */
  admit(): boolean {
    this.prune()
    const now = this.now()
    while (this.started.length > 0 && now - this.started[0]! >= 60_000) this.started.shift()
    if (this.started.length >= MAX_PAIRING_REQUESTS_PER_MINUTE || this.pending.size >= MAX_PENDING_PAIRINGS) return false
    this.started.push(now)
    return true
  }

  /**
   * Put a completed exchange in front of the user.
   * @param request - what the prompt shows.
   * @param settle - called exactly once with the decision, unless the request is withdrawn first.
   * @returns the request's expiry and a `withdraw` for when its socket closes, or `undefined` when too many are waiting.
   */
  submit(
    request: { code: string; origin: string; name: string },
    settle: (decision: PairingDecision) => void,
  ): { expiresAt: number; withdraw: () => void } | undefined {
    this.prune()
    if (this.pending.size >= MAX_PENDING_PAIRINGS) return undefined
    const id = `p${String(++this.serial)}`
    const expiresAt = this.now() + PAIRING_REQUEST_TTL_MS
    this.pending.set(id, { id, ...request, expiresAt, settle })
    return { expiresAt, withdraw: () => { this.pending.delete(id) } }
  }

  /** The requests waiting for an answer, oldest first. */
  list(): PendingPairing[] {
    this.prune()
    return [...this.pending.values()].map(({ settle: _settle, ...request }) => request)
  }

  /** The most recent approval, if any. */
  lastPaired(): PairedNotice | undefined {
    return this.last
  }

  /**
   * Approve one request: its requester, and nobody else, receives the token.
   * @returns false when the request is gone (answered, expired, or its socket closed).
   */
  approve(id: string): boolean {
    const entry = this.take(id)
    if (entry === undefined) return false
    this.last = { origin: entry.origin, name: entry.name, at: this.now() }
    entry.settle('approved')
    return true
  }

  /**
   * Approve the request that shows `code` (the command path, where the user
   * types what their browser shows).
   * @returns `none` when no waiting request shows that code, `ambiguous` when
   *   more than one does (neither is approved).
   */
  approveCode(input: string): 'approved' | 'none' | 'ambiguous' {
    const code = normalizePairingCode(input)
    const matches = code === undefined ? [] : this.list().filter(request => request.code === code)
    if (matches.length === 0) return 'none'
    if (matches.length > 1) return 'ambiguous'
    return this.approve(matches[0]!.id) ? 'approved' : 'none'
  }

  /** Deny one request. @returns false when it is gone. */
  deny(id: string): boolean {
    const entry = this.take(id)
    entry?.settle('denied')
    return entry !== undefined
  }

  /** Deny every waiting request (the plugin is unloading, or the user wants none of them). */
  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.deny(id)
  }

  private take(id: string): Entry | undefined {
    this.prune()
    const entry = this.pending.get(id)
    if (entry !== undefined) this.pending.delete(id)
    return entry
  }

  /** Settle every request whose time ran out. */
  private prune(): void {
    const now = this.now()
    for (const entry of [...this.pending.values()]) {
      if (now < entry.expiresAt) continue
      this.pending.delete(entry.id)
      entry.settle('expired')
    }
  }
}

/** The Chrome extension ID of a `chrome-extension://<id>` origin, if it is one. */
export function chromeExtensionIdOfOrigin(origin: string | undefined): string | undefined {
  return /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin ?? '')?.[1]
}

/**
 * Whether a socket with this Origin may ask to pair at all: any Chrome
 * extension, a Firefox extension, or a client that sends no Origin. A web
 * page always sends its own http(s) Origin and cannot forge another, so pages
 * are refused before any frame is read.
 */
export function isPairableOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === ''
    || origin.startsWith('moz-extension://')
    || chromeExtensionIdOfOrigin(origin) !== undefined
}

/**
 * Read the Chrome extension IDs that paired with this bridge.
 * @param file - the record's path.
 * @returns the IDs (empty when the file is absent or unreadable).
 */
export async function readPairedExtensionIds(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { chromeExtensionIds?: unknown }
    if (!Array.isArray(parsed.chromeExtensionIds)) return []
    return [...new Set(parsed.chromeExtensionIds.filter((id): id is string => typeof id === 'string' && CHROME_EXTENSION_ID.test(id)))]
      .slice(-MAX_PAIRED_EXTENSION_IDS)
  } catch {
    return []
  }
}

/**
 * Persist the Chrome extension IDs that paired (0600, never through a symlink).
 * @param file - the record's path.
 * @param ids - the IDs to keep, oldest first.
 */
export async function writePairedExtensionIds(file: string, ids: readonly string[]): Promise<void> {
  const kept = [...new Set(ids.filter(id => CHROME_EXTENSION_ID.test(id)))].slice(-MAX_PAIRED_EXTENSION_IDS)
  await writePrivateFile(file, `${JSON.stringify({ version: 1, chromeExtensionIds: kept }, null, 2)}\n`, 'the paired-extension record')
}
