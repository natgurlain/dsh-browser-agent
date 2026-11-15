/**
 * Tab fleets (`browser_fanout`) on the extension side.
 *
 * The bridge asks once (`browser_fanout`) with every task's URL and
 * instruction plus the child session ids it reserved. One card names them
 * all; once approved, each URL opens in a background tab of the parent's
 * window, the tabs are grouped as "DSH fleet" when tab groups are available,
 * and each tab is bound to its child session only (the parent's and the
 * user's controlled tab do not move).
 *
 * While the fleet lives the extension enforces each child's tool allowlist
 * itself (read tools only unless the parent passed `allowActions`; never tab
 * management, programs, watchers, or developer tools), and shows every card a
 * child raises under its parent's session so the user sees it in the panel.
 * Actions a child may take still pass every normal gate and card.
 *
 * `browser_fleet_release` (sent by the bridge when the fleet ends, never a
 * model tool) unbinds the children and closes their tabs unless asked not to.
 *
 * @module
 */

import type { ApprovalAuthorization, ApprovalDetail, ApprovalPrompt } from '../security/approval.ts'
import { approvalBinding } from '../security/payload-binding.ts'
import { analyzeUrl } from '../security/url-risk.ts'
import type { ToolCall } from './tools.ts'

export const MAX_FLEET_TASKS = 8
export const FLEET_GROUP_TITLE = 'DSH fleet'
/** Mirrors the bridge's FLEET_READ_TOOLS / FLEET_ACTION_TOOLS (a spec keeps them equal). */
export const FLEET_READ_TOOLS: ReadonlySet<string> = new Set(['browser_snapshot', 'browser_get_text', 'browser_wait', 'browser_pdf_text'])
export const FLEET_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'browser_click', 'browser_type', 'browser_press', 'browser_select', 'browser_hover', 'browser_scroll',
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_dialog',
])

interface FleetChild {
  fleetId: string
  parentSessionId: string | undefined
  tabId: number
  allowActions: boolean
}

interface Fleet {
  parentSessionId: string | undefined
  children: string[]
  tabIds: number[]
}

/** A tab the fleet opened. */
export interface FleetTab {
  id?: number
  url?: string
  title?: string
  windowId?: number
}

/** Browser operations the fleet needs (injected for tests). */
export interface FleetDeps {
  /** Parent's window, for the card and the new tabs. */
  parentWindow: (sessionId: string | undefined) => Promise<number | undefined>
  authorize: (prompt: ApprovalPrompt, windowId: number) => Promise<ApprovalAuthorization>
  createTab: (url: string, windowId: number | undefined) => Promise<FleetTab>
  /** Group the tabs and title the group; resolves false when tab groups are unavailable. */
  groupTabs: (tabIds: number[], windowId: number | undefined) => Promise<boolean>
  bindChild: (childId: string, tab: FleetTab) => void
  unbindChild: (childId: string, tabId: number) => void
  closeTab: (tabId: number) => Promise<void>
  signal: AbortSignal
  newId?: () => string
}

/** Wire answer (structurally a ToolAnswer). */
export type FleetAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: 'bad-args' | 'action-failed' | 'timeout'; message: string } }

function failed(message: string, code: 'bad-args' | 'action-failed' = 'action-failed'): FleetAnswer {
  return { ok: false, error: { code, message } }
}

/** Parsed `browser_fanout` wire arguments. */
export interface FleetRequest {
  tasks: { url: string; instruction: string }[]
  children: string[]
  allowActions: boolean
}

/** Validate the bridge's request. */
export function parseFleetRequest(args: Record<string, unknown>): FleetRequest | string {
  const { tasks, children } = args
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_FLEET_TASKS) return `A fleet needs 1-${String(MAX_FLEET_TASKS)} tasks.`
  if (!Array.isArray(children) || children.length !== tasks.length || !children.every((id) => typeof id === 'string' && id !== '')) {
    return 'The fleet request has no child session for every task.'
  }
  if (new Set(children).size !== children.length) return 'Fleet child sessions must be distinct.'
  const parsed: { url: string; instruction: string }[] = []
  for (const task of tasks) {
    const t = task as { url?: unknown; instruction?: unknown }
    if (typeof t.url !== 'string' || typeof t.instruction !== 'string') return 'Every task needs a url and an instruction.'
    try {
      const url = new URL(t.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Fleet tasks open http and https pages only.'
    } catch {
      return 'Every task needs a complete URL.'
    }
    parsed.push({ url: t.url, instruction: t.instruction })
  }
  return { tasks: parsed, children: children as string[], allowActions: args.allowActions === true }
}

/** The one card for a whole fleet: every URL (decoded, risk-flagged) and its instruction. */
export function fleetApprovalPrompt(request: FleetRequest): ApprovalPrompt {
  const origins = [...new Set(request.tasks.map((task) => new URL(task.url).origin))]
  return {
    kind: 'action',
    action: 'browser_fanout',
    summary: `Open ${String(request.tasks.length)} background tab${request.tasks.length === 1 ? '' : 's'} and let one subagent per tab `
      + (request.allowActions ? 'work on it (every page action still asks you)' : 'read it (no clicking or typing)')
      + '. The tabs close when the fleet finishes.',
    origins,
    canTrust: false,
    details: request.tasks.flatMap((task, index): ApprovalDetail[] => {
      const analysis = analyzeUrl(task.url)
      return [
        analysis === undefined ? { kind: 'text', label: `Page ${String(index + 1)}`, masked: false, value: task.url } : { kind: 'url', url: analysis },
        { kind: 'text', label: `Task ${String(index + 1)}`, masked: false, value: task.instruction },
      ]
    }),
    binding: approvalBinding({ action: 'browser_fanout', args: { tasks: request.tasks, allowActions: request.allowActions }, origins }),
  }
}

