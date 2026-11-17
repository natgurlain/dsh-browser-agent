/**
 * Hash-chained, append-only audit log of everything the agent did through the
 * browser bridge: one JSONL file per Agent session under the dsh home (plus an
 * `unscoped` file for agentless calls), each line
 * `{ seq, ts, alg, prevHash, hash, kind, ... }` where `hash` is
 * HMAC-SHA256 under the bridge's private chain key over
 * `prevHash + "\n" + canonicalJson(entry without hash)`, and the chain head
 * is anchored (keyed) in `<log>.head` after every append (see
 * {@link AUDIT_KEY_FILE}). Editing, dropping, reordering, or truncating any
 * line breaks the chain or the anchor, which {@link verifyAuditChain} and
 * {@link verifyAuditHead} report.
 *
 * Nothing secret is written: typed text, dialog answers, evaluated code,
 * upload paths, and request bodies are reduced to their length, and URLs keep
 * their origin and path while risky query and fragment values are replaced.
 * Results are recorded as a digest and size, never their content.
 *
 * Files are created 0600 inside a 0700 directory. Appends to one file are
 * serialized, and the chain head is recovered from the file's last line on
 * first use so a host restart continues the same chain.
 *
 * @module dsh-browser-agent/src/audit-log
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { writePrivateFile } from './private-file.ts'

/**
 * Keyed chain (tamper evidence against anyone who can edit the log but not
 * read the bridge's key): new entries carry `alg: 'hmac-sha256'` and their
 * `hash` is HMAC-SHA256 under a random 32-byte key kept in
 * {@link AUDIT_KEY_FILE} (0600) beside the logs, so a rewritten history
 * cannot be re-hashed with the public {@link auditEntryHash}. After every
 * append the chain head (`seq`, `hash`) is anchored in `<log>.head` under
 * the same key, so dropping the tail is detected too. Logs written before
 * keying (no `alg`, plain sha256 links) verify and are reported `unkeyed`
 * only while no chain key exists; once one does, an all-unkeyed chain is
 * refused, since it is indistinguishable from a downgraded keyed one.
 */
export const AUDIT_KEY_FILE = '.chain-key'
/** `alg` of keyed entries. */
export const AUDIT_MAC_ALG = 'hmac-sha256'

/** What one entry records. */
export type AuditKind = 'tool-call' | 'approval' | 'result' | 'navigation' | 'kill-switch' | 'fixture' | 'schedule' | 'auto-review'

/** The first entry's `prevHash`. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64)

/** Masked placeholder for a URL component that may carry a credential. */
export const AUDIT_REDACTED = '[redacted]'

/** Fields a writer may set; the log adds `seq`, `ts`, `prevHash`, `hash`. */
export interface AuditEntryInput {
  kind: AuditKind
  /** Bridge-assigned tool-call id (correlates call, approval, and result). */
  callId?: string
  /** The model's tool-call id, when the call came from an Agent step. */
  toolCallId?: string
  /** Registry key of the extension connection (install) that served the call. */
  connection?: string
  tool?: string
  /** Masked argument preview: secrets reduced to their length. */
  args?: Record<string, unknown>
  /** sha256 of the canonical masked arguments. */
  argsDigest?: string
  origin?: string | undefined
  url?: string
  /**
   * Approval decision (`not-required`, `allowed`, `denied`, `timed-out`, ...);
   * on a `result` entry, the decision the call ran under.
   */
  decision?: string
  /** How a call ended (`result` entries). */
  outcome?: 'ok' | 'error'
  /** Policy layer: `blocked` (site/managed policy), `tainted` (needs review), `site-ask`, `site-trusted`. */
  policy?: string
  /** Why the policy layer decided so (URLs redacted). */
  policyReason?: string
  /** Strict mode (commit gate): `armed`, or `refused` when it could not intercept. */
  strictMode?: string
  /** Commit-gate decisions on page writes during the call. */
  commitDecisions?: string[]
  /** `sha256:<hex>` plus byte size of the canonical result, never the content. */
  resultDigest?: string
  /** Error code and a short message for a failed call. */
  error?: { code: string; message: string }
  durationMs?: number
  /** Step of a `browser_run` program: the program's approval call id and the 0-based step. */
  program?: { id: string; step: number }
  /** `auto-review` entries: the reviewer's one-sentence reason (or the bridge's, on failure). */
  reason?: string
  /** `auto-review` entries: `provider/model` of the reviewer. */
  model?: string
  /** `auto-review` entries: the approval binding the review answered. */
  binding?: string
  /** `auto-review` entries: why the review ended as it did (fixed vocabulary), and why it failed. */
  code?: string
  failure?: string
}

