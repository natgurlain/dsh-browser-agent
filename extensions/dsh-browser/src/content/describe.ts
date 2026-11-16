/**
 * Approval-time description of the element an action will act on: its kind
 * (from a fixed vocabulary), the name a person would recognise it by, and a
 * short context (the row or section it sits in). The background puts it on
 * the approval card, so the card says what will be clicked or typed into
 * instead of an index only.
 *
 * Rules:
 * - The element is resolved exactly as the action resolves it
 *   ({@link resolveActionTarget}, or the focused element), in the page, when
 *   the card is raised. Nothing the model wrote is used.
 * - Only labels leave the page, never values: a field is named by its label,
 *   placeholder, or title, not by what was typed into it.
 * - The kind is one of {@link TARGET_KINDS}; a page-chosen `role` attribute
 *   outside it is ignored.
 * - Each described element is remembered per locator, so a later re-check
 *   ({@link describeActionTargets} with `recheck`) can tell whether the same
 *   locator still names the same element.
 *
 * @module
 */

import { resolveActionTarget } from './actions.ts'
import { composedParent, cssEscape, deepActiveElement } from './dom.ts'
import { accessibleName, clean, clip } from './extract.ts'
import type { ElementIds } from './ids.ts'
import { isSensitiveField } from './privacy.ts'
import { MAX_TARGET_CONTEXT_CHARS, MAX_TARGET_NAME_CHARS, TARGET_KINDS, type TargetDescription, type TargetKind, type TargetSlots } from '../shared/target-description.ts'

type FoundTarget = Extract<TargetDescription, { found: true }>

const KINDS: ReadonlySet<string> = new Set(TARGET_KINDS)

/** ARIA roles shown under another kind's wording. */
const ROLE_ALIASES: Record<string, TargetKind> = {
  menuitemcheckbox: 'menuitem',
  menuitemradio: 'menuitem',
  treeitem: 'option',
  img: 'image',
}

const INPUT_KINDS: Record<string, TargetKind> = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'number',
  search: 'searchbox',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  password: 'password',
  email: 'email',
  tel: 'tel',
  url: 'url',
  date: 'date',
  time: 'date',
  'datetime-local': 'date',
  month: 'date',
  week: 'date',
  file: 'file',
  color: 'color',
}

/** The kind of an element, from the fixed vocabulary. */
export function targetKind(el: Element): TargetKind {
  const role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (role !== '') {
    const alias = ROLE_ALIASES[role]
    if (alias !== undefined) return alias
    if (KINDS.has(role) && role !== 'element' && role !== 'clickable' && role !== 'label') return role as TargetKind
  }
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) return INPUT_KINDS[el.type] ?? 'textbox'
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLOptionElement) return 'option'
  if (el instanceof HTMLImageElement) return 'image'
  if (el instanceof HTMLElement && el.isContentEditable) return 'editable'
  if (el.getAttribute('contenteditable') !== null && el.getAttribute('contenteditable') !== 'false') return 'editable'
  if (el.tagName === 'SUMMARY') return 'summary'
  if (el instanceof HTMLLabelElement) return el.control === null ? 'label' : targetKind(el.control)
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'clickable'
  return 'element'
}

/** Kinds that hold a value: named by their label only, never by their content. */
const FIELD_KINDS: ReadonlySet<TargetKind> = new Set([
  'checkbox', 'radio', 'switch', 'slider', 'combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton', 'select', 'textarea',
  'password', 'email', 'tel', 'url', 'number', 'date', 'file', 'color', 'editable',
])

/**
 * The first rendered line of an element's text: a label's headline without
 * the description under it. Falls back to all of its text where the browser
 * has no layout (tests).
 */
function headline(el: Element, exclude?: Element): string {
  if (exclude !== undefined && el.contains(exclude) && (exclude instanceof HTMLSelectElement || exclude instanceof HTMLTextAreaElement)) {
    // A wrapping label's text must not include the control's own options or content.
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const parts: string[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!exclude.contains(node)) parts.push(node.textContent ?? '')
    }
    return clean(parts.join(' '))
  }
  const rendered = el instanceof HTMLElement && typeof el.innerText === 'string' ? el.innerText : undefined
  if (rendered === undefined) return clean(el.textContent ?? '')
  return rendered.split(/\n+/).map(clean).find((line) => line !== '') ?? ''
}

