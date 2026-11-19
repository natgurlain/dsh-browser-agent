// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_CLOSE_CODES, computeBridgeProof, createBridgeNonce } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import { challengeUntilHello, completeHandshake, panelSawConnected, TEST_BRIDGE_TOKEN } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'
import { chromeEvent, panelPort } from './support/chrome.ts'


function mockChrome(options: {
  localGet?: () => Promise<Record<string, unknown>>
  localSet?: (items: Record<string, unknown>) => Promise<void>
  sessionGet?: () => Promise<Record<string, unknown>>
  tabGet?: (tabId: number) => Promise<chrome.tabs.Tab>
  tabQuery?: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
  tabRemove?: (tabId: number) => Promise<void>
  tabSendMessage?: (tabId: number, message: unknown) => Promise<unknown>
  executeScript?: () => Promise<unknown>
} = {}) {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onCommand = chromeEvent<[string]>()
  const action = { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() }
  const sessionStore: Record<string, unknown> = {}
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(async () => true),
    onAlarm,
  }
  vi.stubGlobal('chrome', {
    alarms,
    action,
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
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    },
    storage: {
      local: {
        // Every suite connects with the shared test token unless it stores its own.
        get: vi.fn(async () => {
          const stored: Record<string, unknown> = await (options.localGet ?? (async () => ({})))()
          const settings = (stored.dshSettings ?? {}) as Record<string, unknown>
          // A provisioned client id, so identity setup never writes to storage.
          return { dshClientId: 'test-client-0001', ...stored, dshSettings: { token: TEST_BRIDGE_TOKEN, ...settings } }
        }),
        set: vi.fn(options.localSet ?? (async () => {})),
        remove: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(options.sessionGet ?? (async () => ({ ...sessionStore }))),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionStore, items) }),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(options.tabGet ?? (async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab))),
      query: vi.fn(options.tabQuery ?? (async () => [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' }] as chrome.tabs.Tab[])),
      remove: vi.fn(options.tabRemove ?? (async () => {})),
      sendMessage: vi.fn(options.tabSendMessage ?? (async () => {})),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        documentId: 'document-1',
        url: 'https://example.com/',
      }]),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    scripting: {
      executeScript: vi.fn(options.executeScript ?? (async () => [])),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { alarms, onConnect, onCommand, action, sessionStore, tabs: chrome.tabs }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background bridge lifecycle', () => {
  it('does not probe, connect, or arm keepalive just because the extension loads', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(chrome.storage.local.get).toHaveBeenCalled() })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromeMock.alarms.create).not.toHaveBeenCalled()
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith('bridge-keepalive')
  })

  it('abandons an in-flight discovery when the last panel closes', async () => {
    const chromeMock = mockChrome()
    // Every candidate of the first group stays unanswered until released, so
    // the test observes the pass exactly while it is in flight.
    const pending: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(async () => await new Promise<Response>((resolve) => { pending.push(resolve) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    chromeMock.alarms.clear.mockClear()

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    // The fixed-port group is probed as one batch; the beacon group only starts
    // once every probe of that group has failed.
    await vi.waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4) })
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
    const started = fetchMock.mock.calls.length

    panel.onDisconnect.emit()
    for (const settle of pending.splice(0)) settle(new Response(null, { status: 503 }))
    await vi.waitFor(() => { expect(chromeMock.alarms.clear).toHaveBeenCalledWith('bridge-keepalive') })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    // Nothing else was probed after the lease ended, and no socket was opened.
    expect(fetchMock.mock.calls.length).toBe(started)
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('does not let keepalive reclaim a bridge that replaced this client', async () => {
    const chromeMock = mockChrome()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    socket.close(4000, 'replaced')
    const probed = fetchMock.mock.calls.length

    chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now() })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // The replaced slot stays terminal: the alarm probes at most the same
    // address again and never rediscovers or opens another socket.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(probed + 1)
  })

  it('keeps the panel on its connection when the keepalive fires during a reconnect', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:3080/ext/bridge' } }),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    const states = (): unknown[] => panel.postMessage.mock.calls
      .map(([message]) => message as { type?: unknown; state?: unknown })
      .filter((message) => message.type === 'status')
      .map((message) => message.state)

    // The socket drops; the client is waiting to retry the same address.
    socket.close(1006, '')
    await vi.waitFor(() => { expect(states().at(-1)).toBe('reconnecting') })
    panel.postMessage.mockClear()

    // The half-minute keepalive lands inside that wait.
    chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now() })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const next = FakeWebSocket.instances[1]!
    next.open()
    await completeHandshake(next, { until: panelSawConnected(panel.postMessage) })

    // `stopped` ends a connection for the panel (it drops its conversation and
    // starts a new one); a reconnect to the same bridge must not look like one.
    expect(states()).not.toContain('stopped')
    expect(states().at(-1)).toBe('connected')
  })

  it('invalidates stale connection settings when their save outlives the panel', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({ localSet: async () => await settingsWrite })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3080/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await completeHandshake(originalSocket, { until: panelSawConnected(panel.postMessage) })
    await vi.waitFor(() => {
      expect(panel.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    })

    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'ws://127.0.0.1:3081', token: 'new-token' },
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    panel.onDisconnect.emit()
    expect(originalSocket.readyState).toBe(FakeWebSocket.OPEN)

    finishSettingsWrite()
    await vi.waitFor(() => { expect(originalSocket.readyState).toBe(FakeWebSocket.CLOSED) })

    const reopened = panelPort()
    chromeMock.onConnect.emit(reopened.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:3081/ext/bridge')
  })

  it('acknowledges a policy setting only after persistence without restarting the bridge', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      localSet: async () => { await settingsWrite },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })

    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-1',
      settings: { unrestrictedBrowserAccess: true },
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-2',
      settings: { approvalNotifications: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).toHaveBeenCalledOnce()
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'settings.result',
      id: 'settings-1',
    }))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'settings-1', ok: true })
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'settings-2', ok: true })
    })
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('reports a settings persistence failure to the requesting panel', async () => {
    let settingsWrites = 0
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      localSet: async () => {
        settingsWrites += 1
        if (settingsWrites === 1) throw new Error('Storage is unavailable')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    panel.onMessage.emit({
      type: 'settings',
      id: 'settings-failed',
      settings: { unrestrictedBrowserAccess: true },
    })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'settings-failed',
        ok: false,
        error: { message: 'Storage is unavailable' },
      })
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'unrelated-setting-after-failure',
      settings: { approvalNotifications: false },
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({
        type: 'settings.result',
        id: 'unrelated-setting-after-failure',
        ok: true,
      })
    })

    socket.receive({
      t: 'tool.call',
      id: 'close-after-failed-enable',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request' }))
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('disarms selection capture as soon as unrestricted access is disabled', async () => {
    let finishSettingsWrite!: () => void
    const settingsWrite = new Promise<void>((resolve) => { finishSettingsWrite = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
          sharePageContent: 'off',
        },
      }),
      localSet: async () => { await settingsWrite },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: true,
      }))
    })
    vi.mocked(chromeMock.tabs.sendMessage).mockClear()

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-selection',
      settings: { unrestrictedBrowserAccess: false },
    })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: false,
      }))
    })
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'settings.result',
      id: 'disable-selection',
    }))

    finishSettingsWrite()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-selection', ok: true })
    })
  })

  it('cancels in-flight unrestricted calls before persisting revocation', async () => {
    let finishTabLookup!: (tab: chrome.tabs.Tab) => void
    const tabLookup = new Promise<chrome.tabs.Tab>((resolve) => { finishTabLookup = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabGet: async () => await tabLookup,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-in-flight',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.get).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    panel.onMessage.emit({
      type: 'settings',
      settings: { approvalNotifications: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishTabLookup({ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab)
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual({
        t: 'tool.result',
        id: 'close-in-flight',
        ok: false,
        error: { code: 'action-failed', message: 'Tool call was cancelled' },
      })
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledTimes(2) })

    expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
  })

  it('settles a committed unrestricted action before persisting revocation', async () => {
    const events: string[] = []
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      localSet: async () => { events.push('saved') },
      tabRemove: async () => {
        await close
        events.push('closed')
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-committed',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'tool.result',
      id: 'close-committed',
      ok: false,
    }))

    finishClose()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result',
        id: 'close-committed',
        ok: true,
      }))
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    expect(events).toEqual(['closed', 'saved'])
  })

  it('keeps a rapid re-enable restricted until revocation settles and persists toggles in order', async () => {
    let finishFirstClose!: () => void
    const firstClose = new Promise<void>((resolve) => { finishFirstClose = resolve })
    const persistedAccess: boolean[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      localSet: async (items) => {
        persistedAccess.push((items.dshSettings as { unrestrictedBrowserAccess: boolean }).unrestrictedBrowserAccess)
      },
      tabGet: async (tabId) => ({ id: tabId, windowId: 1, title: `Tab ${tabId}`, url: `https://example.com/${tabId}` } as chrome.tabs.Tab),
      tabRemove: async (tabId) => {
        if (tabId === 1) await firstClose
      },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'close-before-toggle',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({ type: 'settings', id: 'disable-fast', settings: { unrestrictedBrowserAccess: false } })
    panel.onMessage.emit({ type: 'settings', id: 'enable-fast', settings: { unrestrictedBrowserAccess: true } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    socket.receive({
      t: 'tool.call',
      id: 'close-during-revocation',
      name: 'browser_close_tab',
      args: { tabId: 2 },
      expiresAt: Date.now() + 10_000,
    })

    const approval = await vi.waitFor(() => {
      const message = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string; request?: { id?: string } })
        .find((value) => value.type === 'approval.request')
      expect(message?.request?.id).toBeTypeOf('string')
      return message!
    })
    expect(chromeMock.tabs.remove).not.toHaveBeenCalledWith(2)
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishFirstClose()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-fast', ok: true })
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'enable-fast', ok: true })
    })
    expect(persistedAccess).toEqual([false, true])
    expect(FakeWebSocket.instances).toHaveLength(1)

    panel.onMessage.emit({
      type: 'approval.response',
      id: approval.request!.id,
      decision: 'allow-once',
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(2) })
  })

  it('waits for disconnected committed actions during revocation and drops their results', async () => {
    let finishClose!: () => void
    const close = new Promise<void>((resolve) => { finishClose = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabRemove: async () => { await close },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const originalSocket = FakeWebSocket.instances[0]!
    originalSocket.open()
    await completeHandshake(originalSocket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    originalSocket.receive({
      t: 'tool.call',
      id: 'old-close',
      name: 'browser_close_tab',
      args: { tabId: 1 },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chromeMock.tabs.remove).toHaveBeenCalledWith(1) })

    panel.onMessage.emit({
      type: 'settings',
      settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' },
    })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const replacementSocket = FakeWebSocket.instances[1]!
    replacementSocket.open()
    await completeHandshake(replacementSocket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-after-reconnect',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const savedBeforeClose = vi.mocked(chrome.storage.local.set).mock.calls.some(([items]) => (
      (items.dshSettings as { unrestrictedBrowserAccess?: boolean }).unrestrictedBrowserAccess === false
    ))
    finishClose()
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-after-reconnect', ok: true })
    })
    expect(savedBeforeClose).toBe(false)

    expect(originalSocket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-close' }))
    expect(replacementSocket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-close' }))
  })

  it('does not send a navigation result across a reconnect during its checkpoint', async () => {
    const tab = { id: 1, windowId: 1, title: 'New tab', url: 'chrome://newtab/' } as chrome.tabs.Tab
    let pauseCheckpoint = false
    let checkpointStarted = false
    let finishCheckpoint!: (tab: chrome.tabs.Tab) => void
    const checkpoint = new Promise<chrome.tabs.Tab>((resolve) => { finishCheckpoint = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: {
        bridgeUrl: 'wss://bridge.example/ext/bridge',
        unrestrictedBrowserAccess: true,
      } }),
      tabQuery: async () => [tab],
      tabGet: async () => {
        if (!pauseCheckpoint) return tab
        checkpointStarted = true
        return checkpoint
      },
    })
    chrome.tabs.reload = vi.fn(async () => { pauseCheckpoint = true })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const original = FakeWebSocket.instances[0]!
    original.open()
    await completeHandshake(original, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    original.receive({
      t: 'tool.call', id: 'follow-before-reload', name: 'browser_follow_tab',
      sessionId: 'checkpoint-session', args: { tabId: 1 }, expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(original.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'follow-before-reload', ok: true }))
    })
    original.receive({
      t: 'tool.call', id: 'old-reload', name: 'browser_reload',
      sessionId: 'checkpoint-session', args: {}, expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(checkpointStarted).toBe(true) })
    panel.onMessage.emit({ type: 'settings', settings: { bridgeUrl: 'wss://replacement.example/ext/bridge' } })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    const replacement = FakeWebSocket.instances[1]!
    replacement.open()
    await completeHandshake(replacement, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    finishCheckpoint(tab)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    for (const socket of [original, replacement]) {
      expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'old-reload' }))
    }
  })

  it('cancels unrestricted recovery after an undelivered action rolls back its commit', async () => {
    let finishInjection!: () => void
    const injection = new Promise<void>((resolve) => { finishInjection = resolve })
    const actionMessages: unknown[] = []
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
        },
      }),
      tabSendMessage: async (_tabId, message) => {
        if ((message as { type?: unknown }).type !== 'DSH_ACTION') return undefined
        actionMessages.push(message)
        throw new Error('Could not establish connection. Receiving end does not exist.')
      },
      executeScript: async () => { await injection },
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    socket.receive({
      t: 'tool.call',
      id: 'recovering-action',
      name: 'browser_press',
      args: { key: 'Enter' },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => { expect(chrome.scripting.executeScript).toHaveBeenCalledOnce() })

    panel.onMessage.emit({
      type: 'settings',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishInjection()
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result',
        id: 'recovering-action',
        ok: false,
      }))
      expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
        dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
      }))
    })
    expect(actionMessages).toHaveLength(1)
  })

  it('applies a managed "disable unrestricted" before the first call, even when the managed area answers after the user settings', async () => {
    const tab = { id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge', unrestrictedBrowserAccess: true, sharePageContent: 'auto' },
      }),
      tabQuery: async () => [tab],
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? { ok: true, result: { text: 'Pressed Enter.' } }
        : undefined,
    })
    // The managed area answers only after the user's settings could have loaded.
    let releaseManaged!: () => void
    const managedHeld = new Promise<void>((resolve) => { releaseManaged = resolve })
    ;(chrome.storage as { managed?: unknown }).managed = {
      get: async () => { await managedHeld; return { disableUnrestricted: true } },
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    const call = { t: 'tool.call', id: 'managed-first', name: 'browser_press', args: { key: 'Enter' }, expiresAt: Date.now() + 10_000 }
    let socket = FakeWebSocket.instances[0]
    if (socket !== undefined) {
      // Connected before the managed policy arrived: the call must still not
      // run under the user's unrestricted setting.
      socket.open()
      await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
      socket.receive(call)
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      releaseManaged()
    } else {
      releaseManaged()
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
      socket = FakeWebSocket.instances[0]!
      socket.open()
      await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
      socket.receive(call)
    }
    await vi.waitFor(() => {
      const request = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string })
        .find((value) => value.type === 'approval.request')
      expect(request).toBeDefined()
    })
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'managed-first', ok: true }))
  })

  it('keeps an already-started restricted call under approval across access toggles', async () => {
    let holdTarget = false
    let releaseTarget!: (tabs: chrome.tabs.Tab[]) => void
    const target = new Promise<chrome.tabs.Tab[]>((resolve) => { releaseTarget = resolve })
    const tab = { id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: false,
          sharePageContent: 'auto',
        },
      }),
      tabQuery: async (queryInfo) => holdTarget && queryInfo.active === true ? await target : [tab],
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? { ok: true, result: { text: 'Pressed Enter.' } }
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    holdTarget = true
    socket.receive({
      t: 'tool.call',
      id: 'restricted-across-toggle',
      name: 'browser_press',
      args: { key: 'Enter' },
      expiresAt: Date.now() + 10_000,
    })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true })
    })

    panel.onMessage.emit({ type: 'settings', settings: { unrestrictedBrowserAccess: true } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledOnce() })
    releaseTarget([tab])
    const approval = await vi.waitFor(() => {
      const message = panel.postMessage.mock.calls
        .map((args: unknown[]) => args[0] as { type?: string; request?: { id?: string } })
        .find((value) => value.type === 'approval.request')
      expect(message?.request?.id).toBeTypeOf('string')
      return message!
    })

    panel.onMessage.emit({ type: 'settings', settings: { unrestrictedBrowserAccess: false } })
    await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledTimes(2) })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'tool.result',
      id: 'restricted-across-toggle',
    }))

    panel.onMessage.emit({
      type: 'approval.response',
      id: approval.request!.id,
      decision: 'allow-once',
    })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({
        t: 'tool.result',
        id: 'restricted-across-toggle',
        ok: true,
      }))
    })
  })

  it('waits for and suppresses an unrestricted automatic snapshot during revocation', async () => {
    let finishSnapshot!: (answer: unknown) => void
    const snapshot = new Promise<unknown>((resolve) => { finishSnapshot = resolve })
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: {
          bridgeUrl: 'wss://bridge.example/ext/bridge',
          unrestrictedBrowserAccess: true,
          sharePageContent: 'off',
        },
      }),
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? await snapshot
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    await Promise.resolve()
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-refresh', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_ACTION',
        action: 'browser_snapshot',
      }), expect.any(Object))
    })

    panel.onMessage.emit({
      type: 'settings',
      id: 'disable-refresh',
      settings: { unrestrictedBrowserAccess: false },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    finishSnapshot({ ok: true, result: { text: 'private page snapshot' } })
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'settings.result', id: 'disable-refresh', ok: true })
    })
    expect(socket.sent).not.toContainEqual(expect.objectContaining({
      t: 'rpc',
      method: 'bridge.injectBrowserSnapshot',
    }))
  })

  it('connects to a filled-in address without probing anything else', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:51801/ext/bridge' } }),
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.includes(':51801/')
        ? new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:51801/ext/bridge' }), { status: 200 })
        : new Response(null, { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:51801/ext/bridge')
    // Only the address itself is checked (pre-flight plus the client's own
    // probe); no discovery candidate is touched.
    const probes = fetchMock.mock.calls.map(([input]) => String(input))
    expect(probes.every((url) => url.includes(':51801/'))).toBe(true)
  })

  it('falls back to one discovery pass when the filled-in address is gone', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:51801/ext/bridge' } }),
    })
    const probed: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      probed.push(url)
      // The desktop restarted on another port: the old address is dead and the
      // discovery beacon answers for the new one.
      if (url.includes(':43189/')) {
        return new Response(JSON.stringify({
          wsUrl: 'ws://127.0.0.1:60222/ext/bridge',
          beacon: true,
        }), { status: 200 })
      }
      if (url.includes(':60222/')) {
        return new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:60222/ext/bridge' }), { status: 200 })
      }
      return new Response(null, { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })

    expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:60222/ext/bridge')
    // The dead address is probed once, never again by the pass.
    expect(probed.filter((url) => url.includes(':51801/'))).toHaveLength(1)
    expect(probed.some((url) => url.includes(':43189/'))).toBe(true)
    // A discovery answer is not remembered until the peer proves the token.
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({ dshLastBridgeUrl: 'ws://127.0.0.1:60222/ext/bridge' })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    // The user's saved address stays as typed; only the remembered URL moves.
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ dshSettings: expect.anything() }))
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshLastBridgeUrl: 'ws://127.0.0.1:60222/ext/bridge' })
  })

  it('forgets a remembered squatter whose server proof fails and continues discovery', async () => {
    const chromeMock = mockChrome({
      // A previous run remembered port 51000; now another process listens there.
      localGet: async () => ({ dshLastBridgeUrl: 'ws://127.0.0.1:51000/ext/bridge' }),
    })
    const probed: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      probed.push(url)
      if (url.includes(':51000/')) return new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:51000/ext/bridge' }), { status: 200 })
      if (url.includes(':43189/')) return new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:60222/ext/bridge' }), { status: 200 })
      if (url.includes(':60222/')) return new Response(JSON.stringify({ wsUrl: 'ws://127.0.0.1:60222/ext/bridge' }), { status: 200 })
      return new Response(null, { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const squatter = FakeWebSocket.instances[0]!
    expect(squatter.url).toBe('ws://127.0.0.1:51000/ext/bridge')
    squatter.open()
    // The squatter does not know the token, so its server proof is wrong.
    const squatterNonce = createBridgeNonce()
    await challengeUntilHello(squatter, squatterNonce)
    squatter.receive({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }, mac: 'f'.repeat(64) })
    await vi.waitFor(() => { expect(chrome.storage.local.remove).toHaveBeenCalledWith('dshLastBridgeUrl') })

    // Discovery continues without the squatter and finds the real bridge.
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2) })
    const real = FakeWebSocket.instances.at(-1)!
    expect(real.url).toBe('ws://127.0.0.1:60222/ext/bridge')
    expect(FakeWebSocket.instances.every((socket) => socket === squatter || !socket.url.includes(':51000/'))).toBe(true)
    real.open()
    await completeHandshake(real, { until: panelSawConnected(panel.postMessage) })
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshLastBridgeUrl: 'ws://127.0.0.1:60222/ext/bridge' })
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({ dshLastBridgeUrl: 'ws://127.0.0.1:51000/ext/bridge' })
  })

  it('keeps a failing remote address local instead of probing this machine', async () => {
    const chromeMock = mockChrome({
      localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
    })
    const fetchMock = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    await new Promise((resolve) => { setTimeout(resolve, 10) })

    expect(FakeWebSocket.instances[0]!.url).toBe('wss://bridge.example/ext/bridge')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not probe again while the lease remembers a confirmed miss', async () => {
    const chromeMock = mockChrome({
      // DSH stayed stopped across a service-worker restart: the latch survives.
      sessionGet: async () => ({ dshDiscoveryLatch: 'not-found' }),
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ discovery: 'not-found' }))
    })
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  describe('kill switch', () => {
    async function connected(chromeMock: ReturnType<typeof mockChrome>) {
      vi.stubGlobal('WebSocket', FakeWebSocket)
      await import('../src/background/index.ts')
      const panel = panelPort()
      chromeMock.onConnect.emit(panel.port)
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
      const socket = FakeWebSocket.instances[0]!
      socket.open()
      await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
      return { panel, socket }
    }

    it('stops everything from the panel button and stays down until the user reconnects', async () => {
      let finishLookup!: (tab: chrome.tabs.Tab) => void
      const lookup = new Promise<chrome.tabs.Tab>((resolve) => { finishLookup = resolve })
      const chromeMock = mockChrome({
        localGet: async () => ({
          dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge', unrestrictedBrowserAccess: true },
        }),
        tabGet: async () => await lookup,
      })
      const { panel, socket } = await connected(chromeMock)
      socket.receive({ t: 'tool.call', id: 'in-flight', name: 'browser_close_tab', args: { tabId: 1 }, expiresAt: Date.now() + 10_000 })
      await vi.waitFor(() => { expect(chromeMock.tabs.get).toHaveBeenCalledWith(1) })

      panel.onMessage.emit({ type: 'kill-switch.engage' })
      await vi.waitFor(() => {
        expect(panel.postMessage).toHaveBeenCalledWith({ type: 'kill-switch', engaged: true })
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
      })
      expect(chromeMock.sessionStore.dshKillSwitch).toBe(true)
      expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: 'OFF' })
      // The in-flight call was abandoned: it never closes the tab.
      finishLookup({ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab)
      await new Promise((resolve) => { setTimeout(resolve, 10) })
      expect(chromeMock.tabs.remove).not.toHaveBeenCalled()
      // Unrestricted access is turned off (persisted once the abandoned call settled).
      await vi.waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
          dshSettings: expect.objectContaining({ unrestrictedBrowserAccess: false }),
        }))
      })

      // Neither the keepalive nor a new panel reconnects.
      chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now() })
      const second = panelPort()
      chromeMock.onConnect.emit(second.port)
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(second.postMessage).toHaveBeenCalledWith({ type: 'kill-switch', engaged: true })

      panel.onMessage.emit({ type: 'kill-switch.release' })
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
      expect(chromeMock.sessionStore.dshKillSwitch).toBe(false)
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'kill-switch', engaged: false })
    })

    it('revokes standing grants and pending cards: watchers, dev-loop links, fleets, approvals (G2)', async () => {
      const chromeMock = mockChrome({
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge', allowPageWatchers: true } }),
      })
      const now = Date.now()
      chromeMock.sessionStore.dshPageWatchers = [{
        id: 'w-1', sessionId: 's1', tabId: 1, origin: 'https://example.com', url: 'https://example.com/',
        condition: { kind: 'selector', selector: '#x', gone: false }, prompt: 'p', createdAt: now, expiresAt: now + 60_000, maxFires: 1, fires: 0,
      }]
      chromeMock.sessionStore.devLoopLinks = [{ sessionId: 's1', tabId: 1, origin: 'http://localhost:3000' }]
      chromeMock.sessionStore.dshFleets = [{ fleetId: 'fleet-1', parentSessionId: 's1', children: ['c1'], tabIds: [1], allowActions: false }]
      const { panel, socket } = await connected(chromeMock)
      panel.onMessage.emit({ type: 'session.active', sessionId: 's1', isNew: true })
      // A call that needs the user's approval: its card is pending when the switch engages.
      socket.receive({ t: 'tool.call', id: 'needs-card', name: 'browser_click', args: { selector: 'h1' }, expiresAt: Date.now() + 30_000, sessionId: 's1' })
      let cardId: string | undefined
      await vi.waitFor(() => {
        const request = panel.postMessage.mock.calls.map(([message]) => message as { type?: string; request?: { id: string } }).find((message) => message.type === 'approval.request')
        expect(request).toBeDefined()
        cardId = request!.request!.id
      })
      panel.onMessage.emit({ type: 'kill-switch.engage' })
      await vi.waitFor(() => {
        expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
        expect(panel.postMessage).toHaveBeenCalledWith({ type: 'approval.resolved', id: cardId })
        expect(chromeMock.sessionStore.dshPageWatchers).toEqual([])
        expect(chromeMock.sessionStore.devLoopLinks).toEqual([])
        expect(chromeMock.sessionStore.dshFleets).toEqual([])
      })
    })

    it('answers request-status with the full status: discovery and the connected address included (M5)', async () => {
      const chromeMock = mockChrome({
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      })
      const { panel } = await connected(chromeMock)
      const pushed = panel.postMessage.mock.calls.map(([message]) => message as { type?: string }).filter((message) => message.type === 'status').at(-1)
      panel.postMessage.mockClear()
      panel.onMessage.emit({ type: 'request-status' })
      const pulled = panel.postMessage.mock.calls.map(([message]) => message as { type?: string }).find((message) => message.type === 'status')
      expect(pulled).toEqual(pushed)
      expect(pulled).toMatchObject({ state: 'connected', discovery: expect.any(String), killSwitch: false })
    })

    it('engages from the keyboard command and persists the switch in session storage', async () => {
      const chromeMock = mockChrome({
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      })
      const { socket } = await connected(chromeMock)
      chromeMock.onCommand.emit('kill-switch')
      await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) })
      expect(chromeMock.sessionStore.dshKillSwitch).toBe(true)
    })

    it('persists the switch in local storage and stops in-page loops (#8)', async () => {
      const chromeMock = mockChrome({
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      })
      const { panel, socket } = await connected(chromeMock)
      panel.onMessage.emit({ type: 'kill-switch.engage' })
      await vi.waitFor(() => { expect(socket.readyState).toBe(FakeWebSocket.CLOSED) })
      // Local storage survives a browser restart and an extension reload.
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshKillSwitch: true })
      await vi.waitFor(() => { expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'DSH_ABORT' }) })
      panel.onMessage.emit({ type: 'kill-switch.release' })
      await vi.waitFor(() => { expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshKillSwitch: false }) })
    })

    it('does not connect after a browser restart or extension reload while the switch is engaged (#8)', async () => {
      const chromeMock = mockChrome({
        // Session storage is empty after a reload; local storage still holds the switch.
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' }, dshKillSwitch: true }),
      })
      vi.stubGlobal('WebSocket', FakeWebSocket)
      await import('../src/background/index.ts')
      const panel = panelPort()
      chromeMock.onConnect.emit(panel.port)
      await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'kill-switch', engaged: true }) })
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(FakeWebSocket.instances).toHaveLength(0)
    })

    it('does not connect after a worker restart while the switch is engaged', async () => {
      const chromeMock = mockChrome({
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
        sessionGet: async () => ({ dshKillSwitch: true }),
      })
      vi.stubGlobal('WebSocket', FakeWebSocket)
      await import('../src/background/index.ts')
      const panel = panelPort()
      chromeMock.onConnect.emit(panel.port)
      await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'kill-switch', engaged: true }) })
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(FakeWebSocket.instances).toHaveLength(0)
    })

    it('badges the controlled tab while connected', async () => {
      const chromeMock = mockChrome({
        localGet: async () => ({ dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge' } }),
      })
      const { panel } = await connected(chromeMock)
      panel.onMessage.emit({ type: 'session.active', sessionId: 'session-1', isNew: true })
      await vi.waitFor(() => {
        expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: 'AI', tabId: 1 })
      })
    })
  })
})

