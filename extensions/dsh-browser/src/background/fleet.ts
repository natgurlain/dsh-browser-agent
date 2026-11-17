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
import type { CallPolicyDecision, ForceCause } from '../security/call-policy.ts'
import { approvalBinding } from '../security/payload-binding.ts'
import { analyzeUrl } from '../security/url-risk.ts'
import type { CallPolicyHook, ToolCall } from './tools.ts'
import { cancelledAnswer, fail, notApprovedAnswer, type SettledAnswer } from './answers.ts'

export const MAX_FLEET_TASKS = 8
export const FLEET_GROUP_TITLE = 'DSH fleet'
/** chrome.storage.session key of the live fleets. */
export const FLEETS_STORAGE_KEY = 'dshFleets'
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
  allowActions: boolean
}

/**
 * Where live fleets persist (chrome.storage.session in the extension): a
 * worker restart must keep enforcing the children's allowlists and must still
 * be able to release their tabs.
 */
export interface FleetStore {
  get(): Promise<unknown>
  set(value: unknown): Promise<void>
}

interface StoredFleet {
  fleetId: string
  parentSessionId?: string
  children: string[]
  tabIds: number[]
  allowActions: boolean
}

function isStoredFleet(value: unknown): value is StoredFleet {
  const fleet = value as Partial<StoredFleet> | null
  return typeof fleet === 'object' && fleet !== null && typeof fleet.fleetId === 'string'
    && (fleet.parentSessionId === undefined || typeof fleet.parentSessionId === 'string')
    && Array.isArray(fleet.children) && fleet.children.every((id) => typeof id === 'string')
    && Array.isArray(fleet.tabIds) && fleet.tabIds.every((id) => typeof id === 'number')
    && fleet.children.length === fleet.tabIds.length && typeof fleet.allowActions === 'boolean'
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
  /**
   * The parent's policy hook. Each task URL is judged exactly as a
   * `browser_open_tab` to it would be: a blocked or managed-disallowed URL
   * refuses the whole fleet, and a forced decision (site `ask`, taint) makes
   * the card forced (no unrestricted access or trusted origin skips it).
   * Absent only in tests that do not exercise policy.
   */
  policy?: CallPolicyHook
}

/** Wire answer. */
export type FleetAnswer = SettledAnswer

const failed = fail

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

/** Per-task policy outcome for the fleet card. */
export type FleetPolicy = { kind: 'deny'; message: string } | { kind: 'ok'; forced: string[]; causes?: ForceCause[] }

/** Judge every task URL as a `browser_open_tab` to it (deny wins; force reasons collect per page). */
export function evaluateFleetPolicy(call: Pick<ToolCall, 'id' | 'sessionId'>, request: FleetRequest, policy: CallPolicyHook | undefined): FleetPolicy {
  if (policy === undefined) return { kind: 'ok', forced: [] }
  const forced: string[] = []
  const causes = new Set<ForceCause>()
  for (const [index, task] of request.tasks.entries()) {
    const openCall: ToolCall = { id: call.id, name: 'browser_open_tab', args: { url: task.url, active: false }, ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }) }
    const decision: CallPolicyDecision = policy(openCall, { reads: [], acts: [], destination: task.url })
    if (decision.kind === 'deny') return { kind: 'deny', message: `Page ${String(index + 1)} (${task.url}): ${decision.message}` }
    if (decision.kind === 'force') {
      forced.push(...decision.reasons.map((reason) => `Page ${String(index + 1)}: ${reason}`))
      for (const cause of decision.causes ?? []) causes.add(cause)
    }
  }
  return { kind: 'ok', forced, ...causes.size === 0 ? {} : { causes: [...causes] } }
}

/** The one card for a whole fleet: every URL (decoded, risk-flagged) and its instruction. */
export function fleetApprovalPrompt(request: FleetRequest, forcedReasons: readonly string[] = [], forcedBy: readonly ForceCause[] = []): ApprovalPrompt {
  const origins = [...new Set(request.tasks.map((task) => new URL(task.url).origin))]
  const analyses = request.tasks.map((task) => analyzeUrl(task.url))
  const risky = analyses.some((analysis) => analysis?.risky === true)
  return {
    kind: 'action',
    action: 'browser_fanout',
    summary: `Open ${String(request.tasks.length)} background tab${request.tasks.length === 1 ? '' : 's'} and let one subagent per tab `
      + (request.allowActions ? 'work on it (every page action still asks you)' : 'read it (no clicking or typing)')
      + '. The tabs close when the fleet finishes.',
    origins,
    canTrust: false,
    // A long or high-entropy value in any task URL: trusted origins never skip the card.
    ...risky ? { urlRisk: true as const } : {},
    // Site policy or taint demands a fresh decision: unrestricted access never skips it.
    ...forcedReasons.length > 0 ? { forced: true as const, perCallOnly: true as const, ...forcedBy.length === 0 ? {} : { forcedBy: [...forcedBy] } } : {},
    details: [
      ...forcedReasons.length > 0 ? [{ kind: 'text' as const, label: 'Why this needs your approval', masked: false, value: forcedReasons.join('\n') }] : [],
      ...request.tasks.flatMap((task, index): ApprovalDetail[] => {
      const analysis = analyses[index]
      return [
        analysis === undefined ? { kind: 'text', label: `Page ${String(index + 1)}`, masked: false, value: task.url } : { kind: 'url', url: analysis },
        { kind: 'text', label: `Task ${String(index + 1)}`, masked: false, value: task.instruction },
      ]
    }),
    ],
    binding: approvalBinding({ action: 'browser_fanout', args: { tasks: request.tasks, allowActions: request.allowActions }, origins }),
  }
}

