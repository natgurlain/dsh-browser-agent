/**
 * Chat-view surface of the learning features (only rendered while one is on):
 * Save as workflow (+ saved workflows and their schedules), Watch me with its
 * "Do the remaining N like this" offer, and site-driver proposals.
 */

import { useEffect, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { useLearning } from './LearningSettings.tsx'
import { suggestParamName, type RecordedStep } from '../shared/workflow-build.ts'

function t(locale: UiLocale, en: string, zh: string): string {
  return locale === 'zh' ? zh : en
}

function stepLabel(step: RecordedStep, locale: UiLocale): string {
  const target = step.locator === undefined ? '' : ` ${step.locator.role ?? ''} "${step.locator.name ?? step.locator.text ?? ''}"`
  const value = step.sensitive === true
    ? ` ← •••• ${t(locale, '(asked at replay, never stored)', '（重放时询问，从不存储）')}`
    : step.tool === 'browser_type' ? ` ← "${String(step.args.text ?? '')}"`
      : step.tool === 'browser_navigate' ? ` ${String(step.args.url ?? '')}` : ''
  return `${step.tool.replace(/^browser_/u, '')}${target}${value}`
}

interface SavedWorkflow { name: string; description: string; steps: number; params: Array<{ name: string; default?: string; sensitive?: boolean }> }
interface Schedule { id: string; workflow: string; timing: { kind: string; every_seconds?: number; daily?: { time: string } }; status: string; nextAt?: string }

export function LearningPanel({ locale, sessionId, connected }: { locale: UiLocale; sessionId?: string; connected: boolean }): React.JSX.Element | null {
  const { state, client } = useLearning(sessionId)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [minutes, setMinutes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const settings = state?.settings
  const workflowsOn = settings?.workflows === true

  const report = (promise: Promise<unknown>, success?: (value: unknown) => string): void => {
    setBusy(true)
    setMessage(null)
    void promise.then(
      (value) => { if (success !== undefined) setMessage(success(value)) },
      (error: unknown) => { setMessage(error instanceof Error ? error.message : String(error)) },
    ).finally(() => { setBusy(false) })
  }
  const refresh = (): void => {
    if (client === null || !workflowsOn || !connected) return
    void client.request<{ workflows: SavedWorkflow[] }>('learning.workflow.list').then((value) => { setWorkflows(value.workflows ?? []) }, () => {})
    void client.request<{ schedules: Schedule[] }>('learning.schedule.list').then((value) => { setSchedules(value.schedules ?? []) }, () => {})
  }
  useEffect(refresh, [client, workflowsOn, connected, sessionId])

  if (settings === undefined || (!settings.workflows && !settings.watchMe && !settings.siteDrivers)) return null
  const steps = state?.steps ?? []

  return (
    <section className="learning-panel" aria-label={t(locale, 'Learning', '学习')}>
      {settings.workflows && (
        <div className="learning-block">
          <div className="learning-row">
            <span>{t(locale, `${String(steps.length)} step(s) recorded in this conversation`, `本会话已记录 ${String(steps.length)} 步`)}</span>
            <button className="secondary" disabled={steps.length === 0} onClick={() => setOpen((value) => !value)}>
              {t(locale, 'Save as workflow', '保存为工作流')}
            </button>
          </div>
          {open && steps.length > 0 && (
            <div className="learning-form">
              <input aria-label={t(locale, 'Workflow name', '工作流名称')} placeholder={t(locale, 'Workflow name', '工作流名称')} value={name} onChange={(event) => setName(event.target.value)} />
              <input aria-label={t(locale, 'Description', '描述')} placeholder={t(locale, 'What it does (optional)', '用途（可选）')} value={description} onChange={(event) => setDescription(event.target.value)} />
              <small>{t(locale,
                'Untick steps to leave out. Tick "variable" on a typed value to make it a parameter (its current value becomes the default). Only runs recorded with the setting on can be saved.',
                '取消勾选可排除步骤。在输入值上勾选「变量」即可将其设为参数（当前值作为默认值）。只能保存在开启该设置后记录的运行。')}</small>
              <ol className="learning-steps">
                {steps.map((step) => {
                  const canVary = step.sensitive !== true && (step.tool === 'browser_type' || step.tool === 'browser_select')
                  return (
                    <li key={step.id}>
                      <label>
                        <input type="checkbox" checked={!skip.has(step.id)} onChange={(event) => setSkip((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.delete(step.id)
                          else next.add(step.id)
                          return next
                        })} />
                        <span>{stepLabel(step, locale)}</span>
                      </label>
                      {canVary && (
                        <label className="learning-variable">
                          <input type="checkbox" checked={variables[step.id] !== undefined} onChange={(event) => setVariables((current) => {
                            const next = { ...current }
                            if (event.target.checked) next[step.id] = suggestParamName(step, new Set(Object.values(current)))
                            else delete next[step.id]
                            return next
                          })} />
                          {t(locale, 'variable', '变量')}
                          {variables[step.id] !== undefined && (
                            <input aria-label={t(locale, 'Variable name', '变量名')} value={variables[step.id]} onChange={(event) => setVariables((current) => ({ ...current, [step.id]: event.target.value }))} />
                          )}
                        </label>
                      )}
                    </li>
                  )
                })}
              </ol>
              <div className="learning-row">
                <button className="primary" disabled={busy || name.trim() === '' || !connected}
                  onClick={() => report(client!.request('learning.workflow.save', { choices: { name, description, skip: [...skip], variables } }), (value) => {
                    refresh()
                    setOpen(false)
                    // The saved recording's step ids mean nothing for the next one.
                    setName('')
                    setDescription('')
                    setSkip(new Set())
                    setVariables({})
                    return t(locale, `Saved to ${String((value as { relativePath?: string }).relativePath)}`, `已保存到 ${String((value as { relativePath?: string }).relativePath)}`)
                  })}>
                  {t(locale, 'Save', '保存')}
                </button>
                <button className="secondary" onClick={() => { void client?.request('learning.steps.clear'); setOpen(false) }}>{t(locale, 'Clear recording', '清除记录')}</button>
              </div>
            </div>
          )}
          {workflows.length > 0 && (
            <div className="learning-list">
              <strong>{t(locale, 'Saved workflows', '已保存的工作流')}</strong>
              {workflows.map((workflow) => (
                <div className="learning-item" key={workflow.name}>
                  <code>{workflow.name}</code>
                  <small>{t(locale, `${String(workflow.steps)} steps`, `${String(workflow.steps)} 步`)}</small>
                  <input className="learning-minutes" type="number" min={1} aria-label={t(locale, 'Every N minutes', '每 N 分钟')}
                    placeholder={t(locale, 'min', '分钟')} value={minutes[workflow.name] ?? ''}
                    onChange={(event) => setMinutes((current) => ({ ...current, [workflow.name]: event.target.value }))} />
                  <button className="secondary" disabled={busy || sessionId === undefined || !(Number(minutes[workflow.name]) >= 1)}
                    title={t(locale, 'Runs in this conversation; at least every minute. Approval cards still ask, and fail closed when nobody answers.', '在本会话中运行；最短每分钟一次。批准卡片仍会询问，无人回应时默认拒绝。')}
                    onClick={() => report(client!.request('learning.schedule.create', {
                      workflow: workflow.name,
                      timing: { kind: 'every', every_seconds: Math.round(Number(minutes[workflow.name]) * 60) },
                    }), () => { refresh(); return t(locale, 'Scheduled.', '已定时。') })}>
                    {t(locale, 'Schedule', '定时')}
                  </button>
                </div>
              ))}
            </div>
          )}
          {schedules.length > 0 && (
            <div className="learning-list">
              <strong>{t(locale, 'Schedules', '定时任务')}</strong>
              {schedules.map((schedule) => (
                <div className="learning-item" key={schedule.id}>
                  <code>{schedule.workflow}</code>
                  <small>{schedule.timing.kind === 'every'
                    ? t(locale, `every ${String(Math.round((schedule.timing.every_seconds ?? 0) / 60))} min`, `每 ${String(Math.round((schedule.timing.every_seconds ?? 0) / 60))} 分钟`)
                    : schedule.timing.daily?.time ?? schedule.timing.kind} · {schedule.status}</small>
                  <button className="secondary" disabled={busy} onClick={() => report(client!.request('learning.schedule.cancel', { scheduleId: schedule.id }), () => { refresh(); return t(locale, 'Schedule cancelled.', '已取消定时。') })}>
                    {t(locale, 'Cancel', '取消')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {settings.watchMe && (
        <div className="learning-block">
          <div className="learning-row">
            <span>{state?.watching === null || state?.watching === undefined
              ? t(locale, 'Show me once or twice; I\'ll offer to do the rest.', '示范一两次，我来完成剩下的。')
              : t(locale, `Watching ${state.watching.origin} · ${String(state.watching.events)} input(s)`, `正在观察 ${state.watching.origin} · ${String(state.watching.events)} 次输入`)}</span>
            {state?.watching === null || state?.watching === undefined
              ? <button className="secondary" onClick={() => report(client!.request('learning.watch.start'))}>{t(locale, 'Watch me', '观察我')}</button>
              : <button className="secondary" onClick={() => report(client!.request('learning.watch.stop'))}>{t(locale, 'Stop watching', '停止观察')}</button>}
          </div>
          {state?.suggestion !== null && state?.suggestion !== undefined && (
            <div className="learning-suggestion">
              <small>{t(locale, `You did this ${String(state.suggestion.done)} times:`, `您已重复 ${String(state.suggestion.done)} 次：`)} {state.suggestion.labels.join(' → ')}</small>
              <button className="primary" disabled={busy || !connected}
                onClick={() => report(client!.request('learning.watch.run'), (value) => String((value as { text?: string }).text ?? t(locale, 'Done.', '完成。')))}>
                {t(locale, `Do the remaining ${String(state.suggestion.remaining)} like this`, `按同样方式完成剩余 ${String(state.suggestion.remaining)} 项`)}
              </button>
            </div>
          )}
        </div>
      )}
      {settings.siteDrivers && (
        <div className="learning-block">
          {(state?.proposals ?? []).map((proposal, index) => (
            <div className="learning-suggestion" key={`${proposal.driver.origin}${proposal.driver.path}`}>
              <strong>{t(locale, 'Proposed site driver', '建议的站点驱动')}: <code>{proposal.driver.name}</code></strong>
              <pre className="learning-request">{`${proposal.driver.method} ${proposal.driver.origin}${proposal.driver.path}${proposal.driver.body === undefined ? '' : `\n${proposal.driver.body.template}`}`}</pre>
              <small>{t(locale, 'Parameters', '参数')}: {proposal.driver.params.map((param) => param.name).join(', ') || '—'}</small>
              {proposal.driver.tokens.map((token) => (
                <small key={token.header}>{token.header}: {t(locale, `read from page ${token.source.kind} "${token.source.name}" each time (never stored)`, `每次从页面 ${token.source.kind} "${token.source.name}" 读取（从不存储）`)}</small>
              ))}
              {proposal.droppedHeaders.length > 0 && <small>{t(locale, 'Dropped (no page source)', '已丢弃（无页面来源）')}: {proposal.droppedHeaders.join(', ')}</small>}
              <div className="learning-row">
                <button className="primary" onClick={() => report(client!.request('learning.driver.save', { index }), () => t(locale, 'Driver saved.', '驱动已保存。'))}>{t(locale, 'Save driver', '保存驱动')}</button>
                <button className="secondary" onClick={() => { void client?.request('learning.driver.discard', { index }) }}>{t(locale, 'Discard', '丢弃')}</button>
              </div>
            </div>
          ))}
          {(state?.drivers ?? []).length > 0 && (
            <div className="learning-list">
              <strong>{t(locale, 'Site drivers', '站点驱动')}</strong>
              {state!.drivers.map((driver) => (
                <div className="learning-item" key={`${driver.origin}/${driver.name}`}>
                  <code>{driver.name}</code>
                  <small>{driver.method} {driver.origin}</small>
                  <button className="secondary" onClick={() => { void client?.request('learning.driver.delete', { origin: driver.origin, name: driver.name }) }}>{t(locale, 'Delete', '删除')}</button>
                </div>
              ))}
            </div>
          )}
          <div className="learning-row">
            <button className="secondary" onClick={() => {
              void client?.request<string>('learning.driver.export').then((text) => {
                const link = document.createElement('a')
                link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
                link.download = 'dsh-site-drivers.json'
                link.click()
                URL.revokeObjectURL(link.href)
              })
            }}>{t(locale, 'Export drivers', '导出驱动')}</button>
            <label className="secondary learning-import">
              {t(locale, 'Import…', '导入…')}
              <input type="file" accept="application/json,.json" onChange={(event) => {
                const input = event.target
                const file = input.files?.[0]
                // Without a reset, picking the same file again fires no change event.
                input.value = ''
                if (file === undefined) return
                report(file.text().then((text) => client!.request('learning.driver.import', { text })), (count) => t(locale, `Imported ${String(count)} driver(s).`, `已导入 ${String(count)} 个驱动。`))
              }} />
            </label>
          </div>
        </div>
      )}
      {message !== null && <p className="learning-message" role="status">{message}</p>}
    </section>
  )
}
