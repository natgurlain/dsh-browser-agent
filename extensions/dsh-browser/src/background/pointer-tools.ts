/**
 * Pointer tools: the covered-element check before clicks, trusted clicks
 * (explicit only: a synthetic click that changed nothing is reported with a
 * hint, never re-sent automatically), `browser_hover`, and `browser_drag`.
 *
 * Measuring, hit-testing, marking, and the synthetic fallbacks run in the
 * frame that owns the element (content `pointer-support.ts`); real input runs
 * over the tab's shared debugger attachment (`pointer-actions.ts`).
 *
 * @module
 */

import type { ToolErrorCode } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { CdpClient } from './debugger-session.ts'
import type { TabFrame } from './frames.ts'
import { InputError } from './input-actions.ts'
import { isModifierName, type ModifierName } from './keys.ts'
import { mouseClick, mouseDrag, mouseMove, PointerRedirectedError, resolvePointerTarget, type MouseButton } from './pointer-actions.ts'
import type {
  ElementPoint,
  InputSetupRequest,
  InputSetupResult,
  MeasuredTarget,
  PointerEnd,
  WatchReport,
} from '../shared/input-setup.ts'

/** The slice of a tool call these helpers read. */
interface PointerCall {
  name: string
  args: Record<string, unknown>
}

/** Answer shape shared with tool dispatch. */
interface PointerAnswer {
  ok: boolean
  result?: unknown
  error?: { code: ToolErrorCode; message: string }
}

/** Trusted-input runtime (debugger broker), as tool dispatch passes it. */
interface PointerInput {
  supported: boolean
  run<T>(tabId: number, operation: (client: CdpClient) => Promise<T>): Promise<T>
}

/** What the pointer helpers need from tool dispatch. */
export interface PointerContext {
  tabId: number
  frame: TabFrame
  call: PointerCall
  /** Send one internal setup request to the frame. */
  setup(request: InputSetupRequest): Promise<InputSetupResult>
  /** Wait for the frame to settle and build the final answer. */
  settle(status: string, suffix: string): Promise<PointerAnswer>
  /** Trusted input, when the platform has it. */
  input?: PointerInput
}

/** Default number of intermediate drag moves. */
const DEFAULT_DRAG_STEPS = 10

function token(): string {
  return crypto.randomUUID()
}

/** `[5]`, `(#menu)`, or `[5] in frame 2`, for status lines. */
export function describePointerEnd(end: PointerEnd): string {
  if (typeof end.selector === 'string') return `element (${end.selector})`
  if (end.index !== undefined) return `element [${String(end.index)}]`
  return 'the element'
}

function endOf(args: Record<string, unknown>): PointerEnd {
  return {
    ...(args.index === undefined ? {} : { index: args.index as number }),
    ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
  }
}

function usable(input: PointerInput | undefined): input is PointerInput {
  return input !== undefined && input.supported
}

/** The refusal for a click (or hover/drag) whose target is under another element. */
export function coveredAnswer(end: PointerEnd, covered: string, gesture: string): PointerAnswer {
  return {
    ok: false,
    error: {
      code: 'action-failed',
      message: `The ${describePointerEnd(end)} is covered by ${covered} at its center, so the ${gesture} was not delivered. `
        + 'Close or dismiss the covering element (or scroll it away), then retry.',
    },
  }
}

async function measure(ctx: PointerContext, end: PointerEnd, extra: { mark?: string; hitTest?: boolean; watch?: string; noScroll?: boolean }): Promise<MeasuredTarget> {
  const result = await ctx.setup({ op: 'measure', ...end, ...extra })
  if (result.op !== 'measure') throw new InputError('action-failed', 'The page returned an unexpected measurement.')
  return result.measure
}

async function clearMark(ctx: PointerContext, mark: string): Promise<void> {
  await ctx.setup({ op: 'pointer-clear', token: mark }).catch(() => undefined)
}

