/**
 * Content-script side of the Phase 3 learning features. Every handler is
 * driven by the background, which only sends these messages while the
 * matching setting is on:
 *
 * - `DSH_LEARN_DESCRIBE`: a robust locator (role, accessible name, short
 *   text, CSS fallback) for the element an action targets, plus whether the
 *   field is sensitive, so the recorder can drop its value;
 * - `DSH_LEARN_TOKENS`: cookie and CSRF meta-tag values, used by the
 *   background only to *recognize* tokens in a captured request (never stored);
 * - `DSH_LEARN_FIXTURE`: a sanitized DOM snapshot for the failure flywheel
 *   (scripts and handlers removed, sensitive values masked);
 * - `DSH_WATCH` / `DSH_WATCH_PROBE`: "Watch me" recording of the user's own
 *   trusted input events, and the row probe for "do the remaining N";
 * - `DSH_SITE_DRIVER_FETCH`: the approved same-origin request of a site
 *   driver, with tokens read from the page at execution time.
 *
 * @module
 */

import { resolveDriverTokens, type DriverRequest } from 'dsh-browser-agent/src/learning/site-drivers.ts'
import { cssEscape, deepActiveElement, resolveSelectorAll } from './dom.ts'
import { accessibleName, clip } from './extract.ts'
import { roleOfElement, uniqueSelectorFor } from './find.ts'
import type { ElementIds } from './ids.ts'
import { isSensitiveField, maskValue } from './privacy.ts'
import { sha256Hex } from '../security/payload-binding.ts'
import { resolveActionTarget } from './actions.ts'
import { MAX_FINISH_STEPS, parseStepTarget, type StepTarget } from '../shared/repetition.ts'

/** A recorded locator for one element. */
export interface LocatorDescriptor {
  role: string
  name?: string
  text?: string
  css: string
  sensitive: boolean
  password: boolean
}

const LABEL_MAX = 80
const CELL_MAX = 200
const MAX_CELLS = 20
const FIXTURE_MAX_CHARS = 4 * 1024 * 1024
const RESPONSE_MAX_CHARS = 4_000

/** Describe one element as a robust locator. */
export function describeElement(el: Element): LocatorDescriptor {
  const name = clip(accessibleName(el), LABEL_MAX)
  const own = (el.textContent ?? '').replace(/\s+/gu, ' ').trim()
  const sensitive = isSensitiveField(el)
  return {
    role: roleOfElement(el),
    ...(name === '' ? {} : { name }),
    // Short self-descriptive text only; a sensitive field's text is never kept.
    ...(own !== '' && own.length <= 120 && !sensitive ? { text: clip(own, LABEL_MAX) } : {}),
    css: uniqueSelectorFor(el),
    sensitive,
    password: el instanceof HTMLInputElement && el.type === 'password',
  }
}

/** The row an element sits in and the texts of its cells. */
export function rowCells(el: Element): string[] | undefined {
  const row = el.closest('tr, [role="row"], li')
  if (row === null) return undefined
  const cells = [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]')]
  const source = cells.length > 0 ? cells : [...row.children]
  return source.slice(0, MAX_CELLS).map((cell) => isSensitiveField(cell) || cell.querySelector('input[type="password"]') !== null ? '' : clip(cell.textContent ?? '', CELL_MAX))
}

/** Cookie and CSRF-like meta values, for token recognition only. */
export function pageTokens(): { cookies: Array<{ name: string; value: string }>; metas: Array<{ name: string; value: string }> } {
  const cookies = document.cookie.split(';').map((pair) => pair.trim()).filter((pair) => pair.includes('=')).map((pair) => {
    const at = pair.indexOf('=')
    return { name: pair.slice(0, at), value: decodeURIComponent(pair.slice(at + 1)) }
  })
  const metas = [...document.querySelectorAll('meta[name]')]
    .filter((meta) => /csrf|xsrf|token/iu.test(meta.getAttribute('name') ?? ''))
    .map((meta) => ({ name: meta.getAttribute('name')!, value: meta.getAttribute('content') ?? '' }))
  return { cookies, metas }
}

/** Number of sensitive fields on the page (MHTML is used only when 0). */
export function sensitiveFieldCount(): number {
  let count = 0
  for (const el of document.querySelectorAll('input, textarea, select, [contenteditable]')) {
    if (isSensitiveField(el)) count += 1
  }
  return count
}