/** One persisted, chained entry. */
export interface AuditEntry extends AuditEntryInput {
  seq: number
  ts: string
  sessionId?: string
  /** `hmac-sha256` for keyed entries; absent on legacy sha256 entries. */
  alg?: typeof AUDIT_MAC_ALG
  prevHash: string
  hash: string
}

/** Result of {@link verifyAuditChain}. */
export interface AuditVerification {
  ok: boolean
  count: number
  /** Index (0-based line) of the first entry that breaks the chain. */
  brokenAt?: number
  reason?: string
  /** Every entry predates keying (plain sha256): edits that re-hash cannot be detected. */
  unkeyed?: true
}

/** The export handed to the panel's "Export audit log" button. */
export interface AuditExport {
  format: 'dsh-browser-audit/v1'
  sessionId: string | null
  exportedAt: string
  verification: AuditVerification
  entries: unknown[]
}

/** Argument names whose values never enter the log (only their length). */
const SENSITIVE_ARG = /^(?:text|html|prompttext|value|values|expression|code|source|script|body|postdata|headers|paths|files?|password|passcode|passphrase|secret|token|cookies?|authorization|credentials?|otp|pin)$/iu
/** Query/fragment parameter names that commonly carry credentials. */
const RISKY_PARAM = /(?:token|key|secret|code|auth|session|sid|sig|signature|pass|pwd|jwt|nonce|otp|ticket|credential|bearer|state|hash|saml|assertion)/iu
const OPAQUE_VALUE = /^[A-Za-z0-9+/=_~.-]{20,}$/u
const MAX_PREVIEW_STRING = 160
const MAX_PREVIEW_DEPTH = 4

/** Canonical JSON: object keys sorted at every depth, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object' && value !== null) {
    // No prototype: an own "__proto__" key stays an ordinary member instead of
    // vanishing into the prototype setter (two entries must never hash alike).
    const sorted = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) sorted[key] = sortKeys(child)
    }
    return sorted
  }
  return value
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The legacy (unkeyed) chained hash of one entry (everything but `hash` itself). */
export function auditEntryHash(entry: Omit<AuditEntry, 'hash'> | Record<string, unknown>): string {
  const { hash: _hash, ...rest } = entry as Record<string, unknown>
  return sha256(`${String(rest.prevHash)}\n${canonicalJson(rest)}`)
}

/** The keyed chained hash of one entry: HMAC-SHA256 over the same text as {@link auditEntryHash}. */
export function auditEntryMac(key: Buffer, entry: Omit<AuditEntry, 'hash'> | Record<string, unknown>): string {
  const { hash: _hash, ...rest } = entry as Record<string, unknown>
  return createHmac('sha256', key).update(`${String(rest.prevHash)}\n${canonicalJson(rest)}`).digest('hex')
}

/** MAC of one log's head anchor. */
function headMac(key: Buffer, file: string, seq: number, hash: string): string {
  return createHmac('sha256', key).update(`dsh-browser-audit-head/v1\n${basename(file)}\n${String(seq)}\n${hash}`).digest('hex')
}

