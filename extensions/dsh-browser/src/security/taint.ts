/**
 * Deterministic session taint.
 *
 * Once untrusted page content has entered an agent session — any successful
 * browser tool result (page reads, snapshots, extraction, console or network
 * reads, and actions whose results quote the page) or a snapshot injected
 * when the panel follows a tab — the session is tainted until the user clears
 * it in the side panel. While tainted, a fixed set of exfiltration-shaped calls
 * needs a fresh approval even under trusted origins or unrestricted access
 * (see {@link taintForcedReasons}).
 *
 * Fail closed: every successful browser tool result taints except the few
 * whose output never quotes a page ({@link CONTENT_FREE_TOOLS}).
 *
 * @module
 */

import { EXTERNAL_SESSION_PREFIX } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { analyzeUrl, type UrlAnalysis } from './url-risk.ts'

/**
 * A source that is no origin: content entered the session from somewhere this
 * extension did not see (Host lineage, an attachment without a page URL). It
 * never equals a destination, so {@link onlySourceIs} stays false for good,
 * whatever origins are recorded later.
 */
export const UNKNOWN_SOURCE = '(unknown)'

/** Letters and digits in one URL value from which a tainted session's URL counts as carrying data. */
const TAINT_DATA_LENGTH = 16

/**
 * Whether a destination URL can carry data out of a tainted session. The
 * ordinary card's `risky` skips plain numbers and low-entropy runs so that
 * everyday links do not prompt; under taint a card number or a low-entropy
 * key is exactly what must not leave, so any value, fragment, or path segment
 * with 16+ letters and digits that include a digit counts.
 */
export function urlCarriesDataUnderTaint(url: UrlAnalysis): boolean {
  if (url.risky) return true
  const pieces = [...url.params.flatMap((param) => [param.name, param.value]), url.fragment, ...url.path.split('/')]
  return pieces.some((piece) => {
    const joined = piece.replace(/[^A-Za-z0-9]+/g, '')
    return joined.length >= TAINT_DATA_LENGTH && /\d/.test(joined)
  })
}

/** Session key used for calls that carry no agent session (probes, tests). */
export const NO_SESSION_KEY = '(no-session)'

/** Tool results that never contain page-authored text. */
export const CONTENT_FREE_TOOLS: ReadonlySet<string> = new Set([
  'browser_devtools_network',
  'browser_follow_tab',
  'browser_close_tab',
])

/** Per-session taint state; absent means untainted. */
export interface TaintRecord {
  /** Origins whose content entered the session (empty when unknown, e.g. tab titles). */
  sources: string[]
  /**
   * Origin of the most recent page read, when known. Informational only: no
   * exemption keys on it (see {@link onlySourceIs}).
   */
  lastReadOrigin?: string
  /** First tool (or 'snapshot-injection') that tainted the session. */
  firstTool: string
  since: number
}

/** Whether a successful tool result taints the calling session. */
export function resultTaintsSession(toolName: string, ok: boolean): boolean {
  return ok && toolName.startsWith('browser_') && !CONTENT_FREE_TOOLS.has(toolName)
}

/**
 * One taint bucket for every external (MCP) client session (`mcp-…`): each
 * MCP `initialize` mints a fresh session, so per-session taint would let a
 * client shed taint by reconnecting.
 */
export const EXTERNAL_TAINT_KEY = 'mcp-external'

/** Session key for an optional agent session id. */
export function taintKey(sessionId: string | undefined): string {
  const trimmed = sessionId?.trim()
  if (trimmed === undefined || trimmed === '') return NO_SESSION_KEY
  return trimmed.startsWith(EXTERNAL_SESSION_PREFIX) ? EXTERNAL_TAINT_KEY : trimmed
}

/** Storage seam so taint survives an MV3 worker restart. */
export interface TaintStore {
  read(): Promise<unknown>
  write(value: Record<string, TaintRecord>): Promise<void>
}

/** Tracks taint per agent session. */
export class TaintTracker {
  private records = new Map<string, TaintRecord>()
  private readonly listeners = new Set<(key: string) => void>()
  readonly ready: Promise<void>

  constructor(private readonly store?: TaintStore, private readonly now: () => number = Date.now) {
    this.ready = store === undefined
      ? Promise.resolve()
      : store.read().then((value) => { this.restore(value) }, () => {})
  }

