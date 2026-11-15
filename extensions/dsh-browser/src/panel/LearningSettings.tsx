/**
 * Settings section for the Phase 3 learning features. Every switch is off by
 * default and saves immediately (the background owns the state); the copy
 * says what each one records and where it goes.
 */

import { useEffect, useRef, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { LearningSettings as Settings } from '../background/learning.ts'
import { connectLearning, type LearningClient, type LearningClientErrors, type LearningState } from './learning-api.ts'
import { hasOptionalPermission, requestOptionalPermission } from './browser-helpers.ts'
import { SettingToggle } from './SettingToggle.tsx'
import { EntryAdd, EntryList, LearnMore, SettingsGroup } from './SettingsKit.tsx'
import { PANEL_COPY } from './strings.ts'

/** Subscribe to the learning runtime for one conversation. */
export function useLearning(sessionId: string | undefined, locale: UiLocale = 'en'): { state: LearningState | null; client: LearningClient | null } {
  const [state, setState] = useState<LearningState | null>(null)
  const [client, setClient] = useState<LearningClient | null>(null)
  // Read at error time, so a language switch needs no reconnect.
  const localeRef = useRef(locale)
  localeRef.current = locale
  useEffect(() => {
    // The previous conversation's steps must not show until the next push.
    setState(null)
    if (typeof chrome === 'undefined' || chrome.runtime?.connect === undefined) return undefined
    const errors: LearningClientErrors = {
      get failed() { return PANEL_COPY[localeRef.current].learning.requestFailed },
      get disconnected() { return PANEL_COPY[localeRef.current].learning.disconnected },
    }
    const next = connectLearning(sessionId, setState, errors)
    setClient(next)
    return () => {
      next.dispose()
      setClient((current) => current === next ? null : current)
    }
  }, [sessionId])
  return { state, client }
}

export function LearningSettings({ locale, sessionId, note }: {
  locale: UiLocale
  sessionId?: string
  /** Shown beside the title: these switches apply at once, without Save. */
  note?: string
}): React.JSX.Element {
  const copy = PANEL_COPY[locale].learning
  const { state, client } = useLearning(sessionId, locale)
  const [origin, setOrigin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const settings = state?.settings
  const update = (next: Partial<Settings>): void => {
    setError(null)
    void client?.request('learning.settings', { settings: next }).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }
  const parsedOrigin = (() => {
    try {
      const url = new URL(origin.includes('://') ? origin : `https://${origin}`)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
    } catch {
      return undefined
    }
  })()
  return (
    <SettingsGroup title={copy.settingsTitle} className="learning-settings" {...(note === undefined ? {} : { note })}>
      <div className="setting-row">
        <p className="setting-help">{copy.settingsHelp}</p>
        <LearnMore><p>{copy.settingsMore}</p></LearnMore>
      </div>
      <SettingToggle
        title={copy.workflowsTitle}
        help={copy.workflowsHelp}
        more={<p>{copy.workflowsMore}</p>}
        checked={settings?.workflows ?? false}
        disabled={settings === undefined}
        onChange={(checked) => update({ workflows: checked })}
      />
      <SettingToggle
        title={copy.watchMeTitle}
        help={copy.watchMeHelp}
        more={<p>{copy.watchMeMore}</p>}
        checked={settings?.watchMe ?? false}
        disabled={settings === undefined}
        onChange={(checked) => update({ watchMe: checked })}
      />
      <SettingToggle
        title={copy.driversTitle}
        help={state?.siteDriversSupported === false ? copy.driversUnavailable : copy.driversHelp}
        {...(state?.siteDriversSupported === false ? {} : { more: <p>{copy.driversMore}</p> })}
        checked={settings?.siteDrivers ?? false}
        disabled={settings === undefined || state?.siteDriversSupported === false}
        onChange={(checked) => update({ siteDrivers: checked })}
        {...(settings?.siteDrivers === true ? {
          after: (
            <div className="learning-origins">
              <EntryAdd
                label={copy.driverSiteLabel}
                value={origin}
                placeholder="https://shop.example.com"
                valid={parsedOrigin !== undefined}
                error={copy.invalidDriverSite}
                addLabel={copy.add}
                onChange={setOrigin}
                onAdd={() => { if (parsedOrigin !== undefined) { update({ siteDriverOrigins: [...settings.siteDriverOrigins, parsedOrigin] }); setOrigin('') } }}
              />
              <EntryList
                entries={settings.siteDriverOrigins.map((entry) => ({ key: entry, value: entry }))}
                removeLabel={(entry) => copy.removeItem(entry.value)}
                onRemove={(entry) => update({ siteDriverOrigins: settings.siteDriverOrigins.filter((candidate) => candidate !== entry.key) })}
              />
            </div>
          ),
        } : {})}
      />
      <SettingToggle
        title={copy.fixturesTitle}
        help={copy.fixturesHelp}
        more={<p>{copy.fixturesMore}</p>}
        checked={settings?.fixtures ?? false}
        disabled={settings === undefined}
        onChange={(checked) => {
          // The optional permission can only be requested from this click.
          if (checked && hasOptionalPermission('pageCapture')) void requestOptionalPermission('pageCapture')
          update({ fixtures: checked })
        }}
      />
      {error !== null && <div className="setting-row"><p className="field-error learning-error" role="alert">{error}</p></div>}
    </SettingsGroup>
  )
}
