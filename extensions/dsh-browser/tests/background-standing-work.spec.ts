// @vitest-environment jsdom

/**
 * Standing work in the assembled background worker: live watchers and the
 * bridge's host hint hold the runtime lease, bring the connection back after
 * a worker or browser restart, back off while dsh is unreachable, and count
 * for nothing behind the kill switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_CLOSE_CODES } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import { completeHandshake, panelSawConnected, TEST_BRIDGE_TOKEN } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'
import { chromeEvent, memoryStorage, panelPort } from './support/chrome.ts'


const REMOTE = 'wss://bridge.example/ext/bridge'
const LOCAL = 'ws://127.0.0.1:3999/ext/bridge'
const PLAIN_CAPS = { textOnly: true as const, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
const ALARM = { name: 'bridge-keepalive' } as chrome.alarms.Alarm
const WATCHED_PAGE = 'https://shop.example/item/42'

type RuntimeMessage = [unknown, chrome.runtime.MessageSender, (response: unknown) => void]

function watcher(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w-1', sessionId: 's1', tabId: 7, origin: 'https://shop.example', url: WATCHED_PAGE,
    condition: { kind: 'text', text: 'In stock', gone: false }, prompt: 'Buy one', createdAt: 0,
    expiresAt: Date.now() + 3_600_000, maxFires: 3, fires: 0, ...extra,
  }
}

function mockChrome(options: { local?: Record<string, unknown>; session?: Record<string, unknown>; settings?: Record<string, unknown>; accessLevels?: boolean } = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onCommand = chromeEvent<[string]>()
  const setAccessLevel = vi.fn(async () => {})
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onMessage = chromeEvent<RuntimeMessage>()
  const local = memoryStorage({
    dshClientId: 'test-client-0001',
    ...options.local,
    dshSettings: { token: TEST_BRIDGE_TOKEN, ...options.settings },
  })
  const session = memoryStorage(options.session)
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true), onAlarm }
  vi.stubGlobal('chrome', {
    alarms,
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    commands: { onCommand },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
      onButtonClicked: chromeEvent<[string, number]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getPlatformInfo: vi.fn(async () => ({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' })),
      onConnect,
      onMessage,
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: options.accessLevels === true ? Object.assign(local.area, { setAccessLevel }) : local.area,
      session: session.area,
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: WATCHED_PAGE } as chrome.tabs.Tab)),
      query: vi.fn(async () => [{ id: 7, windowId: 1, title: 'Tab', url: WATCHED_PAGE }] as chrome.tabs.Tab[]),
      remove: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => []),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: chromeEvent<[number]>(), onRemoved: chromeEvent<[number]>() },
  } as unknown as typeof chrome)
  return { alarms, onAlarm, onConnect, onCommand, onMessage, local, session, setAccessLevel }
}

/** A clock the test can move forward; installed before the worker module captures `Date.now`. */
function movableClock(): { advance: (ms: number) => void } {
  const real = Date.now.bind(Date)
  let offset = 0
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
  return { advance: (ms) => { offset += ms } }
}

/** dsh answers the pre-flight probe of a loopback address. */
function reachable(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ wsUrl: LOCAL }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Nothing listens on the loopback address. */
function unreachable(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function boot(): Promise<void> {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  await import('../src/background/index.ts')
}

const settle = (ms = 40): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const statuses = (postMessage: { mock: { calls: unknown[][] } }): Array<{ state: string; standing?: unknown }> => postMessage.mock.calls
  .map(([message]) => message as { type?: string; state: string; standing?: unknown })
  .filter((message) => message.type === 'status')
/** The panel's automatic discovery pass ended (so nothing of it outlives the test). */
const discoveryFinished = (postMessage: { mock: { calls: unknown[][] } }): Promise<void> => vi.waitFor(() => {
  expect(postMessage.mock.calls.some(([message]) => (message as { type?: string; discovery?: string }).type === 'status'
    && (message as { discovery?: string }).discovery === 'not-found')).toBe(true)
}, { timeout: 10_000 })
const hostHint = (mock: ReturnType<typeof mockChrome>): unknown => mock.local.data.dshStandingHost
const ATTACKER = 'ws://attacker.example:9000/ext/bridge'
/** A stored hint as an earlier connection to `url` left it. */
const storedHint = (url: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ dshStandingHost: { schedules: 1, mcp: true, url, seenAt: Date.now() - 1_000, ...extra } })

