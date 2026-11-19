/**
 * Saved browser workflows ("Save as workflow"): the on-disk JSON format, its
 * validation, parameter substitution, and the DSH skill a saved workflow
 * becomes.
 *
 * A workflow is a list of steps recorded from a completed run. Every step
 * that targets an element carries a robust locator (role + accessible name +
 * short text + a CSS fallback); a snapshot index is never stored, because it
 * is meaningless on the next visit. Typed values the user marked as variables
 * become `{{param}}` placeholders. Values typed into sensitive fields are
 * never stored: such a step must reference a parameter that has no default,
 * so the value is supplied at replay time and never written to disk.
 *
 * @module @natgurlain/dsh-browser-agent/src/learning/workflow
 */

import { wrapUntrustedPageText } from '../protocol.ts'
import { isRecord } from '../host-api.ts'

/** File format marker written into every workflow file. */
export const WORKFLOW_FORMAT = 'dsh-browser-workflow/v1'

/** Workspace directory (relative) workflows are saved into. */
export const WORKFLOW_DIRECTORY = 'browser-workflows'

/** File-name suffix that marks a workflow file. */
export const WORKFLOW_SUFFIX = '.workflow.json'

/** Most steps one workflow may hold. */
export const MAX_WORKFLOW_STEPS = 200

/** Tools a workflow step may replay (element and navigation actions only). */
export const REPLAYABLE_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_scroll',
  'browser_hover',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_wait',
])

/** Tools whose step must carry a locator (they act on one element). */
export const ELEMENT_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select', 'browser_hover'])

/** How a step finds its element on replay. */
export interface WorkflowLocator {
  /** ARIA role (explicit or implicit). */
  role?: string
  /** Accessible name (label, aria-label, text). */
  name?: string
  /** Short own text of the element. */
  text?: string
  /** CSS selector captured at record time: tried first, never trusted alone. */
  css?: string
  /** Iframe number at record time (top page when absent). */
  frame?: number
}

/** One replayable step. */
export interface WorkflowStep {
  tool: string
  /** Element locator for element-targeting tools. */
  locator?: WorkflowLocator
  /**
   * Remaining arguments (never `index` or `selector`). String values may hold
   * `{{param}}` placeholders.
   */
  args: Record<string, unknown>
  /** Short human description shown in the panel. */
  label?: string
}

/** One workflow parameter. */
export interface WorkflowParam {
  name: string
  description?: string
  /** Default value; never present for a sensitive parameter. */
  default?: string
  /** The value goes into a sensitive field: it is never stored and must be supplied. */
  sensitive?: boolean
}

/** A saved workflow file. */
export interface Workflow {
  format: typeof WORKFLOW_FORMAT
  /** Kebab-case name (also the skill name, prefixed). */
  name: string
  description: string
  /** Origin the workflow was recorded on. */
  origin?: string
  createdAt: string
  params: WorkflowParam[]
  steps: WorkflowStep[]
}

/** A malformed workflow or argument set. */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/u
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu
const FORBIDDEN_ARGS = new Set(['index', 'selector', 'frame'])
const MAX_STRING = 4_000

/** Skill name registered for a workflow. */
export function workflowSkillName(name: string): string {
  return `browser-workflow-${name}`
}

/** Placeholders referenced by a string. */
export function placeholdersIn(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

function validateLocator(value: unknown, at: string): WorkflowLocator {
  if (!isRecord(value)) throw new WorkflowError(`${at}: locator must be an object.`)
  const locator: WorkflowLocator = {}
  for (const key of ['role', 'name', 'text', 'css'] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'string' || field.length > 500) throw new WorkflowError(`${at}: locator.${key} must be a short string.`)
    if (field !== '') locator[key] = field
  }
  if (value.frame !== undefined) {
    if (typeof value.frame !== 'number' || !Number.isInteger(value.frame) || value.frame < 0) throw new WorkflowError(`${at}: locator.frame must be a non-negative integer.`)
    locator.frame = value.frame
  }
  // Robustness: a CSS path alone is the brittle locator this format replaces.
  if (locator.name === undefined && locator.text === undefined && locator.role === undefined) {
    throw new WorkflowError(`${at}: a locator needs a role, name, or text besides its CSS fallback.`)
  }
  return locator
}

