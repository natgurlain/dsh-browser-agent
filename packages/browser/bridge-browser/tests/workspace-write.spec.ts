import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceWriteError, workspacePathComponents, workspaceWriteTarget, writeWorkspaceFile } from '../src/workspace-write.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wswrite-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const policyCtx = (mode: unknown, throws = false) => ({
  get: (name: string) => name === 'sandboxPolicy'
    ? { resolve: () => { if (throws) throw new Error('bad cwd'); return { mode, workspaceRoot: '/x' } } }
    : undefined,
})

describe('workspaceWriteTarget', () => {
  const agent = { id: 's', session: { header: { cwd: '/work/session' } } }

  it('uses the session cwd under a writable sandbox, the fallback for agentless calls', () => {
    expect(workspaceWriteTarget(policyCtx('workspace-write'), agent, '/fallback')).toEqual({ mode: 'workspace-write', root: '/work/session' })
    expect(workspaceWriteTarget(policyCtx('danger-full-access'), undefined, '/fallback')).toEqual({ mode: 'danger-full-access', root: '/fallback', createRoot: true })
  })

  it('refuses read-only, unknown, missing, or failing sandbox policies and a missing workspace', () => {
    expect(() => workspaceWriteTarget(policyCtx('read-only'), agent, '')).toThrow(/read-only/)
    expect(() => workspaceWriteTarget(policyCtx('weird'), agent, '')).toThrow(/unknown sandbox mode/)
    expect(() => workspaceWriteTarget(policyCtx('workspace-write', true), agent, '')).toThrow(/could not be resolved/)
    expect(() => workspaceWriteTarget({ get: () => undefined }, agent, '')).toThrow(/sandbox policy/)
    expect(() => workspaceWriteTarget({}, agent, '')).toThrow(WorkspaceWriteError)
    expect(() => workspaceWriteTarget(policyCtx('workspace-write'), undefined, '')).toThrow(/no workspace/)
  })
})

describe('workspacePathComponents', () => {
  const pdf = { allowedExt: ['.pdf'], defaultExt: '.pdf' }
  it('normalizes and appends the default extension', () => {
    expect(workspacePathComponents('./out//report', pdf)).toEqual(['out', 'report.pdf'])
    expect(workspacePathComponents('A.PDF', pdf)).toEqual(['A.PDF'])
  })
  it('refuses traversal, absolute paths, hidden components, control characters, and other extensions', () => {
    for (const bad of ['', '../a.pdf', '/etc/a.pdf', 'C:\\a.pdf', '\\\\srv\\a.pdf', '.github/a.pdf', 'a/.git/x.pdf', '.env.pdf', 'a\u0000.pdf', 'a.pdf.sh', 'conftest.py']) {
      expect(() => workspacePathComponents(bad, pdf), bad).toThrow(WorkspaceWriteError)
    }
  })
})

describe('writeWorkspaceFile', () => {
  it('writes bytes as a new file and refuses to replace it', async () => {
    const root = tempDir()
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const saved = await writeWorkspaceFile({ mode: 'workspace-write', root }, 'out/page', bytes, { allowedExt: ['.pdf'], defaultExt: '.pdf' })
    expect(saved.relativePath).toBe('out/page.pdf')
    expect(readFileSync(join(root, 'out/page.pdf'))).toEqual(Buffer.from(bytes))
    expect(statSync(join(root, 'out/page.pdf')).mode & 0o777).toBe(0o644 & ~process.umask())
    await expect(writeWorkspaceFile({ mode: 'workspace-write', root }, 'out/page.pdf', bytes, { allowedExt: ['.pdf'] })).rejects.toThrow(/already exists/)
    await expect(writeWorkspaceFile({ mode: 'workspace-write', root }, 'out/page.pdf', bytes, { allowedExt: ['.pdf'] })).rejects.toMatchObject({ reason: 'exists' })
  })

  it('creates the bridge-owned fallback workspace but never a missing session cwd', async () => {
    const base = tempDir()
    await expect(writeWorkspaceFile({ mode: 'workspace-write', root: join(base, 'gone') }, 'a.csv', 'x', { allowedExt: ['.csv'] })).rejects.toThrow(/not an existing directory/)
    const saved = await writeWorkspaceFile({ mode: 'workspace-write', root: join(base, 'bridge'), createRoot: true }, 'a.csv', 'x', { allowedExt: ['.csv'] })
    expect(readFileSync(saved.path, 'utf8')).toBe('x')
  })

  it('refuses a target whose mode is not writable even if constructed by hand', async () => {
    const root = tempDir()
    await expect(writeWorkspaceFile({ mode: 'read-only' as never, root }, 'a.pdf', 'x', { allowedExt: ['.pdf'] })).rejects.toThrow(/may not write/)
    expect(readdirSync(root)).toEqual([])
  })

  // race3: a sandboxed agent atomically flips `d` between a real directory and
  // a symlink to a directory outside the workspace while saves run.
  it.skipIf(process.platform !== 'linux')('lands nothing outside the workspace while a directory flips to a symlink (race3)', async () => {
    const base = tempDir()
    const ws = join(base, 'ws')
    const outside = join(base, 'outside')
    mkdirSync(ws)
    mkdirSync(outside)
    mkdirSync(join(ws, 'd'))
    const script = join(base, 'swap.mjs')
    writeFileSync(script, `import { renameSync, symlinkSync, mkdirSync } from 'node:fs'
process.chdir(${JSON.stringify(ws)}); symlinkSync(${JSON.stringify(outside)}, 'l')
const t = (f) => { try { f() } catch {} }
for (;;) { t(() => renameSync('d', 'd.real' + Math.random())); t(() => renameSync('l', 'd')); for (let i = 0; i < 2000; i++); t(() => renameSync('d', 'l')); t(() => mkdirSync('d')); for (let i = 0; i < 2000; i++); }`)
    const swap = spawn(process.execPath, [script], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      for (let i = 0; i < 300; i++) {
        await writeWorkspaceFile({ mode: 'workspace-write', root: ws }, `d/r${String(i)}.csv`, 'x', { allowedExt: ['.csv'] }).catch(() => {})
      }
    } finally {
      swap.kill('SIGKILL')
    }
    expect(readdirSync(outside)).toEqual([])
  }, 30_000)
})
