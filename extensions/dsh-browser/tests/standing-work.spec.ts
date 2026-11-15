// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeKeeper,
  RuntimeLease,
  STANDING_RETRY_BASE_MS,
  STANDING_RETRY_MAX_MS,
  StandingBackoff,
  isStandingBackoffState,
} from '../src/background/runtime-lifecycle.ts'
import {
  STANDING_HOST_MAX_AGE_MS,
  hintAddressAllowed,
  hostHasStanding,
  normalizeBridgeUrl,
  parseStoredStandingHost,
  standingCount,
  storedStandingHost,
} from '../src/background/standing-work.ts'
import { handleWatchHit, WatcherRegistry, type PageWatcher, type WatchStorage } from '../src/background/watchers.ts'
import { parseStandingStatus } from '../src/panel/api.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'

function setup(idleMs = 1_000) {
  let now = 10_000
  const counts = { panels: 0, toolCalls: 0, approvals: 0, standing: 0 }
  const lease = new RuntimeLease({
    panels: () => counts.panels,
    toolCalls: () => counts.toolCalls,
    approvals: () => counts.approvals,
    standing: () => counts.standing,
  }, idleMs, () => now)
  const handlers: Array<() => void> = []
  const timers = {
    setInterval: vi.fn((handler: () => void) => { handlers.push(handler); return handlers.length }),
    clearInterval: vi.fn(),
  }
  const hooks = { heartbeat: vi.fn(), onActive: vi.fn(), onIdle: vi.fn(), persist: vi.fn() }
  const keeper = new RuntimeKeeper(lease, hooks, 100, timers)
  return { counts, lease, keeper, hooks, advance: (ms: number) => { now += ms }, tick: () => { handlers.at(-1)?.() }, now: () => now }
}

describe('runtime lease with standing work', () => {
  it('stays active past the idle window while standing work exists, and ends with it', () => {
    const { lease, counts, advance } = setup()
    lease.touch()
    advance(60_000)
    expect(lease.active()).toBe(false)
    counts.standing = 2
    expect(lease.active()).toBe(true)
    advance(24 * 60 * 60_000)
    expect(lease.active()).toBe(true)
    counts.standing = 0
    expect(lease.active()).toBe(false)
  })

  it('reports standing-only when nothing else holds the lease', () => {
    const { lease, counts, advance } = setup()
    counts.standing = 1
    expect(lease.standingOnly()).toBe(true)
    expect(lease.busy()).toBe(false)
    lease.touch()
    // Recent activity: someone may be waiting on the connection, so the normal cadence applies.
    expect(lease.standingOnly()).toBe(false)
    advance(1_000)
    expect(lease.standingOnly()).toBe(true)
    counts.panels = 1
    expect(lease.standingOnly()).toBe(false)
    counts.panels = 0
    counts.standing = 0
    expect(lease.standingOnly()).toBe(false)
  })

  it('treats a missing, negative or non-finite count as none', () => {
    const { lease, counts } = setup()
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      counts.standing = bad
      expect(lease.active(), String(bad)).toBe(false)
    }
    const plain = new RuntimeLease({ panels: () => 0, toolCalls: () => 0, approvals: () => 0 })
    expect(plain.active()).toBe(false)
    expect(plain.standingOnly()).toBe(false)
  })

  it('keeps the keeper awake for standing work and reports idle once it is gone', () => {
    const { keeper, counts, hooks, advance, tick } = setup()
    counts.standing = 1
    keeper.update()
    expect(keeper.isAwake).toBe(true)
    expect(hooks.onActive).toHaveBeenCalledTimes(1)
    advance(10 * 60_000)
    tick()
    expect(hooks.heartbeat).toHaveBeenCalledTimes(1)
    expect(hooks.onIdle).not.toHaveBeenCalled()
    counts.standing = 0
    tick()
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
    expect(keeper.isAwake).toBe(false)
  })
})

