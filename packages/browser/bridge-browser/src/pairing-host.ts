/**
 * Host half of one-step pairing: the requests that wait for a code, the
 * attempt a typed code makes against them, the limits, and the record of
 * extensions that paired.
 *
 * The extension shows a code; the user types it into DSH. Nothing on the
 * host shows a code, and nothing can be approved by a click: the only way a
 * requester gets the token is to hold the code the user typed (pairing.ts).
 * A requester's own words (its browser name) are a hint, never a fact.
 *
 * What the bridge holds for unauthenticated sockets is one share and a
 * socket per waiting request, bounded:
 *
 * - at most {@link MAX_PENDING_PAIRINGS} wait, {@link MAX_PENDING_PER_ORIGIN}
 *   per Origin; when the queue is full a new request takes the place of the
 *   oldest one of the Origin that holds the most, so one requester cannot
 *   keep the others out by sitting on the slots;
 * - at most {@link MAX_REQUESTS_PER_ORIGIN_PER_MINUTE} requests per Origin
 *   and {@link MAX_REQUESTS_PER_MINUTE} in all per rolling minute;
 * - a request waits {@link PAIRING_REQUEST_TTL_MS} at most, and only while
 *   its socket stays open;
 * - a typed code is tried once against every waiting request and consumes
 *   all of them; a request never sees a second code;
 * - {@link MAX_FAILED_CONFIRMATIONS} failed confirmations within
 *   {@link FAILURE_WINDOW_MS} pause pairing until the user resumes it.
 *
 * Guessing: a requester that does not hold the user's code passes one
 * attempt with probability 2^-30, and attempts happen only when the user
 * types a code. At most {@link MAX_PENDING_PAIRINGS} requests ride on one
 * typed code (8 × 2^-30 ≈ 7.5 × 10^-9), and once
 * {@link MAX_FAILED_CONFIRMATIONS} have failed pairing stays paused until
 * the user resumes it, so an attacker gets at most 8 + 4 = 12 guesses
 * (≈ 1.1 × 10^-8) between two deliberate resumes.
 *
 * Entering codes, pausing and unpairing are host-side controls only
 * (pairing-mount.ts): dsh's authenticated `/api` route and `/browser-pair`.
 *
 * @module
 */

import { normalizePairingCode } from './pairing.ts'
import { readTrustedJson, serialQueue, writePrivateFile } from './private-file.ts'

/** How long a pairing request waits for its code to be entered. */
export const PAIRING_REQUEST_TTL_MS = 2 * 60_000

/** Requests that may wait at once. */
export const MAX_PENDING_PAIRINGS = 8

/** Requests one Origin may have waiting at once. */
export const MAX_PENDING_PER_ORIGIN = 2

/** Requests accepted per rolling minute, in all. */
export const MAX_REQUESTS_PER_MINUTE = 30

/** Requests accepted per rolling minute from one Origin. */
export const MAX_REQUESTS_PER_ORIGIN_PER_MINUTE = 6

/** Failed confirmations within {@link FAILURE_WINDOW_MS} that pause pairing. */
export const MAX_FAILED_CONFIRMATIONS = 5

/** The window {@link MAX_FAILED_CONFIRMATIONS} is counted over. */
export const FAILURE_WINDOW_MS = 10 * 60_000

/** Most Chrome extension IDs the pairing record keeps (oldest dropped first). */
export const MAX_PAIRED_EXTENSION_IDS = 32

/** File name (under the dsh home) of the Chrome extension IDs that paired. */
export const PAIRED_EXTENSIONS_FILE_NAME = 'browser-paired-extensions.json'

const CHROME_EXTENSION_ID = /^[a-p]{32}$/u

/** How one waiting request fared against a typed code. */
export type PairingAttemptOutcome =
  /** The requester held the code, received the token and acknowledged it. */
  | 'paired'
  /** The requester held the code and was sent the token, but did not acknowledge it. */
  | 'unconfirmed'
  /** The requester did not hold the code (or went away): it received nothing keyed. */
  | 'failed'

/** What entering a code did. */
export type PairingEnterResult =
  | 'paired' | 'unconfirmed'
  /** No waiting request holds that code. */
  | 'no-match'
  /** No request is waiting (nothing was attempted or counted). */
  | 'none-waiting'
  /** The input cannot be a code (nothing was attempted). */
  | 'invalid'
  /** Pairing is paused (nothing was attempted). */
  | 'paused'
  /** Another code is being tried right now. */
  | 'busy'

/** Why a waiting request was dropped without an attempt. */
export type PairingDropReason = 'expired' | 'replaced' | 'paused'

/** Why a request was not admitted. */
export type PairingRefusal = 'paused' | 'rate'