/** Validated click options for the trusted path. */
function clickOptions(args: Record<string, unknown>): { button: MouseButton; clicks: number; modifiers: ModifierName[] } {
  const button = args.button === undefined ? 'left' : args.button
  if (button !== 'left' && button !== 'middle' && button !== 'right') throw new InputError('bad-args', 'button must be left, middle, or right.')
  if (args.action !== undefined && args.action !== 'click' && args.action !== 'dblclick') throw new InputError('bad-args', 'action must be click or dblclick.')
  const clicks = args.action === 'dblclick' ? 2 : args.clicks === undefined ? 1 : args.clicks
  if (typeof clicks !== 'number' || !Number.isInteger(clicks) || clicks < 1 || clicks > 3) throw new InputError('bad-args', 'clicks must be 1, 2, or 3.')
  const modifiers: ModifierName[] = []
  if (args.modifiers !== undefined) {
    if (!Array.isArray(args.modifiers)) throw new InputError('bad-args', 'modifiers must be a list of Alt, Control, Meta, or Shift.')
    for (const value of args.modifiers) {
      if (typeof value !== 'string' || !isModifierName(value)) throw new InputError('bad-args', 'modifiers must be a list of Alt, Control, Meta, or Shift.')
      modifiers.push(value)
    }
  }
  return { button, clicks, modifiers }
}

// ---- Clicks ----

/** Result of the pre-click check. */
export type ClickPrecheck =
  | { kind: 'refuse'; answer: PointerAnswer }
  | { kind: 'proceed'; measured?: MeasuredTarget; watch?: string }

/**
 * Hit-test before any click; start an effect watch when a synthetic click
 * that changes nothing should earn a "retry with trusted: true" hint.
 * A target the page cannot measure (stale index, missing selector) proceeds:
 * the click itself reports that error in its usual words.
 */
export async function precheckClick(ctx: PointerContext, mayRetry: boolean): Promise<ClickPrecheck> {
  const end = endOf(ctx.call.args)
  if (end.index === undefined && end.selector === undefined) return { kind: 'proceed' }
  const watch = mayRetry ? token() : undefined
  let measured: MeasuredTarget
  try {
    measured = await measure(ctx, end, { hitTest: true, ...(watch === undefined ? {} : { watch }) })
  } catch {
    return { kind: 'proceed' }
  }
  if (measured.covered !== undefined) {
    if (watch !== undefined) await ctx.setup({ op: 'watch-end', token: watch }).catch(() => undefined)
    return { kind: 'refuse', answer: coveredAnswer(end, measured.covered, 'click') }
  }
  return { kind: 'proceed', measured, ...(watch === undefined ? {} : { watch }) }
}

/**
 * Whether a synthetic click is watched for the real-input hint: a plain left
 * click with no explicit `trusted` choice and a debugger available.
 */
export function clickMayRetry(args: Record<string, unknown>, input: PointerInput | undefined): boolean {
  if (!usable(input) || args.trusted !== undefined) return false
  if (args.action !== undefined && args.action !== 'click') return false
  if (args.clicks !== undefined && args.clicks !== 1) return false
  if (args.button !== undefined && args.button !== 'left') return false
  if (Array.isArray(args.modifiers) && args.modifiers.length > 0) return false
  return true
}

/** Extra time for asynchronous effects (re-renders, responses) before judging a click. */
const EFFECT_GRACE_MS = 300

/** Finish a watch; a lost or failed watch counts as "changed" (never retry blindly). */
export async function finishWatch(ctx: PointerContext, watch: string, graceMs = EFFECT_GRACE_MS): Promise<WatchReport> {
  if (graceMs > 0) await new Promise((resolve) => { setTimeout(resolve, graceMs) })
  try {
    const result = await ctx.setup({ op: 'watch-end', token: watch })
    return result.op === 'watch-end' ? result.report : { changed: true, reasons: ['unknown'] }
  } catch {
    return { changed: true, reasons: ['unreachable'] }
  }
}

/**
 * Whether a synthetic click that changed nothing earns the "retry with
 * trusted: true" hint (it is never retried automatically: the handler may
 * have run without a visible effect, and a second activation would repeat it).
 */
export function shouldSuggestTrusted(measured: MeasuredTarget | undefined, report: WatchReport): boolean {
  return measured !== undefined
    && measured.visible
    && measured.activation === 'other'
    && !report.changed
}

/** The hint appended to a synthetic click that changed nothing observable. */
export const TRUSTED_HINT = ' (no visible effect — if the control needs real input, retry with trusted: true)'

/** The refusal when the CDP re-hit-test finds another node at the point. */
function redirectedAnswer(end: PointerEnd, error: PointerRedirectedError, gesture: string): PointerAnswer {
  return {
    ok: false,
    error: {
      code: 'action-failed',
      message: `Just before the ${gesture}, the point over the ${describePointerEnd(end)} was occupied by ${error.hit}, so the ${gesture} was not delivered. `
        + 'The page may have moved another element or frame over it; call browser_snapshot and retry.',
    },
  }
}