/** A key file's bytes: 64 hex characters. */
function parseKey(raw: Buffer): Buffer | undefined {
  const text = raw.toString('utf8').trim()
  return /^[0-9a-f]{64}$/u.test(text) ? Buffer.from(text, 'hex') : undefined
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Keep a URL's origin and path; replace credentials, risky or opaque query
 * and fragment values, and long opaque path segments.
 * @param raw - the URL as supplied.
 * @returns the redacted URL, or `[redacted]` when it does not parse.
 */
export function redactAuditUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return AUDIT_REDACTED
  }
  url.username = ''
  url.password = ''
  url.pathname = url.pathname.split('/').map((segment) => (
    segment.length >= 32 && OPAQUE_VALUE.test(segment) ? AUDIT_REDACTED : segment
  )).join('/')
  const params = [...url.searchParams.entries()]
  if (params.length > 0) {
    const kept = new URLSearchParams()
    for (const [name, value] of params) kept.append(name, riskyParam(name, value) ? AUDIT_REDACTED : value)
    url.search = kept.toString()
  }
  if (url.hash.length > 1) {
    const fragment = url.hash.slice(1)
    if (fragment.includes('=')) {
      const kept = new URLSearchParams()
      for (const [name, value] of new URLSearchParams(fragment)) kept.append(name, riskyParam(name, value) ? AUDIT_REDACTED : value)
      url.hash = kept.toString()
    } else if (fragment.length > 32 || OPAQUE_VALUE.test(fragment)) {
      url.hash = AUDIT_REDACTED
    }
  }
  return url.toString()
}

/** Every URL inside free text (error messages, previews). */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/giu

/**
 * Redact every URL embedded in free text, e.g. an approval failure that
 * quotes the destination of a denied navigation.
 * @param text - any text that may contain URLs.
 * @returns the text with each URL passed through {@link redactAuditUrl}.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    // Keep sentence punctuation that the greedy match swallowed outside the URL.
    const trailing = /[.,;:!?)\]}]+$/u.exec(match)?.[0] ?? ''
    const url = trailing === '' ? match : match.slice(0, -trailing.length)
    return `${redactAuditUrl(url)}${trailing}`
  })
}

function riskyParam(name: string, value: string): boolean {
  return RISKY_PARAM.test(name) || value.length > 48 || (value.length >= 20 && OPAQUE_VALUE.test(value))
}

/** The origin of a URL, or undefined for opaque or unparsable ones. */
export function auditOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const origin = new URL(raw).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * Reduce tool arguments to a preview that is safe to keep forever.
 * @param args - the arguments as the model sent them.
 * @returns the masked preview.
 */
export function maskAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  return maskValue(args, 0) as Record<string, unknown>
}