  private restore(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null || this.records.has(key)) continue
      const record = raw as Partial<TaintRecord>
      this.records.set(key, {
        sources: Array.isArray(record.sources) ? record.sources.filter((origin): origin is string => typeof origin === 'string') : [],
        ...typeof record.lastReadOrigin === 'string' ? { lastReadOrigin: record.lastReadOrigin } : {},
        firstTool: typeof record.firstTool === 'string' ? record.firstTool : 'unknown',
        since: typeof record.since === 'number' ? record.since : this.now(),
      })
    }
  }

  /**
   * Mark a session tainted by content from `origins` (may be empty).
   * `pageOrigin` is the top page's origin, recorded as the page last read; it
   * is never guessed from a multi-origin list (an iframe must not set it).
   */
  mark(sessionId: string | undefined, tool: string, origins: readonly string[], pageOrigin?: string): void {
    const key = taintKey(sessionId)
    const existing = this.records.get(key)
    const sources = new Set(existing?.sources ?? [])
    for (const origin of origins) sources.add(origin)
    const lastReadOrigin = pageOrigin ?? existing?.lastReadOrigin
    const next: TaintRecord = {
      sources: [...sources].sort(),
      ...lastReadOrigin === undefined ? {} : { lastReadOrigin },
      firstTool: existing?.firstTool ?? tool,
      since: existing?.since ?? this.now(),
    }
    const changed = existing === undefined
      || existing.sources.length !== next.sources.length
      || existing.lastReadOrigin !== next.lastReadOrigin
    this.records.set(key, next)
    if (changed) this.changed(key)
  }

  /** The user cleared the session's taint in the panel. */
  clear(sessionId: string | undefined): boolean {
    const key = taintKey(sessionId)
    if (!this.records.delete(key)) return false
    this.changed(key)
    return true
  }

  /** Clear every session (kill switch, all panels gone is NOT a reason). */
  clearAll(): void {
    const keys = [...this.records.keys()]
    this.records.clear()
    for (const key of keys) this.changed(key)
  }

  get(sessionId: string | undefined): TaintRecord | undefined {
    return this.records.get(taintKey(sessionId))
  }

  snapshot(): Record<string, TaintRecord> {
    return Object.fromEntries(this.records)
  }

  onChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(key: string): void {
    void this.store?.write(this.snapshot()).catch(() => {})
    for (const listener of this.listeners) {
      try { listener(key) } catch { /* a listener must not break tracking */ }
    }
  }
}

/** What a call would do, as far as the taint rules care. */
export interface TaintCallFacts {
  name: string
  args: Record<string, unknown>
  /** Origin of the frame a typing/paste call writes into. */
  targetOrigin?: string
}

/**
 * Whether data the session read can only have come from `origin`: every
 * source is that origin. Writing it back there (typing a reply into the mail
 * the session read, searching the site it read) moves nothing off-site. An
 * unknown or mixed source set never qualifies, and the most recently read page
 * is deliberately not enough — one plain navigation to an attacker page must
 * not make that page the exempt sink for everything read before.
 */
export function onlySourceIs(taint: TaintRecord, origin: string | undefined): boolean {
  return origin !== undefined && taint.sources.length > 0 && taint.sources.every((source) => source === origin)
}

/** Whether a `browser_press` call types characters (rather than a navigation or editing key). */
function pressTypes(args: Record<string, unknown>): boolean {
  if (args.trusted === true) return true
  const key = typeof args.key === 'string' ? args.key : ''
  if (typeof args.text === 'string' && args.text !== '') return true
  // A printable key is one character (after any modifiers, `Shift+a`).
  const base = key.split('+').at(-1) ?? ''
  return [...base].length === 1 || [...key].length === 1
}

/**
 * Reasons a call needs a fresh approval because the session is tainted, or an
 * empty list. Deterministic: the same call and record always give the same
 * answer, so the approval can be recomputed and compared after it resolves.
 */
export function taintForcedReasons(facts: TaintCallFacts, taint: TaintRecord | undefined): string[] {
  if (taint === undefined) return []
  const reasons: string[] = []
  const typingInto = (what: string): void => {
    if (!onlySourceIs(taint, facts.targetOrigin)) {
      reasons.push(`The session has read untrusted page content from ${describeSources(taint)}; ${what} into ${facts.targetOrigin ?? 'an unknown origin'} needs your approval.`)
    }
  }
  switch (facts.name) {
    case 'browser_navigate':
    case 'browser_open_tab': {
      const raw = typeof facts.args.url === 'string' ? facts.args.url : ''
      const url = analyzeUrl(raw)
      if (url !== undefined && urlCarriesDataUnderTaint(url) && !onlySourceIs(taint, url.origin)) {
        reasons.push(`The session has read untrusted page content from ${describeSources(taint)}, and this URL (${url.origin}) carries data in its host, path, query, or fragment.`)
      }
      break
    }
    case 'browser_clipboard':
      if (facts.args.action === 'write') {
        reasons.push('The session has read untrusted page content; writing to the system clipboard needs your approval.')
      } else {
        typingInto('pasting')
      }
      break
    case 'browser_type':
      typingInto('typing')
      break
    case 'browser_press':
      if (pressTypes(facts.args)) typingInto('typing keys')
      break
    case 'browser_dialog':
      if (typeof facts.args.promptText === 'string' && facts.args.promptText !== '') typingInto('answering a dialog prompt')
      break
    case 'browser_console_eval':
      reasons.push('The session has read untrusted page content; running JavaScript in the page (which can send data anywhere) needs your approval.')
      break
    case 'browser_devtools_set_element_attribute':
    case 'browser_devtools_set_element_style':
      reasons.push('The session has read untrusted page content; changing element attributes or styles (which can load URLs carrying data) needs your approval.')
      break
    case 'browser_save_pdf':
      reasons.push('The session has read untrusted page content; writing a file into the workspace needs your approval.')
      break
    case 'browser_extract':
      if (typeof facts.args.saveTo === 'string' && facts.args.saveTo !== '') {
        reasons.push('The session has read untrusted page content; writing a file into the workspace needs your approval.')
      }
      break
    case 'browser_upload':
      reasons.push('The session has read untrusted page content; handing local files to a page needs your approval.')
      break
    default:
      break
  }
  return reasons
}

function describeSources(taint: TaintRecord): string {
  const known = taint.sources.filter((source) => source !== UNKNOWN_SOURCE)
  if (known.length === 0) return 'an unknown origin'
  return known.length === taint.sources.length ? known.join(', ') : `${known.join(', ')} and an unknown origin`
}