async function connectedWithPanel(mock: ReturnType<typeof mockChrome>, caps: Record<string, unknown> = PLAIN_CAPS) {
  await boot()
  const panel = panelPort()
  mock.onConnect.emit(panel.port)
  await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  await completeHandshake(socket, { caps: caps as never, until: panelSawConnected(panel.postMessage) })
  return { panel, socket }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('host hint from the bridge', () => {
  it('advertises standingUpdates, adopts the MAC-bound hint, stores it with the address, and reports it in the status', async () => {
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, { ...PLAIN_CAPS, standing: { schedules: 2, mcp: true } })
    const hello = socket.sent.find((frame) => (frame as { t?: unknown }).t === 'hello') as { caps: Record<string, unknown> }
    expect(hello.caps.standingUpdates).toBe(1)
    await vi.waitFor(() => {
      expect(hostHint(mock)).toEqual({ schedules: 2, mcp: true, url: REMOTE, seenAt: expect.any(Number) })
    })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'connected', standing: { watchers: 0, schedules: 2, mcp: true } })
  })

  it('follows sealed bridge/standing events, ignores a malformed one, clears the stored hint on "none", and never forwards them to the panel', async () => {
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, { ...PLAIN_CAPS, standing: { schedules: 0, mcp: false } })
    expect(hostHint(mock)).toBeUndefined()
    socket.receive({ t: 'event', frame: { rpcId: '', method: 'bridge/standing', payload: { schedules: 3, mcp: false } } })
    await vi.waitFor(() => { expect(hostHint(mock)).toMatchObject({ schedules: 3, mcp: false, url: REMOTE }) })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ standing: { schedules: 3, mcp: false } })

    for (const payload of [{ schedules: 'lots', mcp: false }, { schedules: -1, mcp: false }, { schedules: 1 }, { mcp: true }, null]) {
      socket.receive({ t: 'event', frame: { rpcId: '', method: 'bridge/standing', payload } })
    }
    await settle()
    expect(hostHint(mock)).toMatchObject({ schedules: 3, mcp: false })

    socket.receive({ t: 'event', frame: { rpcId: '', method: 'bridge/standing', payload: { schedules: 0, mcp: false } } })
    await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ standing: { watchers: 0, schedules: 0, mcp: false } })
    expect(panel.postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === 'event')).toBe(false)
  })

  it('an older bridge (no standing caps) still connects, and clears a hint stored earlier', async () => {
    const mock = mockChrome({
      settings: { bridgeUrl: REMOTE },
      local: { dshStandingHost: { schedules: 1, mcp: false, url: REMOTE, seenAt: Date.now() - 1_000 } },
    })
    const { panel } = await connectedWithPanel(mock)
    await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'connected', standing: { watchers: 0, schedules: 0, mcp: false } })
  })
})

describe('standing work holds the runtime lease', () => {
  async function idleWindowPassed(caps: Record<string, unknown>) {
    const clock = movableClock()
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, caps)
    panel.onDisconnect.emit()
    await settle()
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    // Six minutes later, with no panel, no call and no approval: the keepalive alarm re-evaluates the lease.
    clock.advance(6 * 60_000)
    mock.onAlarm.emit(ALARM)
    await settle()
    return { mock, socket }
  }

  it('keeps the connection past the idle window while the Host has standing work', async () => {
    const { socket, mock } = await idleWindowPassed({ ...PLAIN_CAPS, standing: { schedules: 1, mcp: false } })
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    // The Host's last schedule is cancelled: nothing holds the lease any more.
    socket.receive({ t: 'event', frame: { rpcId: '', method: 'bridge/standing', payload: { schedules: 0, mcp: false } } })
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) })
    expect(hostHint(mock)).toBeUndefined()
  })

  it('closes the connection after the idle window when there is none (the 5-minute rule is unchanged)', async () => {
    const { socket } = await idleWindowPassed(PLAIN_CAPS)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })
})

