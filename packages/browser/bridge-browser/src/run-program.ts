/**
 * `browser_run`: execute a short program of existing browser actions without
 * a model round trip between steps.
 *
 * The bridge sequences the program, but every step is an ordinary `tool.call`
 * to the extension, so each one passes the same chain as a model-issued call:
 * pause gate, site policy, taint, kill switch, approval cards with payload
 * binding, and the per-session audit log (each step is its own audit entry,
 * tagged with the program and step number).
 *
 * Approval: the program is first sent to the extension as one `browser_run`
 * call, which shows a single card listing every step's full payload and binds
 * a hash of the whole program. The extension then lets that approval stand in
 * for a step's ordinary action card only when the step is the next one in the
 * approved program and its arguments hash to the approved step. Policy-forced
 * cards (site rules, taint, strict mode), per-call-only cards, and steps on an
 * origin the program card did not name still ask on their own.
 *
 * Guards run as ordinary `browser_wait` calls after their step, so page
 * sharing and read rules apply to them as well.
 *
 * @module
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from './server.ts'
import { toolCallIdArg } from './server.ts'
import { sessionIdOfExec } from './external-caller.ts'
import { UNTRUSTED_CONTENT_TAG, UNTRUSTED_NOTICE_LEAD } from './protocol.ts'
import { errorMessage, isRecord } from './host-api.ts'

/** Most steps one program (one `browser_run` approval call) may hold. */
export const MAX_PROGRAM_STEPS = 25

/**
 * Most steps a program series may hold in total. A series exists only for
 * the user's own "do the remaining N" request (learning/index.ts): the same
 * few selector-targeted steps repeated over rows. It runs as batches of at
 * most {@link MAX_PROGRAM_STEPS} steps under one card that lists every step
 * of every batch; see {@link runProgramSeries}.
 */
export const MAX_SERIES_STEPS = 250

/** Actions a series step may run: selector-targeted input only, never navigation or reads. */
export const SERIES_STEP_TOOLS: ReadonlySet<string> = new Set(['browser_click', 'browser_type', 'browser_select'])

/** Actions a program step may run. No tab management, uploads, clipboard, devtools, or nested programs. */
export const PROGRAM_STEP_TOOLS = [
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_select',
  'browser_hover',
  'browser_drag',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_wait',
  'browser_snapshot',
  'browser_get_text',
  'browser_dialog',
] as const

/** Steps whose answer is page content the model asked for (kept whole in the result). */
const READ_STEP_TOOLS = new Set(['browser_snapshot', 'browser_get_text'])

/** Default and ceiling for one guard's wait. */
const DEFAULT_GUARD_TIMEOUT_MS = 5_000
const MAX_GUARD_TIMEOUT_MS = 25_000
/** Per-step status text kept for non-read steps. */
const MAX_STATUS_CHARS = 300

/** One expected-state guard, checked after its step. */
export interface ProgramGuard {
  urlMatches?: string
  text?: string
  textAbsent?: string
  selector?: string
  value?: { selector: string; equals: string }
  timeoutMs?: number
}

/** One program step. */
export interface ProgramStep {
  tool: typeof PROGRAM_STEP_TOOLS[number]
  args: Record<string, unknown>
  expect?: ProgramGuard
  /**
   * A series step only: what its element looked like when the offer was
   * built. The extension shows it on the card, binds it, and compares it with
   * the page again just before the step.
   */
  target?: SeriesTarget
}

/** What a series step's element looks like (the extension's StepTarget). */
export interface SeriesTarget {
  tag: string
  role: string
  name: string
  /** The row's identity in a person's words. */
  row: string
  /** A digest of what the row says outside its controls ('' when not compared). */
  rowKey: string
}

const TARGET_FIELD_MAX = 200

function parseSeriesTarget(value: unknown): SeriesTarget | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 5) return undefined
  const { tag, role, name, row, rowKey } = value
  const fits = (field: unknown): field is string => typeof field === 'string' && field.length <= TARGET_FIELD_MAX
  return fits(tag) && tag !== '' && fits(role) && fits(name) && fits(row) && fits(rowKey) ? { tag, role, name, row, rowKey } : undefined
}

/** Keys that name an object's prototype machinery: never a tool argument. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Whether any object inside `value` has an own key from {@link UNSAFE_KEYS}. */
export function hasUnsafeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.keys(value).some((key) => UNSAFE_KEYS.has(key) || hasUnsafeKey((value as Record<string, unknown>)[key]))
}

