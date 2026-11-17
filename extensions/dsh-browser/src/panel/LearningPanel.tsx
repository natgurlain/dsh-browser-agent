/**
 * Chat-view surface of the learning features (only rendered while one is on):
 * Save as workflow (+ saved workflows and their schedules), Watch me with its
 * "Do the remaining N like this" offer, and site-driver proposals.
 */

import { useEffect, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import { useLearning } from './LearningSettings.tsx'
import { suggestParamName, type RecordedStep } from '../shared/workflow-build.ts'
import { downloadText } from './browser-helpers.ts'
import { PANEL_COPY, type PanelCopy } from './strings.ts'

function stepLabel(step: RecordedStep, copy: PanelCopy['learning']): string {
  const target = step.locator === undefined ? '' : ` ${step.locator.role ?? ''} "${step.locator.name ?? step.locator.text ?? ''}"`
  const value = step.sensitive === true
    ? ` ← •••• ${copy.sensitiveStep}`
    : step.tool === 'browser_type' ? ` ← "${String(step.args.text ?? '')}"`
      : step.tool === 'browser_navigate' ? ` ${String(step.args.url ?? '')}` : ''
  return `${step.tool.replace(/^browser_/u, '')}${target}${value}`
}

interface SavedWorkflow { name: string; description: string; steps: number; params: Array<{ name: string; default?: string; sensitive?: boolean }> }
interface Schedule { id: string; workflow: string; timing: { kind: string; every_seconds?: number; daily?: { time: string } }; status: string; nextAt?: string }

export function LearningPanel({ locale, sessionId, connected }: { locale: UiLocale; sessionId?: string; connected: boolean }): React.JSX.Element | null {
  const copy = PANEL_COPY[locale].learning
  const { state, client } = useLearning(sessionId, locale)
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
    <section className="learning-panel" aria-label={copy.label}>
      {settings.workflows && (
        <div className="learning-block">
          <div className="learning-row">
            <span>{copy.stepsRecorded(steps.length)}</span>
            <button className="secondary" disabled={steps.length === 0} onClick={() => setOpen((value) => !value)}>
              {copy.saveAsWorkflow}
            </button>
          </div>
          {open && steps.length > 0 && (
            <div className="learning-form">
              <input aria-label={copy.workflowName} placeholder={copy.workflowName} value={name} onChange={(event) => setName(event.target.value)} />
              <input aria-label={copy.description} placeholder={copy.descriptionPlaceholder} value={description} onChange={(event) => setDescription(event.target.value)} />
              <small>{copy.saveHelp}</small>
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
                        <span>{stepLabel(step, copy)}</span>
                      </label>
                      {canVary && (
                        <label className="learning-variable">
                          <input type="checkbox" checked={variables[step.id] !== undefined} onChange={(event) => setVariables((current) => {
                            const next = { ...current }
                            if (event.target.checked) next[step.id] = suggestParamName(step, new Set(Object.values(current)))
                            else delete next[step.id]
                            return next
                          })} />
                          {copy.variable}
                          {variables[step.id] !== undefined && (
                            <input aria-label={copy.variableName} value={variables[step.id]} onChange={(event) => setVariables((current) => ({ ...current, [step.id]: event.target.value }))} />
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
                    return copy.savedTo(String((value as { relativePath?: string }).relativePath))
                  })}>
                  {copy.save}
                </button>
                <button className="secondary" onClick={() => { void client?.request('learning.steps.clear').catch(() => {}); setOpen(false) }}>{copy.clearRecording}</button>
              </div>
            </div>
          )}
          {workflows.length > 0 && (
            <div className="learning-list">
              <strong>{copy.savedWorkflows}</strong>
              {workflows.map((workflow) => (
                <div className="learning-item" key={workflow.name}>
                  <code>{workflow.name}</code>
                  <small>{copy.stepCount(workflow.steps)}</small>
                  <input className="learning-minutes" type="number" min={1} aria-label={copy.everyMinutesLabel}
                    placeholder={copy.minutesPlaceholder} value={minutes[workflow.name] ?? ''}
                    onChange={(event) => setMinutes((current) => ({ ...current, [workflow.name]: event.target.value }))} />
                  <button className="secondary" disabled={busy || sessionId === undefined || !(Number(minutes[workflow.name]) >= 1)}
                    title={copy.scheduleHint}
                    onClick={() => report(client!.request('learning.schedule.create', {
                      workflow: workflow.name,
                      timing: { kind: 'every', every_seconds: Math.round(Number(minutes[workflow.name]) * 60) },
                    }), () => { refresh(); return copy.scheduled })}>
                    {copy.schedule}
                  </button>
                </div>
              ))}
            </div>
          )}
          {schedules.length > 0 && (
            <div className="learning-list">
              <strong>{copy.schedules}</strong>
              {schedules.map((schedule) => (
                <div className="learning-item" key={schedule.id}>
                  <code>{schedule.workflow}</code>
                  <small>{schedule.timing.kind === 'every'
                    ? copy.everyMinutes(Math.round((schedule.timing.every_seconds ?? 0) / 60))
                    : schedule.timing.daily?.time ?? schedule.timing.kind} · {schedule.status}</small>
                  <button className="secondary" disabled={busy} onClick={() => report(client!.request('learning.schedule.cancel', { scheduleId: schedule.id }), () => { refresh(); return copy.scheduleCancelled })}>
                    {copy.cancel}
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
              ? copy.watchIdle
              : copy.watching(state.watching.origin, state.watching.events)}</span>
            {state?.watching === null || state?.watching === undefined
              ? <button className="secondary" onClick={() => report(client!.request('learning.watch.start'))}>{copy.watchMe}</button>
              : <button className="secondary" onClick={() => report(client!.request('learning.watch.stop'))}>{copy.stopWatching}</button>}
          </div>
          {state?.suggestion !== null && state?.suggestion !== undefined && (
            <div className="learning-suggestion">
              <small>{copy.repeated(state.suggestion.done)} {state.suggestion.labels.join(' → ')}</small>
              <button className="primary" disabled={busy || !connected}
                // Only a real click is the user's own request (Auto approve's reviewer is told so); a scripted one still runs, without that.
                onClick={(event) => report(client!.request('learning.watch.run', { userClick: event.nativeEvent.isTrusted }), (value) => String((value as { text?: string }).text ?? copy.done))}>
                {copy.doRemaining(state.suggestion.remaining, state.suggestion.program.length, state.suggestion.more === true)}
              </button>
              {state.suggestion.limited === 'indistinct' && <small>{copy.rowsIndistinct}</small>}
            </div>
          )}
          {state?.resume !== null && state?.resume !== undefined && (
            <div className="learning-suggestion">
              <small>{copy.stoppedEarly(state.resume.rows, state.resume.skipped)}</small>
              {state.resume.rows > 0 && (
                <button className="primary" disabled={busy || !connected}
                  onClick={(event) => report(client!.request('learning.watch.continue', { userClick: event.nativeEvent.isTrusted }), (value) => String((value as { text?: string }).text ?? copy.done))}>
                  {copy.continueRemaining(state.resume.rows)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {settings.siteDrivers && (
        <div className="learning-block">
          {(state?.proposals ?? []).map((proposal, index) => (
            <div className="learning-suggestion" key={`${proposal.driver.origin}${proposal.driver.path}`}>
              <strong>{copy.proposedDriver}: <code>{proposal.driver.name}</code></strong>
              <pre className="learning-request">{`${proposal.driver.method} ${proposal.driver.origin}${proposal.driver.path}${proposal.driver.body === undefined ? '' : `\n${proposal.driver.body.template}`}`}</pre>
              <small>{copy.parameters}: {proposal.driver.params.map((param) => param.name).join(', ') || '—'}</small>
              {proposal.driver.tokens.map((token) => (
                <small key={token.header}>{token.header}: {copy.tokenSource(token.source.kind, token.source.name)}</small>
              ))}
              {proposal.droppedHeaders.length > 0 && <small>{copy.dropped}: {proposal.droppedHeaders.join(', ')}</small>}
              <div className="learning-row">
                <button className="primary" onClick={() => report(client!.request('learning.driver.save', { index }), () => copy.driverSaved)}>{copy.saveDriver}</button>
                <button className="secondary" onClick={() => { void client?.request('learning.driver.discard', { index }).catch(() => {}) }}>{copy.discard}</button>
              </div>
            </div>
          ))}
          {(state?.drivers ?? []).length > 0 && (
            <div className="learning-list">
              <strong>{copy.siteDrivers}</strong>
              {state!.drivers.map((driver) => (
                <div className="learning-item" key={`${driver.origin}/${driver.name}`}>
                  <code>{driver.name}</code>
                  <small>{driver.method} {driver.origin}</small>
                  <button className="secondary" onClick={() => { void client?.request('learning.driver.delete', { origin: driver.origin, name: driver.name }).catch(() => {}) }}>{copy.deleteDriver}</button>
                </div>
              ))}
            </div>
          )}
          <div className="learning-row">
            <button className="secondary" onClick={() => {
              if (client === null) return
              report(client.request<string>('learning.driver.export').then((text) => { downloadText('dsh-site-drivers.json', text) }))
            }}>{copy.exportDrivers}</button>
            <label className="secondary learning-import">
              {copy.importDrivers}
              <input type="file" accept="application/json,.json" onChange={(event) => {
                const input = event.target
                const file = input.files?.[0]
                // Without a reset, picking the same file again fires no change event.
                input.value = ''
                if (file === undefined) return
                report(file.text().then((text) => client!.request('learning.driver.import', { text })), (count) => copy.imported(Number(count)))
              }} />
            </label>
          </div>
        </div>
      )}
      {message !== null && <p className="learning-message" role="status">{message}</p>}
    </section>
  )
}
