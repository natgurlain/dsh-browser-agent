/**
 * Least-privilege fence between the extension connection and the dsh Host.
 *
 * The bridge speaks to dsh as the `owner` principal, so anything it forwards
 * runs with the local operator's full authority. This wrapper narrows that to
 * what the extension's panel and background actually call:
 *
 * - an explicit method allowlist (no `host.*`, no workspace mutation, no
 *   settings/credential writes outside the panel's relay-profile editor);
 * - session ownership: `session.create` is stripped to `{}` so the bridge
 *   always mints a fresh id, and only sessions the bridge created (this run or
 *   the durable ledger; a matching working directory proves nothing, since any
 *   CLI session can be started there) can be prompted,
 *   steered, injected into, or purged. Other listable non-subagent sessions
 *   (Desktop, CLI) stay readable — history, state, cancel — so an approval
 *   raised by such a session can still be shown; `session.list` and
 *   `workspace.list` answer only about the bridge's own sessions;
 * - no full access: bridge sessions start on a safe preset even when the Host
 *   default is full access, no switch to a full-access preset, and no prompt,
 *   snapshot injection, or command for a session currently running one —
 *   unless the plugin config sets `allowDangerFullAccess`. A preset counts as
 *   safe only when the Host's preset table (public API) bundles a
 *   `read-only` or `workspace-write` sandbox, or the operator names it in
 *   `safePermissionPresets`; unknown presets (including `custom`) are refused;
 * - relay credentials stay bound to the route they were entered for: cleared
 *   before a route moves to a new address without a fresh key, when a route is
 *   removed, and before a new route reuses a slot an earlier route left behind;
 * - `settings.describe` projected down to the fields the panel reads, so other
 *   plugins' configuration (including secrets) never reaches the extension.
 *
 * @module @natgurlain/dsh-bridge-browser/src/bridge-policy
 */

import type { BrowserHostApi, HostRpcCall, HostRpcFailure, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'
import { memorySessionLedger, type SessionLedger } from './session-ledger.ts'

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

/** Session-targeted methods that only read (or stop) a listable session. */
const SESSION_READ_METHODS = new Set([
  'session.history',
  // Reads one stored image of the session's history (message previews).
  'session.attachment',
  'session.models',
  'session.permissions',
  'session.state',
  'session.cancel',
  'commands.list',
  'skills.list',
])

/** Session-targeted methods that act in a session: bridge-created sessions only. */
const SESSION_WRITE_METHODS = new Set([
  'session.setPermission',
  'session.selectModel',
  'session.prompt',
  'commands.execute',
])

/** Write methods that also refuse a session currently running a full-access preset. */
const FULL_ACCESS_GATED_METHODS = new Set(['session.prompt', 'commands.execute'])

/** Preset names that are full access whatever the Host table says. */
export const FULL_ACCESS_PRESET_NAMES: readonly string[] = ['danger-full-access', 'auto']

/** Sandbox modes a safe preset may bundle. */
const SAFE_SANDBOXES = new Set(['read-only', 'workspace-write'])

/** Fields `llm.discoverModels` may carry from the panel. */
const DISCOVER_FIELDS = new Set(['settingsNs', 'provider', 'api', 'baseURL', 'apiKey'])

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

/**
 * User-facing refusal for a session currently running a full-access preset.
 * @param preset - the session's current preset.
 * @returns the message the panel shows.
 */
export const FULL_ACCESS_SESSION_REFUSAL = (preset: string): string =>
  `This session runs the permission preset "${preset}", which the browser extension treats as full access (or cannot verify). `
  + 'Switch it to a restricted preset such as workspace-write first, or set `allowDangerFullAccess: true` in the bridge-browser plugin config.'

/** Refusal for a session the bridge did not create. */
const NOT_BRIDGE_SESSION = (sessionId: string): string =>
  `session ${JSON.stringify(sessionId)} was not created by the browser extension; it can be viewed but not prompted, changed, or deleted from the browser`

/** Refusal for a bridge-owned external (MCP client) session: it has no DSH session behind it. */
export const EXTERNAL_SESSION_REFUSAL = (sessionId: string): string =>
  `session ${JSON.stringify(sessionId)} belongs to an external MCP client; it has no DSH conversation to read, prompt, or change`

/** Options for {@link withBridgePolicy}. */
export interface BridgePolicyOptions {
  /** Allow full-access presets from the extension (switching to and prompting in them). */
  allowDangerFullAccess: boolean
  /**
   * The sandbox mode the Host's preset table bundles for a preset (public
   * permission-presets API), or undefined when the Host cannot say.
   */
  presetSandbox?: (preset: string) => string | undefined
  /** Preset names the operator vouches for as restricted (plugin config). */
  safePresetNames?: readonly string[]
  /** Durable record of bridge-created sessions (the only ownership proof); defaults to memory only. */
  ledger?: SessionLedger
}

/** How a server-owned method touches a session. */
export type SessionAccess = 'read' | 'own' | 'write'

/** The fenced Host API plus the session scope the server reuses for its own methods. */
export interface BridgePolicyApi extends BrowserHostApi {
  /**
   * Whether a session is reachable for an access level: `read` for any
   * listable non-subagent session, `own` for bridge-created sessions, `write`
   * for bridge-created sessions not running a full-access preset.
   */
  allowsSession(sessionId: string, signal: AbortSignal, access?: SessionAccess): Promise<boolean>
  /**
   * The session's current permission preset when it is not a restricted one
   * (full access, `auto`, unknown), else undefined. Unlike the write gate this
   * ignores `allowDangerFullAccess`: standing grants such as the dev loop
   * never attach to a full-access session.
   */
  unsafePreset(sessionId: string, signal: AbortSignal): Promise<string | undefined>
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
 * Where a relay key would be sent: the origin (scheme, host, port) of a
 * baseURL. Paths may differ (`/v1`, listing fallbacks) without moving the key
 * to another server.
 */
function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value.trim()).origin
  } catch {
    return value.trim().replace(/\/+$/u, '')
  }
}

