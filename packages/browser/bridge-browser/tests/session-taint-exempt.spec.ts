/**
 * Host-side taint follows the extension's exemption decision: a browser
 * result the extension vouched for (`tool.result { taintExempt: true }`: every
 * origin it read is loopback or a site the user trusts, and its session is
 * untainted) does not taint. Everything else taints as before.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotInjector } from '../src/bridge-hooks.ts'
import { isLoopbackPageOrigin, parseBridgeFrame } from '../src/protocol.ts'
import { installSessionTaint, SessionTaintRegistry } from '../src/session-taint.ts'
import { BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD } from '../src/protocol.ts'
import { closeTestBridges, connectClient, startTestBridge, toolCallsOf, TEST_CAPS, waitFor } from './support/bridge-client.ts'

afterEach(closeTestBridges)

type Exec = { name: string; callId?: string; agent?: { id: unknown } }

function harness() {
  const registry = new SessionTaintRegistry()
  const guards: Array<(exec: Exec) => string | undefined> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, [...listeners.get(name) ?? [], listener])
      return () => {}
    },
    tools: { guard: (guard: (exec: Exec) => string | undefined) => { guards.push(guard); return () => {} } },
  }
  installSessionTaint(ctx as unknown as Context, registry)
  return {
    registry,
    result: (exec: Exec) => { for (const listener of listeners.get('tools/result') ?? []) listener(exec, { isError: false }) },
    denied: (exec: Exec) => guards.map((guard) => guard(exec)).find((reason) => reason !== undefined),
  }
}

const agent = { id: 's1' }

describe('loopback page origins', () => {
  it('accepts only real loopback hosts, any port', () => {
    for (const origin of ['http://localhost', 'http://localhost:3000', 'https://localhost:8443', 'http://127.0.0.1:5173', 'http://[::1]:8080', 'http://app.localhost:3000', 'http://a.b.localhost']) {
      expect(isLoopbackPageOrigin(origin), origin).toBe(true)
    }
  })

  it('refuses look-alikes, other schemes, and anything that is not a bare origin', () => {
    for (const origin of [
      'http://localhost.evil.com', 'http://127.0.0.1.nip.io', 'http://evil.com/localhost', 'http://localhost@evil.com',
      'http://notlocalhost', 'http://xlocalhost:3000', 'http://127.0.0.2', 'http://0.0.0.0:3000', 'http://192.168.1.10',
      'http://localhost.', 'ftp://localhost', 'file:///tmp/x', 'chrome://newtab', 'localhost', 'http://localhost:3000/path', '', '(unknown)',
    ]) {
      expect(isLoopbackPageOrigin(origin), origin).toBe(false)
    }
  })
})

describe('host taint follows the extension\'s exemption', () => {
  it('keeps shell and file tools for a session whose results were all vouched exempt', () => {
    const { registry, result, denied } = harness()
    registry.expectResult('s1', 'call-1')
    registry.noteResult('s1', 'call-1', true)
    result({ name: 'browser_snapshot', callId: 'call-1', agent })
    expect(registry.isTainted('s1')).toBe(false)
    expect(denied({ name: 'bash', agent })).toBeUndefined()
    expect(denied({ name: 'write', agent })).toBeUndefined()
  })

  it('taints on the first result that is not vouched for, and earlier or later exempt results do not undo it', () => {
    const { registry, result, denied } = harness()
    registry.expectResult('s1', 'call-1')
    registry.noteResult('s1', 'call-1', true)
    result({ name: 'browser_snapshot', callId: 'call-1', agent })
    registry.expectResult('s1', 'call-2')
    registry.noteResult('s1', 'call-2', false)
    result({ name: 'browser_snapshot', callId: 'call-2', agent })
    expect(denied({ name: 'bash', agent })).toMatch(/untrusted web page content/)
    // External then loopback: still tainted.
    registry.expectResult('s1', 'call-3')
    registry.noteResult('s1', 'call-3', true)
    result({ name: 'browser_snapshot', callId: 'call-3', agent })
    expect(denied({ name: 'bash', agent })).toMatch(/untrusted web page content/)
  })

  it('fails closed without a vouched result: no call id, an unknown call, a call that never settled, a reused voucher', () => {
    for (const exec of [
      { name: 'browser_snapshot', agent },
      { name: 'browser_snapshot', callId: 'never-dispatched', agent },
    ]) {
      const { registry, result } = harness()
      result(exec)
      expect(registry.isTainted('s1')).toBe(true)
    }
    const pending = harness()
    pending.registry.expectResult('s1', 'call-1')
    pending.result({ name: 'browser_snapshot', callId: 'call-1', agent })
    expect(pending.registry.isTainted('s1')).toBe(true)
    // A voucher covers one tool result, once, in its own session.
    const reused = harness()
    reused.registry.expectResult('s1', 'call-1')
    reused.registry.noteResult('s1', 'call-1', true)
    reused.result({ name: 'browser_snapshot', callId: 'call-1', agent: { id: 's2' } })
    expect(reused.registry.isTainted('s2')).toBe(true)
    reused.result({ name: 'browser_snapshot', callId: 'call-1', agent })
    expect(reused.registry.isTainted('s1')).toBe(false)
    reused.result({ name: 'browser_snapshot', callId: 'call-1', agent })
    expect(reused.registry.isTainted('s1')).toBe(true)
  })

  it('needs every step of a multi-step tool call to be exempt', () => {
    const { registry, result } = harness()
    registry.expectResult('s1', 'run-1')
    registry.expectResult('s1', 'run-1')
    registry.noteResult('s1', 'run-1', true)
    registry.noteResult('s1', 'run-1', false)
    result({ name: 'browser_run', callId: 'run-1', agent })
    expect(registry.isTainted('s1')).toBe(true)
  })

  it('carries the flag only as the literal `true` on the tool.result frame itself', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 'x', ok: true, result: { text: 'a' }, taintExempt: true }))).toEqual({ t: 'tool.result', id: 'x', ok: true, result: { text: 'a' }, taintExempt: true })
    // Inside the result (what a page or the agent could shape) it is just data.
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 'x', ok: true, result: { text: 'a', taintExempt: true } }))).toEqual({ t: 'tool.result', id: 'x', ok: true, result: { text: 'a', taintExempt: true } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 'x', ok: true, result: {}, taintExempt: 'true' }))).toEqual({ t: 'tool.result', id: 'x', ok: true, result: {} })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 'x', ok: false, error: { code: 'action-failed', message: 'm' }, taintExempt: true }))).toEqual({ t: 'tool.result', id: 'x', ok: false, error: { code: 'action-failed', message: 'm' }, taintExempt: true })
  })

  it('injected snapshots taint unless the extension vouched for them', () => {
    const registry = new SessionTaintRegistry()
    const injected: string[] = []
    const inject = createSnapshotInjector((sessionId, snapshot) => { injected.push(`${sessionId}:${snapshot}`) }, registry)
    inject('s1', 'local page', 'follow', true)
    expect(registry.isTainted('s1')).toBe(false)
    inject('s1', 'web page', 'follow')
    expect(registry.isTainted('s1')).toBe(true)
    inject('s2', 'web page', undefined, false)
    expect(registry.isTainted('s2')).toBe(true)
    expect(injected).toHaveLength(3)
  })
})

describe('the voucher travels on the authenticated frame', () => {
  const caps = { ...TEST_CAPS, client: { id: 'client-aaaa', browser: 'chrome' } }

  it('records an exempt voucher only for a tool.result the extension flagged, per tool call', async () => {
    const registry = new SessionTaintRegistry()
    const bridge = await startTestBridge({ sessionLineage: registry })
    const client = await connectClient(bridge.url, caps)
    const answer = async (callId: string, count: number, frame: Record<string, unknown>): Promise<void> => {
      const call = bridge.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's1', callId)
      await waitFor(() => toolCallsOf(client.frames).length >= count)
      client.send({ t: 'tool.result', id: toolCallsOf(client.frames)[count - 1]!.id, ...frame } as never)
      await call.catch(() => undefined)
    }
    await answer('call-exempt', 1, { ok: true, result: { text: 'local' }, taintExempt: true })
    expect(registry.takeExempt('s1', 'call-exempt')).toBe(true)
    await answer('call-plain', 2, { ok: true, result: { text: 'web' } })
    expect(registry.takeExempt('s1', 'call-plain')).toBe(false)
    // The agent or a page can only shape `result`: a flag in there vouches for nothing.
    await answer('call-forged', 3, { ok: true, result: { text: 'web', taintExempt: true } })
    expect(registry.takeExempt('s1', 'call-forged')).toBe(false)
    await answer('call-failed-exempt', 4, { ok: false, error: { code: 'action-failed', message: 'no such element' }, taintExempt: true })
    expect(registry.takeExempt('s1', 'call-failed-exempt')).toBe(true)
  })

  it('a call that timed out carries no voucher', async () => {
    const registry = new SessionTaintRegistry()
    const bridge = await startTestBridge({ sessionLineage: registry })
    await connectClient(bridge.url, caps)
    await expect(bridge.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 30, 's1', 'call-slow')).rejects.toMatchObject({ code: 'timeout' })
    expect(registry.takeExempt('s1', 'call-slow')).toBe(false)
  })

  it('passes the snapshot injection flag through only as the literal true', async () => {
    const seen: Array<{ sessionId: string; exempt: boolean | undefined }> = []
    const bridge = await startTestBridge({
      injectBrowserSnapshot: (sessionId: string, _snapshot: string, _reason?: string, exempt?: boolean) => { seen.push({ sessionId, exempt }) },
    } as never)
    const client = await connectClient(bridge.url, caps)
    await client.rpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId: 's1', snapshot: 'local', taintExempt: true })
    await client.rpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId: 's2', snapshot: 'web' })
    await client.rpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId: 's3', snapshot: 'web', taintExempt: 'yes' })
    expect(seen).toEqual([{ sessionId: 's1', exempt: true }, { sessionId: 's2', exempt: undefined }, { sessionId: 's3', exempt: undefined }])
  })
})

describe('F4: descendants of a session that read exempt pages', () => {
  it('are flagged on every call, so the extension can count an unknown source for them', async () => {
    const registry = new SessionTaintRegistry()
    const bridge = await startTestBridge({ sessionLineage: registry })
    const caps = { ...TEST_CAPS, client: { id: 'client-aaaa', browser: 'chrome' } }
    const client = await connectClient(bridge.url, caps)
    const call = async (sessionId: string, callId: string, count: number, exempt: boolean) => {
      const pending = bridge.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, sessionId, callId)
      await waitFor(() => toolCallsOf(client.frames).length >= count)
      const frame = toolCallsOf(client.frames)[count - 1]!
      client.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'x' }, ...(exempt ? { taintExempt: true } : {}) } as never)
      await pending
      return frame
    }
    registry.link('child', 'parent')
    registry.link('grandchild', 'child')
    // Nothing read yet: no flag.
    expect(await call('child', 'c1', 1, false)).not.toHaveProperty('inheritedExemptReads')
    registry.takeExempt('child', 'c1')
    // The parent reads a local page; the extension vouches; the Host honours it.
    await call('parent', 'p1', 2, true)
    expect(registry.takeExempt('parent', 'p1')).toBe(true)
    expect(registry.isTainted('parent')).toBe(false)
    // The parent's own calls are not flagged (the extension has its record), its descendants' are.
    expect(await call('parent', 'p2', 3, false)).not.toHaveProperty('inheritedExemptReads')
    expect(await call('child', 'c2', 4, false)).toMatchObject({ sessionId: 'child', inheritedExemptReads: true })
    expect(await call('grandchild', 'g1', 5, false)).toMatchObject({ inheritedExemptReads: true })
    expect(await call('unrelated', 'u1', 6, false)).not.toHaveProperty('inheritedExemptReads')
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: 'x', name: 'browser_snapshot', args: {}, expiresAt: 5, sessionId: 's', inheritedExemptReads: 'yes' }))).not.toHaveProperty('inheritedExemptReads')
  })

  it('an exempt snapshot injection counts as an exempt read too', () => {
    const registry = new SessionTaintRegistry()
    registry.link('child', 'parent')
    createSnapshotInjector(() => {}, registry)('parent', 'local page', 'follow', true)
    expect(registry.isTainted('parent')).toBe(false)
    expect(registry.inheritsExemptReads('child')).toBe(true)
    expect(registry.inheritsExemptReads('parent')).toBe(false)
  })
})

describe('F1: the Host decides which vouchers it honours', () => {
  const vouch = (registry: SessionTaintRegistry, callId: string, local: boolean): boolean => {
    registry.expectResult('s1', callId)
    registry.noteResult('s1', callId, true, local)
    return registry.takeExempt('s1', callId)
  }

  it('devLoop.trustLoopback false: vouchers resting on a local page are ignored, trusted-site ones are not', () => {
    const registry = new SessionTaintRegistry()
    registry.honour = { any: true, local: false }
    expect(vouch(registry, 'local', true)).toBe(false)
    expect(vouch(registry, 'trusted', false)).toBe(true)
    // A multi-step call with one local step is a local voucher.
    registry.expectResult('s1', 'mixed')
    registry.expectResult('s1', 'mixed')
    registry.noteResult('s1', 'mixed', true, false)
    registry.noteResult('s1', 'mixed', true, true)
    expect(registry.takeExempt('s1', 'mixed')).toBe(false)
    const inject = createSnapshotInjector(() => {}, registry)
    inject('s2', 'local page', 'follow', true, true)
    expect(registry.isTainted('s2')).toBe(true)
    inject('s3', 'trusted page', 'follow', true, false)
    expect(registry.isTainted('s3')).toBe(false)
  })

  it('honorTaintExemptions false: every voucher is ignored', () => {
    const registry = new SessionTaintRegistry()
    registry.honour = { any: false, local: false }
    expect(vouch(registry, 'local', true)).toBe(false)
    expect(vouch(registry, 'trusted', false)).toBe(false)
    createSnapshotInjector(() => {}, registry)('s2', 'page', 'follow', true, false)
    expect(registry.isTainted('s2')).toBe(true)
  })

  it('the default honours both', () => {
    const registry = new SessionTaintRegistry()
    expect(vouch(registry, 'local', true)).toBe(true)
    expect(vouch(registry, 'trusted', false)).toBe(true)
  })

  it('carries the local marker on the frame and the choice in the server caps', async () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 'x', ok: true, result: {}, taintExempt: true, taintExemptLocal: true }))).toEqual({ t: 'tool.result', id: 'x', ok: true, result: {}, taintExempt: true, taintExemptLocal: true })
    // The marker means nothing without the voucher itself.
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 'x', ok: true, result: {}, taintExemptLocal: true }))).toEqual({ t: 'tool.result', id: 'x', ok: true, result: {} })
    const registry = new SessionTaintRegistry()
    const bridge = await startTestBridge({ sessionLineage: registry, caps: { ...TEST_CAPS, taintExemptions: { local: false, trusted: true } } })
    const client = await connectClient(bridge.url, { ...TEST_CAPS, client: { id: 'client-aaaa', browser: 'chrome' } })
    expect(client.frames.find((frame) => frame.t === 'hello.ok')).toMatchObject({ caps: { taintExemptions: { local: false, trusted: true } } })
    const pending = bridge.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's1', 'c1')
    await waitFor(() => toolCallsOf(client.frames).length >= 1)
    client.send({ t: 'tool.result', id: toolCallsOf(client.frames)[0]!.id, ok: true, result: { text: 'local' }, taintExempt: true, taintExemptLocal: true } as never)
    await pending
    registry.honour = { any: true, local: false }
    expect(registry.takeExempt('s1', 'c1')).toBe(false)
  })
})
