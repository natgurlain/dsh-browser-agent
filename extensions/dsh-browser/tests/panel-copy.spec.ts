// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PANEL_COPY } from '../src/panel/strings.ts'

/** Every leaf path with its kind ('string', 'function', ...). */
function shape(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, kind] of shape(child, prefix === '' ? key : `${prefix}.${key}`)) out.set(path, kind)
    }
  } else {
    out.set(prefix, typeof value)
  }
  return out
}

describe('panel copy', () => {
  it('has the same keys and kinds in English and Chinese', () => {
    const en = shape(PANEL_COPY.en)
    const zh = shape(PANEL_COPY.zh)
    expect([...zh.keys()].sort()).toEqual([...en.keys()].sort())
    for (const [path, kind] of en) expect(`${path}:${zh.get(path)}`).toBe(`${path}:${kind}`)
  })

  it('has no empty strings in either language', () => {
    for (const locale of ['en', 'zh'] as const) {
      for (const [path, kind] of shape(PANEL_COPY[locale])) {
        if (kind !== 'string') continue
        const value = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], PANEL_COPY[locale])
        expect(`${locale}.${path}:${String(value).trim() === '' ? 'empty' : 'ok'}`).toBe(`${locale}.${path}:ok`)
      }
    }
  })

  it('carries the policy, taint, watcher, dev-loop and learning sections in both languages', () => {
    for (const section of ['sitePolicy', 'taint', 'watchers', 'devLoop', 'learning'] as const) {
      expect(Object.keys(PANEL_COPY.zh[section]).sort()).toEqual(Object.keys(PANEL_COPY.en[section]).sort())
    }
    expect(PANEL_COPY.zh.sitePolicy.managedAllowedOnly(['a', 'b'])).toContain('a、b')
    expect(PANEL_COPY.en.watchers.title(1)).toBe('Watching 1 page')
    expect(PANEL_COPY.en.watchers.title(2)).toBe('Watching 2 pages')
  })

  it('does not list denied steps among the captured failures: they are never captured', () => {
    // Denied, timed-out and cancelled steps are dropped by classifyFailure (privacy).
    expect(PANEL_COPY.en.learning.fixturesHelp).not.toMatch(/\(denied/u)
    expect(PANEL_COPY.en.learning.fixturesHelp).toMatch(/Denied, timed-out and cancelled steps .* never captured/u)
    expect(PANEL_COPY.zh.learning.fixturesHelp).not.toMatch(/（被拒绝/u)
    expect(PANEL_COPY.zh.learning.fixturesHelp).toContain('被拒绝、超时和取消的步骤')
  })
})
