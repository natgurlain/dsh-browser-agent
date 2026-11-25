/**
 * Background runtime for the policy layer: site rules from settings and
 * managed storage, session taint, and the panel's taint/clear channel.
 *
 * Kept out of index.ts so the entry point only wires a hook into each
 * dispatch path and reports results.
 *
 * Panel channel: extension pages (never content scripts) connect a port named
 * {@link POLICY_PORT_NAME} and send `{ type: 'taint.subscribe' }`,
 * `{ type: 'taint.clear', sessionId?, id? }` or
 * `{ type: 'taint.trust', sessionId?, origins, id? }`; the background pushes
 * `{ type: 'taint.state', records, trustable }` on every change and answers a
 * clear with `{ type: 'taint.clear.result', id, ok, bridgeCleared }` and a
 * trust with `{ type: 'taint.trust.result', id, ok, trusted, cleared }`.
 *
 * Taint exemptions (security/taint-exempt.ts): a read whose every origin is
 * loopback or a site the user marked trusted leaves the session untainted.
 * This side decides, because only it knows which frames a result quoted; the
 * bridge follows through the `taintExempt` flag on `tool.result`.
 *
 * @module
 */

import { evaluateCallPolicy, type CallPolicyDecision, type CallPolicyTargets, type ManagedCallFlags } from '../security/call-policy.ts'
import { EMPTY_MANAGED_POLICY, loadManagedPolicy, type ManagedPolicy } from '../security/managed-policy.ts'
import { matchSitePattern, type SitePolicy, type SiteRuleEntry } from '../security/site-policy.ts'
import { resultTaintsSession, TaintTracker, taintKey, UNKNOWN_SOURCE, type TaintRecord } from '../security/taint.ts'
import {
  allTaintExempt,
  allLocalExempt,
  anyLocalExempt,
  originTaintExempt,
  TAINT_EXEMPTION_SWITCHES,
  trustOfferFor,
  unconfirmedTrust,
  type LoopbackScope,
  type TaintExemptionConfig,
  type TrustedMigration,
  type TrustOffer,
} from '../security/taint-exempt.ts'
import { httpOrigin, parseHttpUrl } from '../security/web-url.ts'
import type { CallPolicyHook, ToolCall } from './tools.ts'
import { isDevToolsTool } from './authorization.ts'

export const POLICY_PORT_NAME = 'dsh-policy'
export const TAINT_STORAGE_KEY = 'dshSessionTaint'
/** Exempt reads of untainted sessions (same storage area as taint). */
export const EXEMPT_READS_STORAGE_KEY = 'dshSessionExemptReads'
/** Sessions the user put in strict mode (same storage area as taint: the browser session). */
export const STRICT_SESSIONS_STORAGE_KEY = 'dshStrictSessions'
/** Bridge RPCs that clear and mark the Host-side taint guard of one session. */
export { BRIDGE_TAINT_CLEAR_METHOD, BRIDGE_TAINT_MARK_METHOD } from '@natgurlain/dsh-browser-agent/src/protocol.ts'

/** The settings fields the policy layer reads. */
export interface PolicySettings {
  siteRules: SiteRuleEntry[]
  siteDefaultsEnabled: boolean
  /** Site patterns where strict mode (the commit gate) is on. */
  strictSites?: string[]
  /** Always-allowed origins from Settings: an explicit user trust choice for the taint exemption. */
  trustedActionOrigins?: readonly string[]
  /** "Don't restrict sessions that only read local pages" (absent: off). */
  taintExemptLocalPages?: boolean
  /** "Don't restrict sessions that only read sites I trust" (absent: off). */
  taintExemptTrustedSites?: boolean
  /** Loopback origins the user said are theirs. */
  taintLocalOrigins?: readonly string[]
  /** Hosts whose pages are not treated as untrusted content (the banner's Trust). */
  taintTrustedSites?: readonly string[]
  /** Trusted rules and always-allowed origins confirmed for the exemption (keys, see taint-exempt.ts). */
  taintTrustConfirmed?: readonly string[]
}

/**
 * Where a call's tab stood once the call settled: the top page's origin and
 * the origins of every frame in it. `opaque` means the top page has no web
 * origin (a browser page, a file), so its content cannot be attributed.
 * `urls` are the frames' page URLs (path-scoped site rules).
 */
