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
 * - at most {@link MAX_PENDING_PAIRINGS} wait. When the queue is full a new
 *   request takes the place of the oldest one. Replacement was chosen over
 *   refusing the newcomer because the genuine request is normally the most
 *   recent one (the user has just opened the panel and is about to type its
 *   code): with refusal, whoever holds the slots keeps the user out for as
 *   long as it likes; with replacement it has to keep flooding, and the
 *   request it pushes out is told so and asks again;
 * - at most {@link MAX_REQUESTS_PER_MINUTE} requests are taken per rolling
 *   minute. The limits are global on purpose: the only thing that names a
 *   requester is its Origin header, which a local process chooses freely, so
 *   a per-Origin limit would be a tool against the genuine extension;
 * - a request waits {@link PAIRING_REQUEST_TTL_MS} at most, and only while
 *   its socket stays open;
 * - a typed code is tried once against every waiting request and consumes
 *   all of them; a request never sees a second code;
 * - {@link MAX_FAILED_CONFIRMATIONS} failed confirmations within
 *   {@link FAILURE_WINDOW_MS} pause pairing until the user resumes it.
 *
 * Guessing: a requester that does not hold the user's code passes one
 * attempt with probability 2^-30, and an attempt happens only when the user
 * types a code. What is bounded is therefore per code and per window, not a
 * lifetime total: at most {@link MAX_PENDING_PAIRINGS} requests ride on one
 * typed code (8 × 2^-30 ≈ 7.5 × 10^-9 for that code), and the code that
 * brings the failures in the window to {@link MAX_FAILED_CONFIRMATIONS}
 * pauses pairing. An attacker that stays below the pause gets at most
 * {@link MAX_FAILED_CONFIRMATIONS} − 1 guesses per window, each needing the
 * user to type a code; it cannot make the user type.
 *
 * Local denial of pairing is not prevented: a process that keeps flooding
 * can use up the rate or push the genuine request out. It is made visible
 * (the requester is told it was replaced, refusals are logged, the host
 * shows how many wait and who they say they are) instead.
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

/** Requests accepted per rolling minute. */
export const MAX_REQUESTS_PER_MINUTE = 30

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

/** A waiting request as the host shows it: who the socket says it is, and whether that is an extension this bridge knows. */
export interface WaitingPairing {
  /** The socket's Origin header (an extension origin). A browser sets it; a local process can forge it. */
  origin: string
  /** The browser name the requester gave (a hint, from the fixed list). */
  name: string
  /** Whether the Origin is one of the extension IDs this bridge is configured to accept (the published build). */
  official: boolean
}

/** What the host UI shows about pairing; never a code. */
export interface PairingDeskStatus {
  paused: boolean
  /** Why it is paused: the user asked, or too many failed attempts. */
  pauseReason?: 'user' | 'failures'
  /** Requests waiting for a code. */
  waiting: number
  /** The waiting requests, oldest first. */
  requests: WaitingPairing[]
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
  private readonly arrivals: number[] = []
  private failures: number[] = []
  private serial = 0
  private pause: 'user' | 'failures' | undefined
  private entering = false
  private last: PairedNotice | undefined

  constructor(
    private readonly now: () => number = Date.now,
    /** Told about refusals, drops, failed attempts and pauses (the plugin logs them). */
    private readonly log: (message: string) => void = () => {},
    /** Whether an Origin is one of the extension IDs this bridge is configured to accept. */
    private readonly official: (origin: string) => boolean = () => false,
  ) {}