describe('StandingBackoff', () => {
  it('doubles from 30 s up to the 5-minute cap and resets', () => {
    let now = 1_000_000
    const backoff = new StandingBackoff(() => now)
    expect(backoff.parked).toBe(false)
    expect(backoff.due()).toBe(true)
    expect(backoff.snapshot()).toBeUndefined()
    const delays = Array.from({ length: 7 }, () => backoff.fail())
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
    expect(delays[0]).toBe(STANDING_RETRY_BASE_MS)
    expect(delays.at(-1)).toBe(STANDING_RETRY_MAX_MS)
    expect(backoff.parked).toBe(true)
    expect(backoff.due()).toBe(false)
    expect(backoff.retryAt).toBe(now + 300_000)
    now += 299_999
    expect(backoff.due()).toBe(false)
    now += 1
    expect(backoff.due()).toBe(true)
    backoff.reset()
    expect(backoff.parked).toBe(false)
    expect(backoff.fail()).toBe(30_000)
  })

  it('carries its state across a worker restart, clamping a wait beyond the cap', () => {
    let now = 5_000
    const first = new StandingBackoff(() => now)
    first.fail()
    first.fail()
    const state = first.snapshot()
    expect(state).toEqual({ failures: 2, nextAt: 65_000 })
    const second = new StandingBackoff(() => now)
    second.restore(state)
    expect(second.parked).toBe(true)
    expect(second.due()).toBe(false)
    expect(second.fail()).toBe(120_000)
    const skewed = new StandingBackoff(() => now)
    skewed.restore({ failures: 3, nextAt: now + 10 * 24 * 60 * 60_000 })
    expect(skewed.retryAt).toBe(now + STANDING_RETRY_MAX_MS)
    for (const bad of [undefined, null, 'x', {}, { failures: 0, nextAt: 1 }, { failures: 1 }, { failures: 1.5, nextAt: 1 }, { failures: 1, nextAt: Number.NaN }]) {
      const untouched = new StandingBackoff(() => now)
      untouched.restore(bad)
      expect(untouched.parked, JSON.stringify(bad)).toBe(false)
      expect(isStandingBackoffState(bad)).toBe(false)
    }
  })
})

describe('stored host hint', () => {
  const now = 2_000_000_000_000
  const url = 'ws://127.0.0.1:3080/ext/bridge'

  it('stores only a hint that has standing work and an address', () => {
    expect(storedStandingHost({ schedules: 2, mcp: false }, url, now)).toEqual({ schedules: 2, mcp: false, url, seenAt: now })
    expect(storedStandingHost({ schedules: 0, mcp: true }, url, now)).toEqual({ schedules: 0, mcp: true, url, seenAt: now })
    expect(storedStandingHost({ schedules: 0, mcp: false }, url, now)).toBeUndefined()
    expect(storedStandingHost({ schedules: 1, mcp: false }, undefined, now)).toBeUndefined()
    expect(storedStandingHost({ schedules: 1, mcp: false }, 'https://example.com/', now)).toBeUndefined()
    expect(hostHasStanding({ schedules: 0, mcp: false })).toBe(false)
    expect(standingCount({ watchers: 2, schedules: 3, mcp: true })).toBe(6)
    expect(standingCount({ watchers: 0, schedules: 0, mcp: false })).toBe(0)
  })

  it('reads back only a well-formed, recent hint', () => {
    const good = { schedules: 1, mcp: true, url, seenAt: now - 1_000 }
    expect(parseStoredStandingHost(good, now)).toEqual(good)
    expect(parseStoredStandingHost({ ...good, seenAt: now - STANDING_HOST_MAX_AGE_MS }, now)).toBeDefined()
    for (const bad of [
      undefined, null, 'x', [], {},
      { ...good, schedules: 0, mcp: false },
      { ...good, schedules: -1 },
      { ...good, schedules: '3' },
      { ...good, mcp: 'yes' },
      { ...good, url: 'javascript:alert(1)' },
      { ...good, url: 7 },
      { ...good, seenAt: now + 60_000 },
      { ...good, seenAt: now - STANDING_HOST_MAX_AGE_MS - 1 },
      { ...good, seenAt: 'yesterday' },
      { ...good, extra: true },
    ]) expect(parseStoredStandingHost(bad, now), JSON.stringify(bad)).toBeUndefined()
  })
})

describe('which address a stored hint may be honoured for', () => {
  const loopback = (url: string): boolean => new URL(url).hostname === '127.0.0.1'
  const allowed = (hint: string, configured: string, remembered?: string): boolean =>
    hintAddressAllowed(hint, configured, remembered, loopback, '/ext/bridge')
  const local = 'ws://127.0.0.1:3080/ext/bridge'

  it('the configured address, exactly (a bare host matches its bridge path)', () => {
    expect(allowed('wss://bridge.example/ext/bridge', 'wss://bridge.example/ext/bridge')).toBe(true)
    expect(allowed('wss://bridge.example/ext/bridge', 'wss://bridge.example')).toBe(true)
    expect(allowed('wss://bridge.example/ext/bridge', 'wss://other.example/ext/bridge')).toBe(false)
    expect(allowed('ws://bridge.example/ext/bridge', 'wss://bridge.example/ext/bridge')).toBe(false)
    expect(allowed('wss://bridge.example:444/ext/bridge', 'wss://bridge.example/ext/bridge')).toBe(false)
    // A remembered address does not widen an explicit setting.
    expect(allowed(local, 'wss://bridge.example/ext/bridge', local)).toBe(false)
  })

  it('with no configured address, only the remembered loopback address', () => {
    expect(allowed(local, '', local)).toBe(true)
    expect(allowed(local, '', undefined)).toBe(false)
    expect(allowed(local, '', 'ws://127.0.0.1:3081/ext/bridge')).toBe(false)
    expect(allowed('ws://attacker.example/ext/bridge', '', 'ws://attacker.example/ext/bridge')).toBe(false)
    expect(normalizeBridgeUrl('not a url', '/ext/bridge')).toBe('not a url')
  })
})

