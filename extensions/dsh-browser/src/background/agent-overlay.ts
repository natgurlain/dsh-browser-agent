/**
 * Background half of "show the agent on the page": decides which tabs show
 * the controlled-tab frame and pill, which show the takeover banner, and
 * points at each action's target just before the dispatcher runs it.
 *
 * Every command is best effort and bounded: a page without the content
 * script, a slow frame, or a turned-off setting never delays or fails a tool
 * call by more than {@link POINT_TIMEOUT_MS}.
 *
 * @module
 */

import type { OverlayCopy, PointKind } from '../content/overlay.ts'
import { OVERLAY_COPY } from '../shared/overlay-copy.ts'
import type { TabFrame } from './frames.ts'
import type { ActionOverlay, ToolCall } from './tools.ts'

/** Longest a pointing animation may hold up the action. */
export const POINT_TIMEOUT_MS = 900

const POINT_KINDS: Record<string, PointKind> = {
  browser_click: 'click',
  browser_hover: 'hover',
  browser_drag: 'drag',
  browser_type: 'type',
  browser_select: 'select',
  browser_upload: 'upload',
  browser_press: 'press',
}

/** Message the content script receives. */
export type OverlayMessage =
  | { type: 'DSH_OVERLAY'; op: 'point'; kind: PointKind; args: Record<string, unknown>; label?: string; copy: OverlayCopy }
  | { type: 'DSH_OVERLAY'; op: 'preview'; on: true; kind: PointKind; args: Record<string, unknown>; label?: string; copy: OverlayCopy }
  | { type: 'DSH_OVERLAY'; op: 'preview'; on: false }
  | { type: 'DSH_OVERLAY'; op: 'control' | 'takeover'; on: boolean; copy: OverlayCopy }
  | { type: 'DSH_OVERLAY'; op: 'hide'; hidden: boolean }
  | { type: 'DSH_OVERLAY'; op: 'acting' }

/** What a freshly loaded document is told to show. */
export interface OverlayReadyState {
  control: boolean
  takeover: boolean
  copy: OverlayCopy
}

export interface AgentOverlayDeps {
  send: (tabId: number, message: OverlayMessage, target?: { frameId?: number; documentId?: string }) => Promise<unknown>
  /** The user's "Show the agent on the page" setting. */
  enabled: () => boolean
  locale: () => 'en' | 'zh'
  timeoutMs?: number
}

function hasTarget(call: ToolCall): boolean {
  const { args } = call
  if (call.name === 'browser_drag') return typeof args.from === 'object' && args.from !== null
  return args.index !== undefined || (typeof args.selector === 'string' && args.selector !== '')
}

function targetLabel(call: ToolCall): string | undefined {
  const source = call.name === 'browser_drag' ? (call.args.from as Record<string, unknown> | undefined) ?? {} : call.args
  return typeof source.index === 'number' ? `#${source.index}` : undefined
}

async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Keeps the on-page overlay of every tab in line with agent control. */
export class AgentOverlayController implements ActionOverlay {
  private readonly controlled = new Set<number>()
  private readonly takenOver = new Set<number>()
  /** Calls waiting on an approval: where their target is, and whether its outline is showing. */
  private readonly previews = new Map<string, { tabId: number; target: { frameId?: number; documentId?: string }; message: OverlayMessage; shown: boolean }>()

  constructor(private readonly deps: AgentOverlayDeps) {}

  private copy(): OverlayCopy {
    return OVERLAY_COPY[this.deps.locale()]
  }

