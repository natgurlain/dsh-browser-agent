/**
 * Durable record of the sessions this bridge created, so the extension keeps
 * access to its own conversations across restarts and never gains access to
 * Desktop, CLI, or subagent sessions.
 *
 * The file is a JSON array of session ids under the dsh home, written with
 * mode 0600 through an exclusive temp file and an atomic rename. A missing or
 * unreadable file starts empty (the bridge then only reaches sessions it
 * creates from now on, plus the workspace-path marker in bridge-policy.ts).
 *
 * @module @natgurlain/dsh-bridge-browser/src/session-ledger
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
  try {
    if (!(await lstat(file)).isSymbolicLink()) {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string' && id !== '') ids.add(id)
    } else {
      warn(`browser bridge: ignoring session ledger ${file}: it is a symlink`)
    }
  } catch {
    // Absent or unreadable: start empty.
  }
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