/** Why a program stopped. */
export type ProgramStop = 'completed' | 'error' | 'guard' | 'cancelled' | 'not-approved'

/** Outcome of one executed step. */
export interface ProgramStepResult {
  step: number
  tool: string
  ok: boolean
  /** Status text (whole for read steps, the leading status line otherwise). */
  text: string
  guard?: { ok: boolean; text: string }
}

/** What the runner returns. */
export interface ProgramOutcome {
  stop: ProgramStop
  steps: ProgramStepResult[]
  /** Snapshot delta at the stop point, already inside the untrusted boundary. */
  delta?: string
  message?: string
  /** A series only: whole repetitions (rows) done, of the rows and steps approved. */
  rows?: { done: number; total: number; steps: number }
}

/** The bridge surface the runner uses. */
export type RunnerBridge = Pick<BridgeServer, 'requestTool'>

/** Options resolved from plugin config. */
export interface RunProgramOptions {
  /** Budget for each step's own call. */
  toolTimeoutMs: number
}

/** Thrown for malformed programs (a tool error the model can fix). */
export class ProgramError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProgramError'
  }
}

function optionalString(guard: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = guard[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new ProgramError(`${where}.${key} must be a non-empty string`)
  return value
}

/**
 * Validate a model-supplied program.
 * @param raw - the `steps` argument.
 * @param targets - keep each step's `target` (a program the extension built
 *   from the user's demonstration, never a model's): the extension compares it
 *   with the element the step resolves.
 * @returns the normalized steps.
 * @throws ProgramError naming the first problem.
 */
export function parseProgram(raw: unknown, targets = false): ProgramStep[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ProgramError('steps must be a non-empty array')
  if (raw.length > MAX_PROGRAM_STEPS) throw new ProgramError(`a program holds at most ${String(MAX_PROGRAM_STEPS)} steps`)
  return raw.map((entry, index) => {
    const where = `steps[${String(index)}]`
    if (!isRecord(entry)) throw new ProgramError(`${where} must be an object`)
    const tool = entry.tool
    if (typeof tool !== 'string' || !(PROGRAM_STEP_TOOLS as readonly string[]).includes(tool)) {
      throw new ProgramError(`${where}.tool must be one of ${PROGRAM_STEP_TOOLS.join(', ')}`)
    }
    const args = entry.args ?? {}
    if (!isRecord(args)) throw new ProgramError(`${where}.args must be an object`)
    // The approval card shows the arguments as JSON and hashes them: a key the two could disagree on is refused.
    if (hasUnsafeKey(args)) throw new ProgramError(`${where}.args must not use the names __proto__, constructor or prototype`)
    const step: ProgramStep = { tool: tool as ProgramStep['tool'], args }
    if (entry.expect !== undefined) {
      if (!isRecord(entry.expect)) throw new ProgramError(`${where}.expect must be an object`)
      const raw = entry.expect
      const guard: ProgramGuard = {}
      const at = `${where}.expect`
      for (const key of ['urlMatches', 'text', 'textAbsent', 'selector'] as const) {
        const value = optionalString(raw, key, at)
        if (value !== undefined) guard[key] = value
      }
      if (raw.value !== undefined) {
        if (!isRecord(raw.value) || typeof raw.value.selector !== 'string' || raw.value.selector === '' || typeof raw.value.equals !== 'string') {
          throw new ProgramError(`${at}.value must be { selector, equals }`)
        }
        guard.value = { selector: raw.value.selector, equals: raw.value.equals }
      }
      if (raw.timeoutMs !== undefined) {
        if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
          throw new ProgramError(`${at}.timeoutMs must be a positive number`)
        }
        guard.timeoutMs = Math.min(raw.timeoutMs, MAX_GUARD_TIMEOUT_MS)
      }
      const known = new Set(['urlMatches', 'text', 'textAbsent', 'selector', 'value', 'timeoutMs'])
      const unknown = Object.keys(raw).filter((key) => !known.has(key))
      if (unknown.length > 0) throw new ProgramError(`${at} has unknown field ${unknown.join(', ')}`)
      if (Object.keys(guard).filter((key) => key !== 'timeoutMs').length === 0) {
        throw new ProgramError(`${at} names no condition`)
      }
      step.expect = guard
    }
    if (targets && entry.target !== undefined) {
      const target = parseSeriesTarget(entry.target)
      if (target === undefined) throw new ProgramError(`${where}.target must describe an element (tag, role, name, row, rowKey)`)
      step.target = target
    }
    return step
  })
}

