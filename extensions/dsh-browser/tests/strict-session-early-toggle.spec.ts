// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyRuntime, STRICT_SESSIONS_STORAGE_KEY } from '../src/background/policy-runtime.ts'
import { memoryStorage } from './support/chrome.ts'

beforeEach(() => { vi.stubGlobal('chrome', { runtime: { id: 'ext', getURL: () => 'chrome-extension://ext/' }, storage: {} } as unknown as typeof chrome) })
afterEach(() => { vi.unstubAllGlobals() })

describe('strict toggle before the stored set loads (refactor-security F3)', () => {
  it('keeps the other strict sessions in storage', async () => {
    const storage = memoryStorage({ [STRICT_SESSIONS_STORAGE_KEY]: ['s1'] })
    const options = { settings: () => ({ siteRules: [], siteDefaultsEnabled: true }), unrestricted: () => false, clearBridgeTaint: vi.fn(async () => {}), storage: storage.area }
    const restarted = new PolicyRuntime(options)
    restarted.setStrictSession('s2', true) // the panel message that woke the worker
    await restarted.ready
    await vi.waitFor(() => { expect(restarted.strictFor('s2', undefined)).toBe(true) })
    expect(restarted.strictFor('s1', undefined)).toBe(true)
    await vi.waitFor(() => { expect(storage.data[STRICT_SESSIONS_STORAGE_KEY]).toEqual(['s1', 's2']) })
    const next = new PolicyRuntime(options)
    await next.ready
    expect(next.strictFor('s1', undefined)).toBe(true)
    expect(next.strictFor('s2', undefined)).toBe(true)
  })
})
