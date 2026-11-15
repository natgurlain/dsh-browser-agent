// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  createWatcher,
  handleWatchHit,
  manageWatchers,
  MAX_ACTIVE_WATCHERS,
  parseWatchCondition,
  parseWatchRequest,
  urlHits,
  armedFor,
  WATCHER_COOLDOWN_MS,
  WatcherRegistry,
  watchApprovalPrompt,
  WATCHERS_STORAGE_KEY,
  type PageWatcher,
  type WatchStorage,
} from '../src/background/watchers.ts'
import { evaluateCondition, PageWatchObserver } from '../src/content/watch.ts'
import { resolveApprovalGate } from '../src/background/authorization.ts'

function memoryStorage(initial: Record<string, unknown> = {}): WatchStorage & { data: Record<string, unknown> } {
  const data = { ...initial }
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => { Object.assign(data, structuredClone(items)) },
  }
}

const PAGE = 'https://shop.example/item/42'
const watcher = (extra: Partial<PageWatcher> = {}): PageWatcher => ({
  id: 'w-1', sessionId: 's1', tabId: 7, origin: 'https://shop.example', url: PAGE,
  condition: { kind: 'text', text: 'In stock', gone: false }, prompt: 'Buy one', createdAt: 0,
  expiresAt: Date.now() + 3_600_000, maxFires: 1, fires: 0, ...extra,
})

