// @vitest-environment jsdom
/**
 * The global "Allow developer tools" setting ends by itself: the worker, not
 * the panel, decides when (devtools-allowance.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVTOOLS_ALLOWANCE_MS } from '../src/background/devtools-allowance.ts'
import { chromeEvent } from './support/chrome.ts'

const EXPIRY_ALARM = 'dsh-devtools-allowance'

async function boot(stored: Record<string, unknown>) {
  const onAlarm = chromeEvent<[chrome.alarms.Alarm]>()
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const localData: Record<string, unknown> = { dshSettings: { bridgeUrl: '', token: '', ...stored } }
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true), onAlarm }
  const set = vi.fn(async (items: Record<string, unknown>) => { Object.assign(localData, items) })
  vi.stubGlobal('chrome', {
    alarms,
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      getTargets: vi.fn(async () => []),
      onEvent: chromeEvent<[unknown, string, unknown]>(),
      onDetach: chromeEvent<[unknown, string]>(),
    },
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
        get: vi.fn(async (key?: string) => (typeof key === 'string' ? { [key]: localData[key] } : { ...localData })),
        set,
        remove: vi.fn(async () => {}),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    },
    tabs: {
      get: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced: chromeEvent<[number, number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: { getAllFrames: vi.fn(async () => []), onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: chromeEvent<[number]>(), onRemoved: chromeEvent<[number]>() },
  } as unknown as typeof chrome)
  await import('../src/background/index.ts')
  const storedSettings = (): Record<string, unknown> => localData.dshSettings as Record<string, unknown>
  const expiryAlarms = (): Array<{ when?: number }> => alarms.create.mock.calls
    .filter(([name]) => name === EXPIRY_ALARM)
    .map(([, info]) => info as { when?: number })
  return { onAlarm, alarms, set, storedSettings, expiryAlarms }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('developer-tools allowance expiry', () => {
  it('schedules the end of a live allowance and turns it off when the alarm fires', async () => {
    const until = Date.now() + 60 * 60_000
    const harness = await boot({ allowDevTools: true, allowDevToolsUntil: until })
    await vi.waitFor(() => { expect(harness.expiryAlarms()).toEqual([{ when: until }]) })
    expect(harness.storedSettings()).toMatchObject({ allowDevTools: true, allowDevToolsUntil: until })

    vi.spyOn(Date, 'now').mockReturnValue(until + 1)
    harness.onAlarm.emit({ name: EXPIRY_ALARM, scheduledTime: until })
    await vi.waitFor(() => {
      expect(harness.storedSettings()).toMatchObject({ allowDevTools: false, allowDevToolsUntil: 0 })
    })
    expect(harness.alarms.clear).toHaveBeenCalledWith(EXPIRY_ALARM)
  })

  it('leaves a live allowance alone when the alarm fires early', async () => {
    const until = Date.now() + 60 * 60_000
    const harness = await boot({ allowDevTools: true, allowDevToolsUntil: until })
    await vi.waitFor(() => { expect(harness.expiryAlarms()).toHaveLength(1) })
    harness.onAlarm.emit({ name: EXPIRY_ALARM, scheduledTime: until })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.storedSettings()).toMatchObject({ allowDevTools: true, allowDevToolsUntil: until })
  })

  it('writes back as off an allowance stored before the time limit existed', async () => {
    const harness = await boot({ allowDevTools: true })
    await vi.waitFor(() => {
      expect(harness.storedSettings()).toMatchObject({ allowDevTools: false, allowDevToolsUntil: 0 })
    })
    expect(harness.expiryAlarms()).toEqual([])
  })

  it('cuts a tampered end time down to one window', async () => {
    const before = Date.now()
    const harness = await boot({ allowDevTools: true, allowDevToolsUntil: before + 100 * DEVTOOLS_ALLOWANCE_MS })
    await vi.waitFor(() => { expect(harness.expiryAlarms()).toHaveLength(1) })
    expect(harness.expiryAlarms()[0]!.when).toBeLessThanOrEqual(Date.now() + DEVTOOLS_ALLOWANCE_MS)
  })
})