/** Sensitive fields that currently hold a value (a site driver is not learned then). */
export function filledSensitiveCount(): number {
  let count = 0
  for (const el of document.querySelectorAll('input, textarea')) {
    if ((el as HTMLInputElement).value !== '' && isSensitiveField(el)) count += 1
  }
  return count
}

/**
 * A sanitized copy of the page for a failure fixture: scripts, inline
 * handlers and `javascript:` URLs removed; values of sensitive fields masked;
 * other form values written into attributes so the fixture shows the state.
 */
export function sanitizedDom(): string {
  const live = [...document.querySelectorAll('input, textarea, select')]
  const clone = document.documentElement.cloneNode(true) as HTMLElement
  const copies = [...clone.querySelectorAll('input, textarea, select')]
  live.forEach((field, index) => {
    const copy = copies[index]
    if (copy === undefined) return
    const sensitive = isSensitiveField(field)
    if (field instanceof HTMLInputElement) {
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked) copy.setAttribute('checked', '')
        else copy.removeAttribute('checked')
      } else {
        copy.setAttribute('value', sensitive ? maskValue(field.value) : field.value)
      }
    } else if (field instanceof HTMLTextAreaElement) {
      copy.textContent = sensitive ? maskValue(field.value) : field.value
    } else if (field instanceof HTMLSelectElement && !sensitive) {
      copy.setAttribute('data-dsh-selected', field.value)
    }
    if (sensitive) copy.setAttribute('data-dsh-masked', 'true')
  })
  // Pair live and cloned editing hosts by index before anything is removed
  // from the clone: a selector computed afterwards would point at the wrong node.
  // Descendants of <html> only: the clone's querySelectorAll never matches the
  // clone root, so including a contenteditable <html> would shift every pair.
  const liveEditable = [...document.documentElement.querySelectorAll('[contenteditable]')]
  const copyEditable = [...clone.querySelectorAll('[contenteditable]')]
  liveEditable.forEach((field, index) => {
    const copy = copyEditable[index]
    if (copy === undefined || !isSensitiveField(field)) return
    copy.textContent = maskValue(field.textContent ?? '')
    copy.setAttribute('data-dsh-masked', 'true')
  })
  for (const node of clone.querySelectorAll('script, noscript, iframe[srcdoc], object, embed')) node.remove()
  for (const node of clone.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (/^on/iu.test(attribute.name) || /^\s*javascript:/iu.test(attribute.value)) node.removeAttribute(attribute.name)
    }
  }
  const html = `<!doctype html>\n<!-- dsh-browser fixture: ${location.href.replace(/--/gu, '- -')} -->\n${clone.outerHTML}`
  return html.length > FIXTURE_MAX_CHARS ? html.slice(0, FIXTURE_MAX_CHARS) : html
}

// ---- Watch me ----

let watchHandlers: { click: (event: Event) => void; change: (event: Event) => void } | undefined

function interactiveTarget(el: Element): Element {
  return el.closest('button, a[href], input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], label') ?? el
}

function sendWatchEvent(event: Record<string, unknown>): void {
  void chrome.runtime.sendMessage({ type: 'DSH_WATCH_EVENT', event }).catch(() => {})
}

/** Start or stop recording the user's own input events. */
export function setWatching(enabled: boolean): void {
  if (watchHandlers !== undefined) {
    document.removeEventListener('click', watchHandlers.click, true)
    document.removeEventListener('change', watchHandlers.change, true)
    watchHandlers = undefined
  }
  if (!enabled) return
  const click = (event: Event): void => {
    // Only real user input; scripted clicks (the page's or the extension's synthetic path) are not the user.
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const target = interactiveTarget(event.target)
    // Clicking into a text field is focus, not an action worth repeating.
    if (target instanceof HTMLInputElement && !['button', 'submit', 'checkbox', 'radio', 'reset'].includes(target.type)) return
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
    const cells = rowCells(target)
    sendWatchEvent({ kind: 'click', css: uniqueSelectorFor(target), label: clip(accessibleName(target), LABEL_MAX), tag: target.tagName.toLowerCase(), role: roleOfElement(target), ...(cells === undefined ? {} : { cells }) })
  }
  const change = (event: Event): void => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const target = event.target
    if (target instanceof HTMLInputElement && target.type === 'password') return
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return
    if (target instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'button', 'submit'].includes(target.type)) return
    const sensitive = isSensitiveField(target)
    const cells = rowCells(target)
    sendWatchEvent({
      kind: target instanceof HTMLSelectElement ? 'select' : 'type',
      css: uniqueSelectorFor(target),
      label: clip(accessibleName(target), LABEL_MAX),
      tag: target.tagName.toLowerCase(),
      role: roleOfElement(target),
      ...(sensitive ? { sensitive: true } : { value: target.value.slice(0, 2_000) }),
      ...(cells === undefined ? {} : { cells }),
    })
  }
  watchHandlers = { click, change }
  document.addEventListener('click', click, true)
  document.addEventListener('change', change, true)
}

