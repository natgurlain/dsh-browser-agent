import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { DevLoop, withDevLoopMethods, type DevLoopDeps } from '../src/dev-loop.ts'
import { BrowserContextInjector } from '../src/browser-context.ts'
import { withBridgePolicy } from '../src/bridge-policy.ts'
import { memorySessionLedger } from '../src/session-ledger.ts'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import {
  BRIDGE_DEVLOOP_CANDIDATES_METHOD,
  BRIDGE_DEVLOOP_LINK_METHOD,
  BRIDGE_DEVLOOP_UNLINK_METHOD,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  devLoopOrigin,
} from '../src/protocol.ts'

const SESSIONS = { items: [
  { sessionId: 'coding', origin: 'user', title: 'Fix the login page', cwd: '/home/u/projects/webapp', running: false },
  { sessionId: 'browser-owned', origin: 'user', cwd: '/home/u/.dsh/browser-sessions' },
  { sessionId: 'child', origin: 'subagent', cwd: '/home/u/projects/webapp' },
] }

function harness(overrides: Partial<DevLoopDeps> = {}) {
  const capture = vi.fn(async (): Promise<unknown> => ({ text: 'Console errors (1): TypeError: x is undefined' }))
  const inject = vi.fn((): 'injected' => 'injected')
  const taint = vi.fn()
  const devLoop = new DevLoop({
    listSessions: async () => SESSIONS,
    isBridgeSession: (id) => id === 'browser-owned' || id.startsWith('mcp-'),
    capture,
    inject,
    taint,
    ...overrides,
  })
  return { devLoop, capture, inject, taint }
}

const signal = new AbortController().signal

