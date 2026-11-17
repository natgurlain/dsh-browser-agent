// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  bridgeEndpointOfUrl,
  createBridgeNonce,
} from 'dsh-browser-agent/src/protocol.ts'
import {
  createPairingShare,
  derivePairingKeys,
  normalizePairingCode,
  sealPairingToken,
  verifyPairingClientConfirmation,
  type PairingContext,
} from 'dsh-browser-agent/src/pairing.ts'
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

type Sent = { t?: string; nonce: string; share: string; origin: string; name: string; mac: string }

/** The code the worker told the panel to display for request `id`. */
const shownCode = (postMessage: ReturnType<typeof panelPort>['postMessage'], id: string): Promise<string> => vi.waitFor(() => {
  const message = postMessage.mock.calls.map(call => call[0] as { type?: string; id?: string; code?: string }).find(entry => entry.type === 'pair.code' && entry.id === id)
  expect(message).toBeDefined()
  return message!.code!
})

/**
 * Play the bridge half of a pairing exchange on the socket the worker opened,
 * as a bridge whose user typed `typed` (a string, or a thunk read once the
 * request arrived).
 * @returns whether the worker held that code; when it did, `pair.ok` with `token` was sent.
 */
async function playPairing(socket: FakeWebSocket, typed: string | (() => Promise<string>), token: string): Promise<boolean> {
  const serverNonce = createBridgeNonce()
  socket.open()
  socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
  const find = (t: string) => vi.waitFor(() => {
    const frame = socket.sent.find(sent => (sent as Sent).t === t)
    expect(frame).toBeDefined()
    return frame as Sent
  })
  const request = await find('pair.request')
  const code = normalizePairingCode(typeof typed === 'string' ? typed : await typed())!
  const context: PairingContext = { code, serverNonce, clientNonce: request.nonce, endpoint: bridgeEndpointOfUrl(socket.url)!, origin: request.origin, name: request.name }
  const own = createPairingShare(context)
  const keys = derivePairingKeys(context, own.secret, request.share, own.share, 'server')!
  socket.receive({ t: 'pair.share', share: own.share })
  const confirm = await find('pair.confirm')
  if (!verifyPairingClientConfirmation(keys, confirm.mac)) {
    socket.close(BRIDGE_CLOSE_CODES.pairingFailed, 'pairing failed: the code entered on the host is not this request\'s code')
    return false
  }
  socket.receive({ t: 'pair.ok', ...sealPairingToken(keys, token) })
  return true
}

const statuses = (postMessage: ReturnType<typeof panelPort>['postMessage']): Array<{ state: string; failure?: string }> =>
  postMessage.mock.calls.map(call => call[0] as { type?: string; state: string; failure?: string }).filter(message => message.type === 'status')