/** The `browser_wait` calls that check one guard, in order. */
export function guardChecks(guard: ProgramGuard): Record<string, unknown>[] {
  const timeoutMs = guard.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS
  const checks: Record<string, unknown>[] = []
  if (guard.urlMatches !== undefined) checks.push({ urlMatches: guard.urlMatches, timeoutMs })
  if (guard.text !== undefined) checks.push({ text: guard.text, timeoutMs })
  if (guard.textAbsent !== undefined) checks.push({ text: guard.textAbsent, gone: true, timeoutMs })
  if (guard.selector !== undefined) checks.push({ selector: guard.selector, timeoutMs })
  if (guard.value !== undefined) checks.push({ selector: guard.value.selector, valueEquals: guard.value.equals, timeoutMs })
  return checks
}

/** Text of a canonical `{ text }` tool result. */
function resultText(result: unknown): string {
  return isRecord(result) && typeof result.text === 'string' ? result.text : ''
}

/**
 * The leading status of an action result: everything before the first
 * untrusted-content notice, so a cut never splits the page-content boundary.
 */
export function statusOf(text: string): string {
  const marks = [text.indexOf(UNTRUSTED_NOTICE_LEAD), text.indexOf(`<${UNTRUSTED_CONTENT_TAG}`)].filter((at) => at !== -1)
  const boundary = marks.length === 0 ? -1 : Math.min(...marks)
  const head = (boundary === -1 ? text : text.slice(0, boundary)).trim()
  return head.length > MAX_STATUS_CHARS ? `${head.slice(0, MAX_STATUS_CHARS)}…` : head
}

/** The bridge closed or the caller cancelled: nothing more can reach the page. */
function isTerminal(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return (error as { code?: unknown }).code === 'bridge-closed'
}

/**
 * Execute an approved program step by step.
 * @param bridge - the bridge server.
 * @param steps - validated steps.
 * @param exec - the caller's signal plus its session and tool-call ids.
 * @param options - per-step budget.
 * @returns per-step results and the stop reason.
 */
export async function runProgram(
  bridge: RunnerBridge,
  steps: ProgramStep[],
  exec: { signal: AbortSignal; sessionId?: string; toolCallId?: string },
  options: RunProgramOptions,
): Promise<ProgramOutcome> {
  const request = (name: string, args: Record<string, unknown>, program?: { id: string; step: number }): Promise<unknown> =>
    bridge.requestTool(name, args, exec.signal, options.toolTimeoutMs, exec.sessionId, exec.toolCallId, program)
  let programId: string
  try {
    const approval = await request('browser_run', { steps })
    if (!isRecord(approval) || typeof approval.programId !== 'string' || approval.programId === '') {
      return { stop: 'not-approved', steps: [], message: 'The extension did not approve the program.' }
    }
    programId = approval.programId
  } catch (error: unknown) {
    return { stop: 'not-approved', steps: [], message: errorMessage(error) }
  }
  const results: ProgramStepResult[] = []
  let stop: ProgramStop = 'completed'
  let message: string | undefined
  let reachable = true
  for (const [index, step] of steps.entries()) {
    if (exec.signal.aborted) {
      stop = 'cancelled'
      reachable = false
      break
    }
    let text: string
    try {
      text = resultText(await request(step.tool, step.args, { id: programId, step: index }))
    } catch (error: unknown) {
      results.push({ step: index + 1, tool: step.tool, ok: false, text: errorMessage(error) })
      stop = exec.signal.aborted ? 'cancelled' : 'error'
      reachable = !isTerminal(error, exec.signal)
      break
    }
    const entry: ProgramStepResult = {
      step: index + 1,
      tool: step.tool,
      ok: true,
      text: READ_STEP_TOOLS.has(step.tool) ? text : statusOf(text),
    }
    results.push(entry)
    if (step.expect === undefined) continue
    for (const check of guardChecks(step.expect)) {
      try {
        entry.guard = { ok: true, text: statusOf(resultText(await request('browser_wait', check))) }
      } catch (error: unknown) {
        entry.guard = { ok: false, text: errorMessage(error) }
        reachable = !isTerminal(error, exec.signal)
        break
      }
    }
    if (entry.guard?.ok === false) {
      stop = exec.signal.aborted ? 'cancelled' : 'guard'
      break
    }
  }
  if (stop === 'error' || stop === 'guard') message = `Stopped at step ${String(results.length)}.`
  if (!reachable) return { stop, steps: results, ...(message === undefined ? {} : { message }) }
  let delta: string | undefined
  try {
    delta = resultText(await request('browser_snapshot', { delta: true }))
  } catch (error: unknown) {
    delta = `(No snapshot delta: ${errorMessage(error)})`
  }
  return { stop, steps: results, delta, ...(message === undefined ? {} : { message }) }
}

