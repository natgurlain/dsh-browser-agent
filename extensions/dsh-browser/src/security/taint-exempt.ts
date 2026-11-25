/**
 * Which page reads do not taint a session (see taint.ts for taint itself).
 *
 * Two kinds of origin are exempt, each behind its own setting (both on by
 * default, each can be forced off by managed policy or by the bridge):
 *
 * - the user's own local pages: loopback origins (`localhost`, `*.localhost`,
 *   `127.0.0.1`, `[::1]`, any port). Under {@link TAINT_EXEMPTION_SWITCHES}
 *   `loopbackScope: 'confirmed'` only the loopback origins the user said are
 *   theirs (`taintLocalOrigins`: linked through the dev loop, answered on the
 *   banner, or added in Settings); under `'any'` every loopback origin;
 * - sites the user explicitly and persistently trusts, over https only: a
 *   "not treated as untrusted" entry (`taintTrustedSites`, what the banner's
 *   Trust adds), a user site rule with the `trusted` level, or an
 *   always-allowed origin (`trustedActionOrigins`). Under `trustedMigration:
 *   'confirm'` a trusted rule or always-allowed origin counts only once the
 *   user added or confirmed it after this feature existed
 *   (`taintTrustConfirmed`); under `'immediate'` all of them count. The
 *   blanket "unrestricted access" switch, a session-only allowance from an
 *   approval card, and administrator rules are not such a choice.
 *
 * Never exempt, whatever the settings say: an origin any stricter site rule
 * names (blocked, read-only, ask; any layer; for the page's own URL when it is
 * known, otherwise for any path on that host), and the origins that serve the
 * DSH host itself (its web UI shows every session's transcript).
 *
 * Scope of a trusted entry: a site rule or a "not untrusted" entry covers
 * `https://<host>` and its subdomains on the default port only; an
 * always-allowed origin covers exactly what it names (it must be https).
 *
 * The exemption only decides whether a read taints. It never changes where a
 * tainted session's data may go: `taintForcedReasons` still forces a card for
 * loopback and trusted destinations alike.
 *
 * @module
 */

import { isLoopbackPageOrigin } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import { DEFAULT_SITE_RULES, isNarrowTrustedPattern, matchSitePattern, normalizeSitePattern, type SitePolicy, type SiteRuleEntry } from './site-policy.ts'
import { originMatchesTrusted } from './trusted-origins.ts'
import { httpOrigin, parseHttpUrl } from './web-url.ts'

export { isLoopbackPageOrigin }

/** Which loopback origins are exempt: every one, or only those the user said are theirs. */
export type LoopbackScope = 'any' | 'confirmed'
/** Whether trusted rules and always-allowed origins that predate the exemption count at once, or only once confirmed. */
export type TrustedMigration = 'immediate' | 'confirm'

/**
 * The two product decisions still open, each one switch. The values here are
 * the safer variants; flipping one changes nothing else.
 */
export const TAINT_EXEMPTION_SWITCHES: { loopbackScope: LoopbackScope; trustedMigration: TrustedMigration } = {
  loopbackScope: 'confirmed',
  trustedMigration: 'confirm',
}

/** Everything the exemption is judged against. */
export interface TaintExemptionConfig {
  /** "Don't restrict sessions that only read local pages" (after managed policy and the bridge). */
  localPages: boolean
  /** "Don't restrict sessions that only read sites I trust" (after managed policy and the bridge). */
  trustedSites: boolean
  /** The site policy in force; its `defaultTrusted` (unrestricted access) is ignored here. */
  site: SitePolicy
  /** The user's always-allowed origins from Settings (never the session-only set). */
  trustedActionOrigins: readonly string[]
  /** Loopback origins the user said are theirs (`loopbackScope: 'confirmed'`). */
  localOrigins: readonly string[]
  /** Hosts whose pages are not treated as untrusted content (taint-only trust). */
  taintTrustedSites: readonly string[]
  /** Keys ({@link trustKeys}) of trusted rules and always-allowed origins the user confirmed for the exemption. */
  trustConfirmed: readonly string[]
  loopbackScope: LoopbackScope
  trustedMigration: TrustedMigration
  /** Origins that are never exempt (the DSH host's own web UI and bridge). */
  neverExempt?: (origin: string) => boolean
}

/** No exemption at all: every read taints, as before the exemptions existed. */
export const NO_TAINT_EXEMPTION: TaintExemptionConfig = {
  localPages: false,
  trustedSites: false,
  site: { managed: [], user: [], defaultsEnabled: false, defaultTrusted: false },
  trustedActionOrigins: [],
  localOrigins: [],
  taintTrustedSites: [],
  trustConfirmed: [],
  loopbackScope: 'confirmed',
  trustedMigration: 'confirm',
}

/** A bare http(s) origin (`scheme://host[:port]`), parsed; anything else is undefined. */
function parseOrigin(origin: string): URL | undefined {
  const url = parseHttpUrl(origin)
  return url !== undefined && url.origin === origin ? url : undefined
}