export interface TabProvenance {
  top?: string
  frames: string[]
  opaque: boolean
  urls?: string[]
}

/** Tools whose result can quote any frame of the tab, whatever frame they target (a dialog's text). */
const WHOLE_TAB_PROVENANCE_TOOLS: ReadonlySet<string> = new Set(['browser_dialog'])

/**
 * Tools whose result is never exempt: the list of past downloads names other
 * sites; a screenshot or a PDF carries the pixels of every subresource and
 * frame, whatever origin served them (cross-origin images, a frame that
 * loaded between the frame listing and the capture).
 */
const NEVER_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'browser_downloads',
  // Captured network traffic: requests and response bodies from any host the
  // page talked to, so even a local page's capture quotes other sites.
  'browser_devtools_list_requests', 'browser_devtools_get_request', 'browser_devtools_request_body',
  // Their own results carry no frame provenance (a fleet, a watcher): they taint, whatever the
  // tab shows. A program or series approval (`browser_run`) is not here: its answer is fixed text
  // and does not taint at all (taint.ts CONTENT_FREE_TOOLS); its steps are ordinary calls (click,
  // type, select) and are judged as such.
  'browser_fanout', 'browser_watch', 'browser_watches',
])

/**
 * Tools whose result can carry more than the text of the frames they name: a
 * screenshot or a PDF (pixels of every subresource), and every developer-tools
 * read (console output, captured traffic, page JavaScript). Exempt only on the
 * user's own local pages ({@link allLocalExempt}), with the whole tab known.
 */
const LOCAL_ONLY_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['browser_screenshot', 'browser_save_pdf'])

/** What the caller knows about a settled result beyond its targets. */
export interface ResultFacts {
  /**
   * The result carries console text collected for the whole tab (appended to
   * action results while the debugger is attached): it can quote any frame
   * and anything the page talked to, so the result is never exempt.
   */
  quotesConsole?: boolean
}

/** New persistent choices made on the banner. */
export interface TaintTrustChange {
  /** Hosts to add to the "not treated as untrusted" sites. */
  sites: string[]
  /** Loopback origins to remember as the user's own pages. */
  localOrigins: string[]
}

export interface PolicyRuntimeOptions {
  settings: () => PolicySettings
  /** Whether unrestricted access is currently in effect (already managed-filtered). */
  unrestricted: () => boolean
  /** Forward a clear to the bridge; rejects when it is not connected. */
  clearBridgeTaint: (sessionId: string | undefined) => Promise<void>
  /**
   * Persist the banner's choices through the settings path Settings itself
   * saves with (normalized). Absent: the banner's "Trust" is refused.
   */
  saveTaintTrust?: (change: TaintTrustChange) => Promise<void>
  /** Origins that are never exempt: whatever serves the DSH host (its web UI, the bridge). */
  neverExemptOrigin?: (origin: string) => boolean
  /**
   * What the connected bridge honours (its `hello.ok` caps): a class it does
   * not honour is off here too, so both sides agree. Absent: both honoured.
   */
  bridgeExemptions?: () => { local: boolean; trusted: boolean } | undefined
  /** The two open product decisions (taint-exempt.ts); tests exercise both variants. */
  switches?: { loopbackScope: LoopbackScope; trustedMigration: TrustedMigration }
  /** Called after managed policy changes so settings can be re-normalized. */
  onManagedChange?: (policy: ManagedPolicy) => void
  storage?: chrome.storage.StorageArea
}

/** What one dispatched call touched, kept until its result is known. */
interface CallRecord {
  targets?: CallPolicyTargets
  /** Every origin any policy evaluation of this call named (the landed page of a navigation included). */
  seen: Set<string>
  /** Whether some evaluation named a frame or destination (not just the top page). */
  touched: boolean
  /** A destination that is not a web URL: its content cannot be attributed. */
  opaque: boolean
  /** Page URLs of the frames and destinations named (path-scoped site rules). */
  urls: Set<string>
}

function newCallRecord(): CallRecord {
  return { seen: new Set(), touched: false, opaque: false, urls: new Set() }
}

