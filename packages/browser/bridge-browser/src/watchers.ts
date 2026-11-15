/**
 * Standing page watchers (`browser_watch`, `browser_watches`) on the bridge
 * side: the model-facing tools, the record of which session owns each
 * watcher, and the wake-up when the extension reports that one fired.
 *
 * The extension owns the watcher itself (the setting that enables it, the
 * approval card naming the page and the prompt, the in-page observer, and its
 * persistence across worker restarts). The bridge only:
 *
 * - records `watchId -> sessionId` when the extension confirms a watcher, in a
 *   0600 file so a host restart still recognizes it;
 * - on `bridge.watch.fire`, checks that the watcher is one it recorded, that
 *   the session belongs to this bridge (ledger `'own'`), and the wake rate
 *   limits, then wakes that session with `Agent.followup`: a short
 *   system-generated notice plus the matched page text inside the untrusted
 *   content boundary. The session is marked tainted like any page read.
 *
 * It never wakes a session it does not own, and never cold-starts one that
 * is not running (the extension shows that the wake was missed instead).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { BridgeServer } from './server.ts'
import { toolCallIdArg } from './server.ts'
import { errorMessage } from './host-api.ts'
import { readTrustedJson, serialQueue, writePrivateFile } from './private-file.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A standing page watcher fired (bridge-browser). */
    'browser-watch': { kind: 'browser-watch'; form: 'notice'; summary: string }
  }
}

import { BRIDGE_WATCH_FIRE_METHOD, wrapUntrustedPageText } from './protocol.ts'

/** Extension → bridge RPC: a watcher's condition was met. */
export { BRIDGE_WATCH_FIRE_METHOD }
/** Longest a watcher may live. */
export const MAX_WATCH_MINUTES = 24 * 60
/** Matched page text kept in a wake message. */
export const MAX_MATCHED_CHARS = 600
/** Minimum spacing between two wakes of one session. */
export const SESSION_WAKE_INTERVAL_MS = 30_000
/** Most wakes per session in one hour. */
export const SESSION_WAKES_PER_HOUR = 20

const MAX_RECORDS = 200

/** One recorded watcher. */
export interface WatchRecord {
  sessionId: string
  expiresAt: number
}

/** Durable `watchId -> owner` map. */
export interface WatchRecordStore {
  get(watchId: string): WatchRecord | undefined
  add(watchId: string, record: WatchRecord): Promise<void>
  remove(watchId: string): Promise<void>
  /** Drop every record a (purged) session owns. */
  removeSession(sessionId: string): Promise<void>
}

/** In-memory store (tests, or when no dsh home is writable). */
export function memoryWatchRecords(now: () => number = Date.now): WatchRecordStore {
  const records = new Map<string, WatchRecord>()
  return {
    get: (id) => {
      const record = records.get(id)
      if (record !== undefined && record.expiresAt <= now()) {
        records.delete(id)
        return undefined
      }
      return record
    },
    add: async (id, record) => { records.set(id, record) },
    remove: async (id) => { records.delete(id) },
    removeSession: async (sessionId) => {
      for (const [id, record] of records) if (record.sessionId === sessionId) records.delete(id)
    },
  }
}

/**
 * A 0600 JSON file of watcher owners, read only when it is a regular file
 * owned by this user and not group/other writable (same rule as the ledger).
 */
export async function fileWatchRecords(file: string, warn: (message: string) => void, now: () => number = Date.now): Promise<WatchRecordStore> {
  const records = new Map<string, WatchRecord>()
  const loaded = await readTrustedJson(file)
  if ('value' in loaded) loadRecords(loaded.value, records, now)
  const queue = serialQueue()
  const persist = (): Promise<void> => writePrivateFile(file, JSON.stringify(Object.fromEntries(records)), 'the page watcher records')
  const save = async (): Promise<void> => {
    const current = now()
    for (const [id, record] of records) if (record.expiresAt <= current) records.delete(id)
    while (records.size > MAX_RECORDS) records.delete(records.keys().next().value as string)
    await queue(persist).catch((error: unknown) => {
      warn(`browser bridge: could not persist page watchers: ${errorMessage(error)}`)
    })
  }
  return {
    get: (id) => {
      const record = records.get(id)
      return record === undefined || record.expiresAt <= now() ? undefined : record
    },
    add: async (id, record) => {
      records.set(id, record)
      await save()
    },
    remove: async (id) => {
      if (!records.delete(id)) return
      await save()
    },
    removeSession: async (sessionId) => {
      let changed = false
      for (const [id, record] of records) {
        if (record.sessionId === sessionId) {
          records.delete(id)
          changed = true
        }
      }
      if (changed) await save()
    },
  }
}

