/**
 * Page actions: snapshot, click, type, press, scroll, select, extract,
 * clipboard paste, navigate/back/forward/reload, get_text and wait, executed
 * in the content script against the real page (preserving login state), each
 * returning a short text status. Results of actions that change the page
 * (click, type, press, scroll, select, clipboard) carry a post-action
 * verification report. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All browser action results use structured text, so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { composedParent, deepActiveElement, querySelectorAllDeep, resolveSelector, resolveSelectorAll } from './dom.ts'
import { accessibleName, collectInteractive, isVisible, pageText } from './extract.ts'
import { findElements, LocatorError, parseLocatorQuery, renderFound, roleOfElement } from './find.ts'
import type { ElementIds } from './ids.ts'
import { dispatchPaste } from './paste.ts'
import { isSensitiveField, maskValue } from './privacy.ts'
import { ExtractError, extractRows, parseExtractRequest } from './rows.ts'
import { parseSelectRequest, SelectError, selectOptions } from './select.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
  /** Structured page data (browser_extract rows); the background treats it as untrusted. */
  data?: unknown
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

/** Bumped by the background's kill switch (`DSH_ABORT`); actions started earlier stop. */
let abortGeneration = 0
const abortWakers = new Set<() => void>()

/** Stop every action already running in this frame (waits, scroll and select loops). */
export function abortRunningActions(): void {
  abortGeneration += 1
  for (const wake of [...abortWakers]) wake()
}

function stopIfAborted(ctx: ActionContext): void {
  if (ctx.generation !== undefined && ctx.generation !== abortGeneration) {
    throw new ActionError('action-failed', 'The action was stopped by the user (kill switch).')
  }
}

/** Sleep that ends early, and throws, once the kill switch fires. */
async function pause(ms: number, ctx: ActionContext): Promise<void> {
  stopIfAborted(ctx)
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      abortWakers.delete(done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    abortWakers.add(done)
  })
  stopIfAborted(ctx)
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args' | 'input-unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/**
 * Resolve the element a model action refers to: a stable inventory index or a
 * CSS selector. Exactly one form is allowed; both and neither are caller bugs.
 *
 * @param args - raw tool arguments.
 * @param ids - the frame's element registry.
 * @returns the addressed element.
 */
export function resolveActionTarget(args: Record<string, unknown>, ids: ElementIds): Element {
  const hasIndex = args.index !== undefined
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  if (hasIndex && selector !== undefined) {
    throw new ActionError('bad-args', 'Provide either index or selector, not both.')
  }
  if (!hasIndex && selector === undefined) {
    throw new ActionError('bad-args', 'Provide index or selector.')
  }
  if (hasIndex) return elementOrThrow(ids, numberArg(args, 'index'))
  const found = selectorOrBadArgs(() => resolveSelector(selector as string), 'selector', String(selector))
  if (found === null) {
    throw new ActionError('action-failed', `No element matched selector: ${String(selector)}`)
  }
  return found
}

/**
 * Approval-time probe for browser_type: is the element the text would go into
 * a sensitive field? Resolves the target exactly as the type action does and
 * reports only a boolean, never page content. An unresolvable target counts as
 * sensitive so the approval card fails closed to a masked preview.
 * @param args - the browser_type arguments (frame removed).
 * @param ids - the frame's element registry.
 * @returns whether the typed text should be masked on the approval card.
 */
export function typeTargetIsSensitive(args: Record<string, unknown>, ids: ElementIds): boolean {
  let el: Element | null
  try {
    el = args.index === undefined && args.selector === undefined
      ? deepActiveElement()
      : resolveActionTarget(args, ids)
  } catch {
    return true
  }
  if (!(el instanceof Element)) return true
  // Bind the verdict to this exact element: the type action refuses to write
  // into anything else the same locator resolves to by execution time.
  typeProbes.set(typeTargetKey(args), { target: new WeakRef(el), at: Date.now() })
  return isSensitiveField(el)
}

/** How long an approval-time probe binds its locator (covers a slow approval). */
const TYPE_PROBE_TTL_MS = 15 * 60_000

/** Elements the approval probe judged, by locator; consumed by the type action. */
const typeProbes = new Map<string, { target: WeakRef<Element>; at: number }>()

function typeTargetKey(args: Record<string, unknown>): string {
  return JSON.stringify([args.index ?? null, typeof args.selector === 'string' ? args.selector : null])
}

/**
 * Refuse a browser_type whose locator now resolves to another element than the
 * one its approval card was built for (and masked or unmasked accordingly).
 * @param args - the browser_type arguments.
 * @param el - the element the action is about to write into.
 */
