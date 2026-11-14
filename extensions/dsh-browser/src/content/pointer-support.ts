/**
 * Content-script half of pointer input: measuring and hit-testing a target,
 * handing it to the debugger (through an isolated-world registry, never a DOM
 * marker the page could observe), watching whether a click had any effect,
 * and the synthetic hover/drag fallbacks for browsers without the debugger.
 *
 * Internal plumbing only: results are structured data for the background,
 * never model-facing text (descriptions of covering elements are built from
 * tag/id/class/role, clipped).
 *
 * @module
 */

import {
  POINTER_REGISTRY_GLOBAL,
  type ElementPoint,
  type MeasuredTarget,
  type PointerEnd,
  type PointerRegistry,
  type SyntheticDragRequest,
  type WatchReport,
} from '../shared/input-setup.ts'
import { ActionError, resolveActionTarget } from './actions.ts'
import type { ElementIds } from './ids.ts'

/**
 * Elements handed to the debugger, by one-time token. Kept in the content
 * script's isolated world only: a DOM attribute would tell the page exactly
 * when (and on which element) trusted input is about to land.
 */
const pointerTargets = new Map<string, Element>()
/** Bound on outstanding tokens (each is cleared after its gesture). */
const MAX_POINTER_TARGETS = 32

/** Activation semantics that make a blind retry unsafe (double toggle/submit). */
function activationOf(el: Element): MeasuredTarget['activation'] {
  const tag = el.tagName.toLowerCase()
  if (tag === 'a' && el.hasAttribute('href')) return 'link'
  if (tag === 'label' || tag === 'summary' || tag === 'details' || tag === 'option') return 'toggle'
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return 'toggle'
    if (el.type === 'submit' || el.type === 'image' || el.type === 'reset') return 'submit'
    return 'field'
  }
  // A native button runs its handlers for synthetic clicks too: no visible
  // change usually means a script-only effect, so it is never retried.
  if (el instanceof HTMLButtonElement) return (el.type === 'submit' && el.form !== null) || el.type === 'reset' ? 'submit' : 'control'
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return 'field'
  if (el.closest('form') !== null) return 'submit'
  if (el instanceof HTMLElement && el.isContentEditable) return 'field'
  const role = el.getAttribute('role')
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'tab' || role === 'option') return 'toggle'
  return 'other'
}

