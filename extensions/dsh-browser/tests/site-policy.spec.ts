// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SITE_RULES,
  EMPTY_SITE_POLICY,
  matchSitePattern,
  normalizeSitePattern,
  normalizeSiteRules,
  resolveSiteRule,
  type SitePolicy,
} from '../src/security/site-policy.ts'
import { NO_SESSION_KEY, TaintTracker, resultTaintsSession, taintForcedReasons, type TaintRecord } from '../src/security/taint.ts'
import { evaluateCallPolicy, type CallPolicyTargets } from '../src/security/call-policy.ts'

const policy = (overrides: Partial<SitePolicy> = {}): SitePolicy => ({
  managed: [], user: [], defaultsEnabled: true, defaultTrusted: false, ...overrides,
})

describe('site patterns', () => {
  it('normalizes hosts, globs, and path prefixes and rejects junk', () => {
    expect(normalizeSitePattern(' HTTPS://Example.com/ ')).toBe('example.com')
    expect(normalizeSitePattern('github.com/settings/')).toBe('github.com/settings')
    expect(normalizeSitePattern('*bank*')).toBe('*bank*')
    expect(normalizeSitePattern('*.corp.example:8443')).toBe('*.corp.example')
    for (const bad of ['', '*', '*.*', 'a b.com', 'user@host.com', 'x.com?q=1', 'x..com', 42]) {
      expect(normalizeSitePattern(bad)).toBeUndefined()
    }
  })

  it('matches subdomains, globs, and path prefixes', () => {
    const url = (value: string) => new URL(value)
    expect(matchSitePattern('github.com', url('https://gist.github.com/x'))).toBe(true)
    expect(matchSitePattern('github.com', url('https://notgithub.com/'))).toBe(false)
    expect(matchSitePattern('github.com/settings', url('https://github.com/settings/tokens'))).toBe(true)
    expect(matchSitePattern('github.com/settings', url('https://github.com/settingsx'))).toBe(false)
    expect(matchSitePattern('github.com/settings', url('https://github.com/org/repo'))).toBe(false)
    expect(matchSitePattern('*bank*', url('https://online.mybank.co.uk/login'))).toBe(true)
    expect(matchSitePattern('*bank*', url('https://example.com/bank'))).toBe(false)
    expect(matchSitePattern('*.example.com', url('https://example.com/'))).toBe(true)
  })

  it('dedupes stored rules keeping the most restrictive', () => {
    expect(normalizeSiteRules([
      { pattern: 'a.com', rule: 'trusted' }, { pattern: 'A.com/', rule: 'blocked' },
      { pattern: 'b.com', rule: 'nonsense' }, null, 'x',
    ])).toEqual([{ pattern: 'a.com', rule: 'blocked' }])
  })
})

describe('resolveSiteRule', () => {
  it('ships read-only defaults for banks, vaults, identity pages, and consoles', () => {
    for (const url of [
      'https://www.chase.com/', 'https://secure.examplebank.com/', 'https://vault.bitwarden.com/#/vault',
      'https://accounts.google.com/signin', 'https://login.microsoftonline.com/', 'https://appleid.apple.com/',
      'https://github.com/settings/keys', 'https://us-east-1.console.aws.amazon.com/ec2', 'https://portal.azure.com/',
      'https://console.cloud.google.com/iam-admin', 'https://my.1password.com/',
    ]) {
      expect(resolveSiteRule(url, policy())?.rule, url).toBe('read-only')
    }
    expect(resolveSiteRule('https://github.com/org/repo', policy())).toBeUndefined()
    expect(DEFAULT_SITE_RULES.every((entry) => normalizeSitePattern(entry.pattern) === entry.pattern)).toBe(true)
  })

  it('layers managed over user over defaults, and unrestricted only fills the gaps', () => {
    const p = policy({
      managed: [{ pattern: 'evil.example', rule: 'blocked' }],
      user: [{ pattern: 'mybank.com', rule: 'trusted' }, { pattern: 'evil.example', rule: 'trusted' }],
      defaultTrusted: true,
    })
    expect(resolveSiteRule('https://mybank.com/', p)).toMatchObject({ rule: 'trusted', source: 'user' })
    expect(resolveSiteRule('https://evil.example/', p)).toMatchObject({ rule: 'blocked', source: 'managed' })
    expect(resolveSiteRule('https://otherbank.com/', p)).toMatchObject({ rule: 'read-only', source: 'default' })
    expect(resolveSiteRule('https://news.example/', p)).toMatchObject({ rule: 'trusted' })
    expect(resolveSiteRule('https://otherbank.com/', { ...p, defaultsEnabled: false })?.rule).toBe('trusted')
    expect(resolveSiteRule('chrome://settings', p)).toBeUndefined()
    expect(resolveSiteRule('https://otherbank.com/', EMPTY_SITE_POLICY)).toBeUndefined()
  })

  it('picks the most restrictive rule within a layer', () => {
    const p = policy({ user: [{ pattern: '*.corp.example', rule: 'blocked' }, { pattern: 'app.corp.example', rule: 'trusted' }] })
    expect(resolveSiteRule('https://app.corp.example/', p)?.rule).toBe('blocked')
  })
})

