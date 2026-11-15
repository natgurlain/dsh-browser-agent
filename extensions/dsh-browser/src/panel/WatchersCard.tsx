/**
 * Active page watchers (background/watchers.ts) with a Cancel control.
 *
 * Talks to the background over its own port (`dsh-watchers`, side-port.ts) so
 * it does not depend on the main panel message protocol. Renders nothing while no
 * watcher is active.
 */

import { useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { useSidePort } from './side-port.ts'
import { PANEL_COPY, type PanelCopy } from './strings.ts'

const PORT_NAME = 'dsh-watchers'

/** One watcher as the background reports it. */
export interface WatcherView {
  id: string
  sessionId: string
  url: string
  condition: string
  prompt: string
  expiresAt: number
  fires: number
  maxFires: number
  lastMiss?: string
}

function isWatcherView(value: unknown): value is WatcherView {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.url === 'string' && typeof v.condition === 'string' && typeof v.prompt === 'string'
    && typeof v.expiresAt === 'number' && typeof v.fires === 'number' && typeof v.maxFires === 'number'
}

/** Subscribe to the watcher list. */
export function usePageWatchers(): { watchers: WatcherView[]; cancel: (id: string) => void } {
  const [watchers, setWatchers] = useState<WatcherView[]>([])
  const post = useSidePort(PORT_NAME, { type: 'watchers.subscribe' }, (message) => {
    const msg = message as { type?: unknown; watchers?: unknown }
    if (msg?.type === 'watchers.state' && Array.isArray(msg.watchers)) setWatchers(msg.watchers.filter(isWatcherView))
  })
  return { watchers, cancel: (id) => { post({ type: 'watchers.cancel', id }) } }
}

function remaining(expiresAt: number, copy: PanelCopy['watchers']): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))
  return minutes >= 60 ? copy.hoursLeft(Math.round(minutes / 6) / 10) : copy.minutesLeft(minutes)
}

export function WatchersCard({ locale }: { locale: UiLocale }): React.JSX.Element | null {
  const { watchers, cancel } = usePageWatchers()
  if (watchers.length === 0) return null
  const copy = PANEL_COPY[locale].watchers
  return (
    <section className="watchers-card" aria-label={copy.label} data-testid="watchers-card">
      <strong>{copy.title(watchers.length)}</strong>
      <ul>
        {watchers.map((watcher) => (
          <li key={watcher.id} data-watch-id={watcher.id}>
            <span className="watcher-copy">
              <span className="watcher-condition">{watcher.condition}</span>
              <small>{watcher.url}</small>
              <small>
                {copy.then}{watcher.prompt}
                {' · '}{remaining(watcher.expiresAt, copy)}
                {' · '}{`${String(watcher.fires)}/${String(watcher.maxFires)}`}
                {watcher.lastMiss !== undefined && copy.lastMiss(watcher.lastMiss)}
              </small>
            </span>
            <button type="button" className="secondary" onClick={() => cancel(watcher.id)}>
              {copy.cancel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