describe('panel status', () => {
  it('reads the standing summary and ignores an empty or malformed one', () => {
    expect(parseStandingStatus({ watchers: 2, schedules: 1, mcp: true })).toEqual({ watchers: 2, schedules: 1, mcp: true })
    expect(parseStandingStatus({ watchers: 0, schedules: 0, mcp: false })).toBeUndefined()
    expect(parseStandingStatus({ watchers: 'two', schedules: -1, mcp: 'yes' })).toBeUndefined()
    expect(parseStandingStatus({ watchers: 1.5, mcp: true })).toEqual({ watchers: 0, schedules: 0, mcp: true })
    expect(parseStandingStatus(undefined)).toBeUndefined()
  })

  it('says what keeps the browser connected, in both languages', () => {
    expect(PANEL_COPY.en.settings.staysConnected({ watchers: 1, schedules: 2, mcp: true }))
      .toBe('Stays connected with the panel closed for: 1 page watcher, 2 workflow schedules, MCP clients')
    expect(PANEL_COPY.en.settings.staysConnected({ watchers: 3, schedules: 0, mcp: false }))
      .toBe('Stays connected with the panel closed for: 3 page watchers')
    expect(PANEL_COPY.zh.settings.staysConnected({ watchers: 1, schedules: 2, mcp: true }))
      .toBe('面板关闭后仍保持连接：1 个页面监视、2 个定时工作流、MCP 客户端')
  })
})

