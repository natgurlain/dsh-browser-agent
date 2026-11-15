/**
 * Which page reads do not taint a session (see taint.ts for taint itself).
 *
 * Two kinds of origin are exempt, each behind its own setting (both on by
 * default, each can be forced off by managed policy):
 *
 * - the user's own local pages: loopback origins (`localhost`, `*.localhost`,
 *   `127.0.0.1`, `[::1]`, any port);
 * - sites the user explicitly and persistently marked trusted in Settings: a
 *   user site rule with the `trusted` level, or an "always-allowed" origin
 *   (`trustedActionOrigins`). The blanket "unrestricted access" switch, a
 *   session-only allowance from an approval card, and administrator rules are
 *   not such a choice and never count.
 *
 * The exemption only decides whether a read taints. It never changes where a
 * tainted session's data may go: `taintForcedReasons` still forces a card for
 * loopback and trusted destinations alike.
 *
 * A read is exempt only when every origin it could have quoted is exempt; an
 * unknown source never is.
 *
 * @module
 */

import { isLoopbackPageOrigin } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { DEFAULT_SITE_RULES, isNarrowTrustedPattern, matchSitePattern, normalizeSitePattern, resolveSiteRule, withSiteRule, type SitePolicy, type SiteRuleEntry } from './site-policy.ts'
import { originMatchesTrusted } from './trusted-origins.ts'
import { parseHttpUrl } from './web-url.ts'

export { isLoopbackPageOrigin }

/** Everything the exemption is judged against. */
export interface TaintExemptionConfig {
  /** "Don't restrict sessions that only read local pages" (after managed policy). */
  localPages: boolean
  /** "Don't restrict sessions that only read sites I trust" (after managed policy). */
  trustedSites: boolean
  /** The site policy in force; its `defaultTrusted` (unrestricted access) is ignored here. */
  site: SitePolicy
  /** The user's always-allowed origins from Settings (never the session-only set). */
  trustedActionOrigins: readonly string[]
}

/** No exemption at all: every read taints, as before the exemptions existed. */
export const NO_TAINT_EXEMPTION: TaintExemptionConfig = {
  localPages: false,
  trustedSites: false,
  site: { managed: [], user: [], defaultsEnabled: false, defaultTrusted: false },
  trustedActionOrigins: [],
}

/** A bare http(s) origin (`scheme://host[:port]`), parsed; anything else is undefined. */
function parseOrigin(origin: string): URL | undefined {
  const url = parseHttpUrl(origin)
  return url !== undefined && url.origin === origin ? url : undefined
}

/**
 * Whether the user made an explicit, persistent "I trust this site" choice
 * for `origin`. A stricter rule from any layer (blocked, read-only, ask)
 * wins, and so does an administrator's rule: then the site is not the
 * user's to trust. Path-scoped trusted rules (`example.com/app`) do not make
 * the whole origin trusted.
 */
export function userTrustsOrigin(origin: string, config: Pick<TaintExemptionConfig, 'site' | 'trustedActionOrigins'>): boolean {
  if (parseOrigin(origin) === undefined) return false
  const verdict = resolveSiteRule(origin, { ...config.site, defaultTrusted: false })
  if (verdict !== undefined && verdict.rule !== 'trusted') return false
  if (verdict !== undefined && verdict.source === 'user') return true
  return originMatchesTrusted(origin, config.trustedActionOrigins)
}

/** Whether a read of `origin` alone leaves a session untainted. */
export function originTaintExempt(origin: string, config: TaintExemptionConfig): boolean {
  if (config.localPages && isLoopbackPageOrigin(origin)) return true
  return config.trustedSites && userTrustsOrigin(origin, config)
}

/** Whether every origin is exempt (and there is at least one: no known origin means unknown). */
export function allTaintExempt(origins: readonly string[], config: TaintExemptionConfig): boolean {
  return origins.length > 0 && origins.every((origin) => originTaintExempt(origin, config))
}

function hostPart(pattern: string): string {
  const slash = pattern.indexOf('/')
  return slash === -1 ? pattern : pattern.slice(0, slash)
}

function anyRuleNamesHost(entries: readonly SiteRuleEntry[], url: URL): boolean {
  return entries.some((entry) => matchSitePattern(hostPart(entry.pattern), url))
}

/**
 * The site pattern the banner's "Trust <site>" would add for a taint source,
 * or undefined when that one-click choice is not offered: not a web origin,
 * already exempt, the trusted-sites exemption is off (trusting would change
 * nothing), a host a user rule cannot name (an IP address, a bare name), or a
 * site some rule already covers at any path (the user changes those in
 * Settings, deliberately; a click must not loosen a read-only default or
 * fight an administrator's rule).
 */
export function trustPatternFor(origin: string, config: TaintExemptionConfig): string | undefined {
  if (!config.trustedSites) return undefined
  const url = parseOrigin(origin)
  if (url === undefined || originTaintExempt(origin, config)) return undefined
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (normalizeSitePattern(host) !== host || !isNarrowTrustedPattern(host)) return undefined
  const defaults = config.site.defaultsEnabled || config.site.enforceDefaults === true ? DEFAULT_SITE_RULES : []
  if (anyRuleNamesHost(config.site.managed, url) || anyRuleNamesHost(config.site.user, url) || anyRuleNamesHost(defaults, url)) return undefined
  return host
}

/** A site rule list with `pattern` set to `trusted` (the one way a site becomes trusted, in Settings and on the banner). */
export function withTrustedSite(rules: readonly SiteRuleEntry[], pattern: string): SiteRuleEntry[] {
  return withSiteRule(rules, pattern, 'trusted')
}
