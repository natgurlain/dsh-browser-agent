/**
 * The settings page's switch row: title, help line(s), and a checkbox drawn
 * as a toggle. Shared by every settings section.
 */

import type { ReactNode } from 'react'

export function SettingToggle({ title, help, checked, disabled, onChange, children }: {
  title: string
  help: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  /** Extra detail lines under the help text (e.g. a live status). */
  children?: ReactNode
}): React.JSX.Element {
  return (
    <label className="setting-toggle">
      <span className="setting-toggle-copy">
        <strong>{title}</strong>
        <small>{help}</small>
        {children}
      </span>
      <input className="setting-toggle-input" type="checkbox" checked={checked} disabled={disabled === true}
        onChange={(event) => onChange(event.target.checked)} />
      <span className="setting-toggle-control" aria-hidden="true"><span /></span>
    </label>
  )
}
