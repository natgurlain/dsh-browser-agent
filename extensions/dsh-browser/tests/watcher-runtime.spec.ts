// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_WATCH_FIRE_METHOD } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { PageWatcherRuntime, type PageWatcherRuntimeOptions } from '../src/background/watcher-runtime.ts'
import { WATCHERS_STORAGE_KEY, type PageWatcher } from '../src/background/watchers.ts'
import { chromeEvent, memoryStorage, panelPort } from './support/chrome.ts'

function watcher(overrides: Partial<PageWatcher> = {}): PageWatcher {
  return {
    id: 'w-1', sessionId: 's1', tabId: 5, origin: 'https://shop.example', url: 'https://shop.example/cart',
    condition: { kind: 'selector', selector: '#in-stock', gone: false }, prompt: 'Buy it',
    createdAt: Date.now(), expiresAt: Date.now() + 60 * 60_000, maxFires: 3, fires: 0,
    ...overrides,
  }
}

type Sender = chrome.runtime.MessageSender
type OnMessage = (message: unknown, sender: Sender, sendResponse: (response: unknown) => void) => unknown

function stubChrome(options: { local?: Record<string, unknown>; session?: Record<string, unknown> | false; openTabs?: number[] } = {}) {
  const local = memoryStorage(options.local)
  const session = options.session === false ? undefined : memoryStorage(options.session)
  const onMessage = chromeEvent<Parameters<OnMessage>>()
  const openTabs = new Set(options.openTabs ?? [5])
  const sendMessage = vi.fn(async () => undefined)
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getURL: (path: string) => `chrome-extension://ext/${path}`, onMessage },
    storage: { local: local.area, ...(session === undefined ? {} : { session: session.area }) },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (!openTabs.has(tabId)) throw new Error(`No tab with id: ${String(tabId)}`)
        return { id: tabId, url: 'https://shop.example/cart', windowId: 1 }
      }),
      sendMessage,
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  })
  return { local, session, onMessage, sendMessage }
}

function runtimeOptions(overrides: Partial<PageWatcherRuntimeOptions> = {}): PageWatcherRuntimeOptions {
  return {
    enabled: () => true,
    blocked: () => false,
    shareContent: () => true,
    rpc: vi.fn(async () => ({ type: 'server-response', result: { ok: true, value: { woken: true } } })),
    noteTaint: vi.fn(),
    ...overrides,
  }
}

/** Deliver one content-script message and wait for its async response. */
function deliver(onMessage: ReturnType<typeof stubChrome>['onMessage'], message: unknown, sender: Sender): Promise<unknown> {
  return new Promise((resolve) => {
    const answered = onMessage.emit(message, sender, resolve)
    if (!answered.includes(true)) resolve('no-response')
  })
}

