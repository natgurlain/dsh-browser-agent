/**
 * "Finish what I started": find a repeating pattern in the user's own input
 * events (recorded by "Watch me") and build the program that does the rest.
 *
 * A pattern is a block of `p` events repeated `k ≥ 2` times at the end of the
 * recording, where each position of the block uses the same kind of input on
 * selectors that differ only by an arithmetic row index (`li:nth-child(3)`,
 * `#row-3`, `[data-row="3"]`, …). Typed or selected values must either stay
 * constant or equal one cell of the event's row each time (the value source);
 * anything else is not generalized.
 *
 * Pure: the content script probes how many further rows exist and reports
 * their cells; this module only does the arithmetic.
 *
 * How much one "do the remaining N" does: a single `browser_run` holds
 * {@link RUN_BATCH_STEPS} steps. A longer remainder runs as batches of that
 * size under one approval card that lists every step, up to
 * {@link MAX_FINISH_STEPS} steps in total; rows beyond that are left for a
 * further run, and the offer says so.
 *
 * @module
 */

/** Steps one `browser_run` holds (mirrors run-program.ts MAX_PROGRAM_STEPS). */
export const RUN_BATCH_STEPS = 25
/** Most steps one "do the remaining N" does in total (mirrors run-program.ts MAX_SERIES_STEPS). */
export const MAX_FINISH_STEPS = 250

/** Most further rows one run may cover for a pattern of `period` steps per row (a row must fit one batch). */
export function maxFinishRows(period: number): number {
  return period < 1 || period > RUN_BATCH_STEPS ? 0 : Math.floor(MAX_FINISH_STEPS / period)
}

/** One recorded user input event. */
export interface WatchEvent {
  kind: 'click' | 'type' | 'select'
  /** Unique selector of the target at event time. */
  css: string
  /** Typed or selected value; absent for clicks and for masked fields. */
  value?: string
  /** The field is sensitive: its value was never recorded. */
  sensitive?: boolean
  /** Texts of the cells of the row the target sits in (for value sources). */
  cells?: string[]
  label?: string
  /** Tag name (lowercase) and role of the target at event time. */
  tag?: string
  role?: string
}

/**
 * What a step's element looks like, and which row it sits in. Recorded when
 * "do the remaining N" is offered, shown and bound on its approval card, and
 * compared, inside the action, with the very element the step is about to
 * act on.
 */
export interface StepTarget {
  tag: string
  role: string
  /** Accessible name. */
  name: string
  /**
   * The row's identity in a person's words, from the cells other than the
   * element's own: the first cell with text and the first cell with words
   * ("1042 · Paid"). Empty when the element sits in no recognisable row.
   */
  row: string
  /**
   * A digest of everything the row visibly says outside its form controls
   * and buttons (every cell's text, link text included; sensitive cells
   * masked). Empty: not compared, and `row` is then only the row's first text
   * cell (no row, a row that says nothing, or a step after the first of its
   * row, whose row text earlier steps may have changed).
   */
  rowKey: string
}

const TARGET_FIELD_MAX = 200

/** A well-formed {@link StepTarget}, or undefined. */
export function parseStepTarget(value: unknown): StepTarget | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length !== 5) return undefined
  const field = (key: string): string | undefined => typeof raw[key] === 'string' && (raw[key] as string).length <= TARGET_FIELD_MAX ? raw[key] as string : undefined
  const tag = field('tag')
  const role = field('role')
  const name = field('name')
  const row = field('row')
  const rowKey = field('rowKey')
  return tag === undefined || tag === '' || role === undefined || name === undefined || row === undefined || rowKey === undefined ? undefined : { tag, role, name, row, rowKey }
}

/**
 * Whether the rows of an offer can be told apart: every step sits in a row
 * with an identity, and no two rows share one. Only then may one approval
 * cover more rows than a single program.
 */
export function rowsDistinct(targets: ReadonlyArray<ReadonlyArray<StepTarget | undefined>>): boolean {
  const seen = new Set<string>()
  for (const row of targets) {
    const identity = row[0]?.row
    // The first step binds the whole row: a row that says nothing (no digest) cannot be bound.
    if (identity === undefined || identity === '' || row[0]?.rowKey === '' || row.some((target) => target === undefined || target.row === '') || seen.has(identity)) return false
    seen.add(identity)
  }
  return true
}

