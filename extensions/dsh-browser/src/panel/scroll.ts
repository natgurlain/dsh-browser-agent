/**
 * Scroll helpers for the conversation pane.
 *
 * @module
 */

/** True when the scrollport is within `threshold` px of its bottom edge. */
export function isNearScrollBottom(
  element: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  threshold = 48,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}

/** The scrollport numbers the follow rule reads. */
export type ScrollMetrics = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

/** How long after a wheel, touch or key a scroll still counts as the user's. */
export const USER_SCROLL_WINDOW_MS = 400

/**
 * Whether the conversation follows its newest content.
 *
 * It stops following only when the user scrolls the thread itself up: a scroll
 * that moves the thread upward while the user is wheeling, touching, pressing
 * a scrolling key or dragging its scrollbar. Everything else keeps it
 * following: a banner or status line appearing above the thread (the
 * scrollport shrinks, no scroll by the user), content growing or shrinking,
 * and scrolling inside a nested scroll area (a long code block or card), which
 * does not move the thread. Reaching the bottom again, by any means, follows
 * again.
 */
export class ConversationFollow {
  private following = true
  private lastTop = 0
  private intentUntil = Number.NEGATIVE_INFINITY
  private dragging = false

  constructor(private readonly now: () => number = () => Date.now()) {}

  get isFollowing(): boolean {
    return this.following
  }

  /**
   * A wheel, touch or scrolling key aimed at the thread (a nested scroll area
   * that takes it does not move the thread). A downward wheel or key does not
   * count: the end of its smooth scroll can land above content that grew
   * meanwhile, which is not the user leaving the newest content.
   */
  noteUserScroll(direction: 'up' | 'down' | 'unknown' = 'unknown'): void {
    if (direction === 'down') return
    this.intentUntil = this.now() + USER_SCROLL_WINDOW_MS
  }

  /** The user holds the thread's scrollbar (pointer down on the scrollport itself). */
  setDragging(dragging: boolean): void {
    this.dragging = dragging
    if (!dragging) this.noteUserScroll()
  }

  /** The user asked for the newest content ("Scroll to latest"). */
  stick(): void {
    this.following = true
  }

  /**
   * A scroll event on the thread.
   * @returns whether it follows now, and whether the caller should move it back to the bottom.
   */
  onScroll(metrics: ScrollMetrics): { following: boolean; pin: boolean } {
    const movedUp = metrics.scrollTop < this.lastTop - 1
    this.lastTop = metrics.scrollTop
    if (isNearScrollBottom(metrics)) {
      this.following = true
      return { following: true, pin: false }
    }
    if (movedUp && (this.dragging || this.now() <= this.intentUntil)) {
      this.following = false
      return { following: false, pin: false }
    }
    // Not the user's doing (layout, scroll anchoring, content changes): keep following.
    return { following: this.following, pin: this.following && movedUp }
  }

  /**
   * The scrollport or its content changed size without a scroll by the user.
   * @returns whether the caller should move it back to the bottom.
   */
  onResize(metrics: ScrollMetrics): boolean {
    this.lastTop = metrics.scrollTop
    return this.following && !isNearScrollBottom(metrics, 1)
  }

  /** The caller moved the thread to the bottom. */
  pinned(metrics: ScrollMetrics): void {
    this.lastTop = metrics.scrollTop
  }
}

/** Keys that scroll the focused scrollport up. */
const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/** Whether a key press may scroll the thread up (not while typing into a field). */
export function isScrollUpKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'target'>): boolean {
  if (!SCROLL_UP_KEYS.has(event.key) && !(event.key === ' ' && event.shiftKey)) return false
  const target = event.target as { tagName?: unknown; isContentEditable?: unknown } | null
  if (target === null || typeof target !== 'object') return true
  if (target.isContentEditable === true) return false
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}
