/**
 * Text-only page snapshot: the model's entire view of the page.
 *
 * The browser tools use text snapshots, so the snapshot renders the page as
 * structured text under a hard character budget: URL/title, main content, a
 * numbered interactive inventory, and form fields (sensitive values masked).
 * `delta` mode returns only what changed since the last snapshot, and stable
 * element ids keep the model's addressing valid across snapshots.
 *
 * @module
 */

import { accessibleName, collectInteractive, isInViewport, isVisible, labelControl, mainText, structuredText, truncate } from './extract.ts'
import { resolveSelector } from './dom.ts'
import { ElementIds } from './ids.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

/** Role label per element kind (model-facing vocabulary). */
function roleOf(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case 'checkbox': return 'checkbox'
      case 'radio': return 'radio'
      case 'range': return 'slider'
      case 'number': return 'spinbutton'
      case 'search': return 'searchbox'
      case 'button':
      case 'submit':
      case 'reset': return 'button'
      default: return 'input'
    }
  }
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable'
  if (el.tagName === 'SUMMARY') return 'summary'
  // A label stands in for its hidden control (custom checkbox/toggle).
  const control = labelControl(el)
  if (control !== null) return `${roleOf(control)} label`
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return 'clickable'
  return el.tagName.toLowerCase()
}

/** One numbered interactive element. */
interface InventoryItem {
  index: number
  role: string
  name: string
  disabled?: boolean
  checked?: boolean
  selected?: boolean
  expanded?: boolean
  href?: string
  inViewport: boolean
}

/** Which parts of the page a snapshot renders. */
export type SnapshotMode = 'full' | 'interactive' | 'text'

/** One numbered form field with its (masked) value. */
interface FormFieldView {
  index: number
  label: string
  kind: string
  value: string
  masked: boolean
  checked?: boolean
  required?: boolean
}

/** One page snapshot. */
export interface SnapshotView {
  version: number
  url: string
  title: string
  ready: 'complete' | 'loading'
  main: string
  items: InventoryItem[]
  forms: FormFieldView[]
  /** ids that changed since the last snapshot (delta mode). */
  changed: number[]
  /** ids that disappeared since the last snapshot (delta mode). */
  removed: number[]
  /** Line diff of the main text against the previous snapshot (delta mode, when it changed). */
  mainDiff?: { added: string[]; removed: string[] }
  /** Rendering knobs this view was built with. */
  mode: SnapshotMode
  viewportOnly: boolean
  collapse: boolean
  /** true when the inventory was renumbered (model should re-read ids). */
  reindexed: boolean
  /** Budget accounting: characters cut from main text and items/forms dropped by count caps. */
  truncated: { mainChars: number; itemsDropped: number; formsDropped: number }
  /** 总预算（渲染封顶用）。 */
  budgetChars: number
}

/** Snapshot budgets: negotiated with the plugin via hello caps. */
export interface SnapshotBudget {
  maxItems: number
  maxForms: number
  maxChars: number
}

/** Options for one snapshot build. */
export interface SnapshotOptions {
  delta?: boolean
  region?: string
  budget: SnapshotBudget
  /** full (default): text + inventory + forms; interactive: no main text; text: main text only. */
  mode?: SnapshotMode
  /** Only elements (and text blocks) inside the viewport. */
  viewportOnly?: boolean
  /** Collapse long runs of similar inventory items (default true). */
  collapse?: boolean
}

/** Headline for a link: same-origin relative path, else host + path. */
function hrefHeadline(href: string): string {
  try {
    const url = new URL(href, document.baseURI)
    return url.origin === location.origin ? `${url.pathname}${url.search}` : `${url.host}${url.pathname}`
  } catch {
    return href
  }
}

/**
 * Whether no ancestor hides the subtree by opacity.
 *
 * `opacity` does not inherit, so an element inside a faded-out subtree still
 * reports its own `opacity: 1` and keeps a non-zero rectangle. That is exactly
 * how a dismissable modal looks while it is closing or pre-rendered, so a
 * check that reads only the dialog itself would treat it as open and let its
 * invisible controls evict the ones actually on screen.
 *
 * The walk covers every `Element`, not only HTML: an HTML dialog can sit
 * inside an SVG `foreignObject`, and an SVG ancestor that fades the subtree
 * out hides it just as effectively. `display: none` and `visibility: hidden`
 * need no walk here: the first collapses the rectangle `isVisible` already
 * measures, and the second is inherited, so it is already visible in the
 * dialog's own computed style.
 *
 * @param el - candidate element.
 * @returns true when no ancestor fades the subtree out.
 */
