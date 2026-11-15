/**
 * Background runtime for the policy layer: site rules from settings and
 * managed storage, session taint, and the panel's taint/clear channel.
 *
 * Kept out of index.ts so the entry point only wires a hook into each
 * dispatch path and reports results.
 *
 * Panel channel: extension pages (never content scripts) connect a port named
 * {@link POLICY_PORT_NAME} and send `{ type: 'taint.subscribe' }` or
 * `{ type: 'taint.clear', sessionId?, id? }`; the background pushes
 * `{ type: 'taint.state', records }` on every change and answers a clear with
 * `{ type: 'taint.clear.result', id, ok, bridgeCleared }`.
 *
 * @module
 */

import { evaluateCallPolicy, type CallPolicyDecision, type CallPolicyTargets, type ManagedCallFlags } from '../security/call-policy.ts'
import { EMPTY_MANAGED_POLICY, loadManagedPolicy, type ManagedPolicy } from '../security/managed-policy.ts'
import { matchSitePattern, type SitePolicy, type SiteRuleEntry } from '../security/site-policy.ts'
import { resultTaintsSession, TaintTracker, taintKey, type TaintRecord } from '../security/taint.ts'
import { httpOrigin, parseHttpUrl } from '../security/web-url.ts'
import type { CallPolicyHook, ToolCall } from './tools.ts'
import { isDevToolsTool } from './authorization.ts'

export const POLICY_PORT_NAME = 'dsh-policy'
export const TAINT_STORAGE_KEY = 'dshSessionTaint'
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
}

export interface PolicyRuntimeOptions {
  settings: () => PolicySettings
  /** Whether unrestricted access is currently in effect (already managed-filtered). */
  unrestricted: () => boolean
  /** Forward a clear to the bridge; rejects when it is not connected. */
  clearBridgeTaint: (sessionId: string | undefined) => Promise<void>
  /** Called after managed policy changes so settings can be re-normalized. */
  onManagedChange?: (policy: ManagedPolicy) => void
  storage?: chrome.storage.StorageArea
}

/** What one dispatched call touched, kept until its result is known. */
interface CallRecord {
  targets?: CallPolicyTargets
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
  private readonly ports = new Set<chrome.runtime.Port>()

  constructor(private readonly options: PolicyRuntimeOptions) {
    const storage = options.storage
    this.taint = new TaintTracker(storage === undefined
      ? undefined
      : {
          read: async () => (await storage.get(TAINT_STORAGE_KEY))[TAINT_STORAGE_KEY],
          write: async (value) => { await storage.set({ [TAINT_STORAGE_KEY]: value }) },
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
    if (storage === undefined) return
    try {
      const stored = (await storage.get(STRICT_SESSIONS_STORAGE_KEY))[STRICT_SESSIONS_STORAGE_KEY]
      if (Array.isArray(stored)) for (const key of stored) if (typeof key === 'string') this.strictSessions.add(key)
    } catch {
      // Storage unavailable: strict sites from settings still apply.
    }
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
    const record: CallRecord = {}
    this.calls.set(callId, record)
    return (call, targets) => {
      record.targets = targets
      return this.evaluate({ ...call, sessionId }, targets, unrestricted)
    }
  }

  /**
   * A call settled. A successful browser result taints its session with the
   * origins it touched (or `fallbackOrigin`, the tab's origin, when the call
   * never reached the policy hook).
   */
  recordResult(call: Pick<ToolCall, 'id' | 'name' | 'sessionId'>, ok: boolean, fallbackOrigin?: string): void {
    const record = this.calls.get(call.id)
    this.calls.delete(call.id)
    // A failed call that reached a page can still quote it (an open dialog's
    // text, a content-script error): it taints like a success.
    const reachedPage = record?.targets !== undefined || fallbackOrigin !== undefined
    if (!resultTaintsSession(call.name, true) || (!ok && !reachedPage)) return
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
    if (this.taint.get(sessionId) === undefined) this.taint.mark(sessionId, 'host-lineage', [])
  }

  /** The user attached a page selection to a prompt: its page text entered the session. */
  recordSelection(sessionId: string, origin: string | undefined): void {
    this.taint.mark(sessionId, 'selection-attachment', origin === undefined ? [] : [origin])
  }

  /** A snapshot was injected into a session without a tool call (follow refresh). */
  recordInjection(sessionId: string, origin: string | undefined): void {
    this.taint.mark(sessionId, 'snapshot-injection', origin === undefined ? [] : [origin], origin)
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
        strictSessions: [...this.strictSessions],
        managed: { active: this.managed.active, siteRules: this.managed.siteRules },
      })
    } catch { /* port closed */ }
  }

  broadcast(): void {
    for (const port of this.ports) this.post(port)
  }
}