function maskValue(value: unknown, depth: number, key?: string): unknown {
  if (key !== undefined && SENSITIVE_ARG.test(key) && value !== undefined && value !== null) {
    return { masked: true, ...measure(value) }
  }
  if (typeof value === 'string') {
    if (/^(?:https?|wss?):\/\/\S*$/iu.test(value) || (key !== undefined && /url|href/iu.test(key))) return redactAuditUrl(value)
    const text = redactUrlsInText(value)
    return text.length > MAX_PREVIEW_STRING ? `${text.slice(0, MAX_PREVIEW_STRING)}… (${text.length} chars)` : text
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_PREVIEW_DEPTH) return { items: value.length }
    return value.slice(0, 20).map((item) => maskValue(item, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    if (depth >= MAX_PREVIEW_DEPTH) return { keys: Object.keys(value).length }
    const masked: Record<string, unknown> = {}
    const record = value as Record<string, unknown>
    for (const [childKey, child] of Object.entries(value)) {
      // browser_press: a printable key, or any key sent as trusted typing,
      // is typed text one character at a time.
      masked[childKey] = childKey === 'key' && typeof child === 'string' && ([...child].length === 1 || record.trusted === true)
        ? { masked: true, length: child.length }
        : maskValue(child, depth + 1, childKey)
    }
    return masked
  }
  return value
}

function measure(value: unknown): { length?: number; items?: number } {
  if (typeof value === 'string') return { length: value.length }
  if (Array.isArray(value)) return { items: value.length }
  return { length: canonicalJson(value).length }
}

/** `sha256:<hex>:<bytes>` of a result (content is never kept). */
export function auditResultDigest(result: unknown): string {
  const text = canonicalJson(result)
  return `sha256:${sha256(text)}:${Buffer.byteLength(text)}`
}

/**
 * Check every link of a chain. Legacy (unkeyed) entries are accepted only
 * before the first keyed one: a keyed log cannot be downgraded mid-chain,
 * and with a key an all-unkeyed chain is refused (full downgrade).
 * @param entries - parsed lines in file order (non-objects count as broken).
 * @param key - the chain key; keyed entries fail without it.
 * @returns whether the chain is intact and, if not, where it first breaks.
 */
export function verifyAuditChain(entries: readonly unknown[], key?: Buffer): AuditVerification {
  let previous = AUDIT_GENESIS_HASH
  let expectedSeq: number | undefined
  let keyed = false
  for (const [index, raw] of entries.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, count: entries.length, brokenAt: index, reason: 'line is not a JSON object' }
    }
    const entry = raw as Record<string, unknown>
    if (typeof entry.seq !== 'number' || typeof entry.hash !== 'string' || typeof entry.prevHash !== 'string') {
      return { ok: false, count: entries.length, brokenAt: index, reason: 'entry is missing seq, prevHash, or hash' }
    }
    if (expectedSeq === undefined) {
      if (entry.seq !== 1) return { ok: false, count: entries.length, brokenAt: index, reason: 'the chain does not start at seq 1' }
    } else if (entry.seq !== expectedSeq) {
      return { ok: false, count: entries.length, brokenAt: index, reason: `expected seq ${expectedSeq}, found ${String(entry.seq)}` }
    }
    if (entry.prevHash !== previous) {
      return { ok: false, count: entries.length, brokenAt: index, reason: 'prevHash does not match the previous entry' }
    }
    if (entry.alg === AUDIT_MAC_ALG) {
      if (key === undefined) {
        return { ok: false, count: entries.length, brokenAt: index, reason: 'keyed entry but the chain key is missing' }
      }
      if (!sameHex(auditEntryMac(key, entry), entry.hash)) {
        return { ok: false, count: entries.length, brokenAt: index, reason: 'hash does not match the entry content (keyed)' }
      }
      keyed = true
    } else if (entry.alg !== undefined) {
      return { ok: false, count: entries.length, brokenAt: index, reason: `unknown alg ${JSON.stringify(entry.alg)}` }
    } else if (keyed) {
      return { ok: false, count: entries.length, brokenAt: index, reason: 'unkeyed entry after keyed entries' }
    } else if (auditEntryHash(entry) !== entry.hash) {
      return { ok: false, count: entries.length, brokenAt: index, reason: 'hash does not match the entry content' }
    }
    previous = entry.hash
    expectedSeq = entry.seq + 1
  }
  if (entries.length > 0 && !keyed) {
    // With a chain key present, an all-unkeyed chain cannot be told apart
    // from a keyed one downgraded (alg stripped, re-hashed with the public
    // function, head anchor deleted): refuse it.
    if (key !== undefined) {
      return { ok: false, count: entries.length, brokenAt: 0, reason: 'unkeyed chain while the bridge holds a chain key (downgraded, or written before keying)' }
    }
    return { ok: true, count: entries.length, unkeyed: true }
  }
  return { ok: true, count: entries.length }
}

/** A log's anchored chain head. */
interface HeadAnchor {
  seq: number
  hash: string
  mac: string
}

