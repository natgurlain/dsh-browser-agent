/**
 * What happens between "Resume" and releasing the held tool calls: compare
 * each affected session's controlled tab with the moment the user paused,
 * inject a compact delta through the browser-context path, and mark held
 * element-addressed calls stale when the page changed under them.
 *
 * Kept free of the background's globals so the flow is unit-testable.
 *
 * @module
 */

import {
  HOLD_STALE_MESSAGE,
  describeResumeDelta,
  heldCallStale,
  type HeldCall,
  type PageFacts,
} from './pause-gate.ts'

/** Tab facts recorded when the user paused. */
export interface PauseBaseline {
  /** Controlled tab per session ('' for calls without a session). */
  sessions: Map<string, { tabId: number; facts: PageFacts }>
  /** Every tab id that existed. */
  tabIds: Set<number>
}

/** A tab as the flow needs it. */
export interface TabFacts {
  id: number
  url?: string
  title?: string
  openerTabId?: number
}

export interface ResumeFlowDeps {
  /** Every open tab. */
  queryTabs: () => Promise<TabFacts[]>
  /** One tab, or undefined when it is gone. */
  getTab: (tabId: number) => Promise<TabFacts | undefined>
  /** Sessions whose agent should hear about the change even without a held call. */
  boundSessions: () => string[]
  /** The controlled tab of a session ('' = no session). */
  sessionTab: (sessionId: string) => number | undefined
  /** Whether page details (URLs, titles, page text) may be shared. */
  shareDetails: () => boolean
  /** Rendered `browser_snapshot { delta: true }` of a session's tab, if allowed. */
  pageDelta: (sessionId: string, tabId: number) => Promise<string | undefined>
  /** Deliver the delta to the session's Agent. */
  inject: (sessionId: string, text: string) => Promise<void>
  /** Whether site policy forbids the agent from reading this URL (its address and title are withheld). */
  pageHidden?: (url: string) => boolean
}

/** Capture what the user is about to change. */
export async function capturePauseBaseline(deps: Pick<ResumeFlowDeps, 'queryTabs' | 'boundSessions' | 'sessionTab'>): Promise<PauseBaseline> {
  const tabs = await deps.queryTabs().catch(() => [] as TabFacts[])
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const sessions = new Map<string, { tabId: number; facts: PageFacts }>()
  for (const sessionId of new Set(['', ...deps.boundSessions()])) {
    const tabId = deps.sessionTab(sessionId)
    if (tabId === undefined) continue
    const tab = byId.get(tabId)
    sessions.set(sessionId, { tabId, facts: { ...(tab?.url === undefined ? {} : { url: tab.url }), ...(tab?.title === undefined ? {} : { title: tab.title }) } })
  }
  return { sessions, tabIds: new Set(tabs.map((tab) => tab.id)) }
}

/**
 * Inject one delta per affected session and decide which held calls fail.
 * @returns held call id → failure message, for calls that must not run.
 */
export async function prepareResume(
  held: readonly HeldCall[],
  context: { tookOver: boolean; pausedMs: number },
  baseline: PauseBaseline | undefined,
  deps: ResumeFlowDeps,
): Promise<Map<string, string>> {
  const failures = new Map<string, string>()
  const tabs = await deps.queryTabs().catch(() => [] as TabFacts[])
  const newTabs = baseline === undefined ? [] : tabs.filter((tab) => !baseline.tabIds.has(tab.id))
  const sessions = new Set<string>(held.map((call) => call.sessionId ?? ''))
  for (const sessionId of deps.boundSessions()) sessions.add(sessionId)
  const share = deps.shareDetails()
  for (const sessionId of sessions) {
    const recorded = baseline?.sessions.get(sessionId)
    const tabId = deps.sessionTab(sessionId) ?? recorded?.tabId
    if (tabId === undefined) continue
    const live = await deps.getTab(tabId).catch(() => undefined)
    const after = live === undefined ? undefined : {
      ...(live.url === undefined ? {} : { url: live.url }),
      ...(live.title === undefined ? {} : { title: live.title }),
    }
    const before = recorded?.tabId === tabId ? recorded.facts : undefined
    const pageChanged = live === undefined || before === undefined || before.url !== after?.url
    for (const call of held) {
      if ((call.sessionId ?? '') !== sessionId) continue
      if (heldCallStale(call, pageChanged)) failures.set(call.id, HOLD_STALE_MESSAGE)
    }
    if (sessionId === '') continue
    const delta = share && live !== undefined ? await deps.pageDelta(sessionId, tabId).catch(() => undefined) : undefined
    const text = describeResumeDelta({
      mode: context.tookOver ? 'taken-over' : 'paused',
      pausedMs: context.pausedMs,
      before,
      after,
      openedFromControlled: newTabs.filter((tab) => tab.openerTabId === tabId).length,
      newTabs: newTabs.length,
      ...(delta === undefined ? {} : { pageDelta: delta }),
      shareDetails: share,
      redactAfter: after?.url !== undefined && deps.pageHidden?.(after.url) === true,
    })
    await deps.inject(sessionId, text).catch(() => {})
  }
  return failures
}
