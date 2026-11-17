// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_AUDIT_RECORD_METHOD,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
} from 'dsh-browser-agent/src/protocol.ts'
import { STRICT_MODE_UNAVAILABLE } from '../src/background/commit-gate.ts'
import { HOLD_EXPIRED_MESSAGE } from '../src/background/pause-gate.ts'
import { completeHandshake, panelSawConnected, TEST_BRIDGE_TOKEN } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'
import { chromeEvent } from './support/chrome.ts'

function browserTab(url: string, title = 'Page'): chrome.tabs.Tab {
  return {
    id: 1, index: 0, pinned: false, highlighted: true, active: true, incognito: false, selected: true,
    discarded: false, autoDiscardable: true, groupId: -1, windowId: 1, title, url,
  }
}

interface Sent { t?: string; id?: string; method?: string; payload?: Record<string, unknown>; ok?: boolean; error?: { message?: string } }

async function boot(extraSettings: Record<string, unknown> = {}, chromeExtras: Record<string, unknown> = {}) {
  let currentTab = browserTab('https://example.com/start')
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const sessionData: Record<string, unknown> = {}
  const tabMessages: Array<{ tabId: number; message: Record<string, unknown> }> = []
  const sendMessage = vi.fn(async (tabId: number, message: Record<string, unknown>) => {
    tabMessages.push({ tabId, message })
    if (message.type !== 'DSH_ACTION') return undefined
    return { ok: true, result: { text: message.action === 'browser_snapshot' ? 'Changed: [5] button "Pay"' : 'done' } }
  })
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: { create: vi.fn(async () => ''), clear: vi.fn(async () => true), onClicked: chromeEvent<[string]>() },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage,
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({
          dshSettings: {
            bridgeUrl: 'wss://bridge.example/ext/bridge',
            token: TEST_BRIDGE_TOKEN,
            sharePageContent: 'auto',
            trustedActionOrigins: ['https://example.com'],
            ...extraSettings,
          },
        })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
        remove: vi.fn(async (key: string) => { delete sessionData[key] }),
      },
    },
    tabs: {
      get: vi.fn(async () => currentTab),
      query: vi.fn(async () => [currentTab]),
      sendMessage,
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{ tabId: 1, frameId: 0, parentFrameId: -1, documentId: 'document-1', url: currentTab.url! }]),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: chromeEvent<[number]>(), onRemoved: chromeEvent<[number]>() },
    ...chromeExtras,
  } as unknown as typeof chrome)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  await import('../src/background/index.ts')

  const portMessages = chromeEvent<[unknown]>()
  const port = {
    name: 'dsh-panel', postMessage: vi.fn(), disconnect: vi.fn(), onMessage: portMessages, onDisconnect: chromeEvent<[]>(),
    sender: { url: 'chrome-extension://test/panel/index.html' },
  } as unknown as chrome.runtime.Port
  onConnect.emit(port)
  await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  await completeHandshake(socket, { until: panelSawConnected(port.postMessage as unknown as { mock: { calls: unknown[][] } }) })
  portMessages.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
  // Answer every bridge-owned RPC the background sends.
  const answered = new Set<string>()
  const answerRpcs = (): void => {
    for (const frame of socket.sent as Sent[]) {
      if (frame.t !== 'rpc' || frame.id === undefined || answered.has(frame.id)) continue
      if (frame.method !== BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD && frame.method !== BRIDGE_AUDIT_RECORD_METHOD) continue
      answered.add(frame.id)
      socket.receive({ t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
    }
  }
  const pauseStates = () => (port.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(([message]) => message as { type?: string; state?: { mode: string; held: unknown[] } })
    .filter((message) => message.type === 'agent.pause-state')
    .map((message) => message.state!)
  return {
    socket,
    panel: portMessages,
    content: onMessage,
    tabMessages,
    sessionData,
    answerRpcs,
    pauseStates,
    setTab: (tab: chrome.tabs.Tab) => { currentTab = tab },
    sent: () => socket.sent as Sent[],
  }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('audit notes and the pause gate', () => {
  it('annotates each call for the audit log before answering it', async () => {
    const env = await boot()
    env.socket.receive({ t: 'tool.call', id: 'snap', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'snap', ok: true })) })
    const frames = env.sent()
    const note = frames.findIndex((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'snap')
    const result = frames.findIndex((frame) => frame.t === 'tool.result' && frame.id === 'snap')
    expect(note).toBeGreaterThanOrEqual(0)
    expect(note).toBeLessThan(result)
    expect(frames[note]!.payload).toMatchObject({ decision: 'not-required', url: 'https://example.com/start' })
  })

  it('holds the next call after "pause after this step", injects a delta on resume, then runs it', async () => {
    const env = await boot()
    // The resume read is judged by policy but is not an agent call: it must not leave a call record (M9).
    const { PolicyRuntime } = await import('../src/background/policy-runtime.ts')
    const hook = vi.spyOn(PolicyRuntime.prototype, 'hook')
    env.panel.emit({ type: 'agent.pause', mode: 'after-step' })
    await vi.waitFor(() => { expect(env.pauseStates().at(-1)?.mode).toBe('paused') })
    env.socket.receive({ t: 'tool.call', id: 'click', name: 'browser_click', args: { selector: 'h1' }, expiresAt: Date.now() + 30_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.pauseStates().at(-1)?.held).toHaveLength(1) })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(env.sent().some((frame) => frame.t === 'tool.result' && frame.id === 'click')).toBe(false)
    expect(env.tabMessages.some(({ message }) => message.action === 'browser_click')).toBe(false)
    expect(env.sessionData.dshAgentPause).toMatchObject({ mode: 'paused' })

    env.setTab(browserTab('https://example.com/start', 'Changed title'))
    env.panel.emit({ type: 'agent.resume' })
    await vi.waitFor(() => {
      env.answerRpcs()
      expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'click', ok: true }))
    })
    const frames = env.sent()
    const injection = frames.findIndex((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD && frame.payload?.reason === 'resume')
    const result = frames.findIndex((frame) => frame.t === 'tool.result' && frame.id === 'click')
    expect(injection).toBeGreaterThanOrEqual(0)
    expect(injection).toBeLessThan(result)
    expect(frames[injection]!.payload).toMatchObject({ sessionId: 'session-live', reason: 'resume' })
    expect(String(frames[injection]!.payload!.snapshot)).toContain('Title changed: "Page" → "Changed title"')
    expect(String(frames[injection]!.payload!.snapshot)).toContain('Changed: [5] button "Pay"')
    expect(frames.find((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'click')!.payload)
      .toMatchObject({ heldMs: expect.any(Number) })
    expect(env.pauseStates().at(-1)).toMatchObject({ mode: 'running', held: [] })
    expect(env.sessionData.dshAgentPause).toBeNull()
    expect(hook.mock.calls.map(([callId]) => callId)).toEqual(['click'])
  })

  it('answers a held step once and acts on the page once, however long it is held and however often Resume arrives', async () => {
    const env = await boot()
    env.panel.emit({ type: 'agent.pause', mode: 'after-step' })
    await vi.waitFor(() => { expect(env.pauseStates().at(-1)?.mode).toBe('paused') })
    env.socket.receive({ t: 'tool.call', id: 'click', name: 'browser_click', args: { selector: 'h1' }, expiresAt: Date.now() + 30_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.pauseStates().at(-1)?.held).toHaveLength(1) })

    // Held: the bridge hears nothing about this call. No result and no error
    // means the model has nothing to answer or retry on; its one request for
    // this step simply stays open.
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    const aboutTheCall = (): Sent[] => env.sent().filter((frame) => frame.id === 'click')
    const pageClicks = (): number => env.tabMessages.filter(({ message }) => message.type === 'DSH_ACTION' && message.action === 'browser_click').length
    expect(aboutTheCall()).toEqual([])
    expect(pageClicks()).toBe(0)
    expect(env.pauseStates().at(-1)?.held).toHaveLength(1)

    env.panel.emit({ type: 'agent.resume' })
    // A second Resume (a double click, a second panel) while the first is under way.
    env.panel.emit({ type: 'agent.resume' })
    await vi.waitFor(() => {
      env.answerRpcs()
      expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'click', ok: true }))
    })
    env.panel.emit({ type: 'agent.resume' })
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    env.answerRpcs()

    // One answer for the one call, and the page was clicked once.
    expect(aboutTheCall().filter((frame) => frame.t === 'tool.result')).toHaveLength(1)
    expect(pageClicks()).toBe(1)
    expect(env.pauseStates().at(-1)).toMatchObject({ mode: 'running', held: [] })
  })

  it('shows the "AI controlling · Stop" pill only while a turn acts on the tab', async () => {
    const env = await boot()
    const control = () => env.tabMessages.filter(({ message }) => message.type === 'DSH_OVERLAY' && message.op === 'control').map(({ tabId, message }) => `${tabId}:${String(message.on)}`)
    // Connected, with a conversation bound to the tab, and nothing asked yet: no pill.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(control()).toEqual([])
    // The turn's first tool call: the pill appears on the tab it acts on.
    env.socket.receive({ t: 'tool.call', id: 'first', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'first' })) })
    expect(control()).toEqual(['1:true'])
    // Between two steps of the same turn it stays.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(control()).toEqual(['1:true'])
    // Another conversation's turn ending changes nothing; this one's ending removes it.
    env.socket.receive({ t: 'event', frame: { method: 'session/event', payload: { sessionId: 'session-other', event: { type: 'turn/end' } } } })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(control()).toEqual(['1:true'])
    env.socket.receive({ t: 'event', frame: { method: 'session/event', payload: { sessionId: 'session-live', event: { type: 'turn/end' } } } })
    await vi.waitFor(() => { expect(control()).toEqual(['1:true', '1:false']) })
  })

  it('shows the takeover banner on the controlled tab; its Resume opens the panel, which resumes', async () => {
    const env = await boot()
    env.socket.receive({ t: 'tool.call', id: 'first', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'first' })) })
    // The turn is acting: the pill is on the controlled tab (the setting defaults to on).
    expect(env.tabMessages).toContainEqual({ tabId: 1, message: expect.objectContaining({ type: 'DSH_OVERLAY', op: 'control', on: true }) })
    env.panel.emit({ type: 'agent.pause', mode: 'take-over' })
    await vi.waitFor(() => {
      expect(env.tabMessages).toContainEqual({ tabId: 1, message: expect.objectContaining({ type: 'DSH_OVERLAY', op: 'takeover', on: true }) })
    })
    // The user took over: the banner replaces the pill.
    await vi.waitFor(() => {
      expect(env.tabMessages).toContainEqual({ tabId: 1, message: expect.objectContaining({ type: 'DSH_OVERLAY', op: 'control', on: false }) })
    })
    env.content.emit({ type: 'DSH_AGENT_RESUME' }, { id: 'test-extension', tab: browserTab('https://example.com/start') }, () => {})
    // The in-page button is not authoritative: it only brings up the panel.
    await vi.waitFor(() => { expect(chrome.sidePanel.open).toHaveBeenCalled() })
    expect(env.pauseStates().at(-1)?.mode).toBe('taken-over')
    env.panel.emit({ type: 'agent.resume' })
    await vi.waitFor(() => {
      env.answerRpcs()
      expect(env.pauseStates().at(-1)?.mode).toBe('running')
    })
    expect(env.tabMessages).toContainEqual({ tabId: 1, message: expect.objectContaining({ type: 'DSH_OVERLAY', op: 'takeover', on: false }) })
  })

  it('fails a held call closed before its deadline with a clear message', async () => {
    const env = await boot()
    env.panel.emit({ type: 'agent.pause', mode: 'after-step' })
    await vi.waitFor(() => { expect(env.pauseStates().at(-1)?.mode).toBe('paused') })
    env.socket.receive({ t: 'tool.call', id: 'late', name: 'browser_click', args: { selector: 'h1' }, expiresAt: Date.now() + 1_700, sessionId: 'session-live' })
    await vi.waitFor(() => {
      expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'late', ok: false, error: { code: 'timeout', message: HOLD_EXPIRED_MESSAGE } }))
    }, { timeout: 3_000 })
    expect(env.tabMessages.some(({ message }) => message.action === 'browser_click')).toBe(false)
    expect(env.sent().find((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'late')!.payload)
      .toMatchObject({ decision: 'held-expired' })
  })

  it('records a site-policy block for the audit log and never points at a refused target', async () => {
    const env = await boot({ siteRules: [{ pattern: 'https://example.com', rule: 'read-only' }] })
    env.socket.receive({ t: 'tool.call', id: 'ro', name: 'browser_click', args: { selector: 'h1' }, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'ro', ok: false })) })
    expect(env.sent().find((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'ro')!.payload)
      .toMatchObject({ policy: 'blocked', policyReason: expect.stringContaining('read-only') })
    expect(env.tabMessages.some(({ message }) => message.op === 'point' || message.action === 'browser_click')).toBe(false)
  })

  it('audits developer-tools calls like every other route: policy outcome and page URL (M4)', async () => {
    const env = await boot({ siteRules: [{ pattern: 'https://example.com', rule: 'blocked' }] })
    env.socket.receive({ t: 'tool.call', id: 'eval', name: 'browser_console_eval', args: { expression: '1' }, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'eval', ok: false })) })
    expect(env.sent().find((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'eval')!.payload)
      .toMatchObject({ policy: 'blocked', url: 'https://example.com/start', decision: 'not-required' })
  })

  it('points at the target before a click and fires the kill switch from the page pill', async () => {
    const env = await boot()
    env.socket.receive({ t: 'tool.call', id: 'c', name: 'browser_click', args: { selector: 'h1' }, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'c', ok: true })) })
    const point = env.tabMessages.findIndex(({ message }) => message.type === 'DSH_OVERLAY' && message.op === 'point')
    const click = env.tabMessages.findIndex(({ message }) => message.action === 'browser_click')
    expect(point).toBeGreaterThanOrEqual(0)
    expect(point).toBeLessThan(click)
    expect(env.tabMessages[point]!.message).toMatchObject({ kind: 'click', args: { selector: 'h1' } })
    // A trusted site passed the click without a card: not a user approval.
    expect(env.sent().find((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'c')!.payload)
      .toMatchObject({ decision: 'auto-allowed' })
    env.content.emit({ type: 'DSH_KILL_SWITCH' }, { id: 'test-extension', tab: browserTab('https://example.com/start') }, () => {})
    await vi.waitFor(() => {
      expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'rpc', method: BRIDGE_AUDIT_RECORD_METHOD, payload: { event: 'kill-switch' } }))
    })
  })

  it('ignores the kill switch and takeover Resume from another extension, outside a tab, or from an unbound tab (G22)', async () => {
    const env = await boot()
    env.socket.receive({ t: 'tool.call', id: 'first', name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10_000, sessionId: 'session-live' })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'first' })) })
    const killSwitchRecorded = () => env.sent().some((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.event === 'kill-switch')
    env.content.emit({ type: 'DSH_KILL_SWITCH' }, { id: 'other-extension', tab: browserTab('https://example.com/start') }, () => {})
    env.content.emit({ type: 'DSH_KILL_SWITCH' }, { id: 'test-extension' }, () => {})
    env.panel.emit({ type: 'agent.pause', mode: 'take-over' })
    await vi.waitFor(() => { expect(env.pauseStates().at(-1)?.mode).toBe('taken-over') })
    const unbound = { ...browserTab('https://example.com/other'), id: 99 }
    env.content.emit({ type: 'DSH_AGENT_RESUME' }, { id: 'test-extension', tab: unbound }, () => {})
    env.content.emit({ type: 'DSH_AGENT_RESUME' }, { id: 'other-extension', tab: browserTab('https://example.com/start') }, () => {})
    // A positive control afterwards: the bound tab's Resume does open the panel.
    env.content.emit({ type: 'DSH_AGENT_RESUME' }, { id: 'test-extension', tab: browserTab('https://example.com/start') }, () => {})
    await vi.waitFor(() => { expect(chrome.sidePanel.open).toHaveBeenCalledTimes(1) })
    expect(killSwitchRecorded()).toBe(false)
    expect(env.socket.readyState).toBe(FakeWebSocket.OPEN)
  })
})