function ancestorsRendered(el: Element): boolean {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).opacity === '0') return false
  }
  return true
}

/**
 * Build a memoized "is this dialog open?" test.
 *
 * Openness depends only on the dialog, so the ancestor walk is evaluated once
 * per dialog rather than once per candidate element.
 *
 * @returns a predicate over dialog elements.
 */
function openDialogTest(): (dialog: Element) => boolean {
  const seen = new Map<Element, boolean>()
  return (dialog) => {
    let open = seen.get(dialog)
    if (open === undefined) {
      open = isVisible(dialog) && ancestorsRendered(dialog)
      seen.set(dialog, open)
    }
    return open
  }
}

/**
 * The open modal surface an element belongs to, if any.
 *
 * A modal makes everything behind it inert, so its controls are the real
 * interaction surface. It is also appended late in the DOM, which would
 * otherwise push it past the inventory cap on element-heavy pages and hide
 * the very controls the caller needs. A closed pre-rendered dialog is not
 * visible and must not be promoted.
 *
 * @param el - candidate element.
 * @param isOpen - memoized openness test for a dialog element.
 * @returns the owning open dialog, or null.
 */
function openDialogOf(el: Element, isOpen: (dialog: Element) => boolean): Element | null {
  const dialog = el.closest('[role="dialog"], [aria-modal="true"]')
  return dialog !== null && isOpen(dialog) ? dialog : null
}

/**
 * Build a snapshot of the current page.
 *
 * Reconciles the stable id registry, collects the inventory (dialog-first,
 * then viewport-first, capped), extracts main content (budgeted), and — in
 * delta mode — diffs against the previous snapshot.
 *
 * @param ids - the stable id registry (one per content-script lifetime).
 * @param options - delta flag, region selector, and negotiated budgets.
 * @param last - previous snapshot view, or null for the first snapshot.
 * @returns the snapshot view.
 */
