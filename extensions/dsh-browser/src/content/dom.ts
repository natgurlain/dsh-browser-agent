/**
 * Shadow-DOM-aware element lookup shared by the snapshot, the locator and
 * every page action.
 *
 * Web components keep their controls inside open shadow roots, where
 * `document.querySelectorAll` never looks. Every content-side lookup goes
 * through this module so an element the snapshot lists can also be addressed
 * by the actions.
 *
 * Selectors may pierce shadow boundaries with ` >>> `: `my-card >>> button`
 * finds `my-card` in the document, then `button` inside its open shadow root.
 * A selector without the combinator first matches the light DOM and then
 * falls back to open shadow roots.
 *
 * Closed shadow roots stay out of reach by design.
 *
 * @module
 */

/** Combinator that steps from a shadow host into its open shadow root. */
export const SHADOW_PIERCE = '>>>'

/** Upper bound on elements visited while discovering shadow roots. */
const MAX_SHADOW_SCAN = 50_000

type Scope = Document | Element | ShadowRoot

/**
 * Open shadow roots under a scope (recursively, document order).
 * @param scope - where to start.
 * @returns every reachable open shadow root.
 */
export function openShadowRoots(scope: Scope): ShadowRoot[] {
  const roots: ShadowRoot[] = []
  let scanned = 0
  const visit = (current: Scope): void => {
    for (const el of current.querySelectorAll('*')) {
      scanned += 1
      if (scanned > MAX_SHADOW_SCAN) return
      const shadow = el.shadowRoot
      if (shadow !== null && shadow !== undefined) {
        roots.push(shadow)
        visit(shadow)
      }
    }
  }
  if (scope instanceof Element && scope.shadowRoot !== null) {
    roots.push(scope.shadowRoot)
    visit(scope.shadowRoot)
  }
  visit(scope)
  return roots
}

/**
 * `querySelectorAll` that also searches open shadow roots.
 * @param scope - document, element or shadow root to search.
 * @param selector - a plain CSS selector (no piercing combinator).
 * @returns matches, light DOM first, then each shadow root in discovery order.
 */
export function querySelectorAllDeep(scope: Scope, selector: string): Element[] {
  const result: Element[] = [...scope.querySelectorAll(selector)]
  for (const root of openShadowRoots(scope)) result.push(...root.querySelectorAll(selector))
  return result
}

/**
 * Split a piercing selector into its per-scope segments: `>>>` counts only at
 * bracket/paren depth 0 and outside quoted strings (attribute values may contain it).
 */
function segments(selector: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '[' || char === '(') depth += 1
    else if ((char === ']' || char === ')') && depth > 0) depth -= 1
    else if (depth === 0 && selector.startsWith(SHADOW_PIERCE, index)) {
      parts.push(selector.slice(start, index))
      index += SHADOW_PIERCE.length - 1
      start = index + 1
    }
  }
  parts.push(selector.slice(start))
  return parts.map((part) => part.trim())
}

/**
 * Resolve a selector to every matching element, piercing shadow roots.
 *
 * With ` >>> ` each segment is resolved inside the open shadow roots of the
 * previous segment's matches; without it the whole tree is searched.
 *
 * @param selector - CSS selector, optionally with ` >>> ` segments.
 * @param scope - where to start; defaults to the document.
 * @returns all matches (deduplicated, in discovery order).
 * @throws SyntaxError when a segment is not a valid selector.
 */
export function resolveSelectorAll(selector: string, scope: Scope = document): Element[] {
  const parts = segments(selector)
  if (parts.some((part) => part === '')) throw new SyntaxError(`Invalid selector: ${selector}`)
  if (parts.length === 1) return querySelectorAllDeep(scope, parts[0])
  let scopes: Scope[] = [scope]
  let matches: Element[] = []
  for (const [position, part] of parts.entries()) {
    matches = []
    // The first segment may itself live in a shadow root; later segments start
    // at an explicit shadow root and match inside it.
    for (const current of scopes) {
      matches.push(...(position === 0 ? querySelectorAllDeep(current, part) : current.querySelectorAll(part)))
    }
    if (position < parts.length - 1) {
      scopes = matches.map((el) => el.shadowRoot).filter((root): root is ShadowRoot => root !== null)
    }
  }
  return [...new Set(matches)]
}

/**
 * Resolve a selector to its first match, piercing shadow roots.
 * @param selector - CSS selector, optionally with ` >>> ` segments.
 * @param scope - where to start; defaults to the document.
 * @returns the first match, or null.
 * @throws SyntaxError when the selector is invalid.
 */
export function resolveSelector(selector: string, scope: Scope = document): Element | null {
  const parts = segments(selector)
  if (parts.length === 1) {
    const light = scope.querySelector(parts[0]!)
    if (light !== null) return light
    for (const root of openShadowRoots(scope)) {
      const found = root.querySelector(parts[0]!)
      if (found !== null) return found
    }
    return null
  }
  return resolveSelectorAll(selector, scope)[0] ?? null
}

/**
 * The element that really has focus, descending through open shadow roots.
 * @returns the innermost focused element, or null.
 */
export function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement
  while (active?.shadowRoot?.activeElement !== null && active?.shadowRoot?.activeElement !== undefined) {
    active = active.shadowRoot.activeElement
  }
  return active
}

/**
 * The parent across a shadow boundary: the shadow host for a shadow root's
 * top-level child.
 * @param el - element.
 * @returns the composed-tree parent element, or null at the document root.
 */
export function composedParent(el: Element): Element | null {
  if (el.parentElement !== null) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}