describe('headless reconnect for standing work', () => {
  const expiredLease = () => ({ dshRuntimeLease: { activeUntil: Date.now() - 60_000, url: LOCAL } })

  it('after a worker restart: a live watcher reconnects to the leased address although the idle window has passed', async () => {
    mockChrome({ settings: { allowPageWatchers: true }, session: { ...expiredLease(), dshPageWatchers: [watcher()] } })
    const fetchMock = reachable()
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(FakeWebSocket.instances[0]!.url).toBe(LOCAL)
    // Only the pre-flight probe of that one address; never a discovery sweep.
    for (const [url] of fetchMock.mock.calls as unknown as Array<[string]>) expect(String(url)).toContain('127.0.0.1:3999')
    expect(chrome.alarms.create).toHaveBeenCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
  })

  it('a watcher does not count while the page-watchers setting is off, or once it has expired', async () => {
    mockChrome({ settings: { allowPageWatchers: false }, session: { ...expiredLease(), dshPageWatchers: [watcher()] } })
    const fetchMock = reachable()
    await boot()
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()

    vi.resetModules()
    mockChrome({ settings: { allowPageWatchers: true }, session: { ...expiredLease(), dshPageWatchers: [watcher({ expiresAt: Date.now() - 1 })] } })
    await boot()
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('after a browser restart: the hint in storage.local reconnects to its own address, without discovery', async () => {
    // storage.session is empty after a browser restart; watchers are gone by design.
    mockChrome({ local: { dshLastBridgeUrl: LOCAL, dshStandingHost: { schedules: 1, mcp: true, url: LOCAL, seenAt: Date.now() - 3_600_000 } } })
    const fetchMock = reachable()
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(FakeWebSocket.instances[0]!.url).toBe(LOCAL)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const [url] of fetchMock.mock.calls as unknown as Array<[string]>) expect(String(url)).toContain('127.0.0.1:3999')
  })

  it('ignores and removes a stored hint that is malformed or too old', async () => {
    for (const stale of [
      { schedules: 1, mcp: false, url: LOCAL, seenAt: Date.now() - 8 * 24 * 60 * 60_000 },
      { schedules: 'many', mcp: true, url: LOCAL, seenAt: Date.now() },
      { schedules: 1, mcp: false, url: 'https://example.com/', seenAt: Date.now() },
    ]) {
      vi.resetModules()
      const mock = mockChrome({ local: { dshLastBridgeUrl: LOCAL, dshStandingHost: stale } })
      const fetchMock = reachable()
      await boot()
      await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
      await settle()
      expect(FakeWebSocket.instances).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })
})

describe('backoff while dsh is unreachable', () => {
  const hint = () => ({ dshLastBridgeUrl: LOCAL, dshStandingHost: { schedules: 1, mcp: false, url: LOCAL, seenAt: Date.now() - 1_000 } })
  const oneShots = (mock: ReturnType<typeof mockChrome>): number[] => mock.alarms.create.mock.calls
    .map(([, info]) => (info as { when?: number }).when)
    .filter((when): when is number => typeof when === 'number')

  it('parks after a failed attempt, retries only when due, doubles the wait, and never opens a socket or scans', async () => {
    const clock = movableClock()
    const mock = mockChrome({ local: hint() })
    const fetchMock = unreachable()
    await boot()
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 1 }) })
    const probes = fetchMock.mock.calls.length
    expect(probes).toBeGreaterThan(0)
    for (const [url] of fetchMock.mock.calls as unknown as Array<[string]>) expect(String(url)).toContain('127.0.0.1:3999')
    // A one-shot alarm about 30 s out replaces the half-minute keepalive.
    const first = oneShots(mock).at(-1)!
    expect(first - Date.now()).toBeGreaterThan(29_000)
    expect(first - Date.now()).toBeLessThanOrEqual(30_000)

    // Woken early (any event): not due, so no probe; the alarm is re-armed.
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(fetchMock.mock.calls.length).toBe(probes)

    clock.advance(31_000)
    mock.onAlarm.emit(ALARM)
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 2 }) })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(probes)
    const second = oneShots(mock).at(-1)!
    expect(second - Date.now()).toBeGreaterThan(59_000)
    expect(second - Date.now()).toBeLessThanOrEqual(60_000)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('lets the worker sleep while parked, and keeps it awake once connected for standing work', async () => {
    // Only the keeper's heartbeat interval is faked.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const mock = mockChrome({ local: hint() })
    unreachable()
    await boot()
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 1 }) })
    vi.advanceTimersByTime(61_000)
    expect(chrome.runtime.getPlatformInfo).not.toHaveBeenCalled()

    // dsh comes back; the retry is due.
    mock.session.data.dshStandingRetry = undefined
    vi.resetModules()
    FakeWebSocket.instances = []
    const again = mockChrome({ local: hint() })
    reachable()
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, {
      caps: { ...PLAIN_CAPS, standing: { schedules: 1, mcp: false } },
      until: () => { expect(hostHint(again)).toMatchObject({ schedules: 1 }) },
    })
    vi.advanceTimersByTime(21_000)
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalled()
    expect(socket.sent).toContainEqual({ t: 'pong' })
  })

  it('a restarted worker does not shortcut a parked retry: no probe, the one-shot alarm is re-armed', async () => {
    const nextAt = Date.now() + 100_000
    const mock = mockChrome({ local: hint(), session: { dshStandingRetry: { failures: 2, nextAt } } })
    const fetchMock = unreachable()
    await boot()
    await vi.waitFor(() => { expect(oneShots(mock)).toContain(nextAt) })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('opening a panel restores the normal cadence', async () => {
    const mock = mockChrome({ local: hint() })
    unreachable()
    await boot()
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 1 }) })
    const panel = panelPort()
    mock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toBeUndefined() })
    expect(mock.alarms.create).toHaveBeenLastCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
    await discoveryFinished(panel.postMessage)
  })

  it('a successful connection restores the normal cadence', async () => {
    const mock = mockChrome({ local: hint(), session: { dshStandingRetry: { failures: 3, nextAt: Date.now() - 1 } } })
    reachable()
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, {
      caps: { ...PLAIN_CAPS, standing: { schedules: 1, mcp: false } },
      until: () => { expect(mock.session.data.dshStandingRetry).toBeUndefined() },
    })
    expect(mock.alarms.create).toHaveBeenLastCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
    expect(hostHint(mock)).toMatchObject({ schedules: 1, url: LOCAL })
  })
})