function noteTargets(record: CallRecord, targets: CallPolicyTargets): void {
  record.targets = targets
  for (const url of targets.urls ?? []) record.urls.add(url)
  if (targets.destination !== undefined) record.urls.add(targets.destination)
  for (const origin of targets.reads) record.seen.add(origin)
  for (const origin of targets.acts) record.seen.add(origin)
  if (targets.reads.length > 0 || targets.acts.length > 0) record.touched = true
  if (targets.pageOrigin !== undefined) record.seen.add(targets.pageOrigin)
  if (targets.destination !== undefined) {
    const origin = httpOrigin(targets.destination)
    if (origin === undefined) record.opaque = true
    else {
      record.seen.add(origin)
      record.touched = true
    }
  }
}

/** Whether a port comes from one of this extension's own pages (never a content script). */
export function isExtensionPageSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (sender === undefined) return false
  if (sender.id !== undefined && sender.id !== chrome.runtime.id) return false
  const base = chrome.runtime.getURL('')
  return typeof sender.url === 'string' && sender.url.startsWith(base)
}

export class PolicyRuntime {
  managed: ManagedPolicy = EMPTY_MANAGED_POLICY
  readonly taint: TaintTracker
  readonly ready: Promise<void>
  private readonly calls = new Map<string, CallRecord>()
  /**
   * Agent sessions the user put in strict mode from the panel. Persisted next
   * to taint: a worker restart must not silently turn the commit gate off.
   */
  private readonly strictSessions = new Set<string>()
  /** Set once the persisted strict sessions are loaded; toggles before that wait for it. */
  private strictLoaded = false
  private readonly ports = new Set<chrome.runtime.Port>()

  constructor(private readonly options: PolicyRuntimeOptions) {
    const storage = options.storage
    this.taint = new TaintTracker(storage === undefined
      ? undefined
      : {
          read: async () => (await storage.get(TAINT_STORAGE_KEY))[TAINT_STORAGE_KEY],
          write: async (value) => { await storage.set({ [TAINT_STORAGE_KEY]: value }) },
          readExempt: async () => (await storage.get(EXEMPT_READS_STORAGE_KEY))[EXEMPT_READS_STORAGE_KEY],
          writeExempt: async (value) => { await storage.set({ [EXEMPT_READS_STORAGE_KEY]: value }) },
        })
    this.taint.onChange(() => { this.broadcast() })
    this.ready = Promise.all([
      this.taint.ready,
      this.loadStrictSessions(),
      loadManagedPolicy().then((policy) => { this.setManaged(policy) }),
    ]).then(() => undefined)
  }

  private async loadStrictSessions(): Promise<void> {
    const storage = this.options.storage
    if (storage === undefined) {
      this.strictLoaded = true
      return
    }
    try {
      const stored = (await storage.get(STRICT_SESSIONS_STORAGE_KEY))[STRICT_SESSIONS_STORAGE_KEY]
      if (Array.isArray(stored)) for (const key of stored) if (typeof key === 'string') this.strictSessions.add(key)
    } catch {
      // Storage unavailable: strict sites from settings still apply.
    }
    this.strictLoaded = true
  }

  setManaged(policy: ManagedPolicy): void {
    this.managed = policy
    this.options.onManagedChange?.(policy)
  }

  /**
   * The site policy currently in force. `unrestricted` is the access mode the
   * call started under (a toggle mid-call must not widen it).
   */
  sitePolicy(unrestricted: boolean = this.options.unrestricted()): SitePolicy {
    const settings = this.options.settings()
    return {
      managed: this.managed.siteRules,
      user: settings.siteRules,
      defaultsEnabled: settings.siteDefaultsEnabled || this.managed.enforceSiteDefaults,
      enforceDefaults: this.managed.enforceSiteDefaults,
      defaultTrusted: unrestricted && !this.managed.disableUnrestricted,
    }
  }

  managedFlags(): ManagedCallFlags {
    return {
      disableScreenshots: this.managed.disableScreenshots,
      disableDevTools: this.managed.disableDevTools,
      ...this.managed.allowedOrigins === undefined ? {} : { allowedOrigins: this.managed.allowedOrigins },
    }
  }