export function assertTypeTargetBound(args: Record<string, unknown>, el: Element): void {
  const key = typeTargetKey(args)
  const probe = typeProbes.get(key)
  typeProbes.delete(key)
  if (probe === undefined || Date.now() - probe.at > TYPE_PROBE_TTL_MS) return
  if (probe.target.deref() !== el) {
    throw new ActionError(
      'action-failed',
      'The browser_type target changed after approval. Call browser_snapshot again before retrying.',
    )
  }
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
  /**
   * Page sharing allows page-authored text in this result even without a
   * snapshot baseline (post-action verification details).
   */
  shareContent?: boolean
  /** Abort generation the action started in (set by {@link runAction}). */
  generation?: number
}

/**
 * Run a selector lookup, turning an unparseable selector into `bad-args`.
 * @param lookup - the resolve call.
 * @param argName - the argument the selector came from, for the message.
 * @param selector - the selector text, for the message.
 */
function selectorOrBadArgs<T>(lookup: () => T, argName: string, selector: string): T {
  try {
    return lookup()
  } catch {
    throw new ActionError('bad-args', `${argName} is not a valid CSS selector: ${selector}`)
  }
}

/** Actions whose result carries a post-action verification report. */
const VERIFIED_ACTIONS = new Set(['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_select', 'browser_clipboard'])

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, context: ActionContext): Promise<ActionResult> {
  const ctx: ActionContext = context.generation === undefined ? { ...context, generation: abortGeneration } : context
  if (!VERIFIED_ACTIONS.has(action)) return runUnverified(action, args, ctx)
  const probe = beginVerification()
  const result = await runUnverified(action, args, ctx)
  return finishVerification(result, probe, action, args, ctx)
}

async function runUnverified(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_select':
      return selectAction(args, ctx)
    case 'browser_extract':
      return extractAction(args)
    case 'browser_clipboard':
      if (args.action !== 'paste') {
        throw new ActionError('bad-args', 'Only clipboard paste runs in the page; clipboard writes are dispatched by the browser background.')
      }
      return clipboardPasteAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  if (args.query !== undefined) {
    try {
      const query = parseLocatorQuery(args.query)
      const found = findElements(query)
      return { text: renderFound(found, query, (el) => ctx.ids.indexOf(el)) }
    } catch (error: unknown) {
      if (error instanceof LocatorError) throw new ActionError('bad-args', error.message)
      throw error instanceof Error ? error : new ActionError('action-failed', String(error))
    }
  }
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // A region that matches nothing must not look like an empty page.
  let regionMiss = false
  if (region !== undefined) {
    regionMiss = selectorOrBadArgs(() => resolveSelector(region), 'region', region) === null
  }
  const mode = args.mode === undefined ? 'full' : args.mode
  if (mode !== 'full' && mode !== 'interactive' && mode !== 'text') {
    throw new ActionError('bad-args', 'mode must be full, interactive, or text.')
  }
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, {
    delta,
    region,
    budget: ctx.budget,
    mode,
    viewportOnly: args.viewportOnly === true,
    collapse: args.collapse !== false,
  }, lastSnapshot)
  lastSnapshot = view
  const rendered = renderSnapshot(view, delta)
  return {
    text: regionMiss
      ? `No element matched region selector "${region}"; showing the whole page.\n${rendered}`
      : rendered,
  }
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
  }
}

/** A short, model-facing description of the addressed element. */
function targetLabel(args: Record<string, unknown>, el: Element): string {
  // Selector- and focus-targeted calls have no index at all; reading through
  // `numberArg` here used to throw before the action even ran.
  const index = args.index
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) return `[${index}]`
  const selector = typeof args.selector === 'string' ? args.selector : ''
  return `${el.tagName.toLowerCase()} (${selector})`
}

/**
 * Dispatch the full pointer/mouse sequence at an element's center.
 *
 * Menus and custom controls bind `pointerdown`/`mousedown` rather than only
 * `click`; a bare `el.click()` leaves them inert. Clicking with a synthetic
 * `MouseEvent` still runs the browser's activation behavior for buttons,
 * checkboxes and labels.
 *
 * @param el - target element.
 * @param clicks - 1, 2, or 3 clicks; 2 also emits `dblclick`.
 */
