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
import { nativeChoiceLabels } from './select.ts'
import { MAX_CHOSEN, MAX_DESTINATION_PATH_CHARS, MAX_TARGET_CONTEXT_CHARS, MAX_TARGET_NAME_CHARS, TARGET_KINDS, type TargetDescription, type TargetDestination, type TargetKind, type TargetSlots } from '../shared/target-description.ts'

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

/**
 * Whether activating the element submits a form, by native structure only:
 * a `<button>` whose effective type is submit (a missing or unknown type
 * attribute is submit) or an `<input type=submit|image>`, with a form owner.
 * A page-chosen `role` does not change this, so `role="tab"` on a submit
 * button cannot hide it. A label submits when its control would.
 */
export function submitsForm(el: Element): boolean {
  if (el instanceof HTMLLabelElement) return el.control !== null && el.control !== el && submitsForm(el.control)
  if (el instanceof HTMLButtonElement) return el.type === 'submit' && el.form !== null
  if (el instanceof HTMLInputElement) return (el.type === 'submit' || el.type === 'image') && el.form !== null
  // A click on something inside a submit button (an icon, a span) reaches the button.
  const button = el.closest('button')
  return button !== null && button !== el && submitsForm(button)
}

/** Input types where Enter submits the form (HTML implicit submission). */
const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number',
])

/** A single-line field with a form owner: Enter in it submits that form. */
export function fieldInForm(el: Element): boolean {
  return el instanceof HTMLInputElement && IMPLICIT_SUBMIT_TYPES.has(el.type) && el.form !== null
}

/** Where a URL goes, without its query or fragment values. */
export function destinationOf(href: string): TargetDestination {
  try {
    const url = new URL(href, document.baseURI)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { other: true }
    const path = url.pathname.slice(0, MAX_DESTINATION_PATH_CHARS)
    return { origin: url.origin, path, query: url.search !== '' || url.hash !== '' || href.includes('?') }
  } catch {
    return { other: true }
  }
}

/** The link an element is (or sits in). */
function linkOf(el: Element): HTMLAnchorElement | HTMLAreaElement | undefined {
  const link = el.closest('a[href], area[href]')
  return link instanceof HTMLAnchorElement || link instanceof HTMLAreaElement ? link : undefined
}

/**
 * Whether a link goes somewhere real: not an empty `href`, not a fragment of
 * this page, not `javascript:`, and not this same document. A link that does
 * not is a button whose page code decides what it does, and is described
 * without a destination.
 */
export function realLink(link: HTMLAnchorElement | HTMLAreaElement): boolean {
  const raw = (link.getAttribute('href') ?? '').trim()
  if (raw === '' || raw.startsWith('#') || /^javascript:/iu.test(raw.replace(/[\u0000-\u0020]/gu, ''))) return false
  try {
    const url = new URL(raw, document.baseURI)
    const here = new URL(document.URL)
    if (url.protocol === 'javascript:') return false
    return !(url.origin === here.origin && url.pathname === here.pathname && url.search === here.search)
  } catch {
    return true
  }
}

/**
 * Whether the element only shows or hides part of the page, by its own
 * structure: it carries `aria-expanded`, is a `<summary>`, or is a button
 * (native or role) with `aria-haspopup` or `aria-controls`. A page can lie
 * about this; Auto review only trusts it for names in a short harmless list.
 */
export function isDisclosure(el: Element): boolean {
  // On the element itself, never inherited from an ancestor: a clickable span
  // inside an expandable row is not the row's disclosure control.
  if (el.tagName === 'SUMMARY') return true
  if (el.hasAttribute('aria-expanded')) return true
  const button = el instanceof HTMLButtonElement || (el.getAttribute('role') ?? '').trim().toLowerCase() === 'button'
  const popup = (el.getAttribute('aria-haspopup') ?? '').trim().toLowerCase()
  return button && ((popup !== '' && popup !== 'false') || (el.getAttribute('aria-controls') ?? '').trim() !== '')
}

function contentEditable(el: Element): boolean {
  const value = el.getAttribute('contenteditable')
  return (el instanceof HTMLElement && el.isContentEditable) || (value !== null && value.toLowerCase() !== 'false')
}

/**
 * The editing host typed text goes to: the outermost contenteditable
 * element the element is in (an empty paragraph inside a full editor is not
 * an empty editor).
 */
