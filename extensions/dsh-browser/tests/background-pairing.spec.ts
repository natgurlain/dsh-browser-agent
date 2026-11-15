// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  bridgeEndpointOfUrl,
  createBridgeNonce,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import {
  createPairingShare,
  derivePairingKeys,
  sealPairingToken,
  verifyPairingClientConfirmation,
  type PairingContext,
} from '@natgurlain/dsh-bridge-browser/src/pairing.ts'
import { completeHandshake, panelSawConnected } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'
import { chromeEvent, panelPort } from './support/chrome.ts'

const BRIDGE_URL = 'ws://127.0.0.1:3080/ext/bridge'
const BRIDGE_TOKEN = 'token-only-the-host-knows-0123456789'
const CODE = 'ABCDEFGH'

/** A store install: nothing in storage but a client id, and no `bridge-token` file. */
function mockChrome(stored: Record<string, unknown> = {}) {
  const local: Record<string, unknown> = { dshClientId: 'test-client-0001', ...stored }
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
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
      getPlatformInfo: vi.fn(async () => ({ os: 'linux', arch: 'x86-64', nacl_arch: 'x86-64' })),
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...local })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, items) }),
        remove: vi.fn(async (key: string) => { delete local[key] }),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Tab', url: 'https://example.com/' } as chrome.tabs.Tab)),
      query: vi.fn(async () => [{ id: 1, windowId: 1, title: 'Tab', url: 'https://example.com/' }] as chrome.tabs.Tab[]),
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
  return { onConnect, local }
}

/** One local dsh answers discovery on port 3080; the extension directory has no token file. */
function mockFetch(options: { installedToken?: string } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === 'http://127.0.0.1:3080/ext/bridge-config') return new Response(JSON.stringify({ wsUrl: BRIDGE_URL }), { status: 200 })
    if (url === 'chrome-extension://test/bridge-token' && options.installedToken !== undefined) return new Response(`${options.installedToken}\n`, { status: 200 })
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Play the bridge half of a pairing exchange on the socket the worker opened. */
async function playPairing(socket: FakeWebSocket, code: string, token: string): Promise<boolean> {
  const serverNonce = createBridgeNonce()
  socket.open()
  socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  const find = <T extends string>(t: T) => vi.waitFor(() => {
    const frame = socket.sent.find((sent) => (sent as { t?: unknown }).t === t)
    expect(frame).toBeDefined()
    return frame as { t: T; nonce: string; share: string; origin: string; mac: string }
  })
  const hello = await find('pair.hello')
  const context: PairingContext = { code, serverNonce, clientNonce: hello.nonce, endpoint: bridgeEndpointOfUrl(socket.url)!, origin: hello.origin }
  const own = createPairingShare(context)
  const keys = derivePairingKeys(context, own.secret, hello.share, own.share, 'server')!
  socket.receive({ t: 'pair.share', share: own.share })
  const confirm = await find('pair.confirm')
  if (!verifyPairingClientConfirmation(keys, confirm.mac)) {
    socket.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: the code did not match')
    return false
  }
  socket.receive({ t: 'pair.ok', ...sealPairingToken(keys, token) })
  return true
}