function parseHead(text: string): HeadAnchor | undefined {
  try {
    const value = JSON.parse(text) as Partial<HeadAnchor>
    return typeof value.seq === 'number' && typeof value.hash === 'string' && typeof value.mac === 'string'
      ? { seq: value.seq, hash: value.hash, mac: value.mac }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Check a verified chain against its anchored head.
 * @param file - the log path (the anchor is bound to its name).
 * @param entries - the parsed lines.
 * @param chain - {@link verifyAuditChain}'s result.
 * @param headText - the head file's text, or undefined when there is none.
 * @param key - the chain key, if one exists.
 */
export function verifyAuditHead(
  file: string,
  entries: readonly unknown[],
  chain: AuditVerification,
  headText: string | undefined,
  key: Buffer | undefined,
): AuditVerification {
  if (!chain.ok) return chain
  const keyedEntries = entries.some((entry) => (entry as { alg?: unknown } | null)?.alg === AUDIT_MAC_ALG)
  if (headText === undefined) {
    return keyedEntries
      ? { ok: false, count: entries.length, brokenAt: entries.length, reason: 'the head anchor is missing (log truncated or rewritten?)' }
      : chain
  }
  const head = parseHead(headText)
  if (head === undefined || key === undefined || !sameHex(headMac(key, file, head.seq, head.hash), head.mac)) {
    return { ok: false, count: entries.length, brokenAt: entries.length, reason: 'the head anchor does not verify' }
  }
  const last = entries.at(-1) as { seq?: unknown; hash?: unknown } | undefined
  if (last?.seq !== head.seq || last.hash !== head.hash) {
    return {
      ok: false,
      count: entries.length,
      brokenAt: entries.length,
      reason: `the log was truncated or rewritten: the anchored head is seq ${String(head.seq)}, the file ends at seq ${String(last?.seq ?? 0)}`,
    }
  }
  return chain
}

/** Parse JSONL text; an unparsable line is kept as `null` so verification flags it. */
export function parseAuditLines(text: string): unknown[] {
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      return null
    }
  })
}

/** A file-safe name for one session's log. */
export function auditFileName(sessionId: string | undefined): string {
  if (sessionId === undefined) return 'unscoped.jsonl'
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u.test(sessionId)
    ? `s-${sessionId}.jsonl`
    : `h-${sha256(sessionId).slice(0, 40)}.jsonl`
}

interface ChainHead {
  seq: number
  hash: string
}

/** Append-only, per-session, hash-chained JSONL log. */
export class AuditLog {
  readonly directory: string
  private readonly now: () => number
  private readonly heads = new Map<string, Promise<ChainHead>>()
  private dirReady: Promise<void> | undefined
  private keyReady: Promise<Buffer> | undefined

  // Plain fields (no parameter properties) so Node can load this file by type stripping.
  constructor(directory: string, now: () => number = Date.now) {
    this.directory = directory
    this.now = now
  }

  /** Path of one session's file. */
  file(sessionId: string | undefined): string {
    return join(this.directory, auditFileName(sessionId))
  }

  /**
   * Append one entry to a session's chain.
   * @param sessionId - owning Agent session; undefined for agentless calls.
   * @param input - the entry body.
   * @returns the persisted entry.
   */
  append(sessionId: string | undefined, input: AuditEntryInput): Promise<AuditEntry> {
    const file = this.file(sessionId)
    const previous = this.heads.get(file) ?? this.recoverHead(file)
    let written!: AuditEntry
    const next = previous.then(async (head) => {
      await this.ensureDirectory()
      const key = await this.ensureKey()
      const body: Omit<AuditEntry, 'hash'> = {
        seq: head.seq + 1,
        ts: new Date(this.now()).toISOString(),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...input,
        alg: AUDIT_MAC_ALG,
        prevHash: head.hash,
      }
      written = { ...body, hash: auditEntryMac(key, body) }
      const handle = await open(file, 'a', 0o600)
      try {
        await handle.write(`${JSON.stringify(written)}\n`)
      } finally {
        await handle.close()
      }
      await chmod(file, 0o600)
      await this.writeHead(file, key, written.seq, written.hash)
      return { seq: written.seq, hash: written.hash }
    })
    // A failed write leaves the head where it was so the chain stays valid.
    this.heads.set(file, next.catch(() => previous))
    return next.then(() => written)
  }

