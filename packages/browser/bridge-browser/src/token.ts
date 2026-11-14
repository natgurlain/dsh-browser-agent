/**
 * Bridge bearer-token lifecycle: generation, constant-time verification, and
 * file persistence under the dsh home directory.
 *
 * The token authenticates the browser extension against the bridge WebSocket.
 * It is NOT the /api trust fence (that stays untouched); it is the bridge
 * path's own auth because the bridge route lives outside the fence by design.
 *
 * @module
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** File name of the persisted token inside the dsh home. */
export const TOKEN_FILE_NAME = 'ext-bridge-token'

/** Directory the installers copy the unpacked Chrome extension into (under the dsh home). */
export const INSTALLED_EXTENSION_DIR_NAME = 'browser-extension'

/**
 * Token copy inside the installed extension, read by the extension through
 * `chrome.runtime.getURL` (it is not a web-accessible resource).
 */
export const INSTALLED_TOKEN_FILE_NAME = 'bridge-token'

/** Minimum length of a token pinned in the plugin config. */
export const MIN_CONFIGURED_TOKEN_LENGTH = 32

/** Minimum estimated entropy (bits) of a token pinned in the plugin config. */
const MIN_CONFIGURED_TOKEN_BITS = 80

/** Minimum number of distinct characters in a configured token. */
const MIN_CONFIGURED_TOKEN_DISTINCT = 8

/** Minimum share of distinct 3-character substrings (catches repeated blocks such as `abc123`×6). */
const MIN_DISTINCT_TRIGRAM_RATIO = 0.75

/** Largest share of constant character steps (catches runs such as `0123…uv` or `aceg…`). */
const MAX_CONSTANT_STEP_RATIO = 0.4

/** `O_NOFOLLOW` where the platform has it (not on Windows; the lstat check covers that case). */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Why a token pinned in the plugin config is too weak, or `undefined` when it
 * is acceptable. Handshake transcripts let anyone who observes the loopback
 * traffic test token guesses offline, so a configured token must carry real
 * entropy: at least {@link MIN_CONFIGURED_TOKEN_LENGTH} printable ASCII
 * characters, {@link MIN_CONFIGURED_TOKEN_DISTINCT} distinct ones, and an
 * estimated {@link MIN_CONFIGURED_TOKEN_BITS} bits (per-character Shannon
 * entropy × length), and no low-entropy structure that Shannon entropy
 * misses: repeated blocks (few distinct 3-character substrings) or
 * arithmetic runs (`0123456789abcdef…`). `openssl rand -hex 32` (or 16)
 * always passes.
 * @param token - the configured token.
 * @returns a human-readable problem, or undefined.
 */
export function configuredTokenProblem(token: string): string | undefined {
  if (!/^[\x21-\x7e]*$/u.test(token)) return 'it must be printable ASCII without spaces'
  if (token.length < MIN_CONFIGURED_TOKEN_LENGTH) {
    return `it must be at least ${String(MIN_CONFIGURED_TOKEN_LENGTH)} characters long`
  }
  const counts = new Map<string, number>()
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
  if (counts.size < MIN_CONFIGURED_TOKEN_DISTINCT) {
    return `it must use at least ${String(MIN_CONFIGURED_TOKEN_DISTINCT)} distinct characters`
  }
  let perChar = 0
  for (const count of counts.values()) {
    const p = count / token.length
    perChar -= p * Math.log2(p)
  }
  if (perChar * token.length < MIN_CONFIGURED_TOKEN_BITS) return 'it is too predictable (low entropy)'
  const trigrams = new Set<string>()
  for (let index = 0; index + 3 <= token.length; index += 1) trigrams.add(token.slice(index, index + 3))
  if (trigrams.size / (token.length - 2) < MIN_DISTINCT_TRIGRAM_RATIO) return 'it repeats the same characters (low entropy)'
  let constantSteps = 0
  for (let index = 2; index < token.length; index += 1) {
    if (token.charCodeAt(index) - token.charCodeAt(index - 1) === token.charCodeAt(index - 1) - token.charCodeAt(index - 2)) constantSteps += 1
  }
  if (constantSteps / (token.length - 2) > MAX_CONSTANT_STEP_RATIO) return 'it is a predictable sequence (low entropy)'
  return undefined
}

/**
 * Generate a fresh token as lowercase hex.
 * @param bytes - 随机数据的字节数，默认 32（256 位）。
 * @returns the hex token string.
 */
