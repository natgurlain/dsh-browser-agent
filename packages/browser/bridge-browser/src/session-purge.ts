/**
 * File-level removal of one session's durable storage under the dsh home.
 *
 * The gateway exposes no session.delete, so the bridge performs the removal
 * itself: this module archives the session under exclusive write ownership,
 * then removes its durable data while retaining the kernel lock's pathname.
 * Session ids are validated against the persisted shape, only data within
 * exact-name directories two levels below the sessions root is removed, and
 * running sessions are refused before anything touches the disk.
 *
 * @module @natgurlain/dsh-bridge-browser/src/session-purge
 */

import { randomUUID } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import { isRecord, type BrowserHostApi } from './host-api.ts'

/** Stable failure codes surfaced to the panel. Open set: callers must tolerate growth. */
export type SessionPurgeErrorCode = 'not-found' | 'running' | 'invalid-id' | 'internal'

/** Error thrown by {@link purgeSessionFiles}; the server turns it into a wire error. */
export class SessionPurgeError extends Error {
  constructor(
    readonly code: SessionPurgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionPurgeError'
  }
}

/** Persisted session ids are `session-` plus one lowercase UUID. */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
/** POSIX flock is attached to this inode; unlinking it defeats exclusion. */
const SESSION_LOCK_FILENAME = 'session.lock'

/** Dependencies purging needs from the plugin. */
export interface SessionPurgeDeps {
  /** The dsh sessions root (`dshHomePath('sessions')`). */
  sessionsRoot: string
  /** Session ids currently running; purging any of these is refused. */
  runningSessionIds: ReadonlySet<string>
  /**
   * Claim the runtime's exclusive write ownership (including its kernel lock).
   * The returned handle must remain held until removal finishes. Opening a
   * read handle, checking for a lock file, or checking only Agent status does
   * not provide exclusion: idle Agents and other processes can own the log.
   */
  acquireOwnership(sessionId: string): Promise<{ close(): Promise<void> }>
  /** After archiving, returns an operation that restores the previous archive state, for use when the purge fails. */
  archiveSession(sessionId: string): Promise<void | (() => Promise<void>)>
  /** Waits for the host to finish the worktree cleanup triggered by archiving, then removes the session log. */
  waitForArchiveCleanup?(sessionId: string): Promise<void>
}

/**
 * Validate one session id against the persisted shape. Rejects everything
 * that could escape the sessions root (separators, dot segments) before any
 * filesystem call sees it.
 * @param sessionId - untrusted id from the panel.
 * @returns the id when well-formed.
 * @throws SessionPurgeError with code `invalid-id` otherwise.
 */
export function assertPurgeableSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionPurgeError('invalid-id', `session id "${sessionId}" does not match the persisted shape`)
  }
  return sessionId
}

/**
 * Permanently delete a session's data, keeping its directory and lock inode.
 * The runtime refuses ambiguous duplicate session identities across workspaces.
 * @param deps - root and running-set inputs.
 * @param sessionId - validated session id.
 * @returns nothing; throws {@link SessionPurgeError} on refusal or failure.
 */
export async function purgeSessionFiles(deps: SessionPurgeDeps, sessionId: string): Promise<void> {
  assertPurgeableSessionId(sessionId)
  if (deps.runningSessionIds.has(sessionId)) {
    throw new SessionPurgeError('running', 'refusing to purge a running session; cancel it first')
  }

  let workspaces: string[]
  try {
    workspaces = await readdir(deps.sessionsRoot, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  } catch (error: unknown) {
    throw new SessionPurgeError('internal', `could not read the sessions root "${deps.sessionsRoot}": ${String(error)}`)
  }

  const targets: string[] = []
  for (const workspace of workspaces) {
    // path.join is safe here: the id pattern above excludes separators and
    // dot segments, so the joined segment cannot escape the workspace dir.
    const candidate = path.join(deps.sessionsRoot, workspace, sessionId)
    try {
      if (!(await lstat(candidate)).isDirectory()) continue
      const entries = await readdir(candidate)
      if (entries.some(entry => entry !== SESSION_LOCK_FILENAME)) targets.push(candidate)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SessionPurgeError('internal', `could not inspect "${candidate}": ${String(error)}`, { cause: error })
      }
    }
  }

  if (targets.length === 0) {
    throw new SessionPurgeError('not-found', `no durable storage found for session "${sessionId}"`)
  }
  let ownership: { close(): Promise<void> }
  try {
    ownership = await deps.acquireOwnership(sessionId)
  } catch (error: unknown) {
    // Match the public error identity across independently loaded runtime
    // copies without depending on a private JSONL lock implementation.
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new SessionPurgeError(
        'running',
        'session is still owned by a runtime; release the session or restart that runtime, then retry deletion',
      )
    }
    throw new SessionPurgeError('internal', `could not acquire exclusive session ownership: ${String(error)}`)
  }
  let failure: unknown
  let archived = false
  let restoreArchive: void | (() => Promise<void>) = undefined
  let removing = false
  try {
    // The public archive API checks existence. Calling it after deletion
    // succeeds only accidentally when its header cache already knows this id.
    restoreArchive = await deps.archiveSession(sessionId)
    archived = true
    await deps.waitForArchiveCleanup?.(sessionId)
    removing = true
    for (const target of targets) {
      if (!(await lstat(target)).isDirectory()) throw new Error(`session directory changed: ${target}`)
      // Re-scan after write-open: opening an old log may materialize V3.
      for (const entry of await readdir(target)) {
        if (entry === SESSION_LOCK_FILENAME) continue
        await rm(path.join(target, entry), { recursive: true, force: true })
      }
    }
  } catch (error: unknown) {
    let cause = error
    if (!removing && restoreArchive !== undefined) {
      try {
        await restoreArchive()
        archived = false
      } catch (restoreError: unknown) {
        cause = new AggregateError([error, restoreError], 'worktree cleanup and archive restoration failed')
      }
    }
    failure = new SessionPurgeError('internal', archived
      ? `session was archived, but durable cleanup failed: ${String(cause)}`
      : `session cleanup failed: ${String(cause)}`, { cause })
  } finally {
    try {
      await ownership.close()
    } catch (error: unknown) {
      failure = failure === undefined
        ? new SessionPurgeError('internal', `session was archived and cleared, but ownership release failed: ${String(error)}`, { cause: error })
        : new SessionPurgeError('internal', `${String(failure)}; ownership release also failed: ${String(error)}`, {
          cause: new AggregateError([failure, error], 'session purge and ownership release failed'),
        })
    }
  }
  if (failure !== undefined) throw failure
}

