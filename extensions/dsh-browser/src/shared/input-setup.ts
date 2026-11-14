/**
 * Internal content-script protocol for trusted input.
 *
 * Trusted input runs in the background (CDP), but focusing and selecting
 * happen in the frame that owns the element. These request/result
 * shapes are the contract between the two halves; they never reach the model.
 *
 * @module
 */

/** A point in one frame's viewport, CSS pixels. */
export interface ElementPoint {
  x: number
  y: number
}

/** One pointer target: a snapshot index or a CSS selector. */
export interface PointerEnd {
  index?: number
  selector?: string
}

/** A measured element, with everything a pointer gesture needs. */
export interface MeasuredTarget {
  rect: { x: number; y: number; width: number; height: number }
  center: ElementPoint
  visible: boolean
  /** Description of the element that covers the target's center, if any. */
  covered?: string
  /** What a click would activate; toggles and submits are never retried blindly. */
  activation: 'link' | 'toggle' | 'submit' | 'field' | 'control' | 'other'
  /** HTML5 drag source (`draggable="true"`). */
  draggable: boolean
  tag: string
}

/** Whether the page changed at all between a watch start and its end. */
export interface WatchReport {
  changed: boolean
  reasons: string[]
}

/**
 * Isolated-world global through which the debugger reaches an element the
 * content script measured for trusted pointer input. It lives only in the
 * extension's isolated world (never on the page's DOM or window), so the page
 * cannot observe which element is about to receive real input.
 */
export const POINTER_REGISTRY_GLOBAL = '__dshPointerRegistry'

/** What the debugger may call in the isolated world. */
export interface PointerRegistry {
  /** Whether this frame holds the element for `token`. */
  has(token: string): boolean
  /** The element held for `token`. */
  get(token: string): Element | undefined
  /** Whether a hit-tested node is the element for `token` or inside it (composed tree, bound label/control). */
  reaches(token: string, node: Node): boolean
}

/** Synthetic drag (no debugger, or an HTML5 drag source). */
export interface SyntheticDragRequest {
  from: PointerEnd
  to?: PointerEnd
  offset?: ElementPoint
  steps: number
}

/** What the background asks a frame to prepare before trusted input. */
export type InputSetupRequest =
  | { op: 'prepare'; index?: number; selector?: string; select?: 'none' | 'contents' | 'end' }
  | { op: 'upload-mark'; token: string; index?: number; selector?: string }
  | { op: 'upload-clear'; token: string }
  | ({ op: 'measure'; mark?: string; hitTest?: boolean; watch?: string; noScroll?: boolean } & PointerEnd)
  | { op: 'pointer-clear'; token: string }
  | { op: 'watch-end'; token: string }
  | ({ op: 'synthetic-hover' } & PointerEnd)
  | ({ op: 'synthetic-drag' } & SyntheticDragRequest)

/** Result of one setup request. */
export type InputSetupResult =
  | { op: 'prepare'; focused: boolean; selected: boolean }
  | { op: 'upload-mark'; selector: string }
  | { op: 'upload-clear'; cleared: boolean }
  | { op: 'measure'; measure: MeasuredTarget }
  | { op: 'pointer-clear'; cleared: boolean }
  | { op: 'watch-end'; report: WatchReport }
  | { op: 'synthetic-hover' }
  | { op: 'synthetic-drag'; mode: 'html5' | 'pointer'; dropped: boolean }
