// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
  originMatchesTrusted,
} from '../src/security/trusted-origins.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import { approvalPromptForCall } from '../src/background/authorization.ts'

function action(overrides: Partial<ApprovalPrompt> = {}): ApprovalPrompt {
  return {
    kind: 'action',
    action: 'browser_click',
    summary: 'click',
    origins: ['https://app.example.com'],
    canTrust: true,
    ...overrides,
  }
}

describe('normalizeTrustedOrigin', () => {
  it('canonicalizes exact origins and HTTPS wildcard aliases', () => {
    expect(normalizeTrustedOrigin(' https://Example.com/path ')).toBe('https://example.com')
    expect(normalizeTrustedOrigin('*.Example.com')).toBe('https://*.example.com')
    expect(normalizeTrustedOrigin('https://%2A.Example.com')).toBe('https://*.example.com')
  })

  it('preserves explicit wildcard schemes and non-default ports', () => {
    expect(normalizeTrustedOrigin('http://*.example.com')).toBe('http://*.example.com')
    expect(normalizeTrustedOrigin('https://*.example.com:8443')).toBe('https://*.example.com:8443')
  })

  it('rejects malformed or overly broad wildcard entries', () => {
    expect(normalizeTrustedOrigin('https://*.example.com/path')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.localhost')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://user:pass@*.example.com')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.co.uk')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.github.io')).toBeUndefined()
  })

  it('allows registrable and narrower wildcard roots', () => {
    expect(normalizeTrustedOrigin('https://*.example.co.uk')).toBe('https://*.example.co.uk')
    expect(normalizeTrustedOrigin('https://*.user.github.io')).toBe('https://*.user.github.io')
    expect(normalizeTrustedOrigin('https://*.api.example.com')).toBe('https://*.api.example.com')
  })
})

describe('originMatchesTrusted', () => {
  const trusted = ['https://*.example.com', 'https://secure.example.net:8443']

  it('matches the wildcard base domain and proper subdomains', () => {
    expect(originMatchesTrusted('https://example.com', trusted)).toBe(true)
    expect(originMatchesTrusted('https://api.example.com', trusted)).toBe(true)
    expect(originMatchesTrusted('https://notexample.com', trusted)).toBe(false)
  })

  it('does not cross scheme or port boundaries', () => {
    expect(originMatchesTrusted('http://api.example.com', trusted)).toBe(false)
    expect(originMatchesTrusted('https://api.example.com:8443', trusted)).toBe(false)
    expect(originMatchesTrusted('https://secure.example.net:8443', trusted)).toBe(true)
  })
})

describe('actionCoveredByTrustedOrigins', () => {
  const trusted = ['https://*.example.com']

  it('covers stable actions and fully known cross-origin navigation', () => {
    expect(actionCoveredByTrustedOrigins(action(), trusted)).toBe(true)
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_navigate',
      origins: ['https://app.example.com', 'https://docs.example.com'],
      canTrust: false,
    }), trusted)).toBe(true)
  })

  it('fails closed for history and invalid navigation with unknown destinations', () => {
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_back',
      canTrust: false,
    }), trusted)).toBe(false)
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_navigate',
      canTrust: false,
    }), trusted)).toBe(false)
  })

  it('still prompts on a trusted origin when the URL carries a long or high-entropy value', () => {
    for (const name of ['browser_navigate', 'browser_open_tab']) {
      const clean = approvalPromptForCall(
        { id: 'c', name, args: { url: 'https://docs.example.com/guide?page=2' } },
        'auto',
        [{ frameId: 0, parentFrameId: -1, url: 'https://docs.example.com/' }],
        'en',
      )!
      expect(actionCoveredByTrustedOrigins(clean, trusted), name).toBe(true)
      const risky = approvalPromptForCall(
        { id: 'c', name, args: { url: 'https://docs.example.com/guide?sid=9f86d081884c7d659a2feaa0c55ad015' } },
        'auto',
        [{ frameId: 0, parentFrameId: -1, url: 'https://docs.example.com/' }],
        'en',
      )!
      expect(risky.urlRisk, name).toBe(true)
      expect(actionCoveredByTrustedOrigins(risky, trusted), name).toBe(false)
    }
  })

  it('still prompts on a trusted origin for data smuggled outside a single query value', () => {
    const secret = 'sk-live-9fA3kQ7xLm2ZpT8vBn4Rw6Yc1Hd5Je0u'
    const hex = Buffer.from(secret).toString('hex')
    const cases: Record<string, string> = {
      baseline_query: `https://docs.example.com/c?d=${secret}`,
      path: `https://docs.example.com/c/${hex}/x`,
      param_name: `https://docs.example.com/c?${hex}=1`,
      userinfo: `https://${hex.slice(0, 60)}:x@docs.example.com/`,
      short_userinfo: 'https://a@docs.example.com/',
      chunked: 'https://docs.example.com/c?' + (hex.match(/.{1,15}/g) as string[]).map((c, i) => `p${String(i)}=${c}`).join('&'),
      dashed: 'https://docs.example.com/c?d=' + (hex.slice(0, 40).match(/.{1,8}/g) as string[]).join('-'),
      letters_only: 'https://docs.example.com/c?d=' + hex.replace(/\d/g, (d) => 'ghijklmnop'[Number(d)]!).slice(0, 47),
      oversized: `https://docs.example.com/search?q=${'word '.repeat(120)}`,
    }
    const frames = [{ frameId: 0, parentFrameId: -1, url: 'https://docs.example.com/' }]
    for (const [label, url] of Object.entries(cases)) {
      const prompt = approvalPromptForCall({ id: 'c', name: 'browser_navigate', args: { url } }, 'auto', frames, 'en')!
      expect(prompt.urlRisk, label).toBe(true)
      expect(actionCoveredByTrustedOrigins(prompt, trusted), label).toBe(false)
    }
  })

  it('requires every known navigation origin to be trusted', () => {
    expect(actionCoveredByTrustedOrigins(action({
      action: 'browser_navigate',
      origins: ['https://app.example.com', 'https://bank.example.net'],
      canTrust: false,
    }), trusted)).toBe(false)
  })
})
