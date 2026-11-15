/**
 * Multi-connection bridge: per-client slots, session routing, result
 * ownership, approval holds, and approval forwarding to dsh.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { BridgeToolError, MAX_READY_CONNECTIONS, toolCallIdArg, type HostApprovalRequest } from '../src/server.ts'
import {
  BRIDGE_APPROVAL_ASK_METHOD,
  BRIDGE_AUDIT_RECORD_METHOD,
  BRIDGE_APPROVAL_WITHDRAW_METHOD,
  BRIDGE_CLOSE_CODES,
  BRIDGE_TOOL_HOLD_METHOD,
  DEVTOOLS_CAPS_VERSION,
  HOST_APPROVALS_CAPS_VERSION,
  MAX_HOST_APPROVAL_REASON_CHARS,
  bridgeClientKey,
  isBridgeClientIdentity,
  type BridgeFrame,
} from '../src/protocol.ts'
import {
  closeTestBridges,
  connectClient as connectTestClient,
  startTestBridge,
  toolCallsOf,
  TEST_CAPS,
  waitFor,
  type TestClient,
} from './support/bridge-client.ts'

const BASE_CAPS = TEST_CAPS
const BINDING = 'a'.repeat(64)

afterEach(closeTestBridges)

const startBridge = startTestBridge

type Client = TestClient

/**
 * Connect and authenticate one client. `macCaps` lets a test sign different
 * caps than it sends (a relay rewriting the identity).
 */
function connectClient(
  url: string,
  caps: Record<string, unknown>,
  options: { macCaps?: Record<string, unknown>; expectReady?: boolean } = {},
): Promise<Client> {
  return connectTestClient(url, caps, options)
}

function identity(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_CAPS, client: { id, browser: 'chrome', ...extra } }
}

function toolCalls(client: Client): Array<Extract<BridgeFrame, { t: 'tool.call' }>> {
  return toolCallsOf(client.frames)
}

async function nextToolCall(client: Client, count = 1): Promise<Extract<BridgeFrame, { t: 'tool.call' }>> {
  await waitFor(() => toolCalls(client).length >= count)
  return toolCalls(client)[count - 1]!
}

describe('client identity', () => {
  it('validates identities strictly and derives stable keys', () => {
    expect(isBridgeClientIdentity({ id: 'abcdefgh' })).toBe(true)
    expect(isBridgeClientIdentity({ id: 'abcdefgh', browser: 'firefox', profile: 'Work 1' })).toBe(true)
    expect(isBridgeClientIdentity({ id: 'short' })).toBe(false)
    expect(isBridgeClientIdentity({ id: 'abcdefgh!' })).toBe(false)
    expect(isBridgeClientIdentity({ id: 'abcdefgh', browser: 'Chrome' })).toBe(false)
    expect(isBridgeClientIdentity({ id: 'abcdefgh', profile: 'x'.repeat(65) })).toBe(false)
    expect(isBridgeClientIdentity({ id: 'abcdefgh', profile: 'tab\there' })).toBe(false)
    expect(isBridgeClientIdentity({ id: 'abcdefgh', extra: 1 })).toBe(false)
    expect(isBridgeClientIdentity(['abcdefgh'])).toBe(false)
    expect(bridgeClientKey(undefined)).toBe('legacy')
    expect(bridgeClientKey({ id: 'abcdefgh', browser: 'chrome' })).toBe('chrome/abcdefgh/')
    expect(bridgeClientKey({ id: 'abcdefgh', browser: 'chrome', profile: 'p' }))
      .not.toBe(bridgeClientKey({ id: 'abcdefgh', browser: 'firefox', profile: 'p' }))
  })

  it('refuses a hello whose identity is malformed', async () => {
    const h = await startBridge()
    const client = await connectClient(h.url, { ...BASE_CAPS, client: { id: 'bad id!' } }, { expectReady: false })
    expect((await client.closed).code).toBe(1008)
    expect(h.bridge.connectionCount()).toBe(0)
  })

  it('binds the identity into the handshake proof (a relay cannot rewrite it)', async () => {
    const h = await startBridge()
    const client = await connectClient(h.url, identity('relayed-id'), { macCaps: identity('original-id'), expectReady: false })
    expect((await client.closed).code).toBe(BRIDGE_CLOSE_CODES.authFailed)
    expect(h.bridge.connectionCount()).toBe(0)
  })
})