/** Keep the live, well-formed records of a trusted file. */
function loadRecords(parsed: unknown, records: Map<string, WatchRecord>, now: () => number): void {
  if (typeof parsed !== 'object' || parsed === null) return
  for (const [id, value] of Object.entries(parsed)) {
    const record = value as Partial<WatchRecord>
    if (typeof record.sessionId === 'string' && typeof record.expiresAt === 'number' && record.expiresAt > now()) {
      records.set(id, { sessionId: record.sessionId, expiresAt: record.expiresAt })
    }
  }
}

/** Per-session wake limiter. */
export class WakeLimiter {
  private readonly wakes = new Map<string, number[]>()
  constructor(private readonly now: () => number = Date.now) {}

  /** Whether a wake may go out now; records it when it may. */
  admit(sessionId: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now()
    const recent = (this.wakes.get(sessionId) ?? []).filter((at) => now - at < 3_600_000)
    const last = recent.at(-1)
    if (last !== undefined && now - last < SESSION_WAKE_INTERVAL_MS) return { ok: false, retryAfterMs: SESSION_WAKE_INTERVAL_MS - (now - last) }
    if (recent.length >= SESSION_WAKES_PER_HOUR) return { ok: false, retryAfterMs: 3_600_000 - (now - recent[0]!) }
    recent.push(now)
    this.wakes.set(sessionId, recent)
    return { ok: true }
  }

  /** Drop a purged session's history. */
  forget(sessionId: string): void {
    this.wakes.delete(sessionId)
  }
}

/** A validated fire report from the extension. */
export interface WatchFire {
  watchId: string
  sessionId: string
  prompt: string
  /** What the watcher waited for, in the extension's words (model-authored condition). */
  condition: string
  url: string
  /** Matched page text (absent when page sharing is off). */
  matched?: string
  fires: number
  maxFires: number
}

/** Parse the RPC payload. */
export function parseWatchFire(payload: unknown): WatchFire | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const p = payload as Record<string, unknown>
  const str = (key: string, max: number): string | undefined => typeof p[key] === 'string' && (p[key] as string).length <= max ? p[key] as string : undefined
  const watchId = str('watchId', 100)
  const sessionId = str('sessionId', 200)
  const prompt = str('prompt', 2_000)
  const condition = str('condition', 600)
  const url = str('url', 4_096)
  if (watchId === undefined || watchId === '' || sessionId === undefined || sessionId === '' || prompt === undefined || condition === undefined || url === undefined) return undefined
  const fires = typeof p.fires === 'number' && Number.isSafeInteger(p.fires) && p.fires > 0 ? p.fires : 1
  const maxFires = typeof p.maxFires === 'number' && Number.isSafeInteger(p.maxFires) && p.maxFires > 0 ? p.maxFires : 1
  const matched = typeof p.matched === 'string' ? p.matched.slice(0, MAX_MATCHED_CHARS) : undefined
  return { watchId, sessionId, prompt, condition, url, fires, maxFires, ...(matched === undefined ? {} : { matched }) }
}

/**
 * The model-facing wake message: system-generated notice; everything the
 * page controls (its URL, which history.pushState can rewrite, and the
 * matched text) inside one untrusted boundary.
 */
