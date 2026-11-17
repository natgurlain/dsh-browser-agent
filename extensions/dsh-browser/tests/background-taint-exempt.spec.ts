// @vitest-environment jsdom
/**
 * The whole worker: a tool result read from exempt pages only (local pages,
 * sites the user trusts) leaves the session untainted here and tells the
 * bridge so on the `tool.result` frame (`taintExempt: true`); every other
 * result carries no such flag, so the bridge taints as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_AUDIT_RECORD_METHOD,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_TAINT_CLEAR_METHOD,
} from 'dsh-browser-agent/src/protocol.ts'
import { completeHandshake, panelSawConnected, TEST_BRIDGE_TOKEN } from './support/bridge-handshake.ts'
import { FakeWebSocket } from './support/fake-websocket.ts'
import { chromeEvent } from './support/chrome.ts'

interface Sent { t?: string; id?: string; method?: string; payload?: Record<string, unknown>; ok?: boolean; taintExempt?: boolean }
interface Frame { frameId: number; parentFrameId: number; url: string }

const SESSION = 'session-live'
const LOCAL = 'http://localhost:3000'
const EVIL = 'https://evil.example'

async function boot(tabUrl: string, settings: Record<string, unknown> = {}, childFrames: Frame[] = []) {
  const tab = {
    id: 1, index: 0, pinned: false, highlighted: true, active: true, incognito: false, selected: true,
    discarded: false, autoDiscardable: true, groupId: -1, windowId: 1, title: 'Page', url: tabUrl,
  } as chrome.tabs.Tab
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const sessionData: Record<string, unknown> = {}
  const stored: Record<string, unknown> = {
    // The user said this local address is theirs (the default scope exempts only such origins).
    dshSettings: { bridgeUrl: 'wss://bridge.example/ext/bridge', token: TEST_BRIDGE_TOKEN, sharePageContent: 'auto', taintLocalOrigins: [LOCAL], ...settings },
  }
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: { create: vi.fn(async () => ''), clear: vi.fn(async () => true), onClicked: chromeEvent<[string]>() },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(stored, items) }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) }),
        remove: vi.fn(async (key: string) => { delete sessionData[key] }),
      },
    },
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async (_tabId: number, message: Record<string, unknown>) => (
        message.type === 'DSH_ACTION' ? { ok: true, result: { text: 'page text' } } : undefined
      )),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: {
      getAllFrames: vi.fn(async () => [
        { tabId: 1, frameId: 0, parentFrameId: -1, documentId: 'document-1', url: tabUrl },
        ...childFrames.map((frame) => ({ tabId: 1, documentId: `document-${String(frame.frameId)}`, ...frame })),
      ]),
      onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>(),
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: chromeEvent<[number]>(), onRemoved: chromeEvent<[number]>() },
  } as unknown as typeof chrome)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  await import('../src/background/index.ts')

  const portMessages = chromeEvent<[unknown]>()
  const port = { name: 'dsh-panel', sender: { id: chrome.runtime.id, url: chrome.runtime.getURL('panel/index.html') }, postMessage: vi.fn(), disconnect: vi.fn(), onMessage: portMessages, onDisconnect: chromeEvent<[]>() } as unknown as chrome.runtime.Port
  onConnect.emit(port)
  await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(1) })
  const socket = FakeWebSocket.instances[0]!
  socket.open()
  await completeHandshake(socket, { until: panelSawConnected(port.postMessage as unknown as { mock: { calls: unknown[][] } }) })
  portMessages.emit({ type: 'session.active', sessionId: SESSION, isNew: true })
  const sent = (): Sent[] => socket.sent as Sent[]
  const answered = new Set<string>()
  const answerRpcs = (): void => {
    for (const frame of sent()) {
      if (frame.t !== 'rpc' || frame.id === undefined || answered.has(frame.id)) continue
      if (![BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, BRIDGE_AUDIT_RECORD_METHOD, BRIDGE_TAINT_CLEAR_METHOD].includes(frame.method ?? '')) continue
      answered.add(frame.id)
      socket.receive({ t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
    }
  }
  let seq = 0
  /** Run one tool call of the session and return its `tool.result` frame. */
  const tool = async (name: string, args: Record<string, unknown> = {}, sessionId = SESSION): Promise<Sent> => {
    const id = `call-${String(seq += 1)}`
    socket.receive({ t: 'tool.call', id, name, args, expiresAt: Date.now() + 10_000, sessionId })
    await vi.waitFor(() => {
      answerRpcs()
      expect(sent().some((frame) => frame.t === 'tool.result' && frame.id === id)).toBe(true)
    })
    return sent().find((frame) => frame.t === 'tool.result' && frame.id === id)!
  }
  const taint = (): Record<string, { sources: string[] }> => (sessionData.dshSessionTaint ?? {}) as Record<string, { sources: string[] }>
  const settingsStored = (): Record<string, unknown> => stored.dshSettings as Record<string, unknown>
  /** Save settings through the panel port, as the Settings page does. */
  const saveSettings = async (next: Record<string, unknown>): Promise<void> => {
    const id = `settings-${String(seq += 1)}`
    portMessages.emit({ type: 'settings', id, settings: next })
    await vi.waitFor(() => {
      expect((port.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([message]) => (
        (message as { type?: string; id?: string }).type === 'settings.result' && (message as { id?: string }).id === id
      ))).toBe(true)
    })
  }
  return { tool, taint, sent, answerRpcs, sessionData, socket, onConnect, settingsStored, saveSettings }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  FakeWebSocket.instances = []
})

