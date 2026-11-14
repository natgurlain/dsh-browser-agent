/**
 * Text extraction primitives for the text-only page snapshot: visibility,
 * accessible names, interactive inventory, main-content heuristic, and
 * truncation helpers.
 *
 * The snapshot is the model's entire view of the page (no screenshots), so
 * every helper is written to produce dense, model-usable text under a hard
 * character budget.
 *
 * @module
 */

import { querySelectorAllDeep } from './dom.ts'

/**
 * Elements that are interactive by their own semantics. A match here always
 * enters the inventory (when visible).
 */
const CORE_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  ...[
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'combobox', 'option', 'switch', 'slider', 'spinbutton', 'searchbox', 'textbox', 'treeitem',
  ].map((role) => `[role="${role}"]`),
  '[role="gridcell"][aria-selected]',
].join(', ')

/**
 * Elements that are only interactive by a script hook (focusability, an inline
 * handler) or by delegating to a control. They enter the inventory only when
 * they do not wrap a core control, so a clickable card around a button does
 * not crowd the inventory with a duplicate.
 */
const GENERIC_INTERACTIVE_SELECTOR = [
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
  'label',
].join(', ')

/** Every element type the model may be asked to operate on. */
const INTERACTIVE_SELECTOR = `${CORE_INTERACTIVE_SELECTOR}, ${GENERIC_INTERACTIVE_SELECTOR}`

/** Default cap on one item's rendered name/state text. */
const MAX_ITEM_NAME_CHARS = 80

/** Form controls that custom widgets commonly hide behind a styled label. */
function isCheckable(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
}

/** Whether an element itself renders a box (no opacity exemption). */
function rendersBox(el: Element): boolean {
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Whether an element is visible to the user: not display/visibility/opacity
 * hidden and occupying layout space. Visually-hidden checkboxes, radios and
 * selects behind a rendered label or parent count as visible.
 * @param el - candidate element.
 * @returns true when the element renders.
 */
export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (rendersBox(el)) return true
  return isStyledControl(el)
}

/**
 * Custom checkboxes, radios and toggles keep the real input in the tree but
 * paint it invisible (opacity 0 or a collapsed box) and draw the control on a
 * sibling or the label. The input is still the thing to click, so it counts
 * as visible when its label or its parent renders.
 * @param el - candidate element.
 * @returns true for a hidden-but-operable form control.
 */
function isStyledControl(el: HTMLElement): boolean {
  if (!isCheckable(el) && !(el instanceof HTMLSelectElement)) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  for (const label of el.labels ?? []) {
    if (rendersBox(label)) return true
  }
  const parent = el.parentElement
  return parent !== null && rendersBox(parent)
}

/**
 * Whether the element is inside the current viewport (used to order the
 * inventory: what the user sees comes first).
 * @param el - element.
 * @returns true when any part is within the viewport.
 */
export function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth
}

/** Normalize whitespace and trim. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Text of an element: innerText when available (browsers), textContent
 * otherwise (jsdom/edge cases).
 * @param el - element.
 * @returns the element's text.
 */
function elementText(el: Element): string {
  if (el instanceof HTMLElement && typeof el.innerText === 'string') return el.innerText
  return el.textContent ?? ''
}

/**
 * Truncate text at a character budget, marking the cut.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns `{ text, truncated }` with `truncated` counting removed characters.
 */
export function truncate(text: string, max: number): { text: string; truncated: number } {
  if (text.length <= max) return { text, truncated: 0 }
  return { text: `${text.slice(0, max)}…`, truncated: text.length - max }
}