function toolDeps(registry: WatcherRegistry, overrides: Record<string, unknown> = {}) {
  return {
    registry,
    enabled: () => true,
    resolveTab: async () => ({ id: 7, url: PAGE, title: 'Item 42', windowId: 1 }),
    allowsTab: (tabId: number) => tabId === 7,
    getTab: async (tabId: number) => (tabId === 7 ? { id: 7, url: PAGE, windowId: 1 } : undefined),
    authorize: vi.fn(async () => 'approved' as const),
    arm: vi.fn(async () => {}),
    changed: vi.fn(),
    newId: () => 'abcdef1234',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('watch requests', () => {
  it('accepts exactly one condition kind and bounded lifetimes', () => {
    expect(parseWatchCondition({ selector: '.price', gone: true })).toEqual({ kind: 'selector', selector: '.price', gone: true })
    expect(parseWatchCondition({ networkRequest: '/api\\/cart/' })).toEqual({ kind: 'network', pattern: '/api\\/cart/' })
    expect(parseWatchCondition({ selector: 'a', text: 'b' })).toMatch(/exactly one/)
    expect(parseWatchCondition({ urlMatches: 'x', gone: true })).toMatch(/gone applies/)
    // An invalid /regex/ (or a path such as /api/cart) is matched as plain text.
    expect(parseWatchCondition({ urlMatches: '/(/' })).toEqual({ kind: 'url', pattern: '/(/' })
    expect(parseWatchRequest({ condition: { text: 'x' }, prompt: 'p', expiresInMinutes: 24 * 60 + 1 })).toMatch(/expiresInMinutes/)
    expect(parseWatchRequest({ condition: { text: 'x' }, prompt: '  ' })).toMatch(/prompt/)
    expect(parseWatchRequest({ condition: { text: 'x' }, prompt: 'p', maxFires: 11 })).toMatch(/maxFires/)
    expect(parseWatchRequest({ condition: { text: 'x' }, prompt: 'p' })).toMatchObject({ expiresInMinutes: 60, maxFires: 1 })
  })

  it('always asks: the card is forced and names the page, condition, and prompt', () => {
    const request = parseWatchRequest({ condition: { text: 'In stock' }, prompt: 'Buy one', expiresInMinutes: 120 })
    if (typeof request === 'string') throw new Error(request)
    const prompt = watchApprovalPrompt(request, { url: PAGE, origin: 'https://shop.example', title: 'Item 42' })
    expect(prompt).toMatchObject({ action: 'browser_watch', forced: true, perCallOnly: true, canTrust: false, origins: ['https://shop.example'] })
    expect(prompt.summary).toContain('"Item 42" (https://shop.example/item/42)')
    expect(prompt.summary).toContain('2 h')
    expect(prompt.details?.map((detail) => (detail as { value: string }).value)).toEqual(expect.arrayContaining([PAGE, 'text "In stock" appears', 'Buy one']))
    // Neither unrestricted access nor a trusted origin skips it.
    expect(resolveApprovalGate({ prompt, devToolsAllowed: true, devToolsSessionGrant: true, unrestrictedAccess: true, coveredByTrustedOrigins: true })).toBe('prompt')
  })
})

describe('WatcherRegistry', () => {
  it('persists across worker restarts and drops expired or spent watchers', async () => {
    let now = 1_000
    const storage = memoryStorage()
    const first = new WatcherRegistry(storage, () => now)
    await first.ready
    await first.add(watcher({ expiresAt: 10_000 }))
    await first.add(watcher({ id: 'w-2', expiresAt: 2_000 }))
    expect((storage.data[WATCHERS_STORAGE_KEY] as unknown[]).length).toBe(2)
    now = 5_000
    const restarted = new WatcherRegistry(storage, () => now)
    await restarted.ready
    expect(restarted.list().map((entry) => entry.id)).toEqual(['w-1'])
    await restarted.recordFire('w-1')
    expect(restarted.list()).toEqual([])
    const corrupt = new WatcherRegistry(memoryStorage({ [WATCHERS_STORAGE_KEY]: [{ id: 'x' }, 'junk'] }))
    await corrupt.ready
    expect(corrupt.list()).toEqual([])
  })

  it('rate-limits fires per watcher and globally', async () => {
    let now = 100_000
    const registry = new WatcherRegistry(memoryStorage(), () => now)
    await registry.ready
    const entry = watcher({ maxFires: 10 })
    await registry.add(entry)
    expect(registry.admitFire(entry)).toEqual({ ok: true })
    await registry.recordFire(entry.id)
    expect(registry.admitFire(registry.get(entry.id)!)).toEqual({ ok: false, reason: 'cooldown' })
    now += WATCHER_COOLDOWN_MS
    for (let index = 0; index < 4; index += 1) expect(registry.admitFire(watcher({ id: `g${String(index)}` }))).toEqual({ ok: true })
    expect(registry.admitFire(watcher({ id: 'g-over' }))).toEqual({ ok: false, reason: 'rate-limited' })
  })
})

describe('browser_watch / browser_watches', () => {
  it('refuses while the setting is off, without a session, or at the cap', async () => {
    const registry = new WatcherRegistry(memoryStorage())
    const call = { id: 'c', name: 'browser_watch', args: { condition: { text: 'In stock' }, prompt: 'Buy one' }, sessionId: 's1' }
    const off = toolDeps(registry, { enabled: () => false })
    expect(await createWatcher(call, off)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Allow the agent to watch pages/) } })
    expect(off.authorize).not.toHaveBeenCalled()
    expect(await createWatcher({ ...call, sessionId: undefined }, toolDeps(registry))).toMatchObject({ ok: false })
    for (let index = 0; index < MAX_ACTIVE_WATCHERS; index += 1) await registry.add(watcher({ id: `w${String(index)}` }))
    expect(await createWatcher(call, toolDeps(registry))).toMatchObject({ ok: false, error: { message: expect.stringMatching(/At most 10/) } })
  })

  it('records an approved watcher, arms its tab, and lists or cancels only the session\'s own', async () => {
    const registry = new WatcherRegistry(memoryStorage())
    const deps = toolDeps(registry)
    const answer = await createWatcher({ id: 'c', name: 'browser_watch', args: { condition: { selector: '.badge' }, prompt: 'Report it', maxFires: 2 }, sessionId: 's1' }, deps)
    expect(answer).toMatchObject({ ok: true, result: { watchId: 'w-abcdef12', expiresAt: expect.any(Number) } })
    expect(deps.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'browser_watch', forced: true }), 1)
    expect(deps.arm).toHaveBeenCalledWith(7)
    await registry.add(watcher({ id: 'w-other', sessionId: 's2' }))
    const listed = await manageWatchers({ id: 'l', name: 'browser_watches', args: {}, sessionId: 's1' }, deps)
    expect((listed as { result: { text: string } }).result.text).toContain('w-abcdef12')
    expect((listed as { result: { text: string } }).result.text).not.toContain('w-other')
    expect(await manageWatchers({ id: 'x', name: 'browser_watches', args: { action: 'cancel', id: 'w-other' }, sessionId: 's1' }, deps)).toMatchObject({ ok: false })
    expect(await manageWatchers({ id: 'x', name: 'browser_watches', args: { action: 'cancel', id: 'w-abcdef12' }, sessionId: 's1' }, deps)).toMatchObject({ ok: true })
    expect(registry.get('w-abcdef12')).toBeUndefined()
  })

  it('does not record a declined watcher or one on a tab the session does not control', async () => {
    const registry = new WatcherRegistry(memoryStorage())
    const declined = toolDeps(registry, { authorize: vi.fn(async () => 'denied' as const) })
    expect(await createWatcher({ id: 'c', name: 'browser_watch', args: { condition: { text: 'x' }, prompt: 'p' }, sessionId: 's1' }, declined))
      .toMatchObject({ ok: false, error: { message: 'The user declined the page watcher.' } })
    expect(await createWatcher({ id: 'c', name: 'browser_watch', args: { tabId: 99, condition: { text: 'x' }, prompt: 'p' }, sessionId: 's1' }, toolDeps(registry)))
      .toMatchObject({ ok: false, error: { message: expect.stringMatching(/not controlled by this session/) } })
    expect(registry.list()).toEqual([])
  })
})

