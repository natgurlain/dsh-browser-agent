/**
 * The one way the bridge writes a file into a session's workspace.
 *
 * Every bridge-side file write (`browser_extract { saveTo }`, PDF and
 * download saves) goes through {@link writeWorkspaceFile}:
 *
 * ```ts
 * const target = workspaceWriteTarget(ctx, exec.agent, options.workspacePath ?? '')
 * const saved = await writeWorkspaceFile(target, args.saveTo, pdfBytes, { allowedExt: ['.pdf'] })
 * // saved.relativePath / saved.path
 * ```
 *
 * What it guarantees:
 *
 * - the session's sandbox is asked first (`ctx.sandboxPolicy`, the same
 *   policy the Host's file tools and shell enforce): `read-only` refuses, and
 *   so does a Host whose policy cannot be determined;
 * - the path is workspace-relative, with an allowed extension, no `..`, and
 *   no dot-prefixed component (`.git`, `.github`, `.env`, `.vscode`), so a
 *   page cannot plant hooks, CI workflows, or editor config;
 * - an existing file is never replaced (`O_CREAT | O_EXCL`), so a save cannot
 *   overwrite `conftest.py`, a lockfile, or anything else the user owns;
 * - containment is checked before anything is created, and every directory
 *   is created and entered one component at a time without following
 *   symlinks. On Linux each step is relative to an already-open directory
 *   descriptor (`/proc/self/fd/<fd>/<name>`, the `openat` equivalent), so
 *   flipping a directory to a symlink mid-write cannot redirect it. Other
 *   platforms re-verify each component with `lstat` + `realpath` and publish
 *   the file with `link()`, which never replaces an existing entry; there a
 *   narrow race remains (an ancestor swapped between the check and the
 *   write), so only the Linux strategy fully closes the symlink-flip escape.
 *
 * The Host's sandboxed file service (`ctx.fs` from dsh-fs-sandbox) is not
 * used: it writes text only (PDFs are bytes), always replaces existing files,
 * and documents the ancestor-symlink race as accepted for its threat model.
 *
 * @module @natgurlain/dsh-bridge-browser/src/workspace-write
 */

import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { link, lstat, mkdir, open, readlink, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'

/** A refused or failed workspace write the model can act on. */
export class WorkspaceWriteError extends Error {
  /**
   * Machine-readable refusal kind, for callers that recover from one
   * (`exists`: the file is already there; `symlink`: the path goes through a
   * link or non-directory). Absent for every other refusal.
   */
  readonly reason: 'exists' | 'symlink' | undefined
  constructor(message: string, reason?: 'exists' | 'symlink') {
    super(message)
    this.name = 'WorkspaceWriteError'
    this.reason = reason
  }
}

/** Where and under which sandbox mode a write may happen. */
export interface WorkspaceWriteTarget {
  /** The session's sandbox mode as the Host resolves it. */
  mode: 'workspace-write' | 'danger-full-access'
  /** Absolute workspace root (the session's working directory). */
  root: string
  /**
   * The root is the bridge's own configured workspace (agentless calls,
   * sessions without a cwd) and may be created; a session cwd never is.
   */
  createRoot?: true
}

/** Where a write landed. */
export interface WorkspaceWriteResult {
  /** Absolute path of the new file. */
  path: string
  /** Normalized workspace-relative path. */
  relativePath: string
}

/** Options for {@link writeWorkspaceFile}. */
export interface WorkspaceWriteOptions {
  /** Lowercase extensions (with the dot) the file may have, e.g. `['.pdf']`. */
  allowedExt: readonly string[]
  /** Extension appended when the path has none (must be in `allowedExt`). */
  defaultExt?: string
  /** File mode for the new file (default 0o644). */
  mode?: number
  /** Tests only: use the portable path-based strategy even where `/proc` exists. */
  portable?: boolean
}

/** Most directory levels a relative path may have. */
const MAX_DEPTH = 16
/** Longest single component (bytes) most filesystems accept. */
const MAX_COMPONENT_BYTES = 255

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0

/**
 * Resolve where the calling session may write, asking the Host's sandbox
 * policy. Refuses when the policy service is missing or fails, when the
 * session is read-only, or when no workspace is known.
 * @param ctx - the plugin context (`ctx.get('sandboxPolicy')`).
 * @param agent - the calling Agent (`exec.agent`), when known.
 * @param fallbackWorkspace - workspace for agentless calls or sessions without a cwd ('' for none).
 * @returns the write target.
 */
export function workspaceWriteTarget(ctx: unknown, agent: unknown, fallbackWorkspace: string): WorkspaceWriteTarget {
  const get = (ctx as { get?: unknown } | undefined)?.get
  const service = typeof get === 'function'
    ? (get as (name: string) => unknown).call(ctx, 'sandboxPolicy') as { resolve?: unknown } | undefined
    : undefined
  if (typeof service?.resolve !== 'function') {
    throw new WorkspaceWriteError('the Host does not expose its sandbox policy, so the bridge cannot tell whether this session may write files; nothing was written.')
  }
  const session = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session
  let mode: unknown
  try {
    mode = (service.resolve as (request: object) => { mode?: unknown }).call(service, session === undefined ? {} : { session })?.mode
  } catch (error: unknown) {
    throw new WorkspaceWriteError(`the session's sandbox policy could not be resolved (${error instanceof Error ? error.message : String(error)}); nothing was written.`)
  }
  if (mode === 'read-only') {
    throw new WorkspaceWriteError('this session runs in a read-only sandbox, so the browser tools cannot write files into its workspace; nothing was written.')
  }
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new WorkspaceWriteError(`unknown sandbox mode ${JSON.stringify(mode)}; nothing was written.`)
  }
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return { mode, root: cwd }
  if (fallbackWorkspace === '' || !isAbsolute(fallbackWorkspace)) {
    throw new WorkspaceWriteError('this session has no workspace directory to write into.')
  }
  return { mode, root: fallbackWorkspace, createRoot: true }
}