function byIds(el: Element, attribute: string): string {
  const root = el.getRootNode() as Document | ShadowRoot
  return (el.getAttribute(attribute) ?? '').split(/\s+/)
    .filter((id) => id !== '')
    .map((id) => ('getElementById' in root ? root.getElementById(id) : null)?.textContent ?? '')
    .map(clean)
    .filter((text) => text !== '')
    .join(' ')
}

/** A field's label: what the page calls it, never what it contains. */
function fieldLabel(el: Element): string {
  const aria = clean(el.getAttribute('aria-label') ?? '')
  if (aria !== '') return aria
  const labelledBy = byIds(el, 'aria-labelledby')
  if (labelledBy !== '') return labelledBy
  const root = el.getRootNode() as Document | ShadowRoot
  if (el.id !== '') {
    const label = root.querySelector(`label[for="${cssEscape(el.id)}"]`)
    const text = label === null ? '' : headline(label, el)
    if (text !== '') return text
  }
  const wrapping = el.closest('label')
  if (wrapping !== null) {
    const text = headline(wrapping, el)
    if (text !== '') return text
  }
  if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button' || el.type === 'reset') && el.value !== '') return clean(el.value)
  for (const attribute of ['placeholder', 'aria-placeholder', 'data-placeholder', 'title', 'alt']) {
    const value = clean(el.getAttribute(attribute) ?? '')
    if (value !== '') return value
  }
  return ''
}

/** The name a person would know the element by ('' when it has none). */
export function targetName(el: Element, kind: TargetKind): string {
  if (FIELD_KINDS.has(kind) && !(el instanceof HTMLLabelElement)) return clip(fieldLabel(el), MAX_TARGET_NAME_CHARS)
  const aria = clean(el.getAttribute('aria-label') ?? '')
  if (aria !== '') return clip(aria, MAX_TARGET_NAME_CHARS)
  const labelledBy = byIds(el, 'aria-labelledby')
  if (labelledBy !== '') return clip(labelledBy, MAX_TARGET_NAME_CHARS)
  const own = headline(el)
  if (own !== '') return clip(own, MAX_TARGET_NAME_CHARS)
  if (el instanceof HTMLInputElement) return clip(fieldLabel(el), MAX_TARGET_NAME_CHARS)
  for (const attribute of ['title', 'alt']) {
    const value = clean(el.getAttribute(attribute) ?? '')
    if (value !== '') return clip(value, MAX_TARGET_NAME_CHARS)
  }
  const image = el.querySelector('img[alt], svg[aria-label], [title]')
  const inner = image === null ? '' : clean(image.getAttribute('alt') ?? image.getAttribute('aria-label') ?? image.getAttribute('title') ?? '')
  if (inner !== '') return clip(inner, MAX_TARGET_NAME_CHARS)
  // accessibleName ends in the tag name; that is no name a person would recognise.
  const fallback = accessibleName(el)
  return fallback === el.tagName.toLowerCase() ? '' : clip(fallback, MAX_TARGET_NAME_CHARS)
}

const HEADING = ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > legend, :scope > header h1, :scope > header h2, :scope > header h3'
const ROW = 'tr, li, [role="row"], [role="listitem"]'
/** How far up the tree a context is looked for. */
const CONTEXT_DEPTH = 10

