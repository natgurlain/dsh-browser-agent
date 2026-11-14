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
 * @module @natgurlain/dsh-bridge-browser/src/session-ledger
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Most ids kept; the oldest are dropped first. */
const MAX_LEDGER_IDS = 10_000

/** Membership record of bridge-created sessions. */
export interface SessionLedger {
  has(sessionId: string): boolean
  add(sessionId: string): Promise<void>
}

/** In-memory ledger (tests, or when persistence is disabled). */
export function memorySessionLedger(ids: Iterable<string> = []): SessionLedger {
  const set = new Set(ids)
  return {
    has: (sessionId) => set.has(sessionId),
    add: async (sessionId) => { set.add(sessionId) },
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
  const untrusted = await loadTrusted(file, ids)
  if (untrusted !== undefined) warn(`browser bridge: ignoring session ledger ${file}: ${untrusted}`)
  let writing = Promise.resolve()
  const persist = async (): Promise<void> => {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${randomBytes(8).toString('hex')}`
    try {
      await writeFile(temp, JSON.stringify([...ids]), { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } catch (error: unknown) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }
  return {
    has: (sessionId) => ids.has(sessionId),
    add: async (sessionId) => {
      if (ids.has(sessionId)) return
      ids.add(sessionId)
      while (ids.size > MAX_LEDGER_IDS) ids.delete(ids.values().next().value as string)
      writing = writing.then(persist, persist).catch((error: unknown) => {
        warn(`browser bridge: could not persist the session ledger: ${error instanceof Error ? error.message : String(error)}`)
      })
      await writing
    },
  }
}

/**
 * Read the ledger into `ids` when the file is trustworthy.
 * @returns why the file was ignored, or undefined (loaded, or simply absent/unreadable).
 */
async function loadTrusted(file: string, ids: Set<string>): Promise<string | undefined> {
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
    if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string' && id !== '') ids.add(id)
    return undefined
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}
