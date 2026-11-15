// @vitest-environment jsdom
/**
 * Taint exemptions (security/taint-exempt.ts, policy-runtime.ts): the user's
 * own local pages and sites the user explicitly trusts do not taint a
 * session. Everything else taints as before, and the exemption never changes
 * where a tainted session's data may go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyRuntime, POLICY_PORT_NAME, type PolicySettings, type TabProvenance } from '../src/background/policy-runtime.ts'
import { callPolicyTargets, tabProvenanceOf } from '../src/background/authorization.ts'
import { parseManagedPolicy, type ManagedPolicy } from '../src/security/managed-policy.ts'
import type { SiteRuleEntry } from '../src/security/site-policy.ts'
import { MAX_EXEMPT_READS, taintForcedReasons, UNKNOWN_SOURCE } from '../src/security/taint.ts'
import { allTaintExempt, isLoopbackPageOrigin, NO_TAINT_EXEMPTION, originTaintExempt, trustPatternFor, userTrustsOrigin, type TaintExemptionConfig } from '../src/security/taint-exempt.ts'
import { memoryStorage } from './support/chrome.ts'

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getURL: (path: string) => `chrome-extension://ext/${path}` },
    storage: {},
  } as unknown as typeof chrome)
})
afterEach(() => { vi.unstubAllGlobals() })

const LOCAL = 'http://localhost:3000'
const LOCAL_IP = 'http://127.0.0.1:5173'
const EVIL = 'https://evil.example'
const TRUSTED = 'https://seraph.quest'
const ALWAYS = 'https://tickets.corp.example'

interface Harness {
  policy: PolicyRuntime
  settings: PolicySettings
  clearBridgeTaint: ReturnType<typeof vi.fn>
  saved: SiteRuleEntry[][]
  /** Blanket "unrestricted browser access". */
  unrestricted: { on: boolean }
}

function harness(overrides: Partial<PolicySettings> = {}, managed?: ManagedPolicy): Harness {
  const settings: PolicySettings = {
    siteRules: [{ pattern: 'seraph.quest', rule: 'trusted' }],
    siteDefaultsEnabled: true,
    trustedActionOrigins: [ALWAYS],
    taintExemptLocalPages: true,
    taintExemptTrustedSites: true,
    ...overrides,
  }
  const clearBridgeTaint = vi.fn(async () => {})
  const saved: SiteRuleEntry[][] = []
  const unrestricted = { on: false }
  const policy = new PolicyRuntime({
    settings: () => settings,
    unrestricted: () => unrestricted.on,
    clearBridgeTaint,
    saveSiteRules: async (rules) => {
      saved.push(rules)
      settings.siteRules = rules
    },
  })
  if (managed !== undefined) policy.setManaged(managed)
  return { policy, settings, clearBridgeTaint, saved, unrestricted }
}

let callSeq = 0

/** One page read: the policy hook sees `targets`, then the result is recorded. */
function read(h: Harness, sessionId: string, origins: string[], extra: { name?: string; pageOrigin?: string; after?: TabProvenance } = {}) {
  const id = `call-${callSeq += 1}`
  const name = extra.name ?? 'browser_snapshot'
  const call = { id, name, args: {}, sessionId }
  h.policy.hook(id, sessionId, h.unrestricted.on)(call, { reads: origins, acts: [], pageOrigin: extra.pageOrigin ?? origins[0]! })
  return h.policy.recordResult(call, true, undefined, extra.after)
}

function navigate(h: Harness, sessionId: string, url: string) {
  const id = `call-${callSeq += 1}`
  const call = { id, name: 'browser_navigate', args: { url }, sessionId }
  const decision = h.policy.hook(id, sessionId, h.unrestricted.on)(call, { reads: [], acts: [], destination: url })
  return { decision, call }
}