/** Live fleets of this worker. */
export class FleetRegistry {
  private readonly children = new Map<string, FleetChild>()
  private readonly fleets = new Map<string, Fleet>()

  /** Whether a call from a fleet child names a tool outside its allowlist (the refusal message), else undefined. */
  refusal(call: Pick<ToolCall, 'name' | 'sessionId'>): string | undefined {
    if (call.sessionId === undefined) return undefined
    const child = this.children.get(call.sessionId)
    if (child === undefined) return undefined
    if (FLEET_READ_TOOLS.has(call.name) || (child.allowActions && FLEET_ACTION_TOOLS.has(call.name))) return undefined
    return child.allowActions
      ? `Fleet workers cannot use ${call.name}: only reads and page actions on their own tab.`
      : `Fleet workers are read-only: ${call.name} is not allowed (only ${[...FLEET_READ_TOOLS].join(', ')}).`
  }

  /** The session whose panel shows a child's cards: its parent's. */
  approvalSession(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined
    const child = this.children.get(sessionId)
    return child === undefined ? sessionId : child.parentSessionId
  }

  isChild(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.children.has(sessionId)
  }

  /** `browser_fanout`: approve the fleet, then open, group, and bind its tabs. */
  async open(call: ToolCall, deps: FleetDeps): Promise<FleetAnswer> {
    if (this.isChild(call.sessionId)) return failed('A fleet worker cannot start another fleet.')
    const request = parseFleetRequest(call.args)
    if (typeof request === 'string') return failed(request, 'bad-args')
    if (request.children.some((id) => this.children.has(id) || id === call.sessionId)) return failed('A fleet child session is already in use.', 'bad-args')
    const windowId = await deps.parentWindow(call.sessionId)
    const prompt = fleetApprovalPrompt(request)
    const authorization = await deps.authorize(prompt, windowId ?? 0)
    if (deps.signal.aborted) return failed('Tool call was cancelled')
    if (authorization !== 'approved') {
      return { ok: false, error: { code: authorization === 'timed-out' ? 'timeout' : 'action-failed', message: authorization === 'denied' ? 'The user declined the tab fleet.' : `The tab fleet was not approved (${authorization}).` } }
    }
    const fleetId = `fleet-${(deps.newId ?? (() => crypto.randomUUID()))().slice(0, 8)}`
    const fleet: Fleet = { parentSessionId: call.sessionId, children: [], tabIds: [] }
    this.fleets.set(fleetId, fleet)
    const tabs: { childId: string; tabId: number; url: string }[] = []
    try {
      for (const [index, task] of request.tasks.entries()) {
        if (deps.signal.aborted) throw new Error('cancelled')
        const tab = await deps.createTab(task.url, windowId)
        if (tab.id === undefined) throw new Error('the browser did not open a tab')
        const childId = request.children[index]!
        fleet.tabIds.push(tab.id)
        fleet.children.push(childId)
        this.children.set(childId, { fleetId, parentSessionId: call.sessionId, tabId: tab.id, allowActions: request.allowActions })
        deps.bindChild(childId, tab)
        tabs.push({ childId, tabId: tab.id, url: task.url })
      }
    } catch (error: unknown) {
      await this.release(fleetId, true, deps)
      return failed(`The fleet could not open its tabs: ${error instanceof Error ? error.message : String(error)}`)
    }
    const grouped = await deps.groupTabs(fleet.tabIds, windowId).catch(() => false)
    return {
      ok: true,
      result: {
        text: `Opened ${String(tabs.length)} fleet tab${tabs.length === 1 ? '' : 's'}${grouped ? ` in the "${FLEET_GROUP_TITLE}" group` : ''}.`,
        fleetId,
        tabs,
        grouped,
      },
    }
  }

  /** `browser_fleet_release`: unbind the children, close their tabs unless told not to. */
  async release(fleetId: string, closeTabs: boolean, deps: Pick<FleetDeps, 'unbindChild' | 'closeTab'>): Promise<FleetAnswer> {
    const fleet = this.fleets.get(fleetId)
    if (fleet === undefined) return failed('No such fleet.', 'bad-args')
    this.fleets.delete(fleetId)
    for (const [index, childId] of fleet.children.entries()) {
      this.children.delete(childId)
      deps.unbindChild(childId, fleet.tabIds[index]!)
    }
    if (closeTabs) {
      for (const tabId of fleet.tabIds) await deps.closeTab(tabId).catch(() => {})
    }
    return { ok: true, result: { text: closeTabs ? `Closed ${String(fleet.tabIds.length)} fleet tabs.` : 'Released the fleet; its tabs stay open.' } }
  }

  /** Release from the bridge: only the fleet's parent session may release it. */
  async releaseCall(call: ToolCall, deps: Pick<FleetDeps, 'unbindChild' | 'closeTab'>): Promise<FleetAnswer> {
    const fleetId = call.args.fleetId
    if (typeof fleetId !== 'string') return failed('fleetId is required.', 'bad-args')
    if (this.fleets.get(fleetId)?.parentSessionId !== call.sessionId) return failed('No such fleet for this session.', 'bad-args')
    return this.release(fleetId, call.args.closeTabs !== false, deps)
  }

  /** Fleets alive (tests and the kill switch). */
  get size(): number {
    return this.fleets.size
  }
}
