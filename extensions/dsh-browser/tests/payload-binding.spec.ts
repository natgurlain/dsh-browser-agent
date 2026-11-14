// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { approvalBinding, canonicalJson, sha256Hex } from '../src/security/payload-binding.ts'

describe('sha256Hex', () => {
  it('matches node:crypto across empty, multi-block, and non-ASCII input', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const input of ['', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(1000), '中文 ✓ 😀']) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'))
    }
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}')
  })
})

describe('approvalBinding', () => {
  const base = {
    action: 'browser_type',
    args: { index: 3, text: 'hello' },
    origins: ['https://example.com'],
    frameId: 0,
    documentKey: 'doc-1',
  }

  it('is stable for the same payload regardless of key order', () => {
    expect(approvalBinding(base)).toBe(approvalBinding({ ...base, args: { text: 'hello', index: 3 } }))
    expect(approvalBinding(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when any bound field changes', () => {
    const original = approvalBinding(base)
    expect(approvalBinding({ ...base, action: 'browser_click' })).not.toBe(original)
    expect(approvalBinding({ ...base, args: { index: 3, text: 'hellO' } })).not.toBe(original)
    expect(approvalBinding({ ...base, origins: ['https://evil.example'] })).not.toBe(original)
    expect(approvalBinding({ ...base, frameId: 4 })).not.toBe(original)
    expect(approvalBinding({ ...base, documentKey: 'doc-2' })).not.toBe(original)
    expect(approvalBinding({ ...base, documentKey: undefined })).not.toBe(original)
  })
})