describe('kill switch', () => {
  it('engaged at startup: standing work counts as zero, nothing reconnects, and the stored hint is removed', async () => {
    const mock = mockChrome({
      settings: { allowPageWatchers: true },
      local: { dshKillSwitch: true, dshLastBridgeUrl: LOCAL, dshStandingHost: { schedules: 2, mcp: true, url: LOCAL, seenAt: Date.now() - 1_000 } },
      session: { dshRuntimeLease: { activeUntil: Date.now() - 1, url: LOCAL }, dshPageWatchers: [watcher()] },
    })
    const fetchMock = reachable()
    await boot()
    await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mock.alarms.create).not.toHaveBeenCalled()
    // The alarm of an earlier worker fires anyway: still nothing.
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('engaging it clears the hint (stored copy included) and the connection stays down with no panel', async () => {
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, { ...PLAIN_CAPS, standing: { schedules: 2, mcp: true } })
    await vi.waitFor(() => { expect(hostHint(mock)).toBeDefined() })
    panel.onMessage.emit({ type: 'kill-switch.engage' })
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) })
    await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'stopped', standing: { watchers: 0, schedules: 0, mcp: false } })
    panel.onDisconnect.emit()
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('a watcher hit while the bridge is reconnecting', () => {
  it('with dsh unreachable: one bounded attempt, a prompt miss, and later hits do not probe again', async () => {
    const mock = mockChrome({
      settings: { allowPageWatchers: true },
      session: { dshRuntimeLease: { activeUntil: Date.now() - 60_000, url: LOCAL }, dshPageWatchers: [watcher()] },
    })
    const fetchMock = unreachable()
    await boot()
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 1 }) })
    const sender = { id: 'test-extension', tab: { id: 7, url: WATCHED_PAGE } as chrome.tabs.Tab, url: WATCHED_PAGE, frameId: 0 }
    const first = vi.fn()
    const startedAt = Date.now()
    mock.onMessage.emit({ type: 'DSH_WATCH_HIT', watchId: 'w-1', matched: 'In stock' }, sender, first)
    await vi.waitFor(() => { expect(first).toHaveBeenCalledWith({ accepted: false, reason: 'bridge' }) })
    // The failed attempt answers the hit; it does not sit out the whole wait.
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 2 })
    const probes = fetchMock.mock.calls.length
    const second = vi.fn()
    mock.onMessage.emit({ type: 'DSH_WATCH_HIT', watchId: 'w-1', matched: 'In stock' }, sender, second)
    await vi.waitFor(() => { expect(second).toHaveBeenCalledWith(expect.objectContaining({ accepted: false })) })
    expect(fetchMock.mock.calls.length).toBe(probes)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('waits for the headless connection and then wakes the session instead of recording a miss', async () => {
    const mock = mockChrome({
      settings: { allowPageWatchers: true },
      session: { dshRuntimeLease: { activeUntil: Date.now() - 60_000, url: LOCAL }, dshPageWatchers: [watcher()] },
    })
    reachable()
    await boot()
    const answered = vi.fn()
    // The content script reports the hit as the worker wakes up, before the socket is authenticated.
    const kept = mock.onMessage.emit(
      { type: 'DSH_WATCH_HIT', watchId: 'w-1', matched: 'In stock' },
      { id: 'test-extension', tab: { id: 7, url: WATCHED_PAGE } as chrome.tabs.Tab, url: WATCHED_PAGE, frameId: 0 },
      answered,
    )
    expect(kept).toContain(true)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await settle()
    expect(answered).not.toHaveBeenCalled()
    socket.open()
    type Rpc = { t: 'rpc'; id: string; method: string; payload: Record<string, unknown> }
    const fired = (): Rpc | undefined => socket.sent.find((frame): frame is Rpc => (frame as Rpc).t === 'rpc' && (frame as Rpc).method === 'bridge.watch.fire')
    await completeHandshake(socket, { until: () => { expect(fired()).toBeDefined() } })
    const fire = fired()!
    expect(fire.payload).toMatchObject({ watchId: 'w-1', sessionId: 's1', prompt: 'Buy one', matched: 'In stock' })
    socket.receive({ t: 'rpc.result', id: fire.id, ok: true, result: { type: 'server-response', rpcId: fire.id, result: { ok: true, value: { woken: true } } } })
    await vi.waitFor(() => { expect(answered).toHaveBeenCalledWith({ accepted: true }) })
    const stored = (mock.session.data.dshPageWatchers as Array<Record<string, unknown>>)[0]!
    expect(stored).toMatchObject({ fires: 1 })
    expect(stored).not.toHaveProperty('lastMiss')
  })
})

