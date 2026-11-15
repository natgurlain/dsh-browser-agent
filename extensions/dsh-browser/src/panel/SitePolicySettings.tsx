/**
 * Settings group for per-site policy (security/site-policy.ts): the built-in
 * defaults switch, user rules, strict-mode sites, and what an administrator
 * forces. Edits go through the settings form and take effect on Save.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { UiLocale } from '../i18n.ts'
import { DEFAULT_SITE_RULES, normalizeSitePattern, SITE_RULES, withSiteRule, type SiteRule, type SiteRuleEntry } from '../security/site-policy.ts'
import { parseManagedPolicy, type ManagedPolicy } from '../security/managed-policy.ts'
import { SettingToggle } from './SettingToggle.tsx'
import { Callout, EntryAdd, EntryList, SettingRow, SettingsGroup } from './SettingsKit.tsx'
import { PANEL_COPY } from './strings.ts'

export interface SitePolicyValue {
  siteRules: SiteRuleEntry[]
  siteDefaultsEnabled: boolean
  strictSites: string[]
}

/** Firefox has no debugger API, so the commit gate cannot run there. */
const STRICT_AVAILABLE = typeof (globalThis as { chrome?: { debugger?: unknown } }).chrome?.debugger === 'object'

export function SitePolicySettings({ value, onChange, locale, children }: {
  value: SitePolicyValue
  onChange: (next: SitePolicyValue) => void
  locale: UiLocale
  /** Further site rows that belong in this group (always-allowed domains). */
  children?: ReactNode
}): React.JSX.Element {
  const copy = PANEL_COPY[locale].sitePolicy
  const [pattern, setPattern] = useState('')
  const [rule, setRule] = useState<SiteRule>('read-only')
  const [managed, setManaged] = useState<ManagedPolicy | null>(null)
  const [strictPattern, setStrictPattern] = useState('')
  const strictNormalized = normalizeSitePattern(strictPattern)
  const addStrict = (): void => {
    if (strictNormalized === undefined) return
    onChange({ ...value, strictSites: [...new Set([...value.strictSites, strictNormalized])].sort() })
    setStrictPattern('')
  }
  useEffect(() => {
    const area = (chrome.storage as { managed?: chrome.storage.StorageArea }).managed
    if (area === undefined) return
    void Promise.resolve(area.get(null)).then((raw) => { setManaged(parseManagedPolicy(raw)) }, () => {})
  }, [])
  const normalized = normalizeSitePattern(pattern)
  const add = (): void => {
    if (normalized === undefined) return
    onChange({ ...value, siteRules: withSiteRule(value.siteRules, normalized, rule) })
    setPattern('')
  }
  return (
    <SettingsGroup title={copy.title} className="site-policy">
      <SettingToggle
        title={copy.builtIn}
        help={copy.builtInHelp(DEFAULT_SITE_RULES.length)}
        checked={value.siteDefaultsEnabled || managed?.enforceSiteDefaults === true}
        disabled={managed?.enforceSiteDefaults === true}
        onChange={(checked) => onChange({ ...value, siteDefaultsEnabled: checked })}
      />
      <SettingRow label={copy.rulesTitle} help={copy.help} more={<><p>{copy.more}</p><p className="trusted-note">{copy.trustedNote}</p></>}>
        {(id) => (
          <>
            <EntryAdd
              id={id}
              label={copy.patternLabel}
              value={pattern}
              placeholder={copy.patternPlaceholder}
              valid={normalized !== undefined}
              error={copy.invalidPattern}
              addLabel={copy.add}
              onChange={setPattern}
              onAdd={add}
              select={(
                <select aria-label={copy.ruleLabel} value={rule} onChange={(event) => setRule(event.target.value as SiteRule)}>
                  {SITE_RULES.map((entry) => <option key={entry} value={entry}>{copy.rules[entry]}</option>)}
                </select>
              )}
            />
            <EntryList
              entries={value.siteRules.map((entry) => ({ key: entry.pattern, value: entry.pattern, tag: copy.rules[entry.rule] }))}
              empty={copy.noRules}
              removeLabel={(entry) => copy.removeItem(entry.value)}
              onRemove={(entry) => onChange({ ...value, siteRules: value.siteRules.filter((candidate) => candidate.pattern !== entry.key) })}
            />
          </>
        )}
      </SettingRow>
      {children}
      <SettingRow className="strict-mode" label={copy.strictTitle}
        help={STRICT_AVAILABLE ? copy.strictHelp : copy.strictUnavailable}
        {...(STRICT_AVAILABLE ? { more: <p>{copy.strictMore}</p> } : {})}>
        {(id) => (
          <>
            <EntryAdd
              id={id}
              label={copy.strictSiteLabel}
              value={strictPattern}
              placeholder="shop.example.com"
              disabled={!STRICT_AVAILABLE}
              valid={strictNormalized !== undefined}
              error={copy.invalidPattern}
              addLabel={copy.add}
              onChange={setStrictPattern}
              onAdd={addStrict}
            />
            <EntryList
              entries={value.strictSites.map((site) => ({ key: site, value: site }))}
              {...(STRICT_AVAILABLE ? { empty: copy.noStrictSites } : {})}
              removeLabel={(entry) => copy.removeItem(entry.value)}
              onRemove={(entry) => onChange({ ...value, strictSites: value.strictSites.filter((candidate) => candidate !== entry.key) })}
            />
          </>
        )}
      </SettingRow>
      {managed?.active === true && (
        <div className="setting-row managed-policy">
          <Callout tone="info">
            <p>{copy.managedIntro}</p>
            {managed.disableUnrestricted && <p>{copy.managedNoUnrestricted}</p>}
            {managed.disableDevTools && <p>{copy.managedNoDevTools}</p>}
            {managed.disableScreenshots && <p>{copy.managedNoScreenshots}</p>}
            {managed.disableLocalTaintExemption && <p>{copy.managedNoLocalExemption}</p>}
            {managed.disableTrustedTaintExemption && <p>{copy.managedNoTrustedExemption}</p>}
            {managed.allowedOrigins !== undefined && <p>{copy.managedAllowedOnly(managed.allowedOrigins)}</p>}
          </Callout>
          <EntryList entries={managed.siteRules.map((entry) => ({ key: `managed-${entry.pattern}`, value: entry.pattern, tag: copy.rules[entry.rule] }))} />
        </div>
      )}
    </SettingsGroup>
  )
}