function dispatchPointerClick(el: Element, clicks: number, button: number, modifiers: readonly string[]): void {
  const rect = el.getBoundingClientRect()
  const clientX = rect.left + rect.width / 2
  const clientY = rect.top + rect.height / 2
  const base = {
    bubbles: true, cancelable: true, composed: true, clientX, clientY, button,
    altKey: modifiers.includes('Alt'), ctrlKey: modifiers.includes('Control'),
    metaKey: modifiers.includes('Meta'), shiftKey: modifiers.includes('Shift'),
  }
  const buttons = button === 0 ? 1 : button === 1 ? 4 : 2
  for (let count = 1; count <= clicks; count += 1) {
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerdown', {
        ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons,
      }))
    }
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons, detail: count }))
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerup', {
        ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0,
      }))
    }
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, detail: count }))
    if (button === 2) el.dispatchEvent(new MouseEvent('contextmenu', { ...base, buttons: 0, detail: count }))
    el.dispatchEvent(new MouseEvent(button === 0 ? 'click' : 'auxclick', { ...base, buttons: 0, detail: count }))
  }
  if (clicks >= 2 && button === 0) el.dispatchEvent(new MouseEvent('dblclick', { ...base, buttons: 0, detail: 2 }))
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const action = args.action
  if (action !== undefined && action !== 'click' && action !== 'dblclick') {
    throw new ActionError(
      'bad-args',
      'action must be click or dblclick.',
    )
  }
  const el = resolveActionTarget(args, ctx.ids)
  const label = targetLabel(args, el)
  if (el.matches(':disabled') || el.closest('button:disabled') !== null) {
    throw new ActionError('action-failed', `Element ${label} is disabled.`)
  }
  const buttonName = args.button ?? 'left'
  if (buttonName !== 'left' && buttonName !== 'middle' && buttonName !== 'right') {
    throw new ActionError('bad-args', 'button must be left, middle, or right.')
  }
  const button = buttonName === 'left' ? 0 : buttonName === 'middle' ? 1 : 2
  const modifiers = args.modifiers ?? []
  if (!Array.isArray(modifiers) || modifiers.some(value => typeof value !== 'string' || !PRESS_MODIFIERS.has(value))) {
    throw new ActionError('bad-args', 'modifiers must be a list of Alt, Control, Meta, or Shift.')
  }
  const clicks = action === 'dblclick' ? 2 : args.clicks === undefined ? 1 : numberArg(args, 'clicks')
  if (clicks < 1 || clicks > 3) {
    throw new ActionError('bad-args', 'clicks must be 1, 2, or 3.')
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement && clicks === 1 && button === 0 && modifiers.length === 0) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link ${label} using native browser activation. Call browser_snapshot to read the resulting state.`,
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${label}.`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link ${label}.`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link ${label}. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link ${label}. The link may open outside the controlled frame.` }
  }
  dispatchPointerClick(el, clicks, button, modifiers)
  // An untrusted click runs no focus default action; text fields and editors
  // still expect a click to place the caret, which the next type/press relies on.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable)) {
    el.focus()
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked ${label}.`, ctx)
}

/**
 * The nearest editable host, or null when a `contenteditable="false"` island
 * blocks editing.
 *
 * The walk must stop at the nearest `[contenteditable]` boundary instead of
 * skipping disabled ones: an element inside a non-editable island nested in an
 * editable composer belongs to the island, and resolving past it would type
 * into the surrounding composer rather than refusing the target.
 *
 * @param el - element addressed by the action.
 * @returns the owning editable host, or null when editing is blocked.
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * Whether the element can receive rich-text input.
 *
 * `isContentEditable` is the browser's own answer; the boundary walk covers the
 * attribute case, which is unimplemented in jsdom, where these tests run.
 *
 * @param el - element addressed by the action.
 * @returns true when the element can receive rich-text input.
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` is deprecated but remains the only path that
 * produces the `beforeinput`/`input` sequence those editors listen for. Hosts
 * without it keep the direct-write fallback.
 *
 * @param el - element addressed by the action.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean, insert: boolean): void {
  // `isEditable` already refused a disabled island, so a null host here means
  // the element is editable without the attribute; address it directly.
  const host = editingHost(el) ?? el
  host.focus()
  const selection = host.ownerDocument.getSelection()
  const selectionInside = selection !== null && selection.rangeCount > 0
    && host.contains(selection.anchorNode) && host.contains(selection.focusNode)
  if (selection !== null && (replace || !insert || !selectionInside)) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // A caret collapsed to the end appends; a full selection is replaced by insertText.
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return
    } catch {
      // Fall through to the direct-write path below.
    }
  }
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const mode = args.mode
  if (mode !== undefined && mode !== 'auto' && mode !== 'insert') {
    throw new ActionError(
      'input-unavailable',
      `type mode "${String(mode)}" needs the trusted input channel, which the browser routes through its debugger.`,
    )
  }
  const replace = args.replace === true
  const focusedOnly = args.index === undefined && args.selector === undefined
  const el = focusedOnly ? deepActiveElement() : resolveActionTarget(args, ctx.ids)
  if (!(el instanceof Element)) {
    throw new ActionError('action-failed', 'No element has focus; click the target first or pass index or selector.')
  }
  assertTypeTargetBound(args, el)
  const label = focusedOnly ? 'the focused element' : targetLabel(args, el)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (mode === 'insert' && !replace) {
      const start = el.selectionStart
      const end = el.selectionEnd
      if (start === null || end === null) throw new ActionError('action-failed', 'This input does not expose a text selection.')
      setNativeValue(el, `${el.value.slice(0, start)}${text}${el.value.slice(end)}`)
      el.setSelectionRange(start + text.length, start + text.length)
    } else {
      setNativeValue(el, replace ? text : `${el.value}${text}`)
    }
  } else if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace, mode === 'insert')
  } else {
    throw new ActionError('action-failed', `Element ${label} is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into ${label}.`, ctx)
}