describe('storage is closed to content scripts', () => {
  it('restricts storage.local to trusted contexts at worker start, and works where the API is missing', async () => {
    const mock = mockChrome({ accessLevels: true })
    await boot()
    expect(mock.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    // Firefox: no setAccessLevel anywhere. Booting must not throw.
    vi.resetModules()
    const firefox = mockChrome()
    await boot()
    await settle()
    expect(firefox.setAccessLevel).not.toHaveBeenCalled()
  })

  it('a throwing or rejecting setAccessLevel does not stop the worker', async () => {
    const mock = mockChrome({ accessLevels: true, settings: { bridgeUrl: REMOTE } })
    mock.setAccessLevel.mockImplementation(async () => { throw new Error('not allowed') })
    const { panel } = await connectedWithPanel(mock)
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'connected' })
  })
})

describe('a stored hint never names the address to dial', () => {
  async function staysAsleep(mock: ReturnType<typeof mockChrome>, fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    await boot()
    await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
    await settle()
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mock.alarms.create).not.toHaveBeenCalled()
  }

  it('a forged hint alone (no panel, no configured address) dials nothing and is removed', async () => {
    await staysAsleep(mockChrome({ local: storedHint(ATTACKER) }), reachable())
  })

  it('with no configured address, only the remembered loopback address counts', async () => {
    // Loopback, but not an address this extension remembered from a proven handshake.
    await staysAsleep(mockChrome({ local: storedHint(LOCAL) }), reachable())
    vi.resetModules()
    await staysAsleep(mockChrome({ local: { ...storedHint('ws://127.0.0.1:4555/ext/bridge'), dshLastBridgeUrl: LOCAL } }), reachable())
    // Remembered, but not loopback (a forged "remembered" address is not enough either).
    vi.resetModules()
    await staysAsleep(mockChrome({ local: { ...storedHint(ATTACKER), dshLastBridgeUrl: ATTACKER } }), reachable())
  })

  it('a hint from another bridge does not hold the lease for the configured address', async () => {
    await staysAsleep(mockChrome({ settings: { bridgeUrl: 'wss://other.example/ext/bridge' }, local: storedHint(REMOTE) }), unreachable())
  })

  it('a hint for an address the user has since removed is dropped after a browser restart', async () => {
    await staysAsleep(mockChrome({ settings: { bridgeUrl: '' }, local: storedHint(REMOTE, { seenAt: Date.now() - 6 * 24 * 60 * 60_000 }) }), unreachable())
  })

  it('a hint for the configured address reconnects there (a bare host matches its bridge path) and is renewed only by an authenticated hello.ok', async () => {
    const seenAt = Date.now() - 6 * 24 * 60 * 60_000
    const mock = mockChrome({ settings: { bridgeUrl: 'wss://bridge.example' }, local: storedHint(REMOTE, { seenAt }) })
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toBe(REMOTE)
    socket.open()
    await settle()
    // Dialling, restoring and waiting never touch the stored record.
    expect(hostHint(mock)).toMatchObject({ seenAt })
    // The bridge proves the token but reports no standing work: the hint is gone, not renewed.
    await completeHandshake(socket, { caps: { ...PLAIN_CAPS, standing: { schedules: 0, mcp: false } }, until: () => { expect(hostHint(mock)).toBeUndefined() } })
  })
})