describe('the worker vouches only for exempt reads', () => {
  it('a local page the user confirmed: no taint here, and the result frame tells the bridge, marked as local', async () => {
    const env = await boot(`${LOCAL}/app`)
    const result = await env.tool('browser_snapshot')
    expect(result).toMatchObject({ ok: true, taintExempt: true, taintExemptLocal: true })
    expect((await env.tool('browser_get_text', { selector: 'h1' })).taintExempt).toBe(true)
    expect(env.taint()[SESSION]).toBeUndefined()
  })

  it('a local address the user never confirmed taints (the shipped default scope)', async () => {
    const env = await boot('http://localhost:8080/app')
    expect(await env.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual(['http://localhost:8080']) })
  })

  it('F4: the Host says an ancestor read exempt pages: this session can never have a single source', async () => {
    const env = await boot(`${EVIL}/inbox`)
    const id = 'child-call'
    env.socket.receive({ t: 'tool.call', id, name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10_000, sessionId: SESSION, inheritedExemptReads: true })
    await vi.waitFor(() => {
      env.answerRpcs()
      expect(env.sent().some((frame) => frame.t === 'tool.result' && frame.id === id)).toBe(true)
    })
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual(['(unknown)', EVIL]) })
  })

  it('F1: a page served by the DSH host itself is never exempt, whatever the user trusted', async () => {
    // The bridge address is wss://bridge.example: its web UI shows every session's transcript.
    const env = await boot('https://bridge.example/sessions', { taintTrustedSites: ['bridge.example'] })
    expect(await env.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual(['https://bridge.example']) })
  })

  it('the panel port is refused to anything but an extension page', async () => {
    const env = await boot(`${LOCAL}/app`)
    const before = env.settingsStored().siteRules
    const messages = chromeEvent<[unknown]>()
    const disconnect = vi.fn()
    const contentScript = {
      name: 'dsh-panel',
      sender: { id: chrome.runtime.id, url: 'https://evil.example/', tab: { id: 9 } },
      postMessage: vi.fn(),
      disconnect,
      onMessage: messages,
      onDisconnect: chromeEvent<[]>(),
    } as unknown as chrome.runtime.Port
    env.onConnect.emit(contentScript)
    expect(disconnect).toHaveBeenCalled()
    expect(messages.listeners.size).toBe(0)
    // Nothing it sends is heard: it cannot write site rules or always-allowed origins.
    messages.emit({ type: 'settings', id: 'x', settings: { siteRules: [{ pattern: 'evil.example', rule: 'trusted' }], trustedActionOrigins: ['https://evil.example'] } })
    await Promise.resolve()
    expect(env.settingsStored().siteRules).toEqual(before)
    expect(contentScript.postMessage).not.toHaveBeenCalled()
  })

  it('a trusted site added in Settings now counts at once; one that predates the exemption waits for "Keep"', async () => {
    const env = await boot('https://seraph.quest/board', { siteRules: [{ pattern: 'old.example', rule: 'trusted' }], trustedActionOrigins: ['https://old-allowed.example'] })
    expect(env.settingsStored().taintTrustConfirmed ?? []).toEqual([])
    await env.saveSettings({ siteRules: [{ pattern: 'old.example', rule: 'trusted' }, { pattern: 'seraph.quest', rule: 'trusted' }] })
    expect(env.settingsStored().taintTrustConfirmed).toEqual(['rule:seraph.quest'])
    // The panel's "Keep all" confirms the old ones.
    await env.saveSettings({ taintTrustConfirmed: ['rule:seraph.quest', 'rule:old.example', 'origin:https://old-allowed.example', 'rule:gone.example'] })
    expect(env.settingsStored().taintTrustConfirmed).toEqual(['origin:https://old-allowed.example', 'rule:old.example', 'rule:seraph.quest'])
    // Removing an entry forgets its confirmation.
    await env.saveSettings({ trustedActionOrigins: [] })
    expect(env.settingsStored().taintTrustConfirmed).toEqual(['rule:old.example', 'rule:seraph.quest'])
  })

  it('an external page: tainted, and no flag on the frame', async () => {
    const env = await boot(`${EVIL}/inbox`)
    const result = await env.tool('browser_snapshot')
    expect(result.ok).toBe(true)
    expect(result).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual([EVIL]) })
  })

  it.each(['http://localhost.evil.test:3000/', 'http://127.0.0.1.nip.io/'])('a look-alike host is not local: %s', async (url) => {
    const env = await boot(url)
    expect(await env.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual([new URL(url).origin]) })
  })

  it('a local page that embeds a cross-origin frame taints as soon as that frame is read', async () => {
    const env = await boot(`${LOCAL}/app`, {}, [{ frameId: 5, parentFrameId: 0, url: `${EVIL}/widget` }])
    // The panel's own follow snapshot reads every frame: not vouched for, and both origins are sources.
    await vi.waitFor(() => {
      env.answerRpcs()
      expect(env.sent().some((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD)).toBe(true)
    })
    expect(env.sent().find((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD)?.payload).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual([EVIL, LOCAL].sort()) })
    expect(await env.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    // Once tainted, a later top-frame-only read is not vouched for either.
    expect(await env.tool('browser_get_text', { selector: 'h1' })).not.toHaveProperty('taintExempt')
  })

  it('the local-pages setting off: local pages taint as before', async () => {
    const env = await boot(`${LOCAL}/app`, { taintExemptLocalPages: false })
    expect(await env.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(env.taint()[SESSION]?.sources).toEqual([LOCAL]) })
  })

  it('a site the user marked trusted: exempt; with the setting off, or under the blanket switch only, it taints', async () => {
    const rule = { siteRules: [{ pattern: 'seraph.quest', rule: 'trusted' }], taintTrustConfirmed: ['rule:seraph.quest'] }
    const trusted = await boot('https://seraph.quest/board', rule)
    const vouched = await trusted.tool('browser_snapshot')
    expect(vouched.taintExempt).toBe(true)
    expect(vouched).not.toHaveProperty('taintExemptLocal')
    expect(trusted.taint()[SESSION]).toBeUndefined()
    vi.resetModules()
    FakeWebSocket.instances = []
    // The same rule, stored before the exemption existed and never confirmed: it taints.
    const unconfirmed = await boot('https://seraph.quest/board', { siteRules: rule.siteRules })
    expect(await unconfirmed.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    vi.resetModules()
    FakeWebSocket.instances = []
    // Plain http to a trusted host is never exempt.
    const http = await boot('http://seraph.quest/board', rule)
    expect(await http.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    vi.resetModules()
    FakeWebSocket.instances = []
    const off = await boot('https://seraph.quest/board', { ...rule, taintExemptTrustedSites: false })
    expect(await off.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    vi.resetModules()
    FakeWebSocket.instances = []
    const blanket = await boot('https://seraph.quest/board', { unrestrictedBrowserAccess: true, settingsVersion: 2 })
    expect(await blanket.tool('browser_snapshot')).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(blanket.taint()[SESSION]?.sources).toEqual(['https://seraph.quest']) })
  })

  it('a session the Host holds tainted is never vouched for, even on a local page', async () => {
    const env = await boot(`${LOCAL}/app`)
    const id = 'host-tainted'
    FakeWebSocket.instances[0]!.receive({ t: 'tool.call', id, name: 'browser_snapshot', args: {}, expiresAt: Date.now() + 10_000, sessionId: SESSION, tainted: true })
    await vi.waitFor(() => {
      env.answerRpcs()
      expect(env.sent().some((frame) => frame.t === 'tool.result' && frame.id === id)).toBe(true)
    })
    expect(env.sent().find((frame) => frame.t === 'tool.result' && frame.id === id)).not.toHaveProperty('taintExempt')
    expect(env.taint()[SESSION]?.sources).toContain('(unknown)')
  })

  it('the snapshot injected when the panel follows a local tab is vouched for too; an external one is not', async () => {
    const local = await boot(`${LOCAL}/app`)
    await vi.waitFor(() => {
      local.answerRpcs()
      expect(local.sent().some((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD)).toBe(true)
    })
    expect(local.sent().find((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD)?.payload).toMatchObject({ sessionId: SESSION, taintExempt: true })
    expect(local.taint()[SESSION]).toBeUndefined()
    vi.resetModules()
    FakeWebSocket.instances = []
    const external = await boot(`${EVIL}/inbox`)
    await vi.waitFor(() => {
      external.answerRpcs()
      expect(external.sent().some((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD)).toBe(true)
    })
    expect(external.sent().find((frame) => frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD)?.payload).not.toHaveProperty('taintExempt')
    await vi.waitFor(() => { expect(external.taint()[SESSION]?.sources).toEqual([EVIL]) })
  })
})