afterEach(() => {
  vi.doUnmock('../src/background/pairing.ts')
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('background one-step pairing', () => {
  // The worker reads its own origin from `location`; jsdom's is a web page, so pairing is given an extension origin.
  const STORE_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  async function loadWorker(): Promise<void> {
    vi.doMock('../src/background/pairing.ts', async importOriginal => ({
      ...(await importOriginal<typeof import('../src/background/pairing.ts')>()),
      extensionOrigin: () => STORE_ORIGIN,
    }))
    await import('../src/background/index.ts')
  }

  it('reports "no token" without dialing, shows a code, stores the token once that code was typed on the host, and connects', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()

    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    // A bridge answers discovery, but this install has nothing to prove: no
    // socket is opened, and the panel is told why so it can start pairing.
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'reconnecting', failure: 'no-token' }) })
    expect(FakeWebSocket.instances).toHaveLength(0)

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-1' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const pairingSocket = FakeWebSocket.instances[0]!
    // The request goes to the bridge this install was already trying to reach.
    expect(pairingSocket.url).toBe(BRIDGE_URL)
    // The user reads the code off the panel and types it into DSH.
    expect(await playPairing(pairingSocket, () => shownCode(panel.postMessage, 'pair-1'), BRIDGE_TOKEN)).toBe(true)

    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-1', ok: true }) })
    // Stored like a typed token; the bridge that proved the code is remembered.
    expect((chromeMock.local.dshSettings as { token: string }).token).toBe(BRIDGE_TOKEN)
    expect(chromeMock.local.dshLastBridgeUrl).toBe(BRIDGE_URL)
    expect(pairingSocket.readyState).toBe(FakeWebSocket.CLOSED)
    // The pairing socket never carried a hello or the code; the token reaches the panel in no message.
    expect(pairingSocket.sent.map(frame => (frame as { t: string }).t)).toEqual(['pair.request', 'pair.confirm', 'pair.done'])
    expect(JSON.stringify(pairingSocket.sent)).not.toContain(normalizePairingCode(await shownCode(panel.postMessage, 'pair-1')))
    expect(JSON.stringify(panel.postMessage.mock.calls)).not.toContain(BRIDGE_TOKEN)

    // The worker now connects with the ordinary handshake, keyed by that token.
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2) })
    const bridgeSocket = FakeWebSocket.instances.at(-1)!
    bridgeSocket.open()
    await completeHandshake(bridgeSocket, { token: BRIDGE_TOKEN, until: panelSawConnected(panel.postMessage) })
    expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'connected' })
    expect(statuses(panel.postMessage).at(-1)?.failure).toBeUndefined()
  })

  it('stores nothing and says why when another code was typed on the host', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-2' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    expect(await playPairing(FakeWebSocket.instances[0]!, 'ZZZ-ZZZ', BRIDGE_TOKEN)).toBe(false)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-2', ok: false, reason: 'wrong-code' }) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('regression (review PoC): a squatter that sends pair.ok without the code gets nothing stored, remembered or dialed', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-poc' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    const squatter = FakeWebSocket.instances[0]!
    const serverNonce = createBridgeNonce()
    squatter.open()
    squatter.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
    const request = await vi.waitFor(() => {
      const frame = squatter.sent.find(sent => (sent as Sent).t === 'pair.request')
      expect(frame).toBeDefined()
      return frame as Sent
    })
    // It answers at once with a share made for a guess, and seals a token of its own choosing under its keys.
    const context: PairingContext = { code: 'ZZZZZZ', serverNonce, clientNonce: request.nonce, endpoint: bridgeEndpointOfUrl(BRIDGE_URL)!, origin: request.origin, name: request.name }
    const own = createPairingShare(context)
    const keys = derivePairingKeys(context, own.secret, request.share, own.share, 'server')!
    squatter.receive({ t: 'pair.share', share: own.share })
    squatter.receive({ t: 'pair.ok', ...sealPairingToken(keys, 'attacker-chosen-token-0123456789abcdef') })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-poc', ok: false, reason: 'untrusted' }) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
    expect(chromeMock.local.dshLastBridgeUrl).toBeUndefined()
    expect(squatter.sent.some(sent => (sent as Sent).t === 'pair.done')).toBe(false)
    // No connection is attempted with anything the squatter sent.
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('regression (review PoC): an install that holds a token never pairs by itself, and a failed "pair again" keeps the token', async () => {
    const chromeMock = mockChrome({ dshSettings: { token: BRIDGE_TOKEN } })
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    // A squatter on the dialed port refuses the handshake the way a bridge refuses an unknown extension.
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    FakeWebSocket.instances[0]!.open()
    FakeWebSocket.instances[0]!.close(BRIDGE_CLOSE_CODES.originRejected, 'origin not allowed')
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'origin-rejected' }) })

    // Whatever asks without the user's explicit "pair again" is refused before any socket opens.
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-auto' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-auto', ok: false, reason: 'has-token' }) })
    expect(FakeWebSocket.instances.filter(socket => socket.sent.some(sent => (sent as Sent).t === 'pair.request'))).toEqual([])

    // The user insists; the squatter still cannot make the worker accept anything, and the old token stays.
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-again', again: true })
    const pairing = await vi.waitFor(() => {
      const socket = FakeWebSocket.instances.find(candidate => candidate.readyState !== FakeWebSocket.CLOSED && candidate.sent.length === 0)
      expect(socket).toBeDefined()
      return socket!
    })
    expect(await playPairing(pairing, 'ZZZ-ZZZ', 'attacker-chosen-token-0123456789abcdef')).toBe(false)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-again', ok: false, reason: 'wrong-code' }) })
    expect((chromeMock.local.dshSettings as { token: string }).token).toBe(BRIDGE_TOKEN)
  })

  it('regression (review 2, L7): starts at most three pairings nobody clicked for per sitting', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })
    const requests = (): number => FakeWebSocket.instances.length
    for (const id of ['auto-1', 'auto-2', 'auto-3']) {
      const before = requests()
      panel.onMessage.emit({ type: 'pair.start', id, auto: true })
      await vi.waitFor(() => { expect(requests()).toBe(before + 1) })
      // Something keeps pushing the request out of the bridge's queue.
      FakeWebSocket.instances.at(-1)!.open()
      FakeWebSocket.instances.at(-1)!.close(BRIDGE_CLOSE_CODES.pairingReplaced, 'another pairing request took this one\'s place')
      await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id, ok: false, reason: 'replaced' }) })
    }
    // The fourth is refused before any socket opens; a click still works.
    panel.onMessage.emit({ type: 'pair.start', id: 'auto-4', auto: true })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'auto-4', ok: false, reason: 'auto-limit' }) })
    expect(requests()).toBe(3)
    panel.onMessage.emit({ type: 'pair.start', id: 'clicked' })
    await vi.waitFor(() => { expect(requests()).toBe(4) })
    FakeWebSocket.instances.at(-1)!.close(1006)
    // A new sitting (every panel closed, one opened again) starts the count over.
    panel.onDisconnect.emit()
    const reopened = panelPort()
    chromeMock.onConnect.emit(reopened.port)
    reopened.onMessage.emit({ type: 'pair.start', id: 'auto-5', auto: true })
    await vi.waitFor(() => { expect(requests()).toBe(5) })
  })

  it('regression (review 2, L8): takes the panel port only from the extension\'s own pages', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    // A content script (it runs beside an untrusted page) connects with the panel's port name.
    const content = panelPort('dsh-panel', { id: 'test-extension', url: 'https://evil.example/', tab: { id: 7 } as chrome.tabs.Tab })
    chromeMock.onConnect.emit(content.port)
    expect(content.disconnect).toHaveBeenCalledOnce()
    content.onMessage.emit({ type: 'pair.start', id: 'from-content', again: true })
    content.onMessage.emit({ type: 'settings', id: 's1', settings: { bridgeUrl: 'ws://203.0.113.9:1', token: 'x'.repeat(40) } })
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(content.postMessage).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromeMock.local.dshSettings).toBeUndefined()
    // Another extension, or a port without a sender, fares the same.
    const foreign = panelPort('dsh-panel', { id: 'another-extension', url: 'chrome-extension://test/panel/index.html' })
    chromeMock.onConnect.emit(foreign.port)
    expect(foreign.disconnect).toHaveBeenCalledOnce()
    // The side panel itself is served.
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).length).toBeGreaterThan(0) })
    expect(panel.disconnect).not.toHaveBeenCalled()
  })

  it('regression (review 2, L6): a token file that is there but unreadable never leads to pairing', async () => {
    const chromeMock = mockChrome()
    // The file answers, empty (caught mid-rewrite, or damaged).
    mockFetch({ installedToken: '' })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ state: 'reconnecting', failure: 'token-unreadable' }) })
    expect(statuses(panel.postMessage).some(status => status.failure === 'no-token')).toBe(false)
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-unreadable', auto: true })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-unreadable', ok: false, reason: 'has-token' }) })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('withdraws a waiting request when the panel cancels or closes, and a new request replaces the old', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).at(-1)).toMatchObject({ failure: 'no-token' }) })
    const requested = (socket: FakeWebSocket): Promise<void> => {
      socket.open()
      socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce() })
      return vi.waitFor(() => { expect(socket.sent).toHaveLength(1) })
    }

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-3' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
    await requested(FakeWebSocket.instances[0]!)
    panel.onMessage.emit({ type: 'pair.cancel' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-3', ok: false, reason: 'cancelled' }) })
    // Closing the socket is what takes the request off the host.
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED)

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-4' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
    await requested(FakeWebSocket.instances[1]!)
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-5' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-4', ok: false, reason: 'cancelled' }) })
    await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(3) })
    await requested(FakeWebSocket.instances[2]!)
    // Each request showed its own code.
    expect(await shownCode(panel.postMessage, 'pair-5')).not.toBe(await shownCode(panel.postMessage, 'pair-4'))
    // The last panel closes: nobody is left to read the code.
    panel.onDisconnect.emit()
    await vi.waitFor(() => { expect(FakeWebSocket.instances[2]!.readyState).toBe(FakeWebSocket.CLOSED) })
    expect(chromeMock.local.dshSettings).toBeUndefined()
  })

  it('reports a bridge that cannot pair', async () => {
    const chromeMock = mockChrome()
    mockFetch()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
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

  it('asks the filled-in address', async () => {
    const chromeMock = mockChrome({ dshSettings: { bridgeUrl: 'ws://203.0.113.7:9911' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(statuses(panel.postMessage).length).toBeGreaterThan(0) })

    panel.onMessage.emit({ type: 'pair.start', id: 'pair-7' })
    await vi.waitFor(() => { expect(FakeWebSocket.instances.some(socket => socket.sent.length === 0 && socket.url === 'ws://203.0.113.7:9911/ext/bridge')).toBe(true) })
    expect(await playPairing(FakeWebSocket.instances.at(-1)!, () => shownCode(panel.postMessage, 'pair-7'), BRIDGE_TOKEN)).toBe(true)
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-7', ok: true }) })
    expect(chromeMock.local.dshSettings).toMatchObject({ bridgeUrl: 'ws://203.0.113.7:9911', token: BRIDGE_TOKEN })
  })

  it('says so when no DSH runs on this computer', async () => {
    const chromeMock = mockChrome()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await loadWorker()
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
    await loadWorker()
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1) })
    // Workers of earlier tests are still retrying and now find the token file too: answer every
    // socket, and watch this test's panel.
    const connected = panelSawConnected(panel.postMessage)
    const answered = new Set<FakeWebSocket>()
    await vi.waitFor(async () => {
      for (const socket of FakeWebSocket.instances) {
        if (answered.has(socket)) continue
        answered.add(socket)
        socket.open()
        void completeHandshake(socket, { token: BRIDGE_TOKEN }).catch(() => {})
      }
      connected()
    }, { timeout: 5_000 })
    expect(statuses(panel.postMessage).some(status => status.failure === 'no-token')).toBe(false)
    expect(FakeWebSocket.instances.some(socket => socket.sent.some(frame => String((frame as { t: string }).t).startsWith('pair.')))).toBe(false)
    expect(chromeMock.local.dshSettings).toBeUndefined()
    const sockets = FakeWebSocket.instances.length
    // It holds a token (the installer's file): pairing is refused unless the user asks to pair again.
    panel.onMessage.emit({ type: 'pair.start', id: 'pair-dev' })
    await vi.waitFor(() => { expect(panel.postMessage).toHaveBeenCalledWith({ type: 'pair.result', id: 'pair-dev', ok: false, reason: 'has-token' }) })
    expect(FakeWebSocket.instances.filter(socket => socket.sent.some(frame => (frame as { t: string }).t === 'pair.request'))).toEqual([])
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(sockets)
  })
})
