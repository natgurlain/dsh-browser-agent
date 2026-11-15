/**
 * Phase 3 learning features, extension side. All default OFF behind
 * `dshLearningSettings`; with a feature off this module records nothing.
 *
 * - Workflows (3.8): records successful agent steps with a robust locator per
 *   element, for "Save as workflow"; values typed into sensitive fields are
 *   dropped on the spot. Saving, replay and scheduling happen on the bridge.
 * - Site drivers (3.6): for origins the user enabled, learns a proposal from
 *   the same-origin XHR/fetch request behind an agent action (developer-tools
 *   network capture), shows it to the user, stores approved drivers, and runs
 *   them with a forced, per-call approval card showing the exact request.
 * - Watch me (3.7): records the user's own trusted input on the current tab,
 *   detects a repetition over rows and offers "Do the remaining N like this":
 *   one card approves the whole program, which then runs step by step through
 *   the bridge; each step is pre-approved only for its exact tool + args, once.
 * - Failure flywheel (3.9): a failed step leaves a local fixture (MHTML when
 *   the page has no sensitive field and the optional permission is granted,
 *   else a sanitized DOM) in the session workspace via the bridge.
 *
 * Probes into the page run only from inside the dispatch path: after the
 * pause gate released the call and after site policy did not block it.
 *
 * @module
 */

import { describeDriverRequest, buildDriverRequest, parseSiteDriverImport, proposeSiteDriver, validateSiteDriver, type SiteDriver, type SiteDriverProposal, type TypedValue } from '@natgurlain/dsh-bridge-browser/src/learning/site-drivers.ts'
import { REPLAYABLE_TOOLS, ELEMENT_TOOLS } from '@natgurlain/dsh-bridge-browser/src/learning/workflow.ts'
import { getUiLocale } from '../i18n.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import type { CallPolicyDecision, CallPolicyTargets } from '../security/call-policy.ts'
import { approvalBinding, canonicalJson } from '../security/payload-binding.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { buildWorkflow, type RecordedLocator, type RecordedStep, type WorkflowChoices } from '../shared/workflow-build.ts'
import { buildProgram, detectRepetition, nextSelectors, type ProgramStep, type RepetitionPattern, type WatchEvent } from '../shared/repetition.ts'
import type { NetworkEntry } from './devtools-network.ts'
import { listTabFrames } from './frames.ts'
import { isExtensionPageSender } from './policy-runtime.ts'
import type { CallPolicyHook, ToolAnswer, ToolCall } from './tools.ts'

/** Storage key of the learning switches. */
export const LEARNING_SETTINGS_KEY = 'dshLearningSettings'
/** Storage key of saved site drivers. */
export const SITE_DRIVERS_KEY = 'dshSiteDrivers'
/** Storage flag: a workflows turn-off the bridge has not acknowledged yet. */
export const WORKFLOWS_OFF_PENDING_KEY = 'dshWorkflowsOffPending'

/** Panel port name. */
export const LEARNING_PORT_NAME = 'dsh-learning'

/** The learning switches (all default off). */
export interface LearningSettings {
  /** Record runs for "Save as workflow"; enables workflow replay and schedules. */
  workflows: boolean
  /** Learn and run site drivers (experimental). */
  siteDrivers: boolean
  /** Origins site-driver learning is enabled for. */
  siteDriverOrigins: string[]
  /** Offer the "Watch me" toggle (experimental). */
  watchMe: boolean
  /** Save failure fixtures into the session workspace. */
  fixtures: boolean
}

export const LEARNING_DEFAULTS: LearningSettings = { workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false }

/** Bridge methods (mirrors the bridge's LEARNING_METHODS). */
const METHODS = {
  state: 'bridge.learning.state',
  saveWorkflow: 'bridge.learning.workflow.save',
  listWorkflows: 'bridge.learning.workflow.list',
  scheduleCreate: 'bridge.learning.schedule.create',
  scheduleList: 'bridge.learning.schedule.list',
  scheduleCancel: 'bridge.learning.schedule.cancel',
  programRun: 'bridge.learning.program.run',
  saveFixture: 'bridge.learning.fixture.save',
} as const

const MAX_RECORDED_STEPS = 100
const MAX_WATCH_EVENTS = 60
const MAX_PROPOSALS = 10
const AGENT_QUIET_MS = 1_500
const NO_SESSION = '(no-session)'
const PROGRAM_RUN_TIMEOUT_MS = 30 * 60_000
/** One `browser_run` holds at most this many steps. */
const MAX_PROGRAM_STEPS = 25

/** What the background index provides. */
export interface LearningDeps {
  rpc: () => { request(method: string, payload: unknown, timeoutMs?: number): Promise<unknown> } | null
  bridgeConnected: () => boolean
  /** Whether an agent tool call is (or just was) running on this tab. */
  agentActiveOnTab: (tabId: number) => boolean
  /** Kill switch engaged or agent paused: never capture then. */
  halted: () => boolean
  /**
   * Whether a failure fixture may capture this page: page sharing is not off
   * and site policy does not block reads of it.
   */
  fixtureAllowed: (sessionId: string | undefined, url: string) => boolean
  /** Developer-tools network capture for a tab, when attached. */
  capturedRequests: (tabId: number) => readonly NetworkEntry[] | undefined
  /** Whether this browser can run site drivers (Chrome debugger + page-origin fetch). */
  siteDriversSupported: boolean
  /** Window of the panel/active tab for cards raised by the panel. */
  activeTab: () => Promise<chrome.tabs.Tab | undefined>
  /** Storage area (tests). */
  storage?: chrome.storage.StorageArea
  now?: () => number
}