export function editingHost(el: Element): Element | undefined {
  if (!contentEditable(el)) return undefined
  let host: Element = el
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (!contentEditable(node)) break
    host = node
  }
  return host
}

/** For a text field: whether it holds nothing yet (one bit; the value never leaves the page), measured where the text goes. */
function fieldEmpty(el: Element): boolean | undefined {
  if (el instanceof HTMLTextAreaElement) return el.value === ''
  if (el instanceof HTMLInputElement) return IMPLICIT_SUBMIT_TYPES.has(el.type) ? el.value === '' : undefined
  const host = editingHost(el)
  if (host !== undefined) return (host.textContent ?? '').trim() === ''
  return undefined
}

/** Whether a field saves or acts on change by native markup (an onchange/oninput handler on it or its form). */
function fieldAutoSaves(el: Element): boolean {
  const own = (node: Element | null | undefined): boolean => node !== null && node !== undefined && (node.hasAttribute('onchange') || node.hasAttribute('oninput') || node.hasAttribute('onkeyup') || node.hasAttribute('onkeydown'))
  const form = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.form : el.closest('form')
  return own(el) || own(editingHost(el)) || own(form)
}

/** A field that offers suggestions (Tab may accept one). */
function offersSuggestions(el: Element): boolean {
  const autocomplete = (el.getAttribute('aria-autocomplete') ?? '').trim().toLowerCase()
  const popup = (el.getAttribute('aria-haspopup') ?? '').trim().toLowerCase()
  return el.hasAttribute('list') || (autocomplete !== '' && autocomplete !== 'none') || (popup !== '' && popup !== 'false')
    || (el.getAttribute('aria-controls') ?? '').trim() !== '' || el.getAttribute('aria-expanded') === 'true'
    || (el.getAttribute('role') ?? '').trim().toLowerCase() === 'combobox'
}

/** Whether a dialog or modal is open in this document (Escape may dismiss it). */
function dialogOpen(doc: Document): boolean {
  for (const dialog of doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
    if (!hiddenElement(dialog, false)) return true
  }
  return false
}

/** Whether the document has layout (a real browser, not a DOM without rendering). */
function hasLayout(el: Element): boolean {
  // Only when the element itself has a box can a descendant without one be called hidden.
  return el.getClientRects().length > 0
}

/**
 * Whether an element hides its content from a person: `hidden`,
 * aria-hidden, display none, visibility hidden, opacity 0, font size 0, a
 * zero clip, or (with layout) no box at all. Not covered: text the same
 * colour as its background, text moved off-screen or under another element.
 */
function hiddenElement(el: Element, layout: boolean): boolean {
  if (el instanceof HTMLElement && el.hidden) return true
  if ((el.getAttribute('aria-hidden') ?? '').trim().toLowerCase() === 'true') return true
  const view = el.ownerDocument.defaultView
  const style = view?.getComputedStyle(el)
  if (style !== undefined) {
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true
    if (style.opacity !== '' && Number(style.opacity) === 0) return true
    if (style.fontSize !== '' && Number.parseFloat(style.fontSize) === 0) return true
    if (/rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)/u.test(style.clip ?? '')) return true
    if (/inset\(\s*50%/u.test(style.clipPath ?? '')) return true
  }
  if (layout && el.getClientRects().length === 0 && !(style?.display === 'contents')) return true
  return false
}

/** The text of an element a person can see (all lines, joined), skipping hidden parts, scripts and form values. */
export function visibleText(root: Element): string {
  const layout = hasLayout(root)
  const parts: string[] = []
  const walk = (node: Node, depth: number): void => {
    if (depth > 40) return
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent ?? '')
      else if (child instanceof Element) {
        if (/^(?:SCRIPT|STYLE|TEMPLATE|NOSCRIPT|INPUT|SELECT|TEXTAREA|OPTION)$/u.test(child.tagName)) continue
        if (hiddenElement(child, layout)) continue
        walk(child, depth + 1)
      }
    }
  }
  if (hiddenElement(root, layout)) return ''
  walk(root, 0)
  return clean(parts.join(' '))
}

/**
 * What a person sees as the control's label: for a labelled field (a
 * checkbox, a radio, a text field) the visible text of its <label>s; for
 * anything else its own visible text. Empty for an icon-only control.
 */