describe('multi-connection registry', () => {
  it('keeps clients with different identities connected side by side', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    expect(h.bridge.connectionCount()).toBe(2)
    expect(a.ws.readyState).toBe(WebSocket.OPEN)
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('treats the same id in another browser or profile as a separate client', async () => {
    const h = await startBridge()
    await connectClient(h.url, identity('client-aaaa'))
    await connectClient(h.url, { ...BASE_CAPS, client: { id: 'client-aaaa', browser: 'firefox' } })
    await connectClient(h.url, identity('client-aaaa', { profile: 'Work' }))
    expect(h.bridge.connectionCount()).toBe(3)
  })

  it('replaces only the reconnecting client and settles only its calls', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    // B is most recent: route one call there, then pin a session to A.
    const toB = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal)
    await nextToolCall(b)
    await a.rpc('session.prompt', { sessionId: 's-a', text: 'hi' })
    const toA = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-a')
    const toAOutcome = toA.then(() => 'resolved', (error: unknown) => error)
    await nextToolCall(a)

    const a2 = await connectClient(h.url, identity('client-aaaa'))
    expect((await a.closed).code).toBe(BRIDGE_CLOSE_CODES.replaced)
    expect(await toAOutcome).toMatchObject({ code: 'bridge-closed' })
    expect(b.ws.readyState).toBe(WebSocket.OPEN)
    expect(h.bridge.connectionCount()).toBe(2)

    const callB = toolCalls(b)[0]!
    b.send({ t: 'tool.result', id: callB.id, ok: true, result: { text: 'from b' } })
    await expect(toB).resolves.toEqual({ text: 'from b' })
    // The session's affinity survives the reconnect (same identity).
    const again = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-a')
    const call = await nextToolCall(a2)
    a2.send({ t: 'tool.result', id: call.id, ok: true, result: { text: 'a2' } })
    await expect(again).resolves.toEqual({ text: 'a2' })
  })

  it('keeps the legacy behavior for clients without an identity', async () => {
    const h = await startBridge()
    const first = await connectClient(h.url, { ...BASE_CAPS })
    await connectClient(h.url, { ...BASE_CAPS })
    expect((await first.closed).code).toBe(BRIDGE_CLOSE_CODES.replaced)
    expect(h.bridge.connectionCount()).toBe(1)
  })

  it('evicts the least recently active client beyond the connection limit', async () => {
    const h = await startBridge()
    const clients: Client[] = []
    for (let i = 0; i < MAX_READY_CONNECTIONS; i += 1) {
      clients.push(await connectClient(h.url, identity(`client-${String(i).padStart(4, '0')}`)))
    }
    // Client 0 becomes active again; client 1 is now the stalest.
    await clients[0]!.rpc('session.list', {})
    await connectClient(h.url, identity('client-late'))
    expect((await clients[1]!.closed).code).toBe(BRIDGE_CLOSE_CODES.replaced)
    expect(clients[0]!.ws.readyState).toBe(WebSocket.OPEN)
    expect(h.bridge.connectionCount()).toBe(MAX_READY_CONNECTIONS)
  })
})