  /**
   * Whether a request from `origin` may be taken now; counts it when it may.
   * Called before the bridge keeps anything for the requester.
   */
  admit(origin: string): PairingRefusal | undefined {
    if (this.pause !== undefined) return 'paused'
    const now = this.now()
    while (this.arrivals.length > 0 && now - this.arrivals[0]! >= 60_000) this.arrivals.shift()
    if (this.arrivals.length >= MAX_REQUESTS_PER_MINUTE) {
      this.log(`pairing: refused a request from ${origin} (too many requests this minute)`)
      return 'rate'
    }
    this.arrivals.push(now)
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
    // Full: the oldest request gives way to the newest (see the module comment for why not the reverse).
    if (this.waitingList.size >= MAX_PENDING_PAIRINGS) this.evict(this.waitingList.values().next().value as Waiting)
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
    const attempts = requests.map(async (request) => {
      const outcome = await request.attempt(code).catch((): PairingAttemptOutcome => 'failed')
      if (outcome === 'failed') {
        this.log(`pairing: a request from ${request.origin} did not hold the entered code`)
        this.recordFailures(1)
      } else {
        this.last = { origin: request.origin, name: request.name, at: this.now() }
        this.log(`pairing: paired ${request.origin}`)
      }
      return outcome
    })
    const settled = Promise.all(attempts).finally(() => { this.entering = false })
    // The user is answered as soon as one request pairs; the others (which
    // can only fail or time out) are settled, and counted, in the background.
    const firstPaired = new Promise<PairingAttemptOutcome>((resolve) => {
      for (const attempt of attempts) void attempt.then((outcome) => { if (outcome === 'paired') resolve(outcome) })
    })
    const outcome = await Promise.race([firstPaired, settled.then(outcomes => outcomes.find(entry => entry === 'unconfirmed') ?? 'failed')])
    return outcome === 'failed' ? 'no-match' : outcome
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
      requests: [...this.waitingList.values()].map(entry => ({ origin: entry.origin, name: entry.name, official: this.official(entry.origin) })),
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

/** The extensions that paired with this bridge, persisted privately. */
export interface PairedExtensions {
  /** The paired extension origins, oldest first (`chrome-extension://<id>` and `moz-extension://<uuid>`). */
  origins(): string[]
  /** The Chrome extension IDs among them (what the bridge's Origin allowlist takes). */
  chromeIds(): string[]
  /** Firefox origins the user unpaired: refused at the Origin check from then on. */
  revokedOrigins(): string[]
  /** Record an origin that paired (a revoked one is allowed again). */
  add(origin: string): Promise<void>
  /** Forget a paired origin; a Firefox origin is also recorded as revoked. @returns whether it was paired. */
  remove(origin: string): Promise<boolean>
}

const FIREFOX_ORIGIN = /^moz-extension:\/\/[0-9a-f-]{36}$/u
const isPairedOrigin = (origin: unknown): origin is string =>
  typeof origin === 'string' && (chromeExtensionIdOfOrigin(origin) !== undefined || FIREFOX_ORIGIN.test(origin))

/**
 * Load the record of paired extensions. The file grants access, so it is
 * read only when it is a regular file of this user that nobody else can
 * write ({@link readTrustedJson}); otherwise it counts as empty.
 *
 * Chrome extensions are identified by their ID, so pairing allows one and
 * unpairing disallows it. Firefox gives every install its own
 * `moz-extension://<uuid>` origin and the bridge accepts any of them that
 * proves the token (the manual-token path stays as it was), so a paired
 * Firefox origin is listed here to be shown and unpaired, and unpairing puts
 * it on a refusal list the handshake checks.
 * @param file - the record's path.
 * @param warn - told when the file is ignored.
 */
export async function filePairedExtensions(file: string, warn: (message: string) => void = () => {}): Promise<PairedExtensions> {
  const loaded = await readTrustedJson(file)
  if ('ignored' in loaded) warn(`browser bridge: ignoring the paired-extension record ${file}: ${loaded.ignored}`)
  const stored = 'value' in loaded && typeof loaded.value === 'object' && loaded.value !== null
    ? loaded.value as { chromeExtensionIds?: unknown; firefoxOrigins?: unknown; revokedFirefoxOrigins?: unknown }
    : {}
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  let paired = [...new Set([
    ...strings(stored.chromeExtensionIds).filter(id => CHROME_EXTENSION_ID.test(id)).map(id => `chrome-extension://${id}`),
    ...strings(stored.firefoxOrigins).filter(origin => FIREFOX_ORIGIN.test(origin)),
  ])].slice(-MAX_PAIRED_EXTENSION_IDS)
  let revoked = [...new Set(strings(stored.revokedFirefoxOrigins).filter(origin => FIREFOX_ORIGIN.test(origin)))].slice(-MAX_PAIRED_EXTENSION_IDS)
  const chromeIds = (): string[] => paired.map(chromeExtensionIdOfOrigin).filter((id): id is string => id !== undefined)
  const queue = serialQueue()
  const persist = (): Promise<void> => queue(() => writePrivateFile(file, `${JSON.stringify({
    version: 2,
    chromeExtensionIds: chromeIds(),
    firefoxOrigins: paired.filter(origin => FIREFOX_ORIGIN.test(origin)),
    revokedFirefoxOrigins: revoked,
  }, null, 2)}\n`, 'the paired-extension record'))
  return {
    origins: () => [...paired],
    chromeIds,
    revokedOrigins: () => [...revoked],
    add: async (origin) => {
      if (!isPairedOrigin(origin)) return
      const wasRevoked = revoked.includes(origin)
      if (paired.includes(origin) && !wasRevoked) return
      revoked = revoked.filter(candidate => candidate !== origin)
      if (!paired.includes(origin)) paired = [...paired, origin].slice(-MAX_PAIRED_EXTENSION_IDS)
      await persist()
    },
    remove: async (origin) => {
      if (!paired.includes(origin)) return false
      paired = paired.filter(candidate => candidate !== origin)
      if (FIREFOX_ORIGIN.test(origin)) revoked = [...revoked, origin].slice(-MAX_PAIRED_EXTENSION_IDS)
      await persist()
      return true
    },
  }
}