/**
 * Whether the user can see the element: a hidden template row or a collapsed
 * section is not a row to act on.
 */
function shown(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean }).checkVisibility
  if (typeof check === 'function') return check.call(el, { visibilityProperty: true, checkVisibilityCSS: true })
  // No layout engine (tests): the declared state of the element and its ancestors.
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}

/**
 * Form controls and buttons: what they show is a label or a value, not what
 * the row says. Link text is row text: an id or a name is very often a link.
 */
const FORM_CONTROLS = 'button, input, select, textarea, option, [role="button"], [contenteditable=""], [contenteditable="true"]'
const ROW_IDENTITY_MAX = 120
const ROW_CELLS = ':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]'

/** Tag and classes: two elements with the same ones are built alike. */
function shapeOf(node: Element): string {
  return `${node.tagName} ${[...node.classList].sort().join(' ')}`
}

/** Whether an element has a sibling built like it. */
function hasTwin(node: Element): boolean {
  const parent = node.parentElement
  if (parent === null) return false
  const own = shapeOf(node)
  return [...parent.children].some((sibling) => sibling !== node && shapeOf(sibling) === own)
}

/** The next repeating container above `from`: a table row, an ARIA row, a list item, or a repeated plain element. */
function containerAbove(from: Element): Element | undefined {
  const start = from.parentElement
  if (start === null) return undefined
  const semantic = start.closest('tr, [role="row"], li')
  if (semantic !== null) return semantic
  for (let node: Element | null = start; node !== null && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (!hasTwin(node)) continue
    // A cell among cells built alike (`.row > .cell + .cell`): when what holds it repeats too, that is the row.
    const parent = node.parentElement
    return parent !== null && parent !== document.body && parent !== document.documentElement && hasTwin(parent) ? parent : node
  }
  return undefined
}

/** The cells of a row container (its table or grid cells, else its children) the user can see. */
function cellsOf(container: Element): Element[] {
  const cells = [...container.querySelectorAll(ROW_CELLS)]
  return (cells.length > 0 ? cells : [...container.children]).slice(0, MAX_CELLS).filter(shown)
}

/**
 * The repeating container an element sits in: a table row, an ARIA row, a
 * list item, or else the nearest repeated plain element (a row of a grid
 * built from divs). A container that holds nothing but the element's own cell
 * (a layout table around a button, a cell mistaken for a row) says nothing
 * about the record, so the search goes on above it.
 */
export function rowContainerOf(el: Element): Element | undefined {
  let from: Element = el
  for (let level = 0; level < 6; level += 1) {
    const candidate = containerAbove(from)
    if (candidate === undefined) return undefined
    const elsewhere = cellsOf(candidate).some((cell) => !cell.contains(el) && plainText(cell, el) !== '')
    if (elsewhere || plainText(candidate, el) !== '') return candidate
    from = candidate
  }
  return undefined
}

/**
 * What an element says to the user outside its form controls and buttons,
 * whitespace collapsed: visible text only, and never the step's own element.
 */
function plainText(root: Element, own: Element): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const holder = node.parentElement
    if (holder === null || (node.nodeValue ?? '').trim() === '') continue
    if (own.contains(holder)) continue
    const control = holder.closest(FORM_CONTROLS)
    if (control !== null && root.contains(control)) continue
    // Hidden text (a template, a nonce, a collapsed column) is not what the user approved.
    if (!shown(holder)) continue
    parts.push(node.nodeValue ?? '')
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Which row an element sits in: a short identity for the approval card, the
 * first part of it (the cell an id usually sits in), and a digest of
 * everything the row says. The identity is built from the visible cells
 * other than the element's own: the first with text (an id or a number
 * counts; so does link text) and the first with words. Sensitive cells are
 * masked, as elsewhere. A row that says nothing has no digest.
 */
