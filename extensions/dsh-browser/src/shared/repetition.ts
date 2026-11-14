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
 * @module
 */

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
        steps.push({ kind: column[0]!.kind, template, value, ...(column[0]!.label === undefined ? {} : { label: column[0]!.label }) })
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
 */
export function buildProgram(pattern: RepetitionPattern, rows: ReadonlyArray<readonly string[]>): ProgramStep[] {
  const program: ProgramStep[] = []
  rows.forEach((cells, offset) => {
    const repetition = pattern.done + offset
    for (const step of pattern.steps) {
      const selector = instantiate(step.template, repetition)
      const value = step.value.kind === 'constant' ? step.value.value : step.value.kind === 'cell' ? (cells[step.value.cell] ?? '').trim() : undefined
      if (step.kind === 'click') program.push({ tool: 'browser_click', args: { selector } })
      else if (step.kind === 'type') program.push({ tool: 'browser_type', args: { selector, text: value ?? '', replace: true } })
      else program.push({ tool: 'browser_select', args: { selector, value: value ?? '' } })
    }
  })
  return program
}
