/**
 * Turn the steps recorded during a run (Save as workflow) into a workflow
 * file object. Pure; the bridge validates the result again before writing.
 *
 * - element steps keep their robust locator (role + name + text + CSS);
 * - a typed value the user marked as a variable becomes a `{{param}}` with
 *   the recorded value as its default;
 * - a value typed into a sensitive field is never carried: the recorder
 *   already dropped it, and the step references a required parameter with no
 *   default.
 *
 * @module
 */

import { WORKFLOW_FORMAT } from '@natgurlain/dsh-browser-agent/src/learning/workflow.ts'

/** Locator recorded for one element (from the content script). */
export interface RecordedLocator {
  role?: string
  name?: string
  text?: string
  css?: string
  frame?: number
}

/** One step the recorder kept (only successful calls with the setting on). */
export interface RecordedStep {
  id: string
  tool: string
  /** Arguments without index/selector/frame; `text` is absent for sensitive fields. */
  args: Record<string, unknown>
  locator?: RecordedLocator
  /** The value went into a sensitive field and was not recorded. */
  sensitive?: boolean
  origin?: string
  at: number
}

/** The user's choices in the Save-as-workflow form. */
export interface WorkflowChoices {
  name: string
  description?: string
  /** Step ids to leave out. */
  skip?: readonly string[]
  /** Step id → parameter name for typed values to turn into variables. */
  variables?: Readonly<Record<string, string>>
}

const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/u

/** Kebab-case workflow name (mirrors the bridge's slug rule). */
export function workflowName(raw: string): string {
  return raw.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48).replace(/-+$/u, '')
}

/** Parameter name suggestion from a locator. */
export function suggestParamName(step: RecordedStep, taken: ReadonlySet<string>): string {
  const base = (step.locator?.name ?? step.locator?.text ?? 'value').toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').replace(/^(\d)/u, 'v$1').slice(0, 30) || 'value'
  let name = PARAM.test(base) ? base : 'value'
  for (let index = 2; taken.has(name); index += 1) name = `${base}_${String(index)}`
  return name
}

/**
 * Build the workflow object.
 * @param steps - recorded steps, oldest first.
 * @param choices - the user's form.
 * @param now - clock seam.
 */
export function buildWorkflow(steps: readonly RecordedStep[], choices: WorkflowChoices, now: Date = new Date()): Record<string, unknown> {
  const name = workflowName(choices.name)
  if (name === '') throw new Error('Give the workflow a name with at least one letter or digit.')
  const skip = new Set(choices.skip ?? [])
  const kept = steps.filter((step) => !skip.has(step.id))
  if (kept.length === 0) throw new Error('Keep at least one step.')
  const params: Array<Record<string, unknown>> = []
  const taken = new Set<string>()
  const addParam = (param: Record<string, unknown>): void => {
    taken.add(String(param.name))
    params.push(param)
  }
  const out = kept.map((step) => {
    const args: Record<string, unknown> = { ...step.args }
    let sensitive = false
    if (step.tool === 'browser_type' && step.sensitive === true) {
      const param = suggestParamName(step, taken)
      addParam({ name: param, sensitive: true, description: `Value for ${step.locator?.name ?? 'a sensitive field'} (never stored).` })
      args.text = `{{${param}}}`
      sensitive = true
    } else {
      const variable = choices.variables?.[step.id]
      const value = step.tool === 'browser_type' ? args.text : step.tool === 'browser_select' ? args.value : undefined
      if (variable !== undefined && typeof value === 'string') {
        if (!PARAM.test(variable) || taken.has(variable)) throw new Error(`"${variable}" is not a usable variable name.`)
        addParam({ name: variable, default: value, description: `Value for ${step.locator?.name ?? step.tool}.` })
        if (step.tool === 'browser_type') args.text = `{{${variable}}}`
        else args.value = `{{${variable}}}`
      }
    }
    // Defensive: a recorded index or selector never reaches the file.
    delete args.index
    delete args.selector
    delete args.frame
    return {
      tool: step.tool,
      ...(step.locator === undefined ? {} : { locator: step.locator }),
      args,
      ...(sensitive ? { sensitive: true } : {}),
    }
  })
  return {
    format: WORKFLOW_FORMAT,
    name,
    description: (choices.description ?? '').slice(0, 500),
    ...(kept[0]?.origin === undefined ? {} : { origin: kept[0].origin }),
    createdAt: now.toISOString(),
    params,
    steps: out,
  }
}