/** The row or labelled section the element sits in, when one is near. */
export function targetContext(el: Element, name: string): FoundTarget['context'] {
  let node: Element | null = composedParent(el)
  for (let depth = 0; node !== null && depth < CONTEXT_DEPTH; depth += 1, node = composedParent(node)) {
    if (node === el.ownerDocument.body || node === el.ownerDocument.documentElement) return undefined
    if (node.matches(ROW)) {
      const text = clip(node instanceof HTMLElement && typeof node.innerText === 'string' ? node.innerText : node.textContent ?? '', MAX_TARGET_CONTEXT_CHARS)
      if (text !== '' && text !== name) return { kind: 'row', text }
      continue
    }
    const aria = clean(node.getAttribute('aria-label') ?? '') || byIds(node, 'aria-labelledby')
    let text = aria
    if (text === '') {
      let heading: Element | null = null
      try { heading = node.querySelector(HEADING) } catch { /* :scope unsupported */ }
      if (heading !== null && !heading.contains(el)) text = clean(heading.textContent ?? '')
    }
    if (text !== '' && text !== name) return { kind: 'section', text: clip(text, MAX_TARGET_CONTEXT_CHARS) }
  }
  return undefined
}

/** Describe one element for an approval card. */
export function describeElement(el: Element): FoundTarget {
  const kind = targetKind(el)
  const name = targetName(el, kind)
  const context = targetContext(el, name)
  return {
    found: true,
    kind,
    name,
    ...(context === undefined ? {} : { context }),
    ...(isSensitiveField(el) ? { sensitive: true as const } : {}),
  }
}

/** Elements described for a card, by locator; a re-check compares against them. */
const described = new Map<string, WeakRef<Element>>()
/** Most locators remembered (oldest dropped first). */
const MAX_DESCRIBED = 64

function remember(key: string, el: Element): void {
  described.delete(key)
  described.set(key, new WeakRef(el))
  for (const oldest of described.keys()) {
    if (described.size <= MAX_DESCRIBED) break
    described.delete(oldest)
  }
}

function locatorKey(action: string, slot: string, args: Record<string, unknown>): string {
  return JSON.stringify([action, slot, args.index ?? null, typeof args.selector === 'string' ? args.selector : null])
}

/** Actions that act on the focused element when no locator is given. */
const FOCUS_ACTIONS: ReadonlySet<string> = new Set(['browser_type', 'browser_press', 'browser_clipboard'])

function describeSlot(action: string, slot: string, args: Record<string, unknown>, ids: ElementIds, recheck: boolean, allowFocus: boolean): TargetDescription | undefined {
  const located = args.index !== undefined || (typeof args.selector === 'string' && args.selector !== '')
  let el: Element | null
  if (located) {
    try {
      el = resolveActionTarget(args, ids)
    } catch {
      return { found: false }
    }
  } else if (allowFocus) {
    el = deepActiveElement()
    // Nothing in particular has focus: the keys go to the page.
    if (el === null || el === document.body || el === document.documentElement) return undefined
  } else {
    return undefined
  }
  if (!(el instanceof Element) || !el.isConnected) return { found: false }
  const key = locatorKey(action, slot, args)
  const description: FoundTarget = { ...describeElement(el), ...(located ? {} : { focused: true as const }) }
  if (!recheck) {
    remember(key, el)
    return description
  }
  const before = described.get(key)?.deref()
  return { ...description, same: before === el }
}

/**
 * Describe the element(s) one action would act on.
 * @param action - the tool name.
 * @param args - its arguments (frame removed).
 * @param ids - the frame's element registry.
 * @param recheck - compare with the first description instead of replacing it.
 */
export function describeActionTargets(action: string, args: Record<string, unknown>, ids: ElementIds, recheck = false): TargetSlots {
  const slots: TargetSlots = {}
  if (action === 'browser_drag') {
    const end = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
    const from = end(args.from)
    const to = end(args.to)
    const fromDescription = from === undefined ? undefined : describeSlot(action, 'from', from, ids, recheck, false)
    const toDescription = to === undefined ? undefined : describeSlot(action, 'to', to, ids, recheck, false)
    if (fromDescription !== undefined) slots.from = fromDescription
    if (toDescription !== undefined) slots.to = toDescription
    return slots
  }
  const target = describeSlot(action, 'target', args, ids, recheck, FOCUS_ACTIONS.has(action))
  if (target !== undefined) slots.target = target
  return slots
}
