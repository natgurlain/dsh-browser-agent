/**
 * Settings rows for the taint exemptions (security/taint-exempt.ts): the two
 * switches, the user's local pages, the sites whose pages are not treated as
 * untrusted content, and the one-time confirmation of trusted sites that
 * predate the exemption. Edits go through the settings form and take effect
 * on Save.
 */

import { useEffect, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { parseManagedPolicy, type ManagedPolicy } from '../security/managed-policy.ts'
import type { SiteRuleEntry } from '../security/site-policy.ts'
import { normalizeTaintLocalOrigins, TAINT_EXEMPTION_SWITCHES, trustKeys } from '../security/taint-exempt.ts'
import { SettingToggle } from './SettingToggle.tsx'
import { Callout, EntryAdd, EntryList } from './SettingsKit.tsx'
import { PANEL_COPY } from './strings.ts'

export interface TaintExemptionValue {
  taintExemptLocalPages: boolean
  taintExemptTrustedSites: boolean
  taintLocalOrigins: string[]
  taintTrustedSites: string[]
  taintTrustConfirmed: string[]
  /** Read only here: what can be confirmed. */
  siteRules: SiteRuleEntry[]
  trustedActionOrigins: string[]
}

type Editable = Pick<TaintExemptionValue, 'taintExemptLocalPages' | 'taintExemptTrustedSites' | 'taintLocalOrigins' | 'taintTrustedSites' | 'taintTrustConfirmed'>

/** A confirmation key as the user knows the entry (`rule:x.com` → `x.com`). */
function keyLabel(key: string): string {
  return key.replace(/^(?:rule|origin):/, '')
}

export function TaintExemptionSettings({ value, onChange, locale }: {
  value: TaintExemptionValue
  onChange: (next: Partial<Editable>) => void
  locale: UiLocale
}): React.JSX.Element {
  const copy = PANEL_COPY[locale].sitePolicy
  const [managed, setManaged] = useState<ManagedPolicy | null>(null)
  const [localInput, setLocalInput] = useState('')
  useEffect(() => {
    const area = (chrome.storage as { managed?: chrome.storage.StorageArea }).managed
    if (area === undefined) return
    void Promise.resolve(area.get(null)).then((raw) => { setManaged(parseManagedPolicy(raw)) }, () => {})
  }, [])
  const localCandidate = normalizeTaintLocalOrigins([localInput])[0]
  const addLocal = (): void => {
    if (localCandidate === undefined) return
    onChange({ taintLocalOrigins: [...new Set([...value.taintLocalOrigins, localCandidate])].sort() })
    setLocalInput('')
  }
  const confirmed = new Set(value.taintTrustConfirmed)
  const unconfirmed = TAINT_EXEMPTION_SWITCHES.trustedMigration === 'confirm'
    ? trustKeys(value.siteRules, value.trustedActionOrigins).filter((key) => !confirmed.has(key))
    : []
  const keep = (keys: readonly string[]): void => {
    onChange({ taintTrustConfirmed: [...new Set([...value.taintTrustConfirmed, ...keys])].sort() })
  }
  return (
    <>
      <SettingToggle
        title={copy.exemptLocal}
        help={managed?.disableLocalTaintExemption === true ? copy.managedNoLocalExemption : copy.exemptLocalHelp}
        more={<p>{copy.exemptLocalMore}</p>}
        checked={value.taintExemptLocalPages && managed?.disableLocalTaintExemption !== true}
        disabled={managed?.disableLocalTaintExemption === true}
        onChange={(checked) => onChange({ taintExemptLocalPages: checked })}
        {...(TAINT_EXEMPTION_SWITCHES.loopbackScope === 'confirmed' ? {
          after: (
            <div className="taint-local-origins">
              <EntryAdd
                label={copy.localOriginInput}
                value={localInput}
                placeholder="http://localhost:3000"
                valid={localCandidate !== undefined}
                error={copy.localOriginInvalid}
                addLabel={copy.add}
                onChange={setLocalInput}
                onAdd={addLocal}
              />
              <EntryList
                entries={value.taintLocalOrigins.map((origin) => ({ key: origin, value: origin }))}
                empty={copy.noLocalOrigins}
                removeLabel={(entry) => copy.removeItem(entry.value)}
                onRemove={(entry) => onChange({ taintLocalOrigins: value.taintLocalOrigins.filter((origin) => origin !== entry.key) })}
              />
            </div>
          ),
        } : {})}
      />
      <SettingToggle
        title={copy.exemptTrusted}
        help={managed?.disableTrustedTaintExemption === true ? copy.managedNoTrustedExemption : copy.exemptTrustedHelp}
        more={<p>{copy.exemptTrustedMore}</p>}
        checked={value.taintExemptTrustedSites && managed?.disableTrustedTaintExemption !== true}
        disabled={managed?.disableTrustedTaintExemption === true}
        onChange={(checked) => onChange({ taintExemptTrustedSites: checked })}
        after={(
          <div className="taint-trusted-sites">
            {unconfirmed.length > 0 && (
              <Callout tone="info">
                <p>{copy.keepQuestion(unconfirmed.length)}</p>
                <button type="button" className="secondary small" data-testid="taint-keep-all" onClick={() => keep(unconfirmed)}>{copy.keepAll}</button>
                <EntryList
                  entries={unconfirmed.map((key) => ({ key, value: keyLabel(key) }))}
                  actionText={copy.keepOne}
                  onRemove={(entry) => keep([entry.key])}
                />
              </Callout>
            )}
            <EntryList
              entries={value.taintTrustedSites.map((site) => ({ key: site, value: site, tag: copy.taintTrustedLabel }))}
              empty={copy.noTaintTrusted}
              removeLabel={(entry) => copy.removeItem(entry.value)}
              onRemove={(entry) => onChange({ taintTrustedSites: value.taintTrustedSites.filter((site) => site !== entry.key) })}
            />
          </div>
        )}
      />
    </>
  )
}