interface PendingProbe {
  locator?: Promise<LocatorProbe | undefined>
  networkMark?: number
  tabId: number
  url?: string
  windowId?: number
}

interface LocatorProbe extends RecordedLocator {
  sensitive?: boolean
  password?: boolean
}


/** A "do the remaining N" offer shown in the panel. */
export interface WatchSuggestion {
  tabId: number
  origin: string
  period: number
  done: number
  remaining: number
  program: ProgramStep[]
  labels: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

function zh(): boolean {
  return getUiLocale() === 'zh'
}

/** Normalize stored learning settings. */
export function normalizeLearningSettings(value: unknown): LearningSettings {
  const raw = isRecord(value) ? value : {}
  const origins = Array.isArray(raw.siteDriverOrigins)
    ? [...new Set(raw.siteDriverOrigins.map((entry) => originOf(typeof entry === 'string' ? entry : undefined)).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  return {
    workflows: raw.workflows === true,
    siteDrivers: raw.siteDrivers === true,
    siteDriverOrigins: origins,
    watchMe: raw.watchMe === true,
    fixtures: raw.fixtures === true,
  }
}

/** Unwrap a bridge RPC answer (`{ type: 'server-response', result: { ok, value } }`). */
export function rpcValue(answer: unknown): unknown {
  if (isRecord(answer) && answer.type === 'server-response' && isRecord(answer.result)) return answer.result.value
  return answer
}

/**
 * Classify a failed step for the flywheel; undefined means "do not capture".
 * A step the user denied or let time out is never captured: the user said no
 * to that page action, so its page must not be saved either.
 */
export function classifyFailure(answer: ToolAnswer, decision: string | undefined, policy: string | undefined, retried: boolean): 'not-found' | 'guard' | 'retried' | 'error' | undefined {
  if (answer.ok) return undefined
  if (policy === 'blocked' || decision === 'held-expired') return undefined
  const message = answer.error?.message ?? ''
  if (/cancelled|kill switch|stopped/iu.test(message)) return undefined
  if (decision === 'denied' || decision === 'timed-out' || answer.error?.code === 'timeout' || /denied|declined|not approved|timed out/iu.test(message)) return undefined
  if (retried) return 'retried'
  if (/does not exist|no element matched|not found|no .*matching/iu.test(message)) return 'not-found'
  if (/covered by|changed|guard|strict mode|refused/iu.test(message)) return 'guard'
  return 'error'
}

/**
 * Whether a failure fixture may capture this page: page sharing is `auto`
 * (reads need no card) and the policy decision for reading it is neither
 * `deny` nor `force`.
 */
export function fixtureAllowedFor(sharePageContent: 'ask' | 'auto' | 'off', decide: (origin: string) => 'deny' | 'force' | 'trust' | 'default', url: string | undefined): boolean {
  if (sharePageContent !== 'auto') return false
  const origin = originOf(url)
  if (origin === undefined) return false
  const kind = decide(origin)
  return kind !== 'deny' && kind !== 'force'
}

/**
 * The extension half of the learning features.
 */
export class LearningRuntime {
  settings: LearningSettings = { ...LEARNING_DEFAULTS }
  private drivers: SiteDriver[] = []
  private readonly recorded = new Map<string, RecordedStep[]>()
  private readonly probes = new Map<string, PendingProbe>()
  private readonly proposals: SiteDriverProposal[] = []
  private readonly recentFailures = new Map<string, number>()
  private readonly ports = new Set<chrome.runtime.Port>()
  private watch: { tabId: number; origin: string; events: WatchEvent[] } | undefined
  /** The user turned saved workflows off and the bridge has not acknowledged it yet. */
  private workflowsTurnedOff = false
  private suggestion: WatchSuggestion | undefined
  private lastAgentActivity = new Map<number, number>()
  readonly ready: Promise<void>
  private readonly storage: chrome.storage.StorageArea
  private readonly now: () => number

  constructor(private readonly deps: LearningDeps) {
    this.storage = deps.storage ?? chrome.storage.local
    this.now = deps.now ?? Date.now
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    const stored = await this.storage.get([LEARNING_SETTINGS_KEY, SITE_DRIVERS_KEY, WORKFLOWS_OFF_PENDING_KEY])
    this.settings = normalizeLearningSettings(stored[LEARNING_SETTINGS_KEY])
    this.workflowsTurnedOff = stored[WORKFLOWS_OFF_PENDING_KEY] === true
    const drivers = Array.isArray(stored[SITE_DRIVERS_KEY]) ? stored[SITE_DRIVERS_KEY] as unknown[] : []
    this.drivers = drivers.flatMap((raw) => {
      try {
        return [validateSiteDriver(raw)]
      } catch {
        return []
      }
    })
  }

  // ---- settings ----

  async updateSettings(next: Partial<LearningSettings>): Promise<LearningSettings> {
    await this.ready
    const updated = normalizeLearningSettings({ ...this.settings, ...next })
    // The user turning saved workflows off is the event that ends this
    // install's schedules on the Host; kept until the bridge has heard it.
    if (this.settings.workflows && !updated.workflows) {
      this.workflowsTurnedOff = true
      await this.storage.set({ [WORKFLOWS_OFF_PENDING_KEY]: true })
    } else if (updated.workflows && this.workflowsTurnedOff) {
      this.workflowsTurnedOff = false
      await this.storage.set({ [WORKFLOWS_OFF_PENDING_KEY]: false })
    }
    if (!updated.workflows) this.recorded.clear()
    if (!updated.siteDrivers) this.proposals.splice(0)
    if (!updated.watchMe) await this.stopWatching()
    this.settings = updated
    await this.storage.set({ [LEARNING_SETTINGS_KEY]: updated })
    await this.pushBridgeState()
    this.broadcast()
    return updated
  }

  /** Tell the bridge which features are on (and which drivers exist). */
  async pushBridgeState(): Promise<void> {
    const rpc = this.deps.rpc()
    if (rpc === null || !this.deps.bridgeConnected()) return
    const drivers = this.settings.siteDrivers && this.deps.siteDriversSupported ? this.drivers : []
    const turnedOff = this.workflowsTurnedOff && !this.settings.workflows
    try {
      await rpc.request(METHODS.state, {
        workflows: this.settings.workflows, fixtures: this.settings.fixtures, watchMe: this.settings.watchMe, siteDrivers: drivers,
        ...(turnedOff ? { workflowsTurnedOff: true } : {}),
      })
      if (turnedOff) {
        this.workflowsTurnedOff = false
        await this.storage.set({ [WORKFLOWS_OFF_PENDING_KEY]: false })
      }
    } catch {
      // Not delivered: a pending turn-off is sent again on the next push.
    }
  }

  /** The bridge connection changed state. */
  onBridgeState(state: string): void {
    if (state === 'connected') void this.ready.then(() => this.pushBridgeState())
  }

  // ---- dispatch-path hooks ----

  /**
   * Wrap the policy hook of one tab-bound call: once policy did not block it
   * (the pause gate already released it), start the probes the recorder and
   * the site-driver learner need, before the action runs.
   */
  wrapPolicy(call: ToolCall, target: { id?: number; url?: string; windowId?: number }, hook: CallPolicyHook | undefined): CallPolicyHook | undefined {
    if (hook === undefined) return hook
    return (policyCall, targets) => {
      const decision = hook(policyCall, targets)
      if (decision.kind !== 'deny' && target.id !== undefined && !this.deps.halted()) this.startProbes(call, target.id, target.url, target.windowId)
      return decision
    }
  }

  private wantsLocator(call: ToolCall): boolean {
    // browser_press is probed too (its target or the focused element), only
    // to know whether its keys went into a sensitive field.
    return this.settings.workflows && (ELEMENT_TOOLS.has(call.name) || call.name === 'browser_press')
  }

  private wantsNetwork(call: ToolCall, url: string | undefined): boolean {
    const origin = originOf(url)
    return this.settings.siteDrivers && this.deps.siteDriversSupported && origin !== undefined
      && this.settings.siteDriverOrigins.includes(origin)
      && ['browser_click', 'browser_press', 'browser_select', 'browser_type'].includes(call.name)
  }

  private startProbes(call: ToolCall, tabId: number, url: string | undefined, windowId: number | undefined): void {
    this.lastAgentActivity.set(tabId, this.now())
    if (!this.wantsLocator(call) && !this.wantsNetwork(call, url)) return
    const probe: PendingProbe = { tabId, ...(url === undefined ? {} : { url }), ...(windowId === undefined ? {} : { windowId }) }
    if (this.wantsLocator(call)) probe.locator = this.describe(tabId, call.args)
    if (this.wantsNetwork(call, url)) {
      const entries = this.deps.capturedRequests(tabId)
      probe.networkMark = entries === undefined ? -1 : Math.max(0, ...entries.map((entry) => entry.index))
    }
    this.probes.set(call.id, probe)
  }

  private async describe(tabId: number, args: Record<string, unknown>): Promise<LocatorProbe | undefined> {
    const frameId = typeof args.frame === 'number' ? args.frame : 0
    const { frame: _frame, ...rest } = args
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'DSH_LEARN_DESCRIBE', args: rest }, { frameId }) as { ok?: boolean; result?: Record<string, unknown> } | undefined
      if (response?.ok !== true || !isRecord(response.result)) return undefined
      const result = response.result
      return {
        ...(typeof result.role === 'string' && result.role !== '' ? { role: result.role } : {}),
        ...(typeof result.name === 'string' && result.name !== '' ? { name: result.name } : {}),
        ...(typeof result.text === 'string' && result.text !== '' ? { text: result.text } : {}),
        ...(typeof result.css === 'string' && result.css !== '' ? { css: result.css } : {}),
        ...(frameId === 0 ? {} : { frame: frameId }),
        sensitive: result.sensitive === true,
        password: result.password === true,
      }
    } catch {
      return undefined
    }
  }

