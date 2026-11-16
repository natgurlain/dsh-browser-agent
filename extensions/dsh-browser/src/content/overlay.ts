/**
 * "Show the agent on the page": a ghost cursor that glides to each target
 * before a click, hover, or drag; an outline with the element's index just
 * before acting, and a dashed one while the action's approval card is open;
 * a brief "typing…" flash on typed fields; and, on tabs the
 * agent controls, a thin colored frame with an "AI controlling" pill whose
 * Stop link fires the kill switch. During a takeover a banner tells the user
 * they are in control and offers Resume.
 *
 * Isolation from the page:
 * - One attribute-free-after-creation host element under <html>, inserted once
 *   per document and never touched again, so the page's MutationObserver sees
 *   a single childList record. Everything else changes inside a *closed*
 *   shadow root the page cannot query, style, or observe.
 * - The host's own styles are inline `!important`, which page stylesheets
 *   cannot override, and the host never takes pointer events. Only the pill
 *   and banner buttons do; their handlers accept trusted events only and
 *   ignore clicks inside an action window, so an agent click can never
 *   trigger them. Nothing page-visible changes during an action window, so
 *   hit-testing cannot tell agent activity from the user's.
 * - The host is re-verified every {@link HOST_CHECK_MS} while visible: a page
 *   that removes or restyles it gets a fresh one.
 * - The banner's Resume does not resume: it opens the side panel, whose own
 *   Resume confirms (a page could fake clicks on a lookalike, never on the
 *   panel). Stop only reduces privilege, so it acts at once.
 * - Typed text is never rendered: the typing flash shows a fixed label.
 * - `prefers-reduced-motion` turns every animation into an instant change.
 *
 * @module
 */

import { OVERLAY_COPY_EN, type OverlayCopy } from '../shared/overlay-copy.ts'

export { OVERLAY_COPY_EN, type OverlayCopy }

/** What the agent is about to do to a target. */
export type PointKind = 'click' | 'hover' | 'drag' | 'type' | 'select' | 'press' | 'upload' | 'scroll'

/** Callbacks into the extension for the pill and banner buttons. */
export interface OverlayActions {
  killSwitch: () => void
  resume: () => void
}

const HOST_STYLE = [
  'all: initial !important',
  'position: fixed !important',
  'inset: 0 !important',
  'width: 100vw !important',
  'height: 100vh !important',
  'margin: 0 !important',
  'padding: 0 !important',
  'border: 0 !important',
  'pointer-events: none !important',
  'z-index: 2147483647 !important',
  'display: block !important',
  'visibility: visible !important',
  'opacity: 1 !important',
  'transform: none !important',
  'contain: strict !important',
].join(';')