  /** Evaluate one call now (devtools path, tests). */
  evaluate(call: Pick<ToolCall, 'name' | 'args' | 'sessionId'>, targets: CallPolicyTargets, unrestricted?: boolean): CallPolicyDecision {
    return evaluateCallPolicy({
      name: call.name,
      args: call.args,
      targets,
      site: this.sitePolicy(unrestricted),
      taint: this.taint.get(call.sessionId),
      managed: this.managedFlags(),
      devTools: isDevToolsTool(call.name),
    })
  }

  /**
   * Whether the agent may not see a page at all — a blocked site rule or an
   * origin outside the managed allowlist — so even its title and address are
   * withheld (tab lists, resume summaries). Non-web pages are not judged.
   */
  pageHidden(url: string, unrestricted?: boolean): boolean {
    const origin = httpOrigin(url)
    if (origin === undefined) return false
    return evaluateCallPolicy({
      name: 'browser_list_tabs',
      args: {},
      targets: { reads: [origin], acts: [], urls: [url] },
      site: this.sitePolicy(unrestricted),
      managed: { disableScreenshots: false, disableDevTools: false, ...this.managed.allowedOrigins === undefined ? {} : { allowedOrigins: this.managed.allowedOrigins } },
    }).kind === 'deny'
  }

  /** Evaluate a call without recording it for taint (follow refreshes, landed pages). */
  evaluator(sessionId: string | undefined, unrestricted: boolean): CallPolicyHook {
    return (call, targets) => this.evaluate({ ...call, sessionId }, targets, unrestricted)
  }

  /** The hook a dispatch path consults; it remembers the targets for {@link recordResult}. */
  hook(callId: string, sessionId: string | undefined, unrestricted: boolean): CallPolicyHook {
    const record = newCallRecord()
    this.calls.set(callId, record)
    return (call, targets) => {
      noteTargets(record, targets)
      return this.evaluate({ ...call, sessionId }, targets, unrestricted)
    }
  }

  /**
   * A policy evaluator that also collects the origins it is asked about, for
   * reads injected without a tool call ({@link injectionExempt}).
   */
  provenanceEvaluator(sessionId: string | undefined, unrestricted: boolean): { policy: CallPolicyHook; origins: () => string[] | undefined; urls: () => string[] } {
    const record = newCallRecord()
    return {
      policy: (call, targets) => {
        noteTargets(record, targets)
        return this.evaluate({ ...call, sessionId }, targets, unrestricted)
      },
      origins: () => record.touched && !record.opaque ? [...record.seen] : undefined,
      urls: () => [...record.urls],
    }
  }

  /** Whether a read could leave this session untainted at all (some exemption is on and it is untainted). */
  mayExempt(sessionId: string | undefined): boolean {
    if (this.taint.get(sessionId) !== undefined) return false
    const config = this.exemption()
    return config.localPages || config.trustedSites
  }

  /**
   * The exemptions in force now: the two settings, minus what managed policy
   * or the connected bridge forces off, with the user's lists.
   */
  exemption(): TaintExemptionConfig {
    const settings = this.options.settings()
    const bridge = this.options.bridgeExemptions?.()
    const switches = this.options.switches ?? TAINT_EXEMPTION_SWITCHES
    return {
      localPages: settings.taintExemptLocalPages === true && !this.managed.disableLocalTaintExemption && bridge?.local !== false,
      trustedSites: settings.taintExemptTrustedSites === true && !this.managed.disableTrustedTaintExemption && bridge?.trusted !== false,
      // Unrestricted access is not an explicit choice about any one site.
      site: this.sitePolicy(false),
      trustedActionOrigins: settings.trustedActionOrigins ?? [],
      localOrigins: settings.taintLocalOrigins ?? [],
      taintTrustedSites: settings.taintTrustedSites ?? [],
      trustConfirmed: settings.taintTrustConfirmed ?? [],
      loopbackScope: switches.loopbackScope,
      trustedMigration: switches.trustedMigration,
      ...this.options.neverExemptOrigin === undefined ? {} : { neverExempt: this.options.neverExemptOrigin },
    }
  }

  /** Whether every origin is one of the user's own local pages (and there is at least one). */
  allLocalPages(origins: readonly string[]): boolean {
    return allLocalExempt(origins, this.exemption())
  }

