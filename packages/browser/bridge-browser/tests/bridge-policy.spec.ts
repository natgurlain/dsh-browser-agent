import { describe, expect, it, vi } from 'vitest'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import {
  BRIDGE_ALLOWED_METHODS,
  DANGER_FULL_ACCESS_REFUSAL,
  relayTokenRef,
  withBridgePolicy,
} from '../src/bridge-policy.ts'

type Handler = (call: HostRpcCall) => HostRpcResult | Promise<HostRpcResult>

function harness(handlers: Record<string, Handler> = {}, options: Parameters<typeof withBridgePolicy>[1] = { allowDangerFullAccess: false }) {
  const inner = vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => {
    const handler = handlers[call.method]
    if (handler !== undefined) return handler(call)
    if (call.method === 'session.list') {
      return { ok: true, value: { items: [
        { sessionId: 'listed', origin: 'user', running: false },
        { sessionId: 'child', origin: 'subagent', running: false },
      ] } }
    }
    if (call.method === 'session.create') return { ok: true, value: { sessionId: 'created' } }
    return { ok: true, value: { method: call.method } }
  })
  const api: BrowserHostApi = { call: inner, async *events() {}, respond: async () => ({ accepted: true }) }
  const policy = withBridgePolicy(api, options)
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

describe('session scope', () => {
  it('allows sessions the bridge created and sessions the panel can list', async () => {
    const { call, inner } = harness()
    const created = await call('session.create', {})
    expect(created).toEqual({ ok: true, value: { sessionId: 'created' } })
    expect(await call('session.history', { sessionId: 'created' })).toMatchObject({ ok: true })
    expect(await call('session.history', { sessionId: 'listed' })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'session.history')).toHaveLength(2)
  })

  it('refuses sessions that are neither bridge-created nor listed for the panel', async () => {
    const { call, inner } = harness()
    for (const method of ['session.history', 'session.prompt', 'session.setPermission', 'commands.execute', 'session.cancel', 'session.attachment']) {
      const result = await call(method, { sessionId: 'desktop-private', preset: 'read-only', line: '/plan' })
      expect(result, method).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    // Subagent sessions are hidden from the panel, so they are out of scope too.
    expect(await call('session.prompt', { sessionId: 'child', content: [] })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
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

  it('exposes the same scope to the server-owned purge and snapshot methods', async () => {
    const { policy } = harness()
    const signal = new AbortController().signal
    expect(await policy.allowsSession('listed', signal)).toBe(true)
    expect(await policy.allowsSession('desktop-private', signal)).toBe(false)
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
  ])('refuses the command line %j', async (line) => {
    const { call, inner } = harness()
    await call('session.create', {})
    expect(await call('commands.execute', { sessionId: 'created', line })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(forwarded(inner, 'commands.execute')).toHaveLength(0)
  })

  it('uses the Host preset table to recognize renamed full-access presets', async () => {
    const { call } = harness({}, { allowDangerFullAccess: false, isFullAccessPreset: (preset) => preset === 'yolo' })
    await call('session.create', {})
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'yolo' })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'danger-full-access' })).toMatchObject({ ok: false })
  })

  it('still forwards restrictive presets and other commands', async () => {
    const { call, inner } = harness()
    await call('session.create', {})
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'read-only' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/permission workspace-write' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/permission' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/plan' })).toMatchObject({ ok: true })
    expect(forwarded(inner, 'commands.execute')).toHaveLength(3)
  })

  it('forwards full access only when the plugin config explicitly enables it', async () => {
    const { call, inner } = harness({}, { allowDangerFullAccess: true })
    await call('session.create', {})
    expect(await call('session.setPermission', { sessionId: 'created', preset: 'danger-full-access' })).toMatchObject({ ok: true })
    expect(await call('commands.execute', { sessionId: 'created', line: '/permission danger-full-access' })).toMatchObject({ ok: true })
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
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'relay-my-relay'], value: relayRoute('relay-my-relay') }] })).toMatchObject({ ok: true })
    expect(await call('settings.mutate', { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'relay-my-relay'] }] })).toMatchObject({ ok: true })
    expect(await call('settings.mutate', {
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: 'relay-my-relay' },
        { op: 'set', path: ['model'], value: 'm1' },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
    })).toMatchObject({ ok: true })
    expect(await call('credentials.set', { ref: 'DSH_RELAY_MY_RELAY_TOKEN', value: 'sk-relay' })).toMatchObject({ ok: true })
    expect(await call('credentials.unset', { ref: 'DSH_RELAY_MY_RELAY_TOKEN' })).toMatchObject({ ok: true })
    expect(await call('credentials.describe', { refs: ['DSH_RELAY_MY_RELAY_TOKEN'] })).toMatchObject({ ok: true })
    expect(inner).toHaveBeenCalledTimes(6)
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
    expect(await call('llm.discoverModels', { settingsNs: 'llm-pi-ai', provider: 'relay-a', api: 'openai-completions', baseURL: 'https://relay.example' })).toMatchObject({ ok: true })
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