export function buildSnapshot(ids: ElementIds, options: SnapshotOptions, last: SnapshotView | null): SnapshotView {
  const elements = collectInteractive(document)
  const { added, removed } = ids.assign(elements)
  // A renumbering is only meaningful relative to a previous snapshot: the
  // first snapshot on a fresh document always adds everything.
  const reindexed = last !== null && added + removed > elements.length * 0.5

  // Measure viewport and dialog membership once. Calling getBoundingClientRect
  // from a sort comparator forces repeated layout reads on large pages.
  const isOpenDialog = openDialogTest()
  const viewportOnly = options.viewportOnly === true
  const elementViews = elements.map((element) => ({
    element,
    inViewport: isInViewport(element),
    inDialog: openDialogOf(element, isOpenDialog) !== null,
  })).filter((view) => !viewportOnly || view.inViewport)
  const ordered = [...elementViews].sort((a, b) =>
    Number(b.inDialog) - Number(a.inDialog) || Number(b.inViewport) - Number(a.inViewport))
  const names = new Map<Element, string>()
  const nameOf = (element: Element): string => {
    let name = names.get(element)
    if (name === undefined) {
      name = accessibleName(element)
      names.set(element, name)
    }
    return name
  }

  const items: InventoryItem[] = []
  for (const { element: el, inViewport } of ordered.slice(0, options.budget.maxItems)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const item: InventoryItem = {
      index,
      role: roleOf(el),
      name: nameOf(el),
      inViewport,
    }
    if (el instanceof HTMLButtonElement && el.disabled) item.disabled = true
    if (el instanceof HTMLInputElement) {
      if (el.disabled) item.disabled = true
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked
    }
    const control = labelControl(el)
    if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
      item.checked = control.checked
      if (control.disabled) item.disabled = true
    }
    const ariaChecked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed')
    if (ariaChecked === 'true' || ariaChecked === 'false') item.checked = ariaChecked === 'true'
    if (el.getAttribute('aria-disabled') === 'true') item.disabled = true
    const ariaExpanded = el.getAttribute('aria-expanded')
    if (ariaExpanded === 'true' || ariaExpanded === 'false') item.expanded = ariaExpanded === 'true'
    if ((el instanceof HTMLOptionElement && el.selected) || el.getAttribute('aria-selected') === 'true') item.selected = true
    if (el instanceof HTMLAnchorElement && el.href !== '') item.href = hrefHeadline(el.href)
    items.push(item)
  }

  // Form controls are already part of the visible interactive inventory, so
  // reuse that scan instead of querying, styling, and measuring them again.
  const formElements = elementViews.map((view) => view.element).filter((el) => el instanceof HTMLInputElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLTextAreaElement)
  const forms: FormFieldView[] = []
  for (const el of formElements.slice(0, options.budget.maxForms)) {
    const index = ids.indexOf(el)
    if (index === undefined) continue
    const masked = isSensitiveField(el)
    const checkable = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
    const value = checkable
      ? ''
      : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el instanceof HTMLSelectElement
        ? selectedText(el)
        : ''
    forms.push({
      index,
      label: nameOf(el),
      kind: el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase(),
      value: masked ? maskValue(value) : value.slice(0, 120),
      masked,
      ...checkable ? { checked: el.checked } : {},
      ...el instanceof HTMLInputElement && el.required ? { required: true } : {},
    })
  }

  const mode = options.mode ?? 'full'
  const regionEl = options.region !== undefined && options.region !== ''
    ? resolveSelector(options.region)
    : null
  const mainSource = regionEl !== null
    ? structuredText(regionEl, { viewportOnly })
    : mainText(document, { viewportOnly })
  // A text-only snapshot spends almost the whole budget on the text.
  const mainBudget = Math.floor(options.budget.maxChars * (mode === 'text' ? 0.9 : 0.5))
  const main = truncate(mainSource, mainBudget)

  const lastItems = last === null ? new Map<number, InventoryItem>() : new Map(last.items.map((item) => [item.index, item]))
  const lastForms = last === null ? new Map<number, FormFieldView>() : new Map(last.forms.map((form) => [form.index, form]))

  const changed = new Set<number>()
  const removedIds: number[] = []
  let mainDiff: SnapshotView['mainDiff']
  if (options.delta === true && last !== null) {
    if (last.main !== main.text || last.url !== location.href || last.title !== document.title) {
      changed.add(-1) // -1 = 正文/标题/URL 变化（渲染时说明）
    }
    if (last.main !== main.text) mainDiff = diffLines(last.main, main.text)
    for (const item of items) {
      const before = lastItems.get(item.index)
      if (before === undefined || !sameItem(before, item)) changed.add(item.index)
    }
    const currentItemIds = new Set(items.map((item) => item.index))
    for (const index of lastItems.keys()) {
      if (!currentItemIds.has(index)) removedIds.push(index)
    }
    for (const form of forms) {
      const before = lastForms.get(form.index)
      if (before === undefined || !sameForm(before, form)) changed.add(form.index)
    }
  }

  return {
    version: (last?.version ?? 0) + 1,
    url: location.href,
    title: document.title,
    ready: document.readyState === 'complete' ? 'complete' : 'loading',
    main: main.text,
    items,
    forms,
    changed: options.delta === true ? [...changed] : [],
    removed: options.delta === true ? removedIds : [],
    ...mainDiff === undefined ? {} : { mainDiff },
    mode,
    viewportOnly,
    collapse: options.collapse !== false,
    reindexed,
    truncated: {
      mainChars: main.truncated,
      itemsDropped: Math.max(0, elementViews.length - options.budget.maxItems),
      formsDropped: Math.max(0, formElements.length - options.budget.maxForms),
    },
    budgetChars: options.budget.maxChars,
  }
}

function selectedText(select: HTMLSelectElement): string {
  return [...select.selectedOptions].map((option) => option.textContent ?? '').join(', ')
}

function sameItem(a: InventoryItem, b: InventoryItem): boolean {
  return a.role === b.role && a.name === b.name && a.href === b.href
    && a.disabled === b.disabled && a.checked === b.checked && a.inViewport === b.inViewport
    && a.expanded === b.expanded && a.selected === b.selected
}

function sameForm(a: FormFieldView, b: FormFieldView): boolean {
  return a.label === b.label && a.kind === b.kind && a.value === b.value && a.masked === b.masked
    && a.checked === b.checked && a.required === b.required
}

/**
 * Multiset line diff: which lines of `after` are new and which lines of
 * `before` are gone. Order-insensitive on purpose — a re-sorted list reads as
 * no change, and the result stays linear on large texts.
 * @param before - previous main text.
 * @param after - current main text.
 * @returns added and removed lines, in their own text order.
 */