/** Wire modifier names accepted by `browser_press`. */
const PRESS_MODIFIERS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new ActionError('bad-args', 'key must not be empty.')
  const action = args.action === 'down' || args.action === 'up' ? args.action : 'press'
  if (args.action !== undefined && args.action !== 'press' && action !== args.action) {
    throw new ActionError('bad-args', `action must be "press", "down", or "up"; received "${String(args.action)}".`)
  }
  const repeat = args.repeat === undefined ? 1 : args.repeat
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
    throw new ActionError('bad-args', 'repeat must be an integer between 1 and 100.')
  }
  const modifiers: string[] = []
  if (Array.isArray(args.modifiers)) {
    for (const value of args.modifiers) {
      if (typeof value !== 'string' || !PRESS_MODIFIERS.has(value)) {
        throw new ActionError('bad-args', 'modifiers must be a list of Alt, Control, Meta, or Shift.')
      }
      modifiers.push(value)
    }
  }
  if (args.index !== undefined || args.selector !== undefined) {
    const el = resolveActionTarget(args, ctx.ids)
    if (el instanceof HTMLElement) el.focus()
  }
  const active = deepActiveElement()
  const target = active instanceof HTMLElement ? active : document.body
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    altKey: modifiers.includes('Alt'),
    ctrlKey: modifiers.includes('Control'),
    metaKey: modifiers.includes('Meta'),
    shiftKey: modifiers.includes('Shift'),
  }
  for (let count = 0; count < repeat; count += 1) {
    if (action !== 'up') target.dispatchEvent(new KeyboardEvent('keydown', init))
    if (action !== 'down') target.dispatchEvent(new KeyboardEvent('keyup', init))
  }
  if (key === 'Enter' && action !== 'up' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  const chord = modifiers.length === 0 ? key : `${modifiers.join('+')}+${key}`
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${chord}"${repeat > 1 ? ` ×${repeat}` : ''}.`, ctx)
}

/**
 * Dispatch a paste event carrying text and optional sanitized HTML.
 *
 * The page's own paste handler consumes the event; no system clipboard is
 * touched, so this works in every supported browser and never overwrites what
 * the user has copied.
 */
async function clipboardPasteAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty when pasting.')
  const html = typeof args.html === 'string' && args.html !== '' ? args.html : undefined
  const focusedOnly = args.index === undefined && args.selector === undefined
  const el = focusedOnly ? deepActiveElement() : resolveActionTarget(args, ctx.ids)
  if (!(el instanceof Element)) {
    throw new ActionError('action-failed', 'No element has focus; click the paste target first or pass index or selector.')
  }
  if (el instanceof HTMLElement) el.focus()
  const accepted = dispatchPaste(el, { text, ...(html === undefined ? {} : { html }) })
  const label = focusedOnly ? 'the focused element' : targetLabel(args, el)
  // Plain form controls have no paste handler and an untrusted paste event has
  // no default insertion; fall back to a caret insertion so the intent lands.
  let fallback = false
  if (!accepted && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    setNativeValue(el, `${el.value.slice(0, start)}${text}${el.value.slice(end)}`)
    fallback = true
  }
  await waitForPageSettled(TYPE_SETTLE)
  const detail = html === undefined ? 'text' : 'text+html'
  const note = accepted
    ? ''
    : fallback
      ? '; the page did not consume the paste event, so the text was inserted at the caret'
      : '; the page did not consume the paste event'
  return withPageDelta(`Pasted ${text.length} characters (${detail}) into ${label}${note}.`, ctx)
}

/** What a scroll moves: the window, or one scrollable element. */
interface ScrollTarget {
  element: Element | null
  label: string
  top: () => number
  height: () => number
  viewport: () => number
  scrollTo: (top: number) => void
}

function windowScrollTarget(): ScrollTarget {
  return {
    element: null,
    label: 'the page',
    top: () => window.scrollY,
    height: () => document.documentElement.scrollHeight,
    viewport: () => window.innerHeight,
    scrollTo: (top) => { window.scrollTo({ top, behavior: 'instant' }) },
  }
}

/** Whether an element scrolls its own content vertically. */
function isScrollable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el === document.scrollingElement || el === document.body || el === document.documentElement) return false
  const overflow = getComputedStyle(el).overflowY
  return (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && el.scrollHeight > el.clientHeight + 1
}