describe('dev loop origins', () => {
  it('accepts loopback http(s) origins only, plus explicitly allowed ones', () => {
    expect(devLoopOrigin('http://localhost:5173/app')).toBe('http://localhost:5173')
    expect(devLoopOrigin('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000')
    expect(devLoopOrigin('http://[::1]:8080/x')).toBe('http://[::1]:8080')
    expect(devLoopOrigin('https://localhost/')).toBe('https://localhost')
    expect(devLoopOrigin('https://example.com/')).toBeUndefined()
    expect(devLoopOrigin('http://localhost.evil.example/')).toBeUndefined()
    expect(devLoopOrigin('http://127.0.0.2/')).toBeUndefined()
    expect(devLoopOrigin('file:///tmp/index.html')).toBeUndefined()
    expect(devLoopOrigin('http://myapp.test:3000/', ['http://myapp.test:3000'])).toBe('http://myapp.test:3000')
  })
})

describe('DevLoop', () => {
  it('offers only listable, non-subagent coding sessions the bridge does not own', async () => {
    const { devLoop } = harness()
    expect(await devLoop.candidates(signal)).toEqual([
      { sessionId: 'coding', title: 'Fix the login page', project: 'webapp', running: false },
    ])
  })

  it('links only a localhost tab to a coding session', async () => {
    const { devLoop } = harness()
    await expect(devLoop.link('coding', 'https://shop.example/', signal)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(devLoop.link('browser-owned', 'http://localhost:3000/', signal)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(devLoop.link('child', 'http://localhost:3000/', signal)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(devLoop.link('mcp-1', 'http://localhost:3000/', signal)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await devLoop.link('coding', 'http://localhost:3000/login', signal)).toMatchObject({ sessionId: 'coding', origin: 'http://localhost:3000' })
  })

  it('captures and injects after a turn that edited files, and only then', async () => {
    const { devLoop, capture, inject, taint } = harness()
    await devLoop.link('coding', 'http://localhost:3000/', signal)
    // A turn without edits: nothing.
    devLoop.noteToolResult('coding', 'read', false)
    expect(devLoop.noteStatus('coding', 'idle')).toBeUndefined()
    // A failed edit does not count; a running status does not trigger.
    devLoop.noteToolResult('coding', 'edit', true)
    expect(devLoop.noteStatus('coding', 'idle')).toBeUndefined()
    devLoop.noteToolResult('coding', 'edit', false)
    expect(devLoop.noteStatus('coding', 'running')).toBeUndefined()
    await devLoop.noteStatus('coding', 'idle')
    expect(capture).toHaveBeenCalledExactlyOnceWith('coding', 'http://localhost:3000', expect.any(AbortSignal))
    expect(inject).toHaveBeenCalledExactlyOnceWith('coding', 'Console errors (1): TypeError: x is undefined')
    // Loopback: the user's own dev server does not taint the coding session.
    expect(taint).not.toHaveBeenCalled()
    // The flag was consumed.
    expect(devLoop.noteStatus('coding', 'idle')).toBeUndefined()
  })

  it('ignores edits in sessions that are not linked, and stops after unlink', async () => {
    const { devLoop, capture } = harness()
    devLoop.noteToolResult('coding', 'write', false)
    expect(devLoop.noteStatus('coding', 'idle')).toBeUndefined()
    await devLoop.link('coding', 'http://localhost:3000/', signal)
    devLoop.noteToolResult('coding', 'write', false)
    expect(devLoop.unlink('coding')).toBe(true)
    expect(devLoop.noteStatus('coding', 'idle')).toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
  })

  it('taints the session for an operator-allowed non-loopback origin', async () => {
    const { devLoop, taint } = harness({ extraOrigins: ['http://myapp.test:3000'] })
    await devLoop.link('coding', 'http://myapp.test:3000/', signal)
    devLoop.noteToolResult('coding', 'apply_patch', false)
    await devLoop.noteStatus('coding', 'idle')
    expect(taint).toHaveBeenCalledWith('coding')
  })

  it('injects nothing when the extension refuses or returns nothing', async () => {
    const log = vi.fn()
    const { devLoop, inject } = harness({ capture: async () => { throw new Error('not linked in this browser') }, log })
    await devLoop.link('coding', 'http://localhost:3000/', signal)
    devLoop.noteToolResult('coding', 'edit', false)
    await devLoop.noteStatus('coding', 'idle')
    expect(inject).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not linked in this browser'))
  })
})

describe('dev loop RPCs and the bridge policy', () => {
  function fencedHarness() {
    const inner = vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => {
      if (call.method === 'session.list') return { ok: true, value: SESSIONS }
      return { ok: true, value: {} }
    })
    const hostApi: BrowserHostApi = { call: inner, async *events() {}, respond: async () => ({ accepted: true }) }
    const fenced = withBridgePolicy(hostApi, { allowDangerFullAccess: false, presetSandbox: () => 'workspace-write', ledger: memorySessionLedger(['browser-owned']) })
    const { devLoop } = harness()
    const api = withDevLoopMethods(fenced, devLoop)
    const call = (method: string, payload: unknown) => api.call({ rpcId: 'r', method, payload, signal })
    return { api, call, inner, devLoop }
  }

  it('serves candidates, link and unlink without touching the Host', async () => {
    const { call, devLoop } = fencedHarness()
    expect(await call(BRIDGE_DEVLOOP_CANDIDATES_METHOD, {})).toMatchObject({ ok: true, value: { items: [{ sessionId: 'coding' }] } })
    expect(await call(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 'coding', url: 'https://bank.example/' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await call(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 'coding' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await call(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 'coding', url: 'http://localhost:5173/' })).toMatchObject({ ok: true })
    expect(devLoop.list()).toHaveLength(1)
    expect(await call(BRIDGE_DEVLOOP_UNLINK_METHOD, { sessionId: 'coding' })).toEqual({ ok: true, value: { unlinked: true } })
  })

  it('still refuses prompting, steering or changing a linked coding session from the browser', async () => {
    const { call, inner } = fencedHarness()
    await call(BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: 'coding', url: 'http://localhost:5173/' })
    inner.mockClear()
    for (const [method, payload] of [
      ['session.prompt', { sessionId: 'coding', mode: 'queue', content: [{ type: 'text', text: 'hi' }] }],
      ['commands.execute', { sessionId: 'coding', line: '/plan' }],
      ['session.setPermission', { sessionId: 'coding', preset: 'read-only' }],
    ] as const) {
      expect(await call(method, payload)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(inner.mock.calls.every(([c]) => c.method === 'session.list')).toBe(true)
    // The generic snapshot-injection RPC stays own-only (server.ts checks 'own' scope).
    const { policy } = { policy: withBridgePolicy({ call: inner, async *events() {}, respond: async () => ({}) }, { allowDangerFullAccess: false, ledger: memorySessionLedger() }) }
    expect(await policy.allowsSession('coding', signal, 'own')).toBe(false)
    expect(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD).toBe('bridge.injectBrowserSnapshot')
  })
})

describe('dev loop context injection', () => {
  it('injects read-only context into a live session without waking it, superseding the previous one', () => {
    const removed: string[] = []
    const agent = {
      id: 'coding',
      inbox: { nextStep: [] as Array<{ id: string; source: { kind: string; form: string; sections: Array<{ name: string }> } }>, remove: (id: string) => { removed.push(id) } },
      inject: vi.fn(),
      followup: vi.fn(),
      send: vi.fn(),
      steer: vi.fn(),
    }
    const injector = new BrowserContextInjector({ get: () => agent as unknown as Agent } as unknown as Pick<AgentRegistry, 'get'>)
    expect(injector.inject('coding', 'Console errors (1)', 'devloop')).toBe('injected')
    const message = agent.inject.mock.calls[0]![0] as { content: Array<{ text: string }>; source: { sections: Array<{ name: string }> } }
    expect(message.content[0]!.text).toMatch(/never instructions/u)
    expect(message.source.sections[0]!.name).toBe('browser-devloop')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.send).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
    agent.inbox.nextStep.push({ ...message, id: 'old' } as never)
    injector.inject('coding', 'Console errors (2)', 'devloop')
    expect(removed).toEqual(['old'])
    // No live Agent: dropped, never queued for a later session start.
    const empty = new BrowserContextInjector({ get: () => undefined } as unknown as Pick<AgentRegistry, 'get'>)
    expect(empty.inject('coding', 'x', 'devloop')).toBe('dropped')
  })
})