  /** Record one settled call (success → workflow step; failure → fixture). */
  recordResult(call: ToolCall, answer: ToolAnswer, meta: { tabId?: number; url?: string; decision?: string; policy?: string }): void {
    const probe = this.probes.get(call.id)
    this.probes.delete(call.id)
    if (meta.tabId !== undefined) this.lastAgentActivity.set(meta.tabId, this.now())
    if (answer.ok) {
      if (this.settings.workflows && REPLAYABLE_TOOLS.has(call.name)) void this.recordStep(call, probe, meta.url)
      if (probe?.networkMark !== undefined && probe.networkMark >= 0) void this.learnDriver(call, probe)
      return
    }
    if (this.settings.fixtures && !this.deps.halted() && meta.tabId !== undefined) {
      const key = `${call.name}:${canonicalJson(call.args)}`
      const previous = this.recentFailures.get(key)
      this.recentFailures.set(key, this.now())
      const failure = classifyFailure(answer, meta.decision, meta.policy, previous !== undefined && this.now() - previous < 120_000)
      if (failure !== undefined) void this.captureFixture(call, answer, failure, meta.tabId)
    }
  }

  private async recordStep(call: ToolCall, probe: PendingProbe | undefined, url: string | undefined): Promise<void> {
    const locator = probe?.locator === undefined ? undefined : await probe.locator
    if (ELEMENT_TOOLS.has(call.name) && (locator === undefined || (locator.role === undefined && locator.name === undefined && locator.text === undefined))) return
    if (!this.settings.workflows) return
    const args: Record<string, unknown> = { ...call.args }
    delete args.index
    delete args.selector
    delete args.frame
    delete args.trusted
    if (call.name === 'browser_press') {
      // Keys pressed into a sensitive field (a PIN typed key by key) are never
      // recorded; with no idea of the target only named keys (Enter, Tab) are.
      const key = typeof call.args.key === 'string' ? call.args.key : ''
      if (locator?.sensitive === true || locator?.password === true) return
      if (locator === undefined && [...key].length <= 1) return
    }
    let sensitive = false
    if (call.name === 'browser_type' && (locator?.sensitive === true || locator?.password === true)) {
      // Latched sensitivity from the content script: the value is never kept.
      delete args.text
      sensitive = true
    }
    const step: RecordedStep = {
      id: crypto.randomUUID(),
      tool: call.name,
      args,
      ...(locator === undefined || !ELEMENT_TOOLS.has(call.name) ? {} : {
        locator: {
          ...(locator.role === undefined ? {} : { role: locator.role }),
          ...(locator.name === undefined ? {} : { name: locator.name }),
          ...(locator.text === undefined ? {} : { text: locator.text }),
          ...(locator.css === undefined ? {} : { css: locator.css }),
          ...(locator.frame === undefined ? {} : { frame: locator.frame }),
        },
      }),
      ...(sensitive ? { sensitive: true } : {}),
      ...(originOf(url) === undefined ? {} : { origin: originOf(url)! }),
      at: this.now(),
    }
    const key = call.sessionId ?? NO_SESSION
    const steps = this.recorded.get(key) ?? []
    steps.push(step)
    if (steps.length > MAX_RECORDED_STEPS) steps.splice(0, steps.length - MAX_RECORDED_STEPS)
    this.recorded.set(key, steps)
    this.broadcast()
  }

