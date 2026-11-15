/**
 * The settings page's switch row: title, one help line, and a checkbox drawn
 * as a toggle. The whole row is the label, so clicking the text flips the
 * switch. A long explanation goes in `more` and sits behind "Learn more",
 * outside the label so opening it never flips the switch.
 */

import type { ReactNode } from 'react'
import { LearnMore } from './SettingsKit.tsx'

export function SettingToggle({ title, help, more, checked, disabled, onChange, children, after }: {
  title: string
  help: string
  /** The full explanation, shown on demand. */
  more?: ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  /** Extra detail lines under the help text (e.g. a live status). */
  children?: ReactNode
  /** Content under the row that belongs to this setting (a button, a list). */
  after?: ReactNode
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <label className="setting-toggle">
        <span className="setting-toggle-copy">
          <strong>{title}</strong>
          <small>{help}</small>
          {children}
        </span>
        <input className="setting-toggle-input" type="checkbox" role="switch" checked={checked} disabled={disabled === true}
          onChange={(event) => onChange(event.target.checked)} />
        <span className="setting-toggle-control" aria-hidden="true"><span /></span>
      </label>
      {more !== undefined && <LearnMore>{more}</LearnMore>}
      {after !== undefined && <div className="setting-row-body">{after}</div>}
    </div>
  )
}