/**
 * Host command grammar (dsh-commands `parseCommand`): byte 0 is `/`, a name,
 * then the end of input or one of tab, LF, CR, space. The fence must refuse
 * everything the Host would run as `/permission`, and anything that merely
 * looks like it once Unicode spaces and compatibility forms are normalized.
 */
const HOST_COMMAND = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
/** The one `/permission` form the bridge forwards: a single preset name. */
const EXACT_PERMISSION = /^\/permission[ \t]+([a-z0-9_-]+)[ \t]*$/u
const LOOKS_LIKE_PERMISSION = /^[\s\p{Z}\p{Cf}]*\/[\s\p{Z}\p{Cf}]*permission(?![a-z0-9_])/iu

/**
 * Classify a command line for the `/permission` fence.
 * @param line - the exact composer line.
 * @returns `none` for other commands or text, the preset for an exact switch,
 *   or `malformed` for anything else that could be read as `/permission`.
 */
export function permissionCommandOf(line: string): { kind: 'none' } | { kind: 'switch'; preset: string } | { kind: 'malformed' } {
  const host = HOST_COMMAND.exec(line)
  const looksLike = LOOKS_LIKE_PERMISSION.test(line.normalize('NFKC'))
  if (host?.[1] !== 'permission' && !looksLike) return { kind: 'none' }
  const exact = EXACT_PERMISSION.exec(line)
  return exact === null ? { kind: 'malformed' } : { kind: 'switch', preset: exact[1]! }
}

/**
 * Wrap the Host API with the bridge's least-privilege policy.
 * @param api - the composed Host API (deferral, workspace grouping, adapter).
 * @param options - policy switches from the plugin config.
 * @returns the fenced API.
 */