  /** Trusted rules and always-allowed origins waiting for the user's one-time confirmation (keys). */
  unconfirmedTrust(): string[] {
    return unconfirmedTrust(this.exemption())
  }

  /**
   * The origins a settled call could have quoted when all of them are exempt
   * from taint, else undefined (the call taints). Conservative by design:
   *
   * - every origin any policy evaluation of the call named counts (target
   *   frames, every frame of a whole-tab read, a navigation's destination and
   *   the frames of the page it landed on, the top page);
   * - the top page the tab shows afterwards counts too (a navigation the
   *   call or the page caused meanwhile);
   * - a call that never told the policy layer which frame it reads (it failed
   *   early, or it is a kind this layer has no frame provenance for) or that
   *   can quote any frame is exempt only when every frame in the tab is;
   * - no known origin at all, a non-web page, or a non-web destination is
   *   never exempt;
   * - developer-tools results are never exempt: console output and captured
   *   network traffic quote whatever origins the page talked to, and page
   *   JavaScript can return anything. The same goes for any result that
   *   carries the tab's console text, and for screenshots and PDFs (pixels of
   *   every subresource).
   */
  private exemptProvenance(name: string, record: CallRecord | undefined, fallbackOrigin: string | undefined, after: TabProvenance | undefined, facts: ResultFacts): { origins: string[]; local: boolean } | undefined {
    const config = this.exemption()
    if (!config.localPages && !config.trustedSites) return undefined
    if (NEVER_EXEMPT_TOOLS.has(name)) return undefined
    const localOnly = LOCAL_ONLY_EXEMPT_TOOLS.has(name) || isDevToolsTool(name) || facts.quotesConsole === true
    const origins = new Set<string>()
    const judged = record?.targets !== undefined
    if (judged) {
      if (record.opaque) return undefined
      for (const origin of record.seen) origins.add(origin)
    } else if (fallbackOrigin !== undefined) {
      origins.add(fallbackOrigin)
    }
    const wholeTab = localOnly || !judged || !record.touched || WHOLE_TAB_PROVENANCE_TOOLS.has(name)
    if (after === undefined) {
      if (wholeTab) return undefined
    } else {
      if (after.top !== undefined) origins.add(after.top)
      if (wholeTab) {
        if (after.opaque || after.frames.length === 0) return undefined
        for (const origin of after.frames) origins.add(origin)
      }
    }
    const list = [...origins]
    const urls = [...record?.urls ?? [], ...after?.urls ?? []]
    if (localOnly) return allLocalExempt(list, config, urls) ? { origins: list, local: true } : undefined
    return allTaintExempt(list, config, urls) ? { origins: list, local: anyLocalExempt(list, config) } : undefined
  }

  /**
   * A call settled. A successful browser result taints its session with the
   * origins it touched (or `fallbackOrigin`, the tab's origin, when the call
   * never reached the policy hook), unless everything it could have quoted
   * is exempt ({@link exemptProvenance}; `after` is the tab's state once the
   * call settled, when the caller knows the tab).
   *
   * `exempt: true` is this side vouching to the bridge that the result need
   * not taint: only for a result proven exempt in a session that is still
   * untainted here. Anything else, a result this side does not taint for
   * other reasons included, leaves the bridge to its own (stricter) rule.
   * `local` says the exemption rested on a local page (the bridge may refuse
   * those on its own).
   */
  recordResult(call: Pick<ToolCall, 'id' | 'name' | 'sessionId'>, ok: boolean, fallbackOrigin?: string, after?: TabProvenance, facts: ResultFacts = {}): { exempt: boolean; local?: boolean } {
    const record = this.calls.get(call.id)
    this.calls.delete(call.id)
    // A failed call that reached a page can still quote it (an open dialog's
    // text, a content-script error): it taints like a success.
    const reachedPage = record?.targets !== undefined || fallbackOrigin !== undefined
    if (!resultTaintsSession(call.name, true) || (!ok && !reachedPage)) return { exempt: false }
    if (this.taint.get(call.sessionId) === undefined) {
      const exempt = this.exemptProvenance(call.name, record, fallbackOrigin, after, facts)
      if (exempt !== undefined) {
        this.taint.noteExemptRead(call.sessionId, exempt.origins)
        return { exempt: true, local: exempt.local }
      }
    }
    const targets = record?.targets
    const origins = targets === undefined
      ? fallbackOrigin === undefined ? [] : [fallbackOrigin]
      : [...new Set([...targets.reads, ...targets.acts])]
    // After a navigation or new tab the agent looks at the destination page.
    // A navigation that did not succeed (denied, refused, failed) read nothing
    // there: the destination is kept as attempted, not as a source, so the
    // banner does not name a site that never loaded. It still counts against
    // every "only source" exemption (taint.ts `onlySourceIs`).
    let pageOrigin = targets === undefined ? fallbackOrigin : targets.pageOrigin
    const attempted: string[] = []
    if (targets?.destination !== undefined) {
      try {
        const destination = new URL(targets.destination).origin
        if (ok) {
          origins.push(destination)
          pageOrigin = destination
        } else {
          attempted.push(destination)
        }
      } catch { /* not a URL */ }
    }
    this.taint.mark(call.sessionId, call.name, origins.length === 0 && fallbackOrigin !== undefined ? [fallbackOrigin] : origins, pageOrigin ?? fallbackOrigin, attempted)
    return { exempt: false }
  }