  /** Read and verify one session's chain (empty when no file exists). */
  async read(sessionId: string | undefined): Promise<AuditExport> {
    const file = this.file(sessionId)
    // Let queued appends land first so an export includes them.
    await this.heads.get(file)?.catch(() => undefined)
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const entries = parseAuditLines(text)
    const key = await this.chainKey()
    const headText = await readFile(`${file}.head`, 'utf8').catch(() => undefined)
    return {
      format: 'dsh-browser-audit/v1',
      sessionId: sessionId ?? null,
      exportedAt: new Date(this.now()).toISOString(),
      verification: verifyAuditHead(file, entries, verifyAuditChain(entries, key), headText, key),
      entries,
    }
  }

  /** The chain key, when one exists (never creates it). */
  async chainKey(): Promise<Buffer | undefined> {
    if (this.keyReady !== undefined) return this.keyReady.catch(() => undefined)
    return readFile(join(this.directory, AUDIT_KEY_FILE)).then(parseKey, () => undefined)
  }

  /** Load the chain key, creating it (0600, exclusive) on first use. */
  private ensureKey(): Promise<Buffer> {
    this.keyReady ??= (async () => {
      const path = join(this.directory, AUDIT_KEY_FILE)
      try {
        await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const key = parseKey(await readFile(path))
      if (key === undefined) throw new Error(`audit chain key ${path} is malformed`)
      return key
    })()
    const ready = this.keyReady
    ready.catch(() => { if (this.keyReady === ready) this.keyReady = undefined })
    return ready
  }

  /** Atomically anchor a log's head. */
  private async writeHead(file: string, key: Buffer, seq: number, hash: string): Promise<void> {
    await writePrivateFile(`${file}.head`, JSON.stringify({ seq, hash, mac: headMac(key, file, seq, hash) }), 'the audit head anchor')
  }

  private ensureDirectory(): Promise<void> {
    this.dirReady ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
    })()
    const ready = this.dirReady
    // Retry on the next append if creating the directory failed.
    ready.catch(() => { if (this.dirReady === ready) this.dirReady = undefined })
    return ready
  }

  /**
   * The head to continue from: the verified anchor when there is one (so an
   * append after a truncation links to the anchored head and the gap stays
   * visible), else the file's last line.
   */
  private async recoverHead(file: string): Promise<ChainHead> {
    const key = await this.chainKey()
    const anchor = key === undefined ? undefined : parseHead(await readFile(`${file}.head`, 'utf8').catch(() => ''))
    if (key !== undefined && anchor !== undefined && sameHex(headMac(key, file, anchor.seq, anchor.hash), anchor.mac)) {
      return { seq: anchor.seq, hash: anchor.hash }
    }
    return readFile(file, 'utf8').then((text) => {
      const lines = parseAuditLines(text)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] as Partial<AuditEntry> | null
        if (line !== null && typeof line.seq === 'number' && typeof line.hash === 'string') {
          return { seq: line.seq, hash: line.hash }
        }
      }
      return { seq: 0, hash: AUDIT_GENESIS_HASH }
    }, () => ({ seq: 0, hash: AUDIT_GENESIS_HASH }))
  }
}

