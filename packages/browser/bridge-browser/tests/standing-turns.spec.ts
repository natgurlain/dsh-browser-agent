import { describe, expect, it } from 'vitest'
import { bridgeConfigPayload, isStandingWork, parseBridgeConfigPayload } from '../src/protocol.ts'

describe('running turns: standing hint and discovery flag', () => {
  it('accepts an optional, bounded turns count', () => {
    expect(isStandingWork({ schedules: 0, mcp: false })).toBe(true)
    expect(isStandingWork({ schedules: 0, mcp: false, turns: 2 })).toBe(true)
    for (const turns of [-1, 1.5, '2', 1e9]) expect(isStandingWork({ schedules: 0, mcp: false, turns }), String(turns)).toBe(false)
  })

  it('advertises busy only while a turn runs, and parses only the literal true', () => {
    let running = false
    const info = { pid: 1, busy: () => running }
    expect(bridgeConfigPayload(4000, info).busy).toBeUndefined()
    running = true
    expect(bridgeConfigPayload(4000, info)).toMatchObject({ busy: true })
    expect(parseBridgeConfigPayload({ wsUrl: 'ws://127.0.0.1:4000/ext/bridge', busy: true })?.busy).toBe(true)
    expect(parseBridgeConfigPayload({ wsUrl: 'ws://127.0.0.1:4000/ext/bridge', busy: 'yes' })?.busy).toBeUndefined()
  })
})