  /** A call's dispatch threw before it settled: drop its record without judging taint. */
  forgetCall(callId: string): void {
    this.calls.delete(callId)
  }

  /** Whether strict mode (commit gate) covers a call in this session on this page. */
  strictFor(sessionId: string | undefined, pageUrl: string | undefined): boolean {
    if (this.strictSessions.has(taintKey(sessionId))) return true
    const patterns = this.options.settings().strictSites ?? []
    const url = patterns.length === 0 ? undefined : parseHttpUrl(pageUrl)
    if (url === undefined) return false
    return patterns.some((pattern) => matchSitePattern(pattern, url))
  }

  setStrictSession(sessionId: string | undefined, enabled: boolean): void {
    // A toggle that arrives before the stored set loads (the message that woke
    // the worker) would persist only itself and forget the other strict sessions,
    // and a load landing after it could undo a disable. Apply it once loaded.
    if (!this.strictLoaded) {
      void this.ready.then(() => { this.setStrictSession(sessionId, enabled) })
      return
    }
    const key = taintKey(sessionId)
    if (enabled) this.strictSessions.add(key)
    else this.strictSessions.delete(key)
    void this.options.storage?.set({ [STRICT_SESSIONS_STORAGE_KEY]: [...this.strictSessions] }).catch(() => {})
    this.broadcast()
  }

  /**
   * The Host reports this session (or an agent it was spawned or forked
   * from) tainted: apply the taint rules even without a record of our own.
   * The sources are unknown, so no origin is ever exempt.
   */
  markHostTaint(sessionId: string | undefined): void {
    if (this.taint.get(sessionId) === undefined) this.taint.mark(sessionId, 'host-lineage', [UNKNOWN_SOURCE])
  }

  /**
   * The Host reports that a session this one was spawned or forked from read
   * exempt pages. Their content may be in this session's context, and this
   * extension does not know which pages they were: remember an unknown
   * source, so that once this session is tainted no origin is ever its only
   * source (and so never the exempt destination for what the parent read).
   */
  noteInheritedExemptReads(sessionId: string | undefined): void {
    const record = this.taint.get(sessionId)
    if (record === undefined) this.taint.noteExemptRead(sessionId, [UNKNOWN_SOURCE])
    else if (!record.sources.includes(UNKNOWN_SOURCE)) this.taint.mark(sessionId, 'host-lineage', [UNKNOWN_SOURCE])
  }

  /**
   * The user attached a page selection to a prompt: its page text entered the
   * session. `origin` is the origin of the frame the selection was made in
   * (unknown without one). Returns whether the read was exempt, in which case
   * the bridge is not told to taint either.
   */
  recordSelection(sessionId: string, origin: string | undefined, url?: string): { exempt: boolean } {
    if (origin !== undefined && this.taint.get(sessionId) === undefined && originTaintExempt(origin, this.exemption(), url === undefined ? [] : [url])) {
      this.taint.noteExemptRead(sessionId, [origin])
      return { exempt: true }
    }
    this.taint.mark(sessionId, 'selection-attachment', [origin ?? UNKNOWN_SOURCE])
    return { exempt: false }
  }