/** What the extension reports about one call before answering it. */
export interface AuditAnnotation {
  /**
   * Approval outcome: `not-required` (no approval applies), `auto-allowed` (a
   * standing rule such as a trusted site passed it without a card), `allowed`
   * (the user approved on a card), `denied`, `timed-out`, `unavailable`,
   * `cancelled`, or `held-expired` (paused past its deadline).
   */
  decision?: string
  /** URL of the controlled tab when the call ran. */
  url?: string
  /** New URL after a navigation the call caused. */
  navigatedTo?: string
  /** Time the call was held by the user's pause, in ms. */
  heldMs?: number
  /** Policy layer outcome: `blocked`, `tainted`, `site-ask`, `site-trusted`. */
  policy?: string
  policyReason?: string
  /** Strict mode: `armed` or `refused`. */
  strict?: string
  /** Commit-gate decisions on writes the page made during the call. */
  commit?: string[]
}

/** One call as the bridge dispatched it. */
export interface DispatchedCall {
  id: string
  name: string
  args: Record<string, unknown>
  sessionId?: string
  /** The model's tool-call id. */
  toolCallId?: string
  /** Connection (install) the call was routed to. */
  connection?: string
  /** This call is step `step` of the `browser_run` program approved by call `id`. */
  program?: { id: string; step: number }
}

/** Hooks the bridge server calls around every tool call. */
export interface BridgeAuditObserver {
  dispatched(call: DispatchedCall): void
  annotated(id: string, annotation: AuditAnnotation): void
  settled(id: string, outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void
  /** The kill switch: one entry in every session with calls in flight on `connection` (any, when undefined), else in the unscoped log. */
  killSwitch(connection?: string): void
  /** The Auto approve reviewer decided one action of call `id` (docs/auto-approve-design.md). */
  reviewed?(id: string, review: AuditReview): void
}

/** What one Auto approve review records. */
export interface AuditReview {
  decision: 'allow' | 'deny'
  reason: string
  model?: string
  latencyMs: number
  binding: string
  code: string
  failure?: string
}

interface TrackedCall {
  decision?: string
  policy?: string
  strictMode?: string
  connection?: string
  sessionId?: string
  toolCallId?: string
  name: string
  started: number
  url?: string
}

const PROMPT_DECISIONS = new Set(['allowed', 'auto-allowed', 'auto-approved', 'auto-reviewed', 'denied', 'timed-out', 'unavailable', 'cancelled', 'held-expired', 'program-approved'])
const MAX_ERROR_MESSAGE = 240

/** Turns bridge tool traffic into audit entries. Write failures never reach a tool call. */
export class ToolCallAuditor implements BridgeAuditObserver {
  private readonly calls = new Map<string, TrackedCall>()
  private readonly log: AuditLog
  private readonly onError: (error: unknown) => void
  private readonly now: () => number

  constructor(log: AuditLog, onError: (error: unknown) => void = () => {}, now: () => number = Date.now) {
    this.log = log
    this.onError = onError
    this.now = now
  }

  dispatched(call: DispatchedCall): void {
    const toolCallId = call.toolCallId
    this.calls.set(call.id, {
      name: call.name,
      started: this.now(),
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(call.connection === undefined ? {} : { connection: call.connection }),
    })
    const args = maskAuditArgs(call.args)
    const url = typeof call.args.url === 'string' ? redactAuditUrl(call.args.url) : undefined
    this.write(call.sessionId, {
      kind: 'tool-call',
      callId: call.id,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(call.connection === undefined ? {} : { connection: call.connection }),
      tool: call.name,
      ...(call.program === undefined ? {} : { program: { id: call.program.id, step: call.program.step } }),
      args,
      argsDigest: `sha256:${sha256(canonicalJson(args))}`,
      ...(url === undefined ? {} : { url, origin: auditOrigin(call.args.url as string) }),
    })
  }

