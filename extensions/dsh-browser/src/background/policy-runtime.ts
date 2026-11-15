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
import { allTaintExempt, originTaintExempt, trustPatternFor, withTrustedSite, type TaintExemptionConfig } from '../security/taint-exempt.ts'
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
export { BRIDGE_TAINT_CLEAR_METHOD, BRIDGE_TAINT_MARK_METHOD } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'

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
}

/**
 * Where a call's tab stood once the call settled: the top page's origin and
 * the origins of every frame in it. `opaque` means the top page has no web
 * origin (a browser page, a file), so its content cannot be attributed.
 */
export interface TabProvenance {
  top?: string
  frames: string[]
  opaque: boolean
}

/** Tools whose result can quote any frame of the tab, whatever frame they target (a dialog's text). */
const WHOLE_TAB_PROVENANCE_TOOLS: ReadonlySet<string> = new Set(['browser_dialog'])

/** Tools whose result quotes pages other than the one in the tab (source URLs and names of past downloads). */
const NEVER_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['browser_downloads'])

export interface PolicyRuntimeOptions {
  settings: () => PolicySettings
  /** Whether unrestricted access is currently in effect (already managed-filtered). */
  unrestricted: () => boolean
  /** Forward a clear to the bridge; rejects when it is not connected. */
  clearBridgeTaint: (sessionId: string | undefined) => Promise<void>
  /**
   * Persist new user site rules through the settings path Settings itself
   * saves with (normalized, managed overrides applied). Absent: the banner's
   * "Trust" is refused.
   */
  saveSiteRules?: (rules: SiteRuleEntry[]) => Promise<void>
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
}

