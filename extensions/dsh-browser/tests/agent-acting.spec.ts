// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ActingTurns, IDLE_WITHOUT_TURN_MS, TURN_FALLBACK_MS } from '../src/background/agent-acting.ts'

function fakeTimers() {
  let now = 0
  const pending = new Map<number, { at: number; run: () => void }>()
  let next = 1
  return {
    timers: {
      set: (run: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, run }); return id },
      clear: (handle: unknown) => { pending.delete(handle as number) },
    },
    advance: (ms: number) => {
      now += ms
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) { pending.delete(id); timer.run() }
      }
    },
  }
}

describe('ActingTurns', () => {
  it('acts from the first call of a turn until DSH says the turn ended', () => {
    const clock = fakeTimers()
    const onChange = vi.fn()
    const turns = new ActingTurns(onChange, clock.timers)
    expect(turns.sessions()).toEqual([])
    turns.begin('s1')
    expect(turns.sessions()).toEqual(['s1'])
    turns.settled('s1')
    // The model thinks between steps: still acting.
    clock.advance(60_000)
    turns.begin('s1')
    turns.settled('s1')
    expect(turns.sessions()).toEqual(['s1'])
    expect(onChange).toHaveBeenCalledTimes(1)
    turns.turnEnded('s1')
    expect(turns.sessions()).toEqual([])
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('ends a caller without a visible turn once its calls are idle', () => {
    const clock = fakeTimers()
    const turns = new ActingTurns(() => {}, clock.timers)
    turns.begin(undefined)
    turns.begin('mcp-claude')
    turns.settled(undefined)
    turns.settled('mcp-claude')
    clock.advance(IDLE_WITHOUT_TURN_MS - 1)
    expect(turns.sessions()).toEqual([undefined, 'mcp-claude'])
    clock.advance(1)
    expect(turns.sessions()).toEqual([])
  })

  it('never ends while a call is in flight, and falls back when a turn end is lost', () => {
    const clock = fakeTimers()
    const turns = new ActingTurns(() => {}, clock.timers)
    turns.begin('s1')
    clock.advance(TURN_FALLBACK_MS * 2)
    expect(turns.sessions()).toEqual(['s1'])
    turns.settled('s1')
    clock.advance(TURN_FALLBACK_MS)
    expect(turns.sessions()).toEqual([])
  })

  it('clears everything when the user takes over', () => {
    const turns = new ActingTurns(() => {}, fakeTimers().timers)
    turns.begin('s1')
    turns.begin('s2')
    turns.clear()
    expect(turns.sessions()).toEqual([])
    // A late settle of a cleared call changes nothing.
    turns.settled('s1')
    expect(turns.sessions()).toEqual([])
  })
})