  /** Recorded steps of one session as the panel shows them (sensitive values never included). */
  stepsFor(sessionId: string | undefined): RecordedStep[] {
    return (this.recorded.get(sessionId ?? NO_SESSION) ?? []).map((step) => ({ ...step, args: { ...step.args } }))
  }

  clearSteps(sessionId: string | undefined): void {
    this.recorded.delete(sessionId ?? NO_SESSION)
    this.broadcast()
  }

  // ---- workflows (bridge-backed) ----

  private async bridgeCall(method: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
    const rpc = this.deps.rpc()
    if (rpc === null || !this.deps.bridgeConnected()) throw new Error(zh() ? '未连接到 dsh。' : 'Not connected to dsh.')
    return rpcValue(await rpc.request(method, payload, timeoutMs))
  }

  async saveWorkflow(sessionId: string | undefined, choices: WorkflowChoices): Promise<unknown> {
    if (!this.settings.workflows) throw new Error('Saved workflows are turned off.')
    const workflow = buildWorkflow(this.stepsFor(sessionId), choices, new Date(this.now()))
    return this.bridgeCall(METHODS.saveWorkflow, { ...(sessionId === undefined ? {} : { sessionId }), workflow })
  }

  listWorkflows(sessionId: string | undefined): Promise<unknown> {
    return this.bridgeCall(METHODS.listWorkflows, sessionId === undefined ? {} : { sessionId })
  }

  createSchedule(sessionId: string, workflow: string, timing: unknown, params?: unknown): Promise<unknown> {
    return this.bridgeCall(METHODS.scheduleCreate, { sessionId, workflow, timing, ...(params === undefined ? {} : { params }) })
  }