/**
 * The accessible name of an element, following the ARIA precedence chain
 * (aria-label → aria-labelledby → associated label → own text →
 * placeholder/alt).
 * @param el - element.
 * @returns a ≤80-char name, or the tag name as last resort.
 */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return truncate(clean(ariaLabel), MAX_ITEM_NAME_CHARS).text

  // aria-labelledby is an id list; the name is every referenced node's text in
  // order. Ids resolve in the element's own tree (document or shadow root).
  const root = el.getRootNode() as Document | ShadowRoot
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const refText = labelledBy.split(/\s+/)
      .filter((id) => id !== '')
      .map((id) => byId(root, id)?.textContent ?? '')
      .map(clean)
      .filter((text) => text !== '')
      .join(' ')
    if (refText !== '') return truncate(refText, MAX_ITEM_NAME_CHARS).text
  }

  const labelable = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
  if (labelable) {
    if (el.id !== '') {
      const label = root.querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`)
      const labelText = label?.textContent
      if (labelText !== undefined && labelText.trim() !== '') return truncate(clean(labelText), MAX_ITEM_NAME_CHARS).text
    }
    const wrappingLabelText = el.closest('label')?.textContent
    if (wrappingLabelText !== undefined && wrappingLabelText.trim() !== '') {
      return truncate(clean(wrappingLabelText), MAX_ITEM_NAME_CHARS).text
    }
  }

  const ownText = el instanceof HTMLInputElement ? '' : el.textContent
  if (ownText !== undefined && ownText.trim() !== '') return truncate(clean(ownText), MAX_ITEM_NAME_CHARS).text

  if (el instanceof HTMLInputElement) {
    // Button-like inputs carry their label in `value`; other inputs never use
    // the current value as a name (it is data, not identity — and for
    // password/credit fields it would leak the secret into the snapshot).
    const buttonLike = el.type === 'submit' || el.type === 'button' || el.type === 'reset'
    if (buttonLike && el.value !== '') return truncate(clean(el.value), MAX_ITEM_NAME_CHARS).text
    if (el.placeholder !== '') return truncate(clean(el.placeholder), MAX_ITEM_NAME_CHARS).text
    if (el.alt !== '') return truncate(clean(el.alt), MAX_ITEM_NAME_CHARS).text
    return truncate(clean(el.type), MAX_ITEM_NAME_CHARS).text
  }

  return el.tagName.toLowerCase()
}

/** getElementById for a document or a shadow root. */
function byId(root: Document | ShadowRoot, id: string): Element | null {
  return 'getElementById' in root ? root.getElementById(id) : null
}

/** CSS.escape with a fallback for environments that lack it (jsdom). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/**
 * The control a label operates, when it has one.
 * @param label - label element.
 * @returns the associated form control, or null.
 */
export function labelControl(label: Element): HTMLElement | null {
  return label instanceof HTMLLabelElement ? label.control : null
}

/**
 * Collect the page's interactive elements in document order (open shadow
 * roots included), deduplicated and visibility-filtered.
 *
 * Generic candidates (focusable or `onclick` containers, labels) are kept only
 * when they add something: a wrapper around a core control, or a label whose
 * control is itself listed, would only duplicate that control and spend the
 * inventory cap.
 *
 * @param root - document or element to scan.
 * @returns the interactive inventory.
 */
export function collectInteractive(root: Document | Element): Element[] {
  const seen = new Set<Element>()
  const candidates: Element[] = []
  for (const el of querySelectorAllDeep(root, INTERACTIVE_SELECTOR)) {
    if (seen.has(el)) continue
    seen.add(el)
    if (isVisible(el)) candidates.push(el)
  }
  const listed = new Set(candidates)
  const core = candidates.filter((el) => el.matches(CORE_INTERACTIVE_SELECTOR))
  const coreSet = new Set(core)
  return candidates.filter((el) => {
    if (coreSet.has(el)) return true
    if (el instanceof HTMLLabelElement) {
      // A label is the click target only when its control is not listed itself
      // (a fully hidden custom checkbox or toggle input).
      const control = labelControl(el)
      return control !== null && !listed.has(control)
    }
    // Focusable or clickable wrappers around a real control add nothing.
    return !core.some((control) => control !== el && el.contains(control))
  })
}

/** Tags whose content never belongs to the readable page text. */
const NON_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'canvas', 'iframe', 'object'])

/** Elements that start a new line in the structured text. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hr', 'legend', 'li', 'main',
  'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
])

/** Options for structured text rendering. */
export interface TextOptions {
  /** Skip blocks entirely above or below the viewport. */
  viewportOnly?: boolean
}

/** Rendered-text cap while walking, so a giant page cannot stall a snapshot. */
const STRUCTURED_WALK_CAP = 400_000

/**
 * Render an element's visible text as lightweight structure: `#` headings,
 * `-` list items (indented when nested), `|`-separated table rows, and one
 * line per block. Flattening a whole page into a single string hides which
 * label belongs to which value; a few markers keep that without the cost of a
 * full accessibility tree. Open shadow roots render in place of their host's
 * light children.
 *
 * @param root - element to render.
 * @returns newline-separated text (unbounded below the walk cap).
 */
export function structuredText(root: Element, options: TextOptions = {}): string {
  const lines: string[] = []
  let inline = ''
  let prefix = ''
  let total = 0
  let listDepth = 0

  const flush = (): void => {
    const text = clean(inline)
    inline = ''
    if (text === '') return
    const line = `${prefix}${text}`
    prefix = ''
    if (lines[lines.length - 1] === line) return
    lines.push(line)
    total += line.length + 1
  }
  const hidden = (el: Element): boolean => {
    if (el.getAttribute('aria-hidden') === 'true' || (el instanceof HTMLElement && el.hidden)) return true
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    // Viewport filtering checks blocks only: a partly visible container is
    // kept and its children are tested in turn.
    if (options.viewportOnly === true && el !== root && style.display !== 'inline') {
      const rect = el.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) return true
    }
    return false
  }

  const walk = (node: Node): void => {
    if (total > STRUCTURED_WALK_CAP) return
    if (node.nodeType === Node.TEXT_NODE) {
      inline += node.textContent ?? ''
      return
    }
    if (!(node instanceof Element)) return
    const tag = node.tagName.toLowerCase()
    if (NON_TEXT_TAGS.has(tag) || hidden(node)) return
    if (/^h[1-6]$/.test(tag)) {
      flush()
      walkChildren(node)
      prefix = `${'#'.repeat(Number(tag[1]))} `
      flush()
      prefix = ''
      return
    }
    if (tag === 'table') {
      flush()
      for (const row of node.querySelectorAll('tr')) {
        if (row.closest('table') !== node || hidden(row)) continue
        const cells = [...row.children].filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
        const text = cells.map((cell) => clean(elementText(cell))).join(' | ')
        if (text.replace(/[|\s]/g, '') === '') continue
        inline = `| ${text} |`
        flush()
      }
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      flush()
      listDepth += 1
      walkChildren(node)
      listDepth -= 1
      flush()
      return
    }
    if (tag === 'li') {
      flush()
      const marker = `${'  '.repeat(Math.max(0, listDepth - 1))}- `
      prefix = marker
      walkChildren(node)
      // A nested list flushes the item's own text first; keep the marker only
      // on the item's first line.
      if (prefix === marker) flush()
      prefix = ''
      return
    }
    const block = BLOCK_TAGS.has(tag)
    if (block) flush()
    walkChildren(node)
    if (block) flush()
  }
  const walkChildren = (el: Element): void => {
    if (typeof HTMLSlotElement !== 'undefined' && el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes({ flatten: true })
      for (const child of assigned.length > 0 ? assigned : [...el.childNodes]) walk(child)
      return
    }
    const children = el.shadowRoot !== null ? el.shadowRoot.childNodes : el.childNodes
    for (const child of children) walk(child)
  }

  walk(root)
  flush()
  return lines.join('\n')
}

/**
 * Best-effort main-content extraction (readability-lite): prefer a main
 * landmark, then a single standalone article, else the largest block
 * containing at least two paragraphs. Multiple articles commonly represent
 * cards or feed entries, so selecting only the first would hide page content.
 * @param doc - the document.
 * @returns the main text as structured lines (unbounded; callers apply budgets).
 */
export function mainText(doc: Document, options: TextOptions = {}): string {
  const main = doc.querySelector('main, [role="main"]')
  if (main !== null) return structuredText(main, options)
  const articles = doc.querySelectorAll('article')
  if (articles.length === 1) return structuredText(articles[0]!, options)

  let best: Element | null = null
  let bestScore = 0
  for (const candidate of doc.querySelectorAll('section, div, [role="main"]')) {
    const paragraphs = candidate.querySelectorAll('p').length
    if (paragraphs < 2) continue
    const text = elementText(candidate)
    const score = text.length * Math.min(paragraphs, 5)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best !== null) return structuredText(best, options)
  return doc.body === null ? '' : structuredText(doc.body, options)
}

/**
 * The full text of an element (or the whole document).
 * @param root - element to read; defaults to the document body.
 * @returns normalized text.
 */
export function pageText(root?: Element | null): string {
  const source = root ?? document.body
  if (source === null || source === undefined) return ''
  return clean(elementText(source))
}