function noteTargets(record: CallRecord, targets: CallPolicyTargets): void {
  record.targets = targets
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
    const record: CallRecord = { seen: new Set(), touched: false, opaque: false }
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
  provenanceEvaluator(sessionId: string | undefined, unrestricted: boolean): { policy: CallPolicyHook; origins: () => string[] | undefined } {
    const record: CallRecord = { seen: new Set(), touched: false, opaque: false }
    return {
      policy: (call, targets) => {
        noteTargets(record, targets)
        return this.evaluate({ ...call, sessionId }, targets, unrestricted)
      },
      origins: () => record.touched && !record.opaque ? [...record.seen] : undefined,
    }
  }

  /** Whether a read could leave this session untainted at all (some exemption is on and it is untainted). */
  mayExempt(sessionId: string | undefined): boolean {
    if (this.taint.get(sessionId) !== undefined) return false
    const config = this.exemption()
    return config.localPages || config.trustedSites
  }

  /** The exemptions in force now: the two settings, minus what managed policy forces off. */
  exemption(): TaintExemptionConfig {
    const settings = this.options.settings()
    return {
      localPages: settings.taintExemptLocalPages === true && !this.managed.disableLocalTaintExemption,
      trustedSites: settings.taintExemptTrustedSites === true && !this.managed.disableTrustedTaintExemption,
      // Unrestricted access is not an explicit choice about any one site.
      site: this.sitePolicy(false),
      trustedActionOrigins: settings.trustedActionOrigins ?? [],
    }
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
   *   JavaScript can return anything.
   */
  private exemptProvenance(name: string, record: CallRecord | undefined, fallbackOrigin: string | undefined, after: TabProvenance | undefined): string[] | undefined {
    const config = this.exemption()
    if (!config.localPages && !config.trustedSites) return undefined
    if (NEVER_EXEMPT_TOOLS.has(name) || isDevToolsTool(name)) return undefined
    const origins = new Set<string>()
    const judged = record?.targets !== undefined
    if (judged) {
      if (record.opaque) return undefined
      for (const origin of record.seen) origins.add(origin)
    } else if (fallbackOrigin !== undefined) {
      origins.add(fallbackOrigin)
    }
    const wholeTab = !judged || !record.touched || WHOLE_TAB_PROVENANCE_TOOLS.has(name)
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
    return allTaintExempt(list, config) ? list : undefined
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
   */
  recordResult(call: Pick<ToolCall, 'id' | 'name' | 'sessionId'>, ok: boolean, fallbackOrigin?: string, after?: TabProvenance): { exempt: boolean } {
    const record = this.calls.get(call.id)
    this.calls.delete(call.id)
    // A failed call that reached a page can still quote it (an open dialog's
    // text, a content-script error): it taints like a success.
    const reachedPage = record?.targets !== undefined || fallbackOrigin !== undefined
    if (!resultTaintsSession(call.name, true) || (!ok && !reachedPage)) return { exempt: false }
    if (this.taint.get(call.sessionId) === undefined) {
      const exempt = this.exemptProvenance(call.name, record, fallbackOrigin, after)
      if (exempt !== undefined) {
        this.taint.noteExemptRead(call.sessionId, exempt)
        return { exempt: true }
      }
    }
    const targets = record?.targets
    const origins = targets === undefined
      ? fallbackOrigin === undefined ? [] : [fallbackOrigin]
      : [...new Set([...targets.reads, ...targets.acts])]
    // After a navigation or new tab the agent looks at the destination page.
    let pageOrigin = targets === undefined ? fallbackOrigin : targets.pageOrigin
    if (targets?.destination !== undefined) {
      try {
        const destination = new URL(targets.destination).origin
        origins.push(destination)
        pageOrigin = destination
      } catch { /* not a URL */ }
    }
    this.taint.mark(call.sessionId, call.name, origins.length === 0 && fallbackOrigin !== undefined ? [fallbackOrigin] : origins, pageOrigin ?? fallbackOrigin)
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
   * The user attached a page selection to a prompt: its page text entered the
   * session. `origin` is the origin of the frame the selection was made in
   * (unknown without one). Returns whether the read was exempt, in which case
   * the bridge is not told to taint either.
   */
  recordSelection(sessionId: string, origin: string | undefined): { exempt: boolean } {
    if (origin !== undefined && this.taint.get(sessionId) === undefined && originTaintExempt(origin, this.exemption())) {
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
  injectionExempt(sessionId: string, origin: string | undefined, frames: readonly string[] | undefined): boolean {
    if (origin === undefined || frames === undefined || frames.length === 0) return false
    if (this.taint.get(sessionId) !== undefined) return false
    return allTaintExempt([origin, ...frames], this.exemption())
  }

  /**
   * A snapshot was injected into a session without a tool call (follow
   * refresh, resume, a watcher). It taints unless `frames` proves it exempt
   * ({@link injectionExempt}); the frames it read, when known, are sources
   * like the page itself.
   */
  recordInjection(sessionId: string, origin: string | undefined, frames?: readonly string[]): { exempt: boolean } {
    if (origin !== undefined && this.injectionExempt(sessionId, origin, frames)) {
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
   * Taint sources of each record the banner may offer to trust with one
   * click, mapped to the site pattern that would be added (see
   * {@link trustPatternFor}). A record with an unknown source offers none:
   * an unknown source can never be trusted, so trusting the rest could not
   * lift the taint.
   */
  trustable(): Record<string, Record<string, string>> {
    const config = this.exemption()
    const result: Record<string, Record<string, string>> = {}
    for (const [key, record] of Object.entries(this.taint.snapshot())) {
      if (record.sources.length === 0 || record.sources.includes(UNKNOWN_SOURCE)) continue
      const offered: Record<string, string> = {}
      for (const source of record.sources) {
        const pattern = trustPatternFor(source, config)
        if (pattern !== undefined) offered[source] = pattern
      }
      if (Object.keys(offered).length > 0) result[key] = offered
    }
    return result
  }

  /**
   * The banner's "Trust <site>": mark the named taint sources of one session
   * trusted, persistently, exactly as adding a `trusted` site rule in
   * Settings does. Only sources of that session's current record that
   * {@link trustPatternFor} offers are accepted, so the message cannot be
   * used to trust arbitrary sites. If every source of the record is exempt
   * afterwards the taint is cleared here and on the Host (the same as
   * Clear); otherwise the session stays tainted.
   */
  async trustSources(sessionId: string | undefined, origins: readonly string[]): Promise<{ trusted: string[]; cleared: boolean }> {
    const record = this.taint.get(sessionId)
    const save = this.options.saveSiteRules
    if (record === undefined || save === undefined) return { trusted: [], cleared: false }
    // An unknown source can never be trusted: the banner offers only Clear then.
    if (record.sources.length === 0 || record.sources.includes(UNKNOWN_SOURCE)) return { trusted: [], cleared: false }
    const config = this.exemption()
    const patterns = new Map<string, string>()
    for (const origin of new Set(origins)) {
      if (!record.sources.includes(origin)) continue
      const pattern = trustPatternFor(origin, config)
      if (pattern !== undefined) patterns.set(origin, pattern)
    }
    if (patterns.size === 0) return { trusted: [], cleared: false }
    let rules = [...this.options.settings().siteRules]
    for (const pattern of patterns.values()) rules = withTrustedSite(rules, pattern)
    await save(rules)
    // Judge what was actually stored (normalization or managed policy may have refused a rule).
    const now = this.exemption()
    const trusted = [...patterns.keys()].filter((origin) => originTaintExempt(origin, now))
    const current = this.taint.get(sessionId)
    const cleared = current !== undefined && allTaintExempt(current.sources, now)
    if (cleared) await this.clear(sessionId)
    else this.broadcast()
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
        strictSessions: [...this.strictSessions],
        managed: { active: this.managed.active, siteRules: this.managed.siteRules },
      })
    } catch { /* port closed */ }
  }

  broadcast(): void {
    for (const port of this.ports) this.post(port)
  }
}