export function rowIdentityOf(el: Element): { row: string; first: string; rowKey: string } {
  const container = rowContainerOf(el)
  if (container === undefined) return { row: '', first: '', rowKey: '' }
  const cells = cellsOf(container)
  const text = (cell: Element): string => isSensitiveField(cell) || cell.querySelector('input[type="password"]') !== null ? '' : clip(plainText(cell, el), CELL_MAX)
  const texts = cells.map(text)
  const others = cells.map((cell, index) => cell.contains(el) ? '' : texts[index]!).filter((cell) => cell !== '')
  // No other cell says anything: what the row itself says around its controls (a list item "Ada [Archive]").
  const first = others[0] ?? clip(plainText(container, el), CELL_MAX)
  const worded = others.find((cell) => /\p{L}/u.test(cell))
  const row = worded === undefined || worded === first ? first : `${first} · ${worded}`
  return {
    row: clip(row, ROW_IDENTITY_MAX),
    first: clip(first, ROW_IDENTITY_MAX),
    rowKey: texts.every((cell) => cell === '') ? '' : sha256Hex(texts.join('␟')).slice(0, 32),
  }
}

/**
 * What an element looks like and which row it sits in, for "do the remaining
 * N": recorded when the offer is built, shown on the card, and compared again
 * inside the action.
 * @param later - a step after the first of its row. Earlier steps of the row
 *   may have changed what the row says (a status that flips), so such a step
 *   is held only to the row's first text cell, with no digest.
 */
export function stepTargetOf(el: Element, later = false): StepTarget {
  const identity = rowIdentityOf(el)
  return {
    tag: el.tagName.toLowerCase(),
    role: roleOfElement(el),
    name: clip(accessibleName(el), LABEL_MAX),
    row: later ? identity.first : identity.row,
    rowKey: later ? '' : identity.rowKey,
  }
}

/**
 * For each next repetition whose selectors each resolve to exactly one
 * visible element: its row cells and what each step's element looks like.
 * Stops at the first repetition that does not.
 */
export function probeRowTargets(selectors: readonly (readonly string[])[]): { rows: string[][]; targets: StepTarget[][] } {
  const rows: string[][] = []
  const targets: StepTarget[][] = []
  for (const set of selectors) {
    let cells: string[] | undefined
    const row: StepTarget[] = []
    for (const selector of set) {
      let found: Element[]
      try {
        found = resolveSelectorAll(selector)
      } catch {
        return { rows, targets }
      }
      if (found.length !== 1 || !shown(found[0]!)) return { rows, targets }
      cells ??= rowCells(found[0]!) ?? []
      row.push(stepTargetOf(found[0]!, row.length > 0))
    }
    rows.push(cells ?? [])
    targets.push(row)
  }
  return { rows, targets }
}

/** The row cells of {@link probeRowTargets}. */
export function probeRows(selectors: readonly (readonly string[])[]): string[][] {
  return probeRowTargets(selectors).rows
}

/**
 * Whether an element still is what the approval card showed. Only that is
 * compared (tag, role, accessible name, the row's identity, and at a row's
 * first step everything the row says outside its controls): styling, a
 * spinner, a control's own label elsewhere in the row, or changes elsewhere
 * on the page do not matter.
 * @returns the fields that differ (empty: it matches) and what the element is now; `missing` when it is hidden.
 */
export function stepTargetDiffers(el: Element, expected: StepTarget): { differs: string[]; now?: StepTarget } {
  if (!shown(el)) return { differs: ['missing'] }
  // No digest was approved: a step after the first of its row (or a row that says nothing), held to the row's first text cell.
  const later = expected.rowKey === ''
  const now = stepTargetOf(el, later)
  const fields = later ? (['tag', 'role', 'name', 'row'] as const) : (['tag', 'role', 'name', 'row', 'rowKey'] as const)
  return { differs: fields.filter((key) => now[key] !== expected[key]), now }
}

/**
 * The in-action check of a "do the remaining N" step: called with the very
 * element the action resolved, before anything is done to it.
 * @param expected - the step's target as the background sent it (validated here).
 * @param zh - whether to phrase the refusal in Chinese.
 * @throws Error saying, in the user's words, what no longer matches.
 */