describe('changing the connection settings', () => {
  async function leftBridge(change: Record<string, unknown>) {
    const clock = movableClock()
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, { ...PLAIN_CAPS, standing: { schedules: 1, mcp: true } })
    await vi.waitFor(() => { expect(hostHint(mock)).toBeDefined() })
    unreachable()
    panel.onMessage.emit({ type: 'settings', id: 's1', settings: change })
    await vi.waitFor(() => {
      expect(panel.postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === 'settings.result')).toBe(true)
    }, { timeout: 15_000 })
    return { clock, mock, panel, socket }
  }

  it('removing the address forgets the hint and the headless address: nothing redials the removed bridge', async () => {
    const { clock, mock, panel, socket } = await leftBridge({ bridgeUrl: '' })
    await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) }, { timeout: 15_000 })
    expect(hostHint(mock)).toBeUndefined()
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ standing: { watchers: 0, schedules: 0, mcp: false } })
    const sockets = FakeWebSocket.instances.length
    panel.onDisconnect.emit()
    clock.advance(6 * 60_000)
    mock.onAlarm.emit(ALARM)
    await settle(200)
    expect(FakeWebSocket.instances).toHaveLength(sockets)
    expect(mock.session.data.dshRuntimeLease).toBeUndefined()
  }, 40_000)

  it('removing the address right after agent activity: the still-active lease does not redial the removed bridge either', async () => {
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, { ...PLAIN_CAPS, standing: { schedules: 1, mcp: true } })
    // A tool call just ran: the lease is held by recent activity, whatever standing work says.
    socket.receive({ t: 'tool.call', id: 'recent', name: 'browser_tabs', args: {}, expiresAt: Date.now() + 10_000 })
    await vi.waitFor(() => { expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'recent' })) })
    unreachable()
    panel.onMessage.emit({ type: 'settings', id: 's1', settings: { bridgeUrl: '' } })
    await discoveryFinished(panel.postMessage)
    const sockets = FakeWebSocket.instances.length
    panel.onDisconnect.emit()
    mock.onAlarm.emit(ALARM)
    await settle(200)
    expect(FakeWebSocket.instances).toHaveLength(sockets)
  }, 40_000)

  it('changing only the token forgets the hint too; the new connection must report it again', async () => {
    const { mock } = await leftBridge({ token: 'another-token' })
    expect(hostHint(mock)).toBeUndefined()
  }, 40_000)
})

