// @vitest-environment jsdom
/**
 * The panel side of Auto review: the composer control (off by default, a
 * one-time explanation, a reason when it cannot be used, one-click off), the
 * timeline's Auto badge, reason and "Reviewing…", and the audit join.
 */
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_REVIEW_EXPLAINED_KEY, AutoReviewControl, autoReviewBlocker } from '../src/panel/AutoReviewControl.tsx'
import { StepTimeline } from '../src/panel/StepTimeline.tsx'
import { connectPanel, parseAutoReviewState, type AutoReviewState, type PanelApi } from '../src/panel/api.ts'
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
    root.render(createElement(AutoReviewControl, { api, copy: PANEL_COPY.en, sessionId, disabled: false }))
  })
}

function controllableApi(available = true): { api: PanelApi & { setAutoReview: ReturnType<typeof vi.fn> }; push: (state: AutoReviewState) => void } {
  let listener: ((state: AutoReviewState) => void) | undefined
  const api = fakePanelApi({
    onAutoReviewState: vi.fn((callback: (state: AutoReviewState) => void) => { listener = callback; return () => { listener = undefined } }),
    autoReviewStatus: vi.fn(async () => available ? { available: true, model: 'acme/m' } : { available: false, reason: 'no-model' }),
    setAutoReview: vi.fn(async () => {}),
  }) as PanelApi & { setAutoReview: ReturnType<typeof vi.fn> }
  return { api, push: (state) => { act(() => { listener?.(state) }) } }
}

const trigger = () => host.querySelector<HTMLButtonElement>('.composer-approvals .composer-chip-trigger')!
const option = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.auto-review-menu button')].find((button) => button.textContent?.startsWith(label))

describe('the Approvals control', () => {
  it('starts on Ask, explains Auto once before turning it on, and then turns it on directly', async () => {
    const { api, push } = controllableApi()
    await mount(api)
    push({ offered: true, sessions: {} })
    await act(async () => {})
    expect(trigger().textContent).toBe('Approvals: Ask')
    expect(trigger().disabled).toBe(false)
    await act(async () => { trigger().click() })
    await act(async () => { option('Auto review')!.click() })
    // The explanation names the cost and what is sent.
    const dialog = document.querySelector('.auto-review-dialog')!
    expect(dialog.textContent).toContain('one extra call')
    expect(dialog.textContent).toContain('page address')
    expect(api.setAutoReview).not.toHaveBeenCalled()
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Turn on Auto review')!.click() })
    expect(api.setAutoReview).toHaveBeenCalledWith('s1', true)
    expect(stored[AUTO_REVIEW_EXPLAINED_KEY]).toBe(true)

    push({ offered: true, sessions: { s1: { on: true, expiresAt: Date.now() + 29.5 * 60_000 } } })
    expect(trigger().textContent).toBe('Approvals: Auto')
    expect(host.querySelector('.auto-review-indicator')!.textContent).toContain('Auto review on · 30 min left')
    // One click off.
    await act(async () => { host.querySelector<HTMLButtonElement>('.auto-review-indicator button')!.click() })
    expect(api.setAutoReview).toHaveBeenLastCalledWith('s1', false)

    // Explained already: the next turn-on needs no dialog.
    push({ offered: true, sessions: { s1: { on: false } } })
    await act(async () => { trigger().click() })
    await act(async () => { option('Auto review')!.click() })
    expect(document.querySelector('.auto-review-dialog')).toBeNull()
    expect(api.setAutoReview).toHaveBeenLastCalledWith('s1', true)
  })

  it('is disabled with a one-line reason when the conversation cannot be reviewed', async () => {
    const { api, push } = controllableApi(false)
    await mount(api)
    push({ offered: true, sessions: {} })
    await act(async () => {})
    expect(trigger().disabled).toBe(true)
    expect(host.textContent).toContain('Choose a model for this conversation first.')
  })

  it('says why it ended, and hides itself where Settings or the administrator turned it off', async () => {
    const { api, push } = controllableApi()
    await mount(api)
    push({ offered: true, sessions: { s1: { on: false, ended: 'expired' } } })
    expect(host.textContent).toContain('Auto review ended after 60 minutes')
    push({ offered: false, unavailable: 'managed', sessions: {} })
    expect(host.querySelector('.composer-approvals')).toBeNull()
    push({ offered: false, unavailable: 'bridge', sessions: {} })
    expect(trigger().disabled).toBe(true)
    expect(trigger().title).toBe('Update the DSH browser bridge to use Auto review.')
  })

  it('reads the background state defensively and has every reason in both languages', () => {
    expect(parseAutoReviewState({ offered: 'yes', unavailable: 'nope', sessions: { a: { on: true, expiresAt: 5 }, b: 'x' } }))
      .toEqual({ offered: false, sessions: { a: { on: true, expiresAt: 5 } } })
    for (const reason of ['setting', 'managed', 'kill-switch', 'disconnected', 'bridge', 'host-unsupported', 'no-model', 'external-session', 'disabled']) {
      expect(PANEL_COPY.en.autoReview.unavailable[reason]).toBeTruthy()
      expect(PANEL_COPY.zh.autoReview.unavailable[reason]).toBeTruthy()
    }
    expect(Object.keys(PANEL_COPY.zh.autoReview).sort()).toEqual(Object.keys(PANEL_COPY.en.autoReview).sort())
    expect(autoReviewBlocker({ offered: true, sessions: {} }, { available: false, reason: 'not-started' }, PANEL_COPY.en)).toBeUndefined()
  })
})