export function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
  const count = (text: string): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const line of text.split('\n')) if (line !== '') counts.set(line, (counts.get(line) ?? 0) + 1)
    return counts
  }
  const take = (text: string, other: Map<string, number>): string[] => {
    const remaining = new Map(other)
    const result: string[] = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      const left = remaining.get(line) ?? 0
      if (left > 0) remaining.set(line, left - 1)
      else result.push(line)
    }
    return result
  }
  return { added: take(after, count(before)), removed: take(before, count(after)) }
}

/** Runs shorter than this render item by item. */
const COLLAPSE_MIN_RUN = 8
/** Items of a collapsed run that are still shown individually. */
const COLLAPSE_KEEP = 3

/** Shape of a name: digit runs are wildcards; other names compare by word count. */
function textShape(name: string): string {
  if (/\d/.test(name)) return name.replace(/\d+/g, '#').toLowerCase()
  return `words:${Math.min(6, name.trim().split(/\s+/).filter((word) => word !== '').length)}`
}

/**
 * Shape of an item for run collapsing. Links collapse only when their href
 * pattern (digit runs wildcarded) and their text shape both match; distinct
 * destinations (top-level navigation, `/account/delete` next to
 * `/account/settings`) never share a shape, so none of them is hidden.
 */
function itemShape(item: InventoryItem): string {
  const state = `${String(item.checked)}/${String(item.disabled)}/${String(item.selected)}/${String(item.inViewport)}`
  if (item.href !== undefined) {
    const path = item.href.replace(/[?#].*$/, '').replace(/\d+/g, '#')
    return `${item.role}|${path}|${textShape(item.name)}|${state}`
  }
  return `${item.role}|${item.name.replace(/\d+/g, '#').toLowerCase()}|${state}`
}

/** A rendered inventory entry: one item, or a collapsed run of similar ones. */
type InventoryEntry = { item: InventoryItem } | { run: InventoryItem[] }

/**
 * Collapse long runs of similar consecutive items (product grids, pagers,
 * repeated "Add to cart" buttons). The first few stay individually
 * addressable; the rest become one summary line naming their index range.
 * @param items - items in render order.
 * @returns entries to render.
 */
export function collapseRuns(items: InventoryItem[]): InventoryEntry[] {
  const entries: InventoryEntry[] = []
  let start = 0
  while (start < items.length) {
    const shape = itemShape(items[start]!)
    let end = start + 1
    while (end < items.length && itemShape(items[end]!) === shape) end += 1
    const run = items.slice(start, end)
    if (run.length >= COLLAPSE_MIN_RUN) {
      for (const item of run.slice(0, COLLAPSE_KEEP)) entries.push({ item })
      entries.push({ run: run.slice(COLLAPSE_KEEP) })
    } else {
      for (const item of run) entries.push({ item })
    }
    start = end
  }
  return entries
}

/** 渲染结果的整体预算：主文/清单之外的部分（标题、URL、包装行）也计入。 */
function capRendered(text: string, budgetChars: number): string {
  if (text.length <= budgetChars) return text
  return `${text.slice(0, budgetChars)}…(truncated to the snapshot character budget)`
}

function renderItem(item: InventoryItem): string {
  const state = [
    item.disabled === true ? 'disabled' : undefined,
    item.checked === undefined ? undefined : item.checked ? 'checked' : 'unchecked',
    item.selected === true ? 'selected' : undefined,
    item.expanded === undefined ? undefined : item.expanded ? 'expanded' : 'collapsed',
    item.inViewport ? undefined : 'outside viewport',
  ].filter((value) => value !== undefined).join('/')
  const stateText = state === '' ? '' : ` [${state}]`
  const hrefText = item.href !== undefined ? ` → ${item.href}` : ''
  return `  [${item.index}] ${item.role} "${item.name}"${stateText}${hrefText}`
}

function renderRun(run: InventoryItem[]): string {
  const first = run[0]!
  const last = run[run.length - 1]!
  const range = run.length === 1 ? `[${first.index}]` : `[${first.index}–${last.index}]`
  const noun = `${first.role}${first.role.endsWith('s') ? 'es' : 's'}`
  return `  ${range} ${run.length} more ${noun} like "${first.name}"${first.href === undefined ? '' : ` → ${first.href}`} (collapsed; snapshot with collapse=false lists them)`
}

function renderItems(lines: string[], items: InventoryItem[], collapse: boolean): void {
  if (!collapse) {
    for (const item of items) lines.push(renderItem(item))
    return
  }
  for (const entry of collapseRuns(items)) lines.push('item' in entry ? renderItem(entry.item) : renderRun(entry.run))
}

function renderForm(form: FormFieldView, includeIdentity: boolean): string {
  const identity = includeIdentity ? `${form.label} (${form.kind}) ` : ''
  const state = form.checked === undefined
    ? `value="${form.masked ? '••••' : form.value}"`
    : `checked=${String(form.checked)}`
  return `  [${form.index}] ${identity}${state}${form.required === true ? ' required' : ''}`
}

function appendTruncationNotes(lines: string[], view: SnapshotView): void {
  const notes: string[] = []
  if (view.truncated.mainChars > 0) notes.push(`Main content truncated by ${view.truncated.mainChars} characters`)
  if (view.truncated.itemsDropped > 0) notes.push(`${view.truncated.itemsDropped} additional elements omitted`)
  if (view.truncated.formsDropped > 0) notes.push(`${view.truncated.formsDropped} additional form fields omitted`)
  if (notes.length > 0) lines.push(`\n(${notes.join('; ')}. Use browser_get_text or specify region for more content.)`)
}

/** Lines of a main-text diff worth rendering before falling back to the full text. */
const MAX_DIFF_LINES = 200

/**
 * Render a snapshot as the model-facing text (the whole snapshot is one text
 * block; no images anywhere).
 * @param view - snapshot to render.
 * @param delta - whether this is a delta render (changes only).
 * @param maxChars - optional render cap for compact derivative responses.
 * @returns the text payload.
 */
export function renderSnapshot(view: SnapshotView, delta: boolean, maxChars: number = view.budgetChars): string {
  const lines: string[] = []
  const showText = view.mode !== 'interactive'
  const showInventory = view.mode !== 'text'
  if (delta) {
    lines.push(`Page change v${view.version} (${view.url})`)
    const elementChanges = view.changed.filter((id) => id !== -1)
    const changedIds = new Set(elementChanges)
    const changedItems = showInventory ? view.items.filter((item) => changedIds.has(item.index)) : []
    const changedForms = showInventory ? view.forms.filter((form) => changedIds.has(form.index)) : []

    lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
    if (view.changed.includes(-1)) {
      lines.push(`Title: ${view.title || '(untitled)'}`)
      const diff = view.mainDiff
      const diffSize = diff === undefined ? 0 : diff.added.length + diff.removed.length
      if (showText && diff !== undefined && diffSize > 0 && diffSize <= MAX_DIFF_LINES) {
        // A line diff keeps the delta proportional to what changed, not to the page.
        lines.push('')
        lines.push('Main content changes (+ added, - removed):')
        for (const line of diff.removed) lines.push(`- ${line}`)
        for (const line of diff.added) lines.push(`+ ${line}`)
      } else if (showText && view.main.length > 0 && diffSize > 0) {
        lines.push('')
        lines.push('Changed main content:')
        lines.push(view.main)
      }
    }
    if (changedItems.length > 0) {
      lines.push('')
      lines.push('Changed interactive elements:')
      renderItems(lines, changedItems, view.collapse)
    }
    if (changedForms.length > 0) {
      lines.push('')
      lines.push('Changed form fields:')
      const renderedItems = new Set(changedItems.map((item) => item.index))
      for (const form of changedForms) lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
    if (view.removed.length > 0 && showInventory) lines.push(`Removed elements: ${view.removed.join(', ')}`)
    if (view.changed.length === 0 && view.removed.length === 0) lines.push('(No visible changes.)')
    appendTruncationNotes(lines, view)
    return capRendered(lines.join('\n'), maxChars)
  }
  lines.push(`Title: ${view.title || '(untitled)'}`)
  lines.push(`URL: ${view.url}`)
  lines.push(`Status: ${view.ready}${view.reindexed ? ' (element indices were reassigned; use the indices in this snapshot)' : ''}`)
  if (view.viewportOnly) lines.push('Scope: viewport only')
  if (showText && view.main.length > 0) {
    lines.push('')
    lines.push('Main content:')
    lines.push(view.main)
  }
  if (showInventory && view.items.length > 0) {
    lines.push('')
    lines.push('Interactive elements:')
    renderItems(lines, view.items, view.collapse)
  }
  if (showInventory && view.forms.length > 0) {
    lines.push('')
    lines.push('Form fields:')
    const renderedItems = new Set(view.items.map((item) => item.index))
    for (const form of view.forms) {
      lines.push(renderForm(form, !renderedItems.has(form.index)))
    }
  }
  appendTruncationNotes(lines, view)
  return capRendered(lines.join('\n'), maxChars)
}
