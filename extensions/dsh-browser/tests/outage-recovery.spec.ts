// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OUTAGE_RETRY_BASE_MS,
  OUTAGE_RETRY_MAX_MS,
  OUTAGE_RETRY_PERIOD_MS,
  OutageRecovery,
} from '../src/background/outage-recovery.ts'

/** A recovery on the fake clock that records when each attempt started (ms since `begin`). */
function recovery(attempt: () => Promise<void> = async () => {}) {
  const startedAt = Date.now()
  const attempts: number[] = []
  const giveUp = vi.fn()
  const instance = new OutageRecovery({
    now: () => Date.now(),
    setTimer: (run, delayMs) => setTimeout(run, delayMs),
    clearTimer: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
    attempt: async () => {
      attempts.push(Date.now() - startedAt)
      await attempt()
    },
    giveUp,
  })
  return { instance, attempts, giveUp }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('outage recovery schedule', () => {
  it('looks after one second, then doubles the pause up to fifteen seconds', async () => {
    const { instance, attempts } = recovery()
    instance.begin()
    expect(instance.active).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(OUTAGE_RETRY_BASE_MS).toBe(1_000)
    expect(OUTAGE_RETRY_MAX_MS).toBe(15_000)
    expect(attempts).toEqual([1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000])
    instance.end()
  })

  it('gives up once, ten minutes after the outage began, and looks no more', async () => {
    const { instance, attempts, giveUp } = recovery()
    instance.begin()
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS - 1)
    expect(giveUp).not.toHaveBeenCalled()
    expect(instance.active).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(OUTAGE_RETRY_PERIOD_MS).toBe(10 * 60_000)
    expect(giveUp).toHaveBeenCalledOnce()
    expect(instance.active).toBe(false)
    const looked = attempts.length
    expect(attempts.every(at => at < OUTAGE_RETRY_PERIOD_MS)).toBe(true)
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS)
    expect(attempts).toHaveLength(looked)
    expect(giveUp).toHaveBeenCalledOnce()
  })

  it('keeps the clock of the outage when asked to begin again', async () => {
    const { instance, giveUp } = recovery()
    instance.begin()
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS / 2)
    instance.begin()
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS / 2)
    expect(giveUp).toHaveBeenCalledOnce()
  })

  it('stops looking, and never gives up, once the outage ends', async () => {
    const { instance, attempts, giveUp } = recovery()
    instance.begin()
    await vi.advanceTimersByTimeAsync(3_000)
    instance.end()
    expect(instance.active).toBe(false)
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS * 2)
    expect(attempts).toEqual([1_000, 3_000])
    expect(giveUp).not.toHaveBeenCalled()
  })

  it('starts a new period for a new outage', async () => {
    const { instance, attempts, giveUp } = recovery()
    instance.begin()
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS - 5_000)
    instance.end()
    attempts.length = 0
    instance.begin()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(giveUp).not.toHaveBeenCalled()
    // Counted from the first `begin` of this helper: the second outage restarts at the base pause.
    expect(attempts.map(at => at - (OUTAGE_RETRY_PERIOD_MS - 5_000))).toEqual([1_000, 3_000, 7_000])
    instance.end()
  })

  it('looks again after the base pause when something was just ruled out', async () => {
    const { instance, attempts } = recovery()
    instance.begin()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(attempts).toEqual([1_000, 3_000, 7_000, 15_000])
    // The next look would be 15 s away; a ruled-out candidate brings it forward.
    await vi.advanceTimersByTimeAsync(2_000)
    instance.soon()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempts.at(-1)).toBe(18_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(attempts.at(-1)).toBe(20_000)
    instance.end()
  })

  it('does not overlap attempts, and waits for a slow one before pausing again', async () => {
    let release!: () => void
    const { instance, attempts } = recovery(() => new Promise<void>((resolve) => { release = resolve }))
    instance.begin()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempts).toEqual([1_000])
    await vi.advanceTimersByTimeAsync(20_000)
    instance.tick()
    expect(attempts).toEqual([1_000])
    release()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(attempts).toEqual([1_000, 23_000])
    instance.end()
  })

  it('lets an outside wake-up run only an attempt that is overdue', async () => {
    const timers: Array<() => void> = []
    const attempts: number[] = []
    const instance = new OutageRecovery({
      now: () => Date.now(),
      // Timers that never fire: what a suspended service worker leaves behind.
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
      attempt: async () => { attempts.push(Date.now()) },
      giveUp: () => {},
    })
    instance.begin()
    await vi.advanceTimersByTimeAsync(500)
    instance.tick()
    expect(attempts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    instance.tick()
    expect(attempts).toHaveLength(1)
    instance.end()
    instance.tick()
    expect(attempts).toHaveLength(1)
  })

  it('still counts the period when an attempt throws', async () => {
    const { instance, attempts, giveUp } = recovery(async () => { throw new Error('probe failed') })
    instance.begin()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(attempts).toEqual([1_000, 3_000, 7_000])
    await vi.advanceTimersByTimeAsync(OUTAGE_RETRY_PERIOD_MS)
    expect(giveUp).toHaveBeenCalledOnce()
  })
})
