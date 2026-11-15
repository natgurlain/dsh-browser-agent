// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PauseGate, describeResumeDelta, heldCallStale } from '../src/background/pause-gate.ts'

describe('PauseGate', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
  afterEach(() => { vi.useRealTimers() })

  it('lets calls through while running', async () => {
    const gate = new PauseGate()
    await expect(gate.hold({ id: 'a', name: 'browser_click' }, new AbortController().signal)).resolves.toEqual({ kind: 'not-held' })
  })

  it('holds the next call after "pause after this step" and releases it on resume', async () => {
    const changes: string[] = []
    const gate = new PauseGate({ onChange: (state) => { changes.push(`${state.mode}:${state.held.length}`) } })
    gate.pause('after-step')
    expect(gate.state()).toMatchObject({ mode: 'paused', since: 10_000, held: [] })
    const held = gate.hold({ id: 'a', name: 'browser_click', sessionId: 's', expiresAt: 100_000 }, new AbortController().signal)
    await Promise.resolve()
    expect(gate.state().held).toEqual([{ id: 'a', name: 'browser_click', sessionId: 's', heldAt: 10_000 }])
    vi.advanceTimersByTime(5_000)
    let prepared: unknown
    await gate.resume(async (calls) => { prepared = calls.map((call) => call.id); return new Map() })
    await expect(held).resolves.toEqual({ kind: 'released', heldMs: 5_000 })
    expect(prepared).toEqual(['a'])
    expect(gate.state()).toMatchObject({ mode: 'running', held: [] })
    expect(changes).toEqual(['paused:0', 'paused:1', 'resuming:1', 'running:0'])
  })

  it('keeps holding calls that arrive while the resume delta is prepared', async () => {
    const gate = new PauseGate()
    gate.pause('take-over')
    let late!: Promise<unknown>
    await gate.resume(async () => {
      late = gate.hold({ id: 'late', name: 'browser_type' }, new AbortController().signal)
      return new Map()
    })
    await expect(late).resolves.toMatchObject({ kind: 'released' })
  })

  it('fails stale held calls with the reason chosen at resume', async () => {
    const gate = new PauseGate()
    gate.pause('take-over')
    expect(gate.state().mode).toBe('taken-over')
    const stale = gate.hold({ id: 'a', name: 'browser_click' }, new AbortController().signal)
    const fresh = gate.hold({ id: 'b', name: 'browser_snapshot' }, new AbortController().signal)
    await gate.resume(async () => new Map([['a', 'page changed']]))
    await expect(stale).resolves.toMatchObject({ kind: 'failed', message: 'page changed' })
    await expect(fresh).resolves.toMatchObject({ kind: 'released' })
  })

  it('fails closed shortly before the call deadline and on cancellation', async () => {
    const gate = new PauseGate({ marginMs: 1_000 })
    gate.pause('after-step')
    const expiring = gate.hold({ id: 'a', name: 'browser_click', expiresAt: 13_000 }, new AbortController().signal)
    const controller = new AbortController()
    const cancelled = gate.hold({ id: 'b', name: 'browser_click', expiresAt: 100_000 }, controller.signal)
    controller.abort()
    await expect(cancelled).resolves.toEqual({ kind: 'cancelled' })
    vi.advanceTimersByTime(1_999)
    expect(gate.state().held.map((call) => call.id)).toEqual(['a'])
    vi.advanceTimersByTime(1)
    await expect(expiring).resolves.toEqual({ kind: 'expired', heldMs: 2_000 })
    expect(gate.state().held).toEqual([])
    const already = new AbortController()
    already.abort()
    await expect(gate.hold({ id: 'c', name: 'x' }, already.signal)).resolves.toEqual({ kind: 'cancelled' })
  })

  it('bounds holds without a deadline and cancels all on the kill switch', async () => {
    const gate = new PauseGate({ maxHoldMs: 500 })
    gate.pause('after-step')
    const bounded = gate.hold({ id: 'a', name: 'x' }, new AbortController().signal)
    vi.advanceTimersByTime(500)
    await expect(bounded).resolves.toMatchObject({ kind: 'expired' })
    const pending = gate.hold({ id: 'b', name: 'x' }, new AbortController().signal)
    gate.cancelAll()
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(gate.state().mode).toBe('running')
  })

  it('restores a persisted pause and upgrades a pause to a takeover', () => {
    const gate = new PauseGate()
    gate.restore({ mode: 'taken-over', since: 5 })
    expect(gate.state()).toMatchObject({ mode: 'taken-over', since: 5 })
    gate.restore({ mode: 'bogus' })
    expect(gate.state().mode).toBe('taken-over')
    const other = new PauseGate()
    other.pause('after-step')
    other.pause('take-over')
    expect(other.state()).toMatchObject({ mode: 'taken-over', since: 10_000 })
    expect(other.persisted()).toEqual({ mode: 'taken-over', since: 10_000 })
  })

  it('resumes even when the delta preparation fails', async () => {
    const gate = new PauseGate()
    gate.pause('after-step')
    const held = gate.hold({ id: 'a', name: 'x' }, new AbortController().signal)
    await gate.resume(async () => { throw new Error('snapshot failed') })
    await expect(held).resolves.toMatchObject({ kind: 'released' })
  })
})

