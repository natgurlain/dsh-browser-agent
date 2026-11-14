// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentControls } from '../src/panel/AgentControls.tsx'
import { StepTimeline } from '../src/panel/StepTimeline.tsx'
import { parsePauseState, type PanelApi } from '../src/panel/api.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'

const render = (props: Partial<Parameters<typeof AgentControls>[0]> & { state: Parameters<typeof AgentControls>[0]['state'] }) =>
  renderToStaticMarkup(createElement(AgentControls, {
    working: false,
    copy: PANEL_COPY.en,
    onPause: vi.fn(),
    onTakeOver: vi.fn(),
    onResume: vi.fn(),
    ...props,
  }))

describe('AgentControls', () => {
  it('offers pause and take over only while the agent works', () => {
    expect(render({ state: { mode: 'running', held: [] } })).toBe('')
    const working = render({ state: { mode: 'running', held: [] }, working: true })
    expect(working).toContain('Pause after this step')
    expect(working).toContain('Take over')
  })

  it('shows held steps and Resume while paused or taken over, in both languages', () => {
    const held = [{ id: 'a', name: 'browser_click', heldAt: 1 }]
    const paused = render({ state: { mode: 'paused', held } })
    expect(paused).toContain('1 browser action is waiting for you.')
    expect(paused).toContain('Take over')
    expect(paused).toContain('Resume')
    const takenOver = render({ state: { mode: 'taken-over', held: [] }, copy: PANEL_COPY.zh })
    expect(takenOver).toContain('由你接管')
    expect(takenOver).toContain('继续')
    expect(takenOver).not.toContain('接管</button>')
    const resuming = render({ state: { mode: 'resuming', tookOver: true, held } })
    expect(resuming).toContain('Resuming…')
    expect(resuming).toContain('disabled')
  })

  it('parses pause state defensively', () => {
    expect(parsePauseState(null)).toEqual({ mode: 'running', held: [] })
    expect(parsePauseState({ mode: 'taken-over', since: 3, tookOver: true, held: [{ id: 'a', name: 'x', heldAt: 1 }, { bad: true }] }))
      .toEqual({ mode: 'taken-over', since: 3, tookOver: true, held: [{ id: 'a', name: 'x', heldAt: 1 }] })
    expect(parsePauseState({ mode: 'weird' }).mode).toBe('running')
  })
})

describe('StepTimeline', () => {
  it('renders one row per step with target, decision badge, duration, and failure', () => {
    const html = renderToStaticMarkup(createElement(StepTimeline, {
      row: {
        seq: 1,
        kind: 'tool',
        text: '',
        status: 'complete',
        steps: [
          { callId: 'a', name: 'browser_click', label: 'Click element', target: '#7', status: 'ok', decision: 'allowed', durationMs: 1234, args: '{}' },
          { callId: 'b', name: 'browser_type', label: 'Enter text', status: 'error', decision: 'denied', durationMs: 80 },
          { callId: 'c', name: 'browser_navigate', label: 'Open page', status: 'error', policy: 'blocked', strict: 'refused' },
          { callId: 'd', name: 'browser_click', label: 'Click element', status: 'ok', policy: 'tainted', decision: 'allowed' },
        ],
      },
      sessionId: 's',
      api: {} as PanelApi,
      copy: PANEL_COPY.en,
    }))
    expect(html).toContain('4 browser steps')
    expect(html).toContain('policy bad">Blocked by site policy')
    expect(html).toContain('policy bad">Strict mode: refused')
    expect(html).toContain('policy warn">Needs review (tainted)')
    expect(html).toContain('#7')
    expect(html).toContain('decision-badge good">Approved')
    expect(html).toContain('decision-badge bad">Denied')
    expect(html).toContain('1.2 s')
    expect(html).toContain('80 ms')
    expect(html).toContain('Failed')
    expect(html).toContain('aria-expanded="false"')
  })
})