function validateArgValue(value: unknown, at: string, depth = 0): void {
  if (depth > 3) throw new WorkflowError(`${at}: arguments are nested too deeply.`)
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) throw new WorkflowError(`${at}: a string argument is too long.`)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) validateArgValue(item, at, depth + 1)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) validateArgValue(item, at, depth + 1)
    return
  }
  throw new WorkflowError(`${at}: unsupported argument value.`)
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (isRecord(value)) return Object.values(value).flatMap(stringsOf)
  return []
}

/**
 * Validate an untrusted workflow object (from the panel or a file).
 * @param value - parsed JSON.
 * @returns the validated workflow.
 */
export function validateWorkflow(value: unknown): Workflow {
  if (!isRecord(value)) throw new WorkflowError('a workflow must be a JSON object.')
  if (value.format !== WORKFLOW_FORMAT) throw new WorkflowError(`unsupported workflow format ${JSON.stringify(value.format)}.`)
  if (typeof value.name !== 'string' || !NAME.test(value.name) || value.name.length > 48) {
    throw new WorkflowError('the workflow name must be kebab-case (a-z, 0-9, -), at most 48 characters.')
  }
  const description = typeof value.description === 'string' ? value.description.slice(0, 500) : ''
  const origin = typeof value.origin === 'string' && /^https?:\/\/[^/]+$/u.test(value.origin) ? value.origin : undefined
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString()
  if (!Array.isArray(value.params) || value.params.length > 40) throw new WorkflowError('params must be a list of at most 40 entries.')
  const params: WorkflowParam[] = []
  for (const [index, raw] of value.params.entries()) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !PARAM_NAME.test(raw.name)) {
      throw new WorkflowError(`params[${String(index)}]: a parameter needs an identifier name.`)
    }
    if (params.some((param) => param.name === raw.name)) throw new WorkflowError(`duplicate parameter "${raw.name}".`)
    const sensitive = raw.sensitive === true
    if (sensitive && raw.default !== undefined) {
      throw new WorkflowError(`parameter "${raw.name}" fills a sensitive field, so it cannot store a default value.`)
    }
    if (raw.default !== undefined && (typeof raw.default !== 'string' || raw.default.length > MAX_STRING)) {
      throw new WorkflowError(`parameter "${raw.name}": default must be a string.`)
    }
    params.push({
      name: raw.name,
      ...(typeof raw.description === 'string' && raw.description !== '' ? { description: raw.description.slice(0, 200) } : {}),
      ...(typeof raw.default === 'string' ? { default: raw.default } : {}),
      ...(sensitive ? { sensitive: true } : {}),
    })
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_WORKFLOW_STEPS) {
    throw new WorkflowError(`steps must hold 1–${String(MAX_WORKFLOW_STEPS)} entries.`)
  }
  const known = new Set(params.map((param) => param.name))
  const steps: WorkflowStep[] = value.steps.map((raw, index) => {
    const at = `steps[${String(index)}]`
    if (!isRecord(raw) || typeof raw.tool !== 'string' || !REPLAYABLE_TOOLS.has(raw.tool)) {
      throw new WorkflowError(`${at}: tool must be one of ${[...REPLAYABLE_TOOLS].join(', ')}.`)
    }
    const args = raw.args === undefined ? {} : raw.args
    if (!isRecord(args)) throw new WorkflowError(`${at}: args must be an object.`)
    for (const key of Object.keys(args)) {
      if (FORBIDDEN_ARGS.has(key)) throw new WorkflowError(`${at}: "${key}" is not stored in a workflow; element targets go in locator.`)
    }
    validateArgValue(args, at)
    for (const text of stringsOf(args)) {
      for (const name of placeholdersIn(text)) {
        if (!known.has(name)) throw new WorkflowError(`${at}: placeholder {{${name}}} names no parameter.`)
      }
    }
    if (raw.tool === 'browser_type' && typeof args.text !== 'string') throw new WorkflowError(`${at}: browser_type needs text.`)
    if (raw.sensitive === true) {
      // A sensitive field's value is never stored: only a bare reference to a
      // parameter that has no default is accepted.
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      const refs = placeholdersIn(text)
      const param = params.find((candidate) => candidate.name === refs[0])
      if (refs.length !== 1 || text !== `{{${refs[0]!}}}` || param === undefined || param.default !== undefined) {
        throw new WorkflowError(`${at}: a value typed into a sensitive field is never stored; reference a parameter without a default instead.`)
      }
      param.sensitive = true
    }
    const locator = raw.locator === undefined ? undefined : validateLocator(raw.locator, at)
    if (ELEMENT_TOOLS.has(raw.tool) && locator === undefined) throw new WorkflowError(`${at}: ${raw.tool} needs a locator.`)
    if (raw.tool === 'browser_navigate' && (typeof args.url !== 'string' || !/^https?:\/\//u.test(args.url))) {
      throw new WorkflowError(`${at}: browser_navigate needs an http(s) url.`)
    }
    return {
      tool: raw.tool,
      ...(locator === undefined ? {} : { locator }),
      args: { ...args },
      ...(typeof raw.label === 'string' && raw.label !== '' ? { label: raw.label.slice(0, 120) } : {}),
    }
  })
  return { format: WORKFLOW_FORMAT, name: value.name, description, ...(origin === undefined ? {} : { origin }), createdAt, params, steps }
}