describe('what counts as a local page', () => {
  it('is the real connection target: localhost, *.localhost, 127.0.0.1, [::1], on any port', () => {
    for (const origin of [LOCAL, LOCAL_IP, 'http://localhost', 'https://localhost:8443', 'http://[::1]:8080', 'http://app.localhost:3000']) {
      expect(isLoopbackPageOrigin(origin), origin).toBe(true)
    }
  })

  it.each([
    'http://localhost.evil.com', 'http://localhost.evil.com:3000', 'http://127.0.0.1.nip.io', 'http://127.0.0.1.evil.example:5173',
    'http://localhost@evil.example', 'http://evil.example/localhost', 'http://evil.example#localhost', 'http://xlocalhost',
    'http://localhost.', 'http://127.0.0.2', 'http://0.0.0.0', 'http://10.0.0.1', 'file:///home/me/page.html', 'null', UNKNOWN_SOURCE, '',
  ])('%s is not loopback', (origin) => {
    expect(isLoopbackPageOrigin(origin)).toBe(false)
  })
})

describe('what counts as a site the user trusts', () => {
  const config = (overrides: Partial<TaintExemptionConfig> = {}): TaintExemptionConfig => ({
    localPages: true,
    trustedSites: true,
    site: { managed: [], user: [{ pattern: 'seraph.quest', rule: 'trusted' }], defaultsEnabled: true, defaultTrusted: false },
    trustedActionOrigins: [ALWAYS, 'https://*.wiki.example'],
    ...overrides,
  })

  it('a user `trusted` site rule and an always-allowed origin both count', () => {
    expect(userTrustsOrigin(TRUSTED, config())).toBe(true)
    expect(userTrustsOrigin('https://app.seraph.quest', config())).toBe(true)
    expect(userTrustsOrigin(ALWAYS, config())).toBe(true)
    expect(userTrustsOrigin('https://docs.wiki.example', config())).toBe(true)
    // Always-allowed origins stay scoped to their scheme and port.
    expect(userTrustsOrigin('http://tickets.corp.example', config())).toBe(false)
    expect(userTrustsOrigin(EVIL, config())).toBe(false)
    expect(userTrustsOrigin('https://seraph.quest.evil.example', config())).toBe(false)
  })

  it('the blanket unrestricted switch is not a choice about any site', () => {
    const blanket = config({ site: { managed: [], user: [], defaultsEnabled: true, defaultTrusted: true }, trustedActionOrigins: [] })
    expect(userTrustsOrigin(EVIL, blanket)).toBe(false)
    expect(originTaintExempt(EVIL, blanket)).toBe(false)
  })

  it('a stricter rule from any layer wins, and an administrator rule is not the user\'s choice', () => {
    expect(userTrustsOrigin(TRUSTED, config({ site: { managed: [{ pattern: 'seraph.quest', rule: 'ask' }], user: [{ pattern: 'seraph.quest', rule: 'trusted' }], defaultsEnabled: true, defaultTrusted: false } }))).toBe(false)
    expect(userTrustsOrigin(ALWAYS, config({ site: { managed: [], user: [{ pattern: 'tickets.corp.example', rule: 'read-only' }], defaultsEnabled: true, defaultTrusted: false } }))).toBe(false)
    expect(userTrustsOrigin('https://intranet.example', config({ site: { managed: [{ pattern: 'intranet.example', rule: 'trusted' }], user: [], defaultsEnabled: true, defaultTrusted: false } }))).toBe(false)
    // A built-in read-only default (a bank) is not lifted by an always-allowed entry.
    expect(userTrustsOrigin('https://paypal.com', config({ trustedActionOrigins: ['https://paypal.com'] }))).toBe(false)
  })

  it('a path-scoped trusted rule does not make the whole origin trusted', () => {
    expect(userTrustsOrigin('https://github.com', config({ site: { managed: [], user: [{ pattern: 'github.com/myorg', rule: 'trusted' }], defaultsEnabled: false, defaultTrusted: false } }))).toBe(false)
  })

  it('needs at least one origin, and an unknown source is never exempt', () => {
    expect(allTaintExempt([], config())).toBe(false)
    expect(allTaintExempt([LOCAL, TRUSTED, ALWAYS], config())).toBe(true)
    expect(allTaintExempt([LOCAL, UNKNOWN_SOURCE], config())).toBe(false)
    expect(allTaintExempt([LOCAL, EVIL], config())).toBe(false)
    expect(allTaintExempt([LOCAL], NO_TAINT_EXEMPTION)).toBe(false)
  })
})

