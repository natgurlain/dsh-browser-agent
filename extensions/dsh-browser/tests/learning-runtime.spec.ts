// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyFailure, fixtureAllowedFor, LearningRuntime, normalizeLearningSettings, rpcValue, type LearningDeps } from '../src/background/learning.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { ToolCall } from '../src/background/tools.ts'
import { memoryStorage } from './support/chrome.ts'

const fakeStorage = memoryStorage

let tabUrl = 'https://crm.example/new'
const sendMessage = vi.fn()

beforeEach(() => {
  tabUrl = 'https://crm.example/new'
  sendMessage.mockReset()
  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      sendMessage,
      get: vi.fn(async (id: number) => ({ id, url: tabUrl, windowId: 1, title: 'CRM' })),
    },
    permissions: { contains: vi.fn(async () => false) },
    storage: { local: fakeStorage().area },
  }
})

function runtime(overrides: Partial<LearningDeps> = {}, stored: Record<string, unknown> = {}) {
  const storage = fakeStorage(stored)
  const request = vi.fn(async (_method: string, _payload: unknown) => ({ type: 'server-response', result: { ok: true, value: { saved: true } } }))
  const deps: LearningDeps = {
    rpc: () => ({ request }),
    bridgeConnected: () => true,
    agentActiveOnTab: () => false,
    halted: () => false,
    fixtureAllowed: () => true,
    capturedRequests: () => undefined,
    siteDriversSupported: true,
    activeTab: async () => ({ id: 7 } as chrome.tabs.Tab),
    storage: storage.area,
    ...overrides,
  }
  return { learning: new LearningRuntime(deps), request, storage, deps }
}

