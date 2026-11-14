/**
 * Least-privilege fence between the extension connection and the dsh Host.
 *
 * The bridge speaks to dsh as the `owner` principal, so anything it forwards
 * runs with the local operator's full authority. This wrapper narrows that to
 * what the extension's panel and background actually call:
 *
 * - an explicit method allowlist (no `host.*`, no workspace mutation, no
 *   settings/credential writes outside the panel's relay-profile editor);
 * - session-targeted calls only for sessions this bridge created or that the
 *   panel can list (`session.list`, subagents excluded, as the panel does);
 * - no switch to a full-access permission preset (`session.setPermission` or
 *   `/permission <preset>`) unless the plugin config enables it;
 * - `settings.describe` projected down to the fields the panel reads, so other
 *   plugins' configuration (including secrets) never reaches the extension.
 *
 * @module @natgurlain/dsh-bridge-browser/src/bridge-policy
 */

import type { BrowserHostApi, HostRpcCall, HostRpcFailure, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

/** Host methods the extension may call through the bridge. */
export const BRIDGE_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'session.list',
  'session.create',
  'session.history',
  'session.models',
  'session.permissions',
  'session.setPermission',
  'session.selectModel',
  'session.attachment',
  'session.state',
  'session.cancel',
  'session.prompt',
  'commands.list',
  'commands.execute',
  'skills.list',
  'workspace.list',
  'permission.catalog',
  // The panel's relay-profile editor (Settings → relay stations) needs these;
  // each is narrowed below to relay routes and relay credential references.
  'settings.describe',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/** Methods whose `sessionId` must be in scope. `session.models` only when it names one. */
const SESSION_SCOPED_METHODS = new Set([
  'session.history',
  'session.models',
  'session.permissions',
  'session.setPermission',
  'session.selectModel',
  'session.attachment',
  'session.state',
  'session.cancel',
  'session.prompt',
  'commands.list',
  'commands.execute',
  'skills.list',
])

/** Preset names whose sandbox is full access in dsh's own tables. */
export const FULL_ACCESS_PRESET_NAMES: readonly string[] = ['danger-full-access', 'auto']

/** Relay route keys the panel mints (`relay-<slug>`, `relay-n<hash>`, `-x` dedupe suffixes). */
const RELAY_ROUTE_KEY = /^relay-[a-z0-9-]{1,128}$/u
/** Credential references the panel mints for relay routes. */
const RELAY_CREDENTIAL_REF = /^DSH_RELAY_[A-Z0-9_]{1,160}_TOKEN$/u
/** Protocols the panel offers for a relay route. */
const RELAY_PROTOCOLS = new Set(['openai-completions', 'anthropic-messages', 'openai-codex-responses'])
/** Fields the panel writes into one relay route. */
const RELAY_ROUTE_FIELDS = new Set(['displayName', 'apiKeyEnv', 'baseURL', 'models', 'api'])
/** Default-model fields the panel sets when a relay is made the default. */
const DEFAULT_MODEL_FIELDS = new Set(['provider', 'model', 'reasoningEffort'])
/** Provider fields the panel reads from `settings.describe`. */
const DESCRIBED_PROVIDER_FIELDS = ['displayName', 'api', 'baseURL', 'apiKeyEnv'] as const
/** Model fields the panel reads from `settings.describe`. */
const DESCRIBED_MODEL_FIELDS = ['id', 'name', 'contextWindow', 'reasoning'] as const

/**
 * Credential reference for one relay route; mirrors the panel's `relayTokenRef`.
 * @param routeKey - `relay-…` provider key.
 * @returns the credential store reference.
 */
export function relayTokenRef(routeKey: string): string {
  const suffix = routeKey.slice('relay-'.length).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
  return `DSH_RELAY_${suffix}_TOKEN`
}

/**
 * User-facing refusal for a full-access switch.
 * @param preset - the refused preset name.
 * @returns the message the panel shows.
 */
export const DANGER_FULL_ACCESS_REFUSAL = (preset: string): string =>
  `The browser extension cannot switch a session to the full-access permission preset "${preset}". `
  + 'Change it in DSH itself, or set `allowDangerFullAccess: true` in the bridge-browser plugin config to allow it from the browser.'

/** Options for {@link withBridgePolicy}. */
export interface BridgePolicyOptions {
  /** Allow switching sessions to a full-access preset from the extension. */
  allowDangerFullAccess: boolean
  /**
   * Resolve whether a preset grants a full-access sandbox (the Host's preset
   * table). Names in {@link FULL_ACCESS_PRESET_NAMES} always count.
   */
  isFullAccessPreset?: (preset: string) => boolean
}

/** The fenced Host API plus the session scope the server reuses for its own methods. */
export interface BridgePolicyApi extends BrowserHostApi {
  /** Whether a session is in the extension's scope (created here or listable by the panel). */
  allowsSession(sessionId: string, signal: AbortSignal): Promise<boolean>
}

function forbidden(message: string): HostRpcResult {
  const error: HostRpcFailure = { code: 'forbidden', message, details: {} }
  return { ok: false, error }
}

function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload.sessionId
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Wrap the Host API with the bridge's least-privilege policy.
 * @param api - the composed Host API (deferral, workspace grouping, adapter).
 * @param options - policy switches from the plugin config.
 * @returns the fenced API.
 */
export function withBridgePolicy(api: BrowserHostApi, options: BridgePolicyOptions): BridgePolicyApi {
  const known = new Set<string>()
  const isFullAccess = (preset: string): boolean => FULL_ACCESS_PRESET_NAMES.includes(preset)
    || (options.isFullAccessPreset?.(preset) ?? false)

  const noteListed = (value: unknown): void => {
    if (!isRecord(value) || !Array.isArray(value.items)) return
    for (const item of value.items) {
      // The panel hides subagent sessions; they stay out of the bridge's reach.
      if (isRecord(item) && typeof item.sessionId === 'string' && item.origin !== 'subagent') known.add(item.sessionId)
    }
  }

  const allowsSession = async (sessionId: string, signal: AbortSignal): Promise<boolean> => {
    if (known.has(sessionId)) return true
    const listed = await api.call({ rpcId: crypto.randomUUID(), method: 'session.list', payload: {}, signal })
    if (listed.ok) noteListed(listed.value)
    return known.has(sessionId)
  }

  const refuseFullAccess = (preset: string): HostRpcResult | undefined =>
    !options.allowDangerFullAccess && isFullAccess(preset.trim()) ? forbidden(DANGER_FULL_ACCESS_REFUSAL(preset.trim())) : undefined

  return {
    allowsSession,
    events: (signal) => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      if (!BRIDGE_ALLOWED_METHODS.has(call.method)) {
        return forbidden(`method ${JSON.stringify(call.method)} is not available to the browser extension`)
      }
      const refusal = refuseCall(call, refuseFullAccess)
      if (refusal !== undefined) return refusal

      const sessionId = sessionIdOf(call.payload)
      if (SESSION_SCOPED_METHODS.has(call.method) && sessionId !== undefined
        && !await allowsSession(sessionId, call.signal)) {
        return forbidden(`session ${JSON.stringify(sessionId)} is not available to the browser extension`)
      }
      if (SESSION_SCOPED_METHODS.has(call.method) && sessionId === undefined && call.method !== 'session.models') {
        // Refuse rather than forward: a Host request that also accepted another
        // addressing form would otherwise bypass the scope check above.
        return { ok: false, error: { code: 'bad-request', message: `${call.method} requires a non-empty sessionId`, details: {} } }
      }

      const result = await api.call(call)
      if (!result.ok) return result
      if (call.method === 'session.create') {
        const created = sessionIdOf(result.value)
        if (created !== undefined) known.add(created)
      }
      if (call.method === 'session.list') noteListed(result.value)
      if (call.method === 'settings.describe') return { ok: true, value: describedSettings(result.value) }
      return result
    },
  }
}