const hitSender = (overrides: Partial<Sender> = {}): Sender => ({
  id: 'ext', frameId: 0, url: 'https://shop.example/cart', tab: { id: 5 } as chrome.tabs.Tab, ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('page watcher runtime', () => {
  it('keeps watchers in session storage: tab ids do not outlive the browser session (H2)', async () => {
    const harness = stubChrome({ local: { [WATCHERS_STORAGE_KEY]: [watcher({ id: 'w-old' })] } })
    const runtime = new PageWatcherRuntime(runtimeOptions())
    await runtime.registry.ready
    // A watcher left in local storage by an older build is not revived for whatever tab now has id 5.
    expect(runtime.registry.list()).toEqual([])
    await runtime.registry.add(watcher())
    expect(harness.session!.data[WATCHERS_STORAGE_KEY]).toEqual([expect.objectContaining({ id: 'w-1', tabId: 5 })])
    expect(harness.local.data[WATCHERS_STORAGE_KEY]).toBeUndefined()
  })

  it('drops watchers of tabs that are gone when the worker starts (H2)', async () => {
    stubChrome({ session: { [WATCHERS_STORAGE_KEY]: [watcher({ id: 'w-live' }), watcher({ id: 'w-gone', tabId: 9 })] }, openTabs: [5] })
    const runtime = new PageWatcherRuntime(runtimeOptions())
    await vi.waitFor(() => { expect(runtime.registry.list().map((entry) => entry.id)).toEqual(['w-live']) })
  })

  it('falls back to local storage where there is no session area', async () => {
    const harness = stubChrome({ session: false, local: { [WATCHERS_STORAGE_KEY]: [watcher()] } })
    const runtime = new PageWatcherRuntime(runtimeOptions())
    await runtime.registry.ready
    expect(runtime.registry.list().map((entry) => entry.id)).toEqual(['w-1'])
    await runtime.registry.remove('w-1')
    expect(harness.local.data[WATCHERS_STORAGE_KEY]).toEqual([])
  })

  it('taints the owning session with the page origin on a delivered wake (G9)', async () => {
    const harness = stubChrome({ session: { [WATCHERS_STORAGE_KEY]: [watcher()] } })
    const options = runtimeOptions()
    const runtime = new PageWatcherRuntime(options)
    await runtime.registry.ready
    const outcome = await deliver(harness.onMessage, { type: 'DSH_WATCH_HIT', watchId: 'w-1', matched: 'In stock' }, hitSender())
    expect(outcome).toEqual({ accepted: true })
    expect(options.rpc).toHaveBeenCalledWith(BRIDGE_WATCH_FIRE_METHOD, expect.objectContaining({ watchId: 'w-1', sessionId: 's1' }))
    expect(options.noteTaint).toHaveBeenCalledWith('s1', 'https://shop.example')
  })

  it('does not taint when the bridge did not wake the session', async () => {
    const harness = stubChrome({ session: { [WATCHERS_STORAGE_KEY]: [watcher()] } })
    const options = runtimeOptions({ rpc: vi.fn(async () => ({ type: 'server-response', result: { ok: true, value: { woken: false, reason: 'not-running' } } })) })
    const runtime = new PageWatcherRuntime(options)
    await runtime.registry.ready
    expect(await deliver(harness.onMessage, { type: 'DSH_WATCH_HIT', watchId: 'w-1' }, hitSender())).toEqual({ accepted: false, reason: 'not-running' })
    expect(options.noteTaint).not.toHaveBeenCalled()
  })

  it('ignores hits from another extension or from outside a tab (G9)', async () => {
    const harness = stubChrome({ session: { [WATCHERS_STORAGE_KEY]: [watcher()] } })
    const options = runtimeOptions()
    const runtime = new PageWatcherRuntime(options)
    await runtime.registry.ready
    expect(await deliver(harness.onMessage, { type: 'DSH_WATCH_HIT', watchId: 'w-1' }, hitSender({ id: 'other-extension' }))).toBe('no-response')
    const { tab: _tab, ...noTab } = hitSender()
    expect(await deliver(harness.onMessage, { type: 'DSH_WATCH_HIT', watchId: 'w-1' }, noTab)).toBe('no-response')
    expect(options.rpc).not.toHaveBeenCalled()
    expect(options.noteTaint).not.toHaveBeenCalled()
  })

  it('clearAll revokes every watcher and disarms their tabs (G9)', async () => {
    const harness = stubChrome({ session: { [WATCHERS_STORAGE_KEY]: [watcher(), watcher({ id: 'w-2' })] } })
    const runtime = new PageWatcherRuntime(runtimeOptions())
    await runtime.registry.ready
    harness.sendMessage.mockClear()
    await runtime.clearAll()
    expect(runtime.registry.list()).toEqual([])
    expect(harness.session!.data[WATCHERS_STORAGE_KEY]).toEqual([])
    expect(harness.sendMessage).toHaveBeenCalledWith(5, { type: 'DSH_WATCH_ARM', watches: [] }, { frameId: 0 })
  })

  it('accepts the watcher port only from extension pages', () => {
    stubChrome()
    const runtime = new PageWatcherRuntime(runtimeOptions())
    const content = panelPort('dsh-watchers', { id: 'ext', url: 'https://evil.example/' })
    expect(runtime.connect(content.port)).toBe(true)
    expect(content.disconnect).toHaveBeenCalled()
    expect(content.onMessage.addListener).not.toHaveBeenCalled()
    const panel = panelPort('dsh-watchers', { id: 'ext', url: 'chrome-extension://ext/panel/index.html' })
    expect(runtime.connect(panel.port)).toBe(true)
    expect(panel.onMessage.addListener).toHaveBeenCalled()
  })
})
