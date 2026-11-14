import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { registerPdfTool, safePdfName } from '../src/pdf-tools.ts'

const PDF = Buffer.from('%PDF-1.7\n%test\n').toString('base64')
const roots: string[] = []

function harness(result: unknown) {
  const registered: Record<string, unknown>[] = []
  const ctx = {
    tools: { register: vi.fn((definition: Record<string, unknown>) => { registered.push(definition); return () => {} }) },
  } as unknown as Context
  const requestTool = vi.fn(async () => result)
  const root = mkdtempSync(join(tmpdir(), 'dsh-pdf-'))
  roots.push(root)
  const directory = join(root, 'pdf')
  registerPdfTool(ctx, { requestTool } as unknown as BridgeServer, { toolTimeoutMs: 1_000, directory })
  const execute = registered[0]!.execute as (args: unknown, exec: unknown) => Promise<{ text: string; path: string; bytes: number }>
  return { execute, requestTool, directory }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('browser_save_pdf', () => {
  it('writes the rendered PDF into the workspace and reports its path', async () => {
    const { execute, requestTool, directory } = harness({ pdf: { data: PDF, title: 'Quarterly: report?', url: 'https://example.com/q' } })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-1' } }
    const result = await execute({ landscape: true }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_save_pdf', { landscape: true }, exec.signal, 1_000, 'session-1')
    expect(result.path).toBe(join(directory, 'Quarterly report.pdf'))
    expect(readFileSync(result.path, 'latin1')).toMatch(/^%PDF-/)
    expect(statSync(result.path).mode & 0o777).toBe(0o600)
    expect(result.text).toContain('from https://example.com/q')
    // A second save never overwrites the first.
    const again = await execute({}, { signal: new AbortController().signal })
    expect(again.path).toBe(join(directory, 'Quarterly report-2.pdf'))
    expect(readdirSync(directory).sort()).toEqual(['Quarterly report-2.pdf', 'Quarterly report.pdf'])
  })

  it('keeps model-chosen names inside the workspace', async () => {
    const { execute, directory } = harness({ pdf: { data: PDF } })
    const result = await execute({ filename: '../../etc/passwd' }, { signal: new AbortController().signal })
    expect(result.path).toBe(join(directory, 'passwd.pdf'))
    expect(safePdfName('..', 'fallback')).toBe('fallback.pdf')
    expect(safePdfName('a/b\\c.PDF', 'x')).toBe('c.pdf')
  })

  it('refuses data that is not a PDF', async () => {
    const { execute } = harness({ pdf: { data: Buffer.from('<html>').toString('base64') } })
    await expect(execute({}, { signal: new AbortController().signal })).rejects.toThrow(/not a PDF/)
  })
})