export function generateToken(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * Constant-time token comparison. Length mismatch fails fast (still constant
 * time on the compared prefix) — a wrong-length token can never verify.
 * @param expected - the configured token.
 * @param actual - the token presented by the client.
 * @returns true only when both are equal-length hex and byte-equal.
 */
export function verifyToken(expected: string, actual: string): boolean {
  // UTF-8 byte comparison, not hex decoding: hex would silently truncate
  // non-hex configured tokens (Buffer.from('fixed-token','hex') is empty)
  // and collapse 'deadbeef-team' to 'deadbeef', losing token entropy.
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * Path of the persisted token file under the dsh home.
 * @returns absolute path like `~/.dsh/ext-bridge-token`.
 */
export function tokenFilePath(): string {
  return dshHomePath(TOKEN_FILE_NAME)
}

/**
 * Read the persisted token; returns undefined when absent, unreadable, or a
 * symlink (never followed: a planted link would let another local user choose
 * the token). A file readable by group/others is tightened to 0600 on POSIX;
 * when that fails the token is treated as absent so the caller regenerates it.
 * @param file - token file path.
 * @returns the stored token, trimmed.
 */
export async function readTokenFile(file: string = tokenFilePath()): Promise<string | undefined> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return undefined
    const handle = await open(file, constants.O_RDONLY | O_NOFOLLOW)
    try {
      if (process.platform !== 'win32' && ((await handle.stat()).mode & 0o077) !== 0) {
        await handle.chmod(0o600)
      }
      return (await handle.readFile('utf8')).trim()
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Persist a token with 0600 permissions. A symlink at the target is refused.
 *
 * POSIX: the temp file is created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`,
 * random name, mode 0600) and renamed over the target, so the token is never
 * visible with looser permissions and never written through a planted link.
 *
 * Windows: there are no POSIX mode bits, and a rename would replace the
 * target's ACL with the directory's inherited one. An existing file is
 * therefore rewritten in place (keeping any ACL the user tightened); only a
 * missing file goes through the exclusive temp + rename path. This branch is
 * not exercised by the Linux CI.
 * @param token - token to persist.
 * @param file - token file path.
 */
export async function writeTokenFile(token: string, file: string = tokenFilePath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  let existing = false
  try {
    const info = await lstat(file)
    if (info.isSymbolicLink()) throw new Error(`refusing to write the bridge token through a symlink: ${file}`)
    existing = true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const contents = `${token}\n`
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

/**
 * Resolve the bridge token: an explicitly configured token wins; otherwise the
 * persisted file is reused when present, and a fresh token is generated and
 * persisted otherwise.
 * @param configured - token from plugin config, or undefined.
 * @param file - token file path (injectable for tests).
 * @returns `{ token, file, generated }` where `generated` records whether a new token was minted.
 */
export async function resolveToken(
  configured: string | undefined,
  file: string = tokenFilePath(),
): Promise<{ token: string; file: string; generated: boolean }> {
  if (configured !== undefined && configured.length > 0) {
    const problem = configuredTokenProblem(configured)
    if (problem !== undefined) {
      throw new Error(
        `bridge-browser: the configured \`token\` is too weak (${problem}). Remove it to use the generated token, `
        + `or set at least ${String(MIN_CONFIGURED_TOKEN_LENGTH)} random characters (for example \`openssl rand -hex 32\`).`,
      )
    }
    return { token: configured, file, generated: false }
  }
  const persisted = await readTokenFile(file)
  if (persisted !== undefined && persisted.length > 0) return { token: persisted, file, generated: false }
  const token = generateToken()
  await writeTokenFile(token, file)
  return { token, file, generated: true }
}

/**
 * Keep the installed extension's token copy in step with the bridge token, so
 * a regenerated token (deleted file, fresh dsh home) still connects without
 * any pasting. Only touches a directory the installer marked with
 * `install-info.json`; the copy is written atomically with 0600 permissions.
 * @param token - the token the bridge verifies.
 * @param dir - installed extension directory.
 * @returns what happened, for logging.
 */
export async function syncInstalledExtensionToken(
  token: string,
  dir: string = dshHomePath(INSTALLED_EXTENSION_DIR_NAME),
): Promise<'absent' | 'unchanged' | 'written'> {
  try {
    await stat(join(dir, 'install-info.json'))
  } catch {
    return 'absent'
  }
  const target = join(dir, INSTALLED_TOKEN_FILE_NAME)
  // readTokenFile tightens a loose copy and never follows a symlink; a link
  // reads as absent and writeTokenFile then refuses it.
  if (await readTokenFile(target) === token) return 'unchanged'
  await writeTokenFile(token, target)
  return 'written'
}

/**
 * Whether the installed Chrome extension carries a token copy that differs
 * from the active one. With a token pinned in the plugin config the copy is
 * deliberately not synced, so a stale installer copy makes the extension fail
 * the handshake; callers log this so the user knows to paste the token or
 * remove the pin.
 * @param token - the token the bridge verifies.
 * @param dir - installed extension directory.
 * @returns true only for an installer-marked directory whose copy exists and differs.
 */
export async function installedTokenMismatch(
  token: string,
  dir: string = dshHomePath(INSTALLED_EXTENSION_DIR_NAME),
): Promise<boolean> {
  try {
    await stat(join(dir, 'install-info.json'))
  } catch {
    return false
  }
  const copy = await readTokenFile(join(dir, INSTALLED_TOKEN_FILE_NAME))
  return copy !== undefined && copy !== '' && copy !== token
}