describe('the timeline', () => {
  const row = (decision: string | undefined, extra: Record<string, unknown> = {}): Row => ({
    kind: 'tool', id: 'r', status: 'complete',
    steps: [{ callId: 'call_1', name: 'browser_click', label: 'Click button “Show more”', status: 'ok', ...decision === undefined ? {} : { decision }, ...extra }],
  } as unknown as Row)

  it('shows the Auto badge and the reviewer\'s reason, joined from the audit log', () => {
    const audit = auditByCall([
      { kind: 'auto-review', callId: 'b1', toolCallId: 'call_1', decision: 'allow', reason: 'Opens the list\nyou asked for.' },
      { kind: 'approval', callId: 'b1', toolCallId: 'call_1', decision: 'auto-reviewed' },
    ])
    const [decorated] = applyStepAudit([row(undefined)], audit)
    const html = renderToStaticMarkup(createElement(StepTimeline, { row: decorated!, sessionId: 's1', api: fakePanelApi(), copy: PANEL_COPY.en }))
    expect(html).toContain('auto-review-badge')
    expect(html).toContain('>Auto<')
    // A fixed line on the row; the reviewer's own words only in the details.
    expect(html).toContain('Approved by Auto review')
    expect(html).not.toContain('Opens the list')
  })

  it('shows "Reviewing…" on the running step instead of a card', () => {
    const html = renderToStaticMarkup(createElement(StepTimeline, {
      row: row(undefined, { status: 'running' }), sessionId: 's1', api: fakePanelApi(), copy: PANEL_COPY.zh, reviewing: new Set(['call_1']),
    }))
    expect(html).toContain('正在审核…')
  })
})

describe('the panel API', () => {
  it('replays the latest state to a control that mounts after it arrived, and answers status requests', async () => {
    let receive: ((message: unknown) => void) | undefined
    const postMessage = vi.fn()
    const port = { postMessage, onMessage: { addListener: vi.fn((listener: (message: unknown) => void) => { receive = listener }) }, onDisconnect: { addListener: vi.fn() } }
    vi.stubGlobal('chrome', { runtime: { connect: vi.fn(() => port) } })
    const api = connectPanel()
    receive?.({ type: 'auto-review.state', offered: true, sessions: { s1: { on: true, expiresAt: 9 } } })
    const seen: AutoReviewState[] = []
    api.onAutoReviewState((state) => { seen.push(state) })
    expect(seen).toEqual([{ offered: true, sessions: { s1: { on: true, expiresAt: 9 } } }])
    const status = api.autoReviewStatus('s1')
    const request = postMessage.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.type === 'auto-review.status')!
    receive?.({ type: 'auto-review.status.result', id: request.id, available: false, reason: 'no-model' })
    await expect(status).resolves.toEqual({ available: false, reason: 'no-model' })
    const reviewing: unknown[] = []
    api.onAutoReviewing((value) => { reviewing.push(value) })
    receive?.({ type: 'auto-review.reviewing', sessionId: 's1', toolCallId: 'c', label: 'Click', active: true })
    receive?.({ type: 'auto-review.reviewing', label: 'no session' })
    expect(reviewing).toEqual([{ sessionId: 's1', toolCallId: 'c', label: 'Click', active: true }])
  })
})
