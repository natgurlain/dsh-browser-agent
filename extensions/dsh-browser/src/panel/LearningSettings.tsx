/**
 * Settings section for the Phase 3 learning features. Every switch is off by
 * default and saves immediately (the background owns the state); the copy
 * says what each one records and where it goes.
 */

import { useEffect, useRef, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { LearningSettings as Settings } from '../background/learning.ts'
import { connectLearning, type LearningClient, type LearningState } from './learning-api.ts'

function t(locale: UiLocale, en: string, zh: string): string {
  return locale === 'zh' ? zh : en
}

/** Subscribe to the learning runtime for one conversation. */
export function useLearning(sessionId: string | undefined): { state: LearningState | null; client: LearningClient | null } {
  const [state, setState] = useState<LearningState | null>(null)
  const clientRef = useRef<LearningClient | null>(null)
  const [, force] = useState(0)
  useEffect(() => {
    if (typeof chrome === 'undefined' || chrome.runtime?.connect === undefined) return undefined
    const client = connectLearning(sessionId, setState)
    clientRef.current = client
    force((value) => value + 1)
    return () => {
      client.dispose()
      if (clientRef.current === client) clientRef.current = null
    }
  }, [sessionId])
  return { state, client: clientRef.current }
}

function Toggle({ title, help, checked, disabled, onChange }: {
  title: string
  help: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="setting-toggle">
      <span className="setting-toggle-copy">
        <strong>{title}</strong>
        <small>{help}</small>
      </span>
      <input className="setting-toggle-input" type="checkbox" checked={checked} disabled={disabled === true}
        onChange={(event) => onChange(event.target.checked)} />
      <span className="setting-toggle-control" aria-hidden="true"><span /></span>
    </label>
  )
}

export function LearningSettings({ locale, sessionId }: { locale: UiLocale; sessionId?: string }): React.JSX.Element {
  const { state, client } = useLearning(sessionId)
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
    <section className="settings-panel learning-settings" aria-label={t(locale, 'Learning (experimental)', '学习功能（实验性）')}>
      <div>
        <strong>{t(locale, 'Learning (experimental)', '学习功能（实验性）')}</strong>
        <small>{t(locale,
          'All off by default. These features record what happens in the browser so it can be repeated; every replayed action still goes through site rules, the pause and kill switches, and approval cards.',
          '默认全部关闭。这些功能会记录浏览器中的操作以便重复执行；每个重放的操作仍然经过站点规则、暂停与紧急停止以及批准卡片。')}</small>
      </div>
      <Toggle
        title={t(locale, 'Record runs for "Save as workflow"', '记录运行以便「保存为工作流」')}
        help={t(locale,
          'Keeps the agent\'s successful steps in memory with how to find each element again (role, name, text, CSS). Values typed into password or other sensitive fields are never recorded. Saved workflows are JSON files in the session workspace and become skills; they can be replayed or scheduled.',
          '在内存中保存代理成功执行的步骤以及重新定位每个元素的方式（角色、名称、文本、CSS）。输入到密码等敏感字段的值从不记录。保存的工作流是会话工作区中的 JSON 文件并注册为技能，可重放或定时运行。')}
        checked={settings?.workflows ?? false}
        disabled={settings === undefined}
        onChange={(checked) => update({ workflows: checked })}
      />
      <Toggle
        title={t(locale, 'Watch me (experimental)', '观察我（实验性）')}
        help={t(locale,
          'Shows a "Watch me" button. While it is on, your own clicks and typing on the current tab are recorded (passwords never; sensitive fields masked) to offer "Do the remaining N like this" after you repeat something twice.',
          '显示「观察我」按钮。开启观察时，会记录您在当前标签页上的点击和输入（从不记录密码，敏感字段被遮盖），在您重复两次后提供「按同样方式完成剩余 N 项」。')}
        checked={settings?.watchMe ?? false}
        disabled={settings === undefined}
        onChange={(checked) => update({ watchMe: checked })}
      />
      <Toggle
        title={t(locale, 'Site drivers (experimental)', '站点驱动（实验性）')}
        help={state?.siteDriversSupported === false
          ? t(locale, 'Unavailable in this browser: site drivers need the Chrome debugger.', '此浏览器不可用：站点驱动需要 Chrome 调试器。')
          : t(locale,
            'For the sites listed below, learns the same-origin request behind an agent action (needs developer tools allowed, so network capture runs) and proposes a reusable tool. Nothing is saved until you approve it; secrets and cookies are never stored. Every use shows the exact request on an approval card.',
            '对下方列出的站点，学习代理操作背后的同源请求（需允许开发者工具以进行网络捕获）并建议一个可复用的工具。经您批准才会保存；从不存储密钥和 Cookie。每次使用都会在批准卡片上显示确切请求。')}
        checked={settings?.siteDrivers ?? false}
        disabled={settings === undefined || state?.siteDriversSupported === false}
        onChange={(checked) => update({ siteDrivers: checked })}
      />
      {settings?.siteDrivers === true && (
        <div className="learning-origins">
          <div className="trusted-origin-add">
            <input aria-label={t(locale, 'Site for drivers', '站点驱动的站点')} value={origin} placeholder="https://shop.example.com"
              onChange={(event) => setOrigin(event.target.value)} />
            <button disabled={parsedOrigin === undefined}
              onClick={() => { if (parsedOrigin !== undefined) { update({ siteDriverOrigins: [...settings.siteDriverOrigins, parsedOrigin] }); setOrigin('') } }}>
              {t(locale, 'Add', '添加')}
            </button>
          </div>
          {settings.siteDriverOrigins.map((entry) => (
            <div className="trusted-origin" key={entry}>
              <code>{entry}</code>
              <button onClick={() => update({ siteDriverOrigins: settings.siteDriverOrigins.filter((candidate) => candidate !== entry) })}>{t(locale, 'Remove', '移除')}</button>
            </div>
          ))}
        </div>
      )}
      <Toggle
        title={t(locale, 'Save failures as test fixtures', '将失败保存为测试样例')}
        help={t(locale,
          'When a step fails (denied, element not found, guard, retry), saves the page and the intended action under browser-fixtures/ in the session workspace. Sensitive field values are masked; a full MHTML copy is used only for pages without sensitive fields and if you grant the page-capture permission.',
          '步骤失败（被拒绝、找不到元素、防护拦截、重试）时，将页面和预期操作保存到会话工作区的 browser-fixtures/ 下。敏感字段值会被遮盖；仅当页面没有敏感字段且您授予页面捕获权限时才保存完整 MHTML。')}
        checked={settings?.fixtures ?? false}
        disabled={settings === undefined}
        onChange={(checked) => {
          // The optional permission can only be requested from this click.
          if (checked && typeof chrome.permissions?.request === 'function' && chrome.runtime.getManifest().optional_permissions?.includes('pageCapture' as chrome.runtime.ManifestPermissions)) {
            void chrome.permissions.request({ permissions: ['pageCapture'] }).catch(() => false)
          }
          update({ fixtures: checked })
        }}
      />
      {error !== null && <p className="learning-error" role="alert">{error}</p>}
    </section>
  )
}