describe('resume delta', () => {
  it('summarizes URL, title, and tab changes plus the page delta', () => {
    const text = describeResumeDelta({
      mode: 'taken-over',
      pausedMs: 42_000,
      before: { url: 'https://a.test/cart', title: 'Cart' },
      after: { url: 'https://a.test/checkout', title: 'Checkout' },
      openedFromControlled: 1,
      newTabs: 2,
      pageDelta: 'Changed: [3] button "Pay"',
      shareDetails: true,
    })
    expect(text).toContain('The user took over the browser for 42s')
    expect(text).toContain('URL changed: https://a.test/cart → https://a.test/checkout')
    expect(text).toContain('Title changed: "Cart" → "Checkout"')
    expect(text).toContain('1 new tab was opened from the controlled tab (2 new tabs in total)')
    expect(text).toContain('Changed: [3] button "Pay"')
  })

  it('omits page details when sharing is off and says when nothing changed', () => {
    const hidden = describeResumeDelta({
      mode: 'paused', pausedMs: 1_000,
      before: { url: 'https://a.test/x?token=1', title: 'A' }, after: { url: 'https://a.test/y', title: 'B' },
      openedFromControlled: 0, newTabs: 0, shareDetails: false,
    })
    expect(hidden).toContain('The page URL changed.')
    expect(hidden).not.toContain('a.test')
    const quiet = describeResumeDelta({
      mode: 'paused', pausedMs: 500,
      before: { url: 'https://a.test/', title: 'A' }, after: { url: 'https://a.test/', title: 'A' },
      openedFromControlled: 0, newTabs: 0, shareDetails: true,
    })
    expect(quiet).toContain('paused the agent for 1s')
    expect(quiet).toContain('Nothing changed in the controlled tab.')
    const closed = describeResumeDelta({
      mode: 'paused', pausedMs: 0, before: { url: 'https://a.test/' }, after: undefined,
      openedFromControlled: 0, newTabs: 0, shareDetails: true,
    })
    expect(closed).toContain('The controlled tab is no longer available.')
  })

  it('treats element-addressed calls as stale after the page changed', () => {
    expect(heldCallStale({ name: 'browser_click', args: { index: 3 } }, true)).toBe(true)
    expect(heldCallStale({ name: 'browser_drag', args: { fromIndex: 1, toIndex: 2 } }, true)).toBe(true)
    // The real browser_drag shape (G23).
    expect(heldCallStale({ name: 'browser_drag', args: { from: { index: 1 }, to: { selector: '#b' } } }, true)).toBe(true)
    expect(heldCallStale({ name: 'browser_drag', args: { from: { index: 1 } } }, true)).toBe(true)
    expect(heldCallStale({ name: 'browser_type', args: { selector: '#q', text: 'x' } }, true)).toBe(true)
    expect(heldCallStale({ name: 'browser_snapshot', args: {} }, true)).toBe(false)
    expect(heldCallStale({ name: 'browser_click', args: { index: 3 } }, false)).toBe(false)
  })
})
