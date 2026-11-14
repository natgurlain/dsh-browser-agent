/**
 * Session taint indicator with a Clear control (security/taint.ts).
 *
 * Talks to the background over its own port (`dsh-policy`) so it does not
 * depend on the main panel message protocol.
 */

import { useEffect, useRef, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { TaintRecord } from '../security/taint.ts'
import { NO_SESSION_KEY, taintKey } from '../security/taint.ts'

const PORT_NAME = 'dsh-policy'

/** Subscribe to taint records; returns the records and a clear function. */
export function useSessionTaint(): { records: Record<string, TaintRecord>; clear: (sessionId: string | null) => void } {
  const [records, setRecords] = useState<Record<string, TaintRecord>>({})
  const portRef = useRef<chrome.runtime.Port | null>(null)
  useEffect(() => {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: PORT_NAME })
    } catch {
      return
    }
    portRef.current = port
    port.onMessage.addListener((message: unknown) => {
      const msg = message as { type?: unknown; records?: unknown }
      if (msg?.type === 'taint.state' && typeof msg.records === 'object' && msg.records !== null) {
        setRecords(msg.records as Record<string, TaintRecord>)
      }
    })
    port.postMessage({ type: 'taint.subscribe' })
    return () => {
      portRef.current = null
      try { port.disconnect() } catch { /* already closed */ }
    }
  }, [])
  return {
    records,
    clear: (sessionId) => {
      portRef.current?.postMessage({ type: 'taint.clear', id: crypto.randomUUID(), ...sessionId === null ? {} : { sessionId } })
    },
  }
}

export function TaintBanner({ sessionId, locale }: { sessionId: string | null; locale: UiLocale }): React.JSX.Element | null {
  const { records, clear } = useSessionTaint()
  // Clear exactly the record shown: the session can change between render and click.
  const key = taintKey(sessionId ?? undefined)
  const record = records[key]
  if (record === undefined) return null
  const sources = record.sources.length === 0 ? (locale === 'zh' ? '未知来源' : 'an unknown origin') : record.sources.join(', ')
  return (
    <div className="taint-banner" role="status" data-testid="taint-banner">
      <span>
        {locale === 'zh'
          ? `本会话已读取不受信任的网页内容（${sources}）。跨站输入、剪贴板写入、文件写入和带数据的跳转需要您批准；命令行与文件写入工具已停用。`
          : `This session has read untrusted page content (${sources}). Cross-site typing, clipboard and file writes, and data-carrying navigation need your approval; shell and file-writing tools are off.`}
      </span>
      <button type="button" className="secondary" onClick={() => clear(key === NO_SESSION_KEY ? null : key)}>
        {locale === 'zh' ? '清除' : 'Clear'}
      </button>
    </div>
  )
}