export function renderedLabel(el: Element, kind: TargetKind): string {
  // The visible counterpart of the name's own source (targetName / fieldLabel):
  // an aria-label is compared with the element's own visible text, a
  // labelledby with the visible text of the nodes it points to (a hidden node
  // shows nothing), a native <label> with its first visible line. A field's
  // own content is its value, never its label: it is never read here.
  const field = FIELD_KINDS.has(kind) && !(el instanceof HTMLLabelElement)
  if (clean(el.getAttribute('aria-label') ?? '') !== '') return field ? '' : clip(visibleText(el), MAX_TARGET_NAME_CHARS)
  const root = el.getRootNode() as Document | ShadowRoot
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/u).filter((id) => id !== '')
  const referenced = ids.map((id) => ('getElementById' in root ? root.getElementById(id) : null)).filter((node): node is HTMLElement => node !== null && node !== el && !node.contains(el))
  if (referenced.length > 0) return clip(clean(referenced.map(visibleText).join(' ')), MAX_TARGET_NAME_CHARS)
  if (field) {
    const labels = 'labels' in el ? (el as HTMLInputElement).labels : null
    for (const label of labels === null ? [] : [...labels]) {
      const shown = visibleText(label)
      const first = headline(label, el)
      // The label's headline when a person sees it as the start of the label, else all it shows.
      if (shown !== '') return clip(first !== '' && foldName(shown).startsWith(foldName(first)) ? first : shown, MAX_TARGET_NAME_CHARS)
    }
    return ''
  }
  return clip(visibleText(el), MAX_TARGET_NAME_CHARS)
}

/** Clickable things another control with the same name could be. */
const CONTROL_SELECTOR = 'button, a[href], area[href], summary, select, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], input[type="checkbox"], input[type="radio"], [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="treeitem"], [role="checkbox"], [role="radio"], [role="switch"], [onclick]'