describe('a bridge that ended the connection for good', () => {
  it('after close code 4000 (replaced) neither the alarm nor a restarted worker reclaims the slot; a panel does', async () => {
    const clock = movableClock()
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, { ...PLAIN_CAPS, standing: { schedules: 1, mcp: false } })
    await vi.waitFor(() => { expect(hostHint(mock)).toBeDefined() })
    panel.onDisconnect.emit()
    clock.advance(6 * 60_000)
    socket.close(BRIDGE_CLOSE_CODES.replaced, 'replaced')
    await vi.waitFor(() => { expect(mock.local.data.dshBridgeRefusal).toBe('replaced') })
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
    // The worker sleeps; the next one starts from storage.
    const local = { ...mock.local.data }
    const session = { ...mock.session.data }
    vi.resetModules()
    const again = mockChrome({ local, session, settings: { bridgeUrl: REMOTE } })
    await boot()
    again.onAlarm.emit(ALARM)
    await settle(150)
    expect(FakeWebSocket.instances).toHaveLength(1)
    // Standing work does not keep waking a worker that may not reconnect.
    expect(again.alarms.create).not.toHaveBeenCalled()
    // The user opens a panel: an explicit return clears the latch and reconnects.
    again.onConnect.emit(panelPort().port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(again.local.data.dshBridgeRefusal).toBeUndefined()
  })

  it('replaced while the lease is still held by recent activity: a restarted worker does not reclaim the slot', async () => {
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock)
    panel.onDisconnect.emit()
    await vi.waitFor(() => { expect(mock.session.data.dshRuntimeLease).toMatchObject({ url: REMOTE }) })
    const lease = mock.session.data.dshRuntimeLease
    socket.close(BRIDGE_CLOSE_CODES.replaced, 'replaced')
    await vi.waitFor(() => { expect(mock.local.data.dshBridgeRefusal).toBe('replaced') })
    vi.resetModules()
    const again = mockChrome({ local: { ...mock.local.data }, session: { dshRuntimeLease: lease }, settings: { bridgeUrl: REMOTE } })
    await boot()
    again.onAlarm.emit(ALARM)
    await settle(150)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it.each([
    ['token-mismatch', BRIDGE_CLOSE_CODES.authFailed],
    ['version-mismatch', BRIDGE_CLOSE_CODES.versionMismatch],
    ['origin-rejected', BRIDGE_CLOSE_CODES.originRejected],
  ] as const)('a headless reconnect refused with %s is not retried', async (failure, code) => {
    const clock = movableClock()
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE }, local: storedHint(REMOTE) })
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await settle()
    socket.close(code, 'refused')
    await vi.waitFor(() => { expect(mock.local.data.dshBridgeRefusal).toBe(failure) })
    for (const wait of [31_000, 61_000, 5 * 60_000]) {
      clock.advance(wait)
      mock.onAlarm.emit(ALARM)
      await settle()
    }
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a busy bridge is not a refusal: the standing-work backoff keeps retrying', async () => {
    const clock = movableClock()
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE }, local: storedHint(REMOTE) })
    await boot()
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    FakeWebSocket.instances[0]!.open()
    await settle()
    FakeWebSocket.instances[0]!.close(BRIDGE_CLOSE_CODES.busy, 'busy')
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 1 }) })
    expect(mock.local.data.dshBridgeRefusal).toBeUndefined()
    clock.advance(31_000)
    mock.onAlarm.emit(ALARM)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
  })
})

describe('bridge/standing events need the cap', () => {
  it('an older bridge (no standing cap) cannot set the hint with an event that uses the name, and it is not shown to the panel', async () => {
    const mock = mockChrome({ settings: { bridgeUrl: REMOTE } })
    const { panel, socket } = await connectedWithPanel(mock, PLAIN_CAPS)
    socket.receive({ t: 'event', frame: { rpcId: 'host-1', method: 'bridge/standing', payload: { schedules: 9, mcp: true } } })
    await settle(80)
    expect(hostHint(mock)).toBeUndefined()
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ standing: { watchers: 0, schedules: 0, mcp: false } })
    expect(panel.postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === 'event')).toBe(false)
  })
})