describe('local pages do not taint', () => {
  it('a session that only read loopback pages stays untainted and gets no forced card', () => {
    const h = harness()
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: true })
    expect(read(h, 's1', [LOCAL_IP])).toEqual({ exempt: true })
    expect(h.policy.get('s1')).toBeUndefined()
    const clipboard = { id: 'c', name: 'browser_clipboard', args: { action: 'write', text: 'x' }, sessionId: 's1' }
    expect(h.policy.evaluate(clipboard, { reads: [], acts: [] }).kind).not.toBe('force')
    expect(navigate(h, 's1', 'https://other.example/c?k=sk-canary-800b3920a5708f56').decision.kind).not.toBe('force')
  })

  it('loopback then external: tainted, and the earlier local pages are sources too', () => {
    const h = harness()
    read(h, 's1', [LOCAL])
    expect(read(h, 's1', [EVIL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([LOCAL, EVIL].sort())
    // The attacker page is not the "only source": typing what the local page showed into it still asks.
    const typing = { id: 't', name: 'browser_type', args: { text: 'x' }, sessionId: 's1' }
    expect(h.policy.evaluate(typing, { reads: [], acts: [EVIL], typeTargetOrigin: EVIL }).kind).toBe('force')
  })

  it('external then loopback: still tainted, and the bridge is not told otherwise', () => {
    const h = harness()
    read(h, 's1', [EVIL])
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
  })

  it.each(['http://localhost.evil.com:3000', 'http://127.0.0.1.nip.io', 'http://localhost.attacker.test:8080'])('a look-alike host taints: %s', (origin) => {
    const h = harness()
    expect(read(h, 's1', [origin])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([origin])
  })

  it('a loopback page whose cross-origin frame was included taints', () => {
    const h = harness()
    const frames = [
      { frameId: 0, parentFrameId: -1, url: `${LOCAL}/` },
      { frameId: 4, parentFrameId: 0, url: `${EVIL}/widget` },
    ]
    // The real target computation: a whole-tab read names every frame.
    const snapshot = { id: 'snap', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    h.policy.hook('snap', 's1', false)(snapshot, callPolicyTargets(snapshot, frames))
    expect(h.policy.recordResult(snapshot, true, LOCAL, tabProvenanceOf(frames))).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
    // Reading only the top frame of the same page stays exempt...
    const text = { id: 'text', name: 'browser_get_text', args: {}, sessionId: 's2' }
    h.policy.hook('text', 's2', false)(text, callPolicyTargets(text, frames))
    expect(h.policy.recordResult(text, true, LOCAL, tabProvenanceOf(frames))).toEqual({ exempt: true })
    // ...and reading the embedded frame itself does not.
    const inner = { id: 'inner', name: 'browser_get_text', args: { frame: 4 }, sessionId: 's3' }
    h.policy.hook('inner', 's3', false)(inner, callPolicyTargets(inner, frames))
    expect(h.policy.recordResult(inner, true, LOCAL, tabProvenanceOf(frames))).toEqual({ exempt: false })
  })

  it('a loopback frame inside an external page taints (the top page counts)', () => {
    const h = harness()
    expect(read(h, 's1', [LOCAL], { name: 'browser_get_text', pageOrigin: EVIL })).toEqual({ exempt: false })
  })

  it('a call that never named its frame is exempt only when every frame in the tab is', () => {
    const h = harness()
    const failed = (id: string, sessionId: string, after?: TabProvenance) => h.policy.recordResult({ id, name: 'browser_click', sessionId }, false, LOCAL, after)
    // No frame provenance at all: taints.
    expect(failed('f1', 's1')).toEqual({ exempt: false })
    // An error can quote any frame (an open dialog's text): a cross-origin frame taints.
    expect(failed('f2', 's2', { top: LOCAL, frames: [LOCAL, EVIL], opaque: false })).toEqual({ exempt: false })
    expect(failed('f3', 's3', { top: LOCAL, frames: [LOCAL], opaque: false })).toEqual({ exempt: true })
    expect(h.policy.get('s3')).toBeUndefined()
    // browser_dialog answers a dialog any frame may have opened.
    const dialog = { id: 'd', name: 'browser_dialog', args: { accept: true }, sessionId: 's4' }
    h.policy.hook('d', 's4', false)(dialog, { reads: [], acts: [LOCAL], pageOrigin: LOCAL })
    expect(h.policy.recordResult(dialog, true, LOCAL, { top: LOCAL, frames: [LOCAL, EVIL], opaque: false })).toEqual({ exempt: false })
  })

  it('a navigation the call or the page caused meanwhile counts: the tab now shows an external page', () => {
    const h = harness()
    expect(read(h, 's1', [LOCAL], { name: 'browser_click', after: { top: EVIL, frames: [EVIL], opaque: false } })).toEqual({ exempt: false })
    // A navigation is judged on the page it landed on (a redirect off the local server).
    const call = { id: 'nav', name: 'browser_navigate', args: { url: `${LOCAL}/go` }, sessionId: 's2' }
    const hook = h.policy.hook('nav', 's2', false)
    hook(call, { reads: [], acts: [], destination: `${LOCAL}/go` })
    hook({ ...call, name: 'browser_snapshot', args: {} }, { reads: [EVIL], acts: [], pageOrigin: EVIL })
    expect(h.policy.recordResult(call, true, LOCAL)).toEqual({ exempt: false })
    expect(h.policy.get('s2')).toBeDefined()
  })

  it('content of unknown source always taints: no origin, a non-web destination, host lineage, an attachment without a URL', () => {
    const h = harness()
    // A result with no origin at all (a tool this layer has no provenance for).
    expect(h.policy.recordResult({ id: 'x1', name: 'browser_run', sessionId: 's1' }, true)).toEqual({ exempt: false })
    expect(h.policy.get('s1')).toBeDefined()
    const { call } = navigate(h, 's2', 'about:blank')
    expect(h.policy.recordResult(call, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false })).toEqual({ exempt: false })
    h.policy.markHostTaint('s3')
    expect(h.policy.get('s3')?.sources).toEqual([UNKNOWN_SOURCE])
    expect(read(h, 's3', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.recordSelection('s4', undefined)).toEqual({ exempt: false })
    expect(h.policy.get('s4')?.sources).toEqual([UNKNOWN_SOURCE])
    // The list of past downloads names other sites, whatever the tab shows.
    const downloads = { id: 'dl', name: 'browser_downloads', args: {}, sessionId: 's5' }
    h.policy.hook('dl', 's5', false)(downloads, { reads: [], acts: [], pageOrigin: LOCAL })
    expect(h.policy.recordResult(downloads, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false })).toEqual({ exempt: false })
  })

  it('selections and injected snapshots follow the same rule', () => {
    const h = harness()
    expect(h.policy.recordSelection('s1', LOCAL)).toEqual({ exempt: true })
    expect(h.policy.get('s1')).toBeUndefined()
    expect(h.policy.recordSelection('s1', EVIL)).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
    // An injection without frame provenance always taints.
    expect(h.policy.recordInjection('s2', LOCAL)).toEqual({ exempt: false })
    expect(h.policy.injectionExempt('s3', LOCAL, [LOCAL])).toBe(true)
    expect(h.policy.recordInjection('s3', LOCAL, [LOCAL])).toEqual({ exempt: true })
    expect(h.policy.injectionExempt('s3', LOCAL, [LOCAL, EVIL])).toBe(false)
    expect(h.policy.injectionExempt('s3', undefined, [LOCAL])).toBe(false)
    expect(h.policy.injectionExempt('s3', LOCAL, [])).toBe(false)
    expect(h.policy.recordInjection('s3', LOCAL, [LOCAL, EVIL])).toEqual({ exempt: false })
    expect(h.policy.injectionExempt('s3', LOCAL, [LOCAL])).toBe(false) // tainted now
    // The evaluator that collects a snapshot's frames.
    const provenance = h.policy.provenanceEvaluator('s4', false)
    expect(provenance.origins()).toBeUndefined()
    provenance.policy({ id: 'p', name: 'browser_snapshot', args: {} }, { reads: [LOCAL, EVIL], acts: [], pageOrigin: LOCAL })
    expect(provenance.origins()?.sort()).toEqual([EVIL, LOCAL].sort())
  })

  it('the setting off restores today\'s behaviour', () => {
    const h = harness({ taintExemptLocalPages: false })
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([LOCAL])
    // Absent settings (an older stored value read by the policy layer alone) are off too.
    const bare = new PolicyRuntime({ settings: () => ({ siteRules: [], siteDefaultsEnabled: true }), unrestricted: () => true, clearBridgeTaint: vi.fn(async () => {}) })
    const call = { id: 'b', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    bare.hook('b', 's1', true)(call, { reads: [LOCAL], acts: [], pageOrigin: LOCAL })
    expect(bare.recordResult(call, true)).toEqual({ exempt: false })
    expect(bare.get('s1')?.sources).toEqual([LOCAL])
  })

  it('managed policy can force it off, whatever the user set', () => {
    const managed = parseManagedPolicy({ disableLocalTaintExemption: true })
    expect(managed).toMatchObject({ disableLocalTaintExemption: true, disableTrustedTaintExemption: false, active: true })
    const h = harness({}, managed)
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')).toBeDefined()
    // The other exemption is untouched.
    expect(read(h, 's2', [TRUSTED])).toEqual({ exempt: true })
    const both = harness({}, parseManagedPolicy({ disableTrustedTaintExemption: true }))
    expect(read(both, 's1', [TRUSTED])).toEqual({ exempt: false })
    expect(read(both, 's2', [LOCAL])).toEqual({ exempt: true })
  })

  it('remembers exempt reads across a worker restart, bounded', async () => {
    const storage = memoryStorage()
    const options = {
      settings: (): PolicySettings => ({ siteRules: [], siteDefaultsEnabled: true, taintExemptLocalPages: true }),
      unrestricted: () => false,
      clearBridgeTaint: vi.fn(async () => {}),
      storage: storage.area,
    }
    const before = new PolicyRuntime(options)
    await before.ready
    const first = { id: 'r1', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    before.hook('r1', 's1', false)(first, { reads: [LOCAL], acts: [], pageOrigin: LOCAL })
    expect(before.recordResult(first, true)).toEqual({ exempt: true })
    await vi.waitFor(() => { expect(storage.area.set).toHaveBeenCalled() })
    const after = new PolicyRuntime(options)
    await after.ready
    expect(after.taint.exemptReadsOf('s1')).toEqual([LOCAL])
    const second = { id: 'r2', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    after.hook('r2', 's1', false)(second, { reads: [EVIL], acts: [], pageOrigin: EVIL })
    after.recordResult(second, true)
    expect(after.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
    expect(after.taint.exemptReadsOf('s1')).toEqual([])
    // Past the bound the set counts as unknown, so nothing is ever the only source.
    for (let port = 0; port <= MAX_EXEMPT_READS; port += 1) after.taint.noteExemptRead('s9', [`http://localhost:${String(4000 + port)}`])
    expect(after.taint.exemptReadsOf('s9')).toEqual([UNKNOWN_SOURCE])
    // Clear forgets them with the taint.
    await after.clear('s9')
    expect(after.taint.exemptReadsOf('s9')).toEqual([])
  })
})

describe('sites the user trusts do not taint', () => {
  it('a session that only read trusted sites stays untainted', () => {
    const h = harness()
    expect(read(h, 's1', [TRUSTED])).toEqual({ exempt: true })
    expect(read(h, 's1', [ALWAYS])).toEqual({ exempt: true })
    expect(read(h, 's1', [LOCAL, TRUSTED])).toEqual({ exempt: true })
    expect(h.policy.get('s1')).toBeUndefined()
  })

  it('the blanket unrestricted switch still taints', () => {
    const h = harness({ siteRules: [], trustedActionOrigins: [] })
    h.unrestricted.on = true
    const call = { id: 'u', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    // Under unrestricted access the read itself needs no prompt...
    expect(h.policy.hook('u', 's1', true)(call, { reads: [EVIL], acts: [], pageOrigin: EVIL })).toEqual({ kind: 'trust' })
    // ...and it taints all the same.
    expect(h.policy.recordResult(call, true)).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL])
  })

  it('a session-only allowance still taints (only the persistent Settings list is consulted)', () => {
    // The approval card's "trust for this session" set lives in the background
    // worker and is never handed to the policy layer.
    const h = harness({ siteRules: [], trustedActionOrigins: [] })
    expect(read(h, 's1', ['https://session-allowed.example'])).toEqual({ exempt: false })
    expect(h.policy.get('s1')).toBeDefined()
  })

  it('a trusted page with an untrusted frame included taints', () => {
    const h = harness()
    expect(read(h, 's1', [TRUSTED, EVIL])).toEqual({ exempt: false })
  })

  it('the setting off restores today\'s behaviour, independently of the local-pages setting', () => {
    const h = harness({ taintExemptTrustedSites: false })
    expect(read(h, 's1', [TRUSTED])).toEqual({ exempt: false })
    expect(read(h, 's2', [ALWAYS])).toEqual({ exempt: false })
    expect(read(h, 's3', [LOCAL])).toEqual({ exempt: true })
    expect(h.policy.get('s1')?.sources).toEqual([TRUSTED])
  })
})

describe('the exemption never changes where tainted data may go', () => {
  const risky = (origin: string) => `${origin}/collect?k=sk-canary-800b3920a5708f56`

  it('a tainted session exfiltrating to loopback or to a trusted origin still forces a card', () => {
    const h = harness()
    read(h, 's1', [EVIL])
    for (const sink of [LOCAL, LOCAL_IP, 'http://[::1]:9000', TRUSTED, ALWAYS]) {
      expect(navigate(h, 's1', risky(sink)).decision.kind, sink).toBe('force')
      const open = { id: `o-${sink}`, name: 'browser_open_tab', args: { url: risky(sink) }, sessionId: 's1' }
      expect(h.policy.evaluate(open, { reads: [], acts: [], destination: risky(sink) }).kind, sink).toBe('force')
      const typing = { id: `t-${sink}`, name: 'browser_type', args: { text: 'secret' }, sessionId: 's1' }
      expect(h.policy.evaluate(typing, { reads: [], acts: [sink], typeTargetOrigin: sink }).kind, sink).toBe('force')
    }
  })

  it('also when the session had read that loopback or trusted origin before it was tainted', () => {
    const h = harness()
    read(h, 's1', [LOCAL])
    read(h, 's1', [TRUSTED])
    read(h, 's1', [EVIL])
    expect(navigate(h, 's1', risky(LOCAL)).decision.kind).toBe('force')
    expect(navigate(h, 's1', risky(TRUSTED)).decision.kind).toBe('force')
    expect(navigate(h, 's1', risky(EVIL)).decision.kind).toBe('force')
  })

  it('the pure rule is unchanged: only the taint\'s only source is exempt as a destination', () => {
    const tainted = { sources: [EVIL], firstTool: 'browser_snapshot', since: 0 }
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: risky(LOCAL) } }, tainted)).not.toEqual([])
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: risky(TRUSTED) } }, tainted)).not.toEqual([])
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: risky(EVIL) } }, tainted)).toEqual([])
  })
})