/**
 * The nearest scrollable ancestor-or-self of an element (across shadow
 * boundaries), or the window when nothing between it and the root scrolls.
 */
function scrollTargetFor(el: Element, label: string): ScrollTarget {
  for (let node: Element | null = el; node !== null; node = composedParent(node)) {
    if (!isScrollable(node)) continue
    const container = node as HTMLElement
    return {
      element: container,
      label: node === el ? label : `the scrollable container of ${label}`,
      top: () => container.scrollTop,
      height: () => container.scrollHeight,
      viewport: () => container.clientHeight,
      scrollTo: (top) => { container.scrollTo({ top, behavior: 'instant' }) },
    }
  }
  return { ...windowScrollTarget(), label: `the page (no scrollable container around ${label})` }
}

/** Upper bounds for infinite-scroll mode, well below the tool timeout. */
const MAX_SCROLL_ROUNDS = 30
const DEFAULT_SCROLL_ROUNDS = 10
const SCROLL_ROUND_GROWTH_WAIT_MS = 2_500
const SCROLL_TOTAL_BUDGET_MS = 25_000

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
    throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  const targeted = args.index !== undefined || (typeof args.selector === 'string' && args.selector !== '')
  const target = targeted
    ? (() => { const el = resolveActionTarget(args, ctx.ids); return scrollTargetFor(el, targetLabel(args, el)) })()
    : windowScrollTarget()
  const infinite = args.untilItems !== undefined || args.maxRounds !== undefined
  if (infinite) return infiniteScroll(args, target, ctx)
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(target.viewport() * 0.8)
  switch (direction) {
    case 'top': target.scrollTo(0); break
    case 'bottom': target.scrollTo(target.height()); break
    case 'up': target.scrollTo(target.top() - amount); break
    default: target.scrollTo(target.top() + amount); break
  }
  await waitForPageSettled(SCROLL_SETTLE)
  const position = `scroll position ${Math.round(target.top())} of ${Math.max(0, Math.round(target.height() - target.viewport()))}`
  const label = targeted ? ` ${target.label}` : ''
  return withPageDelta(`Scrolled${label} ${direction} (${position}).`, ctx)
}

/**
 * Infinite-scroll mode: scroll to the bottom repeatedly until enough items
 * exist, the content stops growing, or the round budget runs out.
 */
async function infiniteScroll(args: Record<string, unknown>, target: ScrollTarget, ctx: ActionContext): Promise<ActionResult> {
  const untilItems = args.untilItems === undefined ? undefined : numberArg(args, 'untilItems')
  const maxRounds = Math.min(MAX_SCROLL_ROUNDS, args.maxRounds === undefined ? DEFAULT_SCROLL_ROUNDS : numberArg(args, 'maxRounds'))
  const itemSelector = typeof args.itemSelector === 'string' && args.itemSelector !== '' ? args.itemSelector : undefined
  const scope = target.element ?? document
  const countItems = (): number => {
    if (itemSelector === undefined) return collectInteractive(scope).length
    return selectorOrBadArgs(() => resolveSelectorAll(itemSelector, scope), 'itemSelector', itemSelector).length
  }
  const startedAt = performance.now()
  const initial = countItems()
  let items = initial
  let rounds = 0
  let reason = `reached maxRounds=${maxRounds}`
  while (rounds < maxRounds) {
    if (untilItems !== undefined && items >= untilItems) {
      reason = `reached ${untilItems} items`
      break
    }
    if (performance.now() - startedAt > SCROLL_TOTAL_BUDGET_MS) {
      reason = 'time budget used up'
      break
    }
    rounds += 1
    const heightBefore = target.height()
    target.scrollTo(target.height())
    // Loaders fetch after the scroll event; wait for growth, then for quiet.
    const deadline = performance.now() + SCROLL_ROUND_GROWTH_WAIT_MS
    let grew = false
    while (performance.now() < deadline) {
      await pause(100, ctx)
      if (countItems() > items || target.height() > heightBefore) {
        grew = true
        break
      }
    }
    await waitForPageSettled(SCROLL_SETTLE)
    stopIfAborted(ctx)
    const now = countItems()
    if (!grew && now <= items) {
      reason = 'no new items appeared'
      items = now
      break
    }
    items = now
  }
  if (untilItems !== undefined && items >= untilItems) reason = `reached ${untilItems} items`
  const counted = itemSelector === undefined ? 'interactive elements' : `"${itemSelector}" items`
  return withPageDelta(
    `Scrolled ${target.label} to the bottom ${rounds} time(s): ${counted} ${initial} → ${items} (stopped: ${reason}).`,
    ctx,
  )
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  let source: Element | null = null
  if (selector !== undefined) {
    source = selectorOrBadArgs(() => resolveSelector(selector), 'selector', selector)
  }
  if (source === null && selector !== undefined) return { text: `No element matched selector: ${selector}` }
  const offset = args.offset === undefined ? 0 : numberArg(args, 'offset')
  const text = pageText(source)
  if (offset > 0 && offset >= text.length) {
    return { text: `(offset ${offset} is past the end; the text has ${text.length} characters.)` }
  }
  const end = Math.min(text.length, offset + GET_TEXT_CHUNK_CHARS)
  const chunk = text.slice(offset, end)
  if (offset === 0 && end === text.length) return { text: chunk }
  const more = end < text.length ? ` Call again with offset=${end} for more.` : ''
  return { text: `${chunk}\n(Characters ${offset}–${end} of ${text.length}.${more})` }
}

