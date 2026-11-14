/**
 * Settings section for per-site policy (security/site-policy.ts): user rules,
 * the built-in defaults switch, and the rules an administrator forces.
 * Edits go through the settings form and take effect on Save.
 */

import { useEffect, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { DEFAULT_SITE_RULES, normalizeSitePattern, SITE_RULES, type SiteRule, type SiteRuleEntry } from '../security/site-policy.ts'
import { parseManagedPolicy, type ManagedPolicy } from '../security/managed-policy.ts'

export interface SitePolicyValue {
  siteRules: SiteRuleEntry[]
  siteDefaultsEnabled: boolean
}

const RULE_LABELS: Record<SiteRule, { en: string; zh: string }> = {
  blocked: { en: 'Blocked (no reads)', zh: '禁止（不可读取）' },
  'read-only': { en: 'Read-only', zh: '只读' },
  ask: { en: 'Always ask', zh: '每次询问' },
  trusted: { en: 'Trusted', zh: '信任' },
}

function t(locale: UiLocale, en: string, zh: string): string {
  return locale === 'zh' ? zh : en
}

export function SitePolicySettings({ value, onChange, locale }: {
  value: SitePolicyValue
  onChange: (next: SitePolicyValue) => void
  locale: UiLocale
}): React.JSX.Element {
  const [pattern, setPattern] = useState('')
  const [rule, setRule] = useState<SiteRule>('read-only')
  const [managed, setManaged] = useState<ManagedPolicy | null>(null)
  useEffect(() => {
    const area = (chrome.storage as { managed?: chrome.storage.StorageArea }).managed
    if (area === undefined) return
    void Promise.resolve(area.get(null)).then((raw) => { setManaged(parseManagedPolicy(raw)) }, () => {})
  }, [])
  const normalized = normalizeSitePattern(pattern)
  const add = (): void => {
    if (normalized === undefined) return
    onChange({ ...value, siteRules: [...value.siteRules.filter((entry) => entry.pattern !== normalized), { pattern: normalized, rule }].sort((a, b) => a.pattern.localeCompare(b.pattern)) })
    setPattern('')
  }
  return (
    <section className="settings-panel site-policy" aria-label={t(locale, 'Site policy', '站点策略')}>
      <div>
        <strong>{t(locale, 'Site policy', '站点策略')}</strong>
        <small>{t(locale,
          'Per-site rules apply before every other setting. "Unrestricted access" trusts every site except these. Patterns: example.com (and subdomains), *bank*, github.com/settings.',
          '站点规则优先于其他所有设置。「完全访问」信任除这些站点外的所有站点。格式：example.com（含子域名）、*bank*、github.com/settings。')}</small>
      </div>
      <label className="setting-toggle">
        <span className="setting-toggle-copy">
          <strong>{t(locale, 'Built-in protections', '内置保护')}</strong>
          <small>{t(locale,
            `Banking and payment, password vaults, account pages, and cloud consoles are read-only (${DEFAULT_SITE_RULES.length} patterns).`,
            `银行与支付、密码库、账户页面和云控制台默认只读（${DEFAULT_SITE_RULES.length} 条规则）。`)}</small>
        </span>
        <input
          className="setting-toggle-input"
          type="checkbox"
          checked={value.siteDefaultsEnabled || managed?.enforceSiteDefaults === true}
          disabled={managed?.enforceSiteDefaults === true}
          onChange={(event) => onChange({ ...value, siteDefaultsEnabled: event.target.checked })}
        />
        <span className="setting-toggle-control" aria-hidden="true"><span /></span>
      </label>
      <div className="trusted-origin-add">
        <input
          aria-label={t(locale, 'Site pattern', '站点规则')}
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') add() }}
          placeholder="example.com / *bank* / github.com/settings"
        />
        <select aria-label={t(locale, 'Rule', '规则')} value={rule} onChange={(event) => setRule(event.target.value as SiteRule)}>
          {SITE_RULES.map((entry) => <option key={entry} value={entry}>{RULE_LABELS[entry][locale === 'zh' ? 'zh' : 'en']}</option>)}
        </select>
        <button disabled={normalized === undefined} onClick={add}>{t(locale, 'Add', '添加')}</button>
      </div>
      {value.siteRules.map((entry) => (
        <div className="trusted-origin" key={entry.pattern}>
          <code>{entry.pattern}</code>
          <span>{RULE_LABELS[entry.rule][locale === 'zh' ? 'zh' : 'en']}</span>
          <button onClick={() => onChange({ ...value, siteRules: value.siteRules.filter((candidate) => candidate.pattern !== entry.pattern) })}>
            {t(locale, 'Remove', '移除')}
          </button>
        </div>
      ))}
      {managed?.active === true && (
        <div className="managed-policy">
          <small>{t(locale, 'Managed by your administrator (overrides the settings above):', '由管理员管理（优先于上方设置）：')}</small>
          {managed.siteRules.map((entry) => (
            <div className="trusted-origin" key={`managed-${entry.pattern}`}>
              <code>{entry.pattern}</code>
              <span>{RULE_LABELS[entry.rule][locale === 'zh' ? 'zh' : 'en']}</span>
            </div>
          ))}
          {managed.disableUnrestricted && <small>{t(locale, 'Unrestricted access is disabled.', '已禁用完全访问。')}</small>}
          {managed.disableDevTools && <small>{t(locale, 'Developer tools are disabled.', '已禁用开发者工具。')}</small>}
          {managed.disableScreenshots && <small>{t(locale, 'Screenshots are disabled.', '已禁用截图。')}</small>}
          {managed.allowedOrigins !== undefined && <small>{t(locale, `Only these sites are allowed: ${managed.allowedOrigins.join(', ') || '(none)'}`, `仅允许以下站点：${managed.allowedOrigins.join('、') || '（无）'}`)}</small>}
        </div>
      )}
    </section>
  )
}
