import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTrustedJson, serialQueue, writePrivateFile } from '../src/private-file.ts'
import { tempDirs } from './support/tmp.ts'

const tempDir = tempDirs('dsh-private-file-')
const posix = process.platform !== 'win32'

describe('writePrivateFile', () => {
  it.skipIf(!posix)('writes 0600 through a temp file and replaces the previous contents', async () => {
    const dir = tempDir()
    const file = join(dir, 'nested', 'state.json')
    await writePrivateFile(file, '{"a":1}')
    await writePrivateFile(file, '{"a":2}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json'])
  })

  it.skipIf(!posix)('refuses a symlink at the target, naming what it holds', async () => {
    const dir = tempDir()
    const victim = join(dir, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(dir, 'state'))
    await expect(writePrivateFile(join(dir, 'state'), 'x', 'the session ledger')).rejects.toThrow(/refusing to write the session ledger through a symlink/u)
    expect(readFileSync(victim, 'utf8')).toBe('keep')
  })

  it('leaves no temp file behind when the rename fails', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'state'))
    await expect(writePrivateFile(join(dir, 'state'), 'x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['state'])
  })
})

describe('readTrustedJson', () => {
  it.skipIf(!posix)('reads a private regular file and ignores a symlink or a group/other-writable file', async () => {
    const dir = tempDir()
    const file = join(dir, 'state.json')
    expect(await readTrustedJson(file)).toEqual({ absent: true })
    writeFileSync(file, '[1]', { mode: 0o600 })
    expect(await readTrustedJson(file)).toEqual({ value: [1] })
    symlinkSync(file, join(dir, 'link.json'))
    expect(await readTrustedJson(join(dir, 'link.json'))).toEqual({ ignored: 'it is a symlink' })
    chmodSync(file, 0o622)
    expect(await readTrustedJson(file)).toEqual({ ignored: 'it is writable by group or others' })
    mkdirSync(join(dir, 'dir.json'))
    expect(await readTrustedJson(join(dir, 'dir.json'))).toEqual({ ignored: 'it is not a regular file' })
    writeFileSync(join(dir, 'broken.json'), '{', { mode: 0o600 })
    expect(await readTrustedJson(join(dir, 'broken.json'))).toEqual({ absent: true })
  })
})

describe('serialQueue', () => {
  it('runs tasks one at a time, in order, past a failure', async () => {
    const run = serialQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = run(() => new Promise<void>((resolve) => { releaseFirst = () => { order.push('first'); resolve() } }))
    const failing = run(async () => { order.push('failing'); throw new Error('nope') })
    const third = run(async () => { order.push('third'); return 3 })
    await Promise.resolve()
    expect(order).toEqual([])
    releaseFirst()
    await first
    await expect(failing).rejects.toThrow('nope')
    await expect(third).resolves.toBe(3)
    expect(order).toEqual(['first', 'failing', 'third'])
  })
})
