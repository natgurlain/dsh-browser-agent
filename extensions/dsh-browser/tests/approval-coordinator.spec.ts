// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCoordinator } from '../src/background/approval-coordinator.ts'

const PROMPT = {
  kind: 'action' as const,
  action: 'browser_click',
  summary: 'Click element [3]',
  origins: ['https://example.com'],
  canTrust: true,
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(delivered = false) {
  const callbacks = {
    deliver: vi.fn(() => delivered),
    notify: vi.fn(),
    clearNotification: vi.fn(),
    resolved: vi.fn(),
  }
  const coordinator = new ApprovalCoordinator(callbacks, 60_000)
  return { callbacks, coordinator }
}

describe('ApprovalCoordinator', () => {
  it('keeps an undelivered approval pending and notifies the user', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc')
    const { callbacks, coordinator } = harness()
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-1')

    expect(callbacks.notify).toHaveBeenCalledWith(expect.objectContaining({
      id: '12345678-1234-4234-8234-123456789abc',
      sessionId: 'session-1',
    }), 7)

    coordinator.replay((request) => {
      expect(request.sessionId).toBe('session-1')
      return true
    })
    coordinator.respond('12345678-1234-4234-8234-123456789abc', 'allow-once')

    await expect(pending).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    expect(callbacks.clearNotification).toHaveBeenCalledWith('12345678-1234-4234-8234-123456789abc')
    expect(callbacks.resolved).toHaveBeenCalledWith('12345678-1234-4234-8234-123456789abc')
  })

  it('waits for the full approval window before timing out', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abd')
    const { coordinator } = harness(true)
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7)

    await vi.advanceTimersByTimeAsync(59_999)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ status: 'timed-out' })
  })

  it('cancels a pending approval when its tool call is withdrawn', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abe')
    const { coordinator } = harness(true)
    const abort = new AbortController()
    const pending = coordinator.request(PROMPT, abort.signal, 7)

    abort.abort()

    await expect(pending).resolves.toEqual({ status: 'cancelled' })
  })

  it('cancels approvals only for the requested session', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('12345678-1234-4234-8234-123456789ab1')
      .mockReturnValueOnce('12345678-1234-4234-8234-123456789ab2')
    const { coordinator } = harness(true)
    const sessionOne = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-1')
    const sessionTwo = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-2')

    coordinator.cancelAll('session-2')
    coordinator.respond('12345678-1234-4234-8234-123456789ab1', 'allow-once')

    await expect(sessionOne).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    await expect(sessionTwo).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('ApprovalCoordinator without a side panel', () => {
  const BINDING = 'b'.repeat(64)

  function backgroundHarness(delivered = false, backgroundMs = 600_000) {
    const callbacks = {
      deliver: vi.fn(() => delivered),
      notify: vi.fn(),
      clearNotification: vi.fn(),
      resolved: vi.fn(),
      background: vi.fn(),
    }
    const coordinator = new ApprovalCoordinator(callbacks, 60_000, () => backgroundMs)
    return { callbacks, coordinator }
  }

  it('gives an undelivered approval the longer background window, then fails closed', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-12345678a001')
    const { callbacks, coordinator } = backgroundHarness()
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7, 'session-1', 'call-1')
    expect(callbacks.background).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ id: '12345678-1234-4234-8234-12345678a001' }),
      toolCallId: 'call-1',
      windowId: 7,
      deadline: Date.now() + 600_000,
    }))
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(599_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ status: 'timed-out' })
  })

  it('extends a panel approval to the background window when the last panel closes', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-12345678a002')
    const { callbacks, coordinator } = backgroundHarness(true, 300_000)
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7)
    expect(callbacks.background).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50_000)
    coordinator.notifyPending()
    expect(callbacks.notify).toHaveBeenCalledTimes(1)
    expect(callbacks.background).toHaveBeenCalledTimes(1)
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(299_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ status: 'timed-out' })
  })

  it('never shortens a deadline when the background window is shorter', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-12345678a003')
    const { coordinator } = backgroundHarness(true, 1_000)
    const pending = coordinator.request(PROMPT, new AbortController().signal, 7)
    coordinator.notifyPending()
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('accepts a remote decision only for the exact payload binding', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-12345678a004')
    const { coordinator } = backgroundHarness()
    const pending = coordinator.request({ ...PROMPT, binding: BINDING }, new AbortController().signal, 7)
    const id = '12345678-1234-4234-8234-12345678a004'
    expect(coordinator.respondRemote(id, 'c'.repeat(64), 'allow-once')).toBe(false)
    expect(coordinator.respondRemote(id, undefined, 'allow-once')).toBe(false)
    expect(coordinator.respondRemote('other', BINDING, 'allow-once')).toBe(false)
    expect(coordinator.respondRemote(id, BINDING, 'trust-session' as 'deny')).toBe(false)
    expect(coordinator.size).toBe(1)
    expect(coordinator.respondRemote(id, BINDING, 'allow-once')).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    // First answer wins: later answers find nothing to settle.
    expect(coordinator.respondRemote(id, BINDING, 'deny')).toBe(false)
  })

  it('lets a notification allow only quick approvals, and deny anything', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('12345678-1234-4234-8234-12345678a005')
      .mockReturnValueOnce('12345678-1234-4234-8234-12345678a006')
    const { coordinator } = backgroundHarness()
    const quick = coordinator.request(PROMPT, new AbortController().signal, 7)
    const typed = coordinator.request({
      ...PROMPT,
      action: 'browser_type',
      details: [{ kind: 'text', value: 'hello', masked: false }],
    }, new AbortController().signal, 7)
    expect(coordinator.respondFromNotification('12345678-1234-4234-8234-12345678a006', 'allow-once')).toBe(false)
    expect(coordinator.get('12345678-1234-4234-8234-12345678a006')).toBeDefined()
    expect(coordinator.respondFromNotification('12345678-1234-4234-8234-12345678a006', 'deny')).toBe(true)
    expect(coordinator.respondFromNotification('12345678-1234-4234-8234-12345678a005', 'allow-once')).toBe(true)
    expect(coordinator.respondFromNotification('missing', 'deny')).toBe(false)
    await expect(quick).resolves.toEqual({ status: 'decision', decision: 'allow-once' })
    await expect(typed).resolves.toEqual({ status: 'decision', decision: 'deny' })
  })
})