describe('tool routing', () => {
  it('routes a session to the client that prompted it and others to the most recently active client', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    await a.rpc('session.prompt', { sessionId: 's-a', text: 'go' })
    // B becomes the most recently active client.
    await b.rpc('session.list', {})

    const pinned = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-a')
    const pinnedCall = await nextToolCall(a)
    expect(pinnedCall.sessionId).toBe('s-a')
    expect(toolCalls(b)).toHaveLength(0)
    a.send({ t: 'tool.result', id: pinnedCall.id, ok: true, result: { text: 'a' } })
    await expect(pinned).resolves.toEqual({ text: 'a' })
    // Answering counted as activity for A; make B the most recent again.
    await b.rpc('session.list', {})

    const loose = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-new')
    const looseCall = await nextToolCall(b)
    b.send({ t: 'tool.result', id: looseCall.id, ok: true, result: { text: 'b' } })
    await expect(loose).resolves.toEqual({ text: 'b' })
    // A successful answer pins the new session to B.
    await a.rpc('session.list', {})
    const followUp = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-new')
    const followCall = await nextToolCall(b, 2)
    b.send({ t: 'tool.result', id: followCall.id, ok: true, result: { text: 'b2' } })
    await expect(followUp).resolves.toEqual({ text: 'b2' })
  })

  it('binds an MCP external session to its first install at dispatch, with no fallback', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    await a.rpc('session.list', {})
    // Unanswered (still pending) when A goes away: the binding happened at dispatch.
    const first = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 'mcp-9', undefined, undefined, 'Cursor')
    void first.catch(() => {})
    await nextToolCall(a)
    a.ws.close()
    await waitFor(() => h.bridge.connectionCount() === 1)
    await b.rpc('session.list', {})
    expect(() => h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 'mcp-9', undefined, undefined, 'Cursor'))
      .toThrow(expect.objectContaining({ code: 'bridge-closed' }))
    expect(toolCalls(b)).toHaveLength(0)
  })

  it('fails instead of falling back to another profile when the affine client is gone', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    await a.rpc('session.prompt', { sessionId: 's-a', text: 'go' })
    a.ws.close()
    await waitFor(() => h.bridge.connectionCount() === 1)
    expect(() => h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-a'))
      .toThrow(expect.objectContaining({ code: 'bridge-closed' }))
    expect(toolCalls(b)).toHaveLength(0)
  })

  it('forgets a purged session\'s install binding', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    await a.rpc('session.prompt', { sessionId: 's-a', text: 'go' })
    a.ws.close()
    await waitFor(() => h.bridge.connectionCount() === 1)
    h.bridge.forgetSession('s-a')
    const call = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-a')
    void call.catch(() => {})
    await nextToolCall(b)
    expect(toolCalls(b)).toHaveLength(1)
  })

  it('fails instead of falling back when the affine client lacks the capability', async () => {
    const h = await startBridge()
    const plain = await connectClient(h.url, identity('client-plan'))
    const dev = await connectClient(h.url, { ...identity('client-devt'), devTools: { version: DEVTOOLS_CAPS_VERSION } })
    await plain.rpc('session.prompt', { sessionId: 's-p', text: 'go' })
    expect(() => h.bridge.requestTool('browser_console_eval', { code: '1' }, new AbortController().signal, 1_000, 's-p'))
      .toThrow(expect.objectContaining({ code: 'bridge-closed' }))
    expect(toolCalls(dev)).toHaveLength(0)
  })

  it('pins a session only after the Host authorized the prompt', async () => {
    const h = await startBridge({
      api: {
        call: async ({ method, payload }) => method === 'session.prompt' && (payload as { sessionId?: string }).sessionId === 'foreign'
          ? { ok: false, error: { code: 'forbidden', message: 'no', details: {} } }
          : { ok: true, value: 'ok' },
        async *events() {},
        respond: async () => ({ accepted: true }),
      },
    })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    await a.rpc('session.prompt', { sessionId: 'foreign', text: 'hijack' })
    await b.rpc('session.list', {})
    // The refused prompt did not bind "foreign" to A: routing still picks B.
    const call = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 'foreign')
    const frame = await nextToolCall(b)
    expect(toolCalls(a)).toHaveLength(0)
    b.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'b' } })
    await expect(call).resolves.toEqual({ text: 'b' })
  })

  it('routes subagent sessions to the parent install and marks tainted sessions on the wire', async () => {
    const parents: Record<string, string> = { child: 's-a', grandchild: 'child' }
    const h = await startBridge({
      sessionLineage: { parentOf: (id) => parents[id], isTainted: (id) => id === 'grandchild' },
    })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    await a.rpc('session.prompt', { sessionId: 's-a', text: 'go' })
    await b.rpc('session.list', {})
    const call = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 'grandchild')
    const frame = await nextToolCall(a)
    expect(frame).toMatchObject({ sessionId: 'grandchild', tainted: true })
    expect(toolCalls(b)).toHaveLength(0)
    a.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'a' } })
    await expect(call).resolves.toEqual({ text: 'a' })
    const plain = h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 's-a')
    const plainFrame = await nextToolCall(a, 2)
    expect(plainFrame).not.toHaveProperty('tainted')
    a.send({ t: 'tool.result', id: plainFrame.id, ok: true, result: { text: 'a2' } })
    await plain
    a.ws.close()
    await waitFor(() => h.bridge.connectionCount() === 1)
    expect(() => h.bridge.requestTool('browser_snapshot', {}, new AbortController().signal, 1_000, 'child'))
      .toThrow(expect.objectContaining({ code: 'bridge-closed' }))
  })

  it('audits which connection served a call and lets only that connection annotate it', async () => {
    const audit = { dispatched: vi.fn(), annotated: vi.fn(), settled: vi.fn(), killSwitch: vi.fn() }
    const h = await startBridge({ audit })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal, 1_000, 'sess', 'toolu_9')
    const frame = await nextToolCall(b)
    const served = audit.dispatched.mock.calls[0]![0] as { connection: string; toolCallId: string }
    expect(served.toolCallId).toBe('toolu_9')
    expect(served.connection).toMatch(/bbbb/u)
    expect((await a.rpc(BRIDGE_AUDIT_RECORD_METHOD, { callId: frame.id, decision: 'allowed' })).ok).toBe(false)
    expect((await b.rpc(BRIDGE_AUDIT_RECORD_METHOD, { callId: frame.id, decision: 'allowed' })).ok).toBe(true)
    expect(audit.annotated).toHaveBeenCalledExactlyOnceWith(frame.id, { decision: 'allowed' })
    await a.rpc(BRIDGE_AUDIT_RECORD_METHOD, { event: 'kill-switch' })
    expect(audit.killSwitch).toHaveBeenCalledWith(expect.stringMatching(/aaaa/u))
    b.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'ok' } })
    await expect(call).resolves.toEqual({ text: 'ok' })
  })

  it('ignores a tool.result from a connection the call was not sent to', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    const frame = await nextToolCall(b)
    let settled = false
    void call.then(() => { settled = true }, () => { settled = true })
    a.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'forged' } })
    await a.rpc('session.list', {})
    expect(settled).toBe(false)
    b.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'genuine' } })
    await expect(call).resolves.toEqual({ text: 'genuine' })
  })

  it('routes developer-tools calls only to clients that advertised them and re-syncs caps on close', async () => {
    const onCapsChange = vi.fn()
    const h = await startBridge({ onCapsChange })
    const dev = await connectClient(h.url, { ...identity('client-devt'), devTools: { version: DEVTOOLS_CAPS_VERSION } })
    const plain = await connectClient(h.url, identity('client-plan'))
    await plain.rpc('session.list', {})
    expect(h.bridge.devToolsSupported()).toBe(true)
    const call = h.bridge.requestTool('browser_console_eval', { code: '1' }, new AbortController().signal)
    const frame = await nextToolCall(dev)
    expect(toolCalls(plain)).toHaveLength(0)
    dev.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: '1' } })
    await expect(call).resolves.toEqual({ text: '1' })

    const calls = onCapsChange.mock.calls.length
    dev.ws.close()
    await waitFor(() => !h.bridge.devToolsSupported())
    expect(onCapsChange.mock.calls.length).toBeGreaterThan(calls)
    expect(() => h.bridge.requestTool('browser_console_eval', { code: '1' }, new AbortController().signal))
      .toThrow(/can serve "browser_console_eval"/u)
  })
})