/** Payload-level refusals that do not depend on session scope. */
function refuseCall(
  call: HostRpcCall,
  refuseFullAccess: (preset: string) => HostRpcResult | undefined,
): HostRpcResult | undefined {
  const payload = isRecord(call.payload) ? call.payload : {}
  switch (call.method) {
    case 'session.create':
      return payload.agentPreset === undefined
        ? undefined
        : forbidden('session.create may not choose an agent preset from the browser extension')
    case 'session.setPermission':
      return typeof payload.preset === 'string' ? refuseFullAccess(payload.preset) : undefined
    case 'commands.execute': {
      if (typeof payload.line !== 'string') return undefined
      const command = /^\/([a-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/u.exec(payload.line)
      if (command === null || command[1] !== 'permission') return undefined
      return refuseFullAccess(command[2] ?? '')
    }
    case 'settings.mutate':
      return settingsMutationAllowed(payload) ? undefined : forbidden(
        'settings.mutate from the browser extension is limited to relay routes (llm-pi-ai providers.relay-*) and the default model',
      )
    case 'credentials.set':
    case 'credentials.unset':
      return typeof payload.ref === 'string' && RELAY_CREDENTIAL_REF.test(payload.ref)
        ? undefined
        : forbidden(`${call.method} from the browser extension is limited to relay credentials`)
    case 'credentials.describe':
      return Array.isArray(payload.refs) && payload.refs.length > 0
        && payload.refs.every((ref) => typeof ref === 'string' && RELAY_CREDENTIAL_REF.test(ref))
        ? undefined
        : forbidden('credentials.describe from the browser extension is limited to relay credentials')
    case 'llm.discoverModels':
      return payload.settingsNs === 'llm-pi-ai' && typeof payload.provider === 'string' && RELAY_ROUTE_KEY.test(payload.provider)
        ? undefined
        : forbidden('model discovery from the browser extension is limited to relay routes')
    default:
      return undefined
  }
}

function settingsMutationAllowed(payload: Record<string, unknown>): boolean {
  const { ns, ops } = payload
  if (!Array.isArray(ops) || ops.length === 0) return false
  if (ns === 'llm-pi-ai') return ops.every(relayRouteOpAllowed)
  if (ns === 'agent-default-model') return ops.every(defaultModelOpAllowed)
  return false
}

function opShape(op: unknown): { op: 'set' | 'unset'; path: string[]; value: unknown } | undefined {
  if (!isRecord(op) || (op.op !== 'set' && op.op !== 'unset')) return undefined
  if (!Array.isArray(op.path) || !op.path.every((segment) => typeof segment === 'string')) return undefined
  return { op: op.op, path: op.path as string[], value: op.value }
}

function relayRouteOpAllowed(raw: unknown): boolean {
  const op = opShape(raw)
  if (op === undefined || op.path.length !== 2 || op.path[0] !== 'providers') return false
  const key = op.path[1]!
  if (!RELAY_ROUTE_KEY.test(key)) return false
  if (op.op === 'unset') return true
  const route = op.value
  if (!isRecord(route)) return false
  if (!Object.keys(route).every((field) => RELAY_ROUTE_FIELDS.has(field))) return false
  // A relay may only spend its own credential: pointing it at the user's main
  // key would send that key to whatever baseURL the draft names.
  if (route.apiKeyEnv !== relayTokenRef(key)) return false
  if (typeof route.api !== 'string' || !RELAY_PROTOCOLS.has(route.api)) return false
  if (typeof route.baseURL !== 'string') return false
  if (route.displayName !== undefined && typeof route.displayName !== 'string') return false
  return Array.isArray(route.models) && route.models.every((model) => isRecord(model)
    && typeof model.id === 'string'
    && Object.keys(model).every((field) => field === 'id' || field === 'contextWindow')
    && (model.contextWindow === undefined || typeof model.contextWindow === 'number'))
}

function defaultModelOpAllowed(raw: unknown): boolean {
  const op = opShape(raw)
  if (op === undefined || op.path.length !== 1 || !DEFAULT_MODEL_FIELDS.has(op.path[0]!)) return false
  return op.op === 'unset' || typeof op.value === 'string'
}

/** Keep only what the panel reads: provider routes and the default model. */
function describedSettings(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.namespaces)) return { namespaces: [] }
  const namespaces: Array<{ ns: string; value: Record<string, unknown> }> = []
  for (const entry of value.namespaces) {
    if (!isRecord(entry) || !isRecord(entry.value)) continue
    if (entry.ns === 'llm-pi-ai') namespaces.push({ ns: entry.ns, value: describedProviders(entry.value) })
    if (entry.ns === 'agent-default-model') namespaces.push({ ns: entry.ns, value: pick(entry.value, [...DEFAULT_MODEL_FIELDS]) })
  }
  return { namespaces }
}

function describedProviders(value: Record<string, unknown>): Record<string, unknown> {
  const providers: Record<string, unknown> = {}
  if (isRecord(value.providers)) {
    for (const [key, route] of Object.entries(value.providers)) {
      if (!isRecord(route)) continue
      providers[key] = {
        ...pick(route, DESCRIBED_PROVIDER_FIELDS),
        ...(Array.isArray(route.models)
          ? { models: route.models.filter(isRecord).map((model) => pick(model, DESCRIBED_MODEL_FIELDS)) }
          : {}),
      }
    }
  }
  return { providers }
}

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field]
  return out
}
