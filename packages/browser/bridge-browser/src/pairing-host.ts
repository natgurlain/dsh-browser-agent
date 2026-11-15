/**
 * Host half of one-step pairing: the pairing window and the record of
 * extensions that paired.
 *
 * No window is open by default. One opens only when the user asks for it on
 * the host (the bridge's row in DSH Web settings, or the `/browser-pair`
 * command), which is something only a person who controls the DSH host can
 * do: both paths sit behind dsh's own authentication. Starting on the host
 * was chosen over "the extension asks, the host approves" because the bridge
 * then holds no state at all for unauthenticated sockets outside a window the
 * user opened: there is no request queue for a local process to fill or to
 * plant a look-alike request in.
 *
 * A window carries one code. It closes when the code is used once, when it
 * expires ({@link PAIRING_WINDOW_MS}), when its attempts run out
 * ({@link PAIRING_MAX_ATTEMPTS}), when the user cancels it, or when a new one
 * replaces it. Running out of attempts also blocks new windows for
 * {@link PAIRING_COOLDOWN_MS}, which bounds how fast codes can be guessed
 * however often a window is reopened.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { generatePairingCode } from './pairing.ts'
import { writePrivateFile } from './private-file.ts'

/** How long a pairing code stays valid. */
export const PAIRING_WINDOW_MS = 5 * 60_000

/** Exchanges one code may be tried in (each tests at most one guess). */
export const PAIRING_MAX_ATTEMPTS = 5

/** How long new windows are refused after one ran out of attempts. */
export const PAIRING_COOLDOWN_MS = 30_000

/** Most Chrome extension IDs the pairing record keeps (oldest dropped first). */
export const MAX_PAIRED_EXTENSION_IDS = 32

/** File name (under the dsh home) of the Chrome extension IDs that paired. */
export const PAIRED_EXTENSIONS_FILE_NAME = 'browser-paired-extensions.json'

const CHROME_EXTENSION_ID = /^[a-p]{32}$/u

/** What the host UI shows about pairing. The code itself is only returned by {@link PairingWindows.start}. */
export type PairingStatus =
  | { state: 'idle' }
  | { state: 'open'; expiresAt: number; attemptsLeft: number }
  | { state: 'paired'; at: number; origin: string }
  | { state: 'closed'; reason: 'expired' | 'attempts' | 'cancelled' }

/** Permission to run one exchange against the open window's code. */
export interface PairingTicket {
  /** The window this attempt belongs to. */
  window: number
  /** The code the exchange must be keyed with. */
  code: string
}

interface OpenWindow {
  id: number
  code: string
  expiresAt: number
  attemptsLeft: number
  /** Attempts handed out and not yet settled. */
  inFlight: number
}

/** The single pairing window of one bridge. */
export class PairingWindows {
  private window: OpenWindow | undefined
  private serial = 0
  private outcome: PairingStatus = { state: 'idle' }
  private cooldownUntil = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly generate: () => string = generatePairingCode,
  ) {}

  /**
   * Open a window with a fresh code, replacing any open one (its code stops
   * working). Only host-side controls call this.
   * @returns the code and its expiry, or when a new window may be opened.
   */
  start(): { ok: true; code: string; expiresAt: number } | { ok: false; retryAt: number } {
    const now = this.now()
    if (now < this.cooldownUntil) return { ok: false, retryAt: this.cooldownUntil }
    this.serial += 1
    this.window = { id: this.serial, code: this.generate(), expiresAt: now + PAIRING_WINDOW_MS, attemptsLeft: PAIRING_MAX_ATTEMPTS, inFlight: 0 }
    return { ok: true, code: this.window.code, expiresAt: this.window.expiresAt }
  }

  /** Close the open window, if any (the user changed their mind). */
  cancel(): void {
    if (this.live() === undefined) return
    this.close({ state: 'closed', reason: 'cancelled' })
  }

  /** Whether a new exchange would be admitted right now. */
  isOpen(): boolean {
    const window = this.live()
    return window !== undefined && window.attemptsLeft > 0
  }

  /** Current state for the host UI. */
  status(): PairingStatus {
    const window = this.live()
    return window === undefined
      ? this.outcome
      : { state: 'open', expiresAt: window.expiresAt, attemptsLeft: window.attemptsLeft }
  }

  /**
   * Admit one exchange: consumes an attempt whatever its outcome, so every
   * guess at the code costs one of the window's few attempts.
   * @returns the ticket, or `undefined` when no window admits an exchange.
   */
  attempt(): PairingTicket | undefined {
    const window = this.live()
    if (window === undefined || window.attemptsLeft <= 0) return undefined
    window.attemptsLeft -= 1
    window.inFlight += 1
    return { window: window.id, code: window.code }
  }

  /**
   * The exchange behind `ticket` failed or was abandoned. Once the last
   * attempt has settled this way the window closes and the cooldown starts.
   */
  fail(ticket: PairingTicket): void {
    const window = this.live()
    if (window === undefined || window.id !== ticket.window) return
    window.inFlight = Math.max(0, window.inFlight - 1)
    if (window.attemptsLeft <= 0 && window.inFlight === 0) {
      this.cooldownUntil = this.now() + PAIRING_COOLDOWN_MS
      this.close({ state: 'closed', reason: 'attempts' })
    }
  }

  /**
   * The exchange behind `ticket` verified. The window closes here, before the
   * token is released, so a code is good for exactly one pairing.
   * @param ticket - the attempt that verified.
   * @param origin - the extension origin that paired.
   * @returns false when the window is gone (expired, cancelled, replaced, or
   *   used by another exchange in the meantime); the token must not be sent.
   */
  complete(ticket: PairingTicket, origin: string): boolean {
    const window = this.live()
    if (window === undefined || window.id !== ticket.window) return false
    this.close({ state: 'paired', at: this.now(), origin })
    return true
  }

  /** The open window, after applying expiry. */
  private live(): OpenWindow | undefined {
    if (this.window !== undefined && this.now() >= this.window.expiresAt) this.close({ state: 'closed', reason: 'expired' })
    return this.window
  }

  private close(outcome: PairingStatus): void {
    this.window = undefined
    this.outcome = outcome
  }
}

/** The Chrome extension ID of a `chrome-extension://<id>` origin, if it is one. */
export function chromeExtensionIdOfOrigin(origin: string | undefined): string | undefined {
  return /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin ?? '')?.[1]
}

/**
 * Whether a socket with this Origin may attempt pairing at all (while a
 * window is open): any Chrome extension, a Firefox extension, or a client
 * that sends no Origin. A web page always sends its own http(s) Origin and
 * cannot forge another, so pages are refused before any frame is read.
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
