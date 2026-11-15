/**
 * Browser side of the closed dev loop (Phase 3.5; bridge: dev-loop.ts).
 *
 * The user links a localhost tab to one of their DSH coding sessions from the
 * side panel (an explicit action, recorded here and on the bridge). While
 * linked, a small collector in the page's main world records console errors,
 * uncaught exceptions and failed `fetch`/XHR requests. After a turn of that
 * session edited files, the bridge sends the reserved
 * `browser_devloop_capture` action through the ordinary `tool.call` path
 * (pause gate, kill switch, audit), and this module answers with the
 * collected errors, failed requests and a DOM delta. The DOM delta is a
 * normal `browser_snapshot { delta: true }` read under the call's site
 * policy, taint rules and approval settings; when that read is refused,
 * nothing from the page is returned.
 *
 * The answer is `{ text, origins }`: the raw rendered capture (the bridge
 * fences it with its own nonce; no boundary written here is relied on) and
 * every origin the capture read, the linked page's and each of its frames'.
 * The bridge leaves the coding session untainted only when all of them are
 * loopback; a frame whose origin cannot be judged is reported as such.
 *
 * Refused: a session without a link made in this browser, a linked tab that
 * is gone or has left its linked origin, and any non-loopback origin the
 * bridge did not allow.
 *
 * @module
 */

import { devLoopOrigin } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { ToolAnswer } from './tools.ts'

/** One recorded link. */
export interface DevLoopTabLink {
  sessionId: string
  tabId: number
  origin: string
  /** Panel label for the session (title or project), display only. */
  label?: string
}

/** What the collector recorded since the previous drain. */
export interface DevLoopCollected {
  console: Array<{ level: string; text: string }>
  network: Array<{ method: string; url: string; status?: number; error?: string }>
  dropped: number
}

/** Storage key of the links (chrome.storage.session: cleared with the browser session). */
export const DEVLOOP_STORAGE_KEY = 'devLoopLinks'

/** Most entries the collector keeps per kind between drains. */
const MAX_ENTRIES = 100

/** Most characters of one recorded entry. */
const MAX_ENTRY_CHARS = 500

/**
 * Installed into the page's main world (serialized by chrome.scripting): hook
 * console errors, uncaught errors, rejections and failed fetch/XHR, once.
 * Must stay self-contained.
 */
export function devLoopCollector(maxEntries: number, maxChars: number): void {
  const key = Symbol.for('dsh.devloop.collector')
  const scope = globalThis as unknown as Record<symbol, DevLoopCollected | undefined>
  if (scope[key] !== undefined) return
  const state: DevLoopCollected = { console: [], network: [], dropped: 0 }
  Object.defineProperty(globalThis, key, { value: state, enumerable: false, configurable: true })
  const clip = (text: string): string => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text)
  const describe = (value: unknown): string => {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  const pushConsole = (level: string, text: string): void => {
    if (state.console.length >= maxEntries) { state.dropped += 1; return }
    state.console.push({ level, text: clip(text) })
  }
  const pushNetwork = (entry: DevLoopCollected['network'][number]): void => {
    if (state.network.length >= maxEntries) { state.dropped += 1; return }
    state.network.push({ ...entry, url: clip(entry.url) })
  }
  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    pushConsole('error', args.map(describe).join(' '))
    originalError(...args)
  }
  addEventListener('error', (event) => {
    const where = event.filename ? ` (${event.filename}:${String(event.lineno)})` : ''
    pushConsole('exception', `${event.message}${where}`)
  })
  addEventListener('unhandledrejection', (event) => { pushConsole('unhandledrejection', describe(event.reason)) })
  const originalFetch = globalThis.fetch?.bind(globalThis)
  if (originalFetch !== undefined) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const url = input instanceof Request ? input.url : String(input)
      try {
        const response = await originalFetch(input, init)
        if (response.status >= 400) pushNetwork({ method, url, status: response.status })
        return response
      } catch (error) {
        pushNetwork({ method, url, error: describe(error) })
        throw error
      }
    }
  }
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send
  const xhrInfo = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrInfo.set(this, { method: String(method).toUpperCase(), url: String(url) })
    return (xhrOpen as (...args: unknown[]) => void).call(this, method, url, ...rest)
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener('loadend', () => {
      const info = xhrInfo.get(this)
      if (info === undefined) return
      if (this.status === 0) pushNetwork({ ...info, error: 'network error' })
      else if (this.status >= 400) pushNetwork({ ...info, status: this.status })
    })
    return xhrSend.call(this, body)
  }
}

