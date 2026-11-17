/**
 * The Host-side reactions mountBridge wires into the bridge server, kept out
 * of index.ts so each can be tested with the real registries it touches:
 *
 * - {@link createKillSwitchHandler}: the user's kill switch revokes standing
 *   grants on the Host (dev-loop links, workflow schedules);
 * - {@link createSnapshotInjector}: a panel-requested snapshot injection
 *   delivers page content, so the session is tainted with it;
 * - {@link createSessionForgetter}: after a purge, drop what the bridge kept
 *   per session.
 *
 * @module dsh-browser-agent/src/bridge-hooks
 */

import type { BrowserContextReason } from './browser-context.ts'
import type { DevLoop } from './dev-loop.ts'
import type { LearningMount } from './learning/index.ts'
import type { SessionTaintRegistry } from './session-taint.ts'
import type { WakeLimiter, WatchRecordStore } from './watchers.ts'
import { errorMessage } from './host-api.ts'

/** What the kill switch revokes. */
export interface KillSwitchDeps {
  devLoop: Pick<DevLoop, 'unlinkAll'>
  /** The learning mount while it is mounted. */
  learning: () => Pick<LearningMount, 'revokeStandingGrants'> | undefined
  info: (message: string) => void
}

/**
 * The server's `onKillSwitch`: unlink every dev-loop tab and revoke every
 * workflow schedule this bridge created.
 * @returns the handler; it resolves once the schedules are revoked.
 */
export function createKillSwitchHandler(deps: KillSwitchDeps): () => Promise<void> {
  return async () => {
    const unlinked = deps.devLoop.unlinkAll()
    if (unlinked > 0) deps.info(`browser bridge: kill switch engaged; removed ${String(unlinked)} dev loop link(s)`)
    await deps.learning()?.revokeStandingGrants()
  }
}

/**
 * The server's `injectBrowserSnapshot`: queue the snapshot for the session
 * and taint it (the snapshot is page-controlled text), unless the extension
 * vouched that every frame in it is exempt from taint (`exempt`, see
 * session-taint.ts).
 */
export function createSnapshotInjector(
  inject: (sessionId: string, snapshot: string, reason?: BrowserContextReason) => unknown,
  taint: Pick<SessionTaintRegistry, 'mark'> & Partial<Pick<SessionTaintRegistry, 'honours' | 'noteExemptRead'>>,
): (sessionId: string, snapshot: string, reason?: BrowserContextReason, exempt?: boolean, local?: boolean) => void {
  return (sessionId, snapshot, reason, exempt, local) => {
    inject(sessionId, snapshot, reason)
    // `local`: the exemption rests on a local page, which this bridge may not honour.
    if (exempt === true && taint.honours?.(local === true) !== false) taint.noteExemptRead?.(sessionId)
    else taint.mark(sessionId, 'snapshot-injection')
  }
}

/** Per-session state a purged session leaves behind. */
export interface SessionForgetDeps {
  taint: Pick<SessionTaintRegistry, 'forget'>
  /** The server's install binding (dropped only when the taint registry let go of the session). */
  forgetAffinity: (sessionId: string) => void
  wakeLimiter: Pick<WakeLimiter, 'forget'>
  policy: { forgetSession(sessionId: string): void }
  watchRecords: Pick<WatchRecordStore, 'removeSession'>
  learning: () => Pick<LearningMount, 'forgetSession'> | undefined
  warn: (message: string) => void
}

/**
 * Drop the in-memory and durable per-session state of a purged session
 * (install binding, taint, wake history, listing cache, watcher records,
 * workflow schedules). Taint and the install binding stay while a child
 * session is linked under it: the child inherits both through it.
 */
export function createSessionForgetter(deps: SessionForgetDeps): (sessionId: string) => Promise<void> {
  return async (sessionId) => {
    if (deps.taint.forget(sessionId)) deps.forgetAffinity(sessionId)
    deps.wakeLimiter.forget(sessionId)
    deps.policy.forgetSession(sessionId)
    await deps.watchRecords.removeSession(sessionId).catch((error: unknown) => {
      deps.warn(`browser bridge: could not drop the purged session's page watchers: ${errorMessage(error)}`)
    })
    await deps.learning()?.forgetSession(sessionId)
  }
}