/** The last successful pairing, for the host's confirmation line. */
export interface PairedNotice {
  origin: string
  name: string
  at: number
}

/** What the host UI shows about pairing; never a code. */
export interface PairingDeskStatus {
  paused: boolean
  /** Why it is paused: the user asked, or too many failed attempts. */
  pauseReason?: 'user' | 'failures'
  /** Requests waiting for a code. */
  waiting: number
  /** Browser names the waiting requesters gave (hints, from the fixed list). */
  hints: string[]
  /** Failed confirmations in the current window. */
  failures: number
  paired?: PairedNotice
}

interface Waiting {
  id: number
  origin: string
  name: string
  expiresAt: number
  attempt: (code: string) => Promise<PairingAttemptOutcome>
  drop: (reason: PairingDropReason) => void
}

/** The pairing desk of one bridge. */
export class PairingDesk {
  private readonly waitingList = new Map<number, Waiting>()
  private readonly arrivals: Array<{ at: number; origin: string }> = []
  private failures: number[] = []
  private serial = 0
  private pause: 'user' | 'failures' | undefined
  private entering = false
  private last: PairedNotice | undefined

  constructor(
    private readonly now: () => number = Date.now,
    /** Told about refusals, drops, failed attempts and pauses (the plugin logs them). */
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * Whether a request from `origin` may be taken now; counts it when it may.
   * Called before the bridge keeps anything for the requester.
   */
  admit(origin: string): PairingRefusal | undefined {
    if (this.pause !== undefined) return 'paused'
    const now = this.now()
    while (this.arrivals.length > 0 && now - this.arrivals[0]!.at >= 60_000) this.arrivals.shift()
    const fromOrigin = this.arrivals.filter(arrival => arrival.origin === origin).length
    if (this.arrivals.length >= MAX_REQUESTS_PER_MINUTE || fromOrigin >= MAX_REQUESTS_PER_ORIGIN_PER_MINUTE) {
      this.log(`pairing: refused a request from ${origin} (too many requests this minute)`)
      return 'rate'
    }
    this.arrivals.push({ at: now, origin })
    return undefined
  }

  /**
   * Keep an admitted request until a code is entered.
   * @param request - who asks, as far as the bridge knows (the Origin header) and as it says (the name).
   * @param attempt - run the exchange with a typed code; resolves with how it ended.
   * @param drop - the request is dropped without an attempt (close its socket).
   * @returns `withdraw`, for when the socket goes away.
   */
  enqueue(
    request: { origin: string; name: string },
    attempt: (code: string) => Promise<PairingAttemptOutcome>,
    drop: (reason: PairingDropReason) => void,
  ): { withdraw: () => void } {
    this.prune()
    const sameOrigin = [...this.waitingList.values()].filter(entry => entry.origin === request.origin)
    // One Origin's newest requests are the live ones; its older ones give way first.
    if (sameOrigin.length >= MAX_PENDING_PER_ORIGIN) this.evict(sameOrigin[0]!)
    else if (this.waitingList.size >= MAX_PENDING_PAIRINGS) this.evict(this.oldestOfBusiestOrigin())
    const id = ++this.serial
    this.waitingList.set(id, { id, ...request, expiresAt: this.now() + PAIRING_REQUEST_TTL_MS, attempt, drop })
    return { withdraw: () => { this.waitingList.delete(id) } }
  }

  /**
   * Try the code the user typed against every waiting request. Each request
   * is consumed by this one attempt, and so is the code.
   */
  async enter(input: string): Promise<PairingEnterResult> {
    const code = normalizePairingCode(input)
    if (code === undefined) return 'invalid'
    if (this.pause !== undefined) return 'paused'
    if (this.entering) return 'busy'
    this.prune()
    const requests = [...this.waitingList.values()]
    if (requests.length === 0) return 'none-waiting'
    this.waitingList.clear()
    this.entering = true
    try {
      const outcomes = await Promise.all(requests.map(async (request) => {
        const outcome = await request.attempt(code).catch((): PairingAttemptOutcome => 'failed')
        return { request, outcome }
      }))
      const failed = outcomes.filter(entry => entry.outcome === 'failed')
      for (const { request } of failed) this.log(`pairing: a request from ${request.origin} did not hold the entered code`)
      this.recordFailures(failed.length)
      const success = outcomes.find(entry => entry.outcome === 'paired') ?? outcomes.find(entry => entry.outcome === 'unconfirmed')
      if (success === undefined) return 'no-match'
      this.last = { origin: success.request.origin, name: success.request.name, at: this.now() }
      this.log(`pairing: paired ${success.request.origin}`)
      return success.outcome === 'paired' ? 'paired' : 'unconfirmed'
    } finally {
      this.entering = false
    }
  }

  /** Stop taking requests and codes, and drop every waiting request. */
  pausePairing(reason: 'user' | 'failures' = 'user'): void {
    if (this.pause === undefined) this.log(`pairing: paused (${reason === 'user' ? 'by the user' : 'too many failed attempts'})`)
    this.pause = reason
    for (const entry of [...this.waitingList.values()]) {
      this.waitingList.delete(entry.id)
      entry.drop('paused')
    }
  }

  /** Take requests and codes again; the failure count starts over. */
  resumePairing(): void {
    if (this.pause !== undefined) this.log('pairing: resumed')
    this.pause = undefined
    this.failures = []
  }

  /** Current state for the host UI. */
  status(): PairingDeskStatus {
    this.prune()
    const now = this.now()
    this.failures = this.failures.filter(at => now - at < FAILURE_WINDOW_MS)
    return {
      paused: this.pause !== undefined,
      ...(this.pause === undefined ? {} : { pauseReason: this.pause }),
      waiting: this.waitingList.size,
      hints: [...new Set([...this.waitingList.values()].map(entry => entry.name))],
      failures: this.failures.length,
      ...(this.last === undefined ? {} : { paired: this.last }),
    }
  }

  private recordFailures(count: number): void {
    if (count === 0) return
    const now = this.now()
    this.failures = this.failures.filter(at => now - at < FAILURE_WINDOW_MS)
    for (let index = 0; index < count; index += 1) this.failures.push(now)
    if (this.failures.length >= MAX_FAILED_CONFIRMATIONS) this.pausePairing('failures')
  }

  private oldestOfBusiestOrigin(): Waiting {
    const counts = new Map<string, number>()
    for (const entry of this.waitingList.values()) counts.set(entry.origin, (counts.get(entry.origin) ?? 0) + 1)
    const most = Math.max(...counts.values())
    // Map order is insertion order: the first entry of a busiest Origin is its oldest.
    return [...this.waitingList.values()].find(entry => counts.get(entry.origin) === most)!
  }

  private evict(entry: Waiting): void {
    this.waitingList.delete(entry.id)
    this.log(`pairing: a newer request replaced a waiting one from ${entry.origin}`)
    entry.drop('replaced')
  }

  /** Drop every request whose time ran out. */
  private prune(): void {
    const now = this.now()
    for (const entry of [...this.waitingList.values()]) {
      if (now < entry.expiresAt) continue
      this.waitingList.delete(entry.id)
      entry.drop('expired')
    }
  }
}

/** The Chrome extension ID of a `chrome-extension://<id>` origin, if it is one. */
export function chromeExtensionIdOfOrigin(origin: string | undefined): string | undefined {
  return /^chrome-extension:\/\/([a-p]{32})$/u.exec(origin ?? '')?.[1]
}

/** The Chrome extension IDs that paired with this bridge, persisted privately. */
export interface PairedExtensions {
  /** The IDs, oldest first. */
  list(): string[]
  /** Record an ID that paired. */
  add(id: string): Promise<void>
  /** Forget an ID. @returns whether it was there. */
  remove(id: string): Promise<boolean>
}

/**
 * Load the record of paired Chrome extension IDs. The file grants access, so
 * it is read only when it is a regular file of this user that nobody else
 * can write ({@link readTrustedJson}); otherwise it counts as empty.
 * @param file - the record's path.
 * @param warn - told when the file is ignored.
 */
export async function filePairedExtensions(file: string, warn: (message: string) => void = () => {}): Promise<PairedExtensions> {
  const loaded = await readTrustedJson(file)
  if ('ignored' in loaded) warn(`browser bridge: ignoring the paired-extension record ${file}: ${loaded.ignored}`)
  const stored = 'value' in loaded ? (loaded.value as { chromeExtensionIds?: unknown } | null)?.chromeExtensionIds : undefined
  let ids = Array.isArray(stored)
    ? [...new Set(stored.filter((id): id is string => typeof id === 'string' && CHROME_EXTENSION_ID.test(id)))].slice(-MAX_PAIRED_EXTENSION_IDS)
    : []
  const queue = serialQueue()
  const persist = (): Promise<void> => queue(() =>
    writePrivateFile(file, `${JSON.stringify({ version: 1, chromeExtensionIds: ids }, null, 2)}\n`, 'the paired-extension record'))
  return {
    list: () => [...ids],
    add: async (id) => {
      if (!CHROME_EXTENSION_ID.test(id) || ids.includes(id)) return
      ids = [...ids, id].slice(-MAX_PAIRED_EXTENSION_IDS)
      await persist()
    },
    remove: async (id) => {
      if (!ids.includes(id)) return false
      ids = ids.filter(candidate => candidate !== id)
      await persist()
      return true
    },
  }
}
