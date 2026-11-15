/**
 * Small fakes for the extension APIs that background suites stub by hand.
 */

import { vi } from 'vitest'

/** A `chrome.events.Event`-shaped listener set with an `emit` for the test side. */
export function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => unknown>()
  return {
    listeners,
    addListener: vi.fn((listener: (...args: T) => unknown) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => unknown) => { listeners.delete(listener) }),
    hasListener: (listener: (...args: T) => unknown) => listeners.has(listener),
    /** Call every listener; returns what they returned (`true` = async response). */
    emit: (...args: T): unknown[] => [...listeners].map((listener) => listener(...args)),
  }
}

/** The sender of a port opened by one of this extension's own pages (the stubbed `chrome.runtime`). */
function extensionPageSender(): chrome.runtime.MessageSender | undefined {
  const runtime = (globalThis as { chrome?: { runtime?: { id?: string; getURL?: (path: string) => string } } }).chrome?.runtime
  if (typeof runtime?.getURL !== 'function') return undefined
  return { ...(runtime.id === undefined ? {} : { id: runtime.id }), url: runtime.getURL('panel/index.html') }
}

/**
 * A connected extension-page port (the side panel by default). The worker
 * accepts its ports from extension pages only, so the sender defaults to one.
 */
export function panelPort(name = 'dsh-panel', sender: chrome.runtime.MessageSender | undefined = extensionPageSender()) {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const disconnect = vi.fn()
  // The panel port is accepted only from the extension's own pages: by default this is the side panel.
  const runtime = (globalThis as { chrome?: { runtime?: { id?: string; getURL?: (path: string) => string } } }).chrome?.runtime
  const page = sender ?? (name === 'dsh-panel' && typeof runtime?.getURL === 'function'
    ? { ...(runtime.id === undefined ? {} : { id: runtime.id }), url: runtime.getURL('panel/index.html') }
    : undefined)
  const port = {
    name,
    postMessage,
    disconnect,
    onMessage,
    onDisconnect,
    ...(page === undefined ? {} : { sender: page }),
  } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage, disconnect }
}

/** A `chrome.storage.StorageArea` backed by a plain object (`data`). */
export function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const area = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === undefined || keys === null) return { ...data }
      const list = typeof keys === 'string' ? [keys] : keys
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]))
    }),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items) }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]
    }),
  }
  return { data, area: area as unknown as chrome.storage.StorageArea & typeof area }
}

/** A complete `chrome.tabs.Tab` with test defaults. */
export function browserTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1, index: 0, pinned: false, highlighted: true, active: true, incognito: false, selected: true,
    discarded: false, autoDiscardable: true, groupId: -1, windowId: 1, title: 'Page', url: 'https://example.com/',
    ...overrides,
  }
}