const statuses = (postMessage: ReturnType<typeof panelPort>['postMessage']): Array<{ state: string; failure?: string }> =>
  postMessage.mock.calls.map(call => call[0] as { type?: string; state: string; failure?: string }).filter(message => message.type === 'status')

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background one-step pairing', () => {
  it('reports "no token" without dialing, pairs with the typed code, stores the token and connects', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    // A bridge answers discovery, but this install has nothing to prove: no
    // socket is opened, and the panel is told why so it can offer pairing.
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'reconnecting', failure: 'no-token' }) })
    expect(FakeWebSocket.instances).toHaveLength(0)

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-1', code: 'abcd-efgh' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const pairingSocket = FakeWebSocket.instances[0]!
    expect(pairingSocket.url).toBe(BRIDGE_URL)
    expect(await playPairing(pairingSocket, CODE, BRIDGE_TOKEN)).toBe(true)

    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-1', ok: true }) })
    // Stored like a typed token; the bridge that proved the code is remembered.
    expect((chromeMock.local.dshSettings as { token: string }).token).toBe(BRIDGE_TOKEN)
    expect(chromeMock.local.dshLastBridgeUrl).toBe(BRIDGE_URL)
    expect(pairingSocket.readyState).toBe(FakeWebSocket.CLOSED)
    // The pairing socket never carried a hello, and the token never left in the clear.
    expect(pairingSocket.sent.map(frame => (frame as { t: string }).t)).toEqual(['pair.hello', 'pair.confirm'])
    expect(JSON.stringify(pairingSocket.sent)).not.toContain(CODE)

    // The worker now connects with the ordinary handshake, keyed by that token.
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2) })
    const bridgeSocket = FakeWebSocket.instances.at(-1)!
    bridgeSocket.open()
    await completeHandshake(bridgeSocket, { token: BRIDGE_TOKEN, until: panelSawConnected(panel.postMessage) })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'connected' })
    expect(statuses(panel.postMessage).at(-1)?.failure).toBeUndefined()
  })

  it('stores nothing and says why when the code is wrong', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-2', code: 'ABCDEFGJ' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(await playPairing(FakeWebSocket.instances[0]!, CODE, BRIDGE_TOKEN)).toBe(false)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-2', ok: false, reason: 'wrong-code' }) })
    expect((chromeMock.local.dshSettings as { token?: string } | undefined)?.token ?? '').toBe('')
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Input that cannot be a code never reaches a socket.
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-3', code: '1234' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-3', ok: false, reason: 'invalid-code' }) })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reports that no pairing window is open when the bridge refuses the exchange', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-4', code: CODE })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    // A store build the bridge does not know, with no window open: refused at the Origin check.
    FakeWebSocket.instances[0]!.open()
    FakeWebSocket.instances[0]!.close(BRIDGE_CLOSE_CODES.originRejected, 'origin not allowed')
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-4', ok: false, reason: 'closed' }) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
  })

  it('pairs with the filled-in address instead of discovering', async () => {
    const chromeMock = mockChrome({ dshSettings: { bridgeUrl: 'ws://127.0.0.1:9911' } })
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).length).toBeGreaterThan(0) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-5', code: CODE })
    await vi.waitFor(() => { expect(FakeWebSocket.instances.some(socket => socket.url === 'ws://127.0.0.1:9911/ext/bridge')).toBe(true) })
    const socket = FakeWebSocket.instances.find(candidate => candidate.url === 'ws://127.0.0.1:9911/ext/bridge')!
    expect(await playPairing(socket, CODE, BRIDGE_TOKEN)).toBe(true)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-5', ok: true }) })
    expect(chromeMock.local.dshSettings).toMatchObject({ bridgeUrl: 'ws://127.0.0.1:9911', token: BRIDGE_TOKEN })
    // The filled-in address answered: no other bridge was offered the exchange.
    expect(FakeWebSocket.instances.filter(candidate => candidate.sent.some(frame => (frame as { t?: unknown }).t === 'pair.hello'))).toEqual([socket])
  })

  it('keeps the developer install working unchanged: the installed token file connects without pairing', async () => {
    const chromeMock = mockChrome()
    mockFetch({ installedToken: BRIDGE_TOKEN })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    await completeHandshake(socket, { token: BRIDGE_TOKEN, until: panelSawConnected(panel.postMessage) })
    expect(statuses(panel.postMessage).some(status => status.failure === 'no-token')).toBe(false)
    expect(socket.sent.some(frame => String((frame as { t: string }).t).startsWith('pair.'))).toBe(false)
    expect(chromeMock.local.dshSettings).toBeUndefined()
  })
})