/**
 * Validate the steps of a program series (the same `rowSteps` steps repeated
 * over rows). A series spans more than one `browser_run`, so the rules are
 * narrower than a program's: selector-targeted input only, no guards.
 * @throws ProgramError naming the first problem.
 */
export function parseProgramSeries(raw: unknown, rowSteps: unknown): ProgramStep[] {
  if (typeof rowSteps !== 'number' || !Number.isInteger(rowSteps) || rowSteps < 1 || rowSteps > MAX_PROGRAM_STEPS) {
    throw new ProgramError(`rowSteps must be a whole number from 1 to ${String(MAX_PROGRAM_STEPS)}`)
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ProgramError('steps must be a non-empty array')
  if (raw.length > MAX_SERIES_STEPS) throw new ProgramError(`one run does at most ${String(MAX_SERIES_STEPS)} steps in total`)
  if (raw.length % rowSteps !== 0) throw new ProgramError('steps must be whole repetitions of rowSteps steps')
  return raw.map((entry, index) => {
    const where = `steps[${String(index)}]`
    if (!isRecord(entry) || typeof entry.tool !== 'string' || !SERIES_STEP_TOOLS.has(entry.tool)) {
      throw new ProgramError(`${where}.tool must be one of ${[...SERIES_STEP_TOOLS].join(', ')}`)
    }
    if (!isRecord(entry.args) || typeof entry.args.selector !== 'string' || entry.args.selector === '' || entry.args.index !== undefined) {
      throw new ProgramError(`${where} must target its element by selector`)
    }
    if (entry.expect !== undefined) throw new ProgramError(`${where} must not carry an expect`)
    if (hasUnsafeKey(entry.args)) throw new ProgramError(`${where}.args must not use the names __proto__, constructor or prototype`)
    const target = parseSeriesTarget(entry.target)
    if (target === undefined) throw new ProgramError(`${where} must describe its element (target: tag, role, name, row, rowKey)`)
    return { tool: entry.tool as ProgramStep['tool'], args: { ...entry.args }, target }
  })
}

/**
 * Execute a program series: one approval for the whole run, executed as
 * batches that each fit one `browser_run`.
 *
 * The first `browser_run` call carries the first batch plus every later step
 * (`series`), so the extension's single card lists and binds the true total.
 * Each further batch is announced with its own `browser_run` call that names
 * the series (`continues`); the extension lets it stand only when it is
 * exactly the next approved steps, and that call waits at the pause gate like
 * any other, so pause / take over / the kill switch act between batches as
 * well as before every step. A batch starts only after the one before it
 * completed; the first failed step ends the run.
 * @param bridge - the bridge server.
 * @param steps - validated series steps ({@link parseProgramSeries}).
 * @param rowSteps - steps per repetition; batches hold whole repetitions.
 * @param exec - the caller's signal plus its session and tool-call ids.
 * @param options - per-step budget.
 */
export async function runProgramSeries(
  bridge: RunnerBridge,
  steps: ProgramStep[],
  rowSteps: number,
  exec: { signal: AbortSignal; sessionId?: string; toolCallId?: string },
  options: RunProgramOptions,
): Promise<ProgramOutcome> {
  const request = (name: string, args: Record<string, unknown>, program?: { id: string; step: number }): Promise<unknown> =>
    bridge.requestTool(name, args, exec.signal, options.toolTimeoutMs, exec.sessionId, exec.toolCallId, program)
  const batchSteps = Math.floor(MAX_PROGRAM_STEPS / rowSteps) * rowSteps
  const total = { total: steps.length / rowSteps, steps: steps.length }
  const programIdOf = (approval: unknown): string | undefined =>
    isRecord(approval) && typeof approval.programId === 'string' && approval.programId !== '' ? approval.programId : undefined
  let seriesId: string | undefined
  try {
    seriesId = programIdOf(await request('browser_run', { steps: steps.slice(0, batchSteps), series: { rowSteps, later: steps.slice(batchSteps) } }))
  } catch (error: unknown) {
    return { stop: 'not-approved', steps: [], message: errorMessage(error), rows: { done: 0, ...total } }
  }
  if (seriesId === undefined) return { stop: 'not-approved', steps: [], message: 'The extension did not approve the program.', rows: { done: 0, ...total } }
  const results: ProgramStepResult[] = []
  let stop: ProgramStop = 'completed'
  let reachable = true
  let message: string | undefined
  let programId = seriesId
  run: for (let offset = 0; offset < steps.length; offset += batchSteps) {
    const batch = steps.slice(offset, offset + batchSteps)
    if (exec.signal.aborted) {
      stop = 'cancelled'
      reachable = false
      break
    }
    if (offset > 0) {
      // Held at the pause gate while the user has paused or taken over; refused unless it is exactly the next approved steps.
      let refusal: string | undefined
      try {
        const next = programIdOf(await request('browser_run', { steps: batch, continues: seriesId }))
        if (next === undefined) refusal = 'the extension did not continue the program'
        else programId = next
      } catch (error: unknown) {
        refusal = errorMessage(error)
        reachable = !isTerminal(error, exec.signal)
      }
      if (refusal !== undefined) {
        stop = exec.signal.aborted ? 'cancelled' : 'error'
        message = refusal.replace(/\.$/u, '')
        break
      }
    }
    for (const [index, step] of batch.entries()) {
      if (exec.signal.aborted) {
        stop = 'cancelled'
        reachable = false
        break run
      }
      try {
        const text = resultText(await request(step.tool, step.args, { id: programId, step: index }))
        results.push({ step: offset + index + 1, tool: step.tool, ok: true, text: statusOf(text) })
      } catch (error: unknown) {
        results.push({ step: offset + index + 1, tool: step.tool, ok: false, text: errorMessage(error) })
        stop = exec.signal.aborted ? 'cancelled' : 'error'
        reachable = !isTerminal(error, exec.signal)
        message = `Stopped at step ${String(offset + index + 1)}.`
        break run
      }
    }
  }
  const done = Math.floor(results.filter((step) => step.ok).length / rowSteps)
  const outcome: ProgramOutcome = { stop, steps: results, rows: { done, ...total }, ...(message === undefined ? {} : { message }) }
  if (!reachable) return outcome
  try {
    outcome.delta = resultText(await request('browser_snapshot', { delta: true }))
  } catch (error: unknown) {
    outcome.delta = `(No snapshot delta: ${errorMessage(error)})`
  }
  return outcome
}

/**
 * Render a series outcome: rows done of rows approved, and the step that
 * stopped it (a full run would otherwise list hundreds of near-identical lines).
 */
export function renderSeriesOutcome(outcome: ProgramOutcome): string {
  const rows = outcome.rows ?? { done: 0, total: 0, steps: 0 }
  const rowSteps = rows.total === 0 ? 1 : rows.steps / rows.total
  const ran = outcome.steps.filter((step) => step.ok).length
  const after = `Stopped after ${String(rows.done)} of ${String(rows.total)} rows`
  const failed = outcome.steps.find((step) => !step.ok)
  const lines: string[] = []
  if (outcome.stop === 'completed') {
    lines.push(`Done: all ${String(rows.total)} rows (${String(rows.steps)} steps).`)
  } else if (outcome.stop === 'not-approved') {
    lines.push(`Not run: ${outcome.message ?? 'it was not approved'}.`)
  } else if (failed !== undefined) {
    // What happened, to which row, in the words the step itself reported.
    const row = Math.floor((failed.step - 1) / rowSteps) + 1
    lines.push(`${after}. Row ${String(row)}: ${failed.text}`)
    const partial = ran - rows.done * rowSteps
    if (partial > 0) lines.push(`Row ${String(row)} was left part-done (${String(partial)} of ${String(rowSteps)} steps ran); continuing skips it, so finish it by hand.`)
  } else {
    lines.push(`${after}: ${outcome.message ?? (outcome.stop === 'cancelled' ? 'the run was cancelled' : 'the run could not continue')}.`)
  }
  if (outcome.stop !== 'completed' && outcome.stop !== 'not-approved' && rows.done < rows.total) {
    lines.push('Nothing else was done. You can continue with the rows that are left; a new card will show them as the page is now.')
  }
  if (outcome.delta !== undefined) lines.push('', 'Page changes at the stop point:', outcome.delta)
  return lines.join('\n')
}

/** Render the outcome as the tool's text result. */
export function renderProgramOutcome(outcome: ProgramOutcome, total: number): string {
  const lines: string[] = []
  const headline: Record<ProgramStop, string> = {
    completed: `Program completed: ${String(total)} of ${String(total)} steps ran.`,
    error: `Program stopped by an error after ${String(outcome.steps.length)} of ${String(total)} steps.`,
    guard: `Program stopped: the guard after step ${String(outcome.steps.length)} of ${String(total)} failed.`,
    cancelled: `Program cancelled after ${String(outcome.steps.length)} of ${String(total)} steps.`,
    'not-approved': `Program not run: ${outcome.message ?? 'it was not approved'}.`,
  }
  lines.push(headline[outcome.stop])
  for (const step of outcome.steps) {
    lines.push(`${String(step.step)}. ${step.tool} ${step.ok ? 'ok' : 'FAILED'}: ${step.text}`)
    if (step.guard !== undefined) lines.push(`   expect ${step.guard.ok ? 'met' : 'NOT met'}: ${step.guard.text}`)
  }
  if (outcome.delta !== undefined) lines.push('', 'Page changes at the stop point:', outcome.delta)
  return lines.join('\n')
}

const GUARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'State that must hold after the step, or the program stops here.',
  properties: {
    urlMatches: { type: 'string', description: 'URL contains this, or matches /regex/.' },
    text: { type: 'string', description: 'Text present on the page.' },
    textAbsent: { type: 'string', description: 'Text absent from the page.' },
    selector: { type: 'string', description: 'A visible element matches this CSS selector.' },
    value: {
      type: 'object',
      additionalProperties: false,
      description: 'A form field holds exactly this value.',
      properties: {
        selector: { type: 'string', required: true, description: 'CSS selector of the field.' },
        equals: { type: 'string', required: true, description: 'Expected value.' },
      },
    },
    timeoutMs: { type: 'number', description: 'How long to wait for it (default 5000, max 25000).' },
  },
} as const