/**
 * An accessible name with what varies by row taken out: the row's own cell
 * texts and any digits ("Email 3", "Invite Ada" → the same shape on every row).
 */
export function nameShape(name: string, cells: readonly string[] = []): string {
  let shape = name
  // The cell that holds the element itself reads the same as its name: that is the name, not the row's own text.
  const own = cells.map((cell) => cell.trim()).filter((cell) => cell.length >= 2 && cell !== name.trim()).sort((a, b) => b.length - a.length)
  for (const cell of own) shape = shape.split(cell).join('§')
  return shape.replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim()
}

/** A selector with numeric slots that advance by `step` per repetition. */
export interface SelectorTemplate {
  /** Literal text and numeric slots: number entries are slot start values. */
  parts: Array<string | { start: number; step: number }>
}

/** How one block position gets its value. */
export type ValueSource = { kind: 'none' } | { kind: 'constant'; value: string } | { kind: 'cell'; cell: number }

/** One position of the repeated block. */
export interface PatternStep {
  kind: WatchEvent['kind']
  template: SelectorTemplate
  value: ValueSource
  label?: string
  /**
   * What the user's own targets had in common at this position (set only
   * where every repetition agreed): a further row must look the same.
   */
  tag?: string
  role?: string
  shape?: string
}

/** Whether a further row's element looks like the ones the user acted on at this position. */
export function looksLikeStep(step: PatternStep, target: StepTarget, cells: readonly string[]): boolean {
  return (step.tag === undefined || step.tag === target.tag)
    && (step.role === undefined || step.role === target.role)
    && (step.shape === undefined || step.shape === nameShape(target.name, cells))
}

/** A detected repetition. */
export interface RepetitionPattern {
  /** Events per repetition. */
  period: number
  /** Repetitions already done by the user. */
  done: number
  steps: PatternStep[]
}

/** A concrete program step (browser tool call). */
export interface ProgramStep {
  tool: 'browser_click' | 'browser_type' | 'browser_select'
  args: Record<string, unknown>
  /** Set on every step of a program longer than one `browser_run` (a series). */
  target?: StepTarget
}

const NUMBER_SPLIT = /(\d+)/u

/** Split into literal and numeric tokens. */
function tokens(selector: string): string[] {
  return selector.split(NUMBER_SPLIT)
}

/**
 * Generalize the selectors of one block position across repetitions.
 * @param selectors - the same position's selector in each repetition, in order.
 * @returns a template, or undefined when they do not differ by a row index.
 */
export function generalizeSelectors(selectors: readonly string[]): SelectorTemplate | undefined {
  if (selectors.length < 2) return undefined
  const split = selectors.map(tokens)
  const length = split[0]!.length
  if (split.some((parts) => parts.length !== length)) return undefined
  const parts: SelectorTemplate['parts'] = []
  for (let index = 0; index < length; index += 1) {
    const column = split.map((parts) => parts[index]!)
    const numeric = index % 2 === 1
    if (!numeric) {
      if (column.some((value) => value !== column[0])) return undefined
      parts.push(column[0]!)
      continue
    }
    const values = column.map(Number)
    if (values.every((value) => value === values[0])) {
      parts.push(column[0]!)
      continue
    }
    const step = values[1]! - values[0]!
    if (step === 0 || values.some((value, at) => value !== values[0]! + at * step)) return undefined
    parts.push({ start: values[0]!, step })
  }
  // Several slots may advance together (#row-3 > td:nth-child(3)); each one
  // advances by its own fixed step per repetition. A slot-free template is a
  // constant selector (the same Save button every time).
  return { parts: mergeLiterals(parts) }
}

function mergeLiterals(parts: SelectorTemplate['parts']): SelectorTemplate['parts'] {
  const merged: SelectorTemplate['parts'] = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (typeof part === 'string' && typeof last === 'string') merged[merged.length - 1] = last + part
    else merged.push(part)
  }
  return merged
}

/** The selector of repetition `r` (0-based). */
export function instantiate(template: SelectorTemplate, repetition: number): string {
  return template.parts.map((part) => typeof part === 'string' ? part : String(part.start + repetition * part.step)).join('')
}