const policy = () => ({ kind: 'default' as const })
const call = (name: string, args: Record<string, unknown>, id = crypto.randomUUID()): ToolCall => ({ id, name, args, sessionId: 's1' })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('learning runtime', () => {
  it('defaults every feature off and records nothing then', async () => {
    const { learning } = runtime()
    await learning.ready
    expect(learning.settings).toEqual({ workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false })
    const typed = call('browser_type', { index: 3, text: 'Ada' })
    learning.wrapPolicy(typed, { id: 7, url: tabUrl }, policy)!(typed, { reads: [], acts: [] })
    learning.recordResult(typed, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
    await flush()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(learning.stepsFor('s1')).toEqual([])
  })

  it('reports turning workflows off as an explicit event, resent after a disconnect, never on a plain connect', async () => {
    let connected = false
    const { learning, request, storage } = runtime({ bridgeConnected: () => connected }, { dshLearningSettings: { workflows: true } })
    await learning.ready
    await learning.updateSettings({ workflows: false })
    expect(request).not.toHaveBeenCalled()
    expect(storage.data.dshWorkflowsOffPending).toBe(true)
    connected = true
    await learning.pushBridgeState()
    expect(request).toHaveBeenLastCalledWith('bridge.learning.state', expect.objectContaining({ workflows: false, workflowsTurnedOff: true }))
    await learning.pushBridgeState()
    expect(request.mock.calls.at(-1)![1]).not.toHaveProperty('workflowsTurnedOff')
    expect(storage.data.dshWorkflowsOffPending).toBe(false)
  })

  it('never records keys pressed into a sensitive field (review finding 8)', async () => {
    const { learning } = runtime({}, { dshLearningSettings: { workflows: true } })
    await learning.ready
    let focused: Record<string, unknown> | undefined = { role: 'textbox', name: 'PIN', css: '#pin', sensitive: true, password: false }
    sendMessage.mockImplementation(async () => focused === undefined ? { ok: false } : { ok: true, result: focused })
    const press = async (key: string) => {
      const pressed = call('browser_press', { key })
      learning.wrapPolicy(pressed, { id: 7, url: tabUrl }, policy)!(pressed, { reads: [], acts: [] })
      learning.recordResult(pressed, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
      await flush()
      await flush()
    }
    for (const key of ['4', '2', 'Enter']) await press(key)
    expect(learning.stepsFor('s1')).toEqual([])
    // Unknown target: only named keys are kept.
    focused = undefined
    await press('7')
    await press('Enter')
    focused = { role: 'searchbox', name: 'Search', css: '#q', sensitive: false, password: false }
    await press('a')
    expect(learning.stepsFor('s1').map((step) => step.args.key)).toEqual(['Enter', 'a'])
    expect(learning.stepsFor('s1')[1]).not.toHaveProperty('locator')
  })

  it('records steps with locators, dropping values typed into sensitive fields', async () => {
    const { learning, request } = runtime({}, { dshLearningSettings: { workflows: true } })
    await learning.ready
    sendMessage.mockImplementation(async (_tab: number, message: { args: { index?: number } }) => ({
      ok: true,
      result: message.args.index === 1
        ? { role: 'textbox', name: 'Password', css: '#pw', sensitive: true, password: true }
        : { role: 'textbox', name: 'Name', css: '#name', sensitive: false, password: false },
    }))
    for (const [index, text] of [[1, 'hunter2'], [2, 'Ada']] as const) {
      const typed = call('browser_type', { index, text })
      learning.wrapPolicy(typed, { id: 7, url: tabUrl }, policy)!(typed, { reads: [], acts: [] })
      learning.recordResult(typed, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
    }
    // A blocked call is never probed.
    const blocked = call('browser_click', { index: 9 })
    learning.wrapPolicy(blocked, { id: 7, url: tabUrl }, () => ({ kind: 'deny', message: 'blocked' }))!(blocked, { reads: [], acts: [] })
    await flush()
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(2)
    const steps = learning.stepsFor('s1')
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ tool: 'browser_type', sensitive: true, locator: { role: 'textbox', name: 'Password', css: '#pw' } })
    expect(JSON.stringify(steps)).not.toContain('hunter2')
    expect(steps[1]!.args).toEqual({ text: 'Ada' })
    await learning.saveWorkflow('s1', { name: 'login' })
    const sent = request.mock.calls.find(([method]) => method === 'bridge.learning.workflow.save')![1] as { workflow: { steps: Array<{ args: Record<string, unknown> }> } }
    expect(sent.workflow.steps[0]!.args.text).toBe('{{password}}')
    expect(JSON.stringify(sent)).not.toContain('hunter2')
    // Turning the feature off forgets everything.
    await learning.updateSettings({ workflows: false })
    expect(learning.stepsFor('s1')).toEqual([])
  })

  it('probes once, before the action: the landed-page policy re-check of a navigating click is not re-probed (H1)', async () => {
    const { learning } = runtime({}, { dshLearningSettings: { workflows: true } })
    await learning.ready
    sendMessage.mockImplementation(async (_tab: number, message: { args: { index?: number } }) => message.args.index === 4
      ? { ok: true, result: { role: 'link', name: 'Next page', css: 'a.next' } }
      : { ok: false, error: { message: 'No element at that index' } })
    const click = call('browser_click', { index: 4 })
    const hook = learning.wrapPolicy(click, { id: 7, url: tabUrl }, policy)!
    hook(click, { reads: [], acts: [] })
    // tools.ts judges the page the click landed on with a snapshot-shaped copy of the call.
    hook({ ...click, name: 'browser_snapshot', args: {} }, { reads: [], acts: [] })
    // A second policy pass for the same call (content-script recovery) does not re-probe either.
    hook(click, { reads: [], acts: [] })
    learning.recordResult(click, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
    await flush()
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(learning.stepsFor('s1')).toEqual([expect.objectContaining({ tool: 'browser_click', locator: { role: 'link', name: 'Next page', css: 'a.next' } })])
  })

  it('hands "Do the remaining N" to the bridge as one browser_run program, with no card of its own', async () => {
    const { learning, request } = runtime({}, { dshLearningSettings: { watchMe: true } })
    await learning.ready
    const program = [{ tool: 'browser_click' as const, args: { selector: '#people > tr:nth-child(3) button' } }]
    ;(learning as unknown as { suggestion: unknown }).suggestion = { tabId: 7, origin: 'https://crm.example', period: 1, done: 2, remaining: 1, program, labels: [] }
    await learning.runSuggestion('s1')
    expect(request).toHaveBeenCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: program }, expect.any(Number))
    // A real click on the panel's offer: the bridge is told so, with the offer's own counts (nothing the page wrote).
    ;(learning as unknown as { suggestion: unknown }).suggestion = { tabId: 7, origin: 'https://crm.example', period: 1, done: 2, remaining: 1, program, labels: ['click "Approve all and send"'] }
    await learning.runSuggestion('s1', true)
    expect(request).toHaveBeenLastCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: program, userRequest: { kind: 'do-remaining', rows: 1, steps: 1 } }, expect.any(Number))
    expect(JSON.stringify(request.mock.calls.at(-1))).not.toContain('Approve all')
    tabUrl = 'https://other.example/'
    ;(learning as unknown as { suggestion: unknown }).suggestion = { tabId: 7, origin: 'https://crm.example', period: 1, done: 2, remaining: 1, program, labels: [] }
    await expect(learning.runSuggestion('s1')).rejects.toThrow(/left the page/)
  })

  it('runs a site driver only on its origin, behind a forced card with the exact request', async () => {
    const driver = { format: 'dsh-site-driver/v1', origin: 'https://crm.example', name: 'add', description: '', method: 'POST', path: '/api/add', body: { type: 'json', template: '{"name":"{{name}}"}' }, headers: { 'content-type': 'application/json' }, tokens: [{ header: 'x-csrf', source: { kind: 'meta', name: 'csrf-token' } }], params: [{ name: 'name' }] }
    const { learning } = runtime({}, { dshLearningSettings: { siteDrivers: true, siteDriverOrigins: ['https://crm.example'] }, dshSiteDrivers: [driver] })
    await learning.ready
    const prompts: ApprovalPrompt[] = []
    const authorize = vi.fn(async (prompt: ApprovalPrompt) => { prompts.push(prompt); return 'approved' as const })
    sendMessage.mockResolvedValue({ ok: true, result: { status: 200, ok: true, contentType: 'application/json', body: '{"id":1}' } })
    const answer = await learning.dispatchSiteDriver(call('browser_site_driver', { origin: driver.origin, driver: 'add', params: { name: 'Ada' } }), { id: 7, url: tabUrl }, policy, authorize, new AbortController().signal)
    expect(answer.ok).toBe(true)
    expect(prompts[0]).toMatchObject({ forced: true, perCallOnly: true, canTrust: false, action: 'browser_site_driver' })
    expect(JSON.stringify(prompts[0]!.details)).toContain('POST https://crm.example/api/add')
    expect(JSON.stringify(prompts[0]!.details)).toContain('x-csrf: <from page meta')
    expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'DSH_SITE_DRIVER_FETCH' }), { frameId: 0 })
    // Wrong origin, denied policy, HTTP error: all fall back to the UI (refused cards: next test).
    const off = await learning.dispatchSiteDriver(call('browser_site_driver', { origin: driver.origin, driver: 'add', params: { name: 'x' } }), { id: 7, url: 'https://other.example/' }, policy, authorize, new AbortController().signal)
    expect(off.error?.message).toMatch(/not on https:\/\/crm.example/)
    const denied = await learning.dispatchSiteDriver(call('browser_site_driver', { origin: driver.origin, driver: 'add', params: { name: 'x' } }), { id: 7, url: tabUrl }, () => ({ kind: 'deny', message: 'read-only site' }), authorize, new AbortController().signal)
    expect(denied.error?.message).toBe('read-only site')
    sendMessage.mockResolvedValue({ ok: true, result: { status: 403, ok: false, contentType: '', body: '' } })
    const stale = await learning.dispatchSiteDriver(call('browser_site_driver', { origin: driver.origin, driver: 'add', params: { name: 'x' } }), { id: 7, url: tabUrl }, policy, authorize, new AbortController().signal)
    expect(stale.error?.message).toMatch(/HTTP 403.*Fall back to the page UI/)
  })

  it('exports and re-imports drivers, refusing off-origin ones', async () => {
    const { learning } = runtime({}, { dshLearningSettings: { siteDrivers: true } })
    await learning.ready
    const good = { format: 'dsh-site-driver/v1', origin: 'https://a.example', name: 'go', description: '', method: 'GET', path: '/go', headers: {}, tokens: [], params: [] }
    expect(await learning.importDrivers(JSON.stringify({ format: 'dsh-site-drivers/v1', drivers: [good] }))).toBe(1)
    expect(JSON.parse(learning.exportDrivers()).drivers).toHaveLength(1)
    await expect(learning.importDrivers(JSON.stringify({ format: 'dsh-site-drivers/v1', drivers: [{ ...good, path: '//evil.example/x' }] }))).rejects.toThrow()
  })

  it('classifies failures for the flywheel and skips blocked or cancelled calls', () => {
    const fail = (message: string) => ({ ok: false, error: { code: 'action-failed' as const, message } })
    expect(classifyFailure(fail('No element matched selector: #x'), undefined, undefined, false)).toBe('not-found')
    // Denied or timed-out steps are never captured (review finding 5).
    expect(classifyFailure(fail('The user denied this action'), 'denied', undefined, false)).toBeUndefined()
    expect(classifyFailure(fail('Approval timed out'), 'timed-out', undefined, false)).toBeUndefined()
    expect(classifyFailure({ ok: false, error: { code: 'timeout', message: 'x' } }, undefined, undefined, false)).toBeUndefined()
    expect(classifyFailure(fail('The user declined the tab fleet.'), undefined, undefined, false)).toBeUndefined()
    expect(classifyFailure(fail('Click target is covered by #modal'), undefined, undefined, false)).toBe('guard')
    expect(classifyFailure(fail('boom'), undefined, undefined, true)).toBe('retried')
    expect(classifyFailure(fail('blocked'), undefined, 'blocked', false)).toBeUndefined()
    expect(classifyFailure(fail('Tool call was cancelled'), undefined, undefined, false)).toBeUndefined()
    // The approval outcome decides even when the message says nothing about it (M3).
    for (const decision of ['denied', 'timed-out', 'cancelled', 'unavailable']) expect(classifyFailure(fail('No element matched selector: #x'), decision, undefined, false)).toBeUndefined()
    expect(classifyFailure(fail('No element matched selector: #x'), 'allowed', undefined, false)).toBe('not-found')
    expect(normalizeLearningSettings({ siteDriverOrigins: ['https://a.example/path', 'nope'] }).siteDriverOrigins).toEqual(['https://a.example'])
    expect(rpcValue({ type: 'server-response', result: { ok: true, value: 3 } })).toBe(3)
  })

  it('accepts the panel port only from extension pages, never a content script (review finding 7)', async () => {
    const chromeGlobal = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome
    chromeGlobal.runtime = { id: 'ext', getURL: (path: string) => `chrome-extension://ext/${path}` }
    const { learning } = runtime()
    const port = (url: string) => ({
      name: 'dsh-learning',
      sender: { id: 'ext', url },
      disconnect: vi.fn(),
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
    })
    const content = port('https://evil.example/page')
    expect(learning.connect(content as unknown as chrome.runtime.Port)).toBe(true)
    expect(content.disconnect).toHaveBeenCalled()
    expect(content.onMessage.addListener).not.toHaveBeenCalled()
    const panel = port('chrome-extension://ext/panel/index.html')
    expect(learning.connect(panel as unknown as chrome.runtime.Port)).toBe(true)
    expect(panel.disconnect).not.toHaveBeenCalled()
    expect(panel.onMessage.addListener).toHaveBeenCalled()
  })

  it('captures fixtures only with sharing auto and a non-force, non-deny policy for the page', () => {
    const url = 'https://shop.example/cart'
    expect(fixtureAllowedFor('auto', () => 'default', url)).toBe(true)
    expect(fixtureAllowedFor('auto', () => 'trust', url)).toBe(true)
    expect(fixtureAllowedFor('ask', () => 'default', url)).toBe(false)
    expect(fixtureAllowedFor('off', () => 'trust', url)).toBe(false)
    expect(fixtureAllowedFor('auto', () => 'force', url)).toBe(false)
    expect(fixtureAllowedFor('auto', () => 'deny', url)).toBe(false)
    expect(fixtureAllowedFor('auto', () => 'default', 'chrome://settings')).toBe(false)
  })

  it('saves a fixture through the bridge with a sanitized DOM when the page has sensitive fields', async () => {
    const { learning, request } = runtime({}, { dshLearningSettings: { fixtures: true } })
    await learning.ready
    sendMessage.mockImplementation(async (_tab: number, message: { probe?: boolean }) => message.probe === true
      ? { ok: true, result: { sensitiveCount: 1 } }
      : { ok: true, result: { html: '<html>masked</html>' } })
    learning.recordResult(call('browser_click', { selector: '#gone' }), { ok: false, error: { code: 'action-failed', message: 'No element matched selector: #gone' } }, { tabId: 7, url: tabUrl })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledWith('bridge.learning.fixture.save', expect.anything(), 60_000) })
    const payload = request.mock.calls.find(([method]) => method === 'bridge.learning.fixture.save')![1] as { fixture: { page: { kind: string }; failure: string } }
    expect(payload.fixture).toMatchObject({ failure: 'not-found', page: { kind: 'dom' } })
  })

  it('never captures a fixture where page sharing is off or reads are blocked', async () => {
    const { learning, request } = runtime({ fixtureAllowed: () => false }, { dshLearningSettings: { fixtures: true } })
    await learning.ready
    learning.recordResult(call('browser_click', { selector: '#gone' }), { ok: false, error: { code: 'action-failed', message: 'No element matched selector: #gone' } }, { tabId: 7, url: tabUrl })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([method]) => method === 'bridge.learning.fixture.save')).toBe(false)
  })

  it('ignores watch events while the agent is acting on the tab', async () => {
    const { learning } = runtime({ agentActiveOnTab: () => true }, { dshLearningSettings: { watchMe: true } })
    await learning.ready
    sendMessage.mockResolvedValue({ ok: true })
    await learning.startWatching(7)
    await learning.onWatchEvent(7, 0, { kind: 'click', css: '#a' })
    expect((learning.snapshot().watching as { events: number }).events).toBe(0)
  })

  it('tells only the watched tab top frame on the same origin to resume Watch me after a navigation', async () => {
    const { learning } = runtime({}, { dshLearningSettings: { watchMe: true } })
    await learning.ready
    sendMessage.mockResolvedValue({ ok: true })
    expect(learning.watchMeReady(7, 0, 'https://crm.example/next')).toBe(false)
    await learning.startWatching(7)
    expect(learning.watchMeReady(7, 0, 'https://crm.example/next')).toBe(true)
    expect(learning.watchMeReady(7, 3, 'https://crm.example/next')).toBe(false)
    expect(learning.watchMeReady(8, 0, 'https://crm.example/next')).toBe(false)
    expect(learning.watchMeReady(7, 0, 'https://elsewhere.example/')).toBe(false)
    await learning.stopWatching()
    expect(learning.watchMeReady(7, 0, 'https://crm.example/next')).toBe(false)
  })

  it('tells a tab still recording for a forgotten Watch me (worker restart) to stop, once per tab (M1)', async () => {
    let now = 10_000
    const { learning } = runtime({ now: () => now }, { dshLearningSettings: { watchMe: true } })
    await learning.ready
    sendMessage.mockResolvedValue({ ok: true })
    await learning.onWatchEvent(7, 0, { kind: 'click', css: '#a' })
    await learning.onWatchEvent(7, 0, { kind: 'click', css: '#b' })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'DSH_WATCH', enabled: false }, { frameId: 0 })
    now += 60_000
    await learning.onWatchEvent(7, 0, { kind: 'click', css: '#c' })
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  describe('site driver approval (G5)', () => {
    const driver = { format: 'dsh-site-driver/v1', origin: 'https://crm.example', name: 'add', description: '', method: 'POST', path: '/api/add', body: { type: 'json', template: '{"name":"{{name}}"}' }, headers: { 'content-type': 'application/json' }, tokens: [], params: [{ name: 'name' }] }
    const driverCall = () => call('browser_site_driver', { origin: driver.origin, driver: 'add', params: { name: 'Ada' } })
    const fetched = () => sendMessage.mock.calls.some(([, message]) => (message as { type?: string }).type === 'DSH_SITE_DRIVER_FETCH')

    async function ready() {
      const { learning } = runtime({}, { dshLearningSettings: { siteDrivers: true, siteDriverOrigins: [driver.origin] }, dshSiteDrivers: [driver] })
      await learning.ready
      sendMessage.mockResolvedValue({ ok: true, result: { status: 200, ok: true, contentType: 'application/json', body: '{}' } })
      return learning
    }

    it.each(['denied', 'timed-out', 'unavailable'] as const)('sends nothing when the card is %s', async (authorization) => {
      const learning = await ready()
      const answer = await learning.dispatchSiteDriver(driverCall(), { id: 7, url: tabUrl }, policy, async () => authorization, new AbortController().signal)
      expect(answer.ok).toBe(false)
      expect(answer.error?.message).toContain(authorization)
      expect(fetched()).toBe(false)
    })

    it('sends nothing when the tab left the origin while the card waited', async () => {
      const learning = await ready()
      const answer = await learning.dispatchSiteDriver(driverCall(), { id: 7, url: tabUrl }, policy, async () => {
        tabUrl = 'https://evil.example/'
        return 'approved'
      }, new AbortController().signal)
      expect(answer.error?.message).toMatch(/left https:\/\/crm.example/)
      expect(fetched()).toBe(false)
    })

    it('sends nothing when the call was cancelled while the card waited', async () => {
      const learning = await ready()
      const controller = new AbortController()
      const answer = await learning.dispatchSiteDriver(driverCall(), { id: 7, url: tabUrl }, policy, async () => {
        controller.abort()
        return 'approved'
      }, controller.signal)
      expect(answer.error?.message).toBe('Tool call was cancelled')
      expect(fetched()).toBe(false)
    })
  })

  it('captures nothing while the kill switch is engaged or the agent is paused (G6)', async () => {
    const { learning, request } = runtime({ halted: () => true }, { dshLearningSettings: { workflows: true, fixtures: true } })
    await learning.ready
    sendMessage.mockResolvedValue({ ok: true, result: { role: 'button', name: 'Save', css: '#save' } })
    const click = call('browser_click', { index: 1 })
    learning.wrapPolicy(click, { id: 7, url: tabUrl }, policy)!(click, { reads: [], acts: [] })
    learning.recordResult(click, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
    learning.recordResult(call('browser_click', { selector: '#gone' }), { ok: false, error: { code: 'action-failed', message: 'No element matched selector: #gone' } }, { tabId: 7, url: tabUrl })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sendMessage).not.toHaveBeenCalled()
    expect(learning.stepsFor('s1')).toEqual([])
    expect(request.mock.calls.some(([method]) => method === 'bridge.learning.fixture.save')).toBe(false)
  })

  describe('Watch me switch (G7)', () => {
    it('refuses to watch or run a suggestion while the switch is off', async () => {
      const { learning, request } = runtime()
      await learning.ready
      await expect(learning.startWatching(7)).rejects.toThrow(/turned off/)
      ;(learning as unknown as { suggestion: unknown }).suggestion = { tabId: 7, origin: 'https://crm.example', period: 1, done: 2, remaining: 1, program: [{ tool: 'browser_click', args: { selector: '#x' } }], labels: [] }
      await expect(learning.runSuggestion('s1')).rejects.toThrow()
      expect(sendMessage).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    })

    it('turning the switch off stops the page recorder', async () => {
      const { learning } = runtime({}, { dshLearningSettings: { watchMe: true } })
      await learning.ready
      sendMessage.mockResolvedValue({ ok: true })
      await learning.startWatching(7)
      expect(sendMessage).toHaveBeenLastCalledWith(7, { type: 'DSH_WATCH', enabled: true }, { frameId: 0 })
      await learning.updateSettings({ watchMe: false })
      expect(sendMessage).toHaveBeenLastCalledWith(7, { type: 'DSH_WATCH', enabled: false }, { frameId: 0 })
      expect(learning.snapshot().watching).toBeNull()
    })
  })

  describe('fixture page kind (G8)', () => {
    function withPageCapture(frames: number) {
      const chromeGlobal = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome
      const saveAsMHTML = vi.fn(async () => ({ text: async () => 'MHTML' }) as unknown as Blob)
      chromeGlobal.pageCapture = { saveAsMHTML }
      chromeGlobal.permissions = { contains: vi.fn(async () => true) }
      chromeGlobal.webNavigation = {
        getAllFrames: vi.fn(async () => Array.from({ length: frames }, (_, index) => ({ frameId: index, parentFrameId: index - 1, url: tabUrl, documentId: `d${String(index)}` }))),
      }
      return saveAsMHTML
    }

    async function captured(sensitiveCount: number): Promise<string> {
      const { learning, request } = runtime({}, { dshLearningSettings: { fixtures: true } })
      await learning.ready
      sendMessage.mockImplementation(async (_tab: number, message: { probe?: boolean }) => message.probe === true
        ? { ok: true, result: { sensitiveCount } }
        : { ok: true, result: { html: '<html>masked</html>' } })
      learning.recordResult(call('browser_click', { selector: '#gone' }), { ok: false, error: { code: 'action-failed', message: 'No element matched selector: #gone' } }, { tabId: 7, url: tabUrl })
      await vi.waitFor(() => { expect(request).toHaveBeenCalledWith('bridge.learning.fixture.save', expect.anything(), 60_000) })
      const payload = request.mock.calls.find(([method]) => method === 'bridge.learning.fixture.save')![1] as { fixture: { page: { kind: string } } }
      return payload.fixture.page.kind
    }

    it('uses MHTML only for a single-frame page with no sensitive field', async () => {
      const save = withPageCapture(1)
      expect(await captured(0)).toBe('mhtml')
      expect(save).toHaveBeenCalledWith({ tabId: 7 })
    })

    it('falls back to the sanitized DOM when a sensitive field is present', async () => {
      const save = withPageCapture(1)
      expect(await captured(1)).toBe('dom')
      expect(save).not.toHaveBeenCalled()
    })

    it('falls back to the sanitized DOM when the page has several frames', async () => {
      const save = withPageCapture(2)
      expect(await captured(0)).toBe('dom')
      expect(save).not.toHaveBeenCalled()
    })
  })

  it('forgets the probe of a call whose dispatch threw (M9)', async () => {
    const { learning } = runtime({}, { dshLearningSettings: { workflows: true } })
    await learning.ready
    sendMessage.mockResolvedValue({ ok: true, result: { role: 'button', name: 'Save', css: '#save' } })
    const click = call('browser_click', { index: 1 })
    learning.wrapPolicy(click, { id: 7, url: tabUrl }, policy)!(click, { reads: [], acts: [] })
    learning.forgetCall(click.id)
    // A late result for the same id finds no probe: no locator, so no element step.
    learning.recordResult(click, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
    await flush()
    expect(learning.stepsFor('s1')).toEqual([])
  })

  it('a closed tab takes its pending probes with it (M9)', async () => {
    const { learning } = runtime({}, { dshLearningSettings: { workflows: true } })
    await learning.ready
    sendMessage.mockResolvedValue({ ok: true, result: { role: 'button', name: 'Save', css: '#save' } })
    const click = call('browser_click', { index: 1 })
    learning.wrapPolicy(click, { id: 7, url: tabUrl }, policy)!(click, { reads: [], acts: [] })
    learning.forgetTab(7)
    learning.recordResult(click, { ok: true, result: { text: 'ok' } }, { tabId: 7, url: tabUrl })
    await flush()
    expect(learning.stepsFor('s1')).toEqual([])
  })
})

