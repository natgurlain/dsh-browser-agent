import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  installSessionTaint,
  resultTaintsSession,
  SessionTaintRegistry,
  toolAllowedWhileTainted,
  withTaintMethods,
} from '../src/session-taint.ts'
import { BRIDGE_TAINT_CLEAR_METHOD, BRIDGE_TAINT_MARK_METHOD } from '../src/protocol.ts'
import type { BrowserHostApi } from '../src/host-api.ts'

type Guard = (exec: { name: string; agent?: { id: unknown } }) => string | undefined
type ResultListener = (exec: { name: string; agent?: { id: unknown } }, result: { isError: boolean }) => void

function fakeContext(withGuard = true) {
  const guards: Guard[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => { listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener)) }
    },
    tools: withGuard
      ? { guard: (guard: Guard) => { guards.push(guard); return () => { guards.splice(guards.indexOf(guard), 1) } } }
      : {},
  }
  const result: ResultListener = (exec, value) => { for (const listener of listeners.get('tools/result') ?? []) listener(exec, value) }
  const check = async (exec: { name: string; agent?: { id: unknown } }): Promise<string | undefined> => {
    for (const guard of guards) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    for (const listener of listeners.get('tools/pre-execute') ?? []) {
      const decision = await listener(exec, async () => ({ kind: 'allow' })) as { kind: string; reason?: string }
      if (decision.kind === 'deny') return decision.reason
    }
    return undefined
  }
  return { ctx: ctx as unknown as Context, result, check, guards, listeners }
}

const agent = (id: string) => ({ id })

