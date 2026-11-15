import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { BEACON_PORTS, BRIDGE_PATH, PINNED_CHROME_EXTENSION_ID } from '../src/protocol.ts'
import { apply as applyPlugin, Config, trustedForwardedPorts } from '../src/index.ts'

/** A configured token that passes the strength rule. */
const STRONG_TOKEN = '9e4b1f7c03a2d58e6b0c4f19a7d3e2b5'

async function apply(ctx: Context, config: Config): Promise<void> {
  await applyPlugin(ctx, new Config(config))
}

/**
 * The beacon opens real sockets; those are covered by discovery-beacon.spec.ts.
 * Mounting is asserted here through the factory, keeping this file hermetic.
 */
const beaconMock = vi.hoisted(() => ({
  start: vi.fn(async (): Promise<{ port: number; close: () => Promise<void> } | undefined> => ({
    port: 43189,
    close: async () => {},
  })),
}))

vi.mock('../src/discovery-beacon.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/discovery-beacon.ts')>()),
  startDiscoveryBeacon: beaconMock.start,
}))

/** Disposers the stub's `ctx.effect` collected; run after each test so no bridge outlives it. */
const disposers: Array<() => unknown> = []

/** Minimal context stub: apply only needs the services at registration time. */
function stubContext(): Context {
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({
        async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: { home: '/tmp' } } },
      }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({
      fetch: async (_request: Request, _peer: unknown) => new Response('not found', { status: 404 }),
    }),
    createPeer: () => ({ signal: new AbortController().signal, dispose: async () => {} }),
  }
  return {
    webServer: { host: '127.0.0.1', port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
    tools: { register: () => () => {}, guard: () => () => {} },
    agents: { get: () => undefined },
    get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown, label?: string) => {
      void label
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      return disposer as () => void
    },
  } as unknown as Context
}

const dirs: string[] = []
beforeEach(() => {
  beaconMock.start.mockClear()
})
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Valid budgets (the Loader applies schema defaults; hand-built tests pass them explicitly). */
const VALID = { toolTimeoutMs: 90_000, snapshotMaxChars: 32_000, maxInteractiveItems: 60, devToolsMaxChars: 24_000 }