/** A real mouse click at the element's center. */
export async function trustedClick(ctx: PointerContext, suffix = ' (trusted)'): Promise<PointerAnswer> {
  const input = ctx.input
  if (!usable(input)) {
    throw new InputError('input-unavailable', 'This browser has no trusted input channel (it needs the Chrome debugger). Omit trusted to use the synthetic click.')
  }
  const end = endOf(ctx.call.args)
  if (end.index === undefined && end.selector === undefined) throw new InputError('bad-args', 'Provide index or selector.')
  const options = clickOptions(ctx.call.args)
  const mark = token()
  try {
    await input.run(ctx.tabId, async (client) => {
      // Measure with the debugger attached: its infobar can move the page.
      const measured = await measure(ctx, end, { mark, hitTest: true })
      if (measured.covered !== undefined) throw new CoveredError(measured.covered)
      if (!measured.visible) throw new InputError('action-failed', `The ${describePointerEnd(end)} has no visible area to click.`)
      const target = await resolvePointerTarget(client, ctx.tabId, ctx.frame, mark, measured.center)
      await mouseClick(target.client, target.point, { ...options, verify: () => target.verify() })
    })
  } catch (error: unknown) {
    if (error instanceof CoveredError) return coveredAnswer(end, error.covered, 'click')
    if (error instanceof PointerRedirectedError) return redirectedAnswer(end, error, 'click')
    throw error
  } finally {
    await clearMark(ctx, mark)
  }
  const verb = options.clicks === 2 ? 'Double-clicked' : options.button === 'left' ? 'Clicked' : `${options.button[0]!.toUpperCase()}${options.button.slice(1)}-clicked`
  return ctx.settle(`${verb} ${describePointerEnd(end)}`, suffix)
}

class CoveredError extends Error {
  constructor(readonly covered: string) {
    super(`covered by ${covered}`)
  }
}

// ---- Hover ----

/** Move the pointer over an element: real input when possible, synthetic events otherwise. */
export async function hover(ctx: PointerContext): Promise<PointerAnswer> {
  const end = endOf(ctx.call.args)
  if (end.index === undefined && end.selector === undefined) throw new InputError('bad-args', 'Provide index or selector.')
  const input = ctx.input
  if (!usable(input)) {
    const measured = await measure(ctx, end, { hitTest: true })
    if (measured.covered !== undefined) return coveredAnswer(end, measured.covered, 'hover')
    await ctx.setup({ op: 'synthetic-hover', ...end })
    return ctx.settle(`Hovered over ${describePointerEnd(end)}`, ' (synthetic: CSS :hover styles are not applied)')
  }
  const mark = token()
  try {
    await input.run(ctx.tabId, async (client) => {
      const measured = await measure(ctx, end, { mark, hitTest: true })
      if (measured.covered !== undefined) throw new CoveredError(measured.covered)
      const target = await resolvePointerTarget(client, ctx.tabId, ctx.frame, mark, measured.center)
      await target.verify()
      await mouseMove(target.client, target.point)
    })
  } catch (error: unknown) {
    if (error instanceof CoveredError) return coveredAnswer(end, error.covered, 'hover')
    if (error instanceof PointerRedirectedError) return redirectedAnswer(end, error, 'hover')
    throw error
  } finally {
    await clearMark(ctx, mark)
  }
  return ctx.settle(`Hovered over ${describePointerEnd(end)}`, ' (trusted)')
}

// ---- Drag ----

/** Validated `browser_drag` arguments. */
export interface DragArgs {
  from: PointerEnd
  to?: PointerEnd
  offset?: ElementPoint
  steps: number
}

function parseEnd(value: unknown, name: string): PointerEnd {
  if (typeof value !== 'object' || value === null) throw new InputError('bad-args', `${name} must be {index} or {selector}.`)
  const end = value as Record<string, unknown>
  const hasIndex = end.index !== undefined
  const hasSelector = typeof end.selector === 'string' && end.selector !== ''
  if (hasIndex === hasSelector) throw new InputError('bad-args', `${name} needs exactly one of index or selector.`)
  if (hasIndex && (typeof end.index !== 'number' || !Number.isInteger(end.index) || end.index < 0)) {
    throw new InputError('bad-args', `${name}.index must be a non-negative integer.`)
  }
  return hasIndex ? { index: end.index as number } : { selector: end.selector as string }
}

