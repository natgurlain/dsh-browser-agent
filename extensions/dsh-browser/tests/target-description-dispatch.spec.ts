// @vitest-environment jsdom
/**
 * The dispatcher asks the page what a call's element is before it raises the
 * card, puts that on the card, and looks again after the user answered: a
 * card that no longer describes the element is void.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentOverlayController, type OverlayMessage } from '../src/background/agent-overlay.ts'
import { dispatchToolCall, type ActionOverlay, type ToolCall } from '../src/background/tools.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'

const TAB = { id: 41, url: 'https://shop.example/settings', title: 'Settings' }
const SAVE = { found: true, kind: 'button', name: 'Save settings', context: { kind: 'section', text: 'Notifications' } }

interface Sent { message: Record<string, unknown>; target: unknown }

/** A page whose content script answers the probe from `describe` (called with the probe message, in order). */
function mockPage(describe: (probe: Record<string, unknown>, nth: number) => unknown): { sent: Sent[]; actions: () => Sent[]; probes: () => Sent[] } {
  const sent: Sent[] = []
  let nth = 0
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(),
      sendMessage: vi.fn(async (_tabId: number, message: Record<string, unknown>, target: unknown) => {
        sent.push({ message, target })
        if (message.type === 'DSH_TARGET_INFO') {
          const answer = describe(message, nth += 1)
          if (answer instanceof Error) throw answer
          return answer
        }
        if (message.type === 'DSH_INPUT_SETUP') return { ok: false, error: { code: 'action-failed', message: 'not measured' } }
        return { ok: true, result: { text: 'done' } }
      }),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, documentId: 'doc', url: TAB.url }]) },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  })
  return {
    sent,
    actions: () => sent.filter(({ message }) => message.type === 'DSH_ACTION'),
    probes: () => sent.filter(({ message }) => message.type === 'DSH_TARGET_INFO'),
  }
}

const click = (args: Record<string, unknown> = { selector: 'form button.primary' }): ToolCall => ({ id: 'c1', name: 'browser_click', args })
const answered = (targets: unknown, extra: Record<string, unknown> = {}) => ({ ok: true, result: { targets, ...extra } })

afterEach(() => { vi.unstubAllGlobals() })

