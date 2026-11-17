// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { RuntimeKeeper, RuntimeLease } from '../src/background/runtime-lifecycle.ts'
import { CLIENT_ID_STORAGE_KEY, createClientId, loadClientIdentity } from '../src/background/client-identity.ts'
import { isBridgeClientIdentity } from 'dsh-browser-agent/src/protocol.ts'

function setup(idleMs = 1_000) {
  let now = 10_000
  const counts = { panels: 0, toolCalls: 0, approvals: 0 }
  const lease = new RuntimeLease({
    panels: () => counts.panels,
    toolCalls: () => counts.toolCalls,
    approvals: () => counts.approvals,
  }, idleMs, () => now)
  const handlers: Array<() => void> = []
  const timers = {
    setInterval: vi.fn((handler: () => void) => { handlers.push(handler); return handlers.length }),
    clearInterval: vi.fn(),
  }
  const hooks = { heartbeat: vi.fn(), onActive: vi.fn(), onIdle: vi.fn(), persist: vi.fn() }
  const keeper = new RuntimeKeeper(lease, hooks, 100, timers)
  return {
    counts,
    lease,
    keeper,
    hooks,
    timers,
    advance: (ms: number) => { now += ms },
    tick: () => { handlers.at(-1)?.() },
    now: () => now,
  }
}

describe('RuntimeLease', () => {
  it('is idle until something happens', () => {
    const { lease } = setup()
    expect(lease.active()).toBe(false)
  })

  it('stays active while a panel, a tool call, or an approval is in flight', () => {
    const { lease, counts, advance } = setup()
    for (const key of ['panels', 'toolCalls', 'approvals'] as const) {
      counts[key] = 1
      advance(10_000)
      expect(lease.active()).toBe(true)
      expect(lease.busy()).toBe(true)
      counts[key] = 0
    }
  })

  it('stays active for the idle window after the last activity', () => {
    const { lease, advance, now } = setup()
    lease.touch()
    expect(lease.activeUntil()).toBe(now() + 1_000)
    advance(999)
    expect(lease.active()).toBe(true)
    advance(1)
    expect(lease.active()).toBe(false)
  })

  it('restores a persisted lease without extending it past one idle window', () => {
    const { lease, advance, now } = setup()
    lease.restore(now() + 500)
    expect(lease.active()).toBe(true)
    advance(500)
    expect(lease.active()).toBe(false)
    lease.restore(now() + 1_000_000)
    expect(lease.activeUntil()).toBe(now() + 1_000)
    lease.restore(Number.NaN)
    expect(lease.active()).toBe(true)
  })
})

describe('RuntimeKeeper', () => {
  it('heartbeats while active, then reports idle once and stops', () => {
    const { keeper, lease, hooks, timers, advance, tick, now } = setup()
    keeper.update()
    expect(keeper.isAwake).toBe(false)
    expect(hooks.onIdle).not.toHaveBeenCalled()

    lease.touch()
    keeper.update()
    expect(keeper.isAwake).toBe(true)
    expect(hooks.onActive).toHaveBeenCalledTimes(1)
    expect(hooks.persist).toHaveBeenLastCalledWith(now() + 1_000)
    keeper.update()
    expect(timers.setInterval).toHaveBeenCalledTimes(1)

    advance(500)
    tick()
    expect(hooks.heartbeat).toHaveBeenCalledTimes(1)
    advance(500)
    tick()
    expect(hooks.heartbeat).toHaveBeenCalledTimes(1)
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
    expect(hooks.persist).toHaveBeenLastCalledWith(undefined)
    expect(timers.clearInterval).toHaveBeenCalledTimes(1)
    keeper.update()
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
  })

  it('keeps going while busy and persists the moving lease end sparingly', () => {
    const { keeper, counts, hooks, advance, tick } = setup()
    counts.toolCalls = 1
    keeper.update()
    const writes = hooks.persist.mock.calls.length
    advance(50)
    tick()
    expect(hooks.persist.mock.calls.length).toBe(writes)
    advance(100)
    tick()
    expect(hooks.persist.mock.calls.length).toBe(writes + 1)
    counts.toolCalls = 0
    advance(5_000)
    tick()
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
  })
})

describe('client identity', () => {
  function memoryStorage(initial: Record<string, unknown> = {}) {
    const data = { ...initial }
    return {
      data,
      get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items) }),
    }
  }

  it('creates a valid random id once and reuses it', async () => {
    const storage = memoryStorage()
    const first = await loadClientIdentity(storage, 'chrome')
    expect(isBridgeClientIdentity(first)).toBe(true)
    expect(first.browser).toBe('chrome')
    expect(storage.data[CLIENT_ID_STORAGE_KEY]).toBe(first.id)
    expect(await loadClientIdentity(storage, 'chrome')).toEqual(first)
    expect(createClientId()).not.toBe(createClientId())
  })

  it('replaces a malformed stored id and survives storage failures', async () => {
    const storage = memoryStorage({ [CLIENT_ID_STORAGE_KEY]: 'bad id' })
    const identity = await loadClientIdentity(storage, 'firefox')
    expect(identity.id).not.toBe('bad id')
    expect(isBridgeClientIdentity(identity)).toBe(true)
    const broken = {
      get: async () => { throw new Error('no storage') },
      set: async () => { throw new Error('no storage') },
    }
    expect(isBridgeClientIdentity(await loadClientIdentity(broken, 'chrome'))).toBe(true)
  })
})