/** Characters one browser_get_text call returns. */
const GET_TEXT_CHUNK_CHARS = 8_000

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const conditions = parseWaitConditions(args)
  if (conditions !== undefined) return conditionalWait(conditions, ctx)
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await pause(ms, ctx)
  return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
}

/** Conditions a browser_wait call can wait for inside the page. */
export interface WaitConditions {
  text?: string
  selector?: string
  /** Wait for the text/selector to disappear instead of appear. */
  gone: boolean
  networkIdle: boolean
  timeoutMs: number
  /**
   * browser_run value guard: the first field matching `selector` holds exactly
   * this value. Only pass/fail leaves the page; sensitive fields are refused.
   */
  valueEquals?: string
}

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000
export const MAX_WAIT_TIMEOUT_MS = 25_000
/** Quiet window for the resource-timing network-idle heuristic. */
const NETWORK_IDLE_MS = 500
const WAIT_POLL_MS = 100

/** Parse the conditional form of browser_wait; undefined keeps the plain settle. */
export function parseWaitConditions(args: Record<string, unknown>): WaitConditions | undefined {
  const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const networkIdle = args.networkIdle === true
  const valueEquals = typeof args.valueEquals === 'string' ? args.valueEquals : undefined
  if (valueEquals !== undefined && (selector === undefined || args.gone === true)) {
    throw new ActionError('bad-args', 'valueEquals needs a selector and cannot be combined with gone.')
  }
  if (text === undefined && selector === undefined && !networkIdle) {
    if (args.gone === true) throw new ActionError('bad-args', 'gone needs text or selector.')
    return undefined
  }
  const timeoutRaw = args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  if (typeof timeoutRaw !== 'number' || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
    throw new ActionError('bad-args', 'timeoutMs must be a positive number of milliseconds.')
  }
  return {
    ...text === undefined ? {} : { text },
    ...selector === undefined ? {} : { selector },
    gone: args.gone === true,
    networkIdle,
    timeoutMs: Math.min(timeoutRaw, MAX_WAIT_TIMEOUT_MS),
    ...valueEquals === undefined ? {} : { valueEquals },
  }
}

/** Current value of a form field or editable element; undefined for anything else. */
function fieldValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText
  return undefined
}

/**
 * Whether the first field matching the selector holds `expected`. A sensitive
 * field (password, one-time code, payment data) is refused outright so a
 * guard can never be used to test guesses against it.
 */
function valueMatches(selector: string, expected: string): boolean {
  const matches = selectorOrBadArgs(() => resolveSelectorAll(selector), 'selector', selector)
  const field = matches[0]
  if (field === undefined) return false
  if (isSensitiveField(field)) throw new ActionError('action-failed', 'A value guard cannot read a sensitive field.')
  return fieldValue(field) === expected
}

/** Visible elements matching a selector (piercing open shadow roots). */
function visibleMatches(selector: string): Element[] {
  const matches = selectorOrBadArgs(() => resolveSelectorAll(selector), 'selector', selector)
  return matches.filter((el) => isVisible(el) || (!(el instanceof HTMLElement) && el.getBoundingClientRect().width > 0))
}

/**
 * Network-idle heuristic without the webRequest permission: the document is
 * complete and no resource finished loading for {@link NETWORK_IDLE_MS}. It
 * cannot see requests that are still in flight with nothing finished yet.
 */
function networkQuietSince(): number {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const lastEnd = entries.reduce((latest, entry) => Math.max(latest, entry.responseEnd || entry.startTime), 0)
  return performance.now() - lastEnd
}

