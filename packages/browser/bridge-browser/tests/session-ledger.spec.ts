import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fileSessionLedger } from '../src/session-ledger.ts'
import { tempDirs } from './support/tmp.ts'

const temp = tempDirs('dsh-ledger-')

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

  it('persists external sessions apart from owned ones, readable by older bridges as plain ids only', async () => {
    const file = join(temp(), 'ledger.json')
    const warn = vi.fn()
    const ledger = await fileSessionLedger(file, warn)
    await ledger.add('owned')
    const record = { kind: 'mcp' as const, client: 'cursor', createdAt: '2026-01-01T00:00:00Z' }
    await ledger.addExternal('mcp-1', record)
    expect(ledger.has('mcp-1')).toBe(false)
    await expect(ledger.addExternal('owned', record)).rejects.toThrow(/cannot become external/)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    expect(raw.filter((row) => typeof row === 'string')).toEqual(['owned'])
    const reloaded = await fileSessionLedger(file, warn)
    expect(reloaded.has('owned')).toBe(true)
    expect(reloaded.has('mcp-1')).toBe(false)
    expect(reloaded.external('mcp-1')).toEqual(record)
    expect(reloaded.external('owned')).toBeUndefined()
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
