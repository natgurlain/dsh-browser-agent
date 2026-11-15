import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { tempDirs } from './support/tmp.ts'
import {
  configuredTokenProblem,
  generateToken,
  installedTokenMismatch,
  readTokenFile,
  resolveToken,
  syncInstalledExtensionToken,
  verifyToken,
  writeTokenFile,
} from '../src/token.ts'

const tokenDir = tempDirs('dsh-bridge-token-')
const extDir = tempDirs('dsh-ext-')

const STRONG = 'Zq7-kP2x_Lm9vB4nRw6Yc1Hd5Je0uTa8sF3g'

describe('token', () => {
  it('generates hex tokens of the requested entropy', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(generateToken(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('verifies byte equality and rejects mismatches and bad shapes', () => {
    const token = generateToken()
    expect(verifyToken(token, token)).toBe(true)
    expect(verifyToken(token, generateToken())).toBe(false)
    expect(verifyToken(token, '')).toBe(false)
    expect(verifyToken('', token)).toBe(false)
    expect(verifyToken('zz', 'zzz')).toBe(false)
  })

  it('compares non-hex configured tokens as UTF-8 bytes (no hex truncation)', () => {
    expect(verifyToken('fixed-token', 'fixed-token')).toBe(true)
    expect(verifyToken('fixed-token', 'fixed-token ')).toBe(false)
    // hex 解码会把 deadbeef-team 截断成 deadbeef；UTF-8 比较不会
    expect(verifyToken('deadbeef-team', 'deadbeef')).toBe(false)
    expect(verifyToken('deadbeef-team', 'deadbeef-team')).toBe(true)
  })

  // Windows has no POSIX permission bits: chmod 0600 leaves the file at 0666,
  // so the file-mode half of this contract is verifiable only on POSIX hosts.
  it.skipIf(process.platform === 'win32')('persists tokens with 0600 permissions and round-trips', async () => {
    const dir = tokenDir()
    const file = join(dir, 'token')
    const token = generateToken()
    await writeTokenFile(token, file)
    expect((await readFile(file, 'utf8')).trim()).toBe(token)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const resolved = await resolveToken(undefined, file)
    expect(resolved.token).toBe(token)
    expect(resolved.generated).toBe(false)
  })

  it('generates and persists a fresh token when nothing is configured', async () => {
    const dir = tokenDir()
    const file = join(dir, 'token')
    const resolved = await resolveToken(undefined, file)
    expect(resolved.generated).toBe(true)
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/)
    expect((await readFile(file, 'utf8')).trim()).toBe(resolved.token)
  })

  it('prefers the configured token without touching the file', async () => {
    const dir = tokenDir()
    const file = join(dir, 'token')
    const resolved = await resolveToken(STRONG, file)
    expect(resolved).toEqual({ token: STRONG, file, generated: false })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('accepts every generated random token (no false positives from the repeat and sequence checks)', () => {
    for (const bytes of [16, 32]) {
      for (let index = 0; index < 2000; index += 1) {
        const token = generateToken(bytes)
        expect(configuredTokenProblem(token), token).toBeUndefined()
      }
    }
  })

  it('refuses weak configured tokens with an error naming the config key', async () => {
    const dir = tokenDir()
    for (const weak of [
      'fixed-token', 'a'.repeat(64), 'ab'.repeat(32), 'password'.repeat(4), `${STRONG} `,
      // N6: Shannon entropy alone passes these.
      '0123456789abcdef'.repeat(4), 'abcdefghij'.repeat(4), 'Tr0ub4dor&3xyzQ'.repeat(3),
      '0123456789abcdefghijklmnopqrstuvwxyzABCD', 'acegikmoqsuwyACEGIKMOQSUWY02468BDFH',
    ]) {
      expect(configuredTokenProblem(weak)).toBeTypeOf('string')
      await expect(resolveToken(weak, join(dir, 'token'))).rejects.toThrow(/`token`/)
    }
    expect(configuredTokenProblem(generateToken())).toBeUndefined()
    expect(configuredTokenProblem(generateToken(16))).toBeUndefined()
    expect(configuredTokenProblem(STRONG)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('refuses to write a token through a symlink', async () => {
    const dir = tokenDir()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'keep\n')
    const file = join(dir, 'token')
    await symlink(victim, file)
    await expect(writeTokenFile(generateToken(), file)).rejects.toThrow(/symlink/)
    expect(await readFile(victim, 'utf8')).toBe('keep\n')
    expect(await readTokenFile(file)).toBeUndefined()
    expect((await readdir(dir)).sort()).toEqual(['token', 'victim'])
  })

  it.skipIf(process.platform === 'win32')('leaves no temp files and tightens a loose persisted token to 0600', async () => {
    const dir = tokenDir()
    const file = join(dir, 'token')
    const token = generateToken()
    await writeTokenFile(token, file)
    expect(await readdir(dir)).toEqual(['token'])
    await chmod(file, 0o644)
    expect((await resolveToken(undefined, file)).token).toBe(token)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})

describe('syncInstalledExtensionToken', () => {
  it('leaves directories the installer did not create alone', async () => {
    const dir = extDir()
    expect(await syncInstalledExtensionToken('t', dir)).toBe('absent')
    await expect(stat(join(dir, 'bridge-token'))).rejects.toThrow()
  })

  it('writes the token once with owner-only permissions and then reports it unchanged', async () => {
    const dir = extDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'install-info.json'), '{}')
    expect(await syncInstalledExtensionToken('first', dir)).toBe('written')
    expect(await readFile(join(dir, 'bridge-token'), 'utf8')).toBe('first\n')
    if (process.platform !== 'win32') expect((await stat(join(dir, 'bridge-token'))).mode & 0o777).toBe(0o600)
    expect(await syncInstalledExtensionToken('first', dir)).toBe('unchanged')
    expect(await syncInstalledExtensionToken('second', dir)).toBe('written')
    expect(await readFile(join(dir, 'bridge-token'), 'utf8')).toBe('second\n')
  })
})

describe('syncInstalledExtensionToken hardening', () => {
  async function installed(): Promise<string> {
    const dir = extDir()
    await writeFile(join(dir, 'install-info.json'), '{}')
    return dir
  }

  it.skipIf(process.platform === 'win32')('refuses a symlinked installed copy instead of writing through it', async () => {
    const dir = await installed()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'keep\n')
    await symlink(victim, join(dir, 'bridge-token'))
    await expect(syncInstalledExtensionToken('next', dir)).rejects.toThrow(/symlink/)
    expect(await readFile(victim, 'utf8')).toBe('keep\n')
  })

  it.skipIf(process.platform === 'win32')('tightens a loose unchanged copy', async () => {
    const dir = await installed()
    await writeFile(join(dir, 'bridge-token'), 'same\n', { mode: 0o644 })
    await chmod(join(dir, 'bridge-token'), 0o644)
    expect(await syncInstalledExtensionToken('same', dir)).toBe('unchanged')
    expect((await stat(join(dir, 'bridge-token'))).mode & 0o777).toBe(0o600)
  })
})

describe('installedTokenMismatch', () => {
  it('reports only an installed copy that differs from the active token', async () => {
    const plain = extDir()
    expect(await installedTokenMismatch('t', plain)).toBe(false)
    await writeFile(join(plain, 'install-info.json'), '{}')
    expect(await installedTokenMismatch('t', plain)).toBe(false)
    await writeFile(join(plain, 'bridge-token'), 't\n')
    expect(await installedTokenMismatch('t', plain)).toBe(false)
    expect(await installedTokenMismatch('other', plain)).toBe(true)
  })
})
