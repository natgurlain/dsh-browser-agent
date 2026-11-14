// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { capturePauseBaseline, prepareResume, type ResumeFlowDeps, type TabFacts } from '../src/background/resume-flow.ts'
import { HOLD_STALE_MESSAGE } from '../src/background/pause-gate.ts'

function deps(tabs: TabFacts[], overrides: Partial<ResumeFlowDeps> = {}): ResumeFlowDeps & { inject: ReturnType<typeof vi.fn> } {
  const inject = vi.fn(async () => {})
  return {
    queryTabs: async () => tabs,
    getTab: async (id) => tabs.find((tab) => tab.id === id),
    boundSessions: () => ['s1'],
    sessionTab: (sessionId) => (sessionId === 's1' || sessionId === '' ? 1 : undefined),
    shareDetails: () => true,
    pageDelta: async () => 'Changed: [5] button "Pay"',
    ...overrides,
    inject,
  } as ResumeFlowDeps & { inject: ReturnType<typeof vi.fn> }
}

describe('resume flow', () => {
  it('injects a delta per session and fails element calls whose page changed', async () => {
    const tabs: TabFacts[] = [{ id: 1, url: 'https://shop.test/cart', title: 'Cart' }]
    const baseline = await capturePauseBaseline(deps(tabs))
    tabs[0] = { id: 1, url: 'https://shop.test/checkout', title: 'Checkout' }
    tabs.push({ id: 2, url: 'https://shop.test/help', openerTabId: 1 })
    const flow = deps(tabs)
    const failures = await prepareResume([
      { id: 'click', name: 'browser_click', args: { index: 3 }, sessionId: 's1', heldAt: 0 },
      { id: 'snap', name: 'browser_snapshot', args: {}, sessionId: 's1', heldAt: 0 },
    ], { tookOver: true, pausedMs: 30_000 }, baseline, flow)
    expect([...failures]).toEqual([['click', HOLD_STALE_MESSAGE]])
    expect(flow.inject).toHaveBeenCalledOnce()
    const [sessionId, text] = flow.inject.mock.calls[0] as [string, string]
    expect(sessionId).toBe('s1')
    expect(text).toContain('took over the browser for 30s')
    expect(text).toContain('URL changed: https://shop.test/cart → https://shop.test/checkout')
    expect(text).toContain('1 new tab was opened from the controlled tab')
    expect(text).toContain('Changed: [5] button "Pay"')
  })

  it('releases held calls when nothing changed and keeps page text out when sharing is off', async () => {
    const tabs: TabFacts[] = [{ id: 1, url: 'https://a.test/', title: 'A' }]
    const baseline = await capturePauseBaseline(deps(tabs))
    const pageDelta = vi.fn(async () => 'should not be read')
    const flow = deps(tabs, { shareDetails: () => false, pageDelta })
    const failures = await prepareResume([
      { id: 'click', name: 'browser_click', args: { index: 3 }, sessionId: 's1', heldAt: 0 },
      { id: 'agentless', name: 'browser_click', args: { index: 1 }, heldAt: 0 },
    ], { tookOver: false, pausedMs: 2_000 }, baseline, flow)
    expect(failures.size).toBe(0)
    expect(pageDelta).not.toHaveBeenCalled()
    expect(flow.inject.mock.calls[0]![1]).toContain('Nothing changed in the controlled tab.')
  })

  it('fails element calls when the controlled tab closed, and survives a failing injection', async () => {
    const baseline = await capturePauseBaseline(deps([{ id: 1, url: 'https://a.test/' }]))
    const flow = deps([], { inject: undefined })
    flow.inject.mockRejectedValue(new Error('bridge down'))
    const failures = await prepareResume([
      { id: 'type', name: 'browser_type', args: { selector: '#q', text: 'x' }, sessionId: 's1', heldAt: 0 },
    ], { tookOver: false, pausedMs: 0 }, baseline, flow)
    expect(failures.get('type')).toBe(HOLD_STALE_MESSAGE)
    expect(flow.inject.mock.calls[0]![1]).toContain('no longer available')
  })
})