// The overlay sits on arbitrary pages, so it does not follow the panel theme:
// every piece pairs a dark and a light edge (blue frame + white inset, blue
// cursor + white stroke, navy pill/typing chip + light hairline ring) so it
// reads on both light and dark sites.
const SHADOW_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #182033; }
.frame { position: fixed; inset: 0; border: 3px solid rgba(77, 107, 254, .85); border-radius: 2px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.6); opacity: 0; transition: opacity .2s ease; }
.frame.on { opacity: 1; }
.frame.takeover { border-color: rgba(208, 138, 23, .9); }
.pill { position: fixed; top: 10px; right: 12px; display: none; align-items: center; gap: 8px; padding: 5px 6px 5px 10px; border-radius: 999px; background: #172033; color: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,.32), 0 6px 18px rgba(23,32,51,.28); }
.pill.on { display: inline-flex; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #7d93ff; box-shadow: 0 0 0 3px rgba(125,147,255,.25); }
.pill.on .dot { animation: pulse 1.6s ease-in-out infinite; }
.pill button, .banner button { pointer-events: auto; cursor: pointer; border: 0; border-radius: 999px; font: 600 12px/1 inherit; font-family: inherit; }
.pill button { padding: 5px 10px; background: #b42318; color: #fff; }
.pill button:hover { background: #912018; }
.banner { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: none; align-items: center; gap: 12px; max-width: calc(100vw - 32px); padding: 10px 10px 10px 16px; border-radius: 14px; background: #fffaeb; border: 1px solid #fedf89; color: #4a3200; box-shadow: 0 10px 28px rgba(23,32,51,.18); }
.banner.on { display: flex; }
.banner strong { font-weight: 650; }
.banner span { color: #6b4b00; }
.banner button { padding: 8px 14px; background: #4d6bfe; color: #fff; }
.banner button:hover { background: #3c57e8; }
.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; opacity: 0; transform: translate(-100px, -100px); transition: transform .32s cubic-bezier(.2,.7,.2,1), opacity .18s ease; filter: drop-shadow(0 2px 3px rgba(23,32,51,.35)); }
.cursor.on { opacity: 1; }
.cursor.press svg { transform: scale(.86); transform-origin: 3px 3px; }
.outline { position: fixed; display: none; border: 2px solid #4d6bfe; border-radius: 6px; background: rgba(77,107,254,.08); box-shadow: 0 0 0 4px rgba(77,107,254,.18); }
.outline.on { display: block; }
.outline .label { position: absolute; left: -2px; top: -22px; padding: 2px 6px; border-radius: 6px 6px 6px 0; background: #4d6bfe; color: #fff; font-weight: 650; font-size: 11px; white-space: nowrap; }
.outline.below .label { top: auto; bottom: -22px; border-radius: 0 6px 6px 6px; }
.outline.preview { border-style: dashed; background: transparent; }
.typing { position: fixed; display: none; padding: 3px 8px; border-radius: 999px; background: #172033; color: #fff; font-size: 11px; box-shadow: 0 0 0 1px rgba(255,255,255,.32); }
.typing.on { display: block; animation: blink 1s ease-in-out infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(125,147,255,.08); } }
@keyframes blink { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) {
  .cursor, .frame { transition: none; }
  .pill.on .dot, .typing.on { animation: none; }
}
`

const CURSOR_SVG = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 2.5 L3 18 L7.3 13.9 L10.2 20.2 L13 19 L10.1 12.8 L16 12.6 Z" fill="#4d6bfe" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'

/** How long buttons stay inert after an announced action. */
const ACTING_WINDOW_MS = 4_000
/** How often the host's attachment, style, and geometry are re-verified. */
const HOST_CHECK_MS = 500
/** How long the outline and typing flash stay visible. */
const HIGHLIGHT_MS = 1_400
/** How often a card-time outline follows its element (scrolling, layout changes). */
const PREVIEW_TRACK_MS = 200
const MOVE_MS = 320

interface OverlayParts {
  root: ShadowRoot
  layer: HTMLDivElement
  frame: HTMLDivElement
  pill: HTMLDivElement
  pillText: HTMLSpanElement
  stop: HTMLButtonElement
  banner: HTMLDivElement
  bannerTitle: HTMLElement
  bannerBody: HTMLSpanElement
  resume: HTMLButtonElement
  cursor: HTMLDivElement
  outline: HTMLDivElement
  label: HTMLSpanElement
  /** The second element of a card-time outline (a drag's destination). */
  outlineTo: HTMLDivElement
  typing: HTMLDivElement
}

/** The per-document agent overlay. */
export class AgentOverlay {
  private parts: OverlayParts | undefined
  private host: HTMLElement | undefined
  private copy: OverlayCopy = OVERLAY_COPY_EN
  private control = false
  private takeover = false
  private actingTimer: ReturnType<typeof setTimeout> | undefined
  /** Inside an action window: button clicks are ignored (no visible or hit-test change). */
  private acting = false
  private checkTimer: number | undefined
  private highlightTimer: ReturnType<typeof setTimeout> | undefined
  private cursorAt: { x: number; y: number } | undefined
  /** The element(s) outlined while an approval card is open. */
  private previewed: { targets: Element[]; label: string | undefined } | undefined
  private previewTimer: number | undefined

  constructor(
    private readonly actions: OverlayActions,
    private readonly doc: Document = document,
  ) {}

  /** The host element, once created (tests use it). */
  hostElement(): HTMLElement | undefined {
    return this.host
  }

  /** Show or hide the controlled-tab frame and pill. */
  setControl(on: boolean, copy?: Partial<OverlayCopy>): void {
    this.applyCopy(copy)
    this.control = on
    if (!on && !this.takeover && this.parts === undefined) return
    this.render()
  }

  /** Show or hide the "You're in control" banner. */
  setTakeover(on: boolean, copy?: Partial<OverlayCopy>): void {
    this.applyCopy(copy)
    this.takeover = on
    if (!on && !this.control && this.parts === undefined) return
    this.render()
  }

  /** Hide everything (e.g. during a screenshot) or show it again. */
  setHidden(hidden: boolean): void {
    if (this.parts === undefined) return
    this.parts.layer.style.visibility = hidden ? 'hidden' : 'visible'
  }

  /**
   * Outline the element(s) an action would act on while its approval card is
   * open, so the user sees on the page what the card names. Only a dashed
   * outline in the overlay's own layer: nothing on the page is changed,
   * scrolled, focused, or covered, the outline takes no pointer events, and
   * (unlike {@link point}) the Stop button stays live, because nothing is
   * acting. The outline follows its element until {@link clearPreview}.
   */
  preview(targets: Element[], label: string | undefined, copy?: Partial<OverlayCopy>): void {
    this.applyCopy(copy)
    const parts = this.ensure()
    if (parts === undefined || targets.length === 0) return
    this.stopPreviewTracking()
    if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer)
    parts.typing.classList.remove('on')
    parts.cursor.classList.remove('on')
    this.previewed = { targets: targets.slice(0, 2), label }
    this.drawPreview()
    const view = this.doc.defaultView
    if (view !== null) this.previewTimer = view.setInterval(() => { this.drawPreview() }, PREVIEW_TRACK_MS)
  }

  /** Remove the card-time outline (the card was answered, withdrawn, or timed out). */
  clearPreview(): void {
    if (this.previewed === undefined) return
    this.stopPreviewTracking()
    this.previewed = undefined
    const parts = this.parts
    if (parts === undefined) return
    parts.outline.classList.remove('on', 'preview')
    parts.outlineTo.classList.remove('on', 'preview')
  }

  private stopPreviewTracking(): void {
    if (this.previewTimer === undefined) return
    this.doc.defaultView?.clearInterval(this.previewTimer)
    this.previewTimer = undefined
  }

  private drawPreview(): void {
    const parts = this.parts
    const previewed = this.previewed
    if (parts === undefined || previewed === undefined) return
    const [first, second] = previewed.targets
    const firstRect = first === undefined ? undefined : this.visibleRect(first)
    if (firstRect === undefined) parts.outline.classList.remove('on')
    else this.showOutline(firstRect, previewed.label)
    parts.outline.classList.add('preview')
    const secondRect = second === undefined ? undefined : this.visibleRect(second)
    if (secondRect === undefined) {
      parts.outlineTo.classList.remove('on')
    } else {
      this.placeOutline(parts.outlineTo, secondRect)
      parts.outlineTo.classList.add('on', 'preview')
    }
  }

  /**
   * Point at the element(s) the agent is about to act on: move the ghost
   * cursor, outline the target with its index, and flash "typing…" for typed
   * fields. Resolves once the movement is done (instantly with reduced motion).
   */
  async point(kind: PointKind, targets: Element[], label: string | undefined, copy?: Partial<OverlayCopy>): Promise<void> {
    this.applyCopy(copy)
    const parts = this.ensure()
    if (parts === undefined) return
    // The action begins: a card-time outline gives way to the solid one.
    this.stopPreviewTracking()
    this.previewed = undefined
    parts.outline.classList.remove('preview')
    parts.outlineTo.classList.remove('on', 'preview')
    this.markActing()
    const reduced = this.reducedMotion()
    const [first, second] = targets
    if (first === undefined) return
    const firstRect = this.visibleRect(first)
    if (firstRect === undefined) return
    this.showOutline(firstRect, label)
    if (kind === 'type') {
      this.showTyping(firstRect)
    } else {
      parts.typing.classList.remove('on')
    }
    if (kind !== 'type' && kind !== 'scroll') {
      await this.moveCursor(center(firstRect), reduced)
      if (kind === 'drag' && second !== undefined) {
        const secondRect = this.visibleRect(second)
        if (secondRect !== undefined) await this.moveCursor(center(secondRect), reduced, true)
      } else if (kind === 'click' || kind === 'select') {
        parts.cursor.classList.add('press')
        setTimeout(() => { parts.cursor.classList.remove('press') }, 160)
      }
    }
    if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer)
    this.highlightTimer = setTimeout(() => {
      parts.outline.classList.remove('on')
      parts.typing.classList.remove('on')
      parts.cursor.classList.remove('on')
    }, HIGHLIGHT_MS)
  }

  /** Remove the host (content script replaced or overlays turned off). */
  dispose(): void {
    if (this.actingTimer !== undefined) clearTimeout(this.actingTimer)
    this.stopChecks()
    this.stopPreviewTracking()
    this.previewed = undefined
    if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer)
    this.host?.remove()
    this.host = undefined
    this.parts = undefined
    this.cursorAt = undefined
  }

  private applyCopy(copy: Partial<OverlayCopy> | undefined): void {
    if (copy === undefined) return
    const next = { ...this.copy }
    for (const key of Object.keys(OVERLAY_COPY_EN) as Array<keyof OverlayCopy>) {
      const value = copy[key]
      if (typeof value === 'string' && value !== '') next[key] = value.slice(0, 120)
    }
    this.copy = next
  }

  private render(): void {
    const parts = this.ensure()
    if (parts === undefined) return
    parts.frame.classList.toggle('on', this.control || this.takeover)
    parts.frame.classList.toggle('takeover', this.takeover)
    parts.pill.classList.toggle('on', this.control && !this.takeover)
    parts.banner.classList.toggle('on', this.takeover)
    parts.pillText.textContent = this.copy.controlling
    parts.stop.textContent = this.copy.stop
    parts.stop.title = this.copy.stopHint
    parts.stop.setAttribute('aria-label', this.copy.stopHint)
    parts.bannerTitle.textContent = this.copy.takeoverTitle
    parts.bannerBody.textContent = this.copy.takeoverBody
    parts.resume.textContent = this.copy.resume
    if (this.control || this.takeover) this.startChecks()
    else this.stopChecks()
  }

  /**
   * While the frame, pill, or banner should be visible, re-verify the host:
   * a page that removes it, restyles it (opacity, transform, size), or moves
   * it gets a fresh host. The closed shadow root keeps the inside out of
   * reach, so the host element is the only thing the page can tamper with.
   */
  private startChecks(): void {
    if (this.checkTimer !== undefined) return
    const view = this.doc.defaultView
    if (view === null) return
    this.checkTimer = view.setInterval(() => { this.verifyHost() }, HOST_CHECK_MS)
  }

  private stopChecks(): void {
    if (this.checkTimer === undefined) return
    this.doc.defaultView?.clearInterval(this.checkTimer)
    this.checkTimer = undefined
  }

  /** Whether the host is still attached, unstyled by the page, and covering the viewport. */
  private hostIntact(): boolean {
    const host = this.host
    if (host === undefined || !host.isConnected || host.parentNode !== this.doc.documentElement) return false
    if (host.getAttribute('style') !== HOST_STYLE || host.attributes.length !== 1) return false
    const view = this.doc.defaultView
    if (view === null) return true
    try {
      const computed = view.getComputedStyle(host)
      if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity !== '1'
        || (computed.transform !== '' && computed.transform !== 'none')) return false
      const rect = host.getBoundingClientRect()
      // jsdom has no layout (all zero); a real page must keep it at the viewport.
      if (rect.width !== 0 || rect.height !== 0) {
        if (Math.abs(rect.left) > 1 || Math.abs(rect.top) > 1
          || Math.abs(rect.width - view.innerWidth) > 2 || Math.abs(rect.height - view.innerHeight) > 2) return false
      }
    } catch { /* computed style unavailable: attribute checks stand */ }
    return true
  }

  private verifyHost(): void {
    if (!(this.control || this.takeover)) {
      this.stopChecks()
      return
    }
    if (this.hostIntact()) return
    // Recreate from scratch: a tampered host is discarded, never repaired in place.
    this.host?.remove()
    this.host = undefined
    this.parts = undefined
    this.cursorAt = undefined
    this.render()
  }

  private ensure(): OverlayParts | undefined {
    if (this.parts !== undefined && this.host?.isConnected === true) return this.parts
    const parent = this.doc.documentElement
    if (parent === null) return undefined
    this.host?.remove()
    const host = this.doc.createElement('div')
    host.setAttribute('style', HOST_STYLE)
    const root = host.attachShadow({ mode: 'closed' })
    const style = this.doc.createElement('style')
    style.textContent = SHADOW_CSS
    root.append(style)
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parentNode: ParentNode): HTMLElementTagNameMap[K] => {
      const el = this.doc.createElement(tag)
      el.className = className
      parentNode.append(el)
      return el
    }
    const layer = make('div', 'layer', root)
    layer.setAttribute('aria-hidden', 'false')
    const frame = make('div', 'frame', layer)
    const pill = make('div', 'pill', layer)
    pill.setAttribute('role', 'status')
    make('span', 'dot', pill)
    const pillText = make('span', 'text', pill)
    const stop = make('button', 'stop', pill)
    stop.type = 'button'
    const banner = make('div', 'banner', layer)
    banner.setAttribute('role', 'status')
    const bannerTitle = make('strong', 'title', banner)
    const bannerBody = make('span', 'body', banner)
    const resume = make('button', 'resume', banner)
    resume.type = 'button'
    const cursor = make('div', 'cursor', layer)
    cursor.innerHTML = CURSOR_SVG
    const outline = make('div', 'outline', layer)
    const label = make('span', 'label', outline)
    const outlineTo = make('div', 'outline', layer)
    const typing = make('div', 'typing', layer)
    // Only real user clicks count: page scripts cannot reach a closed root,
    // and synthetic events are refused all the same.
    stop.addEventListener('click', (event) => {
      if (!event.isTrusted || this.acting) return
      event.preventDefault()
      event.stopPropagation()
      this.actions.killSwitch()
    })
    resume.addEventListener('click', (event) => {
      if (!event.isTrusted || this.acting) return
      event.preventDefault()
      event.stopPropagation()
      this.actions.resume()
    })
    parent.append(host)
    this.host = host
    this.parts = { root, layer, frame, pill, pillText, stop, banner, bannerTitle, bannerBody, resume, cursor, outline, label, outlineTo, typing }
    this.render()
    return this.parts
  }

  /** Make the pill and banner buttons inert while an agent action may land on them. */
  markActing(): void {
    // Nothing the page can observe changes (no class, no pointer-events):
    // hit-testing the buttons must not reveal when the agent is acting.
    this.acting = true
    if (this.actingTimer !== undefined) clearTimeout(this.actingTimer)
    this.actingTimer = setTimeout(() => { this.acting = false }, ACTING_WINDOW_MS)
  }

  private visibleRect(el: Element): DOMRect | undefined {
    if (!el.isConnected) return undefined
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return undefined
    return rect
  }

  private placeOutline(outline: HTMLDivElement, rect: DOMRect): void {
    const pad = 3
    outline.style.left = `${Math.round(rect.left - pad)}px`
    outline.style.top = `${Math.round(rect.top - pad)}px`
    outline.style.width = `${Math.round(rect.width + pad * 2)}px`
    outline.style.height = `${Math.round(rect.height + pad * 2)}px`
  }

  private showOutline(rect: DOMRect, label: string | undefined): void {
    const parts = this.parts!
    this.placeOutline(parts.outline, rect)
    parts.outline.classList.toggle('below', rect.top < 28)
    parts.label.textContent = label ?? ''
    parts.label.style.display = label === undefined || label === '' ? 'none' : ''
    parts.outline.classList.add('on')
  }

  private showTyping(rect: DOMRect): void {
    const parts = this.parts!
    // A fixed label only: the typed text itself is never drawn.
    parts.typing.textContent = this.copy.typing
    const top = rect.bottom + 6
    parts.typing.style.left = `${Math.round(Math.max(4, rect.left))}px`
    parts.typing.style.top = `${Math.round(top)}px`
    parts.typing.classList.add('on')
  }

  private async moveCursor(point: { x: number; y: number }, reduced: boolean, drag = false): Promise<void> {
    const cursor = this.parts!.cursor
    const start = this.cursorAt
    const place = (p: { x: number; y: number }): void => {
      cursor.style.transform = `translate(${Math.round(p.x - 3)}px, ${Math.round(p.y - 2)}px)`
    }
    if (start === undefined || reduced) {
      // First appearance: start just off the target so the motion reads as "going there".
      if (!reduced) {
        cursor.style.transition = 'none'
        place({ x: point.x + 60, y: point.y + 40 })
        void cursor.getBoundingClientRect()
        cursor.style.transition = ''
      }
    }
    cursor.classList.add('on')
    cursor.classList.toggle('press', drag)
    place(point)
    this.cursorAt = point
    if (!reduced) await sleep(drag ? MOVE_MS + 120 : MOVE_MS)
  }

  private reducedMotion(): boolean {
    try {
      return this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    } catch {
      return false
    }
  }
}

function center(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