describe('the banner\'s "Trust <site>"', () => {
  function panel(policy: PolicyRuntime, sender: chrome.runtime.MessageSender = { id: 'ext', url: 'chrome-extension://ext/panel/index.html' }) {
    const listeners: Array<(message: unknown) => void> = []
    const posted: Array<Record<string, unknown>> = []
    const port = {
      name: POLICY_PORT_NAME,
      sender,
      postMessage: (message: Record<string, unknown>) => { posted.push(message) },
      disconnect: vi.fn(),
      onMessage: { addListener: (listener: (message: unknown) => void) => { listeners.push(listener) } },
      onDisconnect: { addListener: () => {} },
    } as unknown as chrome.runtime.Port
    policy.connect(port)
    return { posted, port, emit: (message: unknown) => { for (const listener of listeners) listener(message) } }
  }
  const result = (posted: Array<Record<string, unknown>>, id: string) => posted.find((message) => message.type === 'taint.trust.result' && message.id === id)

  it('offers only sources a one-click user rule can cover', () => {
    const h = harness()
    read(h, 's1', [EVIL])
    read(h, 's1', ['https://x.com'])
    read(h, 's1', [LOCAL]) // already exempt: nothing to trust
    read(h, 's1', ['http://192.168.1.20']) // a user rule cannot name an address
    read(h, 's1', ['https://www.paypal.com']) // a built-in read-only site: Settings only
    expect(h.policy.trustable()).toEqual({ s1: { [EVIL]: 'evil.example', 'https://x.com': 'x.com' } })
    const config = h.policy.exemption()
    expect(trustPatternFor(TRUSTED, config)).toBeUndefined()
    expect(trustPatternFor(UNKNOWN_SOURCE, config)).toBeUndefined()
    expect(trustPatternFor('http://intranet', config)).toBeUndefined()
    expect(trustPatternFor('https://github.com', config)).toBeUndefined() // github.com/settings is a built-in rule
    expect(trustPatternFor(EVIL, { ...config, site: { ...config.site, managed: [{ pattern: 'evil.example', rule: 'ask' }] } })).toBeUndefined()
    // With the trusted-sites exemption off, trusting would change nothing: not offered.
    expect(trustPatternFor(EVIL, { ...config, trustedSites: false })).toBeUndefined()
  })

  it('trusting every source clears the taint here and on the Host, like Clear', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    read(h, 's1', [LOCAL])
    const side = panel(h.policy)
    side.emit({ type: 'taint.trust', id: 't1', sessionId: 's1', origins: [EVIL] })
    await vi.waitFor(() => { expect(result(side.posted, 't1')).toBeDefined() })
    expect(result(side.posted, 't1')).toMatchObject({ ok: true, cleared: true, trusted: [EVIL], key: 's1' })
    // The persistent choice is a `trusted` site rule, added to the user's rules.
    expect(h.saved).toEqual([[{ pattern: 'evil.example', rule: 'trusted' }, { pattern: 'seraph.quest', rule: 'trusted' }]])
    expect(h.policy.get('s1')).toBeUndefined()
    expect(h.clearBridgeTaint).toHaveBeenCalledWith('s1')
    // From now on that site does not taint.
    expect(read(h, 's2', [EVIL])).toEqual({ exempt: true })
  })

  it('trusting only some sources leaves the session tainted', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    read(h, 's1', ['https://x.com'])
    expect(await h.policy.trustSources('s1', [EVIL])).toEqual({ trusted: [EVIL], cleared: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, 'https://x.com'])
    expect(h.clearBridgeTaint).not.toHaveBeenCalled()
    expect(h.policy.trustable()).toEqual({ s1: { 'https://x.com': 'x.com' } })
    expect(await h.policy.trustSources('s1', ['https://x.com'])).toEqual({ trusted: ['https://x.com'], cleared: true })
    expect(h.policy.get('s1')).toBeUndefined()
  })

  it('an unknown source can never be trusted: nothing is offered and nothing is saved', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    h.policy.recordSelection('s1', undefined)
    expect(h.policy.get('s1')?.sources).toEqual([UNKNOWN_SOURCE, EVIL])
    expect(h.policy.trustable()).toEqual({})
    expect(await h.policy.trustSources('s1', [EVIL, UNKNOWN_SOURCE])).toEqual({ trusted: [], cleared: false })
    expect(h.saved).toEqual([])
    expect(h.policy.get('s1')).toBeDefined()
    h.policy.markHostTaint('s2')
    expect(await h.policy.trustSources('s2', [UNKNOWN_SOURCE])).toEqual({ trusted: [], cleared: false })
  })

  it('accepts only sources of that session\'s own record, and only from an extension page', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    // Not a source of this session: an arbitrary site cannot be trusted through the banner channel.
    expect(await h.policy.trustSources('s1', ['https://attacker.example'])).toEqual({ trusted: [], cleared: false })
    expect(await h.policy.trustSources('s-other', [EVIL])).toEqual({ trusted: [], cleared: false })
    expect(h.saved).toEqual([])
    // A content script (a page's renderer) is refused the port outright.
    const page = panel(h.policy, { id: 'ext', url: 'https://evil.example/', tab: { id: 3 } as chrome.tabs.Tab })
    expect(page.port.disconnect).toHaveBeenCalled()
    page.emit({ type: 'taint.trust', id: 'x', sessionId: 's1', origins: [EVIL] })
    await Promise.resolve()
    expect(h.saved).toEqual([])
    expect(h.policy.get('s1')).toBeDefined()
  })

  it('reports what the panel may offer with every state push', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    const side = panel(h.policy)
    side.emit({ type: 'taint.subscribe' })
    await vi.waitFor(() => { expect(side.posted.some((message) => message.type === 'taint.state')).toBe(true) })
    expect(side.posted.find((message) => message.type === 'taint.state')).toMatchObject({
      records: { s1: { sources: [EVIL] } },
      trustable: { s1: { [EVIL]: 'evil.example' } },
    })
  })
})
