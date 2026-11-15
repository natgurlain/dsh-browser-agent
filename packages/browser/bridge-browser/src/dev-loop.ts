/**
 * Closed dev loop for coding sessions (Phase 3.5).
 *
 * Opt-in per session from the panel: the user links a localhost tab to one
 * of their DSH coding sessions (a Desktop/CLI session, not a bridge browser
 * session). After each turn of that session that edited files, the bridge
 * asks the extension (reserved `browser_devloop_capture` action, same
 * `tool.call` path as every browser action: pause gate, site policy, taint,
 * kill switch, approval settings, audit log) for the tab's new console errors,
 * failed network requests and a DOM delta, and injects the answer into the
 * session as read-only browser context (inside the untrusted boundary). The
 * injection never wakes the agent and is never a prompt: the session still
 * cannot be prompted, steered or changed from the browser (bridge-policy.ts).
 *
 * Origins: loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) by default;
 * `devLoop.allowedOrigins` adds exact origins.
 *
 * Taint decision: an injection from a loopback origin does NOT taint the
 * coding session on the Host (that would make its edit tools read-only and
 * defeat the loop); the user's own dev server is the source, the payload is
 * limited to errors/requests/DOM changes, and it is fenced as untrusted text.
 * An injection from a non-loopback origin the operator allowed DOES taint the
 * session like any other web content. Caveat: a local dev server that renders
 * untrusted data (user content, scraped or proxied pages) can put that text
 * into the coding session; `devLoop.trustLoopback: false` taints loopback
 * injections too.
 *
 * Links live in memory: a Host restart forgets them (the extension re-asserts
 * its links when the panel opens).
 *
 * @module
 */

import { basename } from 'node:path'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'
import {
  BRIDGE_DEVLOOP_CANDIDATES_METHOD,
  BRIDGE_DEVLOOP_LINK_METHOD,
  BRIDGE_DEVLOOP_UNLINK_METHOD,
  DEVLOOP_CAPTURE_TOOL,
  devLoopOrigin,
  isLoopbackDevOrigin,
} from './protocol.ts'

/** Tools whose successful result means the turn edited files. */
export const DEFAULT_DEVLOOP_EDIT_TOOLS: readonly string[] = ['edit', 'write', 'apply_patch', 'str_replace_editor', 'notebook_edit']

/**
 * Budget for one capture: long enough for the extension's read-approval card
 * (60 s with the panel open) to be answered before the call is withdrawn.
 */
export const DEVLOOP_CAPTURE_TIMEOUT_MS = 90_000

/** One listed coding session the panel may link to. */
export interface DevLoopCandidate {
  sessionId: string
  title?: string
  /** Last path segment of the session's directory (the project name). */
  project?: string
  running?: boolean
}

/** One recorded link. */
export interface DevLoopLink {
  sessionId: string
  origin: string
  linkedAt: string
}

/** What the dev loop needs from the plugin. */
export interface DevLoopDeps {
  /** List Host sessions (the unfenced `session.list`). */
  listSessions(signal: AbortSignal): Promise<unknown>
  /** Sessions the bridge owns (browser sessions) or minted (external): never linkable. */
  isBridgeSession(sessionId: string): boolean
  /** Ask the extension for one capture; resolves its `{ text }` result. */
  capture(sessionId: string, origin: string, signal: AbortSignal): Promise<unknown>
  /** Inject read-only context into a live session (never wakes it). */
  inject(sessionId: string, text: string): 'injected' | 'queued' | 'dropped'
  /** Mark a session tainted (non-loopback origins only). */
  taint(sessionId: string): void
  /** Exact non-loopback origins the operator allowed. */
  extraOrigins?: readonly string[]
  /** Loopback injections do not taint the coding session (default true; `devLoop.trustLoopback`). */
  trustLoopback?: boolean
  /** Tools that count as file edits. */
  editTools?: readonly string[]
  log?: (message: string) => void
}

/** The dev-loop state machine: links, per-turn edit tracking, capture and injection. */
export class DevLoop {
  private readonly links = new Map<string, DevLoopLink>()
  private readonly edited = new Set<string>()
  private readonly inflight = new Map<string, AbortController>()
  private readonly editTools: ReadonlySet<string>

  constructor(private readonly deps: DevLoopDeps) {
    this.editTools = new Set(deps.editTools ?? DEFAULT_DEVLOOP_EDIT_TOOLS)
  }