describe('taint', () => {
  it('taints on any successful browser result except content-free tools', () => {
    expect(resultTaintsSession('browser_snapshot', true)).toBe(true)
    expect(resultTaintsSession('browser_click', true)).toBe(true)
    expect(resultTaintsSession('browser_snapshot', false)).toBe(false)
    expect(resultTaintsSession('browser_devtools_network', true)).toBe(false)
    expect(resultTaintsSession('bash', true)).toBe(false)
  })

  it('tracks sources per session, persists, restores, and clears', async () => {
    const written: unknown[] = []
    const tracker = new TaintTracker({ read: async () => ({}), write: async (value) => { written.push(value) } }, () => 5)
    await tracker.ready
    const events: string[] = []
    tracker.onChange((key) => events.push(key))
    tracker.mark('s1', 'browser_snapshot', ['https://a.example'], 'https://a.example')
    tracker.mark('s1', 'browser_get_text', ['https://b.example', 'https://a.example'], 'https://b.example')
    tracker.mark(undefined, 'browser_list_tabs', [])
    expect(tracker.get('s1')).toEqual({ sources: ['https://a.example', 'https://b.example'], lastReadOrigin: 'https://b.example', firstTool: 'browser_snapshot', since: 5 })
    expect(tracker.get('')).toMatchObject({ sources: [], firstTool: 'browser_list_tabs' })
    expect(events).toEqual(['s1', 's1', NO_SESSION_KEY])
    const restored = new TaintTracker({ read: async () => written.at(-1), write: async () => {} })
    await restored.ready
    expect(restored.get('s1')?.sources).toEqual(['https://a.example', 'https://b.example'])
    expect(restored.clear('s1')).toBe(true)
    expect(restored.get('s1')).toBeUndefined()
    expect(restored.clear('s1')).toBe(false)
  })

  it('forces approval only for the exfiltration-shaped calls', () => {
    const taint: TaintRecord = { sources: ['https://news.example'], lastReadOrigin: 'https://news.example', firstTool: 'browser_snapshot', since: 0 }
    const risky = 'https://sink.example/c?d=c2VjcmV0LXRva2VuLXZhbHVlLTEyMzQ1Njc4OTA'
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: risky } }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_open_tab', args: { url: risky } }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: 'https://sink.example/about' } }, taint)).toEqual([])
    expect(taintForcedReasons({ name: 'browser_navigate', args: { url: 'https://news.example/s?q=c2VjcmV0LXRva2VuLXZhbHVlLTEyMzQ1Njc4OTA' } }, taint)).toEqual([])
    expect(taintForcedReasons({ name: 'browser_type', args: { text: 'x' }, targetOrigin: 'https://news.example' }, taint)).toEqual([])
    expect(taintForcedReasons({ name: 'browser_type', args: { text: 'x' }, targetOrigin: 'https://mail.example' }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_clipboard', args: { action: 'write', text: 'x' } }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_save_pdf', args: {} }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_extract', args: { saveTo: 'a.csv' } }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_extract', args: {} }, taint)).toEqual([])
    expect(taintForcedReasons({ name: 'browser_upload', args: { paths: ['/etc/passwd'] } }, taint)).toHaveLength(1)
    expect(taintForcedReasons({ name: 'browser_click', args: { index: 1 } }, taint)).toEqual([])
    expect(taintForcedReasons({ name: 'browser_clipboard', args: { action: 'write' } }, undefined)).toEqual([])
  })
})