async function conditionalWait(conditions: WaitConditions, ctx: ActionContext): Promise<ActionResult> {
  if (conditions.selector !== undefined) visibleMatches(conditions.selector) // validate before waiting
  const startedAt = performance.now()
  const describe = (): string[] => {
    const parts: string[] = []
    if (conditions.text !== undefined) parts.push(`text "${conditions.text}" ${conditions.gone ? 'gone' : 'present'}`)
    if (conditions.selector !== undefined) parts.push(conditions.valueEquals !== undefined ? `field ${conditions.selector} holds the expected value` : `selector ${conditions.selector} ${conditions.gone ? 'gone' : 'visible'}`)
    if (conditions.networkIdle) parts.push('network idle')
    return parts
  }
  const unmet = (): string[] => {
    const missing: string[] = []
    if (conditions.text !== undefined) {
      const present = pageText().toLowerCase().includes(conditions.text.toLowerCase())
      if (present === conditions.gone) missing.push(`text "${conditions.text}" ${conditions.gone ? 'is still present' : 'did not appear'}`)
    }
    if (conditions.selector !== undefined && conditions.valueEquals !== undefined) {
      if (!valueMatches(conditions.selector, conditions.valueEquals)) missing.push(`field ${conditions.selector} does not hold the expected value`)
    } else if (conditions.selector !== undefined) {
      const present = visibleMatches(conditions.selector).length > 0
      if (present === conditions.gone) missing.push(`selector ${conditions.selector} ${conditions.gone ? 'is still visible' : 'did not become visible'}`)
    }
    if (conditions.networkIdle && (document.readyState !== 'complete' || networkQuietSince() < NETWORK_IDLE_MS)) {
      missing.push('the network did not go idle')
    }
    return missing
  }
  let missing = unmet()
  while (missing.length > 0) {
    const elapsed = performance.now() - startedAt
    if (elapsed >= conditions.timeoutMs) {
      throw new ActionError('action-failed', `browser_wait timed out after ${Math.round(elapsed)}ms: ${missing.join('; ')}.`)
    }
    await pause(Math.min(WAIT_POLL_MS, conditions.timeoutMs - elapsed), ctx)
    missing = unmet()
  }
  const elapsed = Math.round(performance.now() - startedAt)
  return withPageDelta(`Condition met after ${elapsed}ms: ${describe().join(', ')}.`, ctx)
}

async function selectAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  let request
  try {
    request = parseSelectRequest(args)
  } catch (error: unknown) {
    if (error instanceof SelectError) throw new ActionError(error.code, error.message)
    throw error
  }
  const el = resolveActionTarget(args, ctx.ids)
  const label = targetLabel(args, el)
  let outcome
  try {
    outcome = await selectOptions(el, request, {
      click: (target) => {
        target.scrollIntoView({ block: 'center', behavior: 'instant' })
        dispatchPointerClick(target, 1, 0, [])
      },
      settle: async () => {
        await waitForPageSettled(ACTION_SETTLE)
        stopIfAborted(ctx)
      },
      type: (field, text) => {
        field.focus()
        setNativeValue(field, text)
      },
    })
  } catch (error: unknown) {
    if (error instanceof SelectError) throw new ActionError(error.code, error.message)
    throw error
  }
  await waitForPageSettled(ACTION_SETTLE)
  const count = outcome.selected.length
  const kind = outcome.kind === 'native' ? 'select' : outcome.kind
  const result = withPageDelta(`Selected in ${kind} ${label}; ${count} option(s) now selected.`, ctx)
  // Option labels are page text: they travel only as page content, under sharing.
  if (ctx.shareContent !== true || count === 0) return result
  const selected = `Selected options: ${outcome.selected.map((name) => `"${clip(name)}"`).join(', ')}`
  return { ...result, pageContent: result.pageContent === undefined ? selected : `${selected}\n\n${result.pageContent}` }
}

/** browser_extract: structured rows from the page (extract.ts), as text. */
function extractAction(args: Record<string, unknown>): ActionResult {
  let extracted
  try {
    extracted = extractRows(parseExtractRequest(args))
  } catch (error: unknown) {
    if (error instanceof ExtractError) throw new ActionError(error.code, error.message)
    throw error
  }
  const dropped = extracted.dropped > 0 ? `; ${extracted.dropped} more matched beyond limit` : ''
  return {
    // Column names may be page-authored table headers; they ride only in `data`.
    text: `Extracted ${extracted.rows.length} row(s) in ${extracted.columns.length} column(s)${dropped}.`,
    data: { columns: extracted.columns, rows: extracted.rows, dropped: extracted.dropped, url: location.href },
  }
}

/** Page state recorded before an action, compared after it. */
interface VerificationProbe {
  url: string
  messages: Map<Element, string>
  invalid: Set<Element>
}

/** Live regions and alerts where pages announce errors and confirmations. */
const MESSAGE_SELECTOR = '[role="alert"], [role="alertdialog"], [aria-live]:not([aria-live="off"]), [role="status"]'

function liveMessages(): Map<Element, string> {
  const messages = new Map<Element, string>()
  for (const el of querySelectorAllDeep(document, MESSAGE_SELECTOR)) {
    if (!isVisible(el)) continue
    const text = pageText(el)
    if (text !== '') messages.set(el, text)
  }
  return messages
}

