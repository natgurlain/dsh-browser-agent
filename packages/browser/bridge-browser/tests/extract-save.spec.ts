import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { normalizeSavePath, saveExtract, serializeRows, sessionWorkspaceDir } from '../src/extract-save.ts'
import { registerBrowserTools } from '../src/tools.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-extract-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('extract saving', () => {
  it('accepts only workspace-relative paths and infers the format', () => {
    expect(normalizeSavePath('out/rows.json')).toEqual({ relativePath: 'out/rows.json', format: 'json' })
    expect(normalizeSavePath('rows')).toEqual({ relativePath: 'rows.csv', format: 'csv' })
    expect(normalizeSavePath('rows', 'json')).toEqual({ relativePath: 'rows.json', format: 'json' })
    expect(() => normalizeSavePath('/etc/passwd')).toThrow(/absolute/)
    expect(() => normalizeSavePath('../escape.csv')).toThrow(/"\.\."/)
    expect(() => normalizeSavePath('a/../../b.csv')).toThrow(/"\.\."/)
    expect(() => normalizeSavePath('x.csv', 'xml')).toThrow(/csv or json/)
  })

  it('writes RFC 4180 CSV and neutralizes spreadsheet formulas', () => {
    const csv = serializeRows({
      columns: ['name', 'note', 'n'],
      rows: [{ name: 'Mug, large', note: 'say "hi"\nnow', n: 3 }, { name: '=HYPERLINK("x")', note: null, n: -2 }],
    }, 'csv')
    expect(csv).toBe('name,note,n\r\n"Mug, large","say ""hi""\nnow",3\r\n"\'=HYPERLINK(""x"")",,-2\r\n')
  })

  it('saves inside the workspace and refuses symlinked escapes', async () => {
    const workspace = tempDir()
    const outside = tempDir()
    const saved = await saveExtract(workspace, 'data/rows.json', { columns: ['a'], rows: [{ a: 1 }] })
    expect(saved).toMatchObject({ relativePath: 'data/rows.json', format: 'json', rowCount: 1 })
    expect(JSON.parse(readFileSync(join(workspace, 'data/rows.json'), 'utf8'))).toEqual([{ a: 1 }])
    mkdirSync(join(workspace, 'links'))
    symlinkSync(outside, join(workspace, 'links/out'))
    await expect(saveExtract(workspace, 'links/out/rows.csv', { columns: ['a'], rows: [] })).rejects.toThrow(/symbolic link/)
  })

  it('prefers the session working directory over the configured workspace', () => {
    expect(sessionWorkspaceDir({ session: { header: { cwd: '/work/session' } } }, '/fallback')).toBe('/work/session')
    expect(sessionWorkspaceDir({ session: { header: {} } }, '/fallback')).toBe('/fallback')
    expect(sessionWorkspaceDir(undefined, '')).toBeUndefined()
  })
})

describe('browser_extract tool', () => {
  function harness(result: unknown, workspacePath = '') {
    const registered = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    const ctx = {
      tools: {
        register: vi.fn((definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
          registered.set(definition.name, definition)
          return () => {}
        }),
      },
    } as unknown as Context
    const requestTool = vi.fn(async () => result)
    registerBrowserTools(ctx, { requestTool } as unknown as BridgeServer, {
      toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, workspacePath,
    })
    return { tool: registered.get('browser_extract')!, requestTool }
  }
  const RESULT = { text: 'Extracted 2 row(s).', data: { columns: ['name'], rows: [{ name: 'Mug' }, { name: 'Pen' }] } }

  it('returns the extension text without saveTo', async () => {
    const { tool, requestTool } = harness(RESULT)
    const exec = { signal: new AbortController().signal }
    await expect(tool.execute({ table: '#t' }, exec)).resolves.toEqual({ text: 'Extracted 2 row(s).' })
    expect(requestTool).toHaveBeenCalledWith('browser_extract', { table: '#t' }, exec.signal, 1_000)
  })

  it('writes the rows into the calling session workspace', async () => {
    const workspace = tempDir()
    const { tool } = harness(RESULT)
    const exec = { signal: new AbortController().signal, agent: { id: 's1', session: { header: { cwd: workspace } } } }
    const result = await tool.execute({ table: '#t', saveTo: 'exports/items.csv' }, exec) as { text: string }
    expect(result.text).toMatch(/^Saved 2 row\(s\) as CSV to exports\/items\.csv \(/)
    expect(readFileSync(join(workspace, 'exports/items.csv'), 'utf8')).toBe('name\r\nMug\r\nPen\r\n')
  })

  it('falls back to the configured workspace and refuses without one', async () => {
    const workspace = tempDir()
    const exec = { signal: new AbortController().signal }
    const configured = harness(RESULT, workspace)
    await configured.tool.execute({ table: '#t', saveTo: 'a.json' }, exec)
    expect(JSON.parse(readFileSync(join(workspace, 'a.json'), 'utf8'))).toHaveLength(2)

    const none = harness(RESULT)
    await expect(none.tool.execute({ table: '#t', saveTo: 'a.json' }, exec)).rejects.toThrow(/no workspace directory/)
    expect(none.requestTool).not.toHaveBeenCalled()
    await expect(none.tool.execute({ table: '#t', saveTo: '../a.json' }, exec)).rejects.toThrow(/"\.\."/)
  })
})
