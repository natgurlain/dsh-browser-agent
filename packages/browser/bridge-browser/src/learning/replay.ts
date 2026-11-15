/**
 * Workflow replay: a small sequential executor with fresh element lookup per
 * step ("self-healing"), behind the {@link WorkflowExecutor} interface.
 * Concrete programs ("do the remaining N") run as one `browser_run` through
 * a {@link BrowserProgramRunner} when the bridge supplies one.
 *
 * Every step is an ordinary browser tool call made through the bridge
 * (`requestTool`), so it passes the full extension path: pause gate, site
 * policy, taint, kill switch, payload-bound approval cards, audit log. The
 * executor never talks to the page itself.
 *
 * Element lookup for a step, in order:
 * 1. the recorded CSS selector, accepted only when it matches exactly one
 *    visible element whose role and name agree with the recorded locator;
 * 2. a role + accessible-name search;
 * 3. a text search;
 * each accepted only when exactly one candidate matches the recorded role and
 * name exactly. Anything else stops the replay with `needs-model`: the model
 * is called only when a step breaks.
 *
 * @module @natgurlain/dsh-bridge-browser/src/learning/replay
 */

import { wrapUntrustedPageText } from '../protocol.ts'
import { ELEMENT_TOOLS, resolveParams, substitute, type Workflow, type WorkflowLocator, type WorkflowStep } from './workflow.ts'

/** Outcome of one browser tool call made by the executor. */
export type StepCallResult = { ok: true; text: string } | { ok: false; code: string; message: string }