describe('handleWatchHit', () => {
  async function setup(extra: Partial<PageWatcher> = {}, overrides: Record<string, unknown> = {}) {
    const registry = new WatcherRegistry(memoryStorage())
    await registry.add(watcher(extra))
    const fire = vi.fn(async () => ({ woken: true }))
    const deps = { registry, enabled: () => true, blocked: () => false, shareContent: () => true, fire, changed: vi.fn(), ...overrides }
    return { registry, fire, deps }
  }
  const sender = { tabId: 7, url: PAGE, frameId: 0 }

  it('asks the bridge to wake the owning session with a capped excerpt, then ends a single-fire watcher', async () => {
    const { registry, fire, deps } = await setup()
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'In stock '.repeat(100) }, sender, deps)).toEqual({ accepted: true })
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ watchId: 'w-1', sessionId: 's1', prompt: 'Buy one', condition: 'text "In stock" appears', fires: 1, maxFires: 1 }))
    expect(((fire.mock.calls[0] as unknown[])[0] as { matched: string }).matched.length).toBe(300)
    expect(registry.get('w-1')).toBeUndefined()
  })

  it('refuses reports from another tab, frame, or origin, while disabled or paused, and drops text when sharing is off', async () => {
    const { fire, deps } = await setup({ maxFires: 5 })
    expect(await handleWatchHit({ watchId: 'w-1' }, { ...sender, tabId: 8 }, deps)).toMatchObject({ accepted: false, reason: 'wrong-tab' })
    expect(await handleWatchHit({ watchId: 'w-1' }, { ...sender, frameId: 3 }, deps)).toMatchObject({ accepted: false, reason: 'wrong-tab' })
    expect(await handleWatchHit({ watchId: 'w-1' }, { ...sender, url: 'https://evil.example/' }, deps)).toMatchObject({ accepted: false, reason: 'other-origin' })
    expect(await handleWatchHit({ watchId: 'nope' }, sender, deps)).toMatchObject({ accepted: false, reason: 'unknown' })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, { ...deps, enabled: () => false })).toMatchObject({ accepted: false, reason: 'disabled' })
    expect(await handleWatchHit({ watchId: 'w-1' }, sender, { ...deps, blocked: () => true })).toMatchObject({ accepted: false, reason: 'paused' })
    expect(fire).not.toHaveBeenCalled()
    await handleWatchHit({ watchId: 'w-1', matched: 'secret page text' }, sender, { ...deps, shareContent: () => false })
    expect((fire.mock.calls[0] as unknown[])[0]).not.toHaveProperty('matched')
  })

  it('keeps the watcher and notes a missed wake when the session is not running', async () => {
    const { registry, deps } = await setup({}, { fire: vi.fn(async () => ({ woken: false, reason: 'not-running' })) })
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'x' }, sender, deps)).toEqual({ accepted: false, reason: 'not-running' })
    expect(registry.get('w-1')).toMatchObject({ fires: 0, lastMiss: 'not-running' })
  })

  it('lets URL watchers follow the tab to another site but only from the background', async () => {
    const { registry, deps } = await setup({ condition: { kind: 'url', pattern: '/checkout' } })
    expect(urlHits(registry, 7, 'https://pay.example/checkout').map((entry) => entry.id)).toEqual(['w-1'])
    expect(await handleWatchHit({ watchId: 'w-1' }, { ...sender, url: 'https://pay.example/checkout' }, deps)).toMatchObject({ reason: 'other-origin' })
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'https://pay.example/checkout' }, { tabId: 7, url: 'https://pay.example/checkout', frameId: undefined, urlWatcher: true }, deps))
      .toEqual({ accepted: true })
    expect(armedFor(registry, 7, PAGE)).toEqual([])
  })

  it('suspends URL, network and content watchers on a page site policy hides, without disclosing its URL', async () => {
    const hidden = (url: string) => url.startsWith('https://pay.example')
    const url = await setup({ condition: { kind: 'url', pattern: '/checkout' }, maxFires: 3 }, { pageHidden: hidden })
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'https://pay.example/checkout' }, { tabId: 7, url: 'https://pay.example/checkout', frameId: undefined, urlWatcher: true }, url.deps))
      .toEqual({ accepted: false, reason: 'blocked-site' })
    expect(url.fire).not.toHaveBeenCalled()
    expect(url.registry.get('w-1')).toMatchObject({ fires: 0, lastMiss: expect.stringMatching(/suspended/) })
    // A site blocked after approval suspends network and content watchers on the approved origin too.
    // A network match to a blocked third-party origin suspends too.
    const third = await setup({ condition: { kind: 'network', pattern: '/collect' }, maxFires: 3 }, { pageHidden: (u: string) => u.startsWith('https://tracker.example') })
    expect(await handleWatchHit({ watchId: 'w-1', matched: 'https://tracker.example/collect?x=1' }, sender, third.deps)).toEqual({ accepted: false, reason: 'blocked-site' })
    expect(third.fire).not.toHaveBeenCalled()
    for (const condition of [{ kind: 'network', pattern: '/api' }, { kind: 'text', text: 'x', gone: false }] as const) {
      const net = await setup({ condition, maxFires: 3 }, { pageHidden: () => true })
      expect(await handleWatchHit({ watchId: 'w-1', matched: 'https://shop.example/api' }, sender, net.deps)).toEqual({ accepted: false, reason: 'blocked-site' })
      expect(net.fire).not.toHaveBeenCalled()
    }
  })
})

