// @vitest-environment jsdom
/**
 * The panel side of Auto approve: the composer toggle (one confirmation the
 * first time, then one click on or off; on for the conversation without
 * re-arming; the Setting as default), the timeline's Auto badge and lines
 * ("Auto-approved", "Auto-approved after a check", the reviewer's note in
 * the details, "Checking…" while it runs), and the audit join.
 */
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_REVIEW_EXPLAINED_KEY, AutoApproveControl } from '../src/panel/AutoApproveControl.tsx'
import { StepTimeline } from '../src/panel/StepTimeline.tsx'
import { connectPanel, parseAutoReviewState, type AutoReviewState, type PanelApi } from '../src/panel/api.ts'
import { autoApproveOnFor } from '../src/panel/auto-approve-state.ts'
import { applyStepAudit, auditByCall, type Row } from '../src/panel/events.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'
import { fakePanelApi } from './support/panel-api.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement
let stored: Record<string, unknown> = {}

beforeEach(() => {
  stored = {}
  host = document.createElement('div')
  document.body.appendChild(host)
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(stored, items) }),
      },
    },
  })
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host.remove()
  vi.unstubAllGlobals()
})

async function mount(api: PanelApi, sessionId: string | null = 's1'): Promise<void> {
  await act(async () => {
    root = createRoot(host)
    root.render(createElement(AutoApproveControl, { api, copy: PANEL_COPY.en, sessionId, disabled: false }))
  })
}

function controllableApi(): { api: PanelApi & { setAutoReview: ReturnType<typeof vi.fn> }; push: (state: AutoReviewState) => void } {
  let listener: ((state: AutoReviewState) => void) | undefined
  const api = fakePanelApi({
    onAutoReviewState: vi.fn((callback: (state: AutoReviewState) => void) => { listener = callback; return () => { listener = undefined } }),
    setAutoReview: vi.fn(async () => {}),
  }) as PanelApi & { setAutoReview: ReturnType<typeof vi.fn> }
  return { api, push: (state) => { act(() => { listener?.(state) }) } }
}

const toggle = () => host.querySelector<HTMLButtonElement>('.auto-approve-toggle')!
const STATE: AutoReviewState = { offered: true, startOn: false, reviewer: true, sessions: {} }

describe('the Auto approve toggle', () => {
  it('confirms once the first time, then one click turns it on or off; the line offers one-click off', async () => {
    const { api, push } = controllableApi()
    await mount(api)
    push(STATE)
    expect(toggle().textContent).toBe('Auto approve')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    await act(async () => { toggle().click() })
    // One confirmation, in plain words, with the trade-off.
    const dialog = document.querySelector('.auto-review-dialog')!
    expect(dialog.textContent).toContain('The agent will act without asking you first.')
    expect(dialog.textContent).toContain('A web page that tricks the model can make it do things you did not ask for.')
    expect(api.setAutoReview).not.toHaveBeenCalled()
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Turn on')!.click() })
    expect(api.setAutoReview).toHaveBeenCalledWith('s1', true)
    expect(stored[AUTO_REVIEW_EXPLAINED_KEY]).toBe(true)

    push({ ...STATE, sessions: { s1: true } })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('.auto-review-indicator')!.textContent).toContain('Auto approve is on: the agent acts without asking.')
    // No timer, no expiry: nothing counts down.
    expect(host.textContent).not.toMatch(/min left|minutes/u)
    await act(async () => { host.querySelector<HTMLButtonElement>('.auto-review-indicator button')!.click() })
    expect(api.setAutoReview).toHaveBeenLastCalledWith('s1', false)

    // Confirmed already: the next turn-on is one click, no dialog.
    push({ ...STATE, sessions: { s1: false } })
    await act(async () => { toggle().click() })
    expect(document.querySelector('.auto-review-dialog')).toBeNull()
    expect(api.setAutoReview).toHaveBeenLastCalledWith('s1', true)
  })

  it('follows "Start conversations in Auto approve" until the user chooses; says when the reviewer is missing; hidden when managed', async () => {
    const { api, push } = controllableApi()
    await mount(api)
    push({ ...STATE, startOn: true })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    push({ ...STATE, startOn: true, sessions: { s1: false } })
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    push({ ...STATE, startOn: true, reviewer: false })
    expect(host.querySelector('.auto-review-indicator')!.textContent).toContain('Steps that send, delete or pay still ask')
    push({ offered: false, unavailable: 'managed', startOn: true, reviewer: true, sessions: {} })
    expect(host.querySelector('.auto-approve-toggle')).toBeNull()
  })

  it('reads the background state defensively; every string exists in both languages', () => {
    expect(parseAutoReviewState({ offered: 'yes', unavailable: 'nope', startOn: 1, sessions: { a: true, b: 'x', c: { on: true } } }))
      .toEqual({ offered: false, startOn: false, reviewer: false, sessions: { a: true } })
    expect(autoApproveOnFor({ ...STATE, startOn: true }, 'new')).toBe(true)
    expect(autoApproveOnFor({ ...STATE, startOn: true, offered: false }, 'new')).toBe(false)
    expect(autoApproveOnFor({ ...STATE, sessions: { a: true } }, 'a')).toBe(true)
    expect(autoApproveOnFor(STATE, null)).toBe(false)
    expect(Object.keys(PANEL_COPY.zh.autoReview).sort()).toEqual(Object.keys(PANEL_COPY.en.autoReview).sort())
    expect(PANEL_COPY.en.autoReview.toggle).toBe('Auto approve')
    expect(PANEL_COPY.zh.autoReview.toggle).toBe('自动批准')
    expect(PANEL_COPY.en.autoReview.settingTitle).toBe('Start conversations in Auto approve')
    expect(PANEL_COPY.en.autoReview.settingHelp).toBe('With Auto approve on, the agent acts without asking; a web page that tricks the model can make it do things you did not ask for.')
    // With Auto approve on, the taint banner does not promise cards that will not come.
    expect(PANEL_COPY.en.taint.bodyAuto('a.example')).toContain('Auto approve checks risky actions before they run')
    expect(PANEL_COPY.zh.taint.bodyAuto('a.example')).toContain('自动批准')
    for (const decision of ['auto-approved', 'auto-reviewed']) {
      expect(PANEL_COPY.en.timeline.decisions[decision]).toBeTruthy()
      expect(PANEL_COPY.zh.timeline.decisions[decision]).toBeTruthy()
    }
  })
})

