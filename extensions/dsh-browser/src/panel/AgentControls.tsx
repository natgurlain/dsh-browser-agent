import { memo } from 'react'
import type { AgentPauseState } from './api.ts'
import type { PanelCopy } from './strings.ts'

function PauseIcon(): React.JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10 M13 5v10" /></svg>
}

function HandIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 10V4.8a1.2 1.2 0 0 1 2.4 0V9 M9.4 9V3.8a1.2 1.2 0 0 1 2.4 0V9 M11.8 9V4.8a1.2 1.2 0 0 1 2.4 0V11c0 3.3-2.1 5.5-5 5.5-2 0-3.2-1-4.3-2.7L3.6 11a1.2 1.2 0 0 1 2-1.3L7 11.5" />
    </svg>
  )
}

function PlayIcon(): React.JSX.Element {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5v9l7-4.5Z" /></svg>
}

/**
 * Pause after this step, take over, resume. Visible while the agent works or
 * while it is paused; the pause itself lives in the background, so every
 * panel shows the same state.
 */
export const AgentControls = memo(function AgentControls({
  state,
  working,
  copy,
  onPause,
  onTakeOver,
  onResume,
}: {
  state: AgentPauseState
  working: boolean
  copy: PanelCopy
  onPause: () => void
  onTakeOver: () => void
  onResume: () => void
}): React.JSX.Element | null {
  const held = state.held.length
  if (state.mode === 'running') {
    if (!working) return null
    return (
      <section className="agent-controls running" aria-label={copy.agentControl.working}>
        <span className="agent-controls-status"><span className="agent-controls-dot" />{copy.agentControl.working}</span>
        <div className="agent-controls-actions">
          <button type="button" className="secondary" onClick={onPause} title={copy.agentControl.pauseAfterStepHint}>
            <PauseIcon />{copy.agentControl.pauseAfterStep}
          </button>
          <button type="button" className="secondary" onClick={onTakeOver} title={copy.agentControl.takeOverHint}>
            <HandIcon />{copy.agentControl.takeOver}
          </button>
        </div>
      </section>
    )
  }
  const takenOver = state.mode === 'taken-over' || (state.mode === 'resuming' && state.tookOver === true)
  return (
    <section className={`agent-controls paused${takenOver ? ' taken-over' : ''}`} role="status">
      <div className="agent-controls-copy">
        <strong>{takenOver ? copy.agentControl.takenOverTitle : copy.agentControl.pausedTitle}</strong>
        <span>{takenOver ? copy.agentControl.takenOverBody(held) : copy.agentControl.pausedBody(held)}</span>
      </div>
      <div className="agent-controls-actions">
        {state.mode === 'paused' && (
          <button type="button" className="secondary" onClick={onTakeOver} title={copy.agentControl.takeOverHint}>
            <HandIcon />{copy.agentControl.takeOver}
          </button>
        )}
        <button type="button" className="primary" disabled={state.mode === 'resuming'} onClick={onResume} title={copy.agentControl.resumeHint}>
          <PlayIcon />{state.mode === 'resuming' ? copy.agentControl.resuming : copy.agentControl.resume}
        </button>
      </div>
    </section>
  )
})