  annotated(id: string, annotation: AuditAnnotation): void {
    const call = this.calls.get(id)
    if (call === undefined) return
    const url = annotation.url === undefined ? undefined : redactAuditUrl(annotation.url)
    if (url !== undefined) call.url = url
    if (annotation.decision !== undefined) call.decision = annotation.decision
    const base = {
      callId: id,
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      tool: call.name,
    }
    if (annotation.policy !== undefined) call.policy = annotation.policy
    if (annotation.strict !== undefined) call.strictMode = annotation.strict
    const prompted = annotation.decision !== undefined && PROMPT_DECISIONS.has(annotation.decision)
    if (prompted || annotation.policy !== undefined || annotation.strict !== undefined || annotation.commit !== undefined) {
      this.write(call.sessionId, {
        kind: 'approval',
        ...base,
        ...(annotation.decision === undefined ? {} : { decision: annotation.decision }),
        ...(annotation.policy === undefined ? {} : { policy: annotation.policy }),
        ...(annotation.policyReason === undefined ? {} : { policyReason: redactUrlsInText(annotation.policyReason).slice(0, MAX_ERROR_MESSAGE * 2) }),
        ...(annotation.strict === undefined ? {} : { strictMode: annotation.strict }),
        ...(annotation.commit === undefined ? {} : { commitDecisions: annotation.commit }),
        ...(url === undefined ? {} : { url, origin: auditOrigin(annotation.url) }),
        ...(annotation.heldMs === undefined ? {} : { durationMs: annotation.heldMs }),
      })
    }
    if (annotation.navigatedTo !== undefined) {
      this.write(call.sessionId, {
        kind: 'navigation',
        ...base,
        url: redactAuditUrl(annotation.navigatedTo),
        ...(auditOrigin(annotation.navigatedTo) === undefined ? {} : { origin: auditOrigin(annotation.navigatedTo) }),
      })
    }
  }

  settled(id: string, outcome: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void {
    const call = this.calls.get(id)
    if (call === undefined) return
    this.calls.delete(id)
    this.write(call.sessionId, {
      kind: 'result',
      callId: id,
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      tool: call.name,
      ...(call.decision === undefined ? {} : { decision: call.decision }),
      ...(call.policy === undefined ? {} : { policy: call.policy }),
      ...(call.strictMode === undefined ? {} : { strictMode: call.strictMode }),
      outcome: outcome.ok ? 'ok' : 'error',
      ...(call.url === undefined ? {} : { url: call.url, ...(auditOrigin(call.url) === undefined ? {} : { origin: auditOrigin(call.url) }) }),
      ...(outcome.ok
        ? { resultDigest: auditResultDigest(outcome.result) }
        : { error: { code: outcome.error.code, message: redactUrlsInText(outcome.error.message).slice(0, MAX_ERROR_MESSAGE) } }),
      durationMs: Math.max(0, this.now() - call.started),
    })
  }

  reviewed(id: string, review: AuditReview): void {
    const call = this.calls.get(id)
    if (call === undefined) return
    this.write(call.sessionId, {
      kind: 'auto-review',
      callId: id,
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      tool: call.name,
      decision: review.decision,
      reason: redactUrlsInText(review.reason).slice(0, 300),
      ...(review.model === undefined ? {} : { model: review.model.slice(0, 200) }),
      durationMs: Math.max(0, Math.round(review.latencyMs)),
      binding: review.binding,
      code: review.code,
      ...(review.failure === undefined ? {} : { failure: redactUrlsInText(review.failure).slice(0, MAX_ERROR_MESSAGE) }),
    })
  }

  killSwitch(connection?: string): void {
    const targets = new Set<string | undefined>()
    for (const call of this.calls.values()) {
      if (connection === undefined || call.connection === undefined || call.connection === connection) targets.add(call.sessionId)
    }
    if (targets.size === 0) targets.add(undefined)
    for (const sessionId of targets) {
      this.write(sessionId, { kind: 'kill-switch', decision: 'engaged', ...(connection === undefined ? {} : { connection }) })
    }
  }

  private write(sessionId: string | undefined, entry: AuditEntryInput): void {
    void this.log.append(sessionId, entry).catch(this.onError)
  }
}
