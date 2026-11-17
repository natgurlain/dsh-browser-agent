/**
 * Session taint indicator (security/taint.ts): one short sentence naming the
 * sites the conversation read, a Clear control, and one-click choices for
 * sources the user may exempt (security/taint-exempt.ts): "Trust <site>" for
 * a web site, "these are my pages" for a local address.
 *
 * While Auto approve is on the same record shows as a slim, neutral status
 * line instead: the full sentence and the "Trust" choices sit one click away
 * (and are read to screen readers); a local-address question and a pending
 * confirmation still show, in the neutral style.
 *
 * Talks to the background over its own port (`dsh-policy`, side-port.ts) so it
 * does not depend on the main panel message protocol. The background decides
 * which sources can be offered and re-checks every request; this component
 * only renders what it is offered.
 */

import { useId, useRef, useState } from 'react'
import { getDomain } from 'tldts'
import type { UiLocale } from '../i18n.ts'
import type { TaintRecord } from '../security/taint.ts'
import { NO_SESSION_KEY, taintKey, UNKNOWN_SOURCE } from '../security/taint.ts'
import type { TrustOffer } from '../security/taint-exempt.ts'
import { useSidePort } from './side-port.ts'
import { PANEL_COPY } from './strings.ts'

const PORT_NAME = 'dsh-policy'

/** Hosts named in the sentence before the rest collapse into "+N more". */
export const TAINT_BANNER_MAX_HOSTS = 3
/** Sites up to which each gets its own "Trust <site>" button. */
export const TAINT_BANNER_MAX_TRUST_BUTTONS = 2
/** Longest subdomain prefix shown in full in the confirmation. */
const MAX_PREFIX_CHARS = 20

/** Per record key: taint source origin → the choice the background offers for it. */
export type TrustableSources = Record<string, Record<string, TrustOffer>>

interface TrustOutcome {
  ok: boolean
  cleared: boolean
}

/** Subscribe to taint records; returns the records, what may be offered, and the two actions. */
export function useSessionTaint(onTrusted?: (outcome: TrustOutcome) => void): {
  records: Record<string, TaintRecord>
  trustable: TrustableSources
  /** Per record key: its sources that are exempt now (they tainted nothing; not named). */
  exemptSources: Record<string, string[]>
  clear: (sessionId: string | null) => void
  trust: (sessionId: string | null, origins: readonly string[]) => void
} {
  const [records, setRecords] = useState<Record<string, TaintRecord>>({})
  const [trustable, setTrustable] = useState<TrustableSources>({})
  const [exemptSources, setExemptSources] = useState<Record<string, string[]>>({})
  const onTrustedRef = useRef(onTrusted)
  onTrustedRef.current = onTrusted
  const post = useSidePort(PORT_NAME, { type: 'taint.subscribe' }, (message) => {
    const msg = message as { type?: unknown; records?: unknown; trustable?: unknown; exemptSources?: unknown; ok?: unknown; cleared?: unknown }
    if (msg?.type === 'taint.state' && typeof msg.records === 'object' && msg.records !== null) {
      setRecords(msg.records as Record<string, TaintRecord>)
      setTrustable(typeof msg.trustable === 'object' && msg.trustable !== null ? msg.trustable as TrustableSources : {})
      setExemptSources(typeof msg.exemptSources === 'object' && msg.exemptSources !== null ? msg.exemptSources as Record<string, string[]> : {})
    } else if (msg?.type === 'taint.trust.result') {
      onTrustedRef.current?.({ ok: msg.ok === true, cleared: msg.cleared === true })
    }
  })
  return {
    records,
    trustable,
    exemptSources,
    clear: (sessionId) => {
      post({ type: 'taint.clear', id: crypto.randomUUID(), ...sessionId === null ? {} : { sessionId } })
    },
    trust: (sessionId, origins) => {
      post({ type: 'taint.trust', id: crypto.randomUUID(), origins: [...origins], ...sessionId === null ? {} : { sessionId } })
    },
  }
}

/** One choice: the site (or local address) as shown, and the source origins it covers. */
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
  /** "Trust <site>" choices, one per site; empty when none may be offered. */
  trust: TaintTrustChoice[]
  /** "These are my pages" choices, one per local address. */
  local: TaintTrustChoice[]
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
 * A host name split for display: the registrable domain (what the user is
 * really trusting, shown in bold) and the subdomain prefix before it, cut in
 * the middle when it is long so the domain is never pushed out of sight.
 */