/** Tool description; kept under the per-tool share of the description cap. */
export const RUN_DESCRIPTION = 'Run up to 25 browser actions in order without pausing between them; one card approves the whole program. Stops at the first error or failed expect.'

/**
 * Register `browser_run`.
 * @param ctx - Cordis context with the tools service.
 * @param bridge - the bridge server.
 * @param options - per-step budget.
 * @returns the tool's disposer.
 */
export function registerRunProgramTool(ctx: Context, bridge: RunnerBridge, options: RunProgramOptions): () => void {
  return ctx.tools.register(defineRunProgramTool(bridge, options))
}

/** The `browser_run` definition (exported for the description-cap spec). */
export function defineRunProgramTool(bridge: RunnerBridge, options: RunProgramOptions): ToolDefinition {
  return defineTool({
    name: 'browser_run',
    description: RUN_DESCRIPTION,
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: 'Steps in order (max 25).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: { type: 'string', required: true, enum: [...PROGRAM_STEP_TOOLS], description: 'Browser tool to call.' },
            args: { type: 'object', additionalProperties: true, description: 'That tool\'s arguments.' },
            expect: GUARD_SCHEMA,
          },
        },
      },
    },
    // Every step has its own budget; the program as a whole may also wait on cards.
    timeoutMs: Math.max(options.toolTimeoutMs * 4, 600_000),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
    },
    execute: async (args, exec: Pick<ToolRunContext, 'agent' | 'signal'>) => {
      const steps = parseProgram((args as { steps?: unknown }).steps)
      const sessionId = sessionIdOfExec(exec)
      const [toolCallId] = toolCallIdArg(exec)
      const outcome = await runProgram(bridge, steps, {
        signal: exec.signal,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      }, options)
      return { text: renderProgramOutcome(outcome, steps.length) }
    },
  })
}