export function createWatchWakeMessage(fire: WatchFire): UserMessage {
  const lines = [
    `[Page watcher ${fire.watchId} fired] A watcher you created with browser_watch saw its condition (${fire.condition}) on the watched page`
      + ` (fire ${String(fire.fires)} of ${String(fire.maxFires)}). This message was generated by the browser bridge, not typed by the user.`,
    `The instruction you gave for this watcher: ${fire.prompt}`,
  ]
  const page = [`Page URL: ${fire.url}`]
  if (fire.matched !== undefined && fire.matched !== '') page.push(`Matched page content: ${fire.matched.slice(0, MAX_MATCHED_CHARS)}`)
  lines.push('Page data (untrusted):', wrapUntrustedPageText(page.join('\n')))
  if (fire.matched === undefined || fire.matched === '') {
    lines.push('No page content is included (page content sharing is off or nothing textual matched). Take a browser_snapshot if you need it.')
  }
  const text = lines.join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'browser-watch', form: 'notice', summary: `Page watcher fired: ${fire.condition}`.slice(0, 200) },
  })
}

/** What the fire handler needs. */
export interface WatchFireDeps {
  records: WatchRecordStore
  /** Ledger ownership: never wake a session the bridge does not own. */
  ownsSession: (sessionId: string, signal: AbortSignal) => Promise<boolean>
  /** Whether the session's Agent is resident (checked before any taint or rate slot is spent). */
  isRunning: (sessionId: string) => boolean
  /** Deliver to a running Agent; false when it is not resident. */
  wake: (sessionId: string, message: UserMessage) => boolean
  /** Mark the session as having read untrusted page content. */
  taint: (sessionId: string) => void
  limiter: WakeLimiter
}

/** Answer of the fire RPC. */
export type WatchFireAnswer =
  | { ok: true; result: { woken: true } | { woken: false; reason: 'not-running' | 'rate-limited'; retryAfterMs?: number } }
  | { ok: false; error: { code: string; message: string } }

/** Handle one `bridge.watch.fire`. */
export async function handleWatchFire(payload: unknown, signal: AbortSignal, deps: WatchFireDeps): Promise<WatchFireAnswer> {
  const fire = parseWatchFire(payload)
  if (fire === undefined) return { ok: false, error: { code: 'bad-request', message: 'invalid watcher fire payload' } }
  const record = deps.records.get(fire.watchId)
  if (record === undefined || record.sessionId !== fire.sessionId) {
    return { ok: false, error: { code: 'forbidden', message: 'unknown page watcher' } }
  }
  if (!await deps.ownsSession(fire.sessionId, signal).catch(() => false)) {
    return { ok: false, error: { code: 'forbidden', message: 'the session is not owned by this browser bridge' } }
  }
  // A session that is not resident gets nothing: no taint, no spent rate slot.
  if (!deps.isRunning(fire.sessionId)) return { ok: true, result: { woken: false, reason: 'not-running' } }
  const admitted = deps.limiter.admit(fire.sessionId)
  if (!admitted.ok) return { ok: true, result: { woken: false, reason: 'rate-limited', retryAfterMs: admitted.retryAfterMs } }
  const message = createWatchWakeMessage(fire)
  // Every wake carries page-controlled data (at least the URL): taint before the session can act on it.
  deps.taint(fire.sessionId)
  if (!deps.wake(fire.sessionId, message)) return { ok: true, result: { woken: false, reason: 'not-running' } }
  if (fire.fires >= fire.maxFires) await deps.records.remove(fire.watchId)
  return { ok: true, result: { woken: true } }
}

/** Tool descriptions (each under the per-tool share of the description cap). */
export const WATCH_DESCRIPTION = 'Watch a page (selector/text appears or is gone, URL match, network request) and wake this session with prompt when it happens. Needs the user\'s setting and approval.'
export const WATCHES_DESCRIPTION = 'List this session\'s page watchers, or cancel one by id.'

interface WatchToolOptions {
  toolTimeoutMs: number
}

function sessionOf(exec: Pick<ToolRunContext, 'agent'>): string | undefined {
  return exec.agent === undefined ? undefined : String(exec.agent.id)
}

function textOf(result: unknown, fallback: string): string {
  return typeof result === 'object' && result !== null && typeof (result as { text?: unknown }).text === 'string'
    ? (result as { text: string }).text
    : fallback
}

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
} as const