export function siteNameParts(host: string): { prefix: string; domain: string } {
  const domain = getDomain(host, { allowPrivateDomains: true })
  if (domain === null || domain === '' || !host.endsWith(domain)) return { prefix: '', domain: host }
  const prefix = host.slice(0, host.length - domain.length)
  if (prefix.length <= MAX_PREFIX_CHARS) return { prefix, domain }
  const half = Math.floor((MAX_PREFIX_CHARS - 1) / 2)
  return { prefix: `${prefix.slice(0, half)}…${prefix.slice(prefix.length - half)}`, domain }
}

/**
 * Lay out one taint record for the banner. Pure, so the wording and the
 * button rules are tested without a browser.
 * @param offered - source origin → the choice the background offers for it.
 * @param exempt - sources that are exempt from taint now (the user's own local
 *   pages, trusted sites): they tainted nothing, so they are not named, unless
 *   nothing else is left to name.
 */
export function taintBannerView(
  record: TaintRecord,
  offered: Record<string, TrustOffer> | undefined,
  unknownLabel: string,
  exempt: readonly string[] = [],
): TaintBannerView {
  const hosts: string[] = []
  const named = record.sources.filter((source) => !exempt.includes(source))
  const listed = named.length > 0 ? named : record.sources
  let unknown = record.sources.length === 0
  for (const source of listed) {
    const host = source === UNKNOWN_SOURCE ? undefined : displayHost(source)
    if (host === undefined) unknown = true
    else if (!hosts.includes(host)) hosts.push(host)
  }
  if (unknown) hosts.push(unknownLabel)
  const trust: TaintTrustChoice[] = []
  const local: TaintTrustChoice[] = []
  // An unknown source can never be trusted, so trusting the rest could not lift the taint.
  if (!unknown) {
    for (const source of record.sources) {
      const offer = offered?.[source]
      if (offer === undefined || typeof offer.entry !== 'string' || offer.entry === '') continue
      if (offer.kind === 'local') {
        local.push({ site: displayHost(source) ?? offer.entry, origins: [source] })
        continue
      }
      if (offer.kind !== 'site') continue
      const existing = trust.find((choice) => choice.site === offer.entry)
      if (existing === undefined) trust.push({ site: offer.entry, origins: [source] })
      else existing.origins.push(source)
    }
  }
  return {
    hosts,
    shown: hosts.slice(0, TAINT_BANNER_MAX_HOSTS),
    more: Math.max(0, hosts.length - TAINT_BANNER_MAX_HOSTS),
    unknown,
    trust,
    local,
  }
}

