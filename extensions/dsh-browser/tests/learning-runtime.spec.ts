// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyFailure, fixtureAllowedFor, LearningRuntime, normalizeLearningSettings, rpcValue, type LearningDeps } from '../src/background/learning.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { ToolCall } from '../src/background/tools.ts'

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    area: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]))),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items) }),
    } as unknown as chrome.storage.StorageArea,
  }
}

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

  it('hands "Do the remaining N" to the bridge as one browser_run program, with no card of its own', async () => {
    const { learning, request } = runtime({}, { dshLearningSettings: { watchMe: true } })
    await learning.ready
    const program = [{ tool: 'browser_click' as const, args: { selector: '#people > tr:nth-child(3) button' } }]
    ;(learning as unknown as { suggestion: unknown }).suggestion = { tabId: 7, origin: 'https://crm.example', period: 1, done: 2, remaining: 1, program, labels: [] }
    await learning.runSuggestion('s1')
    expect(request).toHaveBeenCalledWith('bridge.learning.program.run', { sessionId: 's1', steps: program }, expect.any(Number))
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
    // Wrong origin, denied policy, refused card, HTTP error: all fall back to the UI.
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
})
