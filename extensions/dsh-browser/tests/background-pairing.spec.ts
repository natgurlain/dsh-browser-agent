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
  derivePairingSession,
  formatPairingCode,
  sealPairingToken,
  verifyPairingCommitment,
  type PairingContext,
} from '@natgurlain/dsh-bridge-browser/src/pairing.ts'
import { completeHandshake, panelSawConnected } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'
import { chromeEvent, panelPort } from './support/chrome.ts'

const BRIDGE_URL = 'ws://127.0.0.1:3080/ext/bridge'
const BRIDGE_TOKEN = 'token-only-the-host-knows-0123456789'
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

type Sent = { t?: string; nonce: string; commit: string; share: string; opening: string; origin: string; name: string }

/** Play the bridge half of a pairing exchange up to the point where the request waits for the user. */
async function playPairing(socket: FakeWebSocket) {
  const serverNonce = createBridgeNonce()
  socket.open()
  socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  const find = (t: string) => vi.waitFor(() => {
    const frame = socket.sent.find(sent => (sent as Sent).t === t)
    expect(frame).toBeDefined()
    return frame as Sent
  })
  const request = await find('pair.request')
  const own = createPairingShare()
  socket.receive({ t: 'pair.share', share: own.share })
  const reveal = await find('pair.reveal')
  expect(verifyPairingCommitment(request.commit, reveal.share, reveal.opening)).toBe(true)
  const context: PairingContext = { serverNonce, clientNonce: request.nonce, endpoint: bridgeEndpointOfUrl(socket.url)!, origin: request.origin, name: request.name }
  const session = derivePairingSession(context, own.secret, reveal.share, own.share, 'server')!
  return {
    /** The code the host's prompt shows. */
    code: formatPairingCode(session.code),
    name: request.name,
    approve: (token: string) => { socket.receive({ t: 'pair.ok', ...sealPairingToken(session, token) }) },
    deny: () => { socket.close(BRIDGE_CLOSE_CODES.pairingDenied, 'the pairing request was denied') },
  }
}

const statuses = (postMessage: ReturnType<typeof panelPort>['postMessage']): Array<{ state: string; failure?: string }> =>
  postMessage.mock.calls.map(call => call[0] as { type?: string; state: string; failure?: string }).filter(message => message.type === 'status')

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background one-step pairing', () => {
  it('reports "no token" without dialing, shows the host\'s code, stores the token once approved and connects', async () => {
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

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-1' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const pairingSocket = FakeWebSocket.instances[0]!
    // The request goes to the bridge this install was already trying to reach.
    expect(pairingSocket.url).toBe(BRIDGE_URL)
    const host = await playPairing(pairingSocket)
    // The panel is given the same code the host shows, and nothing is stored while it waits.
    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.code', id: 'pair-1', code: host.code, answerTimeoutMs: expect.any(Number) })
    })
    expect(chromeMock.local.dshSettings).toBeUndefined()
    expect(panel.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pair.result' }))

    host.approve(BRIDGE_TOKEN)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-1', ok: true }) })
    // Stored like a typed token; the approved bridge is remembered.
    expect((chromeMock.local.dshSettings as { token: string }).token).toBe(BRIDGE_TOKEN)
    expect(chromeMock.local.dshLastBridgeUrl).toBe(BRIDGE_URL)
    expect(pairingSocket.readyState).toBe(FakeWebSocket.CLOSED)
    // The pairing socket never carried a hello; the token reaches the panel in no message.
    expect(pairingSocket.sent.map(frame => (frame as { t: string }).t)).toEqual(['pair.request', 'pair.reveal'])
    expect(JSON.stringify(panel.postMessage.mock.calls)).not.toContain(BRIDGE_TOKEN)

    // The worker now connects with the ordinary handshake, keyed by that token.
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2) })
    const bridgeSocket = FakeWebSocket.instances.at(-1)!
    bridgeSocket.open()
    await completeHandshake(bridgeSocket, { token: BRIDGE_TOKEN, until: panelSawConnected(panel.postMessage) })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'connected' })
    expect(statuses(panel.postMessage).at(-1)?.failure).toBeUndefined()
  })

  it('stores nothing and says why when the user denies the request', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-2' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const host = await playPairing(FakeWebSocket.instances[0]!)
    host.deny()
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-2', ok: false, reason: 'denied' }) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('withdraws a waiting request when the panel cancels or closes, and a new request replaces the old', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-3' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    await playPairing(FakeWebSocket.instances[0]!)
    panel.onMessage.emit({ type: 'pair.cancel' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-3', ok: false, reason: 'cancelled' }) })
    // Closing the socket is what takes the prompt off the host.
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-4' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    await playPairing(FakeWebSocket.instances[1]!)
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-5' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-4', ok: false, reason: 'cancelled' }) })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(3) })
    await playPairing(FakeWebSocket.instances[2]!)
    // The last panel closes: nobody is left to compare the code.
    panel.onDisconnect.emit()
    await vi.waitFor(() => { expect(FakeWebSocket.instances[2]!.readyState).toBe(FakeWebSocket.CLOSED) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
  })

  it('reports a bridge that cannot pair', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-6' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    // An older bridge refuses an extension it does not know at the Origin check.
    FakeWebSocket.instances[0]!.open()
    FakeWebSocket.instances[0]!.close(BRIDGE_CLOSE_CODES.originRejected, 'origin not allowed')
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-6', ok: false, reason: 'unsupported' }) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
  })

  it('asks the filled-in address, and says so when no DSH runs at all', async () => {
    const chromeMock = mockChrome({ dshSettings: { bridgeUrl: 'ws://203.0.113.7:9911' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).length).toBeGreaterThan(0) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-7' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances.some(socket => socket.sent.length === 0 && socket.url === 'ws://203.0.113.7:9911/ext/bridge')).toBe(true) })
    const socket = FakeWebSocket.instances.at(-1)!
    const host = await playPairing(socket)
    host.approve(BRIDGE_TOKEN)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-7', ok: true }) })
    expect(chromeMock.local.dshSettings).toMatchObject({ bridgeUrl: 'ws://203.0.113.7:9911', token: BRIDGE_TOKEN })
  })

  it('says so when no DSH runs on this computer', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('../src/background/index.ts')
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).some(status => (status as { discovery?: string }).discovery === 'not-found')).toBe(true) })
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-8' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-8', ok: false, reason: 'unreachable' }) })
    expect(FakeWebSocket.instances).toHaveLength(0)
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