describe('kill switch during a reconnect', () => {
  const hit = (mock: ReturnType<typeof mockChrome>, answered: (response: unknown) => void): void => {
    mock.onMessage.emit(
      { type: 'DSH_WATCH_HIT', watchId: 'w-1', matched: 'In stock' },
      { id: 'test-extension', tab: { id: 7, url: WATCHED_PAGE } as chrome.tabs.Tab, url: WATCHED_PAGE, frameId: 0 },
      answered,
    )
  }

  it('engaged in the middle of a backoff: the retry is dropped, the hint cleared, and releasing it resurrects neither', async () => {
    const clock = movableClock()
    const mock = mockChrome({ local: { dshLastBridgeUrl: LOCAL, ...storedHint(LOCAL) } })
    const fetchMock = unreachable()
    await boot()
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toMatchObject({ failures: 1 }) })
    mock.onCommand.emit('kill-switch')
    await vi.waitFor(() => { expect(hostHint(mock)).toBeUndefined() })
    expect(mock.session.data.dshStandingRetry).toBeUndefined()
    expect(mock.local.data.dshKillSwitch).toBe(true)
    const probes = fetchMock.mock.calls.length
    // The retry's one-shot alarm (or any later wake-up) finds nothing to do.
    clock.advance(10 * 60_000)
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(fetchMock.mock.calls.length).toBe(probes)
    expect(FakeWebSocket.instances).toHaveLength(0)

    // Released from a panel: the user's reconnect runs, but the cleared hint stays cleared.
    const panel = panelPort()
    mock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'kill-switch.release' })
    await vi.waitFor(() => { expect(mock.local.data.dshKillSwitch).toBe(false) })
    await discoveryFinished(panel.postMessage)
    expect(hostHint(mock)).toBeUndefined()
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ standing: { watchers: 0, schedules: 0, mcp: false } })
    // With the panel closed again nothing holds the lease.
    panel.onDisconnect.emit()
    const afterRelease = fetchMock.mock.calls.length
    clock.advance(10 * 60_000)
    mock.onAlarm.emit(ALARM)
    await settle()
    expect(fetchMock.mock.calls.length).toBe(afterRelease)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('engaged while a watcher hit waits for the reconnect: the hit is refused at once and never fires', async () => {
    const mock = mockChrome({
      settings: { allowPageWatchers: true },
      session: { dshRuntimeLease: { activeUntil: Date.now() - 60_000, url: LOCAL }, dshPageWatchers: [watcher()] },
    })
    reachable()
    await boot()
    const answered = vi.fn()
    hit(mock, answered)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await settle()
    expect(answered).not.toHaveBeenCalled()
    const engagedAt = Date.now()
    mock.onCommand.emit('kill-switch')
    await vi.waitFor(() => { expect(answered).toHaveBeenCalledWith(expect.objectContaining({ accepted: false })) })
    expect(Date.now() - engagedAt).toBeLessThan(3_000)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(socket.sent.some((frame) => (frame as { method?: string }).method === 'bridge.watch.fire')).toBe(false)
    // The switch revoked the watcher itself.
    await vi.waitFor(() => { expect(mock.session.data.dshPageWatchers).toEqual([]) })
  })
})

describe('a watcher hit whose tab moved on during the wait', () => {
  it('does not fire for the page the tab left: the origin is checked against where the tab is now', async () => {
    const mock = mockChrome({
      settings: { allowPageWatchers: true },
      session: { dshRuntimeLease: { activeUntil: Date.now() - 60_000, url: LOCAL }, dshPageWatchers: [watcher()] },
    })
    reachable()
    await boot()
    const answered = vi.fn()
    mock.onMessage.emit(
      { type: 'DSH_WATCH_HIT', watchId: 'w-1', matched: 'In stock' },
      { id: 'test-extension', tab: { id: 7, url: WATCHED_PAGE } as chrome.tabs.Tab, url: WATCHED_PAGE, frameId: 0 },
      answered,
    )
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    await settle()
    const elsewhere = 'https://bank.example/account'
    ;(chrome.tabs.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Bank', url: elsewhere }))
    socket.open()
    await completeHandshake(socket, { until: () => { expect(answered).toHaveBeenCalledWith({ accepted: false, reason: 'other-origin' }) } })
    await settle()
    expect(socket.sent.some((frame) => (frame as { method?: string }).method === 'bridge.watch.fire')).toBe(false)
  })
})
