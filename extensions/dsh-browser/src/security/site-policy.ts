/**
 * Per-site policy: one rule per domain pattern, from three layers.
 *
 * - `blocked` — the agent may not read or act on the site at all, nor
 *   navigate to it.
 * - `read-only` — reads follow the page-sharing preference; every
 *   state-changing action on the site is refused (navigation away is allowed).
 * - `ask` — every read and action on the site asks, even under unrestricted
 *   access, trusted origins, or automatic page sharing.
 * - `trusted` — reads and actions on the site need no prompt (forced prompts
 *   from the taint rules still apply).
 *
 * Layers resolve managed (enterprise policy) > user (Settings) > shipped
 * defaults. Within one layer the most restrictive matching rule wins, so a
 * broad `blocked` can never be loosened by a narrower rule beside it. A user
 * rule overrides a shipped default for the same site, which is how the user
 * opts a real bank out of the `*bank*` heuristic.
 *
 * "Unrestricted access" is the default rule `trusted` for every site no layer
 * names: it no longer lifts `blocked`, `read-only`, or `ask` sites.
 *
 * @module
 */

import { getDomain } from 'tldts'
import { parseHttpUrl } from './web-url.ts'

export type SiteRule = 'blocked' | 'read-only' | 'ask' | 'trusted'

/** Every rule, most restrictive first. */
export const SITE_RULES: readonly SiteRule[] = ['blocked', 'read-only', 'ask', 'trusted']

/** One configured rule. */
export interface SiteRuleEntry {
  /** Normalized pattern (see {@link normalizeSitePattern}). */
  pattern: string
  rule: SiteRule
}

export type SiteRuleSource = 'managed' | 'user' | 'default'

/** The rule that applies to one URL, and where it came from. */
export interface SiteVerdict {
  rule: SiteRule
  pattern: string
  source: SiteRuleSource
}

/** Everything a URL is evaluated against. */
export interface SitePolicy {
  managed: readonly SiteRuleEntry[]
  user: readonly SiteRuleEntry[]
  /** Shipped defaults are on unless the user (or managed policy) turns them off. */
  defaultsEnabled: boolean
  /** Unrestricted access: sites no layer names are `trusted`. */
  defaultTrusted: boolean
  /**
   * Managed `enforceSiteDefaults`: a user rule can only tighten a shipped
   * default, never loosen it (the stricter of the two applies).
   */
  enforceDefaults?: boolean
}

/**
 * Shipped defaults: banking and payment, password-manager web vaults,
 * identity-provider account pages, and cloud admin consoles are read-only.
 * `*bank*` is the heuristic that catches banks the curated list misses.
 */
export const DEFAULT_SITE_RULES: readonly SiteRuleEntry[] = [
  // Banking and payment.
  '*bank*', '*banking*', '*creditunion*', '*credit-union*',
  'paypal.com', 'paypal.me', 'venmo.com', 'cash.app', 'wise.com', 'revolut.com', 'monzo.com', 'n26.com',
  'chase.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com', 'usbank.com', 'pnc.com',
  'americanexpress.com', 'discover.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com',
  'robinhood.com', 'coinbase.com', 'binance.com', 'kraken.com', 'klarna.com', 'affirm.com', 'zelle.com',
  'dashboard.stripe.com', 'pay.google.com', 'payments.google.com', 'wallet.google.com',
  'alipay.com', 'pay.weixin.qq.com', 'secure.checkout.visa.com', 'mastercard.com/paymentmethods',
  // Password managers' web vaults.
  'vault.bitwarden.com', 'vault.bitwarden.eu', '1password.com', '1password.eu', 'lastpass.com',
  'dashlane.com', 'keepersecurity.com', 'nordpass.com', 'pass.proton.me', 'account.proton.me',
  'passwords.google.com',
  // Identity-provider account pages.
  'accounts.google.com', 'myaccount.google.com', 'login.microsoftonline.com', 'login.live.com',
  'account.microsoft.com', 'account.live.com', 'appleid.apple.com', 'account.apple.com', 'idmsa.apple.com',
  'github.com/settings', 'gitlab.com/-/profile', 'id.atlassian.com', 'okta.com', 'auth0.com',
  // Cloud admin consoles.
  'console.aws.amazon.com', 'signin.aws.amazon.com', 'portal.azure.com', 'entra.microsoft.com',
  'console.cloud.google.com', 'admin.google.com', 'cloud.digitalocean.com', 'dash.cloudflare.com',
  'cloud.oracle.com', 'console.firebase.google.com',
].map((pattern) => ({ pattern, rule: 'read-only' as const }))

/** Whether a value is one of the four rules. */
export function isSiteRule(value: unknown): value is SiteRule {
  return typeof value === 'string' && (SITE_RULES as readonly string[]).includes(value)
}

/**
 * Normalize a user- or policy-supplied pattern: `host`, `*.host`, a host glob
 * (`*bank*`), optionally followed by a path prefix (`github.com/settings`).
 * A scheme and trailing slash are dropped; anything else is rejected.
 */
export function normalizeSitePattern(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let text = value.trim().toLowerCase()
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  if (text === '' || /\s/.test(text) || text.includes('@') || text.includes('?') || text.includes('#')) return undefined
  const slash = text.indexOf('/')
  let host = slash === -1 ? text : text.slice(0, slash)
  let path = slash === -1 ? '' : text.slice(slash).replace(/\/+$/, '')
  host = host.replace(/:\d+$/, '')
  if (host === '' || !/^[a-z0-9*.-]+$/.test(host) || /^[*.]+$/.test(host) || host.includes('..')) return undefined
  if (path !== '' && !/^\/[\w\-./~%*]*$/.test(path)) return undefined
  if (path === '/') path = ''
  return `${host}${path}`
}