describe('strict mode wiring (G4)', () => {
  const click = { t: 'tool.call', id: 'strict-click', name: 'browser_click', args: { selector: 'h1' }, sessionId: 'session-live' }

  it('refuses a call on a strict site where the debugger is unavailable, before any page action', async () => {
    const env = await boot({ strictSites: ['https://example.com'] })
    env.socket.receive({ ...click, expiresAt: Date.now() + 10_000 })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'strict-click', ok: false })) })
    const result = env.sent().find((frame) => frame.t === 'tool.result' && frame.id === 'strict-click')!
    expect(result.error?.message).toBe(STRICT_MODE_UNAVAILABLE)
    expect(env.tabMessages.some(({ message }) => message.action === 'browser_click')).toBe(false)
    expect(env.sent().find((frame) => frame.method === BRIDGE_AUDIT_RECORD_METHOD && frame.payload?.callId === 'strict-click')!.payload)
      .toMatchObject({ strict: 'refused' })
  })

  it('refuses rather than runs unguarded when the gate cannot attach', async () => {
    const attach = vi.fn(async () => { throw new Error('Another debugger is already attached') })
    const env = await boot({ strictSites: ['https://example.com'] }, {
      debugger: { attach, detach: vi.fn(async () => {}), sendCommand: vi.fn(async () => ({})), onEvent: chromeEvent(), onDetach: chromeEvent() },
    })
    env.socket.receive({ ...click, expiresAt: Date.now() + 10_000 })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'strict-click', ok: false })) })
    expect(attach).toHaveBeenCalled()
    const result = env.sent().find((frame) => frame.t === 'tool.result' && frame.id === 'strict-click')!
    expect(result.error?.message).toMatch(/refused rather than run unguarded/)
    expect(env.tabMessages.some(({ message }) => message.action === 'browser_click')).toBe(false)
  })

  it('runs the same call normally off the strict site', async () => {
    const env = await boot({ strictSites: ['https://other.example'] })
    env.socket.receive({ ...click, expiresAt: Date.now() + 10_000 })
    await vi.waitFor(() => { expect(env.sent()).toContainEqual(expect.objectContaining({ t: 'tool.result', id: 'strict-click', ok: true })) })
  })
})