export function assertStepTarget(el: Element, expected: unknown, zh: boolean): void {
  const target = parseStepTarget(expected)
  const checked = target === undefined ? { differs: ['missing'] } : stepTargetDiffers(el, target)
  if (checked.differs.length === 0) return
  const quote = (text: string): string => `“${text}”`
  let what: string
  if (target === undefined || checked.now === undefined) {
    what = zh ? '它的元素已不存在或已隐藏' : 'its element is gone or hidden'
  } else {
    // In the words the card used: the label first, then which row it is, then the kind of element.
    const field = (['name', 'row', 'role', 'tag'] as const).find((key) => checked.differs.includes(key))
    what = field === undefined
      ? (zh ? '它所在的行与您批准时相比有变化' : 'something in its row changed since you approved it')
      : zh
        ? `它与您批准的行不再一致（原为 ${quote(target[field])}，现为 ${quote(checked.now[field])}）`
        : `it no longer looks like the rows you approved (was ${quote(target[field])}, now ${quote(checked.now[field])})`
  }
  throw new Error(zh ? `${what}。未对它执行任何操作。` : `${what}. Nothing was done to it.`)
}

// ---- Site driver execution ----

/** Run one approved site-driver request from the page (same origin only). */
export async function siteDriverFetch(request: DriverRequest): Promise<{ status: number; ok: boolean; contentType: string; body: string }> {
  const url = new URL(request.url)
  if (url.origin !== location.origin) throw new Error('A site driver can only call the page\'s own origin.')
  const resolved = resolveDriverTokens(request, (source) => {
    if (source.kind === 'cookie') return pageTokens().cookies.find((cookie) => cookie.name === source.name)?.value
    return document.querySelector(`meta[name="${cssEscape(source.name)}"]`)?.getAttribute('content') ?? undefined
  })
  const response = await fetch(url.href, {
    method: request.method,
    headers: resolved.headers,
    ...(resolved.body === undefined ? {} : { body: resolved.body }),
    credentials: 'same-origin',
    // A redirect would carry the approved request somewhere the card never named.
    redirect: 'error',
  })
  if (new URL(response.url || url.href).origin !== location.origin) throw new Error('The site driver request was redirected to another origin.')
  const text = await response.text()
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') ?? '',
    body: text.length > RESPONSE_MAX_CHARS ? `${text.slice(0, RESPONSE_MAX_CHARS)}…` : text,
  }
}

/**
 * Handle one learning message.
 * @returns true when the response is sent asynchronously, false when sent, undefined when not ours.
 */
export function handleLearningMessage(message: { type?: string } & Record<string, unknown>, ids: ElementIds, sendResponse: (response: unknown) => void): boolean | undefined {
  const fail = (error: unknown): void => { sendResponse({ ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }) }
  switch (message.type) {
    case 'DSH_LEARN_DESCRIBE': {
      try {
        const args = (message.args ?? {}) as Record<string, unknown>
        const el = args.index === undefined && args.selector === undefined ? deepActiveElement() : resolveActionTarget(args, ids)
        if (!(el instanceof Element)) throw new Error('no target element')
        sendResponse({ ok: true, result: describeElement(el) })
      } catch (error: unknown) {
        fail(error)
      }
      return false
    }
    case 'DSH_LEARN_TOKENS':
      sendResponse({ ok: true, result: { ...pageTokens(), filledSensitive: filledSensitiveCount() } })
      return false
    case 'DSH_LEARN_FIXTURE':
      try {
        const count = sensitiveFieldCount()
        sendResponse({ ok: true, result: message.probe === true ? { sensitiveCount: count } : { sensitiveCount: count, html: sanitizedDom(), title: document.title } })
      } catch (error: unknown) {
        fail(error)
      }
      return false
    case 'DSH_WATCH':
      setWatching(message.enabled === true)
      sendResponse({ ok: true })
      return false
    case 'DSH_WATCH_PROBE': {
      const selectors = Array.isArray(message.selectors) ? message.selectors.filter((set): set is string[] => Array.isArray(set) && set.every((s) => typeof s === 'string')) : []
      sendResponse({ ok: true, result: probeRowTargets(selectors.slice(0, MAX_FINISH_STEPS + 1)) })
      return false
    }
    case 'DSH_SITE_DRIVER_FETCH':
      siteDriverFetch(message.request as DriverRequest).then(
        (result) => { sendResponse({ ok: true, result }) },
        fail,
      )
      return true
    default:
      return undefined
  }
}