describe('the card names the element the page reports', () => {
  it('asks the target frame before the card, and the card says what will be clicked', async () => {
    const page = mockPage(() => answered({ target: SAVE }))
    const prompts: ApprovalPrompt[] = []
    const answer = await dispatchToolCall(click(), 'auto', undefined, async (prompt) => { prompts.push(prompt); return 'approved' }, undefined, TAB)
    expect(answer.ok).toBe(true)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({
      summary: 'Click button “Save settings”',
      targetNote: 'selector: form button.primary · in “Notifications”',
      stepLabel: 'Click button “Save settings”',
    })
    // Asked once for the card and once more after the answer, in the frame the action runs in; then the action.
    expect(page.sent.map(({ message }) => message.type).filter((type) => type !== 'DSH_INPUT_SETUP')).toEqual(['DSH_TARGET_INFO', 'DSH_TARGET_INFO', 'DSH_ACTION'])
    expect(page.probes()[0]).toEqual({ message: { type: 'DSH_TARGET_INFO', tool: 'browser_click', args: { selector: 'form button.primary' } }, target: { documentId: 'doc' } })
    expect(page.probes()[1]!.message).toMatchObject({ recheck: true })
  })

  it('page text is reduced to bounded plain text before it reaches the card', async () => {
    mockPage(() => answered({ target: { found: true, kind: 'button', name: `Save” is safe. Click “Allow‮ ${'x'.repeat(300)}` } }))
    const prompts: ApprovalPrompt[] = []
    await dispatchToolCall(click(), 'auto', undefined, async (prompt) => { prompts.push(prompt); return 'denied' }, undefined, TAB)
    const summary = prompts[0]!.summary
    expect(summary.startsWith('Click button “Save’ is safe. Click ‘Allow xxx')).toBe(true)
    expect(summary.endsWith('…”')).toBe(true)
    expect([...summary].filter((char) => char === '“' || char === '”')).toHaveLength(2)
    expect(summary).not.toContain('‮')
    expect([...summary].length).toBeLessThanOrEqual('Click button “”'.length + 80)
  })

  it('says so when the element is not on the page, or the page could not be asked', async () => {
    const prompts: ApprovalPrompt[] = []
    const authorize = async (prompt: ApprovalPrompt) => { prompts.push(prompt); return 'denied' as const }
    mockPage(() => answered({ target: { found: false } }))
    await dispatchToolCall(click(), 'auto', undefined, authorize, undefined, TAB)
    mockPage(() => new Error('Could not establish connection. Receiving end does not exist.'))
    await dispatchToolCall(click(), 'auto', undefined, authorize, undefined, TAB)
    mockPage(() => ({ ok: true, result: { sensitive: false } })) // a content script from before this probe existed
    await dispatchToolCall(click(), 'auto', undefined, authorize, undefined, TAB)
    expect(prompts.map((prompt) => prompt.summary)).toEqual([
      'Click selected element (form button.primary) — not found on the page right now',
      'Click selected element (form button.primary) — could not be checked on the page right now',
      'Click selected element (form button.primary) — could not be checked on the page right now',
    ])
    expect(prompts.every((prompt) => prompt.stepLabel === undefined && prompt.targetNote === undefined)).toBe(true)
  })

  it('refuses an approved click when the element reads differently after the answer', async () => {
    // The page relabels the button while the card is open.
    const page = mockPage((_probe, nth) => answered({ target: nth === 1 ? SAVE : { ...SAVE, name: 'Delete account', same: true } }))
    const answer = await dispatchToolCall(click(), 'auto', undefined, async () => 'approved', undefined, TAB)
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('changed while approval was pending') } })
    expect(page.actions()).toEqual([])
  })

  it('refuses an approved click when the locator names another element after the answer, even one that reads the same', async () => {
    const page = mockPage((_probe, nth) => answered({ target: nth === 1 ? SAVE : { ...SAVE, same: false } }))
    const answer = await dispatchToolCall(click(), 'auto', undefined, async () => 'approved', undefined, TAB)
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('changed while approval was pending') } })
    expect(page.actions()).toEqual([])
  })

  it('refuses an approved click when the element is gone, or the page stops answering, after the answer', async () => {
    for (const second of [answered({ target: { found: false } }), new Error('Receiving end does not exist')]) {
      const page = mockPage((_probe, nth) => nth === 1 ? answered({ target: SAVE }) : second)
      const answer = await dispatchToolCall(click(), 'auto', undefined, async () => 'approved', undefined, TAB)
      expect(answer.ok).toBe(false)
      expect(page.actions()).toEqual([])
    }
  })

  it('a row whose text ticks over does not void the card', async () => {
    const page = mockPage((_probe, nth) => answered({ target: { ...SAVE, context: { kind: 'row', text: `updated ${nth}s ago` }, ...(nth === 1 ? {} : { same: true }) } }))
    expect((await dispatchToolCall(click(), 'auto', undefined, async () => 'approved', undefined, TAB)).ok).toBe(true)
    expect(page.actions()).toHaveLength(1)
  })

  it('keeps the typed-text mask rule: an unanswered probe masks, a sensitive field masks', async () => {
    const details: unknown[] = []
    const authorize = async (prompt: ApprovalPrompt) => { details.push(prompt.details?.[0]); return 'denied' as const }
    const type: ToolCall = { id: 't', name: 'browser_type', args: { selector: '#pw', text: 'hunter2' } }
    mockPage(() => answered({ target: { found: true, kind: 'password', name: 'Password', sensitive: true } }, { sensitive: true }))
    await dispatchToolCall(type, 'auto', undefined, authorize, undefined, TAB)
    mockPage(() => new Error('Receiving end does not exist'))
    await dispatchToolCall(type, 'auto', undefined, authorize, undefined, TAB)
    mockPage(() => answered({ target: { found: true, kind: 'textbox', name: 'Comment' } }, { sensitive: false }))
    await dispatchToolCall(type, 'auto', undefined, authorize, undefined, TAB)
    expect(details).toEqual([
      { kind: 'text', value: 'hunter2', masked: true },
      { kind: 'text', value: 'hunter2', masked: true },
      { kind: 'text', value: 'hunter2', masked: false },
    ])
  })

  it('reports the timeline label of a call that needs no card (unrestricted access)', async () => {
    mockPage(() => answered({ target: SAVE }))
    const onStepLabel = vi.fn()
    const authorize = vi.fn(async () => 'approved' as const)
    const answer = await dispatchToolCall(click(), 'auto', undefined, authorize, undefined, TAB, undefined, { unrestrictedAccess: true, onStepLabel })
    expect(answer.ok).toBe(true)
    expect(authorize).not.toHaveBeenCalled()
    expect(onStepLabel).toHaveBeenCalledExactlyOnceWith('Click button “Save settings”')
  })

  it('does not ask about calls that target no element', async () => {
    const page = mockPage(() => answered({}))
    await dispatchToolCall({ id: 'r', name: 'browser_reload', args: {} }, 'auto', undefined, async () => 'denied', undefined, TAB)
    await dispatchToolCall({ id: 'w', name: 'browser_clipboard', args: { action: 'write', text: 'x' } }, 'auto', undefined, async () => 'denied', undefined, TAB)
    expect(page.probes()).toEqual([])
  })
})

