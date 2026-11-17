/**
 * Enterprise managed policy (chrome.storage.managed; schema in
 * managed-schema.json, declared by the Chrome manifest's
 * `storage.managed_schema`; Firefox reads the same keys from policies.json
 * `3rdparty.extensions`).
 *
 * Managed values override user settings: forced site rules form the top policy
 * layer, and the disable switches pin the matching user settings off no matter
 * what the panel writes.
 *
 * @module
 */

import { normalizeSiteRules, type SiteRuleEntry } from './site-policy.ts'
import { normalizeTrustedOrigin } from './trusted-origins.ts'

export interface ManagedPolicy {
  /** Forced per-site rules; they outrank every user rule. */
  siteRules: SiteRuleEntry[]
  /** Developer tools stay off and every devtools call is refused. */
  disableDevTools: boolean
  /** "Unrestricted access" cannot be turned on. */
  disableUnrestricted: boolean
  /** browser_screenshot is refused. */
  disableScreenshots: boolean
  /** The shipped read-only defaults cannot be turned off. */
  enforceSiteDefaults: boolean
  /** Local (loopback) pages taint a session like any other page (taint-exempt.ts). */
  disableLocalTaintExemption: boolean
  /** Sites the user trusts taint a session like any other page (taint-exempt.ts). */
  disableTrustedTaintExemption: boolean
  /** Auto approve (docs/auto-approve-design.md) is not offered: every card goes to the user. */
  disableAutoReview: boolean
  /**
   * Pinned web origins (exact or `*.` wildcard): the agent may read, act on,
   * and navigate to these only. Undefined = no pin.
   */
  allowedOrigins?: string[]
  /** Whether any managed key was present at all (shown in Settings). */
  active: boolean
}

export const EMPTY_MANAGED_POLICY: ManagedPolicy = {
  siteRules: [],
  disableDevTools: false,
  disableUnrestricted: false,
  disableScreenshots: false,
  enforceSiteDefaults: false,
  disableLocalTaintExemption: false,
  disableTrustedTaintExemption: false,
  disableAutoReview: false,
  active: false,
}

/** Parse raw managed storage, ignoring malformed values (never throws). */
export function parseManagedPolicy(raw: unknown): ManagedPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_MANAGED_POLICY
  const value = raw as Record<string, unknown>
  const allowed = Array.isArray(value.allowedOrigins)
    ? [...new Set(value.allowedOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : undefined
  const known = [
    'siteRules', 'disableDevTools', 'disableUnrestricted', 'disableScreenshots', 'enforceSiteDefaults', 'allowedOrigins',
    'disableLocalTaintExemption', 'disableTrustedTaintExemption', 'disableAutoReview',
  ]
  return {
    siteRules: normalizeSiteRules(value.siteRules, 'managed'),
    disableDevTools: value.disableDevTools === true,
    disableUnrestricted: value.disableUnrestricted === true,
    disableScreenshots: value.disableScreenshots === true,
    enforceSiteDefaults: value.enforceSiteDefaults === true,
    disableLocalTaintExemption: value.disableLocalTaintExemption === true,
    disableTrustedTaintExemption: value.disableTrustedTaintExemption === true,
    disableAutoReview: value.disableAutoReview === true,
    // An allowlist that parsed to nothing still pins: an admin who listed only
    // malformed entries meant "restrict", so fail closed to "no sites".
    ...allowed === undefined ? {} : { allowedOrigins: allowed },
    active: known.some((key) => value[key] !== undefined),
  }
}

/** Settings fields managed policy can force. */
export interface ManagedOverridable {
  allowDevTools: boolean
  unrestrictedBrowserAccess: boolean
  siteDefaultsEnabled: boolean
}

/** Apply managed overrides to user settings (managed wins). */
export function applyManagedOverrides<T extends ManagedOverridable>(settings: T, managed: ManagedPolicy): T {
  return {
    ...settings,
    allowDevTools: settings.allowDevTools && !managed.disableDevTools,
    unrestrictedBrowserAccess: settings.unrestrictedBrowserAccess && !managed.disableUnrestricted,
    siteDefaultsEnabled: settings.siteDefaultsEnabled || managed.enforceSiteDefaults,
  }
}

interface ManagedArea {
  get(keys?: null): Promise<Record<string, unknown>>
}

/** Read managed storage; a browser without it, or with no policy, yields the empty policy. */
export async function loadManagedPolicy(area: ManagedArea | undefined = managedArea()): Promise<ManagedPolicy> {
  if (area === undefined) return EMPTY_MANAGED_POLICY
  try {
    return parseManagedPolicy(await area.get(null))
  } catch {
    return EMPTY_MANAGED_POLICY
  }
}

function managedArea(): ManagedArea | undefined {
  try {
    return (globalThis as { chrome?: { storage?: { managed?: ManagedArea } } }).chrome?.storage?.managed
  } catch {
    return undefined
  }
}