/** Strip a page string to a short, inert token for a description. */
function inert(value: string, max: number): string {
  const cleaned = value.replace(/[^\w\- .:#]/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`
}

/** `<div id="overlay" class="modal backdrop" role="dialog">`, clipped. */
export function describeElement(el: Element): string {
  // Custom element names are page-controlled and unbounded.
  const parts = [inert(el.tagName.toLowerCase(), 40)]
  if (el.id !== '') parts.push(`id="${inert(el.id, 40)}"`)
  const classes = [...el.classList].slice(0, 3).map((name) => inert(name, 30)).filter((name) => name !== '')
  if (classes.length > 0) parts.push(`class="${classes.join(' ')}"`)
  const role = el.getAttribute('role')
  if (role !== null && role !== '') parts.push(`role="${inert(role, 20)}"`)
  return `<${parts.join(' ')}>`
}

/** Whether `node` is `ancestor` or inside it, across shadow roots. */
function composedWithin(ancestor: Node, node: Node): boolean {
  let current: Node | null = node
  while (current !== null) {
    if (current === ancestor) return true
    current = current instanceof ShadowRoot ? current.host : current.parentNode
  }
  return false
}

/**
 * Whether a hit at the aim point reaches the target: the element itself,
 * something inside it, or a label bound to it. An ancestor does not count: a
 * click there (pointer-events passthrough) never reaches the target.
 */
function hitReaches(target: Element, hit: Node): boolean {
  if (composedWithin(target, hit)) return true
  const hitElement = hit instanceof Element ? hit : hit.parentElement
  const label = hitElement?.closest('label')
  if (label instanceof HTMLLabelElement && label.control === target) return true
  if (target instanceof HTMLLabelElement && target.control !== null && composedWithin(target.control, hit)) return true
  // Shadow DOM: a hit retargeted to a host that contains the target.
  let node: Node | null = target
  while (node !== null) {
    const root = node.getRootNode()
    if (!(root instanceof ShadowRoot)) break
    if (root.host === hit) return true
    node = root.host
  }
  return false
}

const registry: PointerRegistry = Object.freeze({
  has: (token: string): boolean => pointerTargets.has(token),
  get: (token: string): Element | undefined => pointerTargets.get(token),
  reaches: (token: string, node: Node): boolean => {
    const target = pointerTargets.get(token)
    return target !== undefined && target.isConnected && node instanceof Node && hitReaches(target, node)
  },
})
// Isolated-world global for the debugger's re-hit-test (invisible to the page).
Object.defineProperty(globalThis, POINTER_REGISTRY_GLOBAL, { value: registry, configurable: true, enumerable: false, writable: false })

/** Hit-test the center of `el`; returns a description of the covering element. */
function coveringElement(el: Element, center: ElementPoint): string | undefined {
  const root = el.getRootNode()
  const scope = root instanceof ShadowRoot || root instanceof Document ? root : document
  if (center.x < 0 || center.y < 0 || center.x >= window.innerWidth || center.y >= window.innerHeight) return undefined
  const hit = scope.elementFromPoint(center.x, center.y)
  if (hit === null || hitReaches(el, hit)) return undefined
  return describeElement(hit)
}

/**
 * Where to aim: the center of the largest client rect still inside the
 * viewport. A wrapped inline element's bounding-box center can lie on a
 * sibling; its line boxes cannot.
 */
function aimPoint(el: Element, rect: DOMRect): ElementPoint {
  let best: ElementPoint | undefined
  let bestArea = 0
  const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : []
  for (const box of Array.from(rects)) {
    const left = Math.max(box.left, 0)
    const top = Math.max(box.top, 0)
    const right = Math.min(box.right, window.innerWidth)
    const bottom = Math.min(box.bottom, window.innerHeight)
    const area = right > left && bottom > top ? (right - left) * (bottom - top) : 0
    if (area > bestArea) {
      bestArea = area
      best = { x: (left + right) / 2, y: (top + bottom) / 2 }
    }
  }
  return best ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function measureElement(el: Element, hitTest: boolean, scroll = true): MeasuredTarget {
  if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  const visible = rect.width > 0 && rect.height > 0
  const center = visible ? aimPoint(el, rect) : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  const covered = hitTest && visible ? coveringElement(el, center) : undefined
  return {
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    center,
    visible,
    ...(covered === undefined ? {} : { covered }),
    activation: activationOf(el),
    draggable: el instanceof HTMLElement && el.getAttribute('draggable') === 'true',
    tag: el.tagName.toLowerCase(),
  }
}

/** Measure (and optionally hit-test, mark, and start watching) one target. */
export function measureTarget(
  args: PointerEnd & { mark?: string; hitTest?: boolean; watch?: string; noScroll?: boolean },
  ids: ElementIds,
): MeasuredTarget {
  const el = resolveActionTarget(args as Record<string, unknown>, ids)
  const measured = measureElement(el, args.hitTest === true, args.noScroll !== true)
  if (args.mark !== undefined) {
    const token = args.mark.replace(/[^a-zA-Z0-9-]/g, '')
    if (token === '') throw new ActionError('bad-args', 'pointer token must not be empty.')
    if (pointerTargets.size >= MAX_POINTER_TARGETS) pointerTargets.delete(pointerTargets.keys().next().value!)
    pointerTargets.set(token, el)
  }
  if (args.watch !== undefined) startWatch(args.watch)
  return measured
}

/** Forget an element handed to the debugger. */
export function clearPointerMark(token: string): boolean {
  return pointerTargets.delete(token.replace(/[^a-zA-Z0-9-]/g, ''))
}

// ---- Effect watch: did a click change anything at all? ----

interface Watch {
  token: string
  observer: MutationObserver
  mutations: number
  href: string
  active: Element | null
  scroll: string
  resources: number
  values: string
}

let currentWatch: Watch | undefined

function scrollSignature(): string {
  return `${window.scrollX},${window.scrollY}`
}

function resourceCount(): number {
  try {
    return performance.getEntriesByType('resource').length
  } catch {
    return 0
  }
}

/** Values of form controls, which change without DOM mutations. */
function valueSignature(): string {
  const parts: string[] = []
  for (const element of document.querySelectorAll('input, select, textarea')) {
    if (element instanceof HTMLInputElement) parts.push(element.type === 'checkbox' || element.type === 'radio' ? String(element.checked) : element.value)
    else if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) parts.push(element.value)
    if (parts.length > 500) break
  }
  return parts.join('\u0000')
}

function startWatch(token: string): void {
  currentWatch?.observer.disconnect()
  const watch: Watch = {
    token,
    observer: new MutationObserver((records) => {
      for (const record of records) {
        // Our own bookkeeping attributes are not page effects.
        if (record.type === 'attributes' && record.attributeName?.startsWith('data-dsh-') === true) continue
        watch.mutations += 1
      }
    }),
    mutations: 0,
    href: location.href,
    active: document.activeElement,
    scroll: scrollSignature(),
    resources: resourceCount(),
    values: valueSignature(),
  }
  watch.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  currentWatch = watch
}

/** Stop a watch and report whether the page changed in any observable way. */
export function endWatch(token: string): WatchReport {
  const watch = currentWatch
  if (watch === undefined || watch.token !== token) return { changed: true, reasons: ['watch-lost'] }
  for (const record of watch.observer.takeRecords()) {
    if (record.type === 'attributes' && record.attributeName?.startsWith('data-dsh-') === true) continue
    watch.mutations += 1
  }
  watch.observer.disconnect()
  currentWatch = undefined
  const reasons: string[] = []
  if (watch.mutations > 0) reasons.push('dom')
  if (location.href !== watch.href) reasons.push('url')
  if (document.activeElement !== watch.active) reasons.push('focus')
  if (scrollSignature() !== watch.scroll) reasons.push('scroll')
  if (resourceCount() !== watch.resources) reasons.push('network')
  if (valueSignature() !== watch.values) reasons.push('value')
  return { changed: reasons.length > 0, reasons }
}

// ---- Synthetic fallbacks (no debugger) ----

function mouseInit(point: ElementPoint, buttons: number): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, button: 0, buttons }
}

