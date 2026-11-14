// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { analyzeUrl, urlCarriesRiskyValue } from '../src/security/url-risk.ts'

describe('analyzeUrl', () => {
  it('keeps the full URL and decodes query parameters', () => {
    const analysis = analyzeUrl('https://example.com/a%20b/c?q=hello%20world&page=2#top')
    expect(analysis).toMatchObject({
      href: 'https://example.com/a%20b/c?q=hello%20world&page=2#top',
      origin: 'https://example.com',
      path: '/a b/c',
      fragment: 'top',
      risky: false,
    })
    expect(analysis?.params).toEqual([
      { source: 'query', name: 'q', value: 'hello world' },
      { source: 'query', name: 'page', value: '2' },
    ])
  })

  it('leaves ordinary query values unflagged', () => {
    for (const url of [
      'https://shop.example/search?q=how%20to%20bake%20bread&page=2',
      'https://news.example/?utm_source=newsletter_2024_fall&utm_medium=email',
      'https://docs.example/guide?lang=zh-CN&id=12345',
      'https://docs.example/guide?section=internationalization',
      'https://docs.example/guide?date=2026-11-14T10:00:00Z',
    ]) {
      expect(analyzeUrl(url)?.risky, url).toBe(false)
      expect(urlCarriesRiskyValue(url), url).toBe(false)
    }
  })

  it('flags long values', () => {
    const long = 'a'.repeat(60)
    const analysis = analyzeUrl(`https://example.com/?data=${long}`)
    expect(analysis?.risky).toBe(true)
    expect(analysis?.params[0]).toEqual({ source: 'query', name: 'data', value: long, flag: 'long' })
    expect(urlCarriesRiskyValue(`https://example.com/?data=${long}`)).toBe(true)
  })

  it('flags high-entropy token-like values in the query and fragment', () => {
    for (const value of [
      '9f86d081884c7d659a2feaa0c55ad015',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbg',
      'Zm9vYmFyQmF6UXV4c2VjcmV0',
    ]) {
      expect(analyzeUrl(`https://example.com/?k=${encodeURIComponent(value)}`)?.params[0]?.flag, value).toBe('entropy')
    }
    const fragment = analyzeUrl('https://example.com/cb#access_token=9f86d081884c7d659a2feaa0c55ad015&state=1')
    expect(fragment?.risky).toBe(true)
    expect(fragment?.fragment).toBe('')
    expect(fragment?.params).toContainEqual({ source: 'fragment', name: 'access_token', value: '9f86d081884c7d659a2feaa0c55ad015', flag: 'entropy' })
  })

  it('returns undefined for unparseable URLs', () => {
    expect(analyzeUrl('not a url')).toBeUndefined()
    expect(urlCarriesRiskyValue('not a url')).toBe(false)
  })
})
