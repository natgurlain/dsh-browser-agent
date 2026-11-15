/**
 * The policy layer evaluated before any approval shortcut.
 *
 * Unrestricted access, trusted origins, and automatic page sharing all skip
 * prompts; this layer runs first and can refuse a call outright (blocked or
 * read-only site, managed policy) or force a fresh, per-call approval that no
 * shortcut covers (an `ask` site, or a taint rule). See site-policy.ts and
 * taint.ts for the rules themselves.
 *
 * @module
 */

import { originMatchesTrusted } from './trusted-origins.ts'
import { resolveSiteRule, SITE_RULES, type SitePolicy, type SiteVerdict } from './site-policy.ts'
import { taintForcedReasons, type TaintRecord } from './taint.ts'

/** Which origins one call reads, changes, or navigates to. */
export interface CallPolicyTargets {
  /** Origins whose content the call hands to the model. */
  reads: string[]
  /** Origins whose page state the call changes. */
  acts: string[]
  /** Destination URL of a navigation or new tab. */
  destination?: string
  /**
   * Full URLs of the frames behind `reads` and `acts`, so path-scoped rules
   * (`github.com/settings`, `intranet.example/hr`) apply to page reads and
   * actions, not only to navigation targets.
   */
  urls?: string[]
  /** Origin of the frame a typing or paste call writes into. */
  typeTargetOrigin?: string
  /**
   * Effective origin of the tab's top page. Taint records it as the "page last
   * read": never an iframe's origin, so an embedded attacker frame cannot make
   * its own origin the exempt navigation target.
   */
  pageOrigin?: string
}

/** Enterprise switches from chrome.storage.managed that shape single calls. */
export interface ManagedCallFlags {
  disableScreenshots: boolean
  disableDevTools: boolean
  /**
   * When set, the only web origins (exact or wildcard, as trusted origins are
   * written) the extension may read from, act on, or navigate to.
   */
  allowedOrigins?: readonly string[]
}

export const NO_MANAGED_FLAGS: ManagedCallFlags = { disableScreenshots: false, disableDevTools: false }

export interface CallPolicyInput {
  name: string
  args: Record<string, unknown>
  targets: CallPolicyTargets
  site: SitePolicy
  taint?: TaintRecord
  managed?: ManagedCallFlags
  /** Whether the tool belongs to the developer-tools group. */
  devTools?: boolean
}

export type CallPolicyDecision =
  /** Refuse without asking. */
  | { kind: 'deny'; message: string }
  /** Ask, every time; no setting or grant covers it. */
  | { kind: 'force'; reasons: string[] }
  /** Every origin involved is trusted by site policy: no prompt needed. */
  | { kind: 'trust' }
  /** The ordinary approval flow decides. */
  | { kind: 'default' }

const SETTINGS_HINT = 'The user can change this in Settings > Site policy.'

function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

function describe(verdict: SiteVerdict): string {
  const source = verdict.source === 'managed' ? 'managed policy' : verdict.source === 'default' ? 'built-in default' : 'your site policy'
  return `${verdict.pattern} (${source})`
}

/** Restrictiveness rank: no rule (ordinary approval flow) sits between `ask` and `trusted`. */
function rank(verdict: SiteVerdict | undefined): number {
  if (verdict === undefined) return SITE_RULES.indexOf('trusted') - 0.5
  return SITE_RULES.indexOf(verdict.rule)
}

function stricterVerdict(left: SiteVerdict | undefined, right: SiteVerdict | undefined): SiteVerdict | undefined {
  return rank(right) < rank(left) ? right : left
}

/** Evaluate one call against managed policy, site rules, and taint. */
export function evaluateCallPolicy(input: CallPolicyInput): CallPolicyDecision {
  const managed = input.managed ?? NO_MANAGED_FLAGS
  if (managed.disableScreenshots && input.name === 'browser_screenshot') {
    return { kind: 'deny', message: 'Screenshots are disabled by your administrator (managed policy).' }
  }
  if (managed.disableDevTools && input.devTools === true) {
    return { kind: 'deny', message: 'Developer tools are disabled by your administrator (managed policy).' }
  }
  const destination = input.targets.destination
  const destinationOrigin = originOf(destination)
  const involved = [...new Set([
    ...input.targets.reads,
    ...input.targets.acts,
    ...destinationOrigin === undefined ? [] : [destinationOrigin],
  ])]
  if (managed.allowedOrigins !== undefined) {
    const outside = involved.filter((origin) => !originMatchesTrusted(origin, managed.allowedOrigins!))
    if (outside.length > 0 || (destination !== undefined && destinationOrigin === undefined && /^[a-z]+:/i.test(destination) && !/^(?:about|chrome|edge):/i.test(destination))) {
      return { kind: 'deny', message: `${outside.join(', ') || destination} is outside the sites your administrator allows (managed policy).` }
    }
  }

  const reasons: string[] = []
  const verdicts = new Map<string, SiteVerdict | undefined>()
  // An origin is judged by the strictest verdict over the frame URLs the call
  // touches there (path-scoped rules), or by the origin alone when none is known.
  const verdictFor = (origin: string): SiteVerdict | undefined => {
    if (!verdicts.has(origin)) {
      const urls = (input.targets.urls ?? []).filter((url) => originOf(url) === origin)
      verdicts.set(origin, urls.length === 0
        ? resolveSiteRule(origin, input.site)
        : urls.map((url) => resolveSiteRule(url, input.site)).reduce(stricterVerdict))
    }
    return verdicts.get(origin)
  }
  // Path-scoped rules (github.com/settings) need the full URL, not the origin.
  const destinationVerdict = destination === undefined ? undefined : resolveSiteRule(destination, input.site)
  for (const origin of involved) {
    const verdict = origin === destinationOrigin && destinationVerdict !== undefined ? destinationVerdict : verdictFor(origin)
    if (verdict?.rule === 'blocked') {
      return { kind: 'deny', message: `${origin} is blocked by ${describe(verdict)}: the agent may not read, change, or open it. ${SETTINGS_HINT}` }
    }
  }
  for (const origin of input.targets.acts) {
    const verdict = verdictFor(origin)
    if (verdict?.rule === 'read-only') {
      return { kind: 'deny', message: `${origin} is read-only by ${describe(verdict)}: the agent may read it but not click, type, or otherwise change it. ${SETTINGS_HINT}` }
    }
  }
  for (const origin of involved) {
    const verdict = origin === destinationOrigin && destinationVerdict !== undefined ? destinationVerdict : verdictFor(origin)
    if (verdict?.rule === 'ask') reasons.push(`Site policy asks before every agent call on ${origin} (${describe(verdict)}).`)
  }
  reasons.push(...taintForcedReasons({
    name: input.name,
    args: input.args,
    ...input.targets.typeTargetOrigin === undefined ? {} : { targetOrigin: input.targets.typeTargetOrigin },
  }, input.taint))
  if (reasons.length > 0) return { kind: 'force', reasons }
  if (involved.length > 0 && involved.every((origin) => {
    const verdict = origin === destinationOrigin && destinationVerdict !== undefined ? destinationVerdict : verdictFor(origin)
    return verdict?.rule === 'trusted'
  })) return { kind: 'trust' }
  return { kind: 'default' }
}