  /** Listable, non-subagent coding sessions the bridge does not own. */
  async candidates(signal: AbortSignal): Promise<DevLoopCandidate[]> {
    const listed = await this.deps.listSessions(signal)
    const items = isRecord(listed) && Array.isArray(listed.items) ? listed.items : []
    const candidates: DevLoopCandidate[] = []
    for (const item of items) {
      if (!isRecord(item) || typeof item.sessionId !== 'string' || item.origin === 'subagent') continue
      if (this.deps.isBridgeSession(item.sessionId)) continue
      candidates.push({
        sessionId: item.sessionId,
        ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title.slice(0, 120) } : {}),
        ...(typeof item.cwd === 'string' && item.cwd !== '' ? { project: basename(item.cwd) } : {}),
        ...(typeof item.running === 'boolean' ? { running: item.running } : {}),
      })
    }
    return candidates
  }

  /** Record a link made in the panel. */
  async link(sessionId: string, url: string, signal: AbortSignal): Promise<DevLoopLink> {
    const origin = devLoopOrigin(url, this.deps.extraOrigins)
    if (origin === undefined) {
      throw new DevLoopError('bad-request', 'Only localhost, 127.0.0.1 and [::1] pages can be linked to a coding session'
        + (this.deps.extraOrigins?.length ? ' (or an origin listed in devLoop.allowedOrigins)' : '') + '.')
    }
    if (this.deps.isBridgeSession(sessionId)) {
      throw new DevLoopError('forbidden', 'Browser sessions cannot be linked; pick a DSH coding session.')
    }
    if (!(await this.candidates(signal)).some(candidate => candidate.sessionId === sessionId)) {
      throw new DevLoopError('forbidden', `session ${JSON.stringify(sessionId)} is not a DSH coding session this browser can link`)
    }
    const link: DevLoopLink = { sessionId, origin, linkedAt: new Date().toISOString() }
    this.links.set(sessionId, link)
    return link
  }

  /** Forget a link (and stop its in-flight capture). */
  unlink(sessionId: string): boolean {
    this.inflight.get(sessionId)?.abort()
    this.edited.delete(sessionId)
    return this.links.delete(sessionId)
  }

  /** The current links (tests and diagnostics). */
  list(): DevLoopLink[] {
    return [...this.links.values()]
  }

  /** `tools/result`: a successful edit marks the linked session's turn. */
  noteToolResult(sessionId: string | undefined, toolName: string, isError: boolean): void {
    if (sessionId === undefined || isError || !this.links.has(sessionId) || !this.editTools.has(toolName)) return
    this.edited.add(sessionId)
  }

  /** `agent/status`: a linked session that edited files went idle: capture and inject. */
  noteStatus(sessionId: string, status: string): Promise<void> | undefined {
    if (status !== 'idle' || !this.edited.has(sessionId)) return undefined
    this.edited.delete(sessionId)
    const link = this.links.get(sessionId)
    if (link === undefined) return undefined
    return this.captureAndInject(link)
  }

  private async captureAndInject(link: DevLoopLink): Promise<void> {
    this.inflight.get(link.sessionId)?.abort()
    const controller = new AbortController()
    this.inflight.set(link.sessionId, controller)
    const timer = setTimeout(() => { controller.abort() }, DEVLOOP_CAPTURE_TIMEOUT_MS)
    try {
      const result = await this.deps.capture(link.sessionId, link.origin, controller.signal)
      const text = isRecord(result) && typeof result.text === 'string' ? result.text : undefined
      if (text === undefined || text.trim() === '' || this.links.get(link.sessionId) !== link) return
      this.deps.inject(link.sessionId, text)
      // Loopback: the user's own dev server, trusted unless `trustLoopback` is
      // off; see the module note on taint.
      if (!isLoopbackDevOrigin(link.origin) || this.deps.trustLoopback === false) this.deps.taint(link.sessionId)
    } catch (error: unknown) {
      this.deps.log?.(`browser bridge: dev loop capture for ${link.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      if (this.inflight.get(link.sessionId) === controller) this.inflight.delete(link.sessionId)
    }
  }
}

/** A refusal the RPC layer maps to an error envelope. */
export class DevLoopError extends Error {
  constructor(readonly code: 'bad-request' | 'forbidden', message: string) {
    super(message)
    this.name = 'DevLoopError'
  }
}

/**
 * Serve the dev-loop RPCs on the extension connection, in front of the
 * fenced Host API (which never sees them).
 */
export function withDevLoopMethods(api: BrowserHostApi, devLoop: DevLoop): BrowserHostApi {
  const failure = (code: string, message: string): HostRpcResult => ({ ok: false, error: { code, message, details: {} } })
  const answer = async (call: HostRpcCall): Promise<HostRpcResult> => {
    const payload = isRecord(call.payload) ? call.payload : {}
    try {
      switch (call.method) {
        case BRIDGE_DEVLOOP_CANDIDATES_METHOD:
          return { ok: true, value: { items: await devLoop.candidates(call.signal) } }
        case BRIDGE_DEVLOOP_LINK_METHOD: {
          if (typeof payload.sessionId !== 'string' || payload.sessionId === '' || typeof payload.url !== 'string') {
            return failure('bad-request', 'sessionId and url are required')
          }
          return { ok: true, value: { link: await devLoop.link(payload.sessionId, payload.url, call.signal) } }
        }
        default: {
          if (typeof payload.sessionId !== 'string' || payload.sessionId === '') return failure('bad-request', 'sessionId is required')
          return { ok: true, value: { unlinked: devLoop.unlink(payload.sessionId) } }
        }
      }
    } catch (error: unknown) {
      if (error instanceof DevLoopError) return failure(error.code, error.message)
      return failure('internal', error instanceof Error ? error.message : String(error))
    }
  }
  return {
    call: (call) => call.method === BRIDGE_DEVLOOP_CANDIDATES_METHOD || call.method === BRIDGE_DEVLOOP_LINK_METHOD
      || call.method === BRIDGE_DEVLOOP_UNLINK_METHOD
      ? answer(call)
      : api.call(call),
    events: (signal) => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}

/** The reserved capture action name (re-exported for the plugin). */
export { DEVLOOP_CAPTURE_TOOL }
