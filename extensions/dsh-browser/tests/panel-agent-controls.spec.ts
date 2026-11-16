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

  it('keeps a denied step readable in a narrow panel: the label has a floor and the badges wrap under it', async () => {
    // The row of the launch demo: three badges that used to squeeze "Open page" into a column of letters.
    const html = renderToStaticMarkup(createElement(StepTimeline, {
      row: {
        seq: 1, kind: 'tool', text: '', status: 'complete',
        steps: [{ callId: 'n', name: 'browser_navigate', label: 'Open page', target: 'verify.example.test/verify', status: 'error', policy: 'tainted', decision: 'denied', durationMs: 6700 }],
      },
      sessionId: 's',
      api: {} as PanelApi,
      copy: PANEL_COPY.en,
    }))
    const host = document.createElement('div')
    host.innerHTML = html
    // Label and badges are siblings in one wrapping row beside the icon.
    const body = host.querySelector('.timeline-step-head > .timeline-step-body')!
    expect([...body.children].map((child) => child.className)).toEqual(['timeline-step-copy', 'timeline-step-meta'])
    expect(body.querySelector('.timeline-step-copy .timeline-step-label .timeline-step-text')?.textContent).toBe('Open page')
    expect([...body.querySelectorAll('.timeline-step-meta > *')].map((el) => el.textContent)).toEqual(['Needs review (tainted)', 'Denied', 'Failed', '6.7 s'])
    // jsdom has no layout, so the rules that make the row hold are asserted as written
    // (screenshots at 320 to 600 px were checked by eye when they were introduced).
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(import.meta.dirname, '../src/panel/styles.css'), 'utf8')
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`)
      expect(start, selector).toBeGreaterThanOrEqual(0)
      return css.slice(start, css.indexOf('}', start))
    }
    expect(rule('.timeline-step-body')).toContain('flex-wrap: wrap')
    expect(rule('.timeline-step-copy')).toContain('min-width: min(100%, calc(96px * var(--ui-scale)))')
    expect(rule('.timeline-step-copy')).toContain('flex: 1 1 auto')
    expect(rule('.timeline-step-text')).toContain('overflow-wrap: break-word')
    expect(rule('.timeline-step-target')).toContain('width: 0')
    expect(rule('.timeline-step-meta')).toContain('flex-wrap: wrap')
    expect(rule('.timeline-step-meta')).toContain('max-width: 100%')
    expect(rule('.timeline-step-meta .decision-badge')).toContain('text-overflow: ellipsis')
  })
})
