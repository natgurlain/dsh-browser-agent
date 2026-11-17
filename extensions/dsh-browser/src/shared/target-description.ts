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

/**
 * Where a link or a form goes: its origin and path (never the query or
 * fragment, which can carry anything), and whether one is attached. `other`
 * is a non-http destination (javascript:, mailto:, data:, …).
 */
export type TargetDestination =
  | { origin: string; path: string; query: boolean }
  | { other: true }

/** Longest destination path kept. */
export const MAX_DESTINATION_PATH_CHARS = 300

/** Longest option label kept, and most labels kept for one selection. */
export const MAX_CHOSEN_LABEL_CHARS = 80
export const MAX_CHOSEN = 5

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
      /**
       * By native structure (tag and effective type, never the page's `role`),
       * activating it submits a form: a submit button or image input with a
       * form owner.
       */
      submits?: true
      /** A form field with a form owner: Enter in it may submit that form. */
      inForm?: true
      /** For a link (or an element inside one): where it goes. */
      href?: TargetDestination
      /** The link downloads its target (`download` attribute): a file lands on disk. */
      download?: true
      /** For a submit control: where its form goes, and how. */
      form?: TargetDestination & { method?: 'get' | 'post' | 'dialog' }
      /** For a native select and a browser_select call: the labels of the options it would choose. */
      chosen?: string[]
      /** A native select whose page code submits or acts on change (an onchange handler on it or its form). */
      autoSubmit?: true
      /** By its own markup, it only shows or hides part of the page (aria-expanded, summary, a popup or controls button). */
      disclosure?: true
      /** For a text field: whether it was empty when described. */
      empty?: boolean
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
  | {
    state: 'found'; kind: TargetKind; name: string; context?: { kind: 'row' | 'section'; text: string }; sensitive?: true; focused?: true; submits?: true; inForm?: true
    href?: TargetDestination; download?: true; form?: TargetDestination & { method?: 'get' | 'post' | 'dialog' }; chosen?: string[]; autoSubmit?: true
    disclosure?: true; empty?: boolean
  }
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

/** Read a reported destination; anything malformed is `other` (never trusted as a web destination). */
export function readDestination(raw: unknown): TargetDestination {
  if (typeof raw !== 'object' || raw === null) return { other: true }
  const value = raw as Record<string, unknown>
  if (value.other === true) return { other: true }
  if (typeof value.origin !== 'string' || !/^https?:\/\/[^\s/?#]+$/u.test(value.origin)) return { other: true }
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || value.path.length > MAX_DESTINATION_PATH_CHARS || /[\s?#]/u.test(value.path)) return { other: true }
  return { origin: value.origin, path: value.path, query: value.query === true }
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
    ...(value.submits === true ? { submits: true as const } : {}),
    ...(value.inForm === true ? { inForm: true as const } : {}),
    ...(value.href === undefined ? {} : { href: readDestination(value.href) }),
    ...(value.download === true ? { download: true as const } : {}),
    ...(value.form === undefined ? {} : {
      form: (() => {
        const destination = readDestination(value.form)
        const method = (value.form as { method?: unknown } | null)?.method
        return 'other' in destination ? destination : { ...destination, ...(method === 'get' || method === 'post' || method === 'dialog' ? { method } : {}) }
      })(),
    }),
    ...(Array.isArray(value.chosen)
      ? { chosen: value.chosen.slice(0, MAX_CHOSEN).map((label) => pageTextForCard(label, MAX_CHOSEN_LABEL_CHARS)) }
      : {}),
    ...(value.autoSubmit === true ? { autoSubmit: true as const } : {}),
    ...(value.disclosure === true ? { disclosure: true as const } : {}),
    ...(typeof value.empty === 'boolean' ? { empty: value.empty } : {}),
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
