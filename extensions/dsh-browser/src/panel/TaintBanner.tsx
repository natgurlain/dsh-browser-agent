/**
 * Session taint indicator with a Clear control (security/taint.ts).
 *
 * Talks to the background over its own port (`dsh-policy`, side-port.ts) so it
 * does not depend on the main panel message protocol.
 */

import { useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { TaintRecord } from '../security/taint.ts'
import { NO_SESSION_KEY, taintKey } from '../security/taint.ts'
import { useSidePort } from './side-port.ts'
import { PANEL_COPY } from './strings.ts'

const PORT_NAME = 'dsh-policy'

/** Subscribe to taint records; returns the records and a clear function. */
export function useSessionTaint(): { records: Record<string, TaintRecord>; clear: (sessionId: string | null) => void } {
  const [records, setRecords] = useState<Record<string, TaintRecord>>({})
  const post = useSidePort(PORT_NAME, { type: 'taint.subscribe' }, (message) => {
    const msg = message as { type?: unknown; records?: unknown }
    if (msg?.type === 'taint.state' && typeof msg.records === 'object' && msg.records !== null) {
      setRecords(msg.records as Record<string, TaintRecord>)
    }
  })
  return {
    records,
    clear: (sessionId) => {
      post({ type: 'taint.clear', id: crypto.randomUUID(), ...sessionId === null ? {} : { sessionId } })
    },
  }
}

export function TaintBanner({ sessionId, locale }: { sessionId: string | null; locale: UiLocale }): React.JSX.Element | null {
  const { records, clear } = useSessionTaint()
  // Clear exactly the record shown: the session can change between render and click.
  const key = taintKey(sessionId ?? undefined)
  const record = records[key]
  if (record === undefined) return null
  const copy = PANEL_COPY[locale].taint
  const sources = record.sources.length === 0 ? copy.unknownSource : record.sources.join(', ')
  return (
    <div className="taint-banner" role="status" data-testid="taint-banner">
      <span>{copy.body(sources)}</span>
      <button type="button" className="secondary" onClick={() => clear(key === NO_SESSION_KEY ? null : key)}>
        {copy.clear}
      </button>
    </div>
  )
}