/**
 * Validate a workspace-relative path without touching the filesystem.
 * @param relPath - the model-supplied path.
 * @param options - allowed and default extensions.
 * @returns the normalized path components (directories, then the file name).
 */
export function workspacePathComponents(relPath: string, options: Pick<WorkspaceWriteOptions, 'allowedExt' | 'defaultExt'>): string[] {
  const trimmed = relPath.trim()
  if (trimmed === '') throw new WorkspaceWriteError('the path must be a non-empty workspace-relative path.')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) throw new WorkspaceWriteError('the path contains control characters.')
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('\\') || trimmed.startsWith('/')) {
    throw new WorkspaceWriteError(`the path must be relative to the session workspace; "${relPath}" is absolute.`)
  }
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) {
    throw new WorkspaceWriteError(`the path must stay inside the session workspace; "${relPath}" contains "..".`)
  }
  if (parts.length === 0) throw new WorkspaceWriteError('the path must name a file.')
  if (parts.length > MAX_DEPTH) throw new WorkspaceWriteError(`the path is nested too deeply (more than ${String(MAX_DEPTH)} levels).`)
  const hidden = parts.find((part) => part.startsWith('.'))
  if (hidden !== undefined) {
    throw new WorkspaceWriteError(`hidden files and directories ("${hidden}") cannot be written from the browser tools (.git, .github, .env, …); choose a visible path.`)
  }
  let name = parts[parts.length - 1]!
  const ext = extname(name).toLowerCase()
  if (ext === '' && options.defaultExt !== undefined) name = `${name}${options.defaultExt}`
  const finalExt = extname(name).toLowerCase()
  if (!options.allowedExt.includes(finalExt)) {
    throw new WorkspaceWriteError(`only ${options.allowedExt.join(', ')} files can be written here; "${relPath}" has ${finalExt === '' ? 'no extension' : `"${finalExt}"`}.`)
  }
  parts[parts.length - 1] = name
  for (const part of parts) {
    if (Buffer.byteLength(part) > MAX_COMPONENT_BYTES) throw new WorkspaceWriteError('a path component is too long.')
  }
  return parts
}

/** Whether `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

function symlinkRefusal(relPath: string): WorkspaceWriteError {
  return new WorkspaceWriteError(`the path goes through a symbolic link or a non-directory: "${relPath}"; nothing was written.`, 'symlink')
}

function existsRefusal(relPath: string): WorkspaceWriteError {
  return new WorkspaceWriteError(`"${relPath}" already exists; existing files are never overwritten. Choose a new file name.`, 'exists')
}

/** Whether descriptor-relative paths (`/proc/self/fd/<fd>/<name>`) work here. */
function descriptorPathsAvailable(): boolean {
  return process.platform === 'linux' && existsSync('/proc/self/fd')
}