describe('evaluateCallPolicy', () => {
  const targets = (overrides: Partial<CallPolicyTargets>): CallPolicyTargets => ({ reads: [], acts: [], ...overrides })

  it('denies anything touching a blocked site, including iframes and destinations', () => {
    const site = policy({ user: [{ pattern: 'blocked.example', rule: 'blocked' }] })
    expect(evaluateCallPolicy({ name: 'browser_snapshot', args: {}, targets: targets({ reads: ['https://ok.example', 'https://blocked.example'] }), site }).kind).toBe('deny')
    expect(evaluateCallPolicy({ name: 'browser_navigate', args: {}, targets: targets({ destination: 'https://blocked.example/x' }), site }).kind).toBe('deny')
    expect(evaluateCallPolicy({ name: 'browser_snapshot', args: {}, targets: targets({ reads: ['https://ok.example'] }), site }).kind).toBe('default')
  })

  it('lets read-only sites be read but not changed, and lets the agent navigate away', () => {
    const site = policy({ defaultTrusted: true })
    expect(evaluateCallPolicy({ name: 'browser_get_text', args: {}, targets: targets({ reads: ['https://www.chase.com'] }), site }).kind).toBe('default')
    const click = evaluateCallPolicy({ name: 'browser_click', args: {}, targets: targets({ acts: ['https://www.chase.com'] }), site })
    expect(click.kind).toBe('deny')
    expect(click.kind === 'deny' && click.message).toMatch(/read-only by \*?chase\.com \(built-in default\)/)
    expect(evaluateCallPolicy({ name: 'browser_navigate', args: {}, targets: targets({ destination: 'https://news.example/' }), site }).kind).toBe('trust')
    expect(evaluateCallPolicy({ name: 'browser_click', args: {}, targets: targets({ acts: ['https://github.com'] }), site }).kind).toBe('trust')
    // Path-scoped default: github.com/settings is read-only as a destination too.
    expect(evaluateCallPolicy({ name: 'browser_navigate', args: {}, targets: targets({ destination: 'https://github.com/settings/keys' }), site }).kind).toBe('default')
  })

  it('forces a prompt on ask sites and under taint, even when the site is trusted', () => {
    const site = policy({ user: [{ pattern: 'ask.example', rule: 'ask' }], defaultTrusted: true })
    const ask = evaluateCallPolicy({ name: 'browser_get_text', args: {}, targets: targets({ reads: ['https://ask.example'] }), site })
    expect(ask).toMatchObject({ kind: 'force' })
    const taint: TaintRecord = { sources: ['https://news.example'], firstTool: 'browser_snapshot', since: 0 }
    const typed = evaluateCallPolicy({ name: 'browser_type', args: { text: 'secret' }, targets: targets({ acts: ['https://mail.example'], typeTargetOrigin: 'https://mail.example' }), site, taint })
    expect(typed.kind).toBe('force')
  })

  it('applies managed switches and the pinned origin allowlist', () => {
    const site = policy({ defaultTrusted: true })
    const managed = { disableScreenshots: true, disableDevTools: true, allowedOrigins: ['https://*.corp.example'] }
    expect(evaluateCallPolicy({ name: 'browser_screenshot', args: {}, targets: targets({}), site, managed }).kind).toBe('deny')
    expect(evaluateCallPolicy({ name: 'browser_console_eval', args: {}, targets: targets({}), site, managed, devTools: true }).kind).toBe('deny')
    expect(evaluateCallPolicy({ name: 'browser_snapshot', args: {}, targets: targets({ reads: ['https://app.corp.example'] }), site, managed }).kind).toBe('trust')
    expect(evaluateCallPolicy({ name: 'browser_snapshot', args: {}, targets: targets({ reads: ['https://elsewhere.example'] }), site, managed }).kind).toBe('deny')
    expect(evaluateCallPolicy({ name: 'browser_navigate', args: {}, targets: targets({ destination: 'https://elsewhere.example/' }), site, managed }).kind).toBe('deny')
  })
})
