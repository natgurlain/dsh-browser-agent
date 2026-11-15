/**
 * Settings section for per-site policy (security/site-policy.ts): user rules,
 * the built-in defaults switch, and the rules an administrator forces.
 * Edits go through the settings form and take effect on Save.
 */

import { useEffect, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { DEFAULT_SITE_RULES, normalizeSitePattern, SITE_RULES, withSiteRule, type SiteRule, type SiteRuleEntry } from '../security/site-policy.ts'
import { parseManagedPolicy, type ManagedPolicy } from '../security/managed-policy.ts'
import { SettingToggle } from './SettingToggle.tsx'
import { PANEL_COPY } from './strings.ts'

export interface SitePolicyValue {
  siteRules: SiteRuleEntry[]
  siteDefaultsEnabled: boolean
  strictSites: string[]
  /** Pages served from this machine do not taint a session (security/taint-exempt.ts). */
  taintExemptLocalPages: boolean
  /** Pages from sites the user trusts do not taint a session. */
  taintExemptTrustedSites: boolean
}

/** Firefox has no debugger API, so the commit gate cannot run there. */
const STRICT_AVAILABLE = typeof (globalThis as { chrome?: { debugger?: unknown } }).chrome?.debugger === 'object'

export function SitePolicySettings({ value, onChange, locale }: {
  value: SitePolicyValue
  onChange: (next: SitePolicyValue) => void
  locale: UiLocale
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
    <section className="settings-panel site-policy" aria-label={copy.title}>
      <div>
        <strong>{copy.title}</strong>
        <small>{copy.help}</small>
      </div>
      <SettingToggle
        title={copy.builtIn}
        help={copy.builtInHelp(DEFAULT_SITE_RULES.length)}
        checked={value.siteDefaultsEnabled || managed?.enforceSiteDefaults === true}
        disabled={managed?.enforceSiteDefaults === true}
        onChange={(checked) => onChange({ ...value, siteDefaultsEnabled: checked })}
      />
      <div className="trusted-origin-add">
        <input
          aria-label={copy.patternLabel}
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') add() }}
          placeholder="example.com / *bank* / github.com/settings"
        />
        <select aria-label={copy.ruleLabel} value={rule} onChange={(event) => setRule(event.target.value as SiteRule)}>
          {SITE_RULES.map((entry) => <option key={entry} value={entry}>{copy.rules[entry]}</option>)}
        </select>
        <button disabled={normalized === undefined} onClick={add}>{copy.add}</button>
      </div>
      <small className="trusted-note">{copy.trustedNote}</small>
      {value.siteRules.map((entry) => (
        <div className="trusted-origin" key={entry.pattern}>
          <code>{entry.pattern}</code>
          <span>{copy.rules[entry.rule]}</span>
          <button onClick={() => onChange({ ...value, siteRules: value.siteRules.filter((candidate) => candidate.pattern !== entry.pattern) })}>
            {copy.remove}
          </button>
        </div>
      ))}
      <SettingToggle
        title={copy.exemptLocal}
        help={copy.exemptLocalHelp}
        checked={value.taintExemptLocalPages && managed?.disableLocalTaintExemption !== true}
        disabled={managed?.disableLocalTaintExemption === true}
        onChange={(checked) => onChange({ ...value, taintExemptLocalPages: checked })}
      />
      <SettingToggle
        title={copy.exemptTrusted}
        help={copy.exemptTrustedHelp}
        checked={value.taintExemptTrustedSites && managed?.disableTrustedTaintExemption !== true}
        disabled={managed?.disableTrustedTaintExemption === true}
        onChange={(checked) => onChange({ ...value, taintExemptTrustedSites: checked })}
      />
      <div className="strict-mode">
        <strong>{copy.strictTitle}</strong>
        <small>{STRICT_AVAILABLE ? copy.strictHelp : copy.strictUnavailable}</small>
        <div className="trusted-origin-add">
          <input
            aria-label={copy.strictSiteLabel}
            value={strictPattern}
            disabled={!STRICT_AVAILABLE}
            onChange={(event) => setStrictPattern(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addStrict() }}
            placeholder="shop.example.com"
          />
          <button disabled={!STRICT_AVAILABLE || strictNormalized === undefined} onClick={addStrict}>{copy.add}</button>
        </div>
        {value.strictSites.map((pattern) => (
          <div className="trusted-origin" key={`strict-${pattern}`}>
            <code>{pattern}</code>
            <button onClick={() => onChange({ ...value, strictSites: value.strictSites.filter((candidate) => candidate !== pattern) })}>
              {copy.remove}
            </button>
          </div>
        ))}
      </div>
      {managed?.active === true && (
        <div className="managed-policy">
          <small>{copy.managedIntro}</small>
          {managed.siteRules.map((entry) => (
            <div className="trusted-origin" key={`managed-${entry.pattern}`}>
              <code>{entry.pattern}</code>
              <span>{copy.rules[entry.rule]}</span>
            </div>
          ))}
          {managed.disableUnrestricted && <small>{copy.managedNoUnrestricted}</small>}
          {managed.disableDevTools && <small>{copy.managedNoDevTools}</small>}
          {managed.disableScreenshots && <small>{copy.managedNoScreenshots}</small>}
          {managed.disableLocalTaintExemption && <small>{copy.managedNoLocalExemption}</small>}
          {managed.disableTrustedTaintExemption && <small>{copy.managedNoTrustedExemption}</small>}
          {managed.allowedOrigins !== undefined && <small>{copy.managedAllowedOnly(managed.allowedOrigins)}</small>}
        </div>
      )}
    </section>
  )
}