function valueSource(events: readonly WatchEvent[]): ValueSource | undefined {
  if (events[0]!.kind === 'click') return { kind: 'none' }
  if (events.some((event) => event.sensitive === true || event.value === undefined)) return undefined
  const values = events.map((event) => event.value!)
  if (values.every((value) => value === values[0])) return { kind: 'constant', value: values[0]! }
  const cellCount = Math.min(...events.map((event) => event.cells?.length ?? 0))
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (events.every((event) => event.cells![cell]!.trim() === event.value!.trim() && event.value!.trim() !== '')) return { kind: 'cell', cell }
  }
  return undefined
}

/**
 * Find the repetition at the end of the recording.
 * @param events - recorded events, oldest first.
 * @returns the shortest period repeated at least twice, or undefined.
 */
export function detectRepetition(events: readonly WatchEvent[]): RepetitionPattern | undefined {
  for (let period = 1; period <= Math.floor(events.length / 2); period += 1) {
    // Count how many whole blocks at the end share the block structure.
    let done = Math.floor(events.length / period)
    while (done >= 2) {
      const start = events.length - done * period
      const blocks = Array.from({ length: done }, (_unused, r) => events.slice(start + r * period, start + (r + 1) * period))
      const steps: PatternStep[] = []
      let ok = true
      for (let position = 0; position < period && ok; position += 1) {
        const column = blocks.map((block) => block[position]!)
        if (column.some((event) => event.kind !== column[0]!.kind)) { ok = false; break }
        const template = generalizeSelectors(column.map((event) => event.css))
        const value = valueSource(column)
        if (template === undefined || value === undefined) { ok = false; break }
        const agreed = <T>(values: Array<T | undefined>): T | undefined => values[0] !== undefined && values.every((entry) => entry === values[0]) ? values[0] : undefined
        const tag = agreed(column.map((event) => event.tag))
        const role = agreed(column.map((event) => event.role))
        const shape = agreed(column.map((event) => event.label === undefined ? undefined : nameShape(event.label, event.cells)))
        steps.push({
          kind: column[0]!.kind, template, value,
          ...(column[0]!.label === undefined ? {} : { label: column[0]!.label }),
          ...(tag === undefined ? {} : { tag }), ...(role === undefined ? {} : { role }), ...(shape === undefined ? {} : { shape }),
        })
      }
      // At least one position must move through rows, or nothing repeats over rows.
      if (ok && steps.some((step) => step.template.parts.some((part) => typeof part !== 'string'))) {
        return { period, done, steps }
      }
      done -= 1
    }
  }
  return undefined
}

/** Selectors of the next repetitions, for the content script's row probe. */
export function nextSelectors(pattern: RepetitionPattern, count: number): string[][] {
  return Array.from({ length: count }, (_unused, offset) => pattern.steps.map((step) => instantiate(step.template, pattern.done + offset)))
}

/**
 * Build the program for the remaining rows.
 * @param pattern - detected pattern.
 * @param rows - for each remaining repetition (as probed), the cells of its row.
 * @param targets - for a series: what each step's element looks like, per row.
 */
export function buildProgram(pattern: RepetitionPattern, rows: ReadonlyArray<readonly string[]>, targets?: ReadonlyArray<readonly StepTarget[]>): ProgramStep[] {
  const program: ProgramStep[] = []
  const push = (step: ProgramStep, target: StepTarget | undefined): void => { program.push(target === undefined ? step : { ...step, target }) }
  rows.forEach((cells, offset) => {
    const repetition = pattern.done + offset
    for (const [position, step] of pattern.steps.entries()) {
      const probed = targets?.[offset]?.[position]
      // The whole row is compared at its first step; the steps after it may have changed what the row says.
      const target = probed === undefined || position === 0 ? probed : { ...probed, rowKey: '' }
      const selector = instantiate(step.template, repetition)
      const value = step.value.kind === 'constant' ? step.value.value : step.value.kind === 'cell' ? (cells[step.value.cell] ?? '').trim() : undefined
      if (step.kind === 'click') push({ tool: 'browser_click', args: { selector } }, target)
      else if (step.kind === 'type') push({ tool: 'browser_type', args: { selector, text: value ?? '', replace: true } }, target)
      else push({ tool: 'browser_select', args: { selector, value: value ?? '' } }, target)
    }
  })
  return program
}
