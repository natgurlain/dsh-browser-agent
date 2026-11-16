/**
 * What the content script reports about the element an action will act on
 * (content/describe.ts), and how the background reads that report before any
 * of it reaches an approval card.
 *
 * The name and context are page-authored text. {@link readTargetSlots}
 * accepts them only as bounded plain text: whitespace collapsed, invisible
 * and direction-changing characters removed, the quotation marks the card
 * wraps them in replaced (so a name cannot close its own quotation and go on
 * in the card's voice), and cut to a fixed length. The kind is accepted only
 * from {@link TARGET_KINDS}.
 *
 * @module
 */

/** Every kind of element a card can name. */
export const TARGET_KINDS = [
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider', 'combobox', 'listbox',
  'textbox', 'searchbox', 'spinbutton', 'select', 'textarea', 'password', 'email', 'tel', 'url', 'number', 'date',
  'file', 'color', 'editable', 'image', 'summary', 'label', 'clickable', 'element',
] as const

export type TargetKind = typeof TARGET_KINDS[number]

/** Longest element name shown on a card. */
export const MAX_TARGET_NAME_CHARS = 80
/** Longest context (row or section) shown on a card. */
export const MAX_TARGET_CONTEXT_CHARS = 60

/** One element as the content script describes it. */
export type TargetDescription =
  | {
      found: true
      kind: TargetKind
      /** The element's label ('' when it has none). Page-authored. */
      name: string
      /** The row or labelled section it sits in. Page-authored. */
      context?: { kind: 'row' | 'section'; text: string }
      /** A sensitive field (privacy.ts): its value is masked everywhere. */
      sensitive?: true
      /** No locator was given: this is the element that has focus. */
      focused?: true
      /** On a re-check: whether the locator still names the element first described. */
      same?: boolean
    }
  | { found: false }

/** The elements of one call: `target`, or the two ends of a drag. */
export interface TargetSlots {
  target?: TargetDescription
  from?: TargetDescription
  to?: TargetDescription
}

/**
 * One element as a card states it: found (with what the page calls it), not
 * on the page, or not checked (the page did not answer).
 */
export type TargetState =
  | { state: 'found'; kind: TargetKind; name: string; context?: { kind: 'row' | 'section'; text: string }; sensitive?: true; focused?: true }
  | { state: 'missing' }
  | { state: 'unknown' }

/** The elements of one call as a card states them. */
export interface TargetStates {
  target?: TargetState
  from?: TargetState
  to?: TargetState
}

const KINDS: ReadonlySet<string> = new Set(TARGET_KINDS)

/** Bidi controls, zero-width and other format characters, and C0/C1 controls. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­؜ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻]/g

/** The quotation marks cards wrap page text in, and what replaces them inside it. */
const QUOTES: Record<string, string> = { '“': '‘', '”': '’', '「': '『', '」': '』' }

/**
 * Page-authored text as a card may show it: one line of plain text, with
 * nothing invisible in it, that cannot close the card's quotation marks.
 */
export function pageTextForCard(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const plain = value
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/[“”「」]/g, (quote) => QUOTES[quote] ?? quote)
    .trim()
  const chars = [...plain]
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join('')}…`
}

function readDescription(raw: unknown): TargetState {
  if (typeof raw !== 'object' || raw === null) return { state: 'unknown' }
  const value = raw as Record<string, unknown>
  if (value.found === false) return { state: 'missing' }
  if (value.found !== true || typeof value.kind !== 'string' || !KINDS.has(value.kind)) return { state: 'unknown' }
  const context = typeof value.context === 'object' && value.context !== null ? value.context as Record<string, unknown> : undefined
  const contextText = context === undefined ? '' : pageTextForCard(context.text, MAX_TARGET_CONTEXT_CHARS)
  return {
    state: 'found',
    kind: value.kind as TargetKind,
    name: pageTextForCard(value.name, MAX_TARGET_NAME_CHARS),
    ...(contextText === '' ? {} : { context: { kind: context?.kind === 'row' ? 'row' as const : 'section' as const, text: contextText } }),
    ...(value.sensitive === true ? { sensitive: true as const } : {}),
    ...(value.focused === true ? { focused: true as const } : {}),
  }
}

/**
 * Read the content script's report for the slots a call has.
 * @param raw - the `targets` member of a `DSH_TARGET_INFO` answer (untrusted shape).
 * @param expected - the slots this call addresses with a locator; one the
 *   report does not cover is `unknown`.
 * @returns the states, and whether a re-check found a locator naming another
 *   element than the one first described.
 */
export function readTargetSlots(raw: unknown, expected: ReadonlyArray<keyof TargetStates>): { targets: TargetStates; moved: boolean } {
  const value = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const targets: TargetStates = {}
  let moved = false
  for (const slot of ['target', 'from', 'to'] as const) {
    const reported = value[slot]
    if (reported === undefined && !expected.includes(slot)) continue
    targets[slot] = readDescription(reported)
    if (typeof reported === 'object' && reported !== null && (reported as { same?: unknown }).same === false) moved = true
  }
  return { targets, moved }
}