describe('session taint (Host side)', () => {
  it('classifies results and allowed tools', () => {
    expect(resultTaintsSession('browser_get_text', false)).toBe(true)
    // Errors can quote the page (dialog text): they taint too.
    expect(resultTaintsSession('browser_get_text', true)).toBe(true)
    expect(resultTaintsSession('browser_follow_tab', false)).toBe(false)
    expect(resultTaintsSession('bash', false)).toBe(false)
    for (const name of ['read', 'grep', 'glob', 'browser_click', 'ask_user_question']) expect(toolAllowedWhileTainted(name)).toBe(true)
    for (const name of ['bash', 'pwsh', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'web_fetch', 'web_search', 'agent', 'schedule_create', 'terminal_send', 'mcp__x__y']) {
      expect(toolAllowedWhileTainted(name)).toBe(false)
    }
  })

  it('makes a tainted session read-only for harness tools until cleared, per session', async () => {
    const registry = new SessionTaintRegistry()
    const { ctx, result, check, guards } = fakeContext()
    const dispose = installSessionTaint(ctx, registry)
    expect(await check({ name: 'bash', agent: agent('s1') })).toBeUndefined()
    // Non-browser results do not taint; a browser result does.
    result({ name: 'bash', agent: agent('s1') }, { isError: false })
    expect(await check({ name: 'bash', agent: agent('s1') })).toBeUndefined()
    result({ name: 'browser_snapshot', agent: agent('s1') }, { isError: false })
    expect(await check({ name: 'bash', agent: agent('s1') })).toMatch(/untrusted web page content.*clears the session/)
    expect(await check({ name: 'write', agent: agent('s1') })).toBeDefined()
    expect(await check({ name: 'web_fetch', agent: agent('s1') })).toBeDefined()
    // Reads are path-scoped to the workspace; with none known they fail closed.
    expect(await check({ name: 'read', agent: agent('s1') })).toMatch(/workspace/)
    expect(await check({ name: 'browser_click', agent: agent('s1') })).toBeUndefined()
    // Other sessions are unaffected.
    expect(await check({ name: 'bash', agent: agent('s2') })).toBeUndefined()
    registry.clear('s1')
    expect(await check({ name: 'bash', agent: agent('s1') })).toBeUndefined()
    dispose()
    expect(guards).toHaveLength(0)
  })

  it('falls back to a pre-execute denial when the registry has no guard()', async () => {
    const registry = new SessionTaintRegistry()
    registry.mark('s1', 'browser_get_text')
    const { ctx, check } = fakeContext(false)
    installSessionTaint(ctx, registry)
    expect(await check({ name: 'bash', agent: agent('s1') })).toBeDefined()
    expect(await check({ name: 'todo_write', agent: agent('s1') })).toBeUndefined()
  })

  it('serves the clear RPC at the bridge, scoped to sessions the bridge may own', async () => {
    const registry = new SessionTaintRegistry()
    registry.mark('mine', 'browser_snapshot')
    registry.mark('other', 'browser_snapshot')
    const inner: BrowserHostApi = { call: vi.fn(async () => ({ ok: true as const, value: 'forwarded' })), events: vi.fn(), respond: vi.fn() } as unknown as BrowserHostApi
    const api = withTaintMethods(inner, registry, async (id) => id === 'mine')
    const signal = new AbortController().signal
    expect(await api.call({ rpcId: '1', method: BRIDGE_TAINT_CLEAR_METHOD, payload: { sessionId: 'mine' }, signal })).toEqual({ ok: true, value: { cleared: true } })
    expect(registry.isTainted('mine')).toBe(false)
    expect(await api.call({ rpcId: '2', method: BRIDGE_TAINT_CLEAR_METHOD, payload: { sessionId: 'other' }, signal })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(registry.isTainted('other')).toBe(true)
    expect(await api.call({ rpcId: '3', method: BRIDGE_TAINT_CLEAR_METHOD, payload: { sessionId: null }, signal })).toEqual({ ok: true, value: { cleared: false } })
    expect(await api.call({ rpcId: '4', method: BRIDGE_TAINT_CLEAR_METHOD, payload: { sessionId: 7 }, signal })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(inner.call).not.toHaveBeenCalled()
    expect(await api.call({ rpcId: '5', method: 'session.list', payload: {}, signal })).toEqual({ ok: true, value: 'forwarded' })
  })

  it('serves the mark RPC (selection attachments) at the bridge', async () => {
    const registry = new SessionTaintRegistry()
    const inner: BrowserHostApi = { call: vi.fn(async () => ({ ok: true as const, value: 'forwarded' })), events: vi.fn(), respond: vi.fn() } as unknown as BrowserHostApi
    const api = withTaintMethods(inner, registry, async () => false)
    const signal = new AbortController().signal
    expect(await api.call({ rpcId: '1', method: BRIDGE_TAINT_MARK_METHOD, payload: { sessionId: 's1' }, signal })).toEqual({ ok: true, value: { marked: true } })
    expect(registry.isTainted('s1')).toBe(true)
    expect(await api.call({ rpcId: '2', method: BRIDGE_TAINT_MARK_METHOD, payload: { sessionId: null }, signal })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(inner.call).not.toHaveBeenCalled()
  })
})

describe('session taint lineage and scoping (P2 hardening)', () => {
  const sub = (id: string, parentSession?: string, cwd?: string) => ({
    id,
    session: { header: { ...(parentSession === undefined ? {} : { parentSession }), ...(cwd === undefined ? {} : { cwd }) } },
  })
  const created = (listeners: Map<string, Array<(...args: unknown[]) => unknown>>, agentValue: unknown): void => {
    for (const listener of listeners.get('agent/created') ?? []) listener({ agent: agentValue, source: 'startup' })
  }

  it('taints the parent as soon as a subagent reads a page (poc2)', async () => {
    const registry = new SessionTaintRegistry()
    const { ctx, result, check, listeners } = fakeContext()
    installSessionTaint(ctx, registry)
    created(listeners, sub('parent-session'))
    created(listeners, sub('child-session', 'parent-session'))
    result({ name: 'browser_snapshot', agent: sub('child-session', 'parent-session') }, { isError: false })
    result({ name: 'subagent', agent: agent('parent-session') }, { isError: false })
    expect(await check({ name: 'bash', agent: agent('child-session') })).toBeDefined()
    expect(await check({ name: 'bash', agent: agent('parent-session') })).toBeDefined()
    expect(await check({ name: 'web_fetch', agent: agent('parent-session') })).toBeDefined()
  })

  it('learns lineage from the exec agent header even without agent/created', async () => {
    const registry = new SessionTaintRegistry()
    const { ctx, result, check } = fakeContext()
    installSessionTaint(ctx, registry)
    result({ name: 'browser_get_text', agent: sub('c', 'p') }, { isError: false })
    expect(await check({ name: 'bash', agent: agent('p') })).toBeDefined()
  })

  it('starts children and forks of a tainted session tainted, and siblings follow the shared root', async () => {
    const registry = new SessionTaintRegistry()
    const { ctx, result, check, listeners } = fakeContext()
    installSessionTaint(ctx, registry)
    created(listeners, sub('root'))
    created(listeners, sub('a', 'root'))
    created(listeners, sub('b', 'root'))
    result({ name: 'browser_snapshot', agent: agent('a') }, { isError: false })
    // Sibling b: its parent (root) is tainted, so it is too.
    expect(await check({ name: 'bash', agent: agent('b') })).toBeDefined()
    // A fork created later under root's initiator scope starts with its own copy.
    ;(ctx as unknown as { agents: unknown }).agents = { currentInitiator: () => ({ id: 'root' }) }
    created(listeners, sub('fork-1'))
    expect(registry.get('fork-1')).toBeDefined()
    // Clearing the root clears only the root's own taint.
    registry.clear('root')
    expect(await check({ name: 'bash', agent: agent('root') })).toBeUndefined()
    expect(await check({ name: 'bash', agent: agent('a') })).toBeDefined()
    expect(await check({ name: 'bash', agent: agent('fork-1') })).toBeDefined()
    expect(registry.isTainted('b')).toBe(false)
  })

  it('taints on failed browser calls whose error may quote the page', async () => {
    const registry = new SessionTaintRegistry()
    const { ctx, result, check } = fakeContext()
    installSessionTaint(ctx, registry)
    result({ name: 'browser_click', agent: agent('s2') }, { isError: true })
    expect(await check({ name: 'bash', agent: agent('s2') })).toBeDefined()
    result({ name: 'browser_follow_tab', agent: agent('s3') }, { isError: true })
    expect(registry.isTainted('s3')).toBe(false)
  })

  it('limits read/read_image/glob/grep to the session workspace and denies network and MCP tools', async () => {
    const base = mkdtempSync(join(tmpdir(), 'taint-ws-'))
    const ws = join(base, 'ws')
    mkdirSync(ws)
    writeFileSync(join(ws, 'notes.md'), 'x')
    symlinkSync(base, join(ws, 'escape'))
    const registry = new SessionTaintRegistry()
    registry.mark('s', 'browser_snapshot')
    const { ctx, check } = fakeContext()
    installSessionTaint(ctx, registry)
    const me = sub('s', undefined, ws)
    const call = (name: string, args: unknown) => check({ name, arguments: args, agent: me } as never)
    expect(await call('read', { file_path: 'notes.md' })).toBeUndefined()
    expect(await call('read', { file_path: join(ws, 'notes.md') })).toBeUndefined()
    expect(await call('read', { file_path: '/etc/passwd' })).toMatch(/workspace/)
    expect(await call('read', { file_path: '../secret' })).toMatch(/workspace/)
    expect(await call('read', { file_path: '~/.ssh/id_rsa' })).toMatch(/workspace/)
    expect(await call('read', { file_path: 'escape/other' })).toMatch(/workspace/)
    expect(await call('read_image', { file_path: '/tmp/x.png' })).toMatch(/workspace/)
    expect(await call('glob', { pattern: '**/*.md' })).toBeUndefined()
    expect(await call('glob', { pattern: '../**/*' })).toMatch(/workspace/)
    expect(await call('glob', { pattern: '*', path: '/home' })).toMatch(/workspace/)
    expect(await call('grep', { pattern: 'x' })).toBeUndefined()
    expect(await call('grep', { pattern: 'x', path: '/' })).toMatch(/workspace/)
    // No workspace known: fail closed.
    expect(await check({ name: 'read', arguments: { file_path: 'a' }, agent: agent('s') } as never)).toMatch(/workspace/)
    for (const name of ['web_fetch', 'web_search', 'mcp__x__y', 'subagent', 'bash']) {
      expect(await call(name, {})).toMatch(/disabled in this session/)
    }
    rmSync(base, { recursive: true, force: true })
  })
})