describe('approval holds', () => {
  it('advertises host approvals only when forwarding is configured', async () => {
    const plain = await startBridge()
    const a = await connectClient(plain.url, identity('client-aaaa'))
    expect((a.frames.find((frame) => frame.t === 'hello.ok') as { caps: Record<string, unknown> }).caps.hostApprovals).toBeUndefined()
    const forwarding = await startBridge({ requestHostApproval: async () => 'rejected' })
    const b = await connectClient(forwarding.url, identity('client-bbbb'))
    expect((b.frames.find((frame) => frame.t === 'hello.ok') as { caps: Record<string, unknown> }).caps.hostApprovals)
      .toBe(HOST_APPROVALS_CAPS_VERSION)
    expect((await b.rpc(BRIDGE_APPROVAL_ASK_METHOD, {})).ok).toBe(false)
    const unsupported = await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: 'x', approvalId: 'y', reason: 'z' })
    expect(unsupported).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })

  it('extends an owned call past its budget, up to the configured ceiling', async () => {
    // Budgets leave the hold RPC ample time to land on a loaded worker.
    const h = await startBridge({ toolTimeoutMs: 600, maxApprovalHoldMs: 600 })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const started = Date.now()
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    const frame = await nextToolCall(a)
    const held = await a.rpc(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: frame.id, holdMs: 60_000 })
    expect(held.ok).toBe(true)
    const expiresAt = (held as { result: { expiresAt: number } }).result.expiresAt
    expect(expiresAt).toBeLessThanOrEqual(frame.expiresAt + 600)
    expect(expiresAt).toBeGreaterThan(frame.expiresAt)
    await expect(call).rejects.toMatchObject({ code: 'timeout' })
    // Past the plain budget (600 ms), so the hold extended it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    await waitFor(() => a.frames.some((f) => f.t === 'tool.cancel' && f.id === frame.id))
  })

  it('keeps a held call alive until its result arrives', async () => {
    const h = await startBridge({ toolTimeoutMs: 500 })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    const frame = await nextToolCall(a)
    await a.rpc(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: frame.id, holdMs: 3_000 })
    // A shorter hold never shortens the deadline.
    const shorter = await a.rpc(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: frame.id, holdMs: 1 })
    expect((shorter as { result: { expiresAt: number } }).result.expiresAt).toBeGreaterThan(Date.now() + 1_500)
    // Answer after the plain 500 ms budget has passed.
    await new Promise((resolve) => { setTimeout(resolve, 700) })
    a.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'done' } })
    await expect(call).resolves.toEqual({ text: 'done' })
  })

  it('refuses holds for calls another connection owns, unknown calls, and bad durations', async () => {
    const h = await startBridge()
    const a = await connectClient(h.url, identity('client-aaaa'))
    const b = await connectClient(h.url, identity('client-bbbb'))
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    const frame = await nextToolCall(b)
    expect(await a.rpc(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: frame.id, holdMs: 1_000 }))
      .toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await b.rpc(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: 'nope', holdMs: 1_000 }))
      .toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await b.rpc(BRIDGE_TOOL_HOLD_METHOD, null)).toMatchObject({ ok: false, error: { code: 'not-found' } })
    for (const holdMs of [0, -1, Number.NaN, '1000']) {
      expect(await b.rpc(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: frame.id, holdMs }))
        .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
    b.send({ t: 'tool.result', id: frame.id, ok: true, result: { text: 'x' } })
    await call
  })
})