/** The name as Auto review compares names: folded, case-folded, whitespace collapsed. */
function foldName(text: string): string {
  return text.normalize('NFKC').replace(/[\u2018\u2019\u02BC\uFF07`\u00B4]/gu, "'").replace(/[\u201C\u201D\uFF02]/gu, '"').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** How many visible, enabled controls in the document carry this name (the element included; capped at 99). */
export function sameNameCount(el: Element, name: string): number {
  const wanted = foldName(name)
  if (wanted === '') return 1
  const layout = hasLayout(el)
  let count = 0
  let seen = 0
  for (const candidate of el.ownerDocument.querySelectorAll(CONTROL_SELECTOR)) {
    seen += 1
    if (seen > 3_000) break
    if (candidate === el) { count += 1; continue }
    if ((candidate as HTMLButtonElement).disabled === true || candidate.getAttribute('aria-disabled') === 'true') continue
    if (hiddenElement(candidate, layout)) continue
    if (foldName(targetName(candidate, targetKind(candidate))) === wanted) count += 1
    if (count >= 99) break
  }
  return Math.max(1, count)
}

/**
 * Which row or section the element is in, as a person would say it: the
 * first cell of its table row, or the first emphasised text or heading of
 * its list item or article, else the row's or section's label.
 */
export function rowKey(el: Element, name: string): string {
  const row = el.closest('tr, li, [role="row"], [role="listitem"], article')
  const wanted = foldName(name)
  const usable = (text: string): string | undefined => {
    const value = clip(clean(text), MAX_TARGET_CONTEXT_CHARS)
    return value !== '' && foldName(value) !== wanted ? value : undefined
  }
  if (row !== null) {
    const cells = row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"], :scope > [role="rowheader"]')
    for (const cell of cells) {
      if (cell.contains(el)) continue
      const text = usable(visibleText(cell))
      if (text !== undefined) return text
    }
    for (const strong of row.querySelectorAll('strong, b, h1, h2, h3, h4, h5, h6, [role="heading"]')) {
      if (strong.contains(el)) continue
      const text = usable(visibleText(strong))
      if (text !== undefined) return text
    }
    const label = usable(row.getAttribute('aria-label') ?? '')
    if (label !== undefined) return label
  }
  const context = targetContext(el, name)
  return context?.kind === 'section' ? usable(context.text) ?? '' : ''
}

/**
 * Where an element's form goes, and how: for a submit control its own
 * formaction/formmethod first, for a field or select the form's.
 */
function formOf(el: Element): (TargetDestination & { method?: 'get' | 'post' | 'dialog' }) | undefined {
  const control = el instanceof HTMLLabelElement ? el.control : el.closest('button, input, select, textarea') ?? el
  if (!(control instanceof HTMLButtonElement) && !(control instanceof HTMLInputElement) && !(control instanceof HTMLSelectElement) && !(control instanceof HTMLTextAreaElement)) return undefined
  const form = control.form
  if (form === null) return undefined
  const submitter = control instanceof HTMLButtonElement || (control instanceof HTMLInputElement && (control.type === 'submit' || control.type === 'image'))
  const own = submitter ? (control as HTMLButtonElement | HTMLInputElement) : undefined
  const destination = destinationOf(own?.getAttribute('formaction') !== null && own !== undefined ? own.formAction : form.action || document.baseURI)
  const method = ((own?.getAttribute('formmethod') !== null && own !== undefined ? own.formMethod : '') || form.method || 'get').toLowerCase()
  return 'other' in destination ? destination : { ...destination, ...(method === 'get' || method === 'post' || method === 'dialog' ? { method } : {}) }
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
    ...(submitsForm(el) ? { submits: true as const } : {}),
    ...(fieldInForm(el) ? { inForm: true as const } : {}),
    ...(() => {
      const link = linkOf(el)
      if (link === undefined) return {}
      // A download writes a file to disk whatever its address: always reported.
      const download = link.hasAttribute('download') ? { download: true as const } : {}
      return realLink(link) ? { href: destinationOf(link.getAttribute('href') ?? ''), ...download } : download
    })(),
    ...(isDisclosure(el) ? { disclosure: true as const } : {}),
    ...(() => {
      const empty = fieldEmpty(el)
      return empty === undefined ? {} : { empty, ...fieldAutoSaves(el) ? { autoSubmit: true as const } : {}, ...offersSuggestions(el) ? { suggests: true as const } : {} }
    })(),
    rendered: renderedLabel(el, kind),
    ...(() => {
      const link = linkOf(el)
      const target = link?.getAttribute('target')?.trim().toLowerCase() ?? ''
      return link !== undefined && target !== '' && target !== '_self' ? { newTab: true as const } : {}
    })(),
    ...(dialogOpen(el.ownerDocument) ? { dialogOpen: true as const } : {}),
    ...(() => {
      // Submit controls, fields where Enter submits, and selects in a form: where their form goes.
      const inForm = submitsForm(el) || fieldInForm(el) || ((el instanceof HTMLSelectElement || (el instanceof HTMLLabelElement && el.control instanceof HTMLSelectElement)) && (el instanceof HTMLSelectElement ? el : el.control as HTMLSelectElement).form !== null)
      const form = inForm ? formOf(el) : undefined
      return form === undefined ? {} : { form }
    })(),
  }
}

/** For browser_select on a native select: the labels it would choose, and whether the page acts on change. */
function selectFacts(el: Element, args: Record<string, unknown>): Pick<Extract<TargetDescription, { found: true }>, 'chosen' | 'autoSubmit'> {
  const select = el instanceof HTMLSelectElement ? el : el instanceof HTMLLabelElement && el.control instanceof HTMLSelectElement ? el.control : undefined
  if (select === undefined) return {}
  const chosen = nativeChoiceLabels(select, args)
  return {
    ...(chosen === undefined ? {} : { chosen: chosen.slice(0, MAX_CHOSEN).map((label) => clip(label, MAX_TARGET_NAME_CHARS)) }),
    ...(select.hasAttribute('onchange') || select.form?.hasAttribute('onchange') === true ? { autoSubmit: true as const } : {}),
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
  const base = describeElement(el)
  const description: FoundTarget = {
    ...base,
    ...(located ? {} : { focused: true as const }),
    // Clicks and key presses: how many controls share the name, and which row this one is in.
    ...(action === 'browser_click' || action === 'browser_press' || action === 'browser_select' ? { sameName: sameNameCount(el, base.name), rowKey: rowKey(el, base.name) } : {}),
    ...(action === 'browser_select' ? selectFacts(el, args) : {}),
  }
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