/** The worktree service's archive-cleanup report (DSH 0.2.2-rc.2 and later). */
interface ArchiveCleanupWorktrees {
  cleanupOf?(session: unknown, revision: unknown): Promise<{ status?: string; revision?: unknown } | null | undefined>
}

/** The session query's inspection entry point (DSH 0.2.2-rc.2 and later). */
interface ArchiveCleanupQuery {
  inspectSession?(sessionId: string, read: (session: unknown) => unknown): Promise<unknown>
}

/**
 * The panel's purge: list running sessions (advisory), then
 * {@link purgeSessionFiles} under the runtime's exclusive write ownership,
 * archiving first (and restoring the archive state if removal fails).
 * @param ctx - the plugin context (session persistence, worktrees, session query).
 * @param api - the Host API (session.list, workspace archive methods).
 * @param sessionsRoot - the dsh sessions root.
 * @param onPurged - runs after a successful purge (drop per-session state).
 * @returns the purge function the server calls.
 */
export function createSessionPurger(
  ctx: Context,
  api: Pick<BrowserHostApi, 'call'>,
  sessionsRoot: string,
  onPurged?: (sessionId: string) => Promise<void>,
): (sessionId: string) => Promise<void> {
  return async (sessionId) => {
    const runningSessionIds = new Set<string>()
    try {
      const listed = await api.call({
        rpcId: randomUUID(),
        method: 'session.list',
        payload: {},
        signal: new AbortController().signal,
      })
      if (listed.ok && isRecord(listed.value) && Array.isArray(listed.value.items)) {
        for (const entry of listed.value.items) {
          if (isRecord(entry) && entry.running === true && typeof entry.sessionId === 'string') {
            runningSessionIds.add(entry.sessionId)
          }
        }
      }
    } catch {
      // Listing is advisory; the required exclusive persistence handle below
      // protects both active and idle sessions, including in other processes.
    }
    const deps: SessionPurgeDeps = {
      sessionsRoot,
      runningSessionIds,
      acquireOwnership: async (id) => {
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          throw new Error('browser bridge: session persistence is required to safely purge a session')
        }
        return persistence.open(id as Parameters<typeof persistence.open>[0], 'write')
      },
      archiveSession: async (id) => {
        const workspace = await api.call({
          rpcId: randomUUID(), method: 'workspace.list', payload: {}, signal: new AbortController().signal,
        })
        if (!workspace.ok) throw new Error(workspace.error.message)
        if (!isRecord(workspace.value) || !Array.isArray(workspace.value.archivedSessionIds)) {
          throw new TypeError('workspace.list returned an invalid archive set')
        }
        const wasArchived = workspace.value.archivedSessionIds.includes(id)
        const archived = await api.call({
          rpcId: randomUUID(),
          method: 'workspace.archiveSession',
          payload: { sessionId: id },
          signal: new AbortController().signal,
        })
        if (!archived.ok) throw new Error(archived.error.message)
        if (wasArchived) return
        return async () => {
          const restored = await api.call({
            rpcId: randomUUID(), method: 'workspace.unarchiveSession', payload: { sessionId: id },
            signal: new AbortController().signal,
          })
          if (!restored.ok) throw new Error(restored.error.message)
        }
      },
      waitForArchiveCleanup: async (id) => {
        // Typed structurally: DSH 0.2.2-rc.1 has neither cleanupOf nor
        // inspectSession, and its archive does not report a cleanup to wait
        // for, so on that host the purge goes on as it did before the wait
        // existed. A host with cleanupOf but no way to inspect is an error.
        const worktrees = ctx.get('worktrees') as unknown as ArchiveCleanupWorktrees | undefined
        if (worktrees === undefined || typeof worktrees.cleanupOf !== 'function') return
        const query = ctx.get('sessionQuery') as unknown as ArchiveCleanupQuery | undefined
        if (query === undefined || typeof query.inspectSession !== 'function') {
          throw new Error('session query is required to finish worktree cleanup')
        }
        const session = await query.inspectSession(id, session => session)
        const pending = await worktrees.cleanupOf(session, null)
        const cleanup = pending?.status === 'scheduled'
          ? await worktrees.cleanupOf(session, pending.revision) : pending
        if (cleanup?.status === 'failed') throw new Error('worktree cleanup failed')
      },
    }
    await purgeSessionFiles(deps, sessionId)
    await onPurged?.(sessionId)
  }
}
