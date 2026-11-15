// @vitest-environment jsdom

/**
 * Standing work in the assembled background worker: live watchers and the
 * bridge's host hint hold the runtime lease, bring the connection back after
 * a worker or browser restart, back off while dsh is unreachable, and count
 * for nothing behind the kill switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function mockChrome(options: { local?: Record<string, unknown>; session?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
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
    commands: { onCommand: chromeEvent<[string]>() },
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
    storage: { local: local.area, session: session.area },
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
  return { alarms, onAlarm, onConnect, onMessage, local, session }
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
const hostHint = (mock: ReturnType<typeof mockChrome>): unknown => mock.local.data.dshStandingHost

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

    for (const payload of [{ schedules: 'lots', mcp: false }, { schedules: -1, mcp: false }, { schedules: 1 }, { schedules: 1, mcp: true, extra: 1 }, null]) {
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
    mockChrome({ local: { dshStandingHost: { schedules: 1, mcp: true, url: LOCAL, seenAt: Date.now() - 3_600_000 } } })
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
      const mock = mockChrome({ local: { dshStandingHost: stale } })
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
  const hint = () => ({ dshStandingHost: { schedules: 1, mcp: false, url: LOCAL, seenAt: Date.now() - 1_000 } })
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
    mock.onConnect.emit(panelPort().port)
    await vi.waitFor(() => { expect(mock.session.data.dshStandingRetry).toBeUndefined() })
    expect(mock.alarms.create).toHaveBeenLastCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
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
      local: { dshKillSwitch: true, dshStandingHost: { schedules: 2, mcp: true, url: LOCAL, seenAt: Date.now() - 1_000 } },
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