function invalidFields(): Set<Element> {
  return new Set(querySelectorAllDeep(document, '[aria-invalid="true"]').filter((el) => isVisible(el)))
}

function beginVerification(): VerificationProbe {
  return { url: location.href, messages: liveMessages(), invalid: invalidFields() }
}

/** The error text a field points at (aria-errormessage / aria-describedby). */
function fieldErrorText(field: Element): string {
  const root = field.getRootNode() as Document | ShadowRoot
  const ids = `${field.getAttribute('aria-errormessage') ?? ''} ${field.getAttribute('aria-describedby') ?? ''}`
    .split(/\s+/).filter((id) => id !== '')
  return ids
    .map((id) => ('getElementById' in root ? root.getElementById(id) : null) ?? document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
    .map((el) => pageText(el))
    .filter((text) => text !== '')
    .join(' ')
}

const MAX_VERIFICATION_ITEM_CHARS = 200

function clip(text: string): string {
  return text.length <= MAX_VERIFICATION_ITEM_CHARS ? text : `${text.slice(0, MAX_VERIFICATION_ITEM_CHARS - 1)}…`
}

/**
 * Append what changed around the action: navigation, focus, the value a
 * typed field ended up with, and newly shown alert/error text.
 *
 * Facts that carry no page text (focus index, value length) go on the status
 * line; page-authored text goes to `pageContent`, which the background
 * releases only under the page-sharing setting.
 */
function finishVerification(
  result: ActionResult,
  probe: VerificationProbe,
  action: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): ActionResult {
  if (result.navigationPending === true) return result
  const facts: string[] = []
  const details: string[] = []
  if (location.href !== probe.url) {
    facts.push('The URL changed (same document).')
    details.push(`URL: ${location.href}`)
  }
  const active = deepActiveElement()
  const focused = active !== null && active !== document.body && active !== document.documentElement ? active : null
  // After typing, the field typed into is the subject even when the page moved focus.
  let subject = focused
  if (action === 'browser_type' && (args.index !== undefined || args.selector !== undefined)) {
    try {
      subject = resolveActionTarget(args, ctx.ids)
    } catch {
      // The target vanished after typing; report focus only.
    }
  }
  if (focused !== null) {
    const index = ctx.ids.indexOf(focused)
    // An explicit role attribute is page-authored; the status line takes only role-shaped words.
    const raw = roleOfElement(focused)
    const role = /^[a-z]{1,24}$/.test(raw) ? raw : 'element'
    facts.push(`Focus: ${index === undefined ? role : `[${index}] ${role}`}.`)
  }
  if (subject !== null) {
    const role = roleOfElement(subject)
    const prefix = subject === focused ? 'Focused' : 'Typed into'
    if (subject instanceof HTMLInputElement || subject instanceof HTMLTextAreaElement || subject instanceof HTMLSelectElement) {
      const value = subject instanceof HTMLSelectElement ? [...subject.selectedOptions].map((option) => option.text).join(', ') : subject.value
      if (action === 'browser_type' && typeof args.text === 'string' && !(subject instanceof HTMLSelectElement)) {
        const landed = args.replace === true ? value === args.text : value.includes(args.text)
        facts.push(landed
          ? `The field holds ${value.length} characters, including the typed text.`
          : `The field holds ${value.length} characters and does not contain the typed text; the page may have reformatted or rejected it.`)
      }
      details.push(`${prefix}: ${role} "${accessibleName(subject)}" value="${isSensitiveField(subject) ? maskValue(value) : clip(value)}"`)
    } else {
      details.push(`${prefix}: ${role} "${accessibleName(subject)}"`)
    }
  }
  const newMessages = [...liveMessages()].filter(([el, text]) => probe.messages.get(el) !== text)
  const newInvalid = [...invalidFields()].filter((el) => !probe.invalid.has(el))
  if (newMessages.length > 0 || newInvalid.length > 0) {
    facts.push(`${newMessages.length + newInvalid.length} new alert/validation message(s) appeared.`)
    for (const [, text] of newMessages) details.push(`New message: "${clip(text)}"`)
    for (const field of newInvalid) {
      const index = ctx.ids.indexOf(field)
      const error = fieldErrorText(field)
      details.push(`Invalid field ${index === undefined ? '' : `[${index}] `}"${accessibleName(field)}"${error === '' ? '' : `: "${clip(error)}"`}`)
    }
  }
  const text = facts.length === 0 ? result.text : `${result.text} ${facts.join(' ')}`
  if (ctx.shareContent !== true || details.length === 0) return { ...result, text }
  const block = `Verification:\n${details.map((line) => `  ${line}`).join('\n')}`
  return { ...result, text, pageContent: result.pageContent === undefined ? block : `${block}\n\n${result.pageContent}` }
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
