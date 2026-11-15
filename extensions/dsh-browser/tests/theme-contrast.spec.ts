// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_COLOR } from '../src/panel/theme.ts'

/**
 * WCAG contrast gate for the panel palette. The stylesheet keeps every colour
 * in three marked token blocks (light, dark forced, dark following the
 * system); this spec parses them and fails when a foreground/background pair
 * drops below its threshold in either theme, when the two dark blocks drift
 * apart, or when a literal colour appears outside the token blocks.
 */

const css = readFileSync(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')

function tokenBlock(name: string): Map<string, string> {
  const match = new RegExp(`/\\* theme-tokens:${name}:start \\*/([\\s\\S]*?)/\\* theme-tokens:${name}:end \\*/`).exec(css)
  if (match === null) throw new Error(`token block ${name} missing`)
  const tokens = new Map<string, string>()
  for (const [, key, value] of match[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens.set(key!, value!.trim())
  return tokens
}

const THEMES = {
  light: tokenBlock('light'),
  dark: tokenBlock('dark'),
} as const

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (match === null) throw new Error(`not an opaque hex colour: ${hex}`)
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(match[1]!.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Normal-size text: WCAG AA 4.5:1. `[foreground, background]`. */
const TEXT_PAIRS: Array<[string, string]> = [
  // Body text.
  ['ink', 'canvas'], ['ink', 'surface'], ['ink', 'surface-hover'], ['ink-strong', 'surface'], ['ink-soft', 'surface'],
  ['muted', 'canvas'], ['muted', 'canvas-deep'], ['muted', 'surface'], ['muted', 'blue-wash'],
  // Hints, timestamps, tool labels.
  ['faint', 'canvas'], ['faint', 'surface'], ['faint', 'blue-wash'],
  // Accent text, links, the user bubble.
  ['blue-ink', 'blue-soft'], ['blue-ink', 'blue-wash'], ['blue-ink', 'surface'], ['blue-ink', 'canvas'],
  ['blue', 'surface'], ['blue', 'canvas'], ['blue', 'blue-wash'], ['user-ink', 'blue-soft'], ['ink', 'blue-soft'],
  // Danger: errors, the kill-switch banner.
  ['danger', 'danger-soft'], ['danger', 'surface'], ['danger', 'canvas'], ['danger-ink', 'danger-soft'], ['ink', 'danger-soft'],
  // Security: taint banner, forced approvals, paused agent controls.
  ['security', 'security-soft'], ['security', 'surface'], ['security-strong', 'security-soft'], ['security-deep', 'security-soft'],
  ['security-strong', 'blue-wash'], ['security-deep', 'blue-wash'], ['ink', 'security-soft'], ['muted', 'security-soft'],
  ['ink', 'warm-wash'], ['muted', 'warm-wash'],
  // Button text on button background.
  ['on-accent', 'blue-fill'], ['on-accent', 'blue-fill-hover'], ['on-accent', 'danger-fill'],
  ['on-inverse', 'inverse-bg'], ['on-inverse', 'inverse-bg-hover'],
  // Code and badges.
  ['code-ink', 'code-bg'], ['code-inline-ink', 'code-inline-bg'], ['ink', 'code-inline-bg'],
  ['success-ink', 'success-soft'], ['success-ink', 'surface'], ['ink', 'chip-bg'], ['muted', 'chip-bg'],
]

/** Large text and UI boundaries / state indicators: 3:1. */
const UI_PAIRS: Array<[string, string]> = [
  ['focus', 'surface'], ['focus', 'canvas'],
  ['toggle-line', 'surface'], ['blue-fill', 'surface'], ['blue-fill', 'canvas'],
  ['success', 'surface'], ['warning', 'surface'], ['danger', 'surface'], ['faint', 'surface'],
  ['toggle-knob', 'blue-fill'],
]

describe.each(['light', 'dark'] as const)('panel palette contrast (%s)', (theme) => {
  const tokens = THEMES[theme]
  const value = (name: string): string => {
    const found = tokens.get(name)
    if (found === undefined) throw new Error(`token --${name} missing in ${theme}`)
    return found
  }

  it.each(TEXT_PAIRS)('text %s on %s meets 4.5:1', (foreground, background) => {
    expect(contrast(value(foreground), value(background))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(UI_PAIRS)('boundary %s on %s meets 3:1', (foreground, background) => {
    expect(contrast(value(foreground), value(background))).toBeGreaterThanOrEqual(3)
  })

  it('keeps the browser-chrome colour equal to the canvas', () => {
    expect(THEME_COLOR[theme]).toBe(value('canvas'))
  })
})

describe('panel palette structure', () => {
  it('defines the same tokens for light and dark', () => {
    expect([...THEMES.dark.keys()].sort()).toEqual([...THEMES.light.keys()].sort())
  })

  it('keeps the forced and the system-following dark palettes identical', () => {
    expect(Object.fromEntries(tokenBlock('dark-auto'))).toEqual(Object.fromEntries(THEMES.dark))
  })

  it('scopes the dark palette as documented', () => {
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/)
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{\s*color-scheme: dark;/)
  })

  it('has no literal colour outside the token blocks', () => {
    const outside = css.replace(/\/\* theme-tokens:([\w-]+):start \*\/[\s\S]*?\/\* theme-tokens:\1:end \*\//g, '')
    const literals = outside.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\([^)]*\)|(?<![-\w])(?:white|black)(?![-\w])/gi) ?? []
    expect(literals).toEqual([])
  })

  it('only uses colour tokens that exist', () => {
    const fixed = tokenBlock('fixed')
    const known = new Set([...THEMES.light.keys(), ...fixed.keys(), 'ui-scale', 'focus-ring'])
    const used = new Set([...css.matchAll(/var\(--([\w-]+)/g)].map((match) => match[1]!))
    expect([...used].filter((name) => !known.has(name))).toEqual([])
  })
})
