/**
 * Settings section for the dev loop (Phase 3.5): link the current localhost
 * tab to one of the user's DSH coding sessions, list links, unlink.
 *
 * Linking is the explicit user action that lets the bridge feed console
 * errors, failed requests and a DOM delta back to that session after each
 * turn that edited files. It is read-only context, never a prompt: the
 * session still cannot be prompted from the browser.
 */

import { useEffect, useState } from 'react'
import {
  BRIDGE_DEVLOOP_CANDIDATES_METHOD,
  BRIDGE_DEVLOOP_LINK_METHOD,
  BRIDGE_DEVLOOP_LIST_METHOD,
  BRIDGE_DEVLOOP_UNLINK_METHOD,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { UiLocale } from '../i18n.ts'

/** The RPC slice of the panel API this section uses. */
export interface DevLoopApi {
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
}

interface Candidate { sessionId: string; title?: string; project?: string; running?: boolean }
interface Link { sessionId: string; tabId: number; origin: string; label?: string }

function t(locale: UiLocale, en: string, zh: string): string {
  return locale === 'zh' ? zh : en
}

/** Label for one coding session in the picker. */
export function candidateLabel(candidate: Candidate): string {
  const name = candidate.title ?? candidate.sessionId.slice(0, 12)
  return candidate.project === undefined ? name : `${candidate.project} — ${name}`
}

export function DevLoopSettings({ api, locale, activeTab }: {
  api: DevLoopApi
  locale: UiLocale
  /** The tab the panel's window shows (resolved by the caller). */
  activeTab: () => Promise<{ id?: number; url?: string } | undefined>
}): React.JSX.Element {
  const [links, setLinks] = useState<Link[]>([])
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [choice, setChoice] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    void api.rpc<{ items?: Link[] }>(BRIDGE_DEVLOOP_LIST_METHOD, {}).then(
      (value) => { setLinks(Array.isArray(value?.items) ? value.items : []) },
      () => { setLinks([]) },
    )
  }
  useEffect(refresh, [])

  const pick = (): void => {
    setError(null)
    void api.rpc<{ items?: Candidate[] }>(BRIDGE_DEVLOOP_CANDIDATES_METHOD, {}).then((value) => {
      const items = Array.isArray(value?.items) ? value.items : []
      setCandidates(items)
      setChoice(items[0]?.sessionId ?? '')
    }, (cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)) })
  }

  const link = (): void => {
    setError(null)
    void (async () => {
      const tab = await activeTab()
      // Loopback is the default; the bridge decides (it may allow configured extra origins).
      if (tab?.id === undefined || !/^https?:\/\//u.test(tab.url ?? '')) {
        throw new Error(t(locale,
          'Open the localhost page (localhost, 127.0.0.1 or [::1]) in this window first.',
          '请先在此窗口打开本地页面（localhost、127.0.0.1 或 [::1]）。'))
      }
      const candidate = candidates?.find(entry => entry.sessionId === choice)
      await api.rpc(BRIDGE_DEVLOOP_LINK_METHOD, {
        sessionId: choice,
        tabId: tab.id,
        ...(candidate === undefined ? {} : { label: candidateLabel(candidate) }),
      })
      setCandidates(null)
      refresh()
    })().catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)) })
  }

  const unlink = (sessionId: string): void => {
    void api.rpc(BRIDGE_DEVLOOP_UNLINK_METHOD, { sessionId }).finally(refresh)
  }

  return (
    <section className="settings-panel dev-loop" aria-label={t(locale, 'Dev loop', '开发闭环')}>
      <div>
        <strong>{t(locale, 'Dev loop', '开发闭环')}</strong>
        <small>{t(locale,
          'Link a localhost tab to a DSH coding session. After each turn in which that session edits files, it receives this tab\'s new console errors, failed requests and page changes as read-only context. It can never be prompted from here.',
          '将本地页面标签关联到 DSH 编码会话。该会话每次编辑文件后，会以只读上下文收到此标签新的控制台错误、失败请求和页面变化；此处永远不会向它发送提示。')}</small>
      </div>
      {links.map((entry) => (
        <div className="trusted-origin" key={entry.sessionId}>
          <code>{entry.origin}</code>
          <span>{entry.label ?? entry.sessionId.slice(0, 12)}</span>
          <button onClick={() => unlink(entry.sessionId)}>{t(locale, 'Unlink', '取消关联')}</button>
        </div>
      ))}
      {candidates === null
        ? <button className="secondary" onClick={pick}>{t(locale, 'Link this tab to a coding session…', '将此标签关联到编码会话…')}</button>
        : candidates.length === 0
          ? <p className="hint">{t(locale, 'No DSH coding session found. Start one in DSH (Desktop or CLI) first.', '未找到 DSH 编码会话。请先在 DSH（桌面版或 CLI）中开始一个会话。')}</p>
          : (
            <div className="trusted-origin-add">
              <select aria-label={t(locale, 'Coding session', '编码会话')} value={choice} onChange={(event) => setChoice(event.target.value)}>
                {candidates.map((candidate) => <option key={candidate.sessionId} value={candidate.sessionId}>{candidateLabel(candidate)}</option>)}
              </select>
              <button disabled={choice === ''} onClick={link}>{t(locale, 'Link', '关联')}</button>
            </div>
          )}
      {error !== null && <p className="origin-error">{error}</p>}
    </section>
  )
}