  /**
   * Whether a snapshot about to be injected into a session is exempt from
   * taint: the session is untainted, the page's origin is known, and
   * `frames` (the origins of every frame the snapshot read, from
   * {@link provenanceEvaluator}) is known and all exempt. Without frame
   * provenance an injection always taints.
   */
  injectionExempt(sessionId: string, origin: string | undefined, frames: readonly string[] | undefined, urls: readonly string[] = []): boolean {
    if (origin === undefined || frames === undefined || frames.length === 0) return false
    if (this.taint.get(sessionId) !== undefined) return false
    return allTaintExempt([origin, ...frames], this.exemption(), urls)
  }

  /** Whether an exempt injection of these origins rests on a local page (told to the bridge). */
  restsOnLocalPage(origins: readonly string[]): boolean {
    return anyLocalExempt(origins, this.exemption())
  }

  /**
   * A snapshot was injected into a session without a tool call (follow
   * refresh, resume, a watcher). It taints unless `frames` proves it exempt
   * ({@link injectionExempt}); the frames it read, when known, are sources
   * like the page itself.
   */
  recordInjection(sessionId: string, origin: string | undefined, frames?: readonly string[], urls: readonly string[] = []): { exempt: boolean } {
    if (origin !== undefined && this.injectionExempt(sessionId, origin, frames, urls)) {
      this.taint.noteExemptRead(sessionId, [origin, ...frames ?? []])
      return { exempt: true }
    }
    this.taint.mark(sessionId, 'snapshot-injection', [origin ?? UNKNOWN_SOURCE, ...frames ?? []], origin)
    return { exempt: false }
  }

  get(sessionId: string | undefined): TaintRecord | undefined {
    return this.taint.get(sessionId)
  }

  /** Clear a session's taint here and on the Host. */
  async clear(sessionId: string | undefined): Promise<{ bridgeCleared: boolean }> {
    this.taint.clear(sessionId)
    try {
      await this.options.clearBridgeTaint(sessionId)
      return { bridgeCleared: true }
    } catch {
      return { bridgeCleared: false }
    }
  }

  /**
   * Taint sources of each record the banner may offer a one-click choice
   * for (see {@link trustOfferFor}). A record with an unknown source offers
   * none: an unknown source can never be trusted, so trusting the rest could
   * not lift the taint.
   */
  trustable(): Record<string, Record<string, TrustOffer>> {
    const config = this.exemption()
    const result: Record<string, Record<string, TrustOffer>> = {}
    for (const [key, record] of Object.entries(this.taint.snapshot())) {
      if (record.sources.length === 0 || record.sources.includes(UNKNOWN_SOURCE)) continue
      const offered: Record<string, TrustOffer> = {}
      for (const source of record.sources) {
        const offer = trustOfferFor(source, config)
        if (offer !== undefined) offered[source] = offer
      }
      if (Object.keys(offered).length > 0) result[key] = offered
    }
    return result
  }

  /**
   * Per record, the sources that are exempt from taint now (the user's own
   * local pages, trusted sites). They stay sources, so a later page is never
   * the "only source"; the banner just does not name them, as they tainted
   * nothing.
   */
  exemptSources(): Record<string, string[]> {
    const config = this.exemption()
    const result: Record<string, string[]> = {}
    for (const [key, record] of Object.entries(this.taint.snapshot())) {
      const exempt = record.sources.filter((source) => source !== UNKNOWN_SOURCE && originTaintExempt(source, config))
      if (exempt.length > 0) result[key] = exempt
    }
    return result
  }