function pointerInit(point: ElementPoint, buttons: number): PointerEventInit {
  return { ...mouseInit(point, buttons), pointerId: 1, pointerType: 'mouse', isPrimary: true }
}

function firePointer(target: Element, type: string, point: ElementPoint, buttons: number): void {
  if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent(type, pointerInit(point, buttons)))
}

/** Synthetic hover: the pointer and mouse enter/over/move sequence. */
export function syntheticHover(args: PointerEnd, ids: ElementIds): void {
  const el = resolveActionTarget(args as Record<string, unknown>, ids)
  const { center } = measureElement(el, false)
  firePointer(el, 'pointerover', center, 0)
  if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerenter', { ...pointerInit(center, 0), bubbles: false }))
  el.dispatchEvent(new MouseEvent('mouseover', mouseInit(center, 0)))
  el.dispatchEvent(new MouseEvent('mouseenter', { ...mouseInit(center, 0), bubbles: false }))
  firePointer(el, 'pointermove', center, 0)
  el.dispatchEvent(new MouseEvent('mousemove', mouseInit(center, 0)))
}

function interpolate(from: ElementPoint, to: ElementPoint, steps: number): ElementPoint[] {
  return Array.from({ length: steps }, (_, index) => {
    const ratio = (index + 1) / steps
    return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }
  })
}

/** Element under a point, falling back to a known element. */
function elementAt(point: ElementPoint, fallback: Element): Element {
  return document.elementFromPoint(point.x, point.y) ?? fallback
}

/**
 * Synthetic drag. HTML5 sources (`draggable="true"`) get the drag-and-drop
 * event sequence sharing one DataTransfer; anything else gets pointer/mouse
 * down-move-up events at interpolated points.
 */
export function syntheticDrag(request: SyntheticDragRequest, ids: ElementIds): { mode: 'html5' | 'pointer'; dropped: boolean } {
  const source = resolveActionTarget(request.from as Record<string, unknown>, ids)
  const start = measureElement(source, false).center
  let targetElement: Element | undefined
  let end: ElementPoint
  if (request.to !== undefined) {
    targetElement = resolveActionTarget(request.to as Record<string, unknown>, ids)
    end = measureElement(targetElement, false, false).center
  } else if (request.offset !== undefined) {
    end = { x: start.x + request.offset.x, y: start.y + request.offset.y }
  } else {
    throw new ActionError('bad-args', 'browser_drag needs to or toOffset.')
  }
  const steps = Math.max(1, Math.min(60, request.steps))
  const html5 = source instanceof HTMLElement && source.getAttribute('draggable') === 'true'
  if (html5) {
    const data = new DataTransfer()
    const dragInit = (point: ElementPoint): DragEventInit => ({ ...mouseInit(point, 1), dataTransfer: data })
    source.dispatchEvent(new DragEvent('dragstart', dragInit(start)))
    let over: Element | undefined
    for (const point of interpolate(start, end, steps)) {
      const under = elementAt(point, targetElement ?? source)
      if (under !== over) {
        if (over !== undefined) over.dispatchEvent(new DragEvent('dragleave', dragInit(point)))
        under.dispatchEvent(new DragEvent('dragenter', dragInit(point)))
        over = under
      }
      source.dispatchEvent(new DragEvent('drag', dragInit(point)))
      under.dispatchEvent(new DragEvent('dragover', dragInit(point)))
    }
    const dropTarget = targetElement ?? elementAt(end, source)
    const accepted = !dropTarget.dispatchEvent(new DragEvent('drop', dragInit(end)))
    source.dispatchEvent(new DragEvent('dragend', dragInit(end)))
    return { mode: 'html5', dropped: accepted }
  }
  firePointer(source, 'pointerdown', start, 1)
  source.dispatchEvent(new MouseEvent('mousedown', mouseInit(start, 1)))
  for (const point of interpolate(start, end, steps)) {
    const under = elementAt(point, source)
    firePointer(under, 'pointermove', point, 1)
    under.dispatchEvent(new MouseEvent('mousemove', mouseInit(point, 1)))
  }
  const release = targetElement ?? elementAt(end, source)
  firePointer(release, 'pointerup', end, 0)
  release.dispatchEvent(new MouseEvent('mouseup', mouseInit(end, 0)))
  return { mode: 'pointer', dropped: true }
}