/** Makes one browser tool call (through the bridge, with the caller's session). */
export type StepCall = (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<StepCallResult>

/** One element candidate reported by `browser_snapshot { query }`. */
export interface FoundCandidate {
  index?: number
  role: string
  label: string
  selector: string
  hidden: boolean
}

/** What happened to one step. */
export interface StepReport {
  step: number
  tool: string
  status: 'done' | 'failed' | 'needs-model' | 'skipped'
  /** How the element was found: css, role-name, text. */
  via?: 'css' | 'role-name' | 'text'
  selector?: string
  message?: string
}

/** A replay's result. */
export interface ReplayReport {
  status: 'completed' | 'failed' | 'needs-model' | 'cancelled'
  steps: StepReport[]
  /** 0-based step that stopped the replay. */
  stoppedAt?: number
  /** Candidates the model can choose from when a lookup was ambiguous. */
  candidates?: FoundCandidate[]
  /** Rendered outcome when a `browser_run` ran the program. */
  text?: string
}

/** A concrete program step (no locator: already resolved). */
export interface ProgramStep {
  tool: string
  args: Record<string, unknown>
}

/** Replay options. */
export interface ReplayOptions {
  /** 0-based first step to run (continue after the model fixed a broken step). */
  fromStep?: number
  signal: AbortSignal
}

/**
 * The executor seam: {@link createSequentialExecutor} (workflows step by
 * step; programs as one `browser_run` when given a runner), or a test double.
 */
export interface WorkflowExecutor {
  runWorkflow(workflow: Workflow, params: Record<string, unknown>, options: ReplayOptions): Promise<ReplayReport>
  runProgram(steps: readonly ProgramStep[], options: ReplayOptions): Promise<ReplayReport>
}

const LABEL_MAX_CHARS = 80
const STATE = '(?:hidden|editable|focusable)'
/**
 * One `renderFound` line. The label is greedy and the selector excludes the
 * middle dot, so a page-authored label containing ` · selector=` cannot spoof
 * the selector: the last field wins, and the role/name check still applies.
 */
const FOUND_LINE = new RegExp(`^\\s+(\\[(\\d+)\\]|-) (\\S+) "(.*)" · selector=([^·\\n]+?)(?: · (${STATE}(?:/${STATE})*))?\\s*$`, 'u')

/**
 * Parse the candidates out of a `browser_snapshot { query }` result.
 * @param text - the tool's text result.
 */
export function parseFoundCandidates(text: string): FoundCandidate[] {
  const found: FoundCandidate[] = []
  for (const line of text.split('\n')) {
    const match = FOUND_LINE.exec(line)
    if (match === null) continue
    found.push({
      ...(match[2] === undefined ? {} : { index: Number(match[2]) }),
      role: match[3]!,
      label: match[4]!,
      selector: match[5]!.trim(),
      hidden: (match[6] ?? '').split('/').includes('hidden'),
    })
  }
  return found
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** Clip like the content script does, so a long recorded name still compares. */
function clipped(value: string): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…` : text
}

/** Whether a candidate is the recorded element: same role and same name/text. */
export function candidateMatches(candidate: FoundCandidate, locator: WorkflowLocator): boolean {
  if (candidate.hidden) return false
  if (locator.role !== undefined && candidate.role !== locator.role) return false
  const expected = locator.name ?? locator.text
  if (expected === undefined) return true
  const label = normalize(candidate.label)
  return label === normalize(clipped(expected)) || (locator.text !== undefined && label === normalize(clipped(locator.text)))
}

/** Result of a fresh element lookup. */
export type LookupResult =
  | { kind: 'found'; selector: string; via: 'css' | 'role-name' | 'text' }
  | { kind: 'ambiguous'; candidates: FoundCandidate[]; message: string }
  | { kind: 'error'; message: string }

/**
 * Find the element a step means on the current page.
 * @param locator - the recorded locator.
 * @param call - tool caller.
 * @param signal - cancellation.
 */
export async function locateElement(locator: WorkflowLocator, call: StepCall, signal: AbortSignal): Promise<LookupResult> {
  const frame = locator.frame === undefined ? {} : { frame: locator.frame }
  const seen: FoundCandidate[] = []
  const query = async (q: Record<string, unknown>): Promise<FoundCandidate[] | string> => {
    const result = await call('browser_snapshot', { query: { ...q, limit: 10 }, ...frame }, signal)
    if (!result.ok) return result.message
    const candidates = parseFoundCandidates(result.text)
    for (const candidate of candidates) {
      if (!seen.some((other) => other.selector === candidate.selector)) seen.push(candidate)
    }
    return candidates
  }
  const attempts: Array<{ via: 'css' | 'role-name' | 'text'; query: Record<string, unknown> }> = []
  if (locator.css !== undefined) attempts.push({ via: 'css', query: { selector: locator.css } })
  const name = locator.name ?? locator.text
  if (name !== undefined) {
    attempts.push({ via: 'role-name', query: { text: name.slice(0, 80), ...(locator.role === undefined ? {} : { role: locator.role }) } })
  }
  if (locator.text !== undefined && locator.text !== name) attempts.push({ via: 'text', query: { text: locator.text.slice(0, 80) } })
  else if (name !== undefined && locator.role !== undefined) attempts.push({ via: 'text', query: { text: name.slice(0, 80) } })
  for (const attempt of attempts) {
    if (signal.aborted) return { kind: 'error', message: 'cancelled' }
    const candidates = await query(attempt.query)
    if (typeof candidates === 'string') {
      // A lookup refused by policy or approval is a hard stop, not ambiguity.
      return { kind: 'error', message: candidates }
    }
    const matching = candidates.filter((candidate) => candidateMatches(candidate, locator))
    // The CSS path must be unambiguous on its own as well.
    if (attempt.via === 'css' && candidates.filter((candidate) => !candidate.hidden).length !== 1) continue
    if (matching.length === 1) return { kind: 'found', selector: matching[0]!.selector, via: attempt.via }
  }
  const wanted = `${locator.role ?? 'element'}${name === undefined ? '' : ` "${name}"`}`
  return {
    kind: 'ambiguous',
    candidates: seen.slice(0, 10),
    message: seen.length === 0 ? `no element matching ${wanted} was found` : `no single element matches ${wanted} exactly`,
  }
}

/**
 * Runs a concrete program as one `browser_run` (one program card, then each
 * step as an ordinary tool call claiming that approval). Supplied by the
 * bridge; absent in unit tests, where programs run step by step.
 */
export type BrowserProgramRunner = (steps: readonly ProgramStep[], signal: AbortSignal) => Promise<ReplayReport>

/**
 * The default executor: one browser tool call at a time through `call`.
 * @param call - tool caller bound to the session.
 * @param runBrowserProgram - runs a program from step 0 as one `browser_run`
 *   (without it, and when continuing from a later step, programs run step by step).
 */
export function createSequentialExecutor(call: StepCall, runBrowserProgram?: BrowserProgramRunner): WorkflowExecutor {
  const runOne = async (tool: string, args: Record<string, unknown>, signal: AbortSignal, report: StepReport): Promise<StepReport> => {
    const result = await call(tool, args, signal)
    if (result.ok) return { ...report, status: 'done' }
    return { ...report, status: 'failed', message: `${result.code}: ${result.message}` }
  }
  return {
    async runWorkflow(workflow, supplied, options) {
      const params = resolveParams(workflow, supplied)
      const from = Math.max(0, Math.min(options.fromStep ?? 0, workflow.steps.length))
      const steps: StepReport[] = []
      for (let index = 0; index < workflow.steps.length; index += 1) {
        const step: WorkflowStep = workflow.steps[index]!
        if (index < from) {
          steps.push({ step: index, tool: step.tool, status: 'skipped' })
          continue
        }
        if (options.signal.aborted) return { status: 'cancelled', steps, stoppedAt: index }
        const args = substitute(step.args, params) as Record<string, unknown>
        let report: StepReport = { step: index, tool: step.tool, status: 'done' }
        if (step.locator !== undefined && ELEMENT_TOOLS.has(step.tool)) {
          const located = await locateElement(step.locator, call, options.signal)
          if (located.kind === 'ambiguous') {
            steps.push({ ...report, status: 'needs-model', message: located.message })
            return { status: 'needs-model', steps, stoppedAt: index, candidates: located.candidates }
          }
          if (located.kind === 'error') {
            steps.push({ ...report, status: 'failed', message: located.message })
            return { status: options.signal.aborted ? 'cancelled' : 'failed', steps, stoppedAt: index }
          }
          args.selector = located.selector
          if (step.locator.frame !== undefined) args.frame = step.locator.frame
          report = { ...report, via: located.via, selector: located.selector }
        }
        const done = await runOne(step.tool, args, options.signal, report)
        steps.push(done)
        if (done.status !== 'done') return { status: options.signal.aborted ? 'cancelled' : 'failed', steps, stoppedAt: index }
      }
      return { status: 'completed', steps }
    },
    async runProgram(program, options) {
      if (runBrowserProgram !== undefined && (options.fromStep ?? 0) === 0) return runBrowserProgram(program, options.signal)
      const steps: StepReport[] = []
      const from = Math.max(0, options.fromStep ?? 0)
      for (const [index, step] of program.entries()) {
        if (index < from) {
          steps.push({ step: index, tool: step.tool, status: 'skipped' })
          continue
        }
        if (options.signal.aborted) return { status: 'cancelled', steps, stoppedAt: index }
        const selector = typeof step.args.selector === 'string' ? step.args.selector : undefined
        const done = await runOne(step.tool, { ...step.args }, options.signal, {
          step: index, tool: step.tool, status: 'done', ...(selector === undefined ? {} : { selector }),
        })
        steps.push(done)
        if (done.status !== 'done') return { status: options.signal.aborted ? 'cancelled' : 'failed', steps, stoppedAt: index }
      }
      return { status: 'completed', steps }
    },
  }
}

/** Fence page-authored text (recorded accessible names, candidate labels and selectors, step errors). */
const fenceReplayText = (text: string): string => wrapUntrustedPageText(text)

/**
 * Render a replay report for the model (only reached when something broke or
 * the replay finished). Everything a page authored (the locator names the
 * recorder captured, candidate labels and selectors, step error text) is
 * inside one untrusted boundary.
 */
export function renderReplayReport(name: string, report: ReplayReport, total: number): string {
  const done = report.steps.filter((step) => step.status === 'done').length
  const lines: string[] = []
  if (report.status === 'completed') {
    lines.push(`Workflow "${name}" completed: ${String(done)} step(s) replayed.`)
  } else if (report.status === 'needs-model') {
    const at = report.stoppedAt ?? 0
    lines.push(`Workflow "${name}" stopped at step ${String(at + 1)} of ${String(total)}: the element could not be found unambiguously (details below).`)
    lines.push('Inspect the page (browser_snapshot), do this step yourself, then continue with browser_workflow_run { name, params, fromStep: '
      + `${String(at + 1)} } (fromStep is 0-based; ${String(at + 1)} is the step after this one).`)
    const page = [`Why: ${report.steps.at(-1)?.message ?? 'the element could not be found unambiguously'}`]
    if ((report.candidates ?? []).length > 0) {
      page.push('Candidates seen:')
      for (const candidate of report.candidates ?? []) {
        page.push(`  ${candidate.role} "${candidate.label}" · selector=${candidate.selector}${candidate.hidden ? ' · hidden' : ''}`)
      }
    }
    lines.push(fenceReplayText(page.join('\n')))
  } else {
    const failed = report.steps.at(-1)
    lines.push(`Workflow "${name}" ${report.status} at step ${String((report.stoppedAt ?? 0) + 1)} of ${String(total)}${failed?.message === undefined ? '.' : ' (details below).'}`)
    if (failed?.message !== undefined) lines.push(fenceReplayText(`Why: ${failed.message}`))
  }
  for (const step of report.steps) {
    if (step.status === 'skipped') continue
    lines.push(`  ${String(step.step + 1)}. ${step.tool} ${step.status}${step.via === undefined ? '' : ` (found by ${step.via})`}`)
  }
  return lines.join('\n')
}