export function withBridgePolicy(api: BrowserHostApi, options: BridgePolicyOptions): BridgePolicyApi {
  const ledger = options.ledger ?? memorySessionLedger()
  /** Non-subagent sessions the Host listed (read tier). */
  const listable = new Set<string>()
  /** Relay route keys whose baseURL changed this run without a fresh key. */
  const reroutedWithoutKey = new Set<string>()
  /** Relay credential references set since their route was last written. */
  const freshCredentials = new Set<string>()

  const isSafePreset = (preset: string): boolean => {
    const name = preset.trim()
    if (FULL_ACCESS_PRESET_NAMES.includes(name)) return false
    if (options.safePresetNames?.includes(name) === true) return true
    let sandbox: string | undefined
    try {
      sandbox = options.presetSandbox?.(name)
    } catch {
      return false
    }
    return sandbox !== undefined && SAFE_SANDBOXES.has(sandbox)
  }

  const inner = (method: string, payload: unknown, signal: AbortSignal): Promise<HostRpcResult> =>
    api.call({ rpcId: crypto.randomUUID(), method, payload, signal })

  const noteListed = (value: unknown): void => {
    if (!isRecord(value) || !Array.isArray(value.items)) return
    for (const item of value.items) {
      if (!isRecord(item) || typeof item.sessionId !== 'string' || item.origin === 'subagent') continue
      listable.add(item.sessionId)
    }
  }

  const owned = (sessionId: string): boolean => ledger.has(sessionId)

  const refreshList = async (signal: AbortSignal): Promise<void> => {
    const listed = await inner('session.list', {}, signal)
    if (listed.ok) noteListed(listed.value)
  }

  /** The session's current preset when it is not safe, else undefined. */
  const unsafePresetOf = async (sessionId: string, signal: AbortSignal): Promise<string | undefined> => {
    if (options.allowDangerFullAccess) return undefined
    return strictUnsafePresetOf(sessionId, signal)
  }

  /** The session's current preset when it is not safe, whatever `allowDangerFullAccess` says. */
  const strictUnsafePresetOf = async (sessionId: string, signal: AbortSignal): Promise<string | undefined> => {
    const permissions = await inner('session.permissions', { sessionId }, signal)
    const current = permissions.ok && isRecord(permissions.value) && typeof permissions.value.current === 'string'
      ? permissions.value.current
      : 'unknown'
    return isSafePreset(current) ? undefined : current
  }

  const allowsSession = async (sessionId: string, signal: AbortSignal, access: SessionAccess = 'read'): Promise<boolean> => {
    // External (MCP client) sessions: their audit log is readable, nothing else.
    if (ledger.external(sessionId) !== undefined) return access === 'read'
    if (access === 'read' ? !(owned(sessionId) || listable.has(sessionId)) : !owned(sessionId)) {
      await refreshList(signal)
    }
    const inScope = access === 'read' ? owned(sessionId) || listable.has(sessionId) : owned(sessionId)
    if (!inScope) return false
    if (access !== 'write') return true
    return await unsafePresetOf(sessionId, signal) === undefined
  }

  /** Put a freshly created session on a safe preset when the Host default is not. */
  const ensureSafePreset = async (sessionId: string, signal: AbortSignal): Promise<HostRpcResult | undefined> => {
    if (await unsafePresetOf(sessionId, signal) === undefined) return undefined
    const catalog = await inner('permission.catalog', {}, signal)
    const presets = catalog.ok && isRecord(catalog.value) && Array.isArray(catalog.value.options)
      ? catalog.value.options.flatMap((option) => isRecord(option) && typeof option.value === 'string' ? [option.value] : [])
      : []
    const safe = presets.filter(isSafePreset)
    const preset = safe.includes('workspace-write') ? 'workspace-write' : safe[0]
    if (preset === undefined) {
      return forbidden('The Host offers no restricted permission preset for browser sessions; '
        + 'add one (or name it in `safePermissionPresets`), or set `allowDangerFullAccess: true` in the bridge-browser plugin config.')
    }
    const applied = await inner('session.setPermission', { sessionId, preset }, signal)
    return applied.ok ? undefined : applied
  }

  const refuseFullAccessSwitch = (preset: string): HostRpcResult | undefined =>
    !options.allowDangerFullAccess && !isSafePreset(preset) ? forbidden(DANGER_FULL_ACCESS_REFUSAL(preset.trim())) : undefined

  /** The stored baseURL of a relay route, undefined when it has none, null when the Host could not say. */
  const storedBaseUrl = async (routeKey: string, signal: AbortSignal): Promise<string | undefined | null> => {
    const described = await inner('settings.describe', {}, signal)
    if (!described.ok || !isRecord(described.value) || !Array.isArray(described.value.namespaces)) return null
    const ns = described.value.namespaces.find((entry) => isRecord(entry) && entry.ns === 'llm-pi-ai')
    const providers = isRecord(ns) && isRecord(ns.value) && isRecord(ns.value.providers) ? ns.value.providers : undefined
    const route = providers?.[routeKey]
    return isRecord(route) ? normalizeBaseUrl(route.baseURL) : undefined
  }

  const refuseDiscovery = async (payload: Record<string, unknown>, signal: AbortSignal): Promise<HostRpcResult | undefined> => {
    if (payload.settingsNs !== 'llm-pi-ai' || typeof payload.provider !== 'string' || !RELAY_ROUTE_KEY.test(payload.provider)
      || !Object.keys(payload).every((field) => DISCOVER_FIELDS.has(field))) {
      return forbidden('model discovery from the browser extension is limited to relay routes')
    }
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim() !== '') return undefined
    // Without a draft key the Host spends the stored one: only on its own route.
    const stored = await storedBaseUrl(payload.provider, signal)
    if (stored === undefined || stored === null || reroutedWithoutKey.has(payload.provider)
      || (payload.baseURL !== undefined && normalizeBaseUrl(payload.baseURL) !== stored)) {
      return forbidden('Enter the relay API key to test a new or changed relay address; the stored key is only used with the address it was saved for.')
    }
    return undefined
  }

  /**
   * Relay credentials a settings.mutate must clear BEFORE it is forwarded:
   * routes whose baseURL changes without a fresh key (`rerouted`), and new
   * routes (no stored address) whose credential slot was not just filled by
   * the panel, so a key left behind by an earlier route (unset-then-set)
   * never follows the route to a new address.
   */
  const credentialsToClear = async (payload: Record<string, unknown>, signal: AbortSignal): Promise<{ rerouted: string[]; orphaned: string[] } | HostRpcResult> => {
    const rerouted: string[] = []
    const orphaned: string[] = []
    if (payload.ns !== 'llm-pi-ai' || !Array.isArray(payload.ops)) return { rerouted, orphaned }
    for (const raw of payload.ops) {
      const op = opShape(raw)
      if (op?.op !== 'set' || !isRecord(op.value)) continue
      const key = op.path[1]!
      if (freshCredentials.has(relayTokenRef(key))) continue
      const stored = await storedBaseUrl(key, signal)
      // Without the stored route the bridge cannot tell a re-save from a new route: refuse rather than guess.
      if (stored === null) return forbidden('The relay settings could not be read, so the route was not saved; try again.')
      if (stored === undefined) orphaned.push(key)
      else if (stored !== normalizeBaseUrl(op.value.baseURL)) rerouted.push(key)
    }
    return { rerouted, orphaned }
  }

  const clearCredential = async (key: string, signal: AbortSignal, after: 'before' | 'after'): Promise<HostRpcResult | undefined> => {
    const cleared = await inner('credentials.unset', { ref: relayTokenRef(key) }, signal)
    if (cleared.ok) return undefined
    return forbidden(after === 'before'
      ? `The stored key of relay route ${key} could not be cleared (${cleared.error.message}); the route was not saved.`
      : `Relay route ${key} was removed but its stored key could not be cleared (${cleared.error.message}); remove the key in DSH settings.`)
  }

  const call = async (call: HostRpcCall): Promise<HostRpcResult> => {
    if (!BRIDGE_ALLOWED_METHODS.has(call.method)) {
      return forbidden(`method ${JSON.stringify(call.method)} is not available to the browser extension`)
    }
    const payload = isRecord(call.payload) ? call.payload : {}
    const refusal = refuseCall(call, payload, refuseFullAccessSwitch)
    if (refusal !== undefined) return refusal

    const sessionId = sessionIdOf(call.payload)
    // An external session id never reaches the Host: no history, no prompt,
    // no preset, no command. Only the bridge's own browser path serves it.
    if (sessionId !== undefined && ledger.external(sessionId) !== undefined) {
      return forbidden(EXTERNAL_SESSION_REFUSAL(sessionId))
    }
    const readMethod = SESSION_READ_METHODS.has(call.method)
    const writeMethod = SESSION_WRITE_METHODS.has(call.method)
    if ((readMethod || writeMethod) && sessionId === undefined && call.method !== 'session.models') {
      // Refuse rather than forward: a Host request that also accepted another
      // addressing form would otherwise bypass the scope check below.
      return { ok: false, error: { code: 'bad-request', message: `${call.method} requires a non-empty sessionId`, details: {} } }
    }
    if (sessionId !== undefined && readMethod && !await allowsSession(sessionId, call.signal, 'read')) {
      return forbidden(`session ${JSON.stringify(sessionId)} is not available to the browser extension`)
    }
    if (sessionId !== undefined && writeMethod && !await allowsSession(sessionId, call.signal, 'own')) {
      return forbidden(NOT_BRIDGE_SESSION(sessionId))
    }
    if (sessionId !== undefined && FULL_ACCESS_GATED_METHODS.has(call.method)) {
      const permission = call.method === 'commands.execute' && typeof payload.line === 'string'
        ? permissionCommandOf(payload.line)
        : undefined
      // Switching a full-access session back to a restricted preset stays possible.
      if (permission?.kind !== 'switch') {
        const unsafe = await unsafePresetOf(sessionId, call.signal)
        if (unsafe !== undefined) return forbidden(FULL_ACCESS_SESSION_REFUSAL(unsafe))
      }
    }

    if (call.method === 'session.create') {
      // The bridge always mints a fresh id in its own workspace: no adopting
      // an existing session, no choosing a directory or workspace.
      const created = await api.call({ ...call, payload: {} })
      if (!created.ok) return created
      const createdId = sessionIdOf(created.value)
      if (createdId === undefined) return created
      await ledger.add(createdId)
      const unsafe = await ensureSafePreset(createdId, call.signal)
      return unsafe ?? created
    }
    if (call.method === 'llm.discoverModels') {
      const refused = await refuseDiscovery(payload, call.signal)
      if (refused !== undefined) return refused
    }
    let rerouted: string[] = []
    if (call.method === 'settings.mutate') {
      if (payload.ns === 'agent-default-model' && Array.isArray(payload.ops) && payload.ops.some((raw) => {
        const op = opShape(raw)
        return op?.op === 'set' && op.path[0] === 'provider' && typeof op.value === 'string' && reroutedWithoutKey.has(op.value)
      })) {
        return forbidden('Re-enter the API key of a relay whose address changed before making it the default model.')
      }
      const clear = await credentialsToClear(payload, call.signal)
      if ('ok' in clear) return clear
      rerouted = clear.rerouted
      // Cleared before the route is written: a Host call between the two
      // (model selection, a prompt) must never spend the old key at the new address.
      for (const key of [...clear.rerouted, ...clear.orphaned]) {
        const failed = await clearCredential(key, call.signal, 'before')
        if (failed !== undefined) return failed
      }
    }

    const result = await api.call(call)
    if (!result.ok) return result
    if (call.method === 'credentials.set' && typeof payload.ref === 'string') {
      freshCredentials.add(payload.ref)
      for (const key of [...reroutedWithoutKey]) if (relayTokenRef(key) === payload.ref) reroutedWithoutKey.delete(key)
    }
    if (call.method === 'settings.mutate' && payload.ns === 'llm-pi-ai' && Array.isArray(payload.ops)) {
      for (const raw of payload.ops) {
        const key = opShape(raw)?.path[1]
        if (key !== undefined) freshCredentials.delete(relayTokenRef(key))
      }
      // A stored key never follows its route to a new address.
      for (const key of rerouted) reroutedWithoutKey.add(key)
      // A removed route takes its key with it, so a later route of the same name starts keyless.
      for (const raw of payload.ops) {
        const op = opShape(raw)
        if (op?.op !== 'unset') continue
        reroutedWithoutKey.delete(op.path[1]!)
        const failed = await clearCredential(op.path[1]!, call.signal, 'after')
        if (failed !== undefined) return failed
      }
    }
    if (call.method === 'session.list') {
      noteListed(result.value)
      return { ok: true, value: ownedListing(result.value, owned) }
    }
    if (call.method === 'settings.describe') return { ok: true, value: describedSettings(result.value) }
    if (call.method === 'workspace.list') return { ok: true, value: ownedArchive(result.value, owned) }
    return result
  }

  return {
    allowsSession,
    unsafePreset: strictUnsafePresetOf,
    events: (signal) => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
    call,
  }
}