/** The two watcher tools (exported for the description-cap spec). */
export function defineWatchTools(bridge: Pick<BridgeServer, 'requestTool'>, records: WatchRecordStore, options: WatchToolOptions): ToolDefinition[] {
  const watch = defineTool({
    name: 'browser_watch',
    description: WATCH_DESCRIPTION,
    parameters: {
      tabId: { type: 'number', description: 'Tab to watch; defaults to the controlled tab.' },
      condition: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Exactly one of selector, text, urlMatches, networkRequest.',
        properties: {
          selector: { type: 'string', description: 'CSS selector that appears.' },
          text: { type: 'string', description: 'Text that appears (case-insensitive).' },
          gone: { type: 'boolean', description: 'Fire when the selector or text disappears instead.' },
          urlMatches: { type: 'string', description: 'URL contains this, or matches /regex/.' },
          networkRequest: { type: 'string', description: 'A request URL contains this, or matches /regex/.' },
        },
      },
      prompt: { type: 'string', required: true, description: 'What to do when it fires (sent back to you).' },
      expiresInMinutes: { type: 'number', description: 'Lifetime, 1-1440 (default 60).' },
      maxFires: { type: 'number', description: 'Fires before it ends, 1-10 (default 1).' },
    },
    timeoutMs: options.toolTimeoutMs,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec)
      if (sessionId === undefined) throw new Error('browser_watch needs an agent session to wake.')
      const a = args as { prompt: string; expiresInMinutes?: number; maxFires?: number }
      if (a.prompt.trim() === '') throw new Error('browser_watch needs a non-empty prompt.')
      if (a.expiresInMinutes !== undefined && !(a.expiresInMinutes >= 1 && a.expiresInMinutes <= MAX_WATCH_MINUTES)) {
        throw new Error(`expiresInMinutes must be between 1 and ${String(MAX_WATCH_MINUTES)}.`)
      }
      if (a.maxFires !== undefined && !(Number.isInteger(a.maxFires) && a.maxFires >= 1 && a.maxFires <= 10)) {
        throw new Error('maxFires must be an integer between 1 and 10.')
      }
      const result = await bridge.requestTool('browser_watch', args as Record<string, unknown>, exec.signal, options.toolTimeoutMs, sessionId, ...toolCallIdArg(exec))
      const watched = result as { watchId?: unknown; expiresAt?: unknown }
      if (typeof watched.watchId === 'string' && typeof watched.expiresAt === 'number') {
        await records.add(watched.watchId, { sessionId, expiresAt: watched.expiresAt })
      }
      return { text: textOf(result, 'Watcher created.') }
    },
  })
  const watches = defineTool({
    name: 'browser_watches',
    description: WATCHES_DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: ['list', 'cancel'], description: 'Defaults to list.' },
      id: { type: 'string', description: 'Watcher id to cancel.' },
    },
    timeoutMs: options.toolTimeoutMs,
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionOf(exec)
      const a = args as { action?: 'list' | 'cancel'; id?: string }
      if (a.action === 'cancel' && (a.id === undefined || a.id === '')) throw new Error('cancel needs the watcher id.')
      const result = sessionId === undefined
        ? await bridge.requestTool('browser_watches', args as Record<string, unknown>, exec.signal, options.toolTimeoutMs)
        : await bridge.requestTool('browser_watches', args as Record<string, unknown>, exec.signal, options.toolTimeoutMs, sessionId, ...toolCallIdArg(exec))
      // Only the owning session's cancel drops the record; another session's
      // (or an unknown id) must not orphan a live watcher.
      if (a.action === 'cancel' && a.id !== undefined && sessionId !== undefined && records.get(a.id)?.sessionId === sessionId) {
        await records.remove(a.id)
      }
      return { text: textOf(result, 'No watchers.') }
    },
  })
  return [watch, watches]
}

/** Register the watcher tools. */
export function registerWatchTools(ctx: Context, bridge: Pick<BridgeServer, 'requestTool'>, records: WatchRecordStore, options: WatchToolOptions): () => void {
  const disposers = defineWatchTools(bridge, records, options).map((tool) => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}
