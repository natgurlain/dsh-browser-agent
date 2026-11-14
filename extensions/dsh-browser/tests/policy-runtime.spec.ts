// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isExtensionPageSender, PolicyRuntime, POLICY_PORT_NAME } from '../src/background/policy-runtime.ts'

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getURL: (path: string) => `chrome-extension://ext/${path}` },
    storage: {},
  } as unknown as typeof chrome)
})
afterEach(() => { vi.unstubAllGlobals() })

function runtime(clearBridgeTaint = vi.fn(async () => {})) {
  return new PolicyRuntime({
    settings: () => ({ siteRules: [], siteDefaultsEnabled: true }),
    unrestricted: () => true,
    clearBridgeTaint,
  })
}

function port(sender: chrome.runtime.MessageSender) {
  const listeners: Array<(message: unknown) => void> = []
  const posted: unknown[] = []
  const value = {
    name: POLICY_PORT_NAME,
    sender,
    postMessage: (message: unknown) => { posted.push(message) },
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (message: unknown) => void) => { listeners.push(listener) } },
    onDisconnect: { addListener: () => {} },
  } as unknown as chrome.runtime.Port
  return { port: value, posted, emit: (message: unknown) => { for (const listener of listeners) listener(message) } }
}

describe('PolicyRuntime', () => {
  it('accepts the policy port only from extension pages, never content scripts', () => {
    expect(isExtensionPageSender({ id: 'ext', url: 'chrome-extension://ext/panel/index.html' })).toBe(true)
    expect(isExtensionPageSender({ id: 'ext', url: 'chrome-extension://ext/panel/index.html', tab: { id: 3 } as chrome.tabs.Tab })).toBe(true)
    expect(isExtensionPageSender({ id: 'ext', url: 'https://evil.example/', tab: { id: 3 } as chrome.tabs.Tab })).toBe(false)
    expect(isExtensionPageSender({ id: 'other', url: 'chrome-extension://ext/x' })).toBe(false)
    expect(isExtensionPageSender(undefined)).toBe(false)
    const rejected = port({ id: 'ext', url: 'https://evil.example/' })
    expect(runtime().connect(rejected.port)).toBe(true)
    expect(rejected.port.disconnect).toHaveBeenCalled()
  })

  it('taints from results with the origins the call touched, and clears here and on the bridge', async () => {
    const clearBridgeTaint = vi.fn(async () => {})
    const policy = runtime(clearBridgeTaint)
    await policy.ready
    const hook = policy.hook('call-1', 's1', true)
    expect(hook({ id: 'call-1', name: 'browser_snapshot', args: {} }, { reads: ['https://a.example'], acts: [] })).toEqual({ kind: 'trust' })
    policy.recordResult({ id: 'call-1', name: 'browser_snapshot', sessionId: 's1' }, true)
    expect(policy.get('s1')?.sources).toEqual(['https://a.example'])
    // Tainted now: a clipboard write is forced even under unrestricted access.
    const next = policy.hook('call-2', 's1', true)
    expect(next({ id: 'call-2', name: 'browser_clipboard', args: { action: 'write', text: 'x' } }, { reads: [], acts: [] }).kind).toBe('force')
    policy.recordResult({ id: 'call-2', name: 'browser_clipboard', sessionId: 's1' }, false)
    // A call that never reached the hook taints with the tab origin.
    policy.recordResult({ id: 'call-3', name: 'browser_list_tabs', sessionId: 's2' }, true, 'https://b.example')
    expect(policy.get('s2')?.sources).toEqual(['https://b.example'])

    const panel = port({ id: 'ext', url: 'chrome-extension://ext/panel/index.html' })
    expect(policy.connect(panel.port)).toBe(true)
    panel.emit({ type: 'taint.clear', id: 'c1', sessionId: 's1' })
    await vi.waitFor(() => { expect(panel.posted).toContainEqual(expect.objectContaining({ type: 'taint.clear.result', id: 'c1', bridgeCleared: true })) })
    expect(clearBridgeTaint).toHaveBeenCalledWith('s1')
    expect(policy.get('s1')).toBeUndefined()
    expect(policy.get('s2')).toBeDefined()
  })
})
