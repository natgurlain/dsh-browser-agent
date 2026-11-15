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
import { PANEL_COPY } from './strings.ts'

/** The RPC slice of the panel API this section uses. */
export interface DevLoopApi {
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
}

interface Candidate { sessionId: string; title?: string; project?: string; running?: boolean }
interface Link { sessionId: string; tabId: number; origin: string; label?: string }

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
  const copy = PANEL_COPY[locale].devLoop
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
        throw new Error(copy.openLocalhost)
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
    <section className="settings-panel dev-loop" aria-label={copy.title}>
      <div>
        <strong>{copy.title}</strong>
        <small>{copy.help}</small>
        <small className="dev-loop-warning">{copy.caution}</small>
      </div>
      {links.map((entry) => (
        <div className="trusted-origin" key={entry.sessionId}>
          <code>{entry.origin}</code>
          <span>{entry.label ?? entry.sessionId.slice(0, 12)}</span>
          <button onClick={() => unlink(entry.sessionId)}>{copy.unlink}</button>
        </div>
      ))}
      {candidates === null
        ? <button className="secondary" onClick={pick}>{copy.linkTab}</button>
        : candidates.length === 0
          ? <p className="hint">{copy.noSessions}</p>
          : (
            <div className="trusted-origin-add">
              <select aria-label={copy.sessionLabel} value={choice} onChange={(event) => setChoice(event.target.value)}>
                {candidates.map((candidate) => <option key={candidate.sessionId} value={candidate.sessionId}>{candidateLabel(candidate)}</option>)}
              </select>
              <button disabled={choice === ''} onClick={link}>{copy.link}</button>
            </div>
          )}
      {error !== null && <p className="origin-error">{error}</p>}
    </section>
  )
}