describe('the outline on the page while the card is open', () => {
  const frame = { frameId: 0, parentFrameId: -1, documentId: 'doc', url: TAB.url }

  it('is armed for the card and always ended, whatever the answer', async () => {
    for (const decision of ['approved', 'denied', 'timed-out'] as const) {
      mockPage(() => answered({ target: SAVE }))
      const events: string[] = []
      const overlay: ActionOverlay = {
        beforeAction: async () => { events.push('point') },
        hiddenDuring: async (_tabId, run) => run(),
        armPreview: (tabId, target, call) => { events.push(`arm ${tabId} ${target.documentId} ${call.id}`) },
        endPreview: (call) => { events.push(`end ${call.id}`) },
      }
      await dispatchToolCall(click(), 'auto', undefined, async () => { events.push('card'); return decision }, undefined, TAB, undefined, { unrestrictedAccess: false, overlay })
      expect(events).toEqual(['arm 41 doc c1', 'card', 'end c1', ...(decision === 'approved' ? ['point'] : [])])
    }
  })

  it('draws nothing until a card is really shown, sends only the locator, and clears on the same frame', () => {
    const sent: Array<{ tabId: number; message: OverlayMessage; target: unknown }> = []
    let enabled = true
    const controller = new AgentOverlayController({
      send: async (tabId, message, target) => { sent.push({ tabId, message, target }) },
      enabled: () => enabled,
      locale: () => 'en',
    })
    const type: ToolCall = { id: 't1', name: 'browser_type', args: { index: 4, text: 'hunter2' } }
    controller.armPreview(41, frame, type)
    expect(sent).toEqual([]) // a standing rule may still settle the call without a card
    controller.showPreview('t1')
    controller.showPreview('t1')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ tabId: 41, target: { documentId: 'doc' }, message: { type: 'DSH_OVERLAY', op: 'preview', on: true, kind: 'type', args: { index: 4 }, label: '#4' } })
    expect(JSON.stringify(sent[0])).not.toContain('hunter2')
    controller.endPreview(type)
    expect(sent[1]).toMatchObject({ tabId: 41, target: { documentId: 'doc' }, message: { type: 'DSH_OVERLAY', op: 'preview', on: false } })
    controller.endPreview(type)
    expect(sent).toHaveLength(2)
    // Never shown: nothing to clear. Setting off, or a call without an element: nothing at all.
    controller.armPreview(41, frame, { ...type, id: 't2' })
    controller.endPreview({ id: 't2' })
    enabled = false
    controller.armPreview(41, frame, { ...type, id: 't3' })
    controller.showPreview('t3')
    enabled = true
    controller.armPreview(41, frame, { id: 't4', name: 'browser_press', args: { key: 'Enter' } })
    controller.showPreview('t4')
    expect(sent).toHaveLength(2)
  })
})