/** Parse and validate drag arguments. */
export function parseDragArgs(args: Record<string, unknown>): DragArgs {
  const from = parseEnd(args.from, 'from')
  const hasTo = args.to !== undefined
  const hasOffset = args.toOffset !== undefined
  if (hasTo === hasOffset) throw new InputError('bad-args', 'Give exactly one of to or toOffset.')
  const steps = args.steps === undefined ? DEFAULT_DRAG_STEPS : args.steps
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > 60) {
    throw new InputError('bad-args', 'steps must be an integer between 1 and 60.')
  }
  if (hasTo) return { from, to: parseEnd(args.to, 'to'), steps }
  const offset = args.toOffset as { x?: unknown; y?: unknown } | null
  if (typeof offset !== 'object' || offset === null || typeof offset.x !== 'number' || typeof offset.y !== 'number'
    || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) {
    throw new InputError('bad-args', 'toOffset must be {x, y} in CSS pixels.')
  }
  return { from, offset: { x: offset.x, y: offset.y }, steps }
}

/** Snapshot indices a drag refers to (for the same-document check). */
export function dragIndices(args: Record<string, unknown>): number[] {
  const indices: number[] = []
  for (const key of ['from', 'to']) {
    const end = args[key]
    if (typeof end === 'object' && end !== null && typeof (end as { index?: unknown }).index === 'number') {
      indices.push((end as { index: number }).index)
    }
  }
  return indices
}

function describeDestination(drag: DragArgs): string {
  return drag.to !== undefined ? describePointerEnd(drag.to) : `offset (${drag.offset!.x}, ${drag.offset!.y})`
}

/**
 * Drag within one frame. HTML5 drag sources get the drag-and-drop event
 * sequence with a shared DataTransfer (real mouse input does not complete a
 * native HTML5 drag without browser drag interception); other sources get a
 * real pointer drag in steps, or synthetic pointer events without a debugger.
 */
export async function drag(ctx: PointerContext): Promise<PointerAnswer> {
  const parsed = parseDragArgs(ctx.call.args)
  const source = await measure(ctx, parsed.from, { hitTest: true })
  if (source.covered !== undefined) return coveredAnswer(parsed.from, source.covered, 'drag')
  const status = `Dragged ${describePointerEnd(parsed.from)} to ${describeDestination(parsed)}`
  if (source.draggable || !usable(ctx.input)) {
    const result = await ctx.setup({
      op: 'synthetic-drag',
      from: parsed.from,
      ...(parsed.to === undefined ? {} : { to: parsed.to }),
      ...(parsed.offset === undefined ? {} : { offset: parsed.offset }),
      steps: parsed.steps,
    })
    if (result.op !== 'synthetic-drag') throw new InputError('action-failed', 'The page returned an unexpected drag result.')
    const note = result.mode === 'html5'
      ? ` (HTML5 drag-and-drop events${result.dropped ? '; the drop target accepted it' : '; no drop target accepted it'})`
      : ' (synthetic pointer events)'
    return ctx.settle(status, note)
  }
  const input = ctx.input!
  const fromMark = token()
  const toMark = token()
  try {
    await input.run(ctx.tabId, async (client) => {
      // The source is scrolled into view; the destination is measured where
      // it is, so both ends share one scroll position.
      const from = await measure(ctx, parsed.from, { mark: fromMark })
      const start = await resolvePointerTarget(client, ctx.tabId, ctx.frame, fromMark, from.center)
      let end: ElementPoint
      if (parsed.to !== undefined) {
        const to = await measure(ctx, parsed.to, { mark: toMark, noScroll: true })
        end = (await resolvePointerTarget(client, ctx.tabId, ctx.frame, toMark, to.center)).point
      } else {
        end = { x: start.point.x + parsed.offset!.x, y: start.point.y + parsed.offset!.y }
      }
      await mouseDrag(start.client, start.point, end, parsed.steps, () => start.verify())
    })
  } catch (error: unknown) {
    if (error instanceof PointerRedirectedError) return redirectedAnswer(parsed.from, error, 'drag')
    throw error
  } finally {
    await clearMark(ctx, fromMark)
    await clearMark(ctx, toMark)
  }
  return ctx.settle(status, ' (trusted)')
}
