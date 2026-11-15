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

export function LearningSettings({ locale, sessionId }: { locale: UiLocale; sessionId?: string }): React.JSX.Element {
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
    <section className="settings-panel learning-settings" aria-label={copy.settingsTitle}>
      <div>
        <strong>{copy.settingsTitle}</strong>
        <small>{copy.settingsHelp}</small>
      </div>
      <SettingToggle
        title={copy.workflowsTitle}
        help={copy.workflowsHelp}
        checked={settings?.workflows ?? false}
        disabled={settings === undefined}
        onChange={(checked) => update({ workflows: checked })}
      />
      <SettingToggle
        title={copy.watchMeTitle}
        help={copy.watchMeHelp}
        checked={settings?.watchMe ?? false}
        disabled={settings === undefined}
        onChange={(checked) => update({ watchMe: checked })}
      />
      <SettingToggle
        title={copy.driversTitle}
        help={state?.siteDriversSupported === false ? copy.driversUnavailable : copy.driversHelp}
        checked={settings?.siteDrivers ?? false}
        disabled={settings === undefined || state?.siteDriversSupported === false}
        onChange={(checked) => update({ siteDrivers: checked })}
      />
      {settings?.siteDrivers === true && (
        <div className="learning-origins">
          <div className="trusted-origin-add">
            <input aria-label={copy.driverSiteLabel} value={origin} placeholder="https://shop.example.com"
              onChange={(event) => setOrigin(event.target.value)} />
            <button disabled={parsedOrigin === undefined}
              onClick={() => { if (parsedOrigin !== undefined) { update({ siteDriverOrigins: [...settings.siteDriverOrigins, parsedOrigin] }); setOrigin('') } }}>
              {copy.add}
            </button>
          </div>
          {settings.siteDriverOrigins.map((entry) => (
            <div className="trusted-origin" key={entry}>
              <code>{entry}</code>
              <button onClick={() => update({ siteDriverOrigins: settings.siteDriverOrigins.filter((candidate) => candidate !== entry) })}>{copy.remove}</button>
            </div>
          ))}
        </div>
      )}
      <SettingToggle
        title={copy.fixturesTitle}
        help={copy.fixturesHelp}
        checked={settings?.fixtures ?? false}
        disabled={settings === undefined}
        onChange={(checked) => {
          // The optional permission can only be requested from this click.
          if (checked && hasOptionalPermission('pageCapture')) void requestOptionalPermission('pageCapture')
          update({ fixtures: checked })
        }}
      />
      {error !== null && <p className="learning-error" role="alert">{error}</p>}
    </section>
  )
}