function hostPart(pattern: string): string {
  const slash = pattern.indexOf('/')
  return slash === -1 ? pattern : pattern.slice(0, slash)
}

/** Every rule in force, all layers (the exemption is blocked by a stricter rule in any of them). */
function allRules(site: SitePolicy): SiteRuleEntry[] {
  return [
    ...site.managed,
    ...site.user,
    ...site.defaultsEnabled || site.enforceDefaults === true ? DEFAULT_SITE_RULES : [],
  ]
}

/**
 * Whether a stricter rule (blocked, read-only, ask) from any layer covers
 * `origin`: a rule matching the origin itself, a rule matching one of the
 * page URLs read there (`urls`, for path-scoped rules), or, when no page URL
 * of that origin is known, any path-scoped rule on that host.
 */
export function stricterRuleCovers(origin: string, urls: readonly string[], site: SitePolicy): boolean {
  const parsed = parseOrigin(origin)
  if (parsed === undefined) return false
  const strict = allRules(site).filter((entry) => entry.rule !== 'trusted')
  if (strict.length === 0) return false
  if (strict.some((entry) => matchSitePattern(entry.pattern, parsed))) return true
  const pages = urls.map((url) => parseHttpUrl(url)).filter((url): url is URL => url !== undefined && url.origin === origin)
  if (pages.length > 0) return pages.some((page) => strict.some((entry) => matchSitePattern(entry.pattern, page)))
  return strict.some((entry) => entry.pattern.includes('/') && matchSitePattern(hostPart(entry.pattern), parsed))
}

/** The key under which a user `trusted` site rule is confirmed for the exemption. */
export function ruleTrustKey(pattern: string): string {
  return `rule:${pattern}`
}

/** The key under which an always-allowed origin is confirmed for the exemption. */
export function originTrustKey(origin: string): string {
  return `origin:${origin}`
}

/** Keys of every user entry that can make a site trusted: `trusted` site rules and always-allowed origins. */
export function trustKeys(siteRules: readonly SiteRuleEntry[], trustedActionOrigins: readonly string[]): string[] {
  return [
    ...siteRules.filter((entry) => entry.rule === 'trusted').map((entry) => ruleTrustKey(entry.pattern)),
    ...trustedActionOrigins.map(originTrustKey),
  ]
}

/**
 * The confirmed keys after a settings change: what was confirmed (or what the
 * change itself asks to confirm), plus every entry the change adds (adding a
 * trusted site now is a choice made knowing what it means), minus entries
 * that no longer exist.
 */
export function reconcileTrustConfirmed(
  previous: { siteRules: readonly SiteRuleEntry[]; trustedActionOrigins: readonly string[] },
  next: { siteRules: readonly SiteRuleEntry[]; trustedActionOrigins: readonly string[] },
  confirmed: readonly string[],
): string[] {
  const before = new Set(trustKeys(previous.siteRules, previous.trustedActionOrigins))
  const now = trustKeys(next.siteRules, next.trustedActionOrigins)
  const keep = new Set(confirmed)
  return now.filter((key) => keep.has(key) || !before.has(key)).sort()
}

/** Trusted rules and always-allowed origins that do not count yet (`trustedMigration: 'confirm'`). */
export function unconfirmedTrust(config: Pick<TaintExemptionConfig, 'site' | 'trustedActionOrigins' | 'trustConfirmed' | 'trustedMigration'>): string[] {
  if (config.trustedMigration === 'immediate') return []
  const confirmed = new Set(config.trustConfirmed)
  return trustKeys(config.site.user, config.trustedActionOrigins).filter((key) => !confirmed.has(key))
}

