import { memo, useState } from 'react'
import type { PanelApi } from './api.ts'
import type { Row, ToolStep } from './events.ts'
import { MessageImages } from './MessageImages.tsx'
import type { PanelCopy } from './strings.ts'

/** One small glyph per kind of browser step. */
function StepIcon({ name }: { name: string }): React.JSX.Element {
  const paths: Record<string, string> = {
    pointer: 'M5 3.5v11.2l3.1-3 2.1 4.6 2-.9-2.1-4.5 4.3-.2Z',
    keyboard: 'M3 6h14v8H3Z M6 9h.01 M9 9h.01 M12 9h.01 M15 9h.01 M6.5 12h7',
    page: 'M5 3h7l3 3v11H5Z M12 3v3h3 M7.5 10h5 M7.5 13h5',
    nav: 'M10 3a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M3 10h14 M10 3c2.2 2 2.2 12 0 14 M10 3c-2.2 2-2.2 12 0 14',
    camera: 'M3.5 6.5h3l1.2-2h4.6l1.2 2h3v9h-13Z M10 8.5a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2',
    tabs: 'M3 7h14v9H3Z M3 7l1.5-3h5L11 7',
    wrench: 'M12.1 3.35a4 4 0 0 0-4.75 5.27l-4.1 4.1a1.85 1.85 0 1 0 2.62 2.62l4.1-4.1a4 4 0 0 0 5.25-4.78l-2.45 2.45-1.9-.5-.5-1.9 2.45-2.45a4 4 0 0 0-.72-.71Z',
  }
  const kind = /click|hover|drag|select|scroll/.test(name) ? 'pointer'
    : /type|press|clipboard|upload/.test(name) ? 'keyboard'
      : /screenshot/.test(name) ? 'camera'
        : /navigate|back|forward|reload|wait/.test(name) ? 'nav'
          : /tab/.test(name) ? 'tabs'
            : /snapshot|text|extract|pdf/.test(name) ? 'page'
              : 'wrench'
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d={paths[kind]} /></svg>
  )
}

const DECISION_TONE: Record<string, 'neutral' | 'good' | 'bad' | 'warn'> = {
  'not-required': 'neutral',
  'auto-allowed': 'neutral',
  'program-approved': 'good',
  allowed: 'good',
  denied: 'bad',
  'timed-out': 'warn',
  unavailable: 'warn',
  cancelled: 'warn',
  'held-expired': 'warn',
}

const POLICY_TONE: Record<string, 'neutral' | 'bad' | 'warn'> = {
  blocked: 'bad',
  tainted: 'warn',
  'site-ask': 'warn',
  'strict-armed': 'neutral',
  'strict-refused': 'bad',
}

/** Badges for the policy layer: site rules, taint review, strict mode. */
function policyBadges(step: ToolStep, copy: PanelCopy): Array<{ key: string; label: string; tone: string }> {
  const keys = [
    ...(step.policy !== undefined && step.policy !== 'site-trusted' ? [step.policy] : []),
    ...(step.strict === undefined ? [] : [`strict-${step.strict}`]),
  ]
  return keys.map((key) => ({ key, label: copy.timeline.policies[key] ?? key, tone: POLICY_TONE[key] ?? 'neutral' }))
}

const TimelineStep = memo(function TimelineStep({
  step,
  index,
  sessionId,
  api,
  copy,
}: {
  step: ToolStep
  index: number
  sessionId: string
  api: PanelApi
  copy: PanelCopy
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = step.args !== undefined || step.result !== undefined || (step.images?.length ?? 0) > 0
  const decision = step.decision === undefined ? undefined : copy.timeline.decisions[step.decision] ?? step.decision
  const tone = step.decision === undefined ? 'neutral' : DECISION_TONE[step.decision] ?? 'neutral'
  const detailsId = `step-${step.callId}-details`
  return (
    <li className={`timeline-step ${step.status}`}>
      <button
        type="button"
        className="timeline-step-head"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? detailsId : undefined}
        disabled={!expandable}
        title={expandable ? (open ? copy.timeline.collapse : copy.timeline.expand) : undefined}
        onClick={() => { setOpen((value) => !value) }}
      >
        <span className="timeline-step-icon"><StepIcon name={step.name} /></span>
        <span className="timeline-step-copy">
          <span className="timeline-step-label">
            <span className="timeline-step-index">{index + 1}</span>
            {step.label}
          </span>
          {step.target !== undefined && <code className="timeline-step-target" title={step.target}>{step.target}</code>}
        </span>
        <span className="timeline-step-meta">
          {policyBadges(step, copy).map((badge) => (
            <span key={badge.key} className={`decision-badge policy ${badge.tone}`}>{badge.label}</span>
          ))}
          {decision !== undefined && <span className={`decision-badge ${tone}`}>{decision}</span>}
          {step.status === 'running'
            ? <span className="spinner" aria-label={copy.timeline.running} />
            : step.status === 'error'
              ? <span className="timeline-step-failed">{copy.timeline.failed}</span>
              : null}
          {step.durationMs !== undefined && <span className="timeline-step-duration">{copy.timeline.duration(step.durationMs)}</span>}
        </span>
      </button>
      {(step.images?.length ?? 0) > 0 && !open && (
        <div className="timeline-step-thumb" aria-label={copy.timeline.screenshot}>
          <MessageImages images={step.images!.slice(0, 1)} sessionId={sessionId} api={api} align="start" copy={copy} />
        </div>
      )}
      {open && (
        <div className="timeline-step-details" id={detailsId}>
          {step.args !== undefined && (
            <>
              <span className="timeline-detail-label">{copy.timeline.arguments}</span>
              <pre>{step.args}</pre>
            </>
          )}
          {step.result !== undefined && (
            <>
              <span className="timeline-detail-label">{copy.timeline.result}</span>
              <pre>{step.result}</pre>
            </>
          )}
          {(step.images?.length ?? 0) > 0 && (
            <>
              <span className="timeline-detail-label">{copy.timeline.screenshot}</span>
              <MessageImages images={step.images!} sessionId={sessionId} api={api} align="start" copy={copy} />
            </>
          )}
        </div>
      )}
    </li>
  )
})

/** The expandable step timeline that replaces the collapsed "a → b → c" tool row. */
export const StepTimeline = memo(function StepTimeline({
  row,
  sessionId,
  api,
  copy,
}: {
  row: Row
  sessionId: string
  api: PanelApi
  copy: PanelCopy
}): React.JSX.Element {
  const steps = row.steps ?? []
  const running = row.status === 'running'
  return (
    <section className={`step-timeline ${running ? 'running' : 'complete'}`} aria-label={copy.timeline.title(steps.length)}>
      <header className="step-timeline-head" role="status">
        <span className="tool-label">{running ? copy.tool.running : copy.tool.complete}</span>
        <span className="step-timeline-count">{copy.timeline.title(steps.length)}</span>
      </header>
      <ol className="step-timeline-list">
        {steps.map((step, index) => (
          <TimelineStep key={step.callId} step={step} index={index} sessionId={sessionId} api={api} copy={copy} />
        ))}
      </ol>
    </section>
  )
})