describe('content observer', () => {
  it('evaluates selector, text, gone, and network conditions', () => {
    document.body.innerHTML = '<div class="price">Now $12</div><p>Only 2 left In Stock today</p>'
    expect(evaluateCondition({ kind: 'selector', selector: '.price', gone: false })).toEqual({ met: true, matched: 'Now $12' })
    expect(evaluateCondition({ kind: 'selector', selector: '.missing', gone: true })).toEqual({ met: true })
    expect(evaluateCondition({ kind: 'text', text: 'in stock', gone: false }).matched).toContain('In Stock')
    expect(evaluateCondition({ kind: 'text', text: 'sold out', gone: false })).toEqual({ met: false })
    expect(evaluateCondition({ kind: 'selector', selector: '[[bad', gone: false })).toEqual({ met: false, invalid: true })
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ name: 'https://shop.example/api/cart?id=1', startTime: 50 } as PerformanceEntry])
    expect(evaluateCondition({ kind: 'network', pattern: '/api/cart' }, 0)).toEqual({ met: true, matched: 'https://shop.example/api/cart?id=1' })
    expect(evaluateCondition({ kind: 'network', pattern: '/api/cart' }, 100)).toEqual({ met: false })
    vi.restoreAllMocks()
  })

  it('resolves selector watchers through the shadow-aware resolver, like browser_wait', () => {
    document.body.innerHTML = '<my-card></my-card>'
    const root = document.querySelector('my-card')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<span class="price">Now $9</span>'
    expect(evaluateCondition({ kind: 'selector', selector: 'my-card >>> .price', gone: false })).toEqual({ met: true, matched: 'Now $9' })
    expect(evaluateCondition({ kind: 'selector', selector: '.price', gone: false })).toEqual({ met: true, matched: 'Now $9' })
    expect(evaluateCondition({ kind: 'selector', selector: 'my-card >>> .price', gone: true })).toEqual({ met: false })
    root.innerHTML = ''
    expect(evaluateCondition({ kind: 'selector', selector: 'my-card >>> .price', gone: true })).toEqual({ met: true })
  })

  it('stops polling a watcher whose selector is invalid instead of never firing', () => {
    document.body.innerHTML = '<p>x</p>'
    const report = vi.fn(async () => ({ accepted: true }))
    const observer = new PageWatchObserver(report, () => 0)
    observer.arm([
      { id: 'bad', condition: { kind: 'selector', selector: '[[bad', gone: true } },
      { id: 'ok', condition: { kind: 'text', text: 'never', gone: false } },
    ])
    expect(observer.size).toBe(1)
    expect(report).not.toHaveBeenCalled()
    observer.stop()
  })

  it('reports once per transition, backs off after a refusal, and forgets a watcher the background rejects', async () => {
    document.body.innerHTML = '<p>waiting</p>'
    let now = 0
    const answers: Record<string, unknown>[] = []
    const report = vi.fn(async () => answers.shift() ?? { accepted: true })
    const observer = new PageWatchObserver(report, () => now)
    observer.arm([{ id: 'a', condition: { kind: 'text', text: 'ready', gone: false } }])
    expect(report).not.toHaveBeenCalled()
    document.body.innerHTML = '<p>ready</p>'
    answers.push({ accepted: false, reason: 'cooldown' })
    observer.check()
    await Promise.resolve()
    await Promise.resolve()
    expect(report).toHaveBeenCalledTimes(1)
    observer.check()
    expect(report).toHaveBeenCalledTimes(1)
    now += 30_001
    observer.check()
    await Promise.resolve()
    await Promise.resolve()
    expect(report).toHaveBeenCalledTimes(2)
    observer.check()
    expect(report).toHaveBeenCalledTimes(2)
    document.body.innerHTML = '<p>waiting</p>'
    observer.check()
    document.body.innerHTML = '<p>ready</p>'
    answers.push({ accepted: false, reason: 'other-origin' })
    observer.check()
    await Promise.resolve()
    await Promise.resolve()
    expect(report).toHaveBeenCalledTimes(3)
    expect(observer.size).toBe(0)
    observer.stop()
  })
})