describe('a watcher hit while the bridge reconnects', () => {
  const PAGE = 'https://shop.example/item/42'
  const sender = { tabId: 7, url: PAGE, frameId: 0 }
  function memoryStorage(): WatchStorage {
    const data: Record<string, unknown> = {}
    return {
      get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
      set: async (items) => { Object.assign(data, structuredClone(items)) },
    }
  }
  async function hitSetup(overrides: Record<string, unknown> = {}) {
    const registry = new WatcherRegistry(memoryStorage())
    const watcher: PageWatcher = {
      id: 'w-1', sessionId: 's1', tabId: 7, origin: 'https://shop.example', url: PAGE,
      condition: { kind: 'text', text: 'In stock', gone: false }, prompt: 'Buy one', createdAt: 0,
      expiresAt: Date.now() + 3_600_000, maxFires: 3, fires: 0,
    }
    await registry.add(watcher)
    const order: string[] = []
    const fire = vi.fn(async () => { order.push('fire'); return { woken: true } })
    const state = { enabled: true, blocked: false }
    const connected = vi.fn(async () => { order.push('wait') })
    const deps = {
      registry, enabled: () => state.enabled, blocked: () => state.blocked, shareContent: () => true, fire, changed: vi.fn(), connected, ...overrides,
    }
    return { registry, fire, deps, state, connected, order }
  }

  it('waits for the connection before firing instead of recording a miss', async () => {
    const { deps, order, registry } = await hitSetup()
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'In stock' }, sender, deps)).toEqual({ accepted: true })
    expect(order).toEqual(['wait', 'fire'])
    expect(registry.get('w-1')).toMatchObject({ fires: 1 })
    expect(registry.get('w-1')).not.toHaveProperty('lastMiss')
  })

  it('still records a miss when the bridge did not come back in time', async () => {
    const { deps, registry } = await hitSetup({ fire: vi.fn(async () => { throw new Error('dsh is not connected') }) })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, deps)).toEqual({ accepted: false, reason: 'bridge' })
    expect(registry.get('w-1')).toMatchObject({ fires: 0, lastMiss: 'dsh is not connected' })
  })

  it('does not wait (or reconnect) for a hit that fails its checks', async () => {
    const { deps, connected, fire, state } = await hitSetup()
    expect(await handleWatchHit({ watchId: 'nope' }, sender, deps)).toMatchObject({ reason: 'unknown' })
    expect(await handleWatchHit({ watchId: 'w-1' }, { ...sender, tabId: 8 }, deps)).toMatchObject({ reason: 'wrong-tab' })
    expect(await handleWatchHit({ watchId: 'w-1' }, { ...sender, url: 'https://evil.example/' }, deps)).toMatchObject({ reason: 'other-origin' })
    state.enabled = false
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, deps)).toMatchObject({ reason: 'disabled' })
    state.enabled = true
    state.blocked = true
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, deps)).toMatchObject({ reason: 'paused' })
    expect(connected).not.toHaveBeenCalled()
    expect(fire).not.toHaveBeenCalled()
  })

  it('re-checks the switch, the setting, the watcher and site policy after the wait', async () => {
    const paused = await hitSetup()
    paused.connected.mockImplementation(async () => { paused.state.blocked = true })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, paused.deps)).toEqual({ accepted: false, reason: 'paused' })
    expect(paused.fire).not.toHaveBeenCalled()

    const disabled = await hitSetup()
    disabled.connected.mockImplementation(async () => { disabled.state.enabled = false })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, disabled.deps)).toEqual({ accepted: false, reason: 'disabled' })
    expect(disabled.fire).not.toHaveBeenCalled()

    const cancelled = await hitSetup()
    cancelled.connected.mockImplementation(async () => { await cancelled.registry.clear() })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, cancelled.deps)).toEqual({ accepted: false, reason: 'unknown' })
    expect(cancelled.fire).not.toHaveBeenCalled()

    // Site policy is evaluated after the wait too.
    let hidden = false
    const blockedSite = await hitSetup({ pageHidden: () => hidden })
    blockedSite.connected.mockImplementation(async () => { hidden = true })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, blockedSite.deps)).toEqual({ accepted: false, reason: 'blocked-site' })
    expect(blockedSite.fire).not.toHaveBeenCalled()
  })

  it('after the wait the tab is read again: another origin, a closed tab, or an expired watcher stops the fire', async () => {
    const moved = await hitSetup({ currentUrl: vi.fn(async () => 'https://bank.example/account') })
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'In stock' }, sender, moved.deps)).toEqual({ accepted: false, reason: 'other-origin' })
    expect(moved.fire).not.toHaveBeenCalled()

    const closed = await hitSetup({ currentUrl: vi.fn(async () => undefined) })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, closed.deps)).toEqual({ accepted: false, reason: 'tab-gone' })
    expect(closed.fire).not.toHaveBeenCalled()

    const unreadable = await hitSetup({ currentUrl: vi.fn(async () => { throw new Error('No tab with id 7') }) })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, unreadable.deps)).toEqual({ accepted: false, reason: 'tab-gone' })
    expect(unreadable.fire).not.toHaveBeenCalled()

    // The watcher's lifetime ends during the wait.
    let now = 1_000
    const registry = new WatcherRegistry(memoryStorage(), () => now)
    await registry.add({
      id: 'w-1', sessionId: 's1', tabId: 7, origin: 'https://shop.example', url: PAGE,
      condition: { kind: 'text', text: 'In stock', gone: false }, prompt: 'Buy one', createdAt: 0, expiresAt: 5_000, maxFires: 3, fires: 0,
    })
    const fire = vi.fn(async () => ({ woken: true }))
    const expired = {
      registry, enabled: () => true, blocked: () => false, shareContent: () => true, fire, changed: vi.fn(),
      connected: async () => { now = 6_000 }, currentUrl: async () => PAGE,
    }
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, expired)).toEqual({ accepted: false, reason: 'unknown' })
    expect(fire).not.toHaveBeenCalled()
  })

  it('site policy and the reported URL use the tab\'s address after the wait', async () => {
    const samePage = 'https://shop.example/item/42?step=2'
    const hidden = await hitSetup({ currentUrl: async () => samePage, pageHidden: (url: string) => url === samePage })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, hidden.deps)).toEqual({ accepted: false, reason: 'blocked-site' })
    expect(hidden.fire).not.toHaveBeenCalled()

    const fresh = await hitSetup({ currentUrl: async () => samePage })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, fresh.deps)).toEqual({ accepted: true })
    expect(fresh.fire).toHaveBeenCalledWith(expect.objectContaining({ url: samePage }))
  })

  it('a failing wait is not an error: the hit goes on to the usual outcome', async () => {
    const { deps, fire } = await hitSetup({ connected: vi.fn(async () => { throw new Error('boom') }) })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, deps)).toEqual({ accepted: true })
    expect(fire).toHaveBeenCalledTimes(1)
  })
})
