// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { httpOrigin, isRecord, parseHttpUrl } from '../src/security/web-url.ts'

describe('web-url', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(httpOrigin('https://Shop.Example:443/cart?x=1')).toBe('https://shop.example')
    expect(httpOrigin('http://localhost:3000/')).toBe('http://localhost:3000')
    for (const value of ['chrome://settings', 'file:///etc/passwd', 'blob:https://a.example/1', 'data:text/html,x', 'about:blank', '/relative', '', '   ', undefined, 42, null]) {
      expect(httpOrigin(value)).toBeUndefined()
    }
    // Strings only: a JSON object shaped like a URL is not one (model arguments).
    expect(httpOrigin({ href: 'https://a.example/' })).toBeUndefined()
    expect(parseHttpUrl(new URL('https://a.example/p'))).toBeUndefined()
    expect(parseHttpUrl('https://a.example/p')?.pathname).toBe('/p')
  })

  it('recognizes plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})
