/**
 * Private state files under the dsh home (token, MCP endpoint, session
 * ledger, watcher records, workflow schedules, audit head anchors): one
 * hardened writer, one trust-checked JSON reader, and a write queue.
 *
 * @module @natgurlain/dsh-bridge-browser/src/private-file
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Persist `contents` with 0600 permissions. A symlink at the target is refused.
 *
 * POSIX: the temp file is created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`,
 * random name, mode 0600) and renamed over the target, so the contents are
 * never visible with looser permissions and never written through a planted
 * link; a failed write removes the temp file.
 *
 * Windows: there are no POSIX mode bits, and a rename would replace the
 * target's ACL with the directory's inherited one. An existing file is
 * therefore rewritten in place (keeping any ACL the user tightened); only a
 * missing file goes through the exclusive temp + rename path. This branch is
 * not exercised by the Linux CI.
 * @param file - target path (its directory is created).
 * @param contents - the full new contents.
 * @param label - what the file holds, for error messages ("the bridge token").
 */
export async function writePrivateFile(file: string, contents: string, label = 'a private file'): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  let existing = false
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink()) throw new Error(`refusing to write ${label} through a symlink: ${file}`)
    existing = true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (process.platform === 'win32' && existing) {
    const handle = await open(file, constants.O_WRONLY | constants.O_TRUNC)
    try {
      await handle.writeFile(contents)
    } finally {
      await handle.close()
    }
    return
  }
  const temp = `${file}.tmp-${randomBytes(8).toString('hex')}`
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
  try {
    try {
      await handle.writeFile(contents)
      if (process.platform !== 'win32') await handle.chmod(0o600)
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error: unknown) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/** Outcome of {@link readTrustedJson}. */
export type TrustedJson =
  /** The file is trustworthy; its parsed contents. */
  | { value: unknown }
  /** The file exists but is not trusted (it grants access, so it is not read). */
  | { ignored: string }
  /** No file, unreadable, or not JSON. */
  | { absent: true }

/**
 * Read a JSON state file only when it is a regular file (never through a
 * symlink), owned by this user, and not writable by group or others.
 * @param file - path to read.
 */
export async function readTrustedJson(file: string): Promise<TrustedJson> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | O_NOFOLLOW)
  } catch (error: unknown) {
    return (error as { code?: string }).code === 'ELOOP' ? { ignored: 'it is a symlink' } : { absent: true }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { ignored: 'it is not a regular file' }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) return { ignored: `it is owned by uid ${String(stat.uid)}, not this user (${String(uid)})` }
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) return { ignored: 'it is writable by group or others' }
    return { value: JSON.parse(await handle.readFile('utf8')) as unknown }
  } catch {
    return { absent: true }
  } finally {
    await handle.close()
  }
}

/**
 * A FIFO for writes to one file: each task starts after the previous one
 * settled (fulfilled or not), so two saves never interleave.
 * @returns `run(task)`, resolving or rejecting with that task's outcome.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}
