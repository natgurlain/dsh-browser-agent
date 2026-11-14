/**
 * Adapter from the bridge's forwarded browser approvals to dsh's own approval
 * service (`ctx.approval`, @deepseek-ai/dsh-user-approval). The service fans
 * the question out to every composed answerer (the web UI, the CLI, SDK
 * clients); the first answer wins and anything but `allowed-once` is no grant.
 *
 * The service is optional at runtime (a host may not compose it), so it is
 * resolved lazily and typed structurally; without it, or without a live agent
 * for the session, the request fails closed as `unavailable`.
 *
 * @module
 */

import type { HostApprovalOutcome, HostApprovalRequest } from './server.ts'

/** The slice of dsh's ApprovalService this adapter uses. */
export interface ApprovalServiceLike {
  request(request: {
    agent: never
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<unknown>
}

/** The slice of dsh's AgentRegistry this adapter uses. */
export interface AgentLookup {
  get(id: never): unknown
}

const OUTCOMES: ReadonlySet<unknown> = new Set<HostApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * Build the bridge's `requestHostApproval` dependency.
 * @param approval - resolves the live approval service (or undefined).
 * @param agents - resolves a live agent by session id.
 * @returns a requester that never throws and never grants by accident.
 */
export function createHostApprovalRequester(
  approval: () => ApprovalServiceLike | undefined,
  agents: () => AgentLookup | undefined,
): (request: HostApprovalRequest) => Promise<HostApprovalOutcome> {
  return async ({ sessionId, toolName, reason, signal }) => {
    if (signal.aborted) return 'cancelled'
    const service = approval()
    const agent = agents()?.get(sessionId as never)
    if (service === undefined || agent === undefined || agent === null) return 'unavailable'
    try {
      const outcome = await service.request({ agent: agent as never, toolName, reason, signal })
      return OUTCOMES.has(outcome) ? outcome as HostApprovalOutcome : 'unavailable'
    } catch {
      // No open turn, a failed audit append, or a throwing answerer.
      return 'unavailable'
    }
  }
}
