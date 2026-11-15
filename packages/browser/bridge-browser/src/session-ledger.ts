/**
 * Durable record of the sessions this bridge created, so the extension keeps
 * access to its own conversations across restarts and never gains access to
 * Desktop, CLI, or subagent sessions.
 *
 * The file is a JSON array of session ids under the dsh home, written with
 * mode 0600 through an exclusive temp file and an atomic rename. It is loaded
 * only when it is a regular file (not a symlink) owned by this user and not
 * writable by group or others, since it grants ownership of sessions; a
 * missing, unreadable, or untrusted file starts empty (the bridge then only reaches sessions it
 * creates from now on, plus the workspace-path marker in bridge-policy.ts).
 *
 * Tab-fleet subagents (fanout.ts) are recorded as `[child, parent]` pairs: a
 * child counts as owned only while its parent does, so a subagent of a
 * session this bridge does not own is never reachable.
 *
 * @module @natgurlain/dsh-bridge-browser/src/session-ledger
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Most ids kept; the oldest are dropped first. */
const MAX_LEDGER_IDS = 10_000

/** How many parent links {@link SessionLedger.has} follows (fleet children are one level deep). */
const MAX_CHILD_DEPTH = 4

/** Membership record of bridge-created sessions. */
export interface SessionLedger {
  has(sessionId: string): boolean
  add(sessionId: string): Promise<void>
  /**
   * Record a subagent the bridge started for an owned session. Ignored when
   * the parent is not owned. The child is owned exactly while its parent is.
   */
  addChild?(childId: string, parentId: string): Promise<void>
}

function ownedThrough(ids: ReadonlySet<string>, children: ReadonlyMap<string, string>, sessionId: string): boolean {
  let current = sessionId
  for (let depth = 0; depth <= MAX_CHILD_DEPTH; depth += 1) {
    if (ids.has(current)) return true
    const parent = children.get(current)
    if (parent === undefined) return false
    current = parent
  }
  return false
}

/** In-memory ledger (tests, or when persistence is disabled). */
export function memorySessionLedger(ids: Iterable<string> = []): SessionLedger {
  const set = new Set(ids)
  const children = new Map<string, string>()
  return {
    has: (sessionId) => ownedThrough(set, children, sessionId),
    add: async (sessionId) => { set.add(sessionId) },
    addChild: async (childId, parentId) => {
      if (childId !== parentId && ownedThrough(set, children, parentId)) children.set(childId, parentId)
    },
  }
}

/**
 * Load the ledger file once and persist every addition.
 * @param file - ledger path.
 * @param warn - logger for persistence failures (membership still holds in memory).
 * @returns the ledger.
 */
export async function fileSessionLedger(file: string, warn: (message: string) => void): Promise<SessionLedger> {
  const ids = new Set<string>()
  const children = new Map<string, string>()
  const untrusted = await loadTrusted(file, ids, children)
  if (untrusted !== undefined) warn(`browser bridge: ignoring session ledger ${file}: ${untrusted}`)
  let writing = Promise.resolve()
  const persist = async (): Promise<void> => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${randomBytes(8).toString('hex')}`
    try {
      await writeFile(temp, JSON.stringify([...ids, ...[...children].map(([child, parent]) => [child, parent])]), { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } catch (error: unknown) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
  const save = async (): Promise<void> => {
    writing = writing.then(persist, persist).catch((error: unknown) => {
      warn(`browser bridge: could not persist the session ledger: ${error instanceof Error ? error.message : String(error)}`)
    })
    await writing
  }
  return {
    has: (sessionId) => ownedThrough(ids, children, sessionId),
    add: async (sessionId) => {
      if (ids.has(sessionId)) return
      ids.add(sessionId)
      while (ids.size > MAX_LEDGER_IDS) ids.delete(ids.values().next().value as string)
      await save()
    },
    addChild: async (childId, parentId) => {
      if (childId === parentId || children.get(childId) === parentId || !ownedThrough(ids, children, parentId)) return
      children.set(childId, parentId)
      while (children.size > MAX_LEDGER_IDS) children.delete(children.keys().next().value as string)
      await save()
    },
  }
}

/**
 * Read the ledger into `ids` when the file is trustworthy.
 * @returns why the file was ignored, or undefined (loaded, or simply absent/unreadable).
 */
async function loadTrusted(file: string, ids: Set<string>, children: Map<string, string>): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    return code === 'ELOOP' ? 'it is a symlink' : undefined
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return 'it is not a regular file'
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) return `it is owned by uid ${String(stat.uid)}, not this user (${String(uid)})`
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) return 'it is writable by group or others'
    const parsed = JSON.parse(await handle.readFile('utf8')) as unknown
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry !== '') ids.add(entry)
        else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'
          && entry[0] !== '' && entry[1] !== '') children.set(entry[0], entry[1])
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}
