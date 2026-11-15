/**
 * Session taint indicator (security/taint.ts): one short sentence naming the
 * sites the conversation read, a Clear control, and one-click "Trust <site>"
 * choices for sources the user may mark trusted (security/taint-exempt.ts).
 *
 * Talks to the background over its own port (`dsh-policy`, side-port.ts) so it
 * does not depend on the main panel message protocol. The background decides
 * which sources can be trusted and re-checks every request; this component
 * only renders what it is offered.
 */

import { useRef, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { TaintRecord } from '../security/taint.ts'
import { NO_SESSION_KEY, taintKey, UNKNOWN_SOURCE } from '../security/taint.ts'
import { useSidePort } from './side-port.ts'
import { PANEL_COPY } from './strings.ts'

const PORT_NAME = 'dsh-policy'

/** Hosts named in the sentence before the rest collapse into "+N more". */
export const TAINT_BANNER_MAX_HOSTS = 3
/** Sources up to which each gets its own "Trust <site>" button. */
export const TAINT_BANNER_MAX_TRUST_BUTTONS = 2

/** Per record key: taint source origin → the site pattern "Trust" would add. */
export type TrustableSources = Record<string, Record<string, string>>

interface TrustOutcome {
  ok: boolean
  cleared: boolean
}

/** Subscribe to taint records; returns the records, what may be trusted, and the two actions. */
export function useSessionTaint(onTrusted?: (outcome: TrustOutcome) => void): {
  records: Record<string, TaintRecord>
  trustable: TrustableSources
  clear: (sessionId: string | null) => void
  trust: (sessionId: string | null, origins: readonly string[]) => void
} {
  const [records, setRecords] = useState<Record<string, TaintRecord>>({})
  const [trustable, setTrustable] = useState<TrustableSources>({})
  const onTrustedRef = useRef(onTrusted)
  onTrustedRef.current = onTrusted
  const post = useSidePort(PORT_NAME, { type: 'taint.subscribe' }, (message) => {
    const msg = message as { type?: unknown; records?: unknown; trustable?: unknown; ok?: unknown; cleared?: unknown }
    if (msg?.type === 'taint.state' && typeof msg.records === 'object' && msg.records !== null) {
      setRecords(msg.records as Record<string, TaintRecord>)
      setTrustable(typeof msg.trustable === 'object' && msg.trustable !== null ? msg.trustable as TrustableSources : {})
    } else if (msg?.type === 'taint.trust.result') {
      onTrustedRef.current?.({ ok: msg.ok === true, cleared: msg.cleared === true })
    }
  })
  return {
    records,
    trustable,
    clear: (sessionId) => {
      post({ type: 'taint.clear', id: crypto.randomUUID(), ...sessionId === null ? {} : { sessionId } })
    },
    trust: (sessionId, origins) => {
      post({ type: 'taint.trust', id: crypto.randomUUID(), origins: [...origins], ...sessionId === null ? {} : { sessionId } })
    },
  }
}

/** One "Trust <site>" choice: the site as shown, and the source origins it covers. */
export interface TaintTrustChoice {
  site: string
  origins: string[]
}

/** What the banner shows for one record. */
export interface TaintBannerView {
  /** Every source as shown: host names (with a port when there is one), or the unknown-source wording. */
  hosts: string[]
  /** The hosts named in the sentence (at most {@link TAINT_BANNER_MAX_HOSTS}). */
  shown: string[]
  /** How many more there are. */
  more: number
  /** A source that is no origin is among them: only Clear is offered. */
  unknown: boolean
  /** One-click trust choices, one per site; empty when none may be offered. */
  trust: TaintTrustChoice[]
}

/** The host of an origin as the banner names it (`seraph.quest`, `localhost:3000`). */
function displayHost(source: string): string | undefined {
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : undefined
  } catch {
    return undefined
  }
}

/**
 * Lay out one taint record for the banner. Pure, so the wording and the
 * button rules are tested without a browser.
 * @param offered - source origin → site pattern, as the background offers it.
 */