/** Live fleets (persisted through {@link FleetStore} when one is given). */
export class FleetRegistry {
  private readonly children = new Map<string, FleetChild>()
  private readonly fleets = new Map<string, Fleet>()
  readonly ready: Promise<void>

  constructor(private readonly store?: FleetStore) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    if (this.store === undefined) return
    let stored: unknown
    try {
      stored = await this.store.get()
    } catch {
      return
    }
    if (!Array.isArray(stored)) return
    for (const entry of stored) {
      if (!isStoredFleet(entry) || this.fleets.has(entry.fleetId)) continue
      const fleet: Fleet = { parentSessionId: entry.parentSessionId, children: [...entry.children], tabIds: [...entry.tabIds], allowActions: entry.allowActions }
      this.fleets.set(entry.fleetId, fleet)
      for (const [index, childId] of fleet.children.entries()) {
        this.children.set(childId, { fleetId: entry.fleetId, parentSessionId: fleet.parentSessionId, tabId: fleet.tabIds[index]!, allowActions: fleet.allowActions })
      }
    }
  }

  private async save(): Promise<void> {
    if (this.store === undefined) return
    const value: StoredFleet[] = [...this.fleets].map(([fleetId, fleet]) => ({
      fleetId,
      ...fleet.parentSessionId === undefined ? {} : { parentSessionId: fleet.parentSessionId },
      children: fleet.children,
      tabIds: fleet.tabIds,
      allowActions: fleet.allowActions,
    }))
    await this.store.set(value).catch(() => undefined)
  }

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
    await this.ready
    if (this.isChild(call.sessionId)) return failed('A fleet worker cannot start another fleet.')
    const request = parseFleetRequest(call.args)
    if (typeof request === 'string') return failed(request, 'bad-args')
    if (request.children.some((id) => this.children.has(id) || id === call.sessionId)) return failed('A fleet child session is already in use.', 'bad-args')
    const policy = evaluateFleetPolicy(call, request, deps.policy)
    if (policy.kind === 'deny') return failed(policy.message)
    const windowId = await deps.parentWindow(call.sessionId)
    const prompt = fleetApprovalPrompt(request, policy.forced, policy.causes)
    const authorization = await deps.authorize(prompt, windowId ?? 0)
    if (deps.signal.aborted) return cancelledAnswer()
    if (authorization !== 'approved') return notApprovedAnswer('The user declined the tab fleet.', 'The tab fleet', authorization)
    const fleetId = `fleet-${(deps.newId ?? (() => crypto.randomUUID()))().slice(0, 8)}`
    const fleet: Fleet = { parentSessionId: call.sessionId, children: [], tabIds: [], allowActions: request.allowActions }
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
        // Persisted before the binding: a restart in between still knows the child.
        await this.save()
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
    await this.save()
    if (closeTabs) {
      for (const tabId of fleet.tabIds) await deps.closeTab(tabId).catch(() => {})
    }
    return { ok: true, result: { text: closeTabs ? `Closed ${String(fleet.tabIds.length)} fleet tabs.` : 'Released the fleet; its tabs stay open.' } }
  }

  /** Release from the bridge: only the fleet's parent session may release it. */
  async releaseCall(call: ToolCall, deps: Pick<FleetDeps, 'unbindChild' | 'closeTab'>): Promise<FleetAnswer> {
    await this.ready
    const fleetId = call.args.fleetId
    if (typeof fleetId !== 'string') return failed('fleetId is required.', 'bad-args')
    if (this.fleets.get(fleetId)?.parentSessionId !== call.sessionId) return failed('No such fleet for this session.', 'bad-args')
    return this.release(fleetId, call.args.closeTabs !== false, deps)
  }

  /** Kill switch: unbind every fleet's children; their tabs stay open for the user. */
  async releaseAll(deps: Pick<FleetDeps, 'unbindChild' | 'closeTab'>): Promise<void> {
    await this.ready
    for (const fleetId of [...this.fleets.keys()]) await this.release(fleetId, false, deps)
  }

  /** Fleets alive. */
  get size(): number {
    return this.fleets.size
  }
}

/** The extension's tab operations for a fleet; session binding is the caller's. */
export function chromeFleetDeps(
  signal: AbortSignal,
  authorize: FleetDeps['authorize'],
  hooks: {
    /** The window of the session's tab, if it has one. */
    sessionWindow: (sessionId: string | undefined) => Promise<number | undefined>
    bindChild: FleetDeps['bindChild']
    unbindChild: FleetDeps['unbindChild']
  },
): FleetDeps {
  return {
    signal,
    authorize,
    parentWindow: async (sessionId) => (await hooks.sessionWindow(sessionId)) ?? (await chrome.windows.getLastFocused().catch(() => undefined))?.id,
    createTab: (url, windowId) => chrome.tabs.create({ url, active: false, ...(windowId === undefined ? {} : { windowId }) }),
    groupTabs: async (tabIds, windowId) => {
      if (typeof chrome.tabs.group !== 'function' || tabIds.length === 0) return false
      const granted = await chrome.permissions.contains({ permissions: ['tabGroups'] }).catch(() => false)
      if (!granted || chrome.tabGroups === undefined) return false
      const groupId = await chrome.tabs.group({ tabIds, ...(windowId === undefined ? {} : { createProperties: { windowId } }) })
      await chrome.tabGroups.update(groupId, { title: FLEET_GROUP_TITLE, color: 'blue', collapsed: false })
      return true
    },
    bindChild: hooks.bindChild,
    unbindChild: hooks.unbindChild,
    closeTab: (tabId) => chrome.tabs.remove(tabId),
  }
}