/**
 * Resolve the parameter values for one replay.
 * @param workflow - the workflow.
 * @param supplied - caller-supplied values.
 * @returns every parameter's value.
 */
export function resolveParams(workflow: Workflow, supplied: Record<string, unknown> = {}): Record<string, string> {
  const values: Record<string, string> = {}
  for (const param of workflow.params) {
    const given = supplied[param.name]
    if (given !== undefined && typeof given !== 'string' && typeof given !== 'number') {
      throw new WorkflowError(`parameter "${param.name}" must be a string.`)
    }
    const value = given === undefined ? param.default : String(given)
    if (value === undefined) throw new WorkflowError(`parameter "${param.name}" is required${param.sensitive === true ? ' (it fills a sensitive field and is never stored)' : ''}.`)
    values[param.name] = value
  }
  for (const key of Object.keys(supplied)) {
    if (!workflow.params.some((param) => param.name === key)) throw new WorkflowError(`unknown parameter "${key}".`)
  }
  return values
}

/** Replace `{{param}}` placeholders in every string of a value. */
export function substitute(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (_match, name: string) => params[name] ?? '')
  if (Array.isArray(value)) return value.map((item) => substitute(item, params))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params)]))
  return value
}

/** Human summary of one step (skill body, panel). */
export function describeStep(step: WorkflowStep): string {
  const target = step.locator === undefined
    ? ''
    : ` ${step.locator.role ?? 'element'}${step.locator.name === undefined ? '' : ` "${step.locator.name}"`}`
  const extra = step.tool === 'browser_type' ? ` ← ${String(step.args.text)}`
    : step.tool === 'browser_navigate' ? ` ${String(step.args.url)}`
      : step.tool === 'browser_press' ? ` ${String(step.args.key ?? step.args.keys ?? '')}`
        : ''
  return `${step.tool.replace(/^browser_/u, '')}${target}${extra}`
}

/**
 * The instruction body of the skill a saved workflow registers.
 * @param workflow - the workflow.
 * @param relativePath - where it lives in the workspace.
 */
export function workflowSkillContent(workflow: Workflow, relativePath: string, skillNonce: string = crypto.randomUUID()): string {
  const params = workflow.params.length === 0
    ? 'This workflow takes no parameters.'
    : workflow.params.map((param) => `- \`${param.name}\`${param.sensitive === true ? ' (sensitive: ask the user, never store it)' : ''}${param.default === undefined ? ' (required)' : ` (default: ${JSON.stringify(param.default)})`}${param.description === undefined ? '' : ` — ${param.description}`}`).join('\n')
  return [
    `# Browser workflow: ${workflow.name}`,
    '',
    workflow.description === '' ? 'A browser workflow saved from a completed run.' : workflow.description,
    '',
    `Saved at \`${relativePath}\`${workflow.origin === undefined ? '' : `, recorded on ${workflow.origin}`}.`,
    '',
    `Replay it with \`browser_workflow_run { "name": "${workflow.name}", "params": { ... } }\`. The replay runs every step itself`,
    'and only returns to you when a step breaks (its element cannot be found unambiguously); then inspect the page,',
    'do that step yourself, and continue with `fromStep`. Every step still passes the browser approval cards.',
    '',
    '## Parameters',
    params,
    '',
    '## Steps',
    // Locator names, typed text and URLs were recorded from pages: untrusted.
    wrapUntrustedPageText(workflow.steps.map((step, index) => `${String(index + 1)}. ${describeStep(step)}`).join('\n'), skillNonce),
  ].join('\n')
}
