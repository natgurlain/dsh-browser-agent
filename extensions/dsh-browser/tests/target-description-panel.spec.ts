// @vitest-environment jsdom
/**
 * Where the element description shows: the approval card (summary and its
 * secondary line, as plain text), the on-page outline while the card is open,
 * and the step timeline (the label the extension recorded for the call).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentOverlay } from '../src/content/overlay.ts'
import { ApprovalDialog } from '../src/panel/App.tsx'
import { appendToolStep, applyStepAudit, applyStepLabels, auditByCall, stepFromCall } from '../src/panel/events.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'
import type { ApprovalRequest } from '../src/security/approval.ts'
import { MAX_STEP_LABELS, readStepLabels, StepLabels, withStepLabel } from '../src/shared/step-labels.ts'

describe('approval card', () => {
  const request: ApprovalRequest = {
    id: 'a1',
    kind: 'action',
    action: 'browser_click',
    summary: 'Click checkbox “<b>Email</b> notifications”',
    targetNote: 'element [4] · in “Notifications‮”',
    origins: ['http://shop.localhost:4180'],
    canTrust: true,
  }
  const render = (value: ApprovalRequest): string => renderToStaticMarkup(createElement(ApprovalDialog, { request: value, onDecision: () => {}, copy: PANEL_COPY.en }))

  it('shows what will be clicked and, under it, how the call addresses the element', () => {
    const html = render(request)
    // Page-authored text is text: markup in a label is shown, not rendered.
    expect(html).toContain('<strong>Click checkbox “&lt;b&gt;Email&lt;/b&gt; notifications”</strong>')
    expect(html).toContain('<small class="approval-target-note">element [4] · in “Notifications⟦U+202E⟧”</small>')
    expect(html.indexOf('approval-target-note')).toBeGreaterThan(html.indexOf('Click checkbox'))
    expect(html.indexOf('approval-target-note')).toBeLessThan(html.indexOf('approval-origins'))
  })

  it('has no secondary line for a card that names no element', () => {
    expect(render({ ...request, summary: 'Reload the current page', targetNote: undefined as never })).not.toContain('approval-target-note')
  })
})

describe('outline on the page while the card is open (content overlay)', () => {
  const shadowOf = (overlay: AgentOverlay): ShadowRoot => (overlay as unknown as { parts: { root: ShadowRoot } }).parts.root
  const rect = (left: number, top: number): DOMRect => ({ left, top, width: 80, height: 24, right: left + 80, bottom: top + 24, x: left, y: top, toJSON: () => ({}) })

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<button id="save">Save settings</button><div id="lane">Done</div>'
    document.querySelector('#save')!.getBoundingClientRect = () => rect(100, 200)
    document.querySelector('#lane')!.getBoundingClientRect = () => rect(300, 400)
  })
  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.querySelectorAll(':scope > div').forEach((el) => { el.remove() })
  })

  it('draws a dashed outline with the index, changes nothing on the page, and leaves Stop live', () => {
    const killSwitch = vi.fn()
    const overlay = new AgentOverlay({ killSwitch, resume: vi.fn() })
    overlay.setControl(true)
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => { records.push(...list) })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    const focused = document.activeElement
    overlay.preview([document.querySelector('#save')!], '#4')
    const root = shadowOf(overlay)
    const outline = root.querySelector<HTMLElement>('.outline.on.preview')!
    expect(outline.querySelector('.label')?.textContent).toBe('#4')
    expect(outline.style.left).toBe('97px')
    expect(outline.style.top).toBe('197px')
    // Only an outline: dashed, no fill, in a layer that takes no pointer events; no ghost cursor, no typing chip.
    const css = root.querySelector('style')!.textContent!
    expect(css).toContain('.outline.preview { border-style: dashed; background: transparent; }')
    expect(css).toMatch(/\.layer \{[^}]*pointer-events: none/)
    expect(root.querySelector('.cursor.on')).toBeNull()
    expect(root.querySelector('.typing.on')).toBeNull()
    expect(overlay.hostElement()!.getAttribute('style')).toContain('pointer-events: none !important')
    // Nothing is acting, so the Stop button is not inert (a real click on it would stop the agent).
    expect((overlay as unknown as { acting: boolean }).acting).toBe(false)
    // The page sees nothing: no node added or changed outside the closed shadow root, focus untouched.
    observer.takeRecords().forEach((record) => records.push(record))
    observer.disconnect()
    expect(records).toEqual([])
    expect(document.activeElement).toBe(focused)
    overlay.dispose()
  })

  it('follows the element, outlines both ends of a drag, and goes away when the card is answered', () => {
    const overlay = new AgentOverlay({ killSwitch: vi.fn(), resume: vi.fn() })
    overlay.preview([document.querySelector('#save')!, document.querySelector('#lane')!], '#3')
    const root = shadowOf(overlay)
    expect(root.querySelectorAll('.outline.on.preview')).toHaveLength(2)
    // The page scrolls while the card is open.
    document.querySelector('#save')!.getBoundingClientRect = () => rect(100, 40)
    vi.advanceTimersByTime(250)
    expect(root.querySelector<HTMLElement>('.outline.on.preview')!.style.top).toBe('37px')
    overlay.clearPreview()
    expect(root.querySelectorAll('.outline.on')).toHaveLength(0)
    // Cleared for good: the tracker no longer redraws it.
    vi.advanceTimersByTime(1_000)
    expect(root.querySelectorAll('.outline.on')).toHaveLength(0)
    overlay.dispose()
  })

  it('gives way to the solid outline when the action starts, and a late "card closed" does not erase that', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
    try {
      const overlay = new AgentOverlay({ killSwitch: vi.fn(), resume: vi.fn() })
      overlay.preview([document.querySelector('#save')!], '#4')
      await overlay.point('click', [document.querySelector('#save')!], '#4')
      const root = shadowOf(overlay)
      expect(root.querySelector('.outline.on')).not.toBeNull()
      expect(root.querySelector('.outline.preview')).toBeNull()
      overlay.clearPreview()
      expect(root.querySelector('.outline.on')).not.toBeNull()
      overlay.dispose()
    } finally {
      Reflect.deleteProperty(window, 'matchMedia')
    }
  })
})

describe('step timeline label', () => {
  const call = (callId: string, index: number) => ({ type: 'tool/call', time: 0, data: { callId, name: 'browser_click', arguments: JSON.stringify({ index }) } })

  it('names the element once the extension has recorded what the call acted on', () => {
    let rows = appendToolStep([], stepFromCall(call('model-1', 4), 'x', 'en'), 1)
    rows = appendToolStep(rows, stepFromCall(call('model-2', 6), 'y', 'en'), 2)
    expect(rows[0]!.steps!.map((step) => `${step.label} ${step.target}`)).toEqual(['Click element #4', 'Click element #6'])
    // The audit log pairs the bridge's call id with the model's; the labels are keyed by the bridge's.
    const audit = auditByCall([
      { kind: 'tool-call', callId: 'bridge-9', toolCallId: 'model-1' },
      { kind: 'approval', callId: 'bridge-9', toolCallId: 'model-1', decision: 'allowed' },
      { kind: 'tool-call', callId: 'bridge-10', toolCallId: 'model-2' },
    ])
    const labelled = applyStepLabels(applyStepAudit(rows, audit), audit, { 'bridge-9': 'Click checkbox “Email notifications”', 'bridge-77': 'Click button “Other session”' })
    expect(labelled[0]!.steps!.map((step) => `${step.label} ${step.target}`)).toEqual(['Click checkbox “Email notifications” #4', 'Click element #6'])
    expect(labelled[0]!.steps![0]!.decision).toBe('allowed')
    expect(applyStepLabels(labelled, audit, { 'bridge-9': 'Click checkbox “Email notifications”' })).toBe(labelled)
    expect(applyStepLabels(rows, audit, {})).toBe(rows)
    expect(applyStepLabels(rows, new Map(), { 'bridge-9': 'x' })).toBe(rows)
  })

  it('keeps a bounded, well-formed record of labels', async () => {
    expect(readStepLabels({ a: 'Click button “Save”', b: 7, c: '', d: 'x'.repeat(5_000) })).toEqual({ a: 'Click button “Save”' })
    expect(readStepLabels('nope')).toEqual({})
    let labels: Record<string, string> = {}
    for (let index = 0; index < MAX_STEP_LABELS + 5; index += 1) labels = withStepLabel(labels, `c${index}`, `label ${index}`)
    expect(Object.keys(labels)).toHaveLength(MAX_STEP_LABELS)
    expect(labels.c0).toBeUndefined()
    expect(labels[`c${MAX_STEP_LABELS + 4}`]).toBe(`label ${MAX_STEP_LABELS + 4}`)
    // The writer survives a failing store and keeps what an earlier worker stored.
    const stored: { value: unknown } = { value: { old: 'Click link “Orders”' } }
    const writer = new StepLabels({ read: async () => stored.value, write: async (value) => { stored.value = value } })
    writer.note('c1', 'Click button “Save settings”')
    await vi.waitFor(() => { expect(stored.value).toEqual({ old: 'Click link “Orders”', c1: 'Click button “Save settings”' }) })
    const broken = new StepLabels({ read: async () => { throw new Error('no store') }, write: async () => { throw new Error('no store') } })
    expect(() => { broken.note('c2', 'x') }).not.toThrow()
  })
})