/** Keep only the bridge's own, non-subagent sessions in a listing. */
function ownedListing(value: unknown, owned: (sessionId: string) => boolean): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return value
  return {
    ...value,
    items: value.items.filter((item) => isRecord(item) && typeof item.sessionId === 'string'
      && item.origin !== 'subagent' && owned(item.sessionId)),
  }
}

/**
 * The panel reads only which of its sessions are archived; other sessions'
 * ids and every workspace path stay on the Host.
 */
function ownedArchive(value: unknown, owned: (sessionId: string) => boolean): { archivedSessionIds: string[] } {
  const archived = isRecord(value) && Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds : []
  return { archivedSessionIds: archived.filter((id): id is string => typeof id === 'string' && owned(id)) }
}

/** Payload-level refusals that do not depend on session scope. */
function refuseCall(
  call: HostRpcCall,
  payload: Record<string, unknown>,
  refuseFullAccessSwitch: (preset: string) => HostRpcResult | undefined,
): HostRpcResult | undefined {
  switch (call.method) {
    case 'session.create':
      return payload.agentPreset === undefined
        ? undefined
        : forbidden('session.create may not choose an agent preset from the browser extension')
    case 'session.setPermission':
      return typeof payload.preset === 'string' ? refuseFullAccessSwitch(payload.preset) : undefined
    case 'commands.execute': {
      if (typeof payload.line !== 'string') return undefined
      const permission = permissionCommandOf(payload.line)
      if (permission.kind === 'malformed') {
        return forbidden('Only `/permission <preset>` with a plain preset name can be sent from the browser extension.')
      }
      return permission.kind === 'switch' ? refuseFullAccessSwitch(permission.preset) : undefined
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