export function TaintBanner({ sessionId, locale, onTrusted, autoApprove = false, acceptSyntheticClicks = false }: {
  sessionId: string | null
  locale: UiLocale
  /** Auto approve is on for this conversation: risky steps go to its reviewer instead of asking. */
  autoApprove?: boolean
  /** A choice went through: the panel's copy of the settings is stale. */
  onTrusted?: () => void
  /** Test seam only: jsdom cannot produce a trusted click. Never set in the panel. */
  acceptSyntheticClicks?: boolean
}): React.JSX.Element | null {
  const { records, trustable, exemptSources, clear, trust } = useSessionTaint((outcome) => { if (outcome.ok) onTrusted?.() })
  const [expanded, setExpanded] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [confirming, setConfirming] = useState<TaintTrustChoice | null>(null)
  // The slim line's own toggles: switching Auto approve never opens the other look's lists.
  const [quietOpen, setQuietOpen] = useState(false)
  const [quietListOpen, setQuietListOpen] = useState(false)
  const quietId = useId()
  // Clear exactly the record shown: the session can change between render and click.
  const key = taintKey(sessionId ?? undefined)
  const record = records[key]
  if (record === undefined) return null
  const copy = PANEL_COPY[locale].taint
  const view = taintBannerView(record, trustable[key], copy.unknownSource, exemptSources[key])
  const target = key === NO_SESSION_KEY ? null : key
  // Trusting a site is the user's decision alone: only a real click in the panel counts.
  const userClick = (event: React.MouseEvent): boolean => acceptSyntheticClicks || event.nativeEvent.isTrusted
  const named = view.shown.join(', ')
  const everySite = view.hosts.join(', ')
  // The choice being confirmed must still be on offer (the record can change under it).
  const pending = confirming !== null && view.trust.some((choice) => choice.site === confirming.site) ? confirming : null
  const pendingName = pending === null ? undefined : siteNameParts(pending.site)
  if (autoApprove) {
    const full = copy.bodyAuto(everySite)
    const pick = (choice: TaintTrustChoice) => (event: React.MouseEvent): void => { if (userClick(event)) setConfirming(choice) }
    return (
      <div className="taint-banner taint-quiet" role="status" data-testid="taint-banner">
        <div className="taint-quiet-row">
          <button
            type="button"
            className="taint-quiet-summary"
            aria-expanded={quietOpen}
            aria-controls={`${quietId}-details`}
            aria-describedby={`${quietId}-full`}
            title={full}
            onClick={() => setQuietOpen((open) => !open)}
          >
            <svg className="taint-quiet-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 1.5 2.75 3.5v4.1c0 3.2 2.2 5.9 5.25 6.9 3.05-1 5.25-3.7 5.25-6.9V3.5L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            <span className="taint-quiet-text">{copy.quiet}</span>
            <svg className="taint-quiet-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="taint-quiet-clear" onClick={() => clear(target)}>
            {copy.clear}
          </button>
        </div>
        <span id={`${quietId}-full`} className="sr-only">{full}</span>
        {quietOpen && (
          <div id={`${quietId}-details`} className="taint-quiet-details" data-testid="taint-details">
            <p>{full}</p>
            {view.trust.length > 0 && view.trust.length <= TAINT_BANNER_MAX_TRUST_BUTTONS && (
              <div className="taint-banner-row">
                {view.trust.map((choice) => (
                  <button type="button" className="secondary taint-trust" key={choice.site} onClick={pick(choice)}>
                    {copy.trust(choice.site)}
                  </button>
                ))}
              </div>
            )}
            {view.trust.length > TAINT_BANNER_MAX_TRUST_BUTTONS && (
              <div className="taint-banner-row">
                <button type="button" className="secondary taint-trust" aria-expanded={quietListOpen} onClick={() => setQuietListOpen((open) => !open)}>
                  {copy.trustMany}
                </button>
              </div>
            )}
            {quietListOpen && view.trust.length > TAINT_BANNER_MAX_TRUST_BUTTONS && (
              <ul className="taint-sources" data-testid="taint-trust-list">
                {view.trust.map((choice) => (
                  <li key={choice.site}>
                    <span>{choice.site}</span>
                    <button type="button" className="secondary taint-trust" onClick={pick(choice)}>
                      {copy.trust(choice.site)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {view.local.map((choice) => (
          <div className="taint-banner-row taint-local" key={choice.site} data-testid="taint-local-question">
            <span>{copy.localQuestion(choice.site)}</span>
            <button type="button" className="secondary taint-trust" onClick={(event) => { if (userClick(event)) trust(target, choice.origins) }}>
              {copy.localYes}
            </button>
          </div>
        ))}
        {pending !== null && pendingName !== undefined && (
          <div className="taint-banner-row taint-confirm" data-testid="taint-trust-confirm">
            <span>
              {copy.trustConfirmLead}
              <span className="taint-site" title={pending.site}>{pendingName.prefix}<strong>{pendingName.domain}</strong></span>
              {copy.trustConfirmEnd}
              {' '}
              {copy.trustEffects}
            </span>
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
  return (
    <div className="taint-banner" role="status" data-testid="taint-banner">
      <div className="taint-banner-row">
        <span title={everySite}>
          {autoApprove ? copy.bodyAuto(named) : copy.body(named)}
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
      {view.local.map((choice) => (
        <div className="taint-banner-row taint-local" key={choice.site} data-testid="taint-local-question">
          <span>{copy.localQuestion(choice.site)}</span>
          <button type="button" className="secondary taint-trust" onClick={(event) => { if (userClick(event)) trust(target, choice.origins) }}>
            {copy.localYes}
          </button>
        </div>
      ))}
      {pending !== null && pendingName !== undefined && (
        <div className="taint-banner-row taint-confirm" data-testid="taint-trust-confirm">
          <span>
            {copy.trustConfirmLead}
            <span className="taint-site" title={pending.site}>{pendingName.prefix}<strong>{pendingName.domain}</strong></span>
            {copy.trustConfirmEnd}
            {' '}
            {copy.trustEffects}
          </span>
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