/**
 * Create a new file inside the session workspace.
 * @param target - from {@link workspaceWriteTarget}.
 * @param relPath - workspace-relative path the model asked for.
 * @param bytes - the file contents.
 * @param options - allowed extensions and file mode.
 * @returns where the file landed.
 */
export async function writeWorkspaceFile(
  target: WorkspaceWriteTarget,
  relPath: string,
  bytes: Uint8Array | string,
  options: WorkspaceWriteOptions,
): Promise<WorkspaceWriteResult> {
  if (target.mode !== 'workspace-write' && target.mode !== 'danger-full-access') {
    throw new WorkspaceWriteError('this session may not write files; nothing was written.')
  }
  const parts = workspacePathComponents(relPath, options)
  const relativePath = parts.join('/')
  let root: string
  try {
    if (target.createRoot === true) await mkdir(target.root, { recursive: true, mode: 0o700 })
    root = await realpath(target.root)
    if (!(await lstat(root)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new WorkspaceWriteError(`the session workspace ${JSON.stringify(target.root)} is not an existing directory.`)
  }
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  const fileMode = options.mode ?? 0o644
  const path = options.portable !== true && descriptorPathsAvailable()
    ? await writeRelativeToDescriptors(root, parts, data, fileMode, relativePath)
    : await writeByVerifiedPaths(root, parts, data, fileMode, relativePath)
  return { path, relativePath }
}

/** Linux: every step is relative to an open, verified directory descriptor. */
async function writeRelativeToDescriptors(root: string, parts: string[], data: Uint8Array, mode: number, relPath: string): Promise<string> {
  let directory: FileHandle = await open(root, constants.O_RDONLY | O_DIRECTORY)
  try {
    for (const component of parts.slice(0, -1)) {
      const at = `/proc/self/fd/${String(directory.fd)}/${component}`
      try {
        await mkdir(at, { mode: 0o755 })
      } catch (error: unknown) {
        if (codeOf(error) !== 'EEXIST') throw error
      }
      let next: FileHandle
      try {
        next = await open(at, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      } catch (error: unknown) {
        if (codeOf(error) === 'ELOOP' || codeOf(error) === 'ENOTDIR') throw symlinkRefusal(relPath)
        throw error
      }
      await directory.close()
      directory = next
    }
    const where = await readlink(`/proc/self/fd/${String(directory.fd)}`)
    if (!within(root, where)) throw symlinkRefusal(relPath)
    const name = parts[parts.length - 1]!
    let file: FileHandle
    try {
      file = await open(`/proc/self/fd/${String(directory.fd)}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode)
    } catch (error: unknown) {
      if (codeOf(error) === 'EEXIST') throw existsRefusal(relPath)
      throw error
    }
    try {
      await file.writeFile(data)
    } finally {
      await file.close()
    }
    return join(where, name)
  } finally {
    await directory.close().catch(() => {})
  }
}

/** Portable: create and re-verify each component by path, publish with link(). */
async function writeByVerifiedPaths(root: string, parts: string[], data: Uint8Array, mode: number, relPath: string): Promise<string> {
  let directory = root
  const verify = async (path: string): Promise<string> => {
    const stat = await lstat(path)
    if (!stat.isDirectory()) throw symlinkRefusal(relPath)
    const real = await realpath(path)
    if (!within(root, real)) throw symlinkRefusal(relPath)
    return real
  }
  for (const component of parts.slice(0, -1)) {
    const next = join(directory, component)
    try {
      await mkdir(next, { mode: 0o755 })
    } catch (error: unknown) {
      if (codeOf(error) !== 'EEXIST') throw error
    }
    directory = await verify(next)
  }
  const name = parts[parts.length - 1]!
  const temporary = join(directory, `.dsh-${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode)
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
  const final = join(directory, name)
  try {
    // link() never replaces an existing entry and does not follow a symlink there.
    await link(temporary, final)
  } catch (error: unknown) {
    if (codeOf(error) === 'EEXIST') throw existsRefusal(relPath)
    throw error
  } finally {
    await unlink(temporary).catch(() => {})
  }
  // Re-verify after publishing: a directory swapped mid-write is caught here.
  if (!within(root, await realpath(directory))) {
    await unlink(final).catch(() => {})
    throw symlinkRefusal(relPath)
  }
  return final
}