  async beforeAction(tabId: number, frame: TabFrame, call: ToolCall): Promise<void> {
    if (!this.deps.enabled()) return
    const kind = POINT_KINDS[call.name]
    if (kind === undefined || !hasTarget(call)) return
    const label = targetLabel(call)
    const message: OverlayMessage = {
      type: 'DSH_OVERLAY',
      op: 'point',
      kind,
      // Only addressing fields travel: typed text, file paths, and option values stay out.
      args: addressingArgs(call.name, call.args),
      ...(label === undefined ? {} : { label }),
      copy: this.copy(),
    }
    const target = frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId }
    // An action inside an iframe still lands on the top page: keep its Stop button inert too.
    if (frame.frameId !== 0) void this.deps.send(tabId, { type: 'DSH_OVERLAY', op: 'acting' }, { frameId: 0 }).catch(() => {})
    await bounded(this.deps.send(tabId, message, target), this.deps.timeoutMs ?? POINT_TIMEOUT_MS)
  }

  /**
   * A call is about to ask for approval. Nothing is drawn yet: most calls are
   * settled by a standing rule without a card ({@link showPreview}).
   */
  armPreview(tabId: number, frame: TabFrame, call: ToolCall): void {
    if (!this.deps.enabled()) return
    const kind = POINT_KINDS[call.name]
    if (kind === undefined || !hasTarget(call)) return
    const label = targetLabel(call)
    this.previews.set(call.id, {
      tabId,
      target: frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId },
      // Only addressing fields travel, as for the action itself.
      message: { type: 'DSH_OVERLAY', op: 'preview', on: true, kind, args: addressingArgs(call.name, call.args), ...(label === undefined ? {} : { label }), copy: this.copy() },
      shown: false,
    })
  }

  /** The call's approval card is on screen: outline its target on the page until the card is answered. */
  showPreview(callId: string): void {
    const preview = this.previews.get(callId)
    if (preview === undefined || preview.shown) return
    preview.shown = true
    void this.deps.send(preview.tabId, preview.message, preview.target).catch(() => {})
  }

  /** The call's approval is settled, either way: remove the outline. */
  endPreview(call: Pick<ToolCall, 'id'>): void {
    const preview = this.previews.get(call.id)
    if (preview === undefined) return
    this.previews.delete(call.id)
    if (preview.shown) void this.deps.send(preview.tabId, { type: 'DSH_OVERLAY', op: 'preview', on: false }, preview.target).catch(() => {})
  }

  async hiddenDuring<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    if (!this.deps.enabled()) return run()
    // Every frame may hold an outline or cursor: hide them all (no frame target).
    await bounded(this.deps.send(tabId, { type: 'DSH_OVERLAY', op: 'hide', hidden: true }), 300)
    try {
      return await run()
    } finally {
      void this.deps.send(tabId, { type: 'DSH_OVERLAY', op: 'hide', hidden: false }).catch(() => {})
    }
  }

  /** Show the frame and pill on exactly `tabIds` (empty while the setting is off). */
  syncControl(tabIds: ReadonlySet<number>): void {
    const wanted = this.deps.enabled() ? tabIds : new Set<number>()
    for (const tabId of [...this.controlled]) {
      if (wanted.has(tabId)) continue
      this.controlled.delete(tabId)
      this.post(tabId, 'control', false)
    }
    for (const tabId of wanted) {
      if (this.controlled.has(tabId)) continue
      this.controlled.add(tabId)
      this.post(tabId, 'control', true)
    }
  }

  /** Show or clear the takeover banner on `tabIds`. The banner ignores the setting: it is a control surface. */
  setTakeover(tabIds: ReadonlySet<number>): void {
    for (const tabId of [...this.takenOver]) {
      if (tabIds.has(tabId)) continue
      this.takenOver.delete(tabId)
      this.post(tabId, 'takeover', false)
    }
    for (const tabId of tabIds) {
      if (this.takenOver.has(tabId)) continue
      this.takenOver.add(tabId)
      this.post(tabId, 'takeover', true)
    }
  }

  /** State for a document that just loaded in `tabId` (top frame only). */
  readyState(tabId: number, frameId: number | undefined): OverlayReadyState | undefined {
    if (frameId !== 0) return undefined
    const control = this.controlled.has(tabId)
    const takeover = this.takenOver.has(tabId)
    if (!control && !takeover) return undefined
    return { control, takeover, copy: this.copy() }
  }

  /** Forget a closed tab. */
  forget(tabId: number): void {
    this.controlled.delete(tabId)
    this.takenOver.delete(tabId)
  }

  private post(tabId: number, op: 'control' | 'takeover', on: boolean): void {
    void this.deps.send(tabId, { type: 'DSH_OVERLAY', op, on, copy: this.copy() }, { frameId: 0 }).catch(() => {})
  }
}

/** The fields that locate a target; never values that would be typed or chosen. */
function addressingArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'browser_drag') {
    const pick = (end: unknown): Record<string, unknown> | undefined => {
      if (typeof end !== 'object' || end === null) return undefined
      const { index, selector } = end as Record<string, unknown>
      return { ...(index === undefined ? {} : { index }), ...(selector === undefined ? {} : { selector }) }
    }
    const from = pick(args.from)
    const to = pick(args.to)
    return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
  }
  const { index, selector } = args
  return { ...(index === undefined ? {} : { index }), ...(selector === undefined ? {} : { selector }) }
}