describe('config', () => {
  it('resolves defaults, including an enabled workspace under the dsh home', () => {
    expect(new Config()).toEqual({
      ...VALID,
      sessionWorkspacePath: dshHomePath('browser-sessions'),
      auditLogPath: dshHomePath('browser-audit'),
      deferSessionCreate: true,
      beacon: true,
      beaconPorts: [...BEACON_PORTS],
      allowedChromeExtensionIds: [PINNED_CHROME_EXTENSION_ID],
      pairing: true,
      allowDangerFullAccess: false,
      safePermissionPresets: [],
      forwardedPorts: [],
      allowForwardedPorts: false,
      mcp: { enabled: false, port: 0 },
      devLoop: { enabled: false, allowedOrigins: [], trustLoopback: true },
    })
  })

  it('only accepts well-formed Chrome extension IDs', () => {
    expect(new Config({ allowedChromeExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'] }).allowedChromeExtensionIds)
      .toEqual(['abcdefghijklmnopabcdefghijklmnop'])
    expect(() => new Config({ allowedChromeExtensionIds: ['*'] })).toThrow()
    expect(() => new Config({ allowedChromeExtensionIds: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'] })).toThrow()
  })

  it('preserves explicit values and the empty-string workspace opt-out', () => {
    expect(new Config({
      token: STRONG_TOKEN,
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      deferSessionCreate: false,
      beacon: false,
    })).toEqual({
      token: STRONG_TOKEN,
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      devToolsMaxChars: 24_000,
      sessionWorkspacePath: '',
      auditLogPath: dshHomePath('browser-audit'),
      deferSessionCreate: false,
      beacon: false,
      beaconPorts: [...BEACON_PORTS],
      allowedChromeExtensionIds: [PINNED_CHROME_EXTENSION_ID],
      pairing: true,
      allowDangerFullAccess: false,
      safePermissionPresets: [],
      forwardedPorts: [],
      allowForwardedPorts: false,
      mcp: { enabled: false, port: 0 },
      devLoop: { enabled: false, allowedOrigins: [], trustLoopback: true },
    })
  })

  it('rejects beacon ports that are not usable ports', () => {
    expect(() => new Config({ beaconPorts: [0] })).toThrow()
    expect(() => new Config({ beaconPorts: [1.5] })).toThrow()
    expect(() => new Config({ beaconPorts: [65536] })).toThrow()
  })

  it('keeps the MCP endpoint off by default and validates its port', () => {
    expect(new Config({ mcp: { enabled: true } }).mcp).toEqual({ enabled: true, port: 0 })
    expect(new Config({ mcp: { port: 4100 } }).mcp).toEqual({ enabled: false, port: 4100 })
    expect(() => new Config({ mcp: { port: 70000 } })).toThrow()
  })

  it('accepts only bare http(s) origins as extra dev-loop origins', () => {
    expect(new Config({ devLoop: { allowedOrigins: ['http://myapp.test:3000'] } }).devLoop).toEqual({ enabled: false, allowedOrigins: ['http://myapp.test:3000'], trustLoopback: true })
    expect(new Config({ devLoop: { trustLoopback: false } }).devLoop).toEqual({ enabled: false, allowedOrigins: [], trustLoopback: false })
    expect(() => new Config({ devLoop: { allowedOrigins: ['http://myapp.test:3000/path'] } })).toThrow()
    expect(() => new Config({ devLoop: { allowedOrigins: ['*'] } })).toThrow()
  })

  it('keeps an empty port list when the beacon is disabled', () => {
    expect(new Config({ beacon: false, beaconPorts: [] }).beaconPorts).toEqual([])
  })
})

describe('apply', () => {
  /** A private dsh home per test: apply reads and writes the ledger, watchers and token there, never the developer's. */
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
  })

  it('registers the bridge with a fixed token (no generation)', async () => {
    const ctx = stubContext()
    const registerUpgrade = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await apply(ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })
    expect(registerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ path: BRIDGE_PATH }))
    await expect(stat(join(home, 'ext-bridge-token'))).rejects.toThrow()
  })

  /** A context whose composition has dsh's exact-route registry and the command registry. */
  function pairingContext() {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    const routes: Array<{ path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }> = []
    const commands: Array<{ name: string }> = []
    const disposeRoute = vi.fn()
    vi.spyOn(ctx, 'get').mockImplementation((key) => {
      if (key === 'connection') {
        return { ...(get(key) as object), fetch: { register: (route: typeof routes[number]) => { routes.push(route); return disposeRoute } } }
      }
      if ((key as string) === 'commands') return { register: (definition: { name: string }) => { commands.push(definition); return () => {} } }
      return get(key)
    })
    return { ctx, routes, commands, disposeRoute }
  }

  it('mounts the pairing controls behind dsh\'s own registries, and nothing public', async () => {
    const { ctx, routes, commands, disposeRoute } = pairingContext()
    const register = vi.spyOn(ctx.webServer, 'register')
    await apply(ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })
    expect(routes.map(route => `${route.methods.join(',')} ${route.path}`)).toEqual(['POST /api/bridge-browser.pairing'])
    expect(commands.map(command => command.name)).toEqual(['browser-pair'])
    // No pairing request is waiting on a fresh bridge.
    const listed = await routes[0]!.fetch(new Request('http://127.0.0.1/api/bridge-browser.pairing', { method: 'POST', body: '{"action":"list"}' }))
    expect(await listed.json()).toEqual({ ok: true, requests: [] })
    // The unauthenticated web server gets no pairing route.
    expect(register.mock.calls.map(call => (call[0] as { path: string }).path).filter(path => /pair/iu.test(path))).toEqual([])
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    expect(disposeRoute).toHaveBeenCalledOnce()
  })

  it('mounts no pairing control when pairing is switched off, and warns when the composition has none', async () => {
    const off = pairingContext()
    await apply(off.ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '', pairing: false })
    expect(off.routes).toEqual([])
    expect(off.commands).toEqual([])

    const bare = stubContext()
    const warn = vi.spyOn(bare.logger, 'warn')
    await apply(bare, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no pairing control'))
  })

  it.each([undefined, {}, { wireStream: {} }])('rejects unsupported Gateway capabilities: %j', async (gateway) => {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((key) => key === 'typertGateway' ? gateway : get(key))
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: STRONG_TOKEN, ...VALID })).rejects.toThrow(/dsh 0\.2\.2-rc\.2.*wireStream unavailable/)
    expect(register).not.toHaveBeenCalled()
  })

  it('rejects a Connection without the in-process Peer factory', async () => {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((key) => key === 'connection'
      ? { createSharedFetchHandler: () => ({ fetch: async () => new Response(null, { status: 404 }) }) }
      : get(key))
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: STRONG_TOKEN, ...VALID })).rejects.toThrow(/createPeer unavailable/)
    expect(register).not.toHaveBeenCalled()
  })

  it('leaves Remote event source ownership to the host composition', async () => {
    const ctx = stubContext()
    const gateway = ctx.get('typertGateway')
    const open = vi.spyOn(gateway.wireStream, 'open')

    await apply(ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })

    expect(open).not.toHaveBeenCalled()
  })

  it('generates and persists a token when none is configured', async () => {
    await apply(stubContext(), VALID)
    expect((await readFile(join(home, 'ext-bridge-token'), 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/u)
    if (process.platform !== 'win32') expect((await stat(join(home, 'ext-bridge-token'))).mode & 0o777).toBe(0o600)
  })

  it('copies the persisted token into an installed extension so Chrome needs no pasting', async () => {
    await mkdir(join(home, 'browser-extension'), { recursive: true })
    await writeFile(join(home, 'browser-extension', 'install-info.json'), '{}\n')
    await apply(stubContext(), VALID)
    const persisted = (await readFile(join(home, 'ext-bridge-token'), 'utf8')).trim()
    const copy = join(home, 'browser-extension', 'bridge-token')
    expect((await readFile(copy, 'utf8')).trim()).toBe(persisted)
    if (process.platform !== 'win32') expect((await stat(copy)).mode & 0o777).toBe(0o600)
  })

  it('never copies a token pinned in the plugin config into the installed extension', async () => {
    await mkdir(join(home, 'browser-extension'), { recursive: true })
    await writeFile(join(home, 'browser-extension', 'install-info.json'), '{}\n')
    await apply(stubContext(), { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })
    await expect(stat(join(home, 'browser-extension', 'bridge-token'))).rejects.toThrow()
  })

  it('warns when a pinned token differs from the installed extension copy instead of failing silently', async () => {
    await mkdir(join(home, 'browser-extension'), { recursive: true })
    await writeFile(join(home, 'browser-extension', 'install-info.json'), '{}\n')
    await writeFile(join(home, 'browser-extension', 'bridge-token'), 'an-older-installer-token-0123456789abcdef\n', { mode: 0o600 })
    const ctx = stubContext()
    const warn = vi.fn()
    ;(ctx as unknown as { logger: { warn: typeof warn } }).logger.warn = warn
    await apply(ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('token mismatch'))
  })

  it('rejects invalid budgets loudly', async () => {
    await expect(apply(stubContext(), { ...VALID, toolTimeoutMs: 0 })).rejects.toThrow(/toolTimeoutMs/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: -1 })).rejects.toThrow(/snapshotMaxChars/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: 499 })).rejects.toThrow(/snapshotMaxChars/)
  })

  it('requires at least one port when the beacon is enabled', async () => {
    await expect(apply(stubContext(), { beaconPorts: [] })).rejects.toThrow(/at least one port/)
  })

  it('advertises the bridge on the default beacon ports', async () => {
    await apply(stubContext(), { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })

    expect(beaconMock.start).toHaveBeenCalledOnce()
    expect(beaconMock.start.mock.calls[0]?.[0]).toMatchObject({
      ports: [...BEACON_PORTS],
      info: { pid: process.pid },
    })
  })

  it('honours a custom port list and the beacon opt-out', async () => {
    await apply(stubContext(), { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '', beaconPorts: [45111] })
    expect(beaconMock.start.mock.calls[0]?.[0]).toMatchObject({ ports: [45111] })

    beaconMock.start.mockClear()
    await apply(stubContext(), { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '', beacon: false })
    expect(beaconMock.start).not.toHaveBeenCalled()
  })

  it('skips the beacon when the host binds a non-loopback interface', async () => {
    const ctx = stubContext()
    Object.assign(ctx.webServer as unknown as Record<string, unknown>, { host: '10.0.0.7' })

    await apply(ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })

    expect(beaconMock.start).not.toHaveBeenCalled()
  })

  it('closes the beacon when the plugin is disposed', async () => {
    const close = vi.fn(async () => {})
    beaconMock.start.mockResolvedValueOnce({ port: 43190, close })
    let dispose: (() => unknown) | undefined
    const ctx = stubContext()
    const effect = ctx.effect.bind(ctx)
    vi.spyOn(ctx, 'effect').mockImplementation((fn: () => unknown, label?: string) => {
      const disposer = effect(fn, label) as (() => unknown) | undefined
      if (typeof label === 'string' && label.includes('discovery beacon')) dispose = disposer
      return disposer as () => void
    })

    await apply(ctx, { token: STRONG_TOKEN, ...VALID, sessionWorkspacePath: '' })
    await vi.waitFor(() => { expect(beaconMock.start).toHaveBeenCalledOnce() })
    await Promise.resolve()
    expect(typeof dispose).toBe('function')
    await dispose?.()

    expect(close).toHaveBeenCalledOnce()
  })
})

describe('forwarded ports', () => {
  it('honors forwardedPorts only with the explicit allowForwardedPorts acknowledgment', () => {
    const warn = vi.fn()
    expect(trustedForwardedPorts({ forwardedPorts: [4000], allowForwardedPorts: false }, warn)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowForwardedPorts'))
    expect(trustedForwardedPorts({ forwardedPorts: [4000], allowForwardedPorts: true }, warn)).toEqual([4000])
    expect(trustedForwardedPorts({ forwardedPorts: [], allowForwardedPorts: false }, warn)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