/** Main-world drain: return and reset what the collector recorded. */
export function devLoopDrain(): DevLoopCollected | null {
  const state = (globalThis as unknown as Record<symbol, DevLoopCollected | undefined>)[Symbol.for('dsh.devloop.collector')]
  if (state === undefined) return null
  const copy: DevLoopCollected = { console: state.console.splice(0), network: state.network.splice(0), dropped: state.dropped }
  state.dropped = 0
  return copy
}

/** Render one capture for the model (the caller wraps it as untrusted). */
export function renderDevLoopCapture(origin: string, collected: DevLoopCollected | null, delta: string | undefined): string {
  const lines = [`Linked tab: ${origin}`]
  if (collected === null) {
    lines.push('The error collector was not installed in this page yet (it is installed on link and on every navigation); console errors and failed requests from before that are not available.')
  } else {
    lines.push(collected.console.length === 0
      ? 'Console errors since the last turn: none.'
      : `Console errors since the last turn (${String(collected.console.length)}):`)
    for (const entry of collected.console) lines.push(`- [${entry.level}] ${entry.text}`)
    lines.push(collected.network.length === 0
      ? 'Failed network requests since the last turn: none.'
      : `Failed network requests since the last turn (${String(collected.network.length)}):`)
    for (const entry of collected.network) {
      lines.push(`- ${entry.method} ${entry.url} → ${entry.status === undefined ? (entry.error ?? 'failed') : String(entry.status)}`)
    }
    if (collected.dropped > 0) lines.push(`(${String(collected.dropped)} more entries were dropped.)`)
  }
  lines.push(delta === undefined || delta.trim() === '' ? 'DOM changes: none reported.' : `DOM changes:\n${delta}`)
  return lines.join('\n')
}

/** Browser services the controller uses (injected for tests). */
export interface DevLoopBrowser {
  getTab(tabId: number): Promise<{ id?: number; url?: string; title?: string; windowId?: number } | undefined>
  /** Run a self-contained function in the tab's main world. */
  runInPage<T>(tabId: number, func: (...args: never[]) => T, args: unknown[]): Promise<T | undefined>
  load(): Promise<unknown>
  save(value: unknown): Promise<void>
  /** URLs of every frame of the tab (top included), for the origins report. */
  frameUrls?(tabId: number): Promise<string[]>
}

/**
 * The origin a frame URL's content comes from, for the taint decision:
 * http(s) and blob: URLs by their origin, about:blank/srcdoc frames by their
 * parent (skipped), anything else (data:, file:, opaque) as its scheme, which
 * is never loopback.
 */
export function frameContentOrigin(url: string): string | undefined {
  if (url === '' || url === 'about:blank' || url === 'about:srcdoc') return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'blob:') {
      return parsed.origin === 'null' ? parsed.protocol : parsed.origin
    }
    return parsed.protocol
  } catch {
    return 'unknown:'
  }
}

/** Links, collector installation and the capture action. */
export class DevLoopController {
  private readonly links = new Map<string, DevLoopTabLink>()
  readonly ready: Promise<void>

  constructor(private readonly browser: DevLoopBrowser) {
    this.ready = browser.load().then((stored) => {
      if (!Array.isArray(stored)) return
      for (const entry of stored) {
        const link = parseLink(entry)
        if (link !== undefined) this.links.set(link.sessionId, link)
      }
    }, () => {})
  }

  /**
   * The http(s) origin of a URL. Which origins may be linked is the bridge's
   * call (loopback by default, plus its configured extras); a link records the
   * origin the bridge accepted, and captures require the tab to still be on it.
   */
  originOf(url: string | undefined): string | undefined {
    return devLoopOrigin(url, [httpOrigin(url) ?? ''])
  }

  /** Record a link the user made in the panel (after the bridge accepted it). */
  async link(link: DevLoopTabLink): Promise<void> {
    await this.ready
    this.links.set(link.sessionId, link)
    await this.persist()
    await this.install(link.tabId)
  }

  async unlink(sessionId: string): Promise<boolean> {
    await this.ready
    const removed = this.links.delete(sessionId)
    if (removed) await this.persist()
    return removed
  }

  /** Current links (panel list; re-asserted to the bridge on panel open). */
  async list(): Promise<DevLoopTabLink[]> {
    await this.ready
    return [...this.links.values()]
  }

  /** The link of a session, if any. */
  linkOf(sessionId: string | undefined): DevLoopTabLink | undefined {
    return sessionId === undefined ? undefined : this.links.get(sessionId)
  }

  /** Whether a tab is the linked target of a session (capture-time re-check). */
  allowsTarget(sessionId: string | undefined, tabId: number | undefined): boolean {
    const link = this.linkOf(sessionId)
    return link !== undefined && link.tabId === tabId
  }

