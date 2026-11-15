// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANEL_COPY } from '../src/panel/strings.ts'

const BRIDGE_SRC = join(import.meta.dirname, '../../../packages/browser/bridge-browser/src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : []
  })
}

/**
 * Every browser tool name the bridge can put on the timeline: tools it
 * registers (`name: 'browser_…'`), the wire action lists, and the fleet
 * release action. Read from the bridge source so a new tool cannot be missed.
 */
function bridgeToolNames(): string[] {
  const names = new Set<string>()
  for (const text of sources(BRIDGE_SRC)) {
    for (const match of text.matchAll(/\bname: '(browser_[a-z_]+)'/gu)) names.add(match[1]!)
    for (const list of text.matchAll(/export const (?:BROWSER|RELIABILITY|DEVTOOLS)_TOOL_NAMES = \[([^\]]*)\]/gu)) {
      for (const match of list[1]!.matchAll(/'(browser_[a-z_]+)'/gu)) names.add(match[1]!)
    }
    for (const match of text.matchAll(/export const \w+_ACTION = '(browser_[a-z_]+)'/gu)) names.add(match[1]!)
  }
  return [...names].sort()
}

describe('timeline tool labels', () => {
  it('finds the bridge tool list (guards the scan itself)', () => {
    const names = bridgeToolNames()
    expect(names.length).toBeGreaterThan(40)
    for (const known of ['browser_snapshot', 'browser_run', 'browser_watch', 'browser_fanout', 'browser_fleet_release', 'browser_workflow_run', 'browser_console_eval']) {
      expect(names).toContain(known)
    }
  })

  it('labels every bridge tool in English and Chinese', () => {
    const names = bridgeToolNames()
    for (const locale of ['en', 'zh'] as const) {
      const missing = names.filter((name) => (PANEL_COPY[locale].tool.labels[name] ?? '').trim() === '')
      expect({ locale, missing }).toEqual({ locale, missing: [] })
    }
  })
})
