import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileSessionLedger } from '../src/session-ledger.ts'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fileSessionLedger', () => {
  it('loads a private ledger and persists additions', async () => {
    const file = join(temp(), 'ledger.json')
    writeFileSync(file, JSON.stringify(['a']), { mode: 0o600 })
    const warn = vi.fn()
    const ledger = await fileSessionLedger(file, warn)
    expect(ledger.has('a')).toBe(true)
    await ledger.add('b')
    expect((await fileSessionLedger(file, warn)).has('b')).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('ignores a ledger writable by group or others, and a symlinked one', async () => {
    const dir = temp()
    const file = join(dir, 'ledger.json')
    writeFileSync(file, JSON.stringify(['victim-session']))
    chmodSync(file, 0o666)
    const warn = vi.fn()
    expect((await fileSessionLedger(file, warn)).has('victim-session')).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writable by group or others'))
    chmodSync(file, 0o600)
    const link = join(dir, 'link.json')
    symlinkSync(file, link)
    const warnLink = vi.fn()
    expect((await fileSessionLedger(link, warnLink)).has('victim-session')).toBe(false)
    expect(warnLink).toHaveBeenCalledWith(expect.stringContaining('symlink'))
  })
})
