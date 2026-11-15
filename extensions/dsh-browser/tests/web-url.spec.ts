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
    expect(parseHttpUrl(new URL('https://a.example/p'))?.pathname).toBe('/p')
    expect(parseHttpUrl(new URL('ftp://a.example/'))).toBeUndefined()
  })

  it('recognizes plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})
