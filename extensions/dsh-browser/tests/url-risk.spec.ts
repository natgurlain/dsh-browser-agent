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

  it('keeps ordinary paths, slugs, ids, and search parameters unflagged', () => {
    for (const url of [
      'https://blog.example/2026/11/how-to-bake-bread-in-a-dutch-oven-without-kneading',
      'https://api.example/orders/123e4567-e89b-12d3-a456-426614174000/items',
      'https://shop.example/p/ABC-12345?color=red&size=m&ref=home',
      'https://www.example/search?q=hello+world&hl=en&safe=active&num=10',
      'https://docs.example/en-US/docs/Web/API/Element/setAttribute#examples',
      'https://wiki.example/wiki/Internationalization_and_localization',
    ]) {
      expect(analyzeUrl(url)?.risky, url).toBe(false)
    }
  })

  it('scores the whole URL: path, parameter names, userinfo, aggregate and total size', () => {
    const hex = '736b2d6c6976652d396641336b5137784c6d325a7054387642'
    expect(analyzeUrl(`https://e.example/c/${hex}/x`)).toMatchObject({ risky: true, pathFlag: 'long' })
    expect(analyzeUrl(`https://e.example/c/${hex.slice(0, 32)}/x`)).toMatchObject({ risky: true, pathFlag: 'entropy' })
    expect(analyzeUrl(`https://e.example/c?${hex}=1`)?.params[0]?.flag).toBeDefined()
    expect(analyzeUrl('https://u:p@e.example/')).toMatchObject({ risky: true, userinfo: true })
    const chunked = 'https://e.example/c?' + (hex.match(/.{1,10}/g) as string[]).map((c, i) => `p${String(i)}=${c}`).join('&')
    expect(analyzeUrl(chunked)?.risky).toBe(true)
    expect(analyzeUrl(`https://e.example/c?d=${'ghkmnpabcdefijlo'.repeat(2)}`)?.risky).toBe(true)
    expect(analyzeUrl(`https://e.example/?q=${'a b '.repeat(200)}`)?.risky).toBe(true)
  })

  // misc3 residuals: a secret re-encoded as letters only, digits only, or short
  // mixed pieces, split across many parameters or path segments.
  it('flags a payload split into many short letters-only, digits-only, or mixed pieces', () => {
    const hex = Buffer.from('sk-live-9fA3kQ7xLm2ZpT8vBn4Rw6Yc1Hd5Je0u').toString('hex')
    const letters = hex.replace(/\d/g, (digit) => 'ghijklmnop'[Number(digit)]!)
    const chunks = (text: string, size: number): string[] => text.match(new RegExp(`.{1,${String(size)}}`, 'g')) as string[]
    for (const [label, url] of [
      ['letters across params', 'https://t.example/c?' + chunks(letters, 15).map((c, i) => `${'abcdefgh'[i]!}=${c}`).join('&')],
      ['letters across segments', 'https://t.example/' + chunks(letters, 15).join('/')],
      ['letters as a dashed slug', 'https://t.example/c/' + chunks(letters, 12).join('-')],
      ['digits across params', 'https://t.example/c?' + chunks(BigInt(`0x${hex}`).toString(), 15).map((c, i) => `${'abcdefghij'[i]!}=${c}`).join('&')],
      ['5-character mixed pieces', 'https://t.example/c?' + chunks(hex, 5).map((c, i) => `k${String(i)}=${c}`).join('&')],
    ] as const) {
      expect(analyzeUrl(url)?.risky, label).toBe(true)
    }
  })

  it('does not flag ordinary search queries, article slugs, and tracking links', () => {
    for (const url of [
      'https://www.google.com/search?q=how+to+bake+sourdough+bread+at+home&oq=how+to+bake&sourceid=chrome&ie=UTF-8',
      'https://www.google.com/search?q=strength+training+schedule+for+beginners&source=hp',
      'https://duckduckgo.com/?q=typescript+strict+null+checks+explained&ia=web',
      'https://www.bbc.com/news/articles/how-the-international-construction-industry-rebuilt-after-the-earthquake-in-2023',
      'https://www.nytimes.com/2024/05/12/world/europe/ukraine-russia-war-negotiations.html',
      'https://www.theguardian.com/world/2024/mar/14/scientists-discover-new-species-of-deep-sea-anglerfish',
      'https://en.wikipedia.org/wiki/List_of_tallest_buildings_in_the_United_States',
      'https://shop.example.com/products/merino-wool-sweater?utm_source=newsletter&utm_medium=email&utm_campaign=spring_sale_2024',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2944813,17z',
      'https://www.amazon.com/s?k=noise+cancelling+headphones&page=2',
      'https://www.booking.com/searchresults.html?ss=Krakow&checkin=2024-06-01&checkout=2024-06-05&group_adults=2',
      'https://stackoverflow.com/questions/12345678/how-do-i-undo-the-most-recent-local-commits-in-git',
      'https://medium.com/@someone/understanding-javascript-closures-with-practical-examples-3f2a1b',
      'https://dev.to/author/building-a-rest-api-with-express-and-postgresql-step-by-step-4k2m',
    ]) {
      expect(analyzeUrl(url)?.risky, url).toBe(false)
    }
  })

  it('returns undefined for unparseable URLs', () => {
    expect(analyzeUrl('not a url')).toBeUndefined()
    expect(urlCarriesRiskyValue('not a url')).toBe(false)
  })
})
