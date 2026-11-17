/**
 * The composer's "Auto approve" toggle (docs/auto-approve-design.md §6): one
 * click turns it on or off for the conversation, with a single confirmation
 * the very first time it is switched on, and an unobtrusive line with a
 * one-click off while it is on. It stays on for the conversation (across
 * restarts) until the user turns it off; "Start conversations in Auto
 * approve" in Settings makes it the default.
 *
 * The background owns the state; this control only asks it to change.
 *
 * @module
 */

import { useEffect, useState } from 'react'
import type { AutoReviewState, PanelApi } from './api.ts'
import { autoApproveOnFor } from './auto-approve-state.ts'
import type { PanelCopy } from './strings.ts'

/** `chrome.storage.local` key: the user has confirmed Auto approve once (it is never asked again). */
export const AUTO_REVIEW_EXPLAINED_KEY = 'dshAutoApproveConfirmed'

function BoltIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" /></svg>
}

export function AutoApproveControl({ api, copy, sessionId, disabled }: {
  api: PanelApi
  copy: PanelCopy
  sessionId: string | null
  /** The composer is not ready (no session yet, switching). */
  disabled: boolean
}): React.JSX.Element | null {
  const [state, setState] = useState<AutoReviewState>({ offered: false, startOn: false, reviewer: false, sessions: {}, panel: [] })
  const [confirming, setConfirming] = useState(false)

  useEffect(() => api.onAutoReviewState(setState), [api])

  // Nothing at all where the administrator turned it off.
  if (!state.offered) return null
  const on = autoApproveOnFor(state, sessionId)

  const turnOn = async (): Promise<void> => {
    if (sessionId === null) return
    let confirmed = false
    try {
      confirmed = (await chrome.storage.local.get(AUTO_REVIEW_EXPLAINED_KEY))[AUTO_REVIEW_EXPLAINED_KEY] === true
    } catch { /* ask once */ }
    if (!confirmed) {
      setConfirming(true)
      return
    }
    await api.setAutoReview(sessionId, true)
  }
  const confirm = async (): Promise<void> => {
    setConfirming(false)
    if (sessionId === null) return
    try { await chrome.storage.local.set({ [AUTO_REVIEW_EXPLAINED_KEY]: true }) } catch { /* asked again next time */ }
    await api.setAutoReview(sessionId, true)
  }
  const turnOff = (): void => {
    if (sessionId !== null) void api.setAutoReview(sessionId, false)
  }

  return (
    <>
      <div className="composer-approvals">
        <button
          type="button"
          className={`composer-chip-trigger auto-approve-toggle${on ? ' auto-review-active' : ''}`}
          aria-pressed={on}
          title={on ? copy.autoReview.toggleOnHint : copy.autoReview.toggleOffHint}
          disabled={disabled || sessionId === null}
          onClick={() => { if (on) turnOff(); else void turnOn() }}
        >
          <BoltIcon />
          <span>{copy.autoReview.toggle}</span>
        </button>
      </div>
      {on ? (
        <div className="composer-chip-note auto-review-indicator" role="status">
          <span className="auto-review-dot" aria-hidden="true" />
          <span>{state.reviewer ? copy.autoReview.on : `${copy.autoReview.on} ${copy.autoReview.reviewerMissing}`}</span>
          <button type="button" onClick={turnOff}>{copy.autoReview.turnOff}</button>
        </div>
      ) : null}
      {confirming ? (
        <div className="approval-backdrop">
          <section className="approval-dialog auto-review-dialog" role="alertdialog" aria-modal="true" aria-labelledby="auto-review-title">
            <div className="approval-rail" aria-hidden="true" />
            <div className="approval-heading">
              <div>
                <h2 id="auto-review-title">{copy.autoReview.dialogTitle}</h2>
              </div>
            </div>
            <p className="auto-review-dialog-text">{copy.autoReview.dialogBody}</p>
            <div className="approval-actions">
              <button className="deny" onClick={() => { setConfirming(false) }}>{copy.autoReview.dialogCancel}</button>
              <button className="allow" autoFocus onClick={() => { void confirm() }}>{copy.autoReview.dialogConfirm}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