  /** A linked tab committed a navigation: reinstall the collector when it is still on its origin. */
  async onCommitted(tabId: number, url: string): Promise<void> {
    await this.ready
    if (![...this.links.values()].some(link => link.tabId === tabId && this.originOf(url) === link.origin)) return
    await this.install(tabId)
  }

  /** A tab closed: its links end. */
  async onRemoved(tabId: number): Promise<void> {
    await this.ready
    let changed = false
    for (const [sessionId, link] of this.links) {
      if (link.tabId === tabId) {
        this.links.delete(sessionId)
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  /**
   * Answer one `browser_devloop_capture` call.
   * @param call - the bridge call (its sessionId names the coding session).
   * @param readDelta - the DOM delta read through the call's policy and approval path.
   * @param clip - budget the page-derived text (the bridge fences it).
   */
  async capture(
    call: { sessionId?: string; args: Record<string, unknown> },
    readDelta: (tab: { id?: number; url?: string; title?: string; windowId?: number }) => Promise<ToolAnswer>,
    clip: (text: string) => string,
  ): Promise<ToolAnswer & { origin?: string }> {
    await this.ready
    const link = this.linkOf(call.sessionId)
    if (link === undefined) return refuse('This session is not linked to a browser tab in this browser (link it from the side panel).')
    if (typeof call.args.origin === 'string' && call.args.origin !== link.origin) return refuse('The bridge and the browser disagree about the linked origin; relink the tab.')
    const tab = await this.browser.getTab(link.tabId)
    if (tab === undefined) return refuse('The linked tab was closed.')
    if (this.originOf(tab.url) !== link.origin) return refuse(`The linked tab left ${link.origin}; nothing was read.`)
    const delta = await readDelta(tab)
    // The page read decides whether anything from this page may be shared.
    if (!delta.ok) return { ...delta, origin: link.origin }
    const collected = await this.browser.runInPage(link.tabId, devLoopDrain, []).catch(() => null) ?? null
    const text = (delta.result as { text?: unknown } | undefined)?.text
    // Every origin the read could have quoted: the page and all of its frames.
    const frameUrls = await this.browser.frameUrls?.(link.tabId).catch(() => undefined)
    const origins = new Set<string>([link.origin])
    if (frameUrls === undefined) origins.add('unknown:')
    for (const url of frameUrls ?? []) {
      const origin = frameContentOrigin(url)
      if (origin !== undefined) origins.add(origin)
    }
    return {
      ok: true,
      origin: link.origin,
      result: { text: clip(renderDevLoopCapture(link.origin, collected, typeof text === 'string' ? text : undefined)), origins: [...origins] },
    }
  }

  private async install(tabId: number): Promise<void> {
    await this.browser.runInPage(tabId, devLoopCollector, [MAX_ENTRIES, MAX_ENTRY_CHARS]).catch(() => undefined)
  }

  private async persist(): Promise<void> {
    await this.browser.save([...this.links.values()]).catch(() => undefined)
  }
}

function refuse(message: string): ToolAnswer {
  return { ok: false, error: { code: 'action-failed', message } }
}

function parseLink(value: unknown): DevLoopTabLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { sessionId, tabId, origin, label } = value as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId === '' || typeof tabId !== 'number' || typeof origin !== 'string') return undefined
  return { sessionId, tabId, origin, ...(typeof label === 'string' ? { label } : {}) }
}

/** Production browser services. */
export function chromeDevLoopBrowser(): DevLoopBrowser {
  const area = (): chrome.storage.StorageArea | undefined => chrome.storage?.session ?? chrome.storage?.local
  return {
    getTab: (tabId) => chrome.tabs.get(tabId).then(tab => tab, () => undefined),
    runInPage: async (tabId, func, args) => {
      const [first] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: func as (...args: unknown[]) => unknown,
        args,
      } as chrome.scripting.ScriptInjection<unknown[], unknown>)
      return first?.result as never
    },
    frameUrls: async (tabId) => {
      const frames = await chrome.webNavigation.getAllFrames({ tabId })
      if (frames === null || frames === undefined || frames.length === 0) throw new Error('no frame list')
      return frames.map(frame => frame.url)
    },
    load: async () => (await area()?.get(DEVLOOP_STORAGE_KEY))?.[DEVLOOP_STORAGE_KEY],
    save: async (value) => { await area()?.set({ [DEVLOOP_STORAGE_KEY]: value }) },
  }
}

function httpOrigin(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(url ?? '')
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}