export function taintBannerView(record: TaintRecord, offered: Record<string, string> | undefined, unknownLabel: string): TaintBannerView {
  const hosts: string[] = []
  let unknown = record.sources.length === 0
  for (const source of record.sources) {
    const host = source === UNKNOWN_SOURCE ? undefined : displayHost(source)
    if (host === undefined) unknown = true
    else if (!hosts.includes(host)) hosts.push(host)
  }
  if (unknown) hosts.push(unknownLabel)
  const trust: TaintTrustChoice[] = []
  // An unknown source can never be trusted, so trusting the rest could not lift the taint.
  if (!unknown) {
    for (const source of record.sources) {
      const site = offered?.[source]
      if (typeof site !== 'string' || site === '') continue
      const existing = trust.find((choice) => choice.site === site)
      if (existing === undefined) trust.push({ site, origins: [source] })
      else existing.origins.push(source)
    }
  }
  return {
    hosts,
    shown: hosts.slice(0, TAINT_BANNER_MAX_HOSTS),
    more: Math.max(0, hosts.length - TAINT_BANNER_MAX_HOSTS),
    unknown,
    trust,
  }
}

export function TaintBanner({ sessionId, locale, onTrusted, acceptSyntheticClicks = false }: {
  sessionId: string | null
  locale: UiLocale
  /** A "Trust" went through: the panel's copy of the settings is stale. */
  onTrusted?: () => void
  /** Test seam only: jsdom cannot produce a trusted click. Never set in the panel. */
  acceptSyntheticClicks?: boolean
}): React.JSX.Element | null {
  const { records, trustable, clear, trust } = useSessionTaint((outcome) => { if (outcome.ok) onTrusted?.() })
  const [expanded, setExpanded] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [confirming, setConfirming] = useState<TaintTrustChoice | null>(null)
  // Clear exactly the record shown: the session can change between render and click.
  const key = taintKey(sessionId ?? undefined)
  const record = records[key]
  if (record === undefined) return null
  const copy = PANEL_COPY[locale].taint
  const view = taintBannerView(record, trustable[key], copy.unknownSource)
  const target = key === NO_SESSION_KEY ? null : key
  // Trusting a site is the user's decision alone: only a real click in the panel counts.
  const userClick = (event: React.MouseEvent): boolean => acceptSyntheticClicks || event.nativeEvent.isTrusted
  const named = view.shown.join(', ')
  const everySite = view.hosts.join(', ')
  // The choice being confirmed must still be on offer (the record can change under it).
  const pending = confirming !== null && view.trust.some((choice) => choice.site === confirming.site) ? confirming : null
  return (
    <div className="taint-banner" role="status" data-testid="taint-banner">
      <div className="taint-banner-row">
        <span title={everySite}>
          {copy.body(named)}
          {view.more > 0 && (
            <>
              {' '}
              <button type="button" className="taint-more" aria-expanded={expanded} title={everySite} onClick={() => setExpanded((open) => !open)}>
                {copy.more(view.more)}
              </button>
            </>
          )}
        </span>
        {view.trust.length > 0 && view.trust.length <= TAINT_BANNER_MAX_TRUST_BUTTONS && view.trust.map((choice) => (
          <button type="button" className="secondary taint-trust" key={choice.site} onClick={(event) => { if (userClick(event)) setConfirming(choice) }}>
            {copy.trust(choice.site)}
          </button>
        ))}
        {view.trust.length > TAINT_BANNER_MAX_TRUST_BUTTONS && (
          <button type="button" className="secondary taint-trust" aria-expanded={listOpen} onClick={() => setListOpen((open) => !open)}>
            {copy.trustMany}
          </button>
        )}
        <button type="button" className="secondary" onClick={() => clear(target)}>
          {copy.clear}
        </button>
      </div>
      {expanded && view.more > 0 && (
        <ul className="taint-sources" data-testid="taint-sources">
          {view.hosts.map((host) => <li key={host}>{host}</li>)}
        </ul>
      )}
      {listOpen && view.trust.length > TAINT_BANNER_MAX_TRUST_BUTTONS && (
        <ul className="taint-sources" data-testid="taint-trust-list">
          {view.trust.map((choice) => (
            <li key={choice.site}>
              <span>{choice.site}</span>
              <button type="button" className="secondary taint-trust" onClick={(event) => { if (userClick(event)) setConfirming(choice) }}>
                {copy.trust(choice.site)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending !== null && (
        <div className="taint-banner-row taint-confirm" data-testid="taint-trust-confirm">
          <span>{copy.trustConfirm(pending.site)} {PANEL_COPY[locale].sitePolicy.trustedNote}</span>
          <button
            type="button"
            className="secondary taint-trust"
            onClick={(event) => {
              if (!userClick(event)) return
              trust(target, pending.origins)
              setConfirming(null)
            }}
          >
            {copy.confirmTrust}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(null)}>{copy.cancel}</button>
        </div>
      )}
    </div>
  )
}