function hostCovered(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`)
}

/**
 * Whether the user made an explicit, persistent "I trust this site" choice
 * for `origin` that counts for the exemption. Only https. Stricter rules are
 * judged separately ({@link stricterRuleCovers}).
 */
export function userTrustsOrigin(
  origin: string,
  config: Pick<TaintExemptionConfig, 'site' | 'trustedActionOrigins' | 'taintTrustedSites' | 'trustConfirmed' | 'trustedMigration'>,
): boolean {
  const url = parseOrigin(origin)
  if (url === undefined || url.protocol !== 'https:') return false
  const counts = (key: string): boolean => config.trustedMigration === 'immediate' || config.trustConfirmed.includes(key)
  // An always-allowed origin covers exactly what it names.
  if (config.trustedActionOrigins.some((entry) => originMatchesTrusted(origin, [entry]) && counts(originTrustKey(entry)))) return true
  // Host entries cover https on the default port only.
  if (url.port !== '') return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (config.taintTrustedSites.some((entry) => hostCovered(host, entry))) return true
  return config.site.user.some((entry) => entry.rule === 'trusted'
    && !entry.pattern.includes('/')
    && isNarrowTrustedPattern(entry.pattern)
    && matchSitePattern(entry.pattern, url)
    && counts(ruleTrustKey(entry.pattern)))
}

/** Whether a loopback origin counts as the user's own page. */
function localPageExempt(origin: string, config: TaintExemptionConfig): boolean {
  if (!config.localPages || !isLoopbackPageOrigin(origin)) return false
  return config.loopbackScope === 'any' || config.localOrigins.includes(origin)
}

/**
 * Whether a read of `origin` alone leaves a session untainted. `urls` are the
 * page URLs read (any origin; only those of `origin` matter).
 */
export function originTaintExempt(origin: string, config: TaintExemptionConfig, urls: readonly string[] = []): boolean {
  if (!config.localPages && !config.trustedSites) return false
  if (config.neverExempt?.(origin) === true) return false
  if (stricterRuleCovers(origin, urls, config.site)) return false
  if (localPageExempt(origin, config)) return true
  return config.trustedSites && userTrustsOrigin(origin, config)
}

/** Whether every origin is exempt (and there is at least one: no known origin means unknown). */
export function allTaintExempt(origins: readonly string[], config: TaintExemptionConfig, urls: readonly string[] = []): boolean {
  return origins.length > 0 && origins.every((origin) => originTaintExempt(origin, config, urls))
}

/**
 * Whether every origin is exempt as one of the user's own local pages (and
 * there is at least one). The bar for results that can carry more than the
 * frames' text (a screenshot's pixels, console output, captured traffic,
 * page JavaScript): only the user's own dev server is trusted with those,
 * the same trust the dev loop already gives its console and network reports.
 */
export function allLocalExempt(origins: readonly string[], config: TaintExemptionConfig, urls: readonly string[] = []): boolean {
  return origins.length > 0 && origins.every((origin) => localPageExempt(origin, config) && originTaintExempt(origin, config, urls))
}

/** Whether any of the origins is exempt as a local page (the bridge may refuse those separately). */
export function anyLocalExempt(origins: readonly string[], config: TaintExemptionConfig): boolean {
  return origins.some((origin) => localPageExempt(origin, config))
}

/**
 * A one-click choice the banner may offer for a taint source:
 * - `site`: add `entry` (a host) to the "not treated as untrusted" sites;
 * - `local`: remember `entry` (a loopback origin) as one of the user's pages.
 */
export interface TrustOffer {
  kind: 'site' | 'local'
  entry: string
}

/**
 * What the banner may offer for one taint source, or undefined: not a web
 * origin, already exempt, the matching exemption is off (the choice would
 * change nothing), an origin that is never exempt, a site some stricter rule
 * names at any path (the user changes those in Settings, deliberately), a
 * host a rule cannot name (an address, a bare name), or a site not on https
 * on its default port.
 */
export function trustOfferFor(origin: string, config: TaintExemptionConfig): TrustOffer | undefined {
  const url = parseOrigin(origin)
  if (url === undefined || originTaintExempt(origin, config)) return undefined
  if (config.neverExempt?.(origin) === true) return undefined
  if (allRules(config.site).some((entry) => entry.rule !== 'trusted' && matchSitePattern(hostPart(entry.pattern), url))) return undefined
  if (isLoopbackPageOrigin(origin)) {
    return config.localPages && config.loopbackScope === 'confirmed' ? { kind: 'local', entry: origin } : undefined
  }
  if (!config.trustedSites || url.protocol !== 'https:' || url.port !== '') return undefined
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (normalizeSitePattern(host) !== host || !isNarrowTrustedPattern(host)) return undefined
  return { kind: 'site', entry: host }
}

function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
}

function isLoopbackHostName(hostname: string): boolean {
  return isLoopbackPageOrigin(`http://${hostname}`)
}

/**
 * Whether `origin` is served by the DSH host the extension talks to: the
 * same host and port as one of the bridge addresses (`ws(s)://…`), any
 * loopback name counting as the same host. The host's web UI lives there and
 * shows every session's transcript, text that tainted sessions read
 * included, so such a page is never exempt.
 */
export function servesBridge(origin: string, bridgeUrls: readonly (string | undefined)[]): boolean {
  const page = parseOrigin(origin)
  if (page === undefined) return false
  for (const value of bridgeUrls) {
    if (value === undefined || value.trim() === '') continue
    let bridge: URL
    try {
      bridge = new URL(value)
    } catch {
      continue
    }
    if (effectivePort(bridge) !== effectivePort(page)) continue
    if (bridge.hostname === page.hostname) return true
    if (isLoopbackHostName(bridge.hostname) && isLoopbackHostName(page.hostname)) return true
  }
  return false
}

/** Normalize the stored "not treated as untrusted" hosts: narrow host names only, no paths. */
export function normalizeTaintTrustedSites(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts = new Set<string>()
  for (const entry of value) {
    const host = normalizeSitePattern(entry)
    if (host !== undefined && !host.includes('/') && !host.includes('*') && isNarrowTrustedPattern(host)) hosts.add(host)
  }
  return [...hosts].sort()
}

/** Normalize the stored local origins: loopback page origins only. */
export function normalizeTaintLocalOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const origins = new Set<string>()
  for (const entry of value) {
    const origin = typeof entry === 'string' ? httpOrigin(entry.trim()) : undefined
    if (origin !== undefined && isLoopbackPageOrigin(origin)) origins.add(origin)
  }
  return [...origins].sort()
}
