/**
 * Page-world (MAIN world) listener shim: tells the content script which
 * elements a script made clickable.
 *
 * A `<div>` that is clickable only because a script called
 * `addEventListener('click', …)`, assigned `el.onclick`, or rendered it from a
 * framework component has nothing in the DOM the isolated world can read. This
 * shim runs in the page's own world at `document_start`, before any page
 * script, and
 *
 * - records which elements receive a click-like listener (a transparent
 *   `Proxy` around `EventTarget.prototype.addEventListener`; only a WeakMap
 *   entry is kept, never the listener), and
 * - on a query from the content script, walks the document and reports the
 *   elements that have such a listener, an `onclick`-style handler property,
 *   or a framework click handler (React props, Vue 3 invokers, Svelte 5 and
 *   Solid delegated handlers).
 *
 * Security: this code shares a world with the page, so the page can read,
 * replace or fake everything in it. It therefore holds no secret, exposes no
 * global, takes no input but a nonce, and its whole output is "element X is
 * click-activated" (see `shared/listener-probe.ts`). A page that lies through
 * it gains nothing it could not get by writing `onclick` on an element.
 *
 * @module
 */

import { ACTIVATION_EVENTS, MAX_REPORTS, NONCE_PATTERN, QUERY_EVENT, REPORT_EVENT_PREFIX } from '../shared/listener-probe.ts'

/** Elements visited per query, so a huge document cannot stall a snapshot. */
const MAX_WALK = 20_000

/**
 * An element listening to more distinct event types than this is an event
 * delegation root (React attaches every event it knows to its container), not
 * a click target.
 */
const MAX_DISTINCT_TYPES = 12

const ACTIVATION = new Set(ACTIVATION_EVENTS)

/** Handler IDL properties (`el.onclick = fn`), invisible to the isolated world. */
const HANDLER_PROPERTIES = ACTIVATION_EVENTS.map((type) => `on${type}`)

/** React prop names for the activation events. */
const REACT_HANDLERS = ['onClick', 'onDoubleClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchStart', 'onTouchEnd']

/** Vue 3 invoker keys: `onClick`, `onClickOnce`, `onPointerdown`, … */
const VUE_INVOKER = /^on(click|dblclick|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend)/i

/** Delegated handler expandos: Svelte 5 (`__click`) and Solid (`$$click`). */
const DELEGATED_KEYS = new Set(ACTIVATION_EVENTS.flatMap((type) => [`__${type}`, `$$${type}`]))

interface ListenerRecord {
  activation: boolean
  types: Set<string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/** Whether a framework stored a click-like handler for this element. */
function hasFrameworkHandler(el: Element): boolean {
  const own = el as unknown as Record<string, unknown>
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
      const props = own[key]
      if (isObject(props) && REACT_HANDLERS.some((name) => typeof props[name] === 'function')) return true
    } else if (key === '_vei') {
      const invokers = own[key]
      if (isObject(invokers) && Object.keys(invokers).some((name) => VUE_INVOKER.test(name) && invokers[name] != null)) return true
    } else if (DELEGATED_KEYS.has(key) && own[key] != null) {
      return true
    }
  }
  return false
}

/**
 * Install the shim into a window.
 * @param win - the page-world window (a jsdom window in tests).
 * @returns a function that removes the shim again (tests only).
 */
export function installListenerShim(win: Window & typeof globalThis): () => void {
  // Natives are captured before any page script can replace them.
  const prototype = win.EventTarget.prototype
  const nativeAdd = prototype.addEventListener
  const nativeDispatch = prototype.dispatchEvent
  const NativeEvent = win.Event
  const NativeElement = win.Element
  const apply = Reflect.apply
  const listeners = new WeakMap<Element, ListenerRecord>()

  const record = (target: unknown, type: unknown, listener: unknown): void => {
    if (typeof type !== 'string' || listener === null || listener === undefined) return
    if (!(target instanceof NativeElement)) return
    let entry = listeners.get(target)
    if (entry === undefined) {
      entry = { activation: false, types: new Set() }
      listeners.set(target, entry)
    }
    if (entry.types.size <= MAX_DISTINCT_TYPES) entry.types.add(type)
    if (ACTIVATION.has(type)) entry.activation = true
  }

  const isActivated = (el: Element): boolean => {
    const entry = listeners.get(el)
    if (entry !== undefined && entry.activation && entry.types.size <= MAX_DISTINCT_TYPES) return true
    const own = el as unknown as Record<string, unknown>
    for (const property of HANDLER_PROPERTIES) {
      if (typeof own[property] === 'function') return true
    }
    return hasFrameworkHandler(el)
  }

  const onQuery = (event: Event): void => {
    // The page never sees the query: this listener was registered first.
    event.stopImmediatePropagation()
    const nonce: unknown = (event as CustomEvent<unknown>).detail
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return
    const reportType = `${REPORT_EVENT_PREFIX}${nonce}`
    let walked = 0
    let reported = 0
    const visit = (scope: Document | ShadowRoot): void => {
      for (const el of scope.querySelectorAll('*')) {
        walked += 1
        if (walked > MAX_WALK || reported >= MAX_REPORTS) return
        let activated = false
        // Page-defined getters may throw; one bad element must not end the walk.
        try { activated = isActivated(el) } catch { /* skip */ }
        if (activated) {
          reported += 1
          apply(nativeDispatch, el, [new NativeEvent(reportType, { composed: true })])
        }
        const shadow = el.shadowRoot
        if (shadow !== null && shadow !== undefined) visit(shadow)
      }
    }
    try { visit(win.document) } catch { /* a page that broke the walk gets no hints */ }
  }
  // Registered through the still-native method and before any page script, so
  // this listener is first in line for the query.
  win.addEventListener(QUERY_EVENT, onQuery, true)

  // A Proxy keeps the original's `name` and `length` and stringifies as
  // `[native code]`, so the usual "is this built-in patched?" checks still pass.
  // (It is not undetectable: the string loses the function name.)
  prototype.addEventListener = new Proxy(nativeAdd, {
    apply(target, self, args: unknown[]): unknown {
      const result = apply(target, self, args)
      try { record(self, args[0], args[1]) } catch { /* never break the page's call */ }
      return result
    },
  })
  const patchedAdd = prototype.addEventListener

  return () => {
    win.removeEventListener(QUERY_EVENT, onQuery, true)
    if (prototype.addEventListener === patchedAdd) prototype.addEventListener = nativeAdd
  }
}
