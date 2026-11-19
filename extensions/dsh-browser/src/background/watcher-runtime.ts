/**
 * Browser wiring for standing page watchers: chrome.storage persistence, the
 * content-script arm/sync/hit messages, URL watchers on tabs.onUpdated, tab
 * removal, and the panel's `dsh-watchers` port. The policy lives in
 * watchers.ts; this module only connects it to the extension APIs so the
 * entry point needs a handful of one-line hooks.
 *
 * @module
 */

import { BRIDGE_WATCH_FIRE_METHOD } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import { isExtensionPageSender } from './policy-runtime.ts'
import { httpOrigin } from '../security/web-url.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import type { CallPolicyHook, ToolCall } from './tools.ts'
import {
  armedFor,
  selectorSyntaxError,
  createWatcher,
  handleWatchHit,
  manageWatchers,
  panelView,
  urlHits,
  WATCHERS_PORT_NAME,
  WATCHERS_STORAGE_KEY,
  WatcherRegistry,
  type WatchStorage,
  type WatchAnswer,
  type WatchHitDeps,
} from './watchers.ts'

/** What the runtime needs from the background entry point. */
export interface PageWatcherRuntimeOptions {
  enabled: () => boolean
  /** Kill switch engaged, or the user paused / took over. */
  blocked: () => boolean
  shareContent: () => boolean
  /** Site policy hides the page from the agent (blocked / managed-disallowed). */
  pageHidden?: (url: string) => boolean
  /** Bridge RPC (resolves with the server-response envelope). */
  rpc: (method: string, payload: unknown) => Promise<unknown>
  /** Record that page content entered a session (extension-side taint). */
  noteTaint: (sessionId: string, origin: string) => void
  /** A hit is about to fire: wait briefly for a reconnecting bridge (watchers.ts `WatchHitDeps.connected`). */
  connected?: () => Promise<void>
  /** The set of watchers (or the setting) changed: the runtime lease counts live watchers. */
  changed?: () => void
}

/** Per-call dependencies supplied by the dispatch path. */
export interface WatchCallDeps {
  resolveTab: (sessionId: string | undefined) => Promise<{ id?: number; url?: string; title?: string; windowId?: number } | { ok: boolean; error?: { message: string } }>
  allowsTab: (tabId: number, sessionId: string | undefined) => boolean
  authorize: (prompt: ApprovalPrompt, windowId: number) => Promise<ApprovalAuthorization>
  /** Site and managed policy (and taint) for the watched page. */
  policy?: CallPolicyHook
  signal: AbortSignal
}

function unwrapServerResponse(value: unknown): unknown {
  // Bridge-internal RPCs answer `{ type: 'server-response', result: { ok, value } }`.
  const result = (value as { result?: { ok?: unknown; value?: unknown } } | undefined)?.result
  return result?.ok === true ? result.value : value
}

/**
 * Where watchers persist: `chrome.storage.session` (survives worker restarts,
 * cleared with the browser session), because a watcher is bound to a tab id
 * and tab ids are only unique within one browser session. Without a session
 * area local storage is used; startup then drops watchers of tabs that no
 * longer exist.
 */
function watcherStorage(): WatchStorage {
  const session = (chrome.storage as { session?: chrome.storage.StorageArea }).session
  if (session !== undefined) {
    // Watchers an older build kept in local storage name tabs of an earlier browser session.
    void Promise.resolve().then(() => chrome.storage.local.remove(WATCHERS_STORAGE_KEY)).catch(() => {})
  }
  const area = session ?? chrome.storage.local
  return {
    get: async (key) => await area.get(key) as Record<string, unknown>,
    set: async (items) => { await area.set(items) },
  }
}

export class PageWatcherRuntime {
  readonly registry: WatcherRegistry
  private readonly ports = new Set<chrome.runtime.Port>()

  constructor(private readonly options: PageWatcherRuntimeOptions, registry?: WatcherRegistry) {
    this.registry = registry ?? new WatcherRegistry(watcherStorage())
    this.install()
  }

  private hitDeps(): WatchHitDeps {
    return {
      registry: this.registry,
      enabled: this.options.enabled,
      blocked: this.options.blocked,
      shareContent: this.options.shareContent,
      ...(this.options.pageHidden === undefined ? {} : { pageHidden: this.options.pageHidden }),
      fire: async (payload) => {
        const answer = unwrapServerResponse(await this.options.rpc(BRIDGE_WATCH_FIRE_METHOD, payload))
        // Every wake carries page-controlled data (at least its URL): it taints like a read.
        if ((answer as { woken?: unknown } | undefined)?.woken === true) {
          const watcher = this.registry.get(String(payload.watchId))
          let origin = watcher?.origin ?? ''
          try { origin = new URL(String(payload.url)).origin } catch { /* keep the approved origin */ }
          this.options.noteTaint(String(payload.sessionId), origin)
        }
        return answer
      },
      ...(this.options.connected === undefined ? {} : {
        connected: this.options.connected,
        currentUrl: (tabId: number) => chrome.tabs.get(tabId).then((tab) => tab.url, () => undefined),
      }),
      changed: () => { this.broadcast() },
    }
  }

