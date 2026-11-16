/**
 * The composer's "Approvals: Ask · Auto" control (docs/auto-review-design.md
 * §7): per conversation, off by default, a one-time explanation before the
 * first use, a one-line reason when it cannot be turned on, and an
 * unobtrusive "Auto review on" line with a one-click off while it is on.
 *
 * The background owns the state; this control only asks it to change.
 *
 * @module
 */

import { useEffect, useRef, useState } from 'react'
import type { AutoReviewAvailability, AutoReviewState, PanelApi } from './api.ts'
import type { PanelCopy } from './strings.ts'

/** `chrome.storage.local` key: the user has read the explanation once. */
export const AUTO_REVIEW_EXPLAINED_KEY = 'dshAutoReviewExplained'

function ChevronDownIcon(): React.JSX.Element {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
}

/** The reason line for a disabled control, if any. */
export function autoReviewBlocker(state: AutoReviewState, availability: AutoReviewAvailability | undefined, copy: PanelCopy): string | undefined {
  if (!state.offered) return copy.autoReview.unavailable[state.unavailable ?? 'bridge'] ?? copy.autoReview.unavailable.bridge
  if (availability === undefined || availability.available || availability.reason === 'not-started') return undefined
  return copy.autoReview.unavailable[availability.reason ?? 'bridge'] ?? copy.autoReview.unavailable.bridge
}

export function AutoReviewControl({ api, copy, sessionId, disabled }: {
  api: PanelApi
  copy: PanelCopy
  sessionId: string | null
  /** The composer is not ready (no session yet, switching). */
  disabled: boolean
}): React.JSX.Element | null {
  const [state, setState] = useState<AutoReviewState>({ offered: false, sessions: {} })
  const [availability, setAvailability] = useState<AutoReviewAvailability | undefined>(undefined)
  const [menu, setMenu] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => api.onAutoReviewState((next) => {
    setState(next)
    setNow(Date.now())
  }), [api])
  // The status depends on the conversation and the bridge; ask again when either changes.
  useEffect(() => {
    if (sessionId === null || !state.offered) {
      setAvailability(undefined)
      return
    }
    let live = true
    void api.autoReviewStatus(sessionId).then((value) => { if (live) setAvailability(value) })
    return () => { live = false }
  }, [api, sessionId, state.offered])
  // Minutes left tick once a minute.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [menu])

  // Nothing at all where the Setting or the administrator turned it off.
  if (state.unavailable === 'setting' || state.unavailable === 'managed') return null
  const session = sessionId === null ? undefined : state.sessions[sessionId]
  const on = session?.on === true
  const blocker = autoReviewBlocker(state, availability, copy)
  const minutesLeft = session?.expiresAt === undefined ? 0 : Math.min(60, Math.max(1, Math.ceil((session.expiresAt - now) / 60_000)))
  const ended = !on && session?.ended !== undefined && session.ended !== 'user' ? copy.autoReview.ended[session.ended] : undefined
  // Auto approves only in the conversation a panel shows; say where else it is on, with one click off.
  const others = Object.entries(state.sessions).filter(([id, view]) => id !== sessionId && view.on).length

  const turnOn = async (): Promise<void> => {
    setMenu(false)
    if (sessionId === null) return
    let explained = false
    try {
      explained = (await chrome.storage.local.get(AUTO_REVIEW_EXPLAINED_KEY))[AUTO_REVIEW_EXPLAINED_KEY] === true
    } catch { /* show the explanation */ }
    if (!explained) {
      setExplaining(true)
      return
    }
    await api.setAutoReview(sessionId, true)
  }
  const confirm = async (): Promise<void> => {
    setExplaining(false)
    if (sessionId === null) return
    try { await chrome.storage.local.set({ [AUTO_REVIEW_EXPLAINED_KEY]: true }) } catch { /* ask again next time */ }
    await api.setAutoReview(sessionId, true)
  }
  const turnOff = (): void => {
    setMenu(false)
    if (sessionId !== null) void api.setAutoReview(sessionId, false)
  }

  return (
    <>
      <div className="composer-approvals" ref={ref}>
        <button
          type="button"
          className={`composer-chip-trigger${on ? ' auto-review-active' : ''}`}
          aria-expanded={menu}
          aria-haspopup="listbox"
          aria-label={copy.autoReview.control}
          title={blocker ?? (on ? copy.autoReview.on(minutesLeft) : copy.autoReview.chipAsk)}
          disabled={disabled || sessionId === null || (blocker !== undefined && !on)}
          onClick={() => { setMenu((open) => !open) }}
        >
          <span>{on ? copy.autoReview.chipAuto : copy.autoReview.chipAsk}</span>
          <ChevronDownIcon />
        </button>
        {menu ? (
          <div className="composer-chip-menu auto-review-menu" role="listbox" aria-label={copy.autoReview.control}>
            <button type="button" role="option" aria-selected={!on} className={on ? undefined : 'isSelected'} onClick={turnOff}>
              <span>{copy.autoReview.optionAsk}</span>
              <small>{copy.autoReview.optionAskHelp}</small>
            </button>
            <button type="button" role="option" aria-selected={on} className={on ? 'isSelected' : undefined} disabled={blocker !== undefined} onClick={() => { void turnOn() }}>
              <span>{copy.autoReview.optionAuto}</span>
              <small>{copy.autoReview.optionAutoHelp}</small>
            </button>
            {availability?.reason === 'not-started' ? <div className="chip-menu-footnote">{copy.autoReview.notStarted}</div> : null}
          </div>
        ) : null}
      </div>
      {on ? (
        <div className="composer-chip-note auto-review-indicator" role="status">
          <span className="auto-review-dot" aria-hidden="true" />
          <span>{copy.autoReview.on(minutesLeft)}</span>
          <button type="button" onClick={turnOff}>{copy.autoReview.turnOff}</button>
        </div>
      ) : blocker !== undefined && sessionId !== null && state.offered ? (
        <div className="composer-chip-note">{blocker}</div>
      ) : ended !== undefined ? (
        <div className="composer-chip-note">{ended}</div>
      ) : null}
      {others > 0 ? (
        <div className="composer-chip-note auto-review-others" role="status">
          <span>{copy.autoReview.otherOn(others)}</span>
          <button type="button" onClick={() => { void api.setAutoReviewAll(false) }}>{copy.autoReview.turnAllOff}</button>
        </div>
      ) : null}
      {explaining ? (
        <div className="approval-backdrop">
          <section className="approval-dialog auto-review-dialog" role="alertdialog" aria-modal="true" aria-labelledby="auto-review-title">
            <div className="approval-rail" aria-hidden="true" />
            <div className="approval-heading">
              <div>
                <span className="eyebrow">{copy.autoReview.control}</span>
                <h2 id="auto-review-title">{copy.autoReview.dialogTitle}</h2>
              </div>
            </div>
            {copy.autoReview.dialogBody.map((paragraph) => <p key={paragraph} className="auto-review-dialog-text">{paragraph}</p>)}
            <div className="approval-actions">
              <button className="deny" autoFocus onClick={() => { setExplaining(false) }}>{copy.autoReview.dialogCancel}</button>
              <button className="allow" onClick={() => { void confirm() }}>{copy.autoReview.dialogConfirm}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
