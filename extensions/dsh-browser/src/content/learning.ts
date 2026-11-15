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

import { resolveDriverTokens, type DriverRequest } from '@natgurlain/dsh-bridge-browser/src/learning/site-drivers.ts'
import { cssEscape, deepActiveElement, resolveSelectorAll } from './dom.ts'
import { accessibleName, clip } from './extract.ts'
import { roleOfElement, uniqueSelectorFor } from './find.ts'
import type { ElementIds } from './ids.ts'
import { isSensitiveField, maskValue } from './privacy.ts'
import { resolveActionTarget } from './actions.ts'

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
  const liveEditable = [...document.querySelectorAll('[contenteditable]')]
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
    sendWatchEvent({ kind: 'click', css: uniqueSelectorFor(target), label: clip(accessibleName(target), LABEL_MAX), ...(cells === undefined ? {} : { cells }) })
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
      ...(sensitive ? { sensitive: true } : { value: target.value.slice(0, 2_000) }),
      ...(cells === undefined ? {} : { cells }),
    })
  }
  watchHandlers = { click, change }
  document.addEventListener('click', click, true)
  document.addEventListener('change', change, true)
}

/** For each next repetition, whether all its selectors resolve to exactly one element, plus its row cells. */
export function probeRows(selectors: readonly (readonly string[])[]): string[][] {
  const rows: string[][] = []
  for (const set of selectors) {
    let cells: string[] | undefined
    for (const selector of set) {
      let found: Element[]
      try {
        found = resolveSelectorAll(selector)
      } catch {
        return rows
      }
      if (found.length !== 1) return rows
      cells ??= rowCells(found[0]!) ?? []
    }
    rows.push(cells ?? [])
  }
  return rows
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
      sendResponse({ ok: true, result: { rows: probeRows(selectors.slice(0, 100)) } })
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