describe('approval forwarding to dsh', () => {
  async function setup(answer: (request: HostApprovalRequest) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>) {
    const requestHostApproval = vi.fn(answer)
    const h = await startBridge({ requestHostApproval, toolTimeoutMs: 2_000 })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const call = h.bridge.requestTool('browser_type', { index: 2, text: 'hi' }, new AbortController().signal, 2_000, 'sess-1')
    void call.catch(() => {})
    const frame = await nextToolCall(a)
    return { h, a, call, frame, requestHostApproval }
  }

  it('asks with the session and tool from the bridge record and echoes the binding', async () => {
    const { a, frame, requestHostApproval } = await setup(async () => 'allowed-once')
    const result = await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, {
      toolCallId: frame.id, approvalId: 'ap-1', binding: BINDING, reason: 'Type "hi" on example.com', sessionId: 'spoofed',
    })
    expect(result).toMatchObject({ ok: true, result: { approvalId: 'ap-1', binding: BINDING, decision: 'allow-once' } })
    expect(requestHostApproval).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1', toolName: 'browser_type', reason: 'Type "hi" on example.com',
    }))
  })

  it('labels an external (MCP) session\'s call with its requester and never forwards its approvals to dsh', async () => {
    const requestHostApproval = vi.fn(async () => 'allowed-once' as const)
    const h = await startBridge({ requestHostApproval, toolTimeoutMs: 2_000 })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const call = h.bridge.requestTool('browser_type', { index: 2, text: 'hi' }, new AbortController().signal, 2_000, 'mcp-42', undefined, undefined, 'Claude Code')
    void call.catch(() => {})
    const frame = await nextToolCall(a)
    expect(frame).toMatchObject({ sessionId: 'mcp-42', requester: 'Claude Code' })
    const result = await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap-1', binding: BINDING, reason: 'Type "hi"' })
    expect(result).toMatchObject({ ok: true, result: { approvalId: 'ap-1', decision: 'unavailable' } })
    expect(requestHostApproval).not.toHaveBeenCalled()
    // An Agent session's call never carries a requester label.
    const agentCall = h.bridge.requestTool('browser_type', { index: 2, text: 'hi' }, new AbortController().signal, 2_000, 'sess-1')
    void agentCall.catch(() => {})
    const agentFrame = await nextToolCall(a, 2)
    expect('requester' in agentFrame).toBe(false)
  })

  it.each([
    ['rejected', 'deny'],
    ['cancelled', 'cancelled'],
    ['unavailable', 'unavailable'],
    ['bogus', 'unavailable'],
  ] as const)('maps a %s outcome to %s (fail closed)', async (outcome, decision) => {
    const { a, frame } = await setup(async () => outcome as 'rejected')
    const result = await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap-1', reason: 'r' })
    expect(result).toMatchObject({ ok: true, result: { approvalId: 'ap-1', decision } })
    expect((result as { result: Record<string, unknown> }).result.binding).toBeUndefined()
  })

  it('fails closed when the approval service throws', async () => {
    const { a, frame } = await setup(async () => { throw new Error('no open turn') })
    expect(await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap-1', reason: 'r' }))
      .toMatchObject({ ok: true, result: { decision: 'unavailable' } })
  })

  it('withdraws a forwarded approval on request and when the call settles', async () => {
    let seen: AbortSignal | undefined
    const { a, frame } = await setup((request) => new Promise((resolve) => {
      seen = request.signal
      request.signal.addEventListener('abort', () => { resolve('cancelled') })
    }))
    const pending = a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap-1', reason: 'r' })
    await waitFor(() => seen !== undefined)
    expect(await a.rpc(BRIDGE_APPROVAL_WITHDRAW_METHOD, { toolCallId: frame.id, approvalId: 'ap-1' }))
      .toMatchObject({ ok: true, result: { withdrawn: true } })
    expect(await pending).toMatchObject({ ok: true, result: { decision: 'cancelled' } })
    expect(await a.rpc(BRIDGE_APPROVAL_WITHDRAW_METHOD, { toolCallId: frame.id, approvalId: 'ap-1' }))
      .toMatchObject({ ok: true, result: { withdrawn: false } })

    seen = undefined
    const second = a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap-2', reason: 'r' })
    await waitFor(() => seen !== undefined)
    a.send({ t: 'tool.result', id: frame.id, ok: false, error: { code: 'action-failed', message: 'denied in panel' } })
    await waitFor(() => seen!.aborted)
    expect(await second).toMatchObject({ ok: true, result: { decision: 'cancelled' } })
  })

  it('refuses forwarding for calls it does not own, malformed payloads, duplicates, and oversized reasons', async () => {
    let release!: () => void
    const { h, a, frame } = await setup(() => new Promise((resolve) => { release = () => resolve('rejected') }))
    const b = await connectClient(h.url, identity('client-bbbb'))
    expect(await b.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap-1', reason: 'r' }))
      .toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await b.rpc(BRIDGE_APPROVAL_WITHDRAW_METHOD, { toolCallId: frame.id, approvalId: 'ap-1' }))
      .toMatchObject({ ok: true, result: { withdrawn: false } })
    for (const payload of [
      { toolCallId: frame.id, reason: 'r' },
      { toolCallId: frame.id, approvalId: '', reason: 'r' },
      { toolCallId: frame.id, approvalId: 'x'.repeat(129), reason: 'r' },
      { toolCallId: frame.id, approvalId: 'ap', reason: '  ' },
      { toolCallId: frame.id, approvalId: 'ap', reason: 'r', binding: 'not-hex' },
    ]) {
      expect(await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, payload)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
    expect(await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, {
      toolCallId: frame.id, approvalId: 'big', reason: 'x'.repeat(MAX_HOST_APPROVAL_REASON_CHARS + 1),
    })).toMatchObject({ ok: false, error: { code: 'too-large' } })
    const first = a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'dup', reason: 'r' })
    await waitFor(() => release !== undefined)
    expect(await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'dup', reason: 'r' }))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    release()
    expect(await first).toMatchObject({ ok: true, result: { decision: 'deny' } })
  })

  it('forwards the model tool call id with the approval', async () => {
    const requestHostApproval = vi.fn(async () => 'rejected' as const)
    const h = await startBridge({ requestHostApproval })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal, 1_000, 'sess-9', 'call-42')
    void call.catch(() => {})
    const frame = await nextToolCall(a)
    await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap', reason: 'r' })
    expect(requestHostApproval).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-9', callId: 'call-42' }))
    expect(toolCallIdArg({ callId: 'call-1' })).toEqual(['call-1'])
    expect(toolCallIdArg({ callId: '' })).toEqual([])
    expect(toolCallIdArg({})).toEqual([])
  })

  it('reports unavailable for calls without an agent session', async () => {
    const requestHostApproval = vi.fn(async () => 'allowed-once' as const)
    const h = await startBridge({ requestHostApproval })
    const a = await connectClient(h.url, identity('client-aaaa'))
    const call = h.bridge.requestTool('browser_click', { index: 1 }, new AbortController().signal)
    void call.catch(() => {})
    const frame = await nextToolCall(a)
    expect(await a.rpc(BRIDGE_APPROVAL_ASK_METHOD, { toolCallId: frame.id, approvalId: 'ap', reason: 'r' }))
      .toMatchObject({ ok: true, result: { decision: 'unavailable' } })
    expect(requestHostApproval).not.toHaveBeenCalled()
  })

  it('withdraws forwarded approvals when their connection closes', async () => {
    let seen: AbortSignal | undefined
    const { a, frame, call } = await setup((request) => new Promise((resolve) => {
      seen = request.signal
      request.signal.addEventListener('abort', () => { resolve('cancelled') })
    }))
    a.send({ t: 'rpc', id: 'ask', method: BRIDGE_APPROVAL_ASK_METHOD, payload: { toolCallId: frame.id, approvalId: 'ap', reason: 'r' } })
    await waitFor(() => seen !== undefined)
    a.ws.close()
    await expect(call).rejects.toBeInstanceOf(BridgeToolError)
    expect(seen!.aborted).toBe(true)
  })
})
