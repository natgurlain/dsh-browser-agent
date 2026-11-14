import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  installSessionTaint,
  resultTaintsSession,
  SessionTaintRegistry,
  toolAllowedWhileTainted,
  withTaintMethods,
} from '../src/session-taint.ts'
import { BRIDGE_TAINT_CLEAR_METHOD } from '../src/protocol.ts'
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
    expect(resultTaintsSession('browser_get_text', true)).toBe(false)
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
    // A failed read does not taint; a successful one does.
    result({ name: 'browser_snapshot', agent: agent('s1') }, { isError: true })
    expect(await check({ name: 'bash', agent: agent('s1') })).toBeUndefined()
    result({ name: 'browser_snapshot', agent: agent('s1') }, { isError: false })
    expect(await check({ name: 'bash', agent: agent('s1') })).toMatch(/untrusted web page content.*clears the session/)
    expect(await check({ name: 'write', agent: agent('s1') })).toBeDefined()
    expect(await check({ name: 'web_fetch', agent: agent('s1') })).toBeDefined()
    expect(await check({ name: 'read', agent: agent('s1') })).toBeUndefined()
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
    expect(await check({ name: 'read', agent: agent('s1') })).toBeUndefined()
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
})
