/**
 * Building blocks of the Settings view. Every setting is drawn from these, so
 * the page keeps one layout:
 *
 *   SettingsSection   collapsible, named section (open state is remembered)
 *     SettingsGroup   one card of rows, optionally titled
 *       SettingRow    label + one-line help, control on the right, long
 *                     explanation behind "Learn more", wide content below
 *       SettingToggle (SettingToggle.tsx) the same row with a switch
 *
 * Lists of sites use EntryAdd (input, optional select, Add, inline validation)
 * and EntryList (removable rows). Warnings use Callout.
 */

import { createContext, useContext, useId, useState, type ReactNode } from 'react'

/** Copy the kit itself shows; the App provides the current language. */
export interface SettingsKitCopy {
  learnMore: string
}

export const SettingsKitCopyContext = createContext<SettingsKitCopy>({ learnMore: 'Learn more' })

const SECTION_STATE_KEY = 'dshPanelSettingsSections'

function readSectionState(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SECTION_STATE_KEY) ?? '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, boolean> : {}
  } catch {
    return {}
  }
}

function rememberSectionState(id: string, open: boolean): void {
  try {
    globalThis.localStorage?.setItem(SECTION_STATE_KEY, JSON.stringify({ ...readSectionState(), [id]: open }))
  } catch {
    // Remembering which sections are open is a convenience only.
  }
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg className="settings-chevron" viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7 4.5 5.5 5.5L7 15.5" />
    </svg>
  )
}

/** A named, collapsible section. Its open state survives closing the panel. */
export function SettingsSection({ id, title, help, defaultOpen = true, children }: {
  id: string
  title: string
  /** One sentence under the title. */
  help: string
  defaultOpen?: boolean
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(() => readSectionState()[id] ?? defaultOpen)
  return (
    <details className="settings-section" data-section={id} open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next === open) return
        setOpen(next)
        rememberSectionState(id, next)
      }}>
      <summary>
        <span className="settings-section-title">
          <h2>{title}</h2>
          <ChevronIcon />
        </span>
        <span className="settings-section-help">{help}</span>
      </summary>
      <div className="settings-section-body">{children}</div>
    </details>
  )
}

/** One card of rows. `note` sits beside the title (e.g. "Applies immediately"). */
export function SettingsGroup({ title, note, className, label, children }: {
  title?: string
  note?: string
  className?: string
  /** Accessible name when the group has no visible title. */
  label?: string
  children: ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section className={`settings-group${className === undefined ? '' : ` ${className}`}`}
      {...(title !== undefined ? { 'aria-labelledby': headingId } : label !== undefined ? { 'aria-label': label } : {})}>
      {(title !== undefined || note !== undefined) && (
        <div className="settings-group-head">
          {title !== undefined && <h3 id={headingId}>{title}</h3>}
          {note !== undefined && <span className="settings-instant">{note}</span>}
        </div>
      )}
      <div className="settings-panel">{children}</div>
    </section>
  )
}

/** The long explanation of a setting, tucked behind a native disclosure. */
export function LearnMore({ children }: { children: ReactNode }): React.JSX.Element {
  const copy = useContext(SettingsKitCopyContext)
  return (
    <details className="learn-more">
      <summary>{copy.learnMore}</summary>
      <div className="learn-more-body">{children}</div>
    </details>
  )
}

/**
 * One setting: label and help on the left, `control` on the right. Pass a
 * render function as `control` to receive the id the label points at.
 */
export function SettingRow({ label, help, more, control, className, children }: {
  label: string
  help?: ReactNode
  more?: ReactNode
  control?: ReactNode | ((id: string) => ReactNode)
  className?: string
  /** Full-width content under the row: inputs, lists, status lines. */
  children?: ReactNode | ((id: string) => ReactNode)
}): React.JSX.Element {
  const id = useId()
  return (
    <div className={`setting-row${className === undefined ? '' : ` ${className}`}`}>
      <div className="setting-row-main">
        <div className="setting-row-copy">
          <label className="setting-label" htmlFor={id}>{label}</label>
          {help !== undefined && <p className="setting-help">{help}</p>}
        </div>
        {control !== undefined && (
          <div className="setting-row-control">{typeof control === 'function' ? control(id) : control}</div>
        )}
      </div>
      {more !== undefined && <LearnMore>{more}</LearnMore>}
      {children !== undefined && (
        <div className="setting-row-body">{typeof children === 'function' ? children(id) : children}</div>
      )}
    </div>
  )
}

function CautionIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.2 17.4 16H2.6L10 3.2Z" />
      <path d="M10 8.2v3.6M10 14h.01" />
    </svg>
  )
}

function InfoIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 9.2v4.2M10 6.6h.01" />
    </svg>
  )
}

/** A compact notice: icon plus one or two lines. */
export function Callout({ tone = 'caution', children }: {
  tone?: 'caution' | 'info'
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className={`callout callout-${tone}`} role="note">
      {tone === 'caution' ? <CautionIcon /> : <InfoIcon />}
      <div className="callout-body">{children}</div>
    </div>
  )
}

/** Input (plus an optional select) and an Add button, with inline validation. */
export function EntryAdd({ id, label, value, placeholder, disabled, valid, error, addLabel, select, onChange, onAdd }: {
  id?: string
  /** Accessible name of the input. */
  label: string
  value: string
  placeholder: string
  disabled?: boolean
  /** Whether the current text can be added. */
  valid: boolean
  /** Shown while the text is not empty and not valid. */
  error?: string
  addLabel: string
  select?: ReactNode
  onChange: (value: string) => void
  onAdd: () => void
}): React.JSX.Element {
  const errorId = useId()
  const invalid = error !== undefined && value.trim() !== '' && !valid
  return (
    <div className={`entry-add${select === undefined ? '' : ' with-select'}`}>
      <input
        {...(id === undefined ? {} : { id })}
        aria-label={label}
        aria-invalid={invalid}
        {...(invalid ? { 'aria-describedby': errorId } : {})}
        value={value}
        disabled={disabled === true}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && valid) onAdd() }}
        placeholder={placeholder}
      />
      {select}
      <button type="button" className="secondary" disabled={disabled === true || !valid} onClick={onAdd}>{addLabel}</button>
      {invalid && <p className="field-error" id={errorId} role="alert">{error}</p>}
    </div>
  )
}

export interface Entry {
  key: string
  /** The pattern, origin or name; shown in a monospace face. */
  value: string
  /** A short badge after the value (e.g. the rule level). */
  tag?: string
  /** Second line under the value. */
  detail?: string
}

function RemoveIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
    </svg>
  )
}

/** Entries as rows; each can be removed unless `onRemove` is omitted. */
export function EntryList({ entries, empty, removeLabel, onRemove, actionText }: {
  entries: readonly Entry[]
  /** Shown when the list is empty. */
  empty?: string
  removeLabel?: (entry: Entry) => string
  onRemove?: (entry: Entry) => void
  /** Use a text button (e.g. "Unlink") instead of the remove icon. */
  actionText?: string
}): React.JSX.Element | null {
  if (entries.length === 0) return empty === undefined ? null : <p className="entry-empty">{empty}</p>
  return (
    <ul className="entry-list">
      {entries.map((entry) => (
        <li className="entry" key={entry.key}>
          <span className="entry-copy">
            <code>{entry.value}</code>
            {entry.detail !== undefined && <small>{entry.detail}</small>}
          </span>
          {entry.tag !== undefined && <span className="entry-tag">{entry.tag}</span>}
          {onRemove !== undefined && (actionText !== undefined
            ? <button type="button" className="secondary small" onClick={() => onRemove(entry)}>{actionText}</button>
            : (
              <button type="button" className="entry-remove" onClick={() => onRemove(entry)}
                aria-label={removeLabel?.(entry)} title={removeLabel?.(entry)}>
                <RemoveIcon />
              </button>
            ))}
        </li>
      ))}
    </ul>
  )
}