describe('panel-free runtime and approvals', () => {
  const HOST_CAPS = { textOnly: true as const, snapshotMaxChars: 32_000, maxInteractiveItems: 60, hostApprovals: 1 as const }
  type ButtonEvent = { emit: (id: string, index: number) => void }

  async function connectedThenClosed(caps: typeof HOST_CAPS | null = HOST_CAPS) {
    const tab = { id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/', active: true } as chrome.tabs.Tab
    const chromeMock = mockChrome({
      localGet: async () => ({
        dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge', sharePageContent: 'auto' },
      }),
      tabQuery: async () => [tab],
      tabSendMessage: async (_tabId, message) => (message as { type?: unknown }).type === 'DSH_ACTION'
        ? { ok: true, result: { text: 'Pressed Enter.' } }
        : undefined,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { ...(caps === null ? {} : { caps }), until: panelSawConnected(panel.postMessage) })
    panel.onDisconnect.emit()
    return { chromeMock, socket }
  }

  type SentRpc = { t: 'rpc'; id: string; method: string; payload: Record<string, unknown> }
  const rpcs = (socket: FakeWebSocket, method: string): SentRpc[] =>
    socket.sent.filter((frame): frame is SentRpc => (frame as SentRpc).t === 'rpc' && (frame as SentRpc).method === method)

  function pressEnter(socket: FakeWebSocket, id: string): void {
    socket.receive({ t: 'tool.call', id, name: 'browser_press', args: { key: 'Enter' }, expiresAt: Date.now() + 10_000 })
  }

  async function forwarded(socket: FakeWebSocket): Promise<SentRpc> {
    return await vi.waitFor(() => {
      const found = rpcs(socket, 'bridge.approval.ask')[0]
      expect(found).toBeDefined()
      return found!
    })
  }

  it('advertises a per-install client identity in hello', async () => {
    const { socket } = await connectedThenClosed()
    const hello = socket.sent.find((frame) => (frame as { t?: unknown }).t === 'hello') as { caps: { client?: unknown } }
    expect(hello.caps.client).toEqual({ id: 'test-client-0001', browser: 'chrome' })
  })

  it('keeps the connection after the last panel closes and gates tool calls without a panel', async () => {
    const { chromeMock, socket } = await connectedThenClosed()
    // Boot clears stale alarms once; closing the panel must not clear it again.
    const clears = chromeMock.alarms.clear.mock.calls.length
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(chromeMock.alarms.clear.mock.calls.length).toBe(clears)
    // The worker records its lease so a restarted worker can reconnect headlessly.
    await vi.waitFor(() => {
      expect(chromeMock.sessionStore.dshRuntimeLease).toEqual({ activeUntil: expect.any(Number), url: 'wss://bridge.example/ext/bridge' })
    })
    pressEnter(socket, 'panel-free-call')
    // The approval has no panel: it is held on the bridge and forwarded to dsh.
    const ask = await forwarded(socket)
    expect(ask.payload).toMatchObject({ toolCallId: 'panel-free-call', approvalId: expect.any(String), reason: expect.stringContaining('browser_press') })
    const hold = rpcs(socket, 'bridge.tool.hold')[0]!
    expect(hold.payload).toMatchObject({ toolCallId: 'panel-free-call' })
    expect(hold.payload.holdMs as number).toBeGreaterThan(9 * 60_000)
    expect(chrome.notifications.create).toHaveBeenCalledWith(
      `dsh-browser-approval:${String(ask.payload.approvalId)}`,
      expect.objectContaining({ buttons: expect.any(Array) }),
    )

    // A dsh answer for a different payload binding is ignored.
    socket.receive({ t: 'rpc.result', id: ask.id, ok: true, result: { approvalId: ask.payload.approvalId, binding: '0'.repeat(64), decision: 'allow-once' } })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'panel-free-call' }))
    // Deny from the notification instead (button 1 is Deny in both layouts).
    ;(chrome.notifications.onButtonClicked as unknown as ButtonEvent)
      .emit(`dsh-browser-approval:${String(ask.payload.approvalId)}`, 1)
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'panel-free-call', ok: false }))
    })
  })

  it('runs the call when dsh allows it with the exact binding', async () => {
    const { socket } = await connectedThenClosed()
    pressEnter(socket, 'dsh-allowed')
    const ask = await forwarded(socket)
    socket.receive({
      t: 'rpc.result',
      id: ask.id,
      ok: true,
      result: { approvalId: ask.payload.approvalId, ...(ask.payload.binding === undefined ? {} : { binding: ask.payload.binding }), decision: 'allow-once' },
    })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'dsh-allowed', ok: true }))
    })
    // dsh answered first, so there is no question left to withdraw.
    expect(rpcs(socket, 'bridge.approval.withdraw')).toHaveLength(0)
  })

  it('withdraws the dsh question when the notification answers first', async () => {
    const { socket } = await connectedThenClosed()
    pressEnter(socket, 'notification-first')
    const ask = await forwarded(socket)
    ;(chrome.notifications.onButtonClicked as unknown as ButtonEvent)
      .emit(`dsh-browser-approval:${String(ask.payload.approvalId)}`, 1)
    await vi.waitFor(() => {
      expect(rpcs(socket, 'bridge.approval.withdraw')[0]?.payload).toEqual({ toolCallId: 'notification-first', approvalId: ask.payload.approvalId })
    })
    await vi.waitFor(() => {
      expect(socket.sent).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'notification-first', ok: false }))
    })
  })

  it('does not forward or hold when the bridge does not support host approvals', async () => {
    const { socket } = await connectedThenClosed(null)
    pressEnter(socket, 'old-bridge')
    await vi.waitFor(() => { expect(chrome.notifications.create).toHaveBeenCalled() })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(rpcs(socket, 'bridge.approval.ask')).toHaveLength(0)
    expect(rpcs(socket, 'bridge.tool.hold')).toHaveLength(0)
  })
})