/**
 * Whether a pattern is narrow enough to be a user `trusted` rule: its host
 * part must name one literal registrable domain (eTLD+1), optionally with a
 * leading `*.`. Catch-all globs (`*a*`, `*.com`, `e*`) would recreate
 * unrestricted access one rule at a time, so they are refused as `trusted`
 * (they stay fine for the restrictive rules).
 */
export function isNarrowTrustedPattern(pattern: string): boolean {
  const slash = pattern.indexOf('/')
  const host = (slash === -1 ? pattern : pattern.slice(0, slash)).replace(/^\*\./, '')
  if (host.includes('*')) return false
  const domain = getDomain(host, { allowPrivateDomains: true })
  return domain !== null && domain !== '' && (host === domain || host.endsWith(`.${domain}`))
}

/**
 * Normalize a stored rule list, dropping malformed entries and duplicates.
 * User-layer `trusted` rules must be narrow ({@link isNarrowTrustedPattern});
 * pass `source: 'managed'` for administrator rules, which are not limited.
 */
export function normalizeSiteRules(value: unknown, source: SiteRuleSource = 'user'): SiteRuleEntry[] {
  if (!Array.isArray(value)) return []
  const byPattern = new Map<string, SiteRule>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const pattern = normalizeSitePattern((entry as { pattern?: unknown }).pattern)
    const rule = (entry as { rule?: unknown }).rule
    if (pattern === undefined || !isSiteRule(rule)) continue
    if (rule === 'trusted' && source !== 'managed' && !isNarrowTrustedPattern(pattern)) continue
    const existing = byPattern.get(pattern)
    byPattern.set(pattern, existing === undefined ? rule : mostRestrictive(existing, rule))
  }
  return [...byPattern].map(([pattern, rule]) => ({ pattern, rule })).sort((a, b) => a.pattern.localeCompare(b.pattern))
}

/** The more restrictive of two rules. */
export function mostRestrictive(left: SiteRule, right: SiteRule): SiteRule {
  return SITE_RULES.indexOf(left) <= SITE_RULES.indexOf(right) ? left : right
}

/**
 * Whether a pattern covers a URL. A plain host covers itself and its
 * subdomains; `*` matches any run of host characters (dots included); a path
 * prefix matches that path and everything below it.
 */
export function matchSitePattern(pattern: string, url: URL): boolean {
  const slash = pattern.indexOf('/')
  const hostPattern = slash === -1 ? pattern : pattern.slice(0, slash)
  const pathPattern = slash === -1 ? '' : pattern.slice(slash)
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostMatches(hostPattern, host)) return false
  if (pathPattern === '') return true
  let path: string
  try {
    path = decodeURIComponent(url.pathname).toLowerCase()
  } catch {
    path = url.pathname.toLowerCase()
  }
  if (pathPattern.includes('*')) return globRegExp(pathPattern, true).test(path)
  return path === pathPattern || path.startsWith(`${pathPattern}/`)
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.includes('*')) {
    if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
      const base = pattern.slice(2)
      return host === base || host.endsWith(`.${base}`)
    }
    return globRegExp(pattern, false).test(host)
  }
  return host === pattern || host.endsWith(`.${pattern}`)
}

function globRegExp(pattern: string, prefix: boolean): RegExp {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}${prefix ? '(?:/.*)?' : ''}$`)
}

function layerVerdict(entries: readonly SiteRuleEntry[], url: URL, source: SiteRuleSource): SiteVerdict | undefined {
  let verdict: SiteVerdict | undefined
  for (const entry of entries) {
    // Rules stored before the normalizer refused catch-all trusted globs.
    if (source === 'user' && entry.rule === 'trusted' && !isNarrowTrustedPattern(entry.pattern)) continue
    if (!matchSitePattern(entry.pattern, url)) continue
    if (verdict === undefined || mostRestrictive(verdict.rule, entry.rule) !== verdict.rule) {
      verdict = { rule: entry.rule, pattern: entry.pattern, source }
    }
  }
  return verdict
}

/**
 * The rule for one URL or origin, or undefined when no layer names it and
 * unrestricted access is off (ordinary approval flow). Non-web URLs have none.
 */
export function resolveSiteRule(value: string | URL, policy: SitePolicy): SiteVerdict | undefined {
  const url = parseHttpUrl(typeof value === 'string' ? value : value.href)
  if (url === undefined) return undefined
  const managed = layerVerdict(policy.managed, url, 'managed')
  if (managed !== undefined) return managed
  const user = layerVerdict(policy.user, url, 'user')
  const defaults = policy.defaultsEnabled || policy.enforceDefaults === true
    ? layerVerdict(DEFAULT_SITE_RULES, url, 'default')
    : undefined
  if (policy.enforceDefaults === true && user !== undefined && defaults !== undefined) {
    return mostRestrictive(user.rule, defaults.rule) === user.rule ? user : defaults
  }
  return user
    ?? defaults
    ?? (policy.defaultTrusted ? { rule: 'trusted', pattern: '*', source: 'user' } : undefined)
}

/** A policy with no rules at all: every call takes the ordinary approval path. */
export const EMPTY_SITE_POLICY: SitePolicy = { managed: [], user: [], defaultsEnabled: false, defaultTrusted: false }