  listSchedules(sessionId: string | undefined): Promise<unknown> {
    return this.bridgeCall(METHODS.scheduleList, sessionId === undefined ? {} : { sessionId })
  }

  cancelSchedule(id: string): Promise<unknown> {
    return this.bridgeCall(METHODS.scheduleCancel, { id })
  }

  // ---- failure flywheel ----

  private async captureFixture(call: ToolCall, answer: ToolAnswer, failure: NonNullable<ReturnType<typeof classifyFailure>>, tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (originOf(tab.url) === undefined || this.deps.halted() || !this.deps.fixtureAllowed(call.sessionId, tab.url!)) return
      const probe = await chrome.tabs.sendMessage(tabId, { type: 'DSH_LEARN_FIXTURE', probe: true }, { frameId: 0 }) as { ok?: boolean; result?: { sensitiveCount?: number } } | undefined
      let page: { kind: 'mhtml' | 'dom'; content: string } | undefined
      // MHTML serializes every frame and form value: only a single-frame page
      // with no sensitive field qualifies (the probe sees the top frame only).
      const frames = await listTabFrames(tabId, tab.url).catch(() => [])
      const mhtmlAllowed = probe?.ok === true && probe.result?.sensitiveCount === 0 && frames.length === 1
        && typeof chrome.pageCapture?.saveAsMHTML === 'function'
        && await chrome.permissions.contains({ permissions: ['pageCapture'] }).catch(() => false)
      if (mhtmlAllowed) {
        const blob = await chrome.pageCapture.saveAsMHTML({ tabId })
        if (blob !== undefined) page = { kind: 'mhtml', content: await blob.text() }
      }
      if (page === undefined) {
        const dom = await chrome.tabs.sendMessage(tabId, { type: 'DSH_LEARN_FIXTURE' }, { frameId: 0 }) as { ok?: boolean; result?: { html?: string } } | undefined
        if (dom?.ok !== true || typeof dom.result?.html !== 'string') return
        page = { kind: 'dom', content: dom.result.html }
      }
      await this.bridgeCall(METHODS.saveFixture, {
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        fixture: {
          tool: call.name, args: call.args, error: answer.error ?? { code: 'action-failed', message: 'failed' },
          failure, url: tab.url, ...(tab.title === undefined ? {} : { title: tab.title }), page,
        },
      }, 60_000)
    } catch {
      // Best effort: the flywheel never affects the call itself.
    }
  }

  // ---- site drivers ----

  private async learnDriver(call: ToolCall, probe: PendingProbe): Promise<void> {
    const origin = originOf(probe.url)
    if (origin === undefined || !this.wantsNetwork(call, probe.url)) return
    // Let the request settle in the capture.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const entries = (this.deps.capturedRequests(probe.tabId) ?? []).filter((entry) => entry.index > (probe.networkMark ?? 0)
      && /^(xhr|fetch)$/iu.test(entry.resourceType ?? '') && originOf(entry.url) === origin)
    const request = entries.find((entry) => entry.method.toUpperCase() !== 'GET') ?? entries[0]
    if (request === undefined) return
    try {
      const tokens = await chrome.tabs.sendMessage(probe.tabId, { type: 'DSH_LEARN_TOKENS' }, { frameId: 0 }) as { ok?: boolean; result?: { cookies?: Array<{ name: string; value: string }>; metas?: Array<{ name: string; value: string }>; filledSensitive?: number } } | undefined
      // A filled password/OTP field means the request may carry a secret the
      // recorder never saw (and so cannot recognize): learn nothing.
      if (tokens?.ok !== true || (tokens.result?.filledSensitive ?? 1) > 0) return
      const typed: TypedValue[] = this.stepsFor(call.sessionId)
        .filter((step) => step.tool === 'browser_type' && step.sensitive !== true && typeof step.args.text === 'string')
        .slice(-5)
        .map((step) => ({ ...(step.locator?.name === undefined ? {} : { field: step.locator.name }), value: String(step.args.text) }))
      if (call.name === 'browser_type' && typeof call.args.text === 'string' && !typed.some((value) => value.value === call.args.text)) {
        typed.push({ value: call.args.text })
      }
      const proposal = proposeSiteDriver(origin, {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.requestHeaders.map((header) => [header.name, header.value])),
        ...(request.postData === undefined ? {} : { postData: request.postData }),
      }, typed, { cookies: tokens?.result?.cookies ?? [], metas: tokens?.result?.metas ?? [] }, new Date(this.now()))
      if (this.proposals.some((existing) => existing.driver.origin === proposal.driver.origin && existing.driver.path === proposal.driver.path && existing.driver.method === proposal.driver.method)) return
      this.proposals.push(proposal)
      if (this.proposals.length > MAX_PROPOSALS) this.proposals.shift()
      this.broadcast()
    } catch {
      // Not every request can become a driver (credential in the URL, other origin).
    }
  }

  /** Add a proposal directly (panel-provided capture, tests). */
  addProposal(proposal: SiteDriverProposal): void {
    this.proposals.push(proposal)
    this.broadcast()
  }

  async saveDriver(index: number, edits: { name?: string; description?: string } = {}): Promise<SiteDriver> {
    const proposal = this.proposals[index]
    if (proposal === undefined) throw new Error('That proposal is gone.')
    const driver = validateSiteDriver({ ...proposal.driver, ...(edits.name === undefined ? {} : { name: edits.name }), ...(edits.description === undefined ? {} : { description: edits.description }) })
    this.drivers = [...this.drivers.filter((existing) => !(existing.origin === driver.origin && existing.name === driver.name)), driver]
    this.proposals.splice(index, 1)
    await this.persistDrivers()
    return driver
  }

  discardProposal(index: number): void {
    this.proposals.splice(index, 1)
    this.broadcast()
  }

  async deleteDriver(origin: string, name: string): Promise<void> {
    this.drivers = this.drivers.filter((driver) => !(driver.origin === origin && driver.name === name))
    await this.persistDrivers()
  }

  exportDrivers(): string {
    return JSON.stringify({ format: 'dsh-site-drivers/v1', exportedAt: new Date(this.now()).toISOString(), drivers: this.drivers }, null, 2)
  }

  async importDrivers(text: string): Promise<number> {
    const imported = parseSiteDriverImport(JSON.parse(text))
    for (const driver of imported) {
      this.drivers = [...this.drivers.filter((existing) => !(existing.origin === driver.origin && existing.name === driver.name)), driver]
    }
    await this.persistDrivers()
    return imported.length
  }

  private async persistDrivers(): Promise<void> {
    await this.storage.set({ [SITE_DRIVERS_KEY]: this.drivers })
    await this.pushBridgeState()
    this.broadcast()
  }

  /**
   * Run one site driver: same tab, same origin, site policy and taint first,
   * then a forced per-call card with the exact request, then the page fetch.
   */
  async dispatchSiteDriver(
    call: ToolCall,
    tab: { id?: number; url?: string; windowId?: number },
    policy: CallPolicyHook | undefined,
    authorize: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
    signal: AbortSignal,
  ): Promise<ToolAnswer> {
    await this.ready
    const fail = (message: string, code: 'action-failed' | 'bad-args' = 'action-failed'): ToolAnswer => ({ ok: false, error: { code, message } })
    if (!this.settings.siteDrivers || !this.deps.siteDriversSupported) return fail('Site drivers are turned off in the extension settings. Use the page UI.')
    const origin = typeof call.args.origin === 'string' ? call.args.origin : ''
    const driver = this.drivers.find((candidate) => candidate.origin === origin && candidate.name === call.args.driver)
    if (driver === undefined) return fail('That site driver is not saved in this browser. Use the page UI.')
    if (tab.id === undefined || originOf(tab.url) !== driver.origin) return fail(`The controlled tab is not on ${driver.origin}. Use the page UI instead.`)
    const params = isRecord(call.args.params) ? call.args.params : {}
    let request
    try {
      request = buildDriverRequest(driver, params)
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error), 'bad-args')
    }
    const targets: CallPolicyTargets = { reads: [driver.origin], acts: [driver.origin], pageOrigin: driver.origin }
    const decision: CallPolicyDecision = policy?.({ ...call, args: { origin, driver: driver.name, params } }, targets) ?? { kind: 'default' }
    if (decision.kind === 'deny') return fail(decision.message)
    const described = describeDriverRequest(request)
    const reasons = [
      zh() ? '站点驱动（实验性）直接发送下面这条请求，每次都需要您批准。' : 'A site driver (experimental) sends exactly this request; each one needs your approval.',
      ...(decision.kind === 'force' ? decision.reasons : []),
    ]
    const prompt: ApprovalPrompt = {
      kind: 'action',
      action: 'browser_site_driver',
      summary: zh() ? `站点驱动 “${driver.name}”：${request.method} ${request.url}` : `Site driver "${driver.name}": ${request.method} ${request.url}`,
      origins: [driver.origin],
      canTrust: false,
      forced: true,
      perCallOnly: true,
      details: [
        { kind: 'text', value: reasons.join('\n'), masked: false, label: zh() ? '为何需要您的批准' : 'Why this needs your approval' },
        { kind: 'payload', value: described },
      ],
      binding: approvalBinding({ action: 'browser_site_driver', args: { request: described }, origins: [driver.origin] }),
    }
    const authorization = await authorize(prompt)
    if (signal.aborted) return fail('Tool call was cancelled')
    if (authorization !== 'approved') return fail(`The user did not approve the site driver request (${authorization}). Use the page UI only if the user asks.`)
    // The tab may have moved while the card waited.
    const now = await chrome.tabs.get(tab.id).catch(() => undefined)
    if (originOf(now?.url) !== driver.origin) return fail(`The tab left ${driver.origin} while approval was pending. Use the page UI.`)
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'DSH_SITE_DRIVER_FETCH', request }, { frameId: 0 }) as { ok?: boolean; result?: { status: number; ok: boolean; contentType: string; body: string }; error?: { message?: string } } | undefined
      if (response?.ok !== true || response.result === undefined) return fail(`The site driver failed: ${response?.error?.message ?? 'no answer from the page'}. Fall back to the page UI.`)
      const result = response.result
      if (!result.ok) return fail(`The site driver got HTTP ${String(result.status)} (the token may be stale or the site changed). Fall back to the page UI for this task.`)
      return { ok: true, result: { text: `Site driver "${driver.name}" sent ${request.method} ${request.url}: HTTP ${String(result.status)} (${result.contentType || 'no content type'}).\n${wrapUntrustedContent(result.body, 6_000)}` } }
    } catch (error: unknown) {
      return fail(`The site driver failed: ${error instanceof Error ? error.message : String(error)}. Fall back to the page UI.`)
    }
  }

  // ---- watch me ----

  async startWatching(tabId: number): Promise<void> {
    if (!this.settings.watchMe) throw new Error('Watch me is turned off in the settings.')
    await this.stopWatching()
    const tab = await chrome.tabs.get(tabId)
    const origin = originOf(tab.url)
    if (origin === undefined) throw new Error(zh() ? '此页面无法观察。' : 'This page cannot be watched.')
    this.watch = { tabId, origin, events: [] }
    this.suggestion = undefined
    await chrome.tabs.sendMessage(tabId, { type: 'DSH_WATCH', enabled: true }, { frameId: 0 })
    this.broadcast()
  }

  async stopWatching(): Promise<void> {
    const watch = this.watch
    this.watch = undefined
    this.suggestion = undefined
    if (watch !== undefined) await chrome.tabs.sendMessage(watch.tabId, { type: 'DSH_WATCH', enabled: false }, { frameId: 0 }).catch(() => {})
    this.broadcast()
  }

  /**
   * Whether a freshly loaded top document should resume "Watch me": only the
   * watched tab, its top frame, and the origin the recording started on.
   */
  watchMeReady(tabId: number, frameId: number | undefined, url: string | undefined): boolean {
    const watch = this.watch
    return this.settings.watchMe && watch !== undefined && watch.tabId === tabId && (frameId ?? 0) === 0 && originOf(url) === watch.origin
  }

  /** One trusted user event from the watched tab. */
  async onWatchEvent(tabId: number, frameId: number, raw: unknown): Promise<void> {
    const watch = this.watch
    if (watch === undefined || watch.tabId !== tabId || frameId !== 0 || !isRecord(raw)) return
    // Trusted events the agent causes (debugger input) are not the user's.
    const last = this.lastAgentActivity.get(tabId)
    if (this.deps.agentActiveOnTab(tabId) || (last !== undefined && this.now() - last < AGENT_QUIET_MS)) return
    if (raw.kind !== 'click' && raw.kind !== 'type' && raw.kind !== 'select') return
    if (typeof raw.css !== 'string' || raw.css === '' || raw.css.length > 1_000) return
    const event: WatchEvent = {
      kind: raw.kind,
      css: raw.css,
      ...(typeof raw.label === 'string' ? { label: raw.label.slice(0, 80) } : {}),
      ...(raw.sensitive === true ? { sensitive: true } : typeof raw.value === 'string' ? { value: raw.value.slice(0, 2_000) } : {}),
      ...(Array.isArray(raw.cells) ? { cells: raw.cells.filter((cell): cell is string => typeof cell === 'string').slice(0, 20) } : {}),
    }
    watch.events.push(event)
    if (watch.events.length > MAX_WATCH_EVENTS) watch.events.splice(0, watch.events.length - MAX_WATCH_EVENTS)
    await this.refreshSuggestion()
  }

  private async refreshSuggestion(): Promise<void> {
    const watch = this.watch
    if (watch === undefined) return
    const pattern: RepetitionPattern | undefined = detectRepetition(watch.events)
    if (pattern === undefined) {
      this.suggestion = undefined
      this.broadcast()
      return
    }
    try {
      const response = await chrome.tabs.sendMessage(watch.tabId, { type: 'DSH_WATCH_PROBE', selectors: nextSelectors(pattern, Math.floor(MAX_PROGRAM_STEPS / pattern.period)) }, { frameId: 0 }) as { ok?: boolean; result?: { rows?: string[][] } } | undefined
      const rows = response?.result?.rows ?? []
      // A cell-sourced value needs a non-empty cell in every remaining row.
      const usable = rows.filter((cells) => pattern.steps.every((step) => step.value.kind !== 'cell' || (cells[step.value.cell] ?? '').trim() !== ''))
      if (usable.length !== rows.length || rows.length === 0) {
        this.suggestion = undefined
      } else {
        this.suggestion = {
          tabId: watch.tabId,
          origin: watch.origin,
          period: pattern.period,
          done: pattern.done,
          remaining: rows.length,
          program: buildProgram(pattern, rows),
          labels: pattern.steps.map((step) => `${step.kind}${step.label === undefined ? '' : ` "${step.label}"`}${step.value.kind === 'cell' ? ` ← column ${String(step.value.cell + 1)}` : step.value.kind === 'constant' ? ` ← "${step.value.value}"` : ''}`),
        }
      }
    } catch {
      this.suggestion = undefined
    }
    this.broadcast()
  }

  /**
   * "Do the remaining N like this": the program goes to the bridge as one
   * `browser_run`, so the extension shows its single program card (every
   * step's payload, bound to this page) and each step then claims that
   * approval through run-program.ts; forced, per-call and off-origin cards
   * still ask, and every step keeps the full dispatch path.
   */
  async runSuggestion(sessionId: string | undefined): Promise<unknown> {
    const suggestion = this.suggestion
    if (suggestion === undefined || !this.settings.watchMe) throw new Error('There is no suggestion to run.')
    const tab = await chrome.tabs.get(suggestion.tabId)
    if (originOf(tab.url) !== suggestion.origin) throw new Error('The watched tab left the page.')
    // The user's own input from here on is the program, not new teaching.
    await this.stopWatching()
    return this.bridgeCall(METHODS.programRun, { ...(sessionId === undefined ? {} : { sessionId }), steps: suggestion.program }, PROGRAM_RUN_TIMEOUT_MS)
  }

  // ---- panel port ----

  snapshot(sessionId?: string): Record<string, unknown> {
    return {
      settings: this.settings,
      siteDriversSupported: this.deps.siteDriversSupported,
      steps: this.stepsFor(sessionId),
      watching: this.watch === undefined ? null : { tabId: this.watch.tabId, origin: this.watch.origin, events: this.watch.events.length },
      suggestion: this.suggestion ?? null,
      proposals: this.proposals.map((proposal) => ({ driver: proposal.driver, droppedHeaders: proposal.droppedHeaders })),
      drivers: this.drivers,
    }
  }

  private readonly portSessions = new WeakMap<chrome.runtime.Port, string | undefined>()

  private broadcast(): void {
    for (const port of this.ports) {
      try { port.postMessage({ type: 'learning.state', state: this.snapshot(this.portSessions.get(port)) }) } catch { /* closed */ }
    }
  }

  /** Attach a panel port; returns false when it is not ours. */
  connect(port: chrome.runtime.Port): boolean {
    if (port.name !== LEARNING_PORT_NAME) return false
    // Content scripts run beside untrusted pages: only extension pages may
    // save workflows, approve drivers, or read the learning state.
    if (!isExtensionPageSender(port.sender)) {
      port.disconnect()
      return true
    }
    this.ports.add(port)
    port.onDisconnect.addListener(() => { this.ports.delete(port) })
    port.onMessage.addListener((message: unknown) => { void this.onPortMessage(port, message) })
    void this.ready.then(() => { this.broadcast() })
    return true
  }

  private async onPortMessage(port: chrome.runtime.Port, message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') return
    const id = typeof message.id === 'string' ? message.id : undefined
    const sessionId = typeof message.sessionId === 'string' && message.sessionId !== '' ? message.sessionId : undefined
    const reply = (result: unknown): void => {
      if (id !== undefined) try { port.postMessage({ type: 'learning.result', id, ok: true, result }) } catch { /* closed */ }
    }
    const replyError = (error: unknown): void => {
      if (id !== undefined) try { port.postMessage({ type: 'learning.result', id, ok: false, error: { message: error instanceof Error ? error.message : String(error) } }) } catch { /* closed */ }
    }
    await this.ready
    try {
      switch (message.type) {
        case 'learning.subscribe':
          this.portSessions.set(port, sessionId)
          port.postMessage({ type: 'learning.state', state: this.snapshot(sessionId) })
          return reply(true)
        case 'learning.settings':
          return reply(await this.updateSettings(isRecord(message.settings) ? message.settings as Partial<LearningSettings> : {}))
        case 'learning.workflow.save':
          return reply(await this.saveWorkflow(sessionId, message.choices as WorkflowChoices))
        case 'learning.workflow.list':
          return reply(await this.listWorkflows(sessionId))
        case 'learning.steps.clear':
          this.clearSteps(sessionId)
          return reply(true)
        case 'learning.schedule.create':
          if (sessionId === undefined) throw new Error(zh() ? '需要先打开一个会话。' : 'Open a conversation first.')
          return reply(await this.createSchedule(sessionId, String(message.workflow), message.timing, message.params))
        case 'learning.schedule.list':
          return reply(await this.listSchedules(sessionId))
        case 'learning.schedule.cancel':
          return reply(await this.cancelSchedule(String(message.scheduleId)))
        case 'learning.watch.start': {
          const tab = await this.deps.activeTab()
          if (tab?.id === undefined) throw new Error('No active tab.')
          await this.startWatching(tab.id)
          return reply(true)
        }
        case 'learning.watch.stop':
          await this.stopWatching()
          return reply(true)
        case 'learning.watch.run':
          return reply(await this.runSuggestion(sessionId))
        case 'learning.driver.save':
          return reply(await this.saveDriver(Number(message.index), isRecord(message.edits) ? message.edits as { name?: string; description?: string } : {}))
        case 'learning.driver.discard':
          this.discardProposal(Number(message.index))
          return reply(true)
        case 'learning.driver.delete':
          await this.deleteDriver(String(message.origin), String(message.name))
          return reply(true)
        case 'learning.driver.export':
          return reply(this.exportDrivers())
        case 'learning.driver.import':
          return reply(await this.importDrivers(String(message.text)))
        default:
          return replyError(new Error(`unknown learning request ${message.type}`))
      }
    } catch (error: unknown) {
      replyError(error)
    }
  }
}
