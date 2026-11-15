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

describe('fleet children in the ledger', () => {
  it('owns a child only through an owned parent, and persists the link', async () => {
    const file = join(temp(), 'ledger.json')
    const ledger = await fileSessionLedger(file, () => {})
    await ledger.add('parent')
    await ledger.addChild!('child', 'parent')
    await ledger.addChild!('orphan', 'someone-elses-session')
    expect(ledger.has('child')).toBe(true)
    expect(ledger.has('orphan')).toBe(false)
    const reloaded = await fileSessionLedger(file, () => {})
    expect(reloaded.has('child')).toBe(true)
    expect(reloaded.has('parent')).toBe(true)
    expect(reloaded.has('orphan')).toBe(false)
  })

  it('applies the same rule in memory', async () => {
    const { memorySessionLedger } = await import('../src/session-ledger.ts')
    const ledger = memorySessionLedger(['p'])
    await ledger.addChild!('c', 'p')
    await ledger.addChild!('x', 'not-owned')
    await ledger.addChild!('p', 'p')
    expect([ledger.has('c'), ledger.has('x'), ledger.has('p')]).toEqual([true, false, true])
  })
})