  /**
   * The banner's one-click choices for one session: "Trust <site>" adds the
   * source's host to the sites whose pages are not treated as untrusted
   * content (a taint-only entry: it relaxes no approval card), and "these
   * are my pages" remembers a loopback origin as the user's own. Only
   * sources of that session's current record that {@link trustOfferFor}
   * offers are accepted, so the message cannot be used to trust arbitrary
   * sites. If every source of the record is exempt afterwards the taint is
   * lifted here and on the Host; the record's sources stay remembered as
   * exempt reads, so a page read later is never the session's only source.
   * Otherwise the session stays tainted.
   */
  async trustSources(sessionId: string | undefined, origins: readonly string[]): Promise<{ trusted: string[]; cleared: boolean }> {
    const record = this.taint.get(sessionId)
    const save = this.options.saveTaintTrust
    if (record === undefined || save === undefined) return { trusted: [], cleared: false }
    // An unknown source can never be trusted: the banner offers only Clear then.
    if (record.sources.length === 0 || record.sources.includes(UNKNOWN_SOURCE)) return { trusted: [], cleared: false }
    const config = this.exemption()
    const offers = new Map<string, TrustOffer>()
    for (const origin of new Set(origins)) {
      if (!record.sources.includes(origin)) continue
      const offer = trustOfferFor(origin, config)
      if (offer !== undefined) offers.set(origin, offer)
    }
    if (offers.size === 0) return { trusted: [], cleared: false }
    const chosen = [...offers.values()]
    await save({
      sites: [...new Set(chosen.filter((offer) => offer.kind === 'site').map((offer) => offer.entry))],
      localOrigins: [...new Set(chosen.filter((offer) => offer.kind === 'local').map((offer) => offer.entry))],
    })
    // Judge what was actually stored (normalization may have refused an entry).
    const now = this.exemption()
    const trusted = [...offers.keys()].filter((origin) => originTaintExempt(origin, now))
    const current = this.taint.get(sessionId)
    // Attempted destinations must be exempt too: a failed navigation may have loaded part of the page.
    const cleared = current !== undefined && allTaintExempt([...current.sources, ...current.attempted ?? []], now)
    if (cleared) {
      this.taint.lift(sessionId)
      await this.options.clearBridgeTaint(sessionId).catch(() => {})
    } else {
      this.broadcast()
    }
    return { trusted, cleared }
  }

  /** Accept a panel policy port (extension pages only). */
  connect(port: chrome.runtime.Port): boolean {
    if (port.name !== POLICY_PORT_NAME) return false
    // Content scripts run beside untrusted pages: only extension pages (the
    // side panel, or the panel opened in a tab) may clear taint.
    if (!isExtensionPageSender(port.sender)) {
      port.disconnect()
      return true
    }
    this.ports.add(port)
    port.onDisconnect.addListener(() => { this.ports.delete(port) })
    port.onMessage.addListener((message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      const msg = message as { type?: unknown; sessionId?: unknown; id?: unknown }
      if (msg.type === 'taint.subscribe') {
        void this.ready.then(() => { this.post(port) })
      } else if (msg.type === 'strict.session') {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
        this.setStrictSession(sessionId, (message as { enabled?: unknown }).enabled === true)
      } else if (msg.type === 'taint.trust') {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
        const origins = (message as { origins?: unknown }).origins
        const wanted = Array.isArray(origins) ? origins.filter((origin): origin is string => typeof origin === 'string') : []
        void this.ready.then(() => this.trustSources(sessionId, wanted)).then(
          (result) => ({ ok: true, ...result }),
          () => ({ ok: false, trusted: [] as string[], cleared: false }),
        ).then((result) => {
          try {
            port.postMessage({ type: 'taint.trust.result', id: msg.id, key: taintKey(sessionId), ...result })
          } catch { /* port closed */ }
        })
      } else if (msg.type === 'taint.clear') {
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
        void this.ready.then(() => this.clear(sessionId)).then((result) => {
          try {
            port.postMessage({ type: 'taint.clear.result', id: msg.id, ok: true, key: taintKey(sessionId), ...result })
          } catch { /* port closed */ }
        })
      }
    })
    return true
  }

  private post(port: chrome.runtime.Port): void {
    try {
      port.postMessage({
        type: 'taint.state',
        records: this.taint.snapshot(),
        trustable: this.trustable(),
        exemptSources: this.exemptSources(),
        unconfirmedTrust: this.unconfirmedTrust(),
        strictSessions: [...this.strictSessions],
        managed: { active: this.managed.active, siteRules: this.managed.siteRules },
      })
    } catch { /* port closed */ }
  }

  broadcast(): void {
    for (const port of this.ports) this.post(port)
  }
}