describe('the timeline', () => {
  const row = (decision: string | undefined, extra: Record<string, unknown> = {}): Row => ({
    kind: 'tool', id: 'r', status: 'complete',
    steps: [{ callId: 'call_1', name: 'browser_click', label: 'Click button “Send”', status: 'ok', ...decision === undefined ? {} : { decision }, ...extra }],
  } as unknown as Row)
  const render = (value: Row) => renderToStaticMarkup(createElement(StepTimeline, { row: value, sessionId: 's1', api: fakePanelApi(), copy: PANEL_COPY.en }))

  it('marks an auto-approved step with the Auto badge and one line', () => {
    const [decorated] = applyStepAudit([row(undefined)], auditByCall([{ kind: 'approval', callId: 'b1', toolCallId: 'call_1', decision: 'auto-approved' }]))
    const html = render(decorated!)
    expect(html).toContain('auto-review-badge')
    expect(html).toContain('>Auto<')
    expect(html).toContain('Auto-approved')
    expect(html).not.toContain('after a check')
  })

  it('marks a reviewed step, with the reviewer\'s verdict joined from the audit log behind the details', () => {
    const audit = auditByCall([
      { kind: 'auto-review', callId: 'b1', toolCallId: 'call_1', decision: 'allow', reason: 'You asked to send\nit.' },
      { kind: 'approval', callId: 'b1', toolCallId: 'call_1', decision: 'auto-reviewed' },
    ])
    const [decorated] = applyStepAudit([row(undefined)], audit)
    expect(decorated!.steps![0]).toMatchObject({ decision: 'auto-reviewed', autoReason: 'You asked to send it.' })
    const html = render(decorated!)
    expect(html).toContain('Auto-approved after a check')
    // The model's words only in the details, attributed.
    expect(html).not.toContain('You asked to send it.')
  })

  it('shows "Checking…" on the running step instead of a card', () => {
    const html = renderToStaticMarkup(createElement(StepTimeline, {
      row: row(undefined, { status: 'running' }), sessionId: 's1', api: fakePanelApi(), copy: PANEL_COPY.zh, reviewing: new Set(['call_1']),
    }))
    expect(html).toContain('正在检查…')
  })
})

describe('the panel API', () => {
  it('replays the latest state to a toggle that mounts after it arrived; relays "Checking…"', () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = { postMessage, onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) }, onDisconnect: { addListener: vi.fn() } }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    const api = connectPanel()
    receive?.({ type: 'auto-review.state', offered: true, startOn: false, reviewer: true, sessions: { s1: true } })
    const seen: AutoReviewState[] = []
    api.onAutoReviewState((state) => { seen.push(state) })
    expect(seen).toEqual([{ offered: true, startOn: false, reviewer: true, sessions: { s1: true } }])
    void api.setAutoReview('s1', false)
    expect(postMessage.mock.calls.map(([message]) => message as Record<string, unknown>)).toContainEqual(expect.objectContaining({ type: 'auto-review.set', sessionId: 's1', enabled: false }))
    const reviewing: unknown[] = []
    api.onAutoReviewing((value) => { reviewing.push(value) })
    receive?.({ type: 'auto-review.reviewing', sessionId: 's1', toolCallId: 'c', label: 'Click', active: true })
    receive?.({ type: 'auto-review.reviewing', label: 'no session' })
    expect(reviewing).toEqual([{ sessionId: 's1', toolCallId: 'c', label: 'Click', active: true }])
  })
})
