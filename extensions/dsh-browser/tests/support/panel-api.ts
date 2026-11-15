/**
 * App-level `PanelApi` fake shared by the panel specs: every subscription
 * returns a no-op unsubscribe, every command resolves, and `rpc` answers an
 * empty history. Specs pass only what they observe or answer differently.
 */

import { vi } from 'vitest'
import type { PanelApi } from '../../src/panel/api.ts'

export function fakePanelApi(overrides: Partial<PanelApi> = {}): PanelApi {
  const unsubscribe = (): void => {}
  return {
    rpc: async <T = unknown>(): Promise<T> => ({ events: [] }) as T,
    respond: vi.fn(async () => undefined),
    onStatus: vi.fn(() => unsubscribe),
    onEvent: vi.fn(() => unsubscribe),
    onApprovalRequest: vi.fn(() => unsubscribe),
    onApprovalResolved: vi.fn(() => unsubscribe),
    onTabAffinity: vi.fn(() => unsubscribe),
    onSelection: vi.fn(() => unsubscribe),
    onSessionResumeHint: vi.fn(() => unsubscribe),
    respondToApproval: vi.fn(async () => {}),
    resolveTabAffinity: vi.fn(async () => {}),
    rebindTabAffinity: vi.fn(async () => {}),
    returnToControlledTab: vi.fn(async () => {}),
    clearSelection: vi.fn(async () => {}),
    registerWindow: vi.fn(async () => {}),
    setActiveSession: vi.fn(async () => {}),
    updateSettings: vi.fn(async () => {}),
    onDevToolsStatus: vi.fn(() => unsubscribe),
    detachDevTools: vi.fn(async () => undefined),
    requestStatus: vi.fn(async () => {}),
    startDiscovery: vi.fn(async () => []),
    cancelDiscovery: vi.fn(async () => {}),
    onDiscoveryProgress: vi.fn(() => unsubscribe),
    pair: vi.fn(async () => {}),
    engageKillSwitch: vi.fn(async () => undefined),
    releaseKillSwitch: vi.fn(async () => undefined),
    onKillSwitch: vi.fn(() => unsubscribe),
    pauseAgent: vi.fn(async () => {}),
    resumeAgent: vi.fn(async () => {}),
    onPauseState: vi.fn(() => unsubscribe),
    ...overrides,
  }
}