  /** Handle `browser_watch` / `browser_watches`. */
  dispatch(call: ToolCall, deps: WatchCallDeps): Promise<WatchAnswer> {
    const shared = {
      registry: this.registry,
      changed: () => { this.broadcast() },
      arm: (tabId: number) => this.arm(tabId),
      ...(this.options.pageHidden === undefined ? {} : { pageHidden: this.options.pageHidden }),
    }
    if (call.name === 'browser_watches') return manageWatchers(call, shared)
    return createWatcher(call, {
      ...shared,
      enabled: this.options.enabled,
      resolveTab: deps.resolveTab,
      allowsTab: deps.allowsTab,
      getTab: (tabId) => chrome.tabs.get(tabId).then((tab) => tab, () => undefined),
      validateSelector: async (tabId, selector) => {
        // Best effort: where the page cannot be scripted the content script still drops an unparseable selector.
        const results = await chrome.scripting?.executeScript({ target: { tabId, frameIds: [0] }, func: selectorSyntaxError, args: [selector] }).catch(() => undefined)
        const error = results?.[0]?.result
        return typeof error === 'string' ? error : undefined
      },
      authorize: deps.authorize,
      ...deps.policy === undefined ? {} : { policy: deps.policy },
      signal: deps.signal,
    })
  }

  /** Push a tab's armed watchers to its top-frame content script. */
  async arm(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (tab === undefined) return
    await chrome.tabs.sendMessage(tabId, { type: 'DSH_WATCH_ARM', watches: armedFor(this.registry, tabId, tab.url) }, { frameId: 0 }).catch(() => {})
  }

  /** Revoke every watcher (kill switch, setting turned off). */
  async clearAll(): Promise<void> {
    await this.registry.ready
    const tabs = new Set(this.registry.list().map((watcher) => watcher.tabId))
    await this.registry.clear()
    for (const tabId of tabs) await this.arm(tabId)
    this.broadcast()
  }

  /** Accept the panel's watcher port. */
  connect(port: chrome.runtime.Port): boolean {
    if (port.name !== WATCHERS_PORT_NAME) return false
    if (!isExtensionPageSender(port.sender)) {
      port.disconnect()
      return true
    }
    this.ports.add(port)
    port.onDisconnect.addListener(() => { this.ports.delete(port) })
    port.onMessage.addListener((message: unknown) => {
      const msg = message as { type?: unknown; id?: unknown }
      if (msg?.type === 'watchers.subscribe') {
        void this.registry.ready.then(() => { this.post(port) })
      } else if (msg?.type === 'watchers.cancel' && typeof msg.id === 'string') {
        const watcher = this.registry.get(msg.id)
        if (watcher === undefined) return
        void this.registry.remove(msg.id).then(() => this.arm(watcher.tabId)).then(() => { this.broadcast() })
      }
    })
    return true
  }

  private post(port: chrome.runtime.Port): void {
    try {
      port.postMessage({ type: 'watchers.state', enabled: this.options.enabled(), watchers: this.registry.list().map(panelView) })
    } catch { /* port closed */ }
  }

  broadcast(): void {
    this.options.changed?.()
    for (const port of this.ports) this.post(port)
  }

  private install(): void {
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (typeof message !== 'object' || message === null) return undefined
      if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return undefined
      const type = (message as { type?: unknown }).type
      const tabId = sender.tab.id
      if (type === 'DSH_WATCH_INVALID') {
        // The page cannot evaluate this watcher (its selector never parses there): drop it
        // instead of listing a watcher that can never fire. Only that tab's own watcher.
        const watchId = (message as { watchId?: unknown }).watchId
        void this.registry.ready.then(async () => {
          const watcher = typeof watchId === 'string' ? this.registry.get(watchId) : undefined
          if (watcher === undefined || watcher.tabId !== tabId || (sender.frameId ?? 0) !== 0) return
          // Same checks as a hit: only the watched origin's page, and only a selector can fail to parse.
          if (watcher.condition.kind !== 'selector' || httpOrigin(sender.url) !== watcher.origin) return
          await this.registry.remove(watcher.id)
          this.broadcast()
        })
        return undefined
      }
      if (type === 'DSH_WATCH_HIT') {
        const hit = message as { watchId?: unknown; matched?: unknown }
        void handleWatchHit(
          { watchId: hit.watchId, matched: hit.matched },
          { tabId, url: sender.url ?? sender.tab.url, frameId: sender.frameId },
          this.hitDeps(),
        ).then(sendResponse, () => { sendResponse({ accepted: false, reason: 'internal' }) })
        return true
      }
      return undefined
    })
    // A restarted worker re-arms every watched tab; content scripts keep observing meanwhile.
    // A tab closed while no worker ran (tabs.onRemoved missed) takes its watchers with it.
    void this.registry.ready.then(async () => {
      let changed = false
      for (const tabId of new Set(this.registry.list().map((watcher) => watcher.tabId))) {
        const open = await chrome.tabs.get(tabId).then(() => true, () => false)
        if (open) await this.arm(tabId)
        else if (await this.registry.removeTab(tabId)) changed = true
      }
      if (changed) this.broadcast()
    })
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      // A finished navigation has a fresh content script: give it the tab's watchers.
      if (changeInfo.status === 'complete') {
        void this.registry.ready.then(() => this.registry.forTab(tabId).length > 0 ? this.arm(tabId) : undefined)
      }
      const url = changeInfo.url
      if (url === undefined) return
      void this.registry.ready.then(async () => {
        for (const watcher of urlHits(this.registry, tabId, url)) {
          await handleWatchHit({ watchId: watcher.id, matched: url }, { tabId, url, frameId: undefined, urlWatcher: true }, this.hitDeps())
        }
      })
    })
    chrome.tabs.onRemoved.addListener((tabId) => {
      void this.registry.ready.then(() => this.registry.removeTab(tabId)).then((changed) => { if (changed) this.broadcast() })
    })
  }
}
