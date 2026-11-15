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

function remaining(expiresAt: number, locale: UiLocale): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))
  if (minutes >= 60) {
    const hours = Math.round(minutes / 6) / 10
    return locale === 'zh' ? `剩余 ${String(hours)} 小时` : `${String(hours)} h left`
  }
  return locale === 'zh' ? `剩余 ${String(minutes)} 分钟` : `${String(minutes)} min left`
}

export function WatchersCard({ locale }: { locale: UiLocale }): React.JSX.Element | null {
  const { watchers, cancel } = usePageWatchers()
  if (watchers.length === 0) return null
  const zh = locale === 'zh'
  return (
    <section className="watchers-card" aria-label={zh ? '页面监视' : 'Page watchers'} data-testid="watchers-card">
      <strong>{zh ? `正在监视 ${String(watchers.length)} 个页面` : `Watching ${String(watchers.length)} page${watchers.length === 1 ? '' : 's'}`}</strong>
      <ul>
        {watchers.map((watcher) => (
          <li key={watcher.id} data-watch-id={watcher.id}>
            <span className="watcher-copy">
              <span className="watcher-condition">{watcher.condition}</span>
              <small>{watcher.url}</small>
              <small>
                {zh ? '触发后：' : 'Then: '}{watcher.prompt}
                {' · '}{remaining(watcher.expiresAt, locale)}
                {' · '}{`${String(watcher.fires)}/${String(watcher.maxFires)}`}
                {watcher.lastMiss !== undefined && (zh ? ` · 上次未送达（${watcher.lastMiss}）` : ` · last wake missed (${watcher.lastMiss})`)}
              </small>
            </span>
            <button type="button" className="secondary" onClick={() => cancel(watcher.id)}>
              {zh ? '取消' : 'Cancel'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