describe('headless reconnect after a worker restart', () => {
  it('reconnects to the leased address without a panel and without discovery', async () => {
    mockChrome({
      sessionGet: async () => ({ dshRuntimeLease: { activeUntil: Date.now() + 60_000, url: 'ws://127.0.0.1:3999/ext/bridge' } }),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wsUrl: 'ws://127.0.0.1:3999/ext/bridge',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:3999/ext/bridge')
    // Only the pre-flight probe of that one address; no discovery sweep.
    for (const [url] of fetchMock.mock.calls as unknown as Array<[string]>) expect(String(url)).toContain('127.0.0.1:3999')
    expect(chrome.alarms.create).toHaveBeenCalledWith('bridge-keepalive', { periodInMinutes: 0.5 })
  })

  it('stays asleep when the persisted lease has expired', async () => {
    mockChrome({
      sessionGet: async () => ({ dshRuntimeLease: { activeUntil: Date.now() - 1, url: 'ws://127.0.0.1:3999/ext/bridge' } }),
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(chrome.alarms.create).not.toHaveBeenCalled()
  })

  it('ignores a malformed lease', async () => {
    mockChrome({ sessionGet: async () => ({ dshRuntimeLease: { activeUntil: 'soon' } }) })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('outage of a connected bridge while a panel is open', () => {
  const HOME = 'ws://127.0.0.1:3080/ext/bridge'
  const BEACON = 43189
  const CAPS = { textOnly: true as const, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
  /** Recovery looks one second after the drop, then two seconds later: enough for two looks. */
  const TWO_LOOKS_MS = 3_400
  /** Ends the background of the test that just ran: its timers would otherwise keep probing. */
  let shutDown: (() => void) | undefined

  afterEach(async () => {
    shutDown?.()
    shutDown = undefined
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })

  /**
   * A background connected to HOME with one panel open. `answers` maps a
   * loopback port to the bridge address its discovery endpoint advertises;
   * a port that is not in it does not answer.
   */
  async function connected() {
    const chromeMock = mockChrome({ localGet: async () => ({ dshSettings: { bridgeUrl: HOME } }) })
    const answers = new Map<number, string>([[3080, HOME]])
    const fetchMock = vi.fn(async (input: unknown) => {
      const wsUrl = answers.get(Number(new URL(String(input)).port))
      return wsUrl === undefined ? new Response(null, { status: 503 }) : new Response(JSON.stringify({ wsUrl }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { until: panelSawConnected(panel.postMessage) })
    const statuses = (): Array<{ state?: unknown; discovery?: unknown; failure?: unknown; address?: unknown; killSwitch?: unknown }> => (
      panel.postMessage.mock.calls.map(([message]) => message as { type?: unknown; state?: unknown })
        .filter(message => message.type === 'status')
    )
    const probed = (port: number): number => fetchMock.mock.calls.filter(([input]) => Number(new URL(String(input)).port) === port).length
    const refusalLatched = (): boolean => (chrome.storage.local.set as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls.some(([items]) => 'dshBridgeRefusal' in items)
    /** The bridge goes away: its socket drops and its port stops answering. */
    const drop = async (): Promise<void> => {
      answers.delete(3080)
      socket.close(1006, '')
      await vi.waitFor(() => { expect(statuses().at(-1)?.state).toBe('reconnecting') })
      panel.postMessage.mockClear()
    }
    /** The next socket the client opens to `url`. */
    const socketTo = async (url: string): Promise<FakeWebSocket> => {
      const seen = FakeWebSocket.instances.length
      let found: FakeWebSocket | undefined
      await vi.waitFor(() => {
        found = FakeWebSocket.instances.slice(seen).find(candidate => candidate.url === url)
        expect(found).toBeDefined()
      }, { timeout: 8_000, interval: 20 })
      return found!
    }
    shutDown = () => { chromeMock.onCommand.emit('kill-switch') }
    /** A bridge at `wsUrl`, advertised by its own port and by a beacon port. */
    const advertise = (beacon: number, wsUrl: string): void => {
      answers.set(beacon, wsUrl)
      answers.set(Number(new URL(wsUrl).port), wsUrl)
    }
    const alarm = (): void => { chromeMock.alarms.onAlarm.emit({ name: 'bridge-keepalive', scheduledTime: Date.now() }) }
    return { chromeMock, answers, advertise, fetchMock, panel, socket, statuses, probed, refusalLatched, drop, socketTo, alarm }
  }

  it('stays reconnecting through keepalive ticks while the bridge is unreachable, then reconnects when it returns', async () => {
    const env = await connected()
    await env.drop()

    // The keepalive lands while nothing answers anywhere, twice.
    env.alarm()
    await new Promise((resolve) => { setTimeout(resolve, TWO_LOOKS_MS) })
    env.alarm()
    // It looked for the bridge by itself (address first, then the beacon ports)…
    expect(env.probed(BEACON)).toBeGreaterThanOrEqual(1)
    // …and the miss was not final: no `stopped`, no "not found".
    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
    expect(env.statuses().map(status => status.discovery)).not.toContain('not-found')
    expect(env.statuses().at(-1)?.state).toBe('reconnecting')

    env.answers.set(3080, HOME)
    const next = await env.socketTo(HOME)
    next.open()
    await completeHandshake(next, { until: panelSawConnected(env.panel.postMessage) })
    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
    expect(env.statuses().at(-1)?.state).toBe('connected')
  }, 20_000)

  it('finds the bridge on the new port it restarted on, without ending the connection for the panel', async () => {
    const env = await connected()
    await env.drop()
    const moved = 'ws://127.0.0.1:45555/ext/bridge'
    env.advertise(BEACON, moved)

    const next = await env.socketTo(moved)
    next.open()
    await completeHandshake(next, { until: panelSawConnected(env.panel.postMessage) })

    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
    expect(env.statuses().at(-1)).toMatchObject({ state: 'connected', address: moved })
    // The handshake proved it: the new address is tried first next time.
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshLastBridgeUrl: moved })
  }, 20_000)

  it('rules out a squatter that fails the proof, tells it nothing but the hello, and keeps looking', async () => {
    const env = await connected()
    await env.drop()
    const squatter = 'ws://127.0.0.1:46001/ext/bridge'
    env.advertise(BEACON, squatter)

    const impostor = await env.socketTo(squatter)
    impostor.open()
    const serverNonce = createBridgeNonce()
    const hello = await challengeUntilHello(impostor, serverNonce)
    impostor.receive({ t: 'hello.ok', caps: CAPS, mac: await computeBridgeProof('not-the-token', 'server', hello.nonce, serverNonce, hello.endpoint, { client: hello.caps, server: CAPS }) })
    await vi.waitFor(() => { expect(impostor.closedWith?.code).toBe(BRIDGE_CLOSE_CODES.authFailed) })
    expect(impostor.sent.map(frame => (frame as { t: string }).t)).toEqual(['hello'])
    expect(JSON.stringify(impostor.sent)).not.toContain(TEST_BRIDGE_TOKEN)

    // The squatter keeps answering; the real bridge appears on the next beacon port.
    const real = 'ws://127.0.0.1:46002/ext/bridge'
    env.advertise(BEACON + 1, real)
    const next = await env.socketTo(real)
    next.open()
    await completeHandshake(next, { until: panelSawConnected(env.panel.postMessage) })

    // It was never dialed again, the loop did not stop, and nothing was latched as a refusal.
    expect(FakeWebSocket.instances.filter(candidate => candidate.url === squatter)).toHaveLength(1)
    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
    expect(env.statuses().map(status => status.failure)).not.toContain('token-mismatch')
    expect(env.refusalLatched()).toBe(false)
  }, 20_000)

  it('treats a refusal from an address it only discovered as "not that one", not as the answer', async () => {
    const env = await connected()
    await env.drop()
    const other = 'ws://127.0.0.1:46003/ext/bridge'
    env.advertise(BEACON, other)

    // Another DSH on this computer: it holds a different token and refuses the hello.
    const foreign = await env.socketTo(other)
    foreign.open()
    foreign.close(BRIDGE_CLOSE_CODES.authFailed, 'auth failed')
    await new Promise((resolve) => { setTimeout(resolve, TWO_LOOKS_MS) })

    expect(FakeWebSocket.instances.filter(candidate => candidate.url === other)).toHaveLength(1)
    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
    expect(env.statuses().at(-1)?.state).toBe('reconnecting')
    expect(env.statuses().at(-1)?.failure).toBeUndefined()
    expect(env.refusalLatched()).toBe(false)

    env.answers.set(3080, HOME)
    const next = await env.socketTo(HOME)
    next.open()
    await completeHandshake(next, { until: panelSawConnected(env.panel.postMessage) })
    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
  }, 20_000)

  it('moves on from a discovered address whose dial just fails, and tries it again once the others had their turn', async () => {
    const env = await connected()
    await env.drop()
    const starting = 'ws://127.0.0.1:46006/ext/bridge'
    env.advertise(BEACON, starting)

    // It advertises itself but is not accepting sockets yet.
    const early = await env.socketTo(starting)
    early.close(1006, '')
    // With nothing else to try, the same address gets another turn, and this time it is up.
    const later = await env.socketTo(starting)
    later.open()
    await completeHandshake(later, { until: panelSawConnected(env.panel.postMessage) })

    expect(env.statuses().map(status => status.state)).not.toContain('stopped')
    expect(env.statuses().at(-1)).toMatchObject({ state: 'connected', address: starting })
    expect(env.refusalLatched()).toBe(false)
  }, 20_000)

  it('takes a refusal from the address that was connected as the answer: latched, and no search', async () => {
    const env = await connected()
    // The bridge is back at once, but no longer accepts this install's token.
    env.socket.close(1006, '')
    const next = await env.socketTo(HOME)
    next.open()
    next.close(BRIDGE_CLOSE_CODES.authFailed, 'auth failed')

    await vi.waitFor(() => { expect(env.statuses().at(-1)).toMatchObject({ state: 'reconnecting', failure: 'token-mismatch' }) })
    await vi.waitFor(() => {
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ dshBridgeRefusal: 'token-mismatch' })
    })
    // A refusal is not an outage: nothing goes looking for another bridge.
    env.advertise(BEACON, 'ws://127.0.0.1:46004/ext/bridge')
    await new Promise((resolve) => { setTimeout(resolve, TWO_LOOKS_MS) })
    expect(env.probed(BEACON)).toBe(0)
    expect(FakeWebSocket.instances.some(candidate => candidate.url.includes(':46004'))).toBe(false)
  }, 20_000)

  it('stops looking when the last panel closes: panel-free reconnects keep their own rules', async () => {
    const env = await connected()
    await env.drop()
    env.panel.onDisconnect.emit()
    env.advertise(BEACON, 'ws://127.0.0.1:46005/ext/bridge')
    await new Promise((resolve) => { setTimeout(resolve, TWO_LOOKS_MS) })
    // No scan runs by itself with nobody there, and nothing dials what a scan would have found.
    expect(env.probed(BEACON)).toBe(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
  }, 20_000)

  it('stops at once for the kill switch and does not look again', async () => {
    const env = await connected()
    await env.drop()
    env.chromeMock.onCommand.emit('kill-switch')
    await vi.waitFor(() => { expect(env.statuses().at(-1)).toMatchObject({ state: 'stopped', killSwitch: true }) })
    const probes = env.fetchMock.mock.calls.length
    env.answers.set(3080, HOME)
    env.answers.set(BEACON, HOME)
    await new Promise((resolve) => { setTimeout(resolve, TWO_LOOKS_MS) })
    env.alarm()
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(env.fetchMock.mock.calls.length).toBe(probes)
    expect(FakeWebSocket.instances).toHaveLength(1)
  }, 20_000)

  it('gives up after ten minutes with "not found" and says the bridge did not come back', async () => {
    const env = await connected()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await env.drop()
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 5_000)
      expect(env.statuses().map(status => status.state)).not.toContain('stopped')
      const probes = env.fetchMock.mock.calls.length
      expect(probes).toBeGreaterThan(20)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(env.statuses().at(-1)).toMatchObject({ state: 'stopped', discovery: 'not-found', failure: 'gave-up' })

      // Stopped means stopped: neither time nor the keepalive looks again.
      const after = env.fetchMock.mock.calls.length
      env.alarm()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(env.fetchMock.mock.calls.length).toBe(after)
      expect(FakeWebSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)
})
