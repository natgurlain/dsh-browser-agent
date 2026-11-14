import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from '../security/approval.ts'
import { approvalNotificationClass } from './approval-notifications.ts'

export type ApprovalRequestResult =
  | { status: 'decision'; decision: ApprovalDecision }
  | { status: 'unavailable' | 'timed-out' | 'cancelled' }

/** A pending approval as seen by the panel-independent surfaces. */
export interface BackgroundApproval {
  request: ApprovalRequest
  windowId: number
  /** Bridge tool call the approval gates, when known (hold and forwarding need it). */
  toolCallId?: string
  /** When the approval times out (epoch ms). */
  deadline: number
}

interface PendingApproval {
  request: ApprovalRequest
  windowId: number
  toolCallId?: string
  deadline: number
  resolve: (result: ApprovalRequestResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface ApprovalCoordinatorCallbacks {
  deliver: (request: ApprovalRequest) => boolean
  notify: (request: ApprovalRequest, windowId: number) => void
  clearNotification: (id: string) => void
  resolved: (id: string) => void
  /**
   * The approval has no side panel to show it (raised without one, or its
   * last panel closed): hold its tool call and forward it to dsh.
   */
  background?: (approval: BackgroundApproval) => void
}

/** Time allowed to decide while a side panel shows the card. */
export const APPROVAL_TIMEOUT_MS = 60_000

/** Default time allowed to decide while no side panel is open. */
export const BACKGROUND_APPROVAL_TIMEOUT_MS = 10 * 60_000

/** Decisions that a source outside the side panel may deliver. */
export type RemoteApprovalDecision = 'allow-once' | 'deny'

/**
 * Own pending approvals independently of the side panel's lifetime. Fails
 * closed: an approval nobody answers in time settles `timed-out`.
 */
export class ApprovalCoordinator {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly callbacks: ApprovalCoordinatorCallbacks,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
    private readonly backgroundTimeoutMs: () => number = () => BACKGROUND_APPROVAL_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  request(
    prompt: ApprovalPrompt,
    signal: AbortSignal,
    windowId: number,
    sessionId?: string,
    toolCallId?: string,
  ): Promise<ApprovalRequestResult> {
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' })
    const request: ApprovalRequest = {
      ...prompt,
      id: crypto.randomUUID(),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    return new Promise((resolve) => {
      const onAbort = (): void => { this.settle(request.id, { status: 'cancelled' }) }
      const resolveWithCleanup = (result: ApprovalRequestResult): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const entry: PendingApproval = {
        request,
        windowId,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        deadline: this.now() + this.timeoutMs,
        resolve: resolveWithCleanup,
        timer: setTimeout(() => { this.settle(request.id, { status: 'timed-out' }) }, this.timeoutMs),
      }
      this.pending.set(request.id, entry)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        this.settle(request.id, { status: 'cancelled' })
        return
      }
      if (!this.callbacks.deliver(request)) this.goBackground(entry)
    })
  }

  respond(id: string, decision: ApprovalDecision): void {
    this.settle(id, { status: 'decision', decision })
  }

  /**
   * Accept a decision from outside the side panel (dsh's approval service).
   * It must name the payload binding of the pending request exactly, and can
   * only allow once or deny.
   * @returns whether the decision settled the approval.
   */
  respondRemote(id: string, binding: string | undefined, decision: RemoteApprovalDecision): boolean {
    const pending = this.pending.get(id)
    if (pending === undefined || pending.request.binding !== binding) return false
    if (decision !== 'allow-once' && decision !== 'deny') return false
    this.settle(id, { status: 'decision', decision })
    return true
  }

  /**
   * Accept a notification button. Denying is always possible; allowing only
   * for an approval whose payload the notification fully shows.
   * @returns whether the click settled the approval.
   */
  respondFromNotification(id: string, decision: RemoteApprovalDecision): boolean {
    const pending = this.pending.get(id)
    if (pending === undefined) return false
    if (decision === 'allow-once' && approvalNotificationClass(pending.request) !== 'quick') return false
    if (decision !== 'allow-once' && decision !== 'deny') return false
    this.settle(id, { status: 'decision', decision })
    return true
  }

  cancelAll(sessionId?: string): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      if (sessionId === undefined || pending.request.sessionId === sessionId) {
        this.settle(id, { status: 'cancelled' })
      }
    }
  }

  /** Re-send every live request after a panel has installed its listeners. */
  replay(deliver: (request: ApprovalRequest) => boolean): void {
    for (const { request } of this.pending.values()) {
      if (deliver(request)) this.callbacks.clearNotification(request.id)
    }
  }

  /**
   * The last panel closed: notify for every pending request, and give each
   * the longer no-panel window to be decided in.
   */
  notifyPending(): void {
    for (const pending of this.pending.values()) this.goBackground(pending)
  }

  windowId(id: string): number | undefined {
    return this.pending.get(id)?.windowId
  }

  /** The pending request with this id, if any. */
  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request
  }

  /** How many approvals are waiting on the user. */
  get size(): number {
    return this.pending.size
  }

  private goBackground(pending: PendingApproval): void {
    const deadline = this.now() + Math.max(this.timeoutMs, this.backgroundTimeoutMs())
    if (deadline > pending.deadline) {
      pending.deadline = deadline
      clearTimeout(pending.timer)
      pending.timer = setTimeout(() => { this.settle(pending.request.id, { status: 'timed-out' }) }, deadline - this.now())
    }
    this.callbacks.notify(pending.request, pending.windowId)
    this.callbacks.background?.({
      request: pending.request,
      windowId: pending.windowId,
      ...(pending.toolCallId === undefined ? {} : { toolCallId: pending.toolCallId }),
      deadline: pending.deadline,
    })
  }

  private settle(id: string, result: ApprovalRequestResult): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
    this.callbacks.clearNotification(id)
    this.callbacks.resolved(id)
  }
}
