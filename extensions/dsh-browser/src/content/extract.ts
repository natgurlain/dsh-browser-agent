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

import { MAX_REPORTS, QUERY_EVENT, REPORT_EVENT_PREFIX } from '../shared/listener-probe.ts'
import { composedParent, cssEscape, querySelectorAllDeep } from './dom.ts'

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
/** Whether an element draws a box: not display:none / hidden / transparent, and non-empty. */
export function rendersBox(el: Element): boolean {
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
export function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whitespace-normalized text cut to `max` characters, the cut marked with an ellipsis. */
export function clip(text: string, max: number): string {
  const inline = clean(text)
  return inline.length > max ? `${inline.slice(0, max - 1)}…` : inline
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
/**
 * The control a label operates, when it has one.
 * @param label - label element.
 * @returns the associated form control, or null.
 */
export function labelControl(label: Element): HTMLElement | null {
  return label instanceof HTMLLabelElement ? label.control : null
}

/**
 * Attributes through which frameworks and hand-written delegation declare a
 * click action in the DOM itself (readable from the isolated world).
 */
const ACTION_ATTRIBUTES = [
  'jsaction', 'ng-click', 'data-ng-click', 'v-on:click', '@click', 'x-on:click', 'on:click', 'wire:click',
  'hx-get', 'hx-post', 'hx-put', 'hx-patch', 'hx-delete',
  'data-action', 'data-click', 'data-onclick', 'data-toggle', 'data-bs-toggle', 'data-dismiss', 'data-bs-dismiss',
]

/** Elements examined for cursor and action-attribute hints per collection. */
const MAX_HINT_SCAN = 15_000

/** Inferred click targets one collection may add to the inventory. */
export const MAX_INFERRED_ITEMS = 100

/** An inferred target with more element descendants than this is a container, not a control. */
const MAX_INFERRED_DESCENDANTS = 40

/** Share of the viewport (both axes) above which an inferred target is a page-level surface. */
const PAGE_SURFACE_RATIO = 0.9

/** The interactive inventory plus which of its members were only inferred. */
export interface Inventory {
  /** Semantic controls in document order, then inferred click targets in document order. */
  elements: Element[]
  /**
   * Members with no interactive semantics of their own: a script listener, a
   * framework handler, an action attribute or a pointer cursor says they are
   * clickable. They are hints from the page, never trusted.
   */
  inferred: ReadonlySet<Element>
}

/** Whether `el` declares a click action through a framework/delegation attribute. */
function hasActionAttribute(el: Element): boolean {
  if (el.attributes.length === 0) return false
  for (const name of ACTION_ATTRIBUTES) {
    const value = el.getAttribute(name)
    if (value === null) continue
    // jsaction lists `event:handler` pairs; a bare handler means click.
    if (name === 'jsaction' && value.includes(':') && !/(^|[;\s])(click|dblclick|mousedown|pointerdown)\s*:/.test(value)) continue
    return true
  }
  return false
}

function queryNonce(): string {
  const bytes = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Ask the page-world listener shim which elements a script made clickable
 * (protocol: `shared/listener-probe.ts`). The exchange is synchronous; without
 * a shim (a tab opened before the extension loaded, a browser that ignores
 * `world: "MAIN"`) nothing answers and the set stays empty.
 *
 * Whatever answers runs in the page's world, so the result is untrusted: it is
 * only ever a set of elements, capped, and filtered like any other hint.
 *
 * @returns elements reported as click-activated.
 */
function scriptActivatedElements(): Set<Element> {
  const reported = new Set<Element>()
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return reported
  const nonce = queryNonce()
  const reportType = `${REPORT_EVENT_PREFIX}${nonce}`
  const onReport = (event: Event): void => {
    event.stopImmediatePropagation()
    if (reported.size >= MAX_REPORTS) return
    // Reports from inside an open shadow root arrive retargeted to the host.
    const target = event.composedPath()[0] ?? event.target
    if (target instanceof Element) reported.add(target)
  }
  window.addEventListener(reportType, onReport, true)
  try {
    window.dispatchEvent(new CustomEvent(QUERY_EVENT, { detail: nonce }))
  } catch {
    // A page listener that threw must not fail the snapshot.
  } finally {
    window.removeEventListener(reportType, onReport, true)
  }
  return reported
}

/** Whether `el` is `root` or inside it, crossing shadow boundaries. */
function composedContains(root: Document | Element, el: Element): boolean {
  if (!el.isConnected) return false
  if (!(root instanceof Element)) return el.ownerDocument === root
  for (let node: Element | null = el; node !== null; node = composedParent(node)) {
    if (node === root) return true
  }
  return false
}

/**
 * Click targets with no interactive semantics, in document order.
 *
 * Sources: the page-world shim (script listeners, handler properties,
 * framework handlers), action attributes, and the element where a
 * `cursor: pointer` starts. All three are statements by the page; the filters
 * below decide what is worth a slot:
 *
 * - elements the semantic pass already considered are skipped (listed, or
 *   deliberately dropped as a duplicate of a control);
 * - a pointer cursor inside a listed control is that control's styling;
 * - page-level surfaces and large containers (delegation roots, backdrops)
 *   are not controls;
 * - of nested candidates only the innermost stays, and a candidate wrapping a
 *   listed control goes (same rule as for `onclick` wrappers);
 * - at most {@link MAX_INFERRED_ITEMS} are returned, viewport first.
 *
 * @param root - scan scope.
 * @param considered - every element the semantic pass matched.
 * @param listed - the semantic inventory.
 * @returns inferred click targets.
 */
function collectInferred(root: Document | Element, considered: ReadonlySet<Element>, listed: readonly Element[]): Element[] {
  const scripted = scriptActivatedElements()
  /** Candidate → whether a pointer cursor is its only evidence. */
  const hints = new Map<Element, boolean>()
  const cursors = new Map<Element, string>()
  const cursorOf = (el: Element): string => {
    let cursor = cursors.get(el)
    if (cursor === undefined) {
      cursor = getComputedStyle(el).cursor
      cursors.set(el, cursor)
    }
    return cursor
  }
  const eligible = (el: Element): el is HTMLElement => el instanceof HTMLElement
    && el !== document.body && el !== document.documentElement && !considered.has(el)
  let scanned = 0
  for (const el of querySelectorAllDeep(root, '*')) {
    scanned += 1
    if (scanned > MAX_HINT_SCAN) break
    if (!eligible(el)) continue
    if (scripted.has(el) || hasActionAttribute(el)) {
      hints.set(el, false)
      continue
    }
    if (cursorOf(el) !== 'pointer') continue
    // `cursor` inherits: only the element that introduces it is the target.
    const parent = composedParent(el)
    if (parent === null || cursorOf(parent) !== 'pointer') hints.set(el, true)
  }
  // Reported elements past the scan cap still count.
  for (const el of scripted) {
    if (!hints.has(el) && eligible(el) && composedContains(root, el)) hints.set(el, false)
  }
  if (hints.size === 0) return []

  const listedSet = new Set(listed)
  const insideListed = (el: Element): boolean => {
    for (let node = composedParent(el); node !== null; node = composedParent(node)) {
      if (listedSet.has(node)) return true
    }
    return false
  }
  const candidates: Element[] = []
  for (const [el, cursorOnly] of hints) {
    if (el.closest('[inert], [aria-hidden="true"]') !== null || !isVisible(el)) continue
    if (cursorOnly && insideListed(el)) continue
    if (el.getElementsByTagName('*').length > MAX_INFERRED_DESCENDANTS) continue
    const rect = el.getBoundingClientRect()
    if (rect.width >= window.innerWidth * PAGE_SURFACE_RATIO && rect.height >= window.innerHeight * PAGE_SURFACE_RATIO) continue
    candidates.push(el)
  }

  // Innermost wins: anything that wraps a listed control or another candidate is a container.
  const wrappers = new Set<Element>()
  for (const el of [...listed, ...candidates]) {
    for (let node = composedParent(el); node !== null && !wrappers.has(node); node = composedParent(node)) {
      wrappers.add(node)
    }
  }
  const kept = candidates.filter((el) => !wrappers.has(el))
  if (kept.length <= MAX_INFERRED_ITEMS) return kept
  const chosen = new Set<Element>()
  for (const visible of [true, false]) {
    for (const el of kept) {
      if (chosen.size >= MAX_INFERRED_ITEMS) break
      if (isInViewport(el) === visible) chosen.add(el)
    }
  }
  return kept.filter((el) => chosen.has(el))
}

/**
 * Collect the page's interactive elements (open shadow roots included),
 * deduplicated and visibility-filtered.
 *
 * Semantic candidates come first, in document order. Generic ones (focusable
 * or `onclick` containers, labels) are kept only when they add something: a
 * wrapper around a core control, or a label whose control is itself listed,
 * would only duplicate that control and spend the inventory cap.
 *
 * Inferred click targets (see {@link collectInferred}) follow, so adding them
 * never changes the order of the semantic ones.
 *
 * @param root - document or element to scan.
 * @returns the inventory and which members were inferred.
 */
export function collectInventory(root: Document | Element): Inventory {
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
  const semantic = candidates.filter((el) => {
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
  const inferred = collectInferred(root, seen, semantic)
  return { elements: [...semantic, ...inferred], inferred: new Set(inferred) }
}

/**
 * The interactive inventory as a plain list (see {@link collectInventory}).
 * @param root - document or element to scan.
 * @returns semantic controls, then inferred click targets.
 */
export function collectInteractive(root: Document | Element): Element[] {
  return collectInventory(root).elements
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
