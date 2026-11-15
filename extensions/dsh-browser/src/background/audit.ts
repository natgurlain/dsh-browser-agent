/**
 * What one agent call records for the bridge's audit log, gathered while it
 * is dispatched: the approval outcome, the policy outcome, the page, the
 * pause hold, strict mode and commit-gate decisions. index.ts sends the note
 * ahead of the call's tool.result.
 *
 * @module
 */

import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import type { CallPolicyHook } from './tools.ts'

/** The audit fields of one in-flight call. */
export interface AuditedCall {
  tabId?: number
  /** Approval outcome reported to the audit log. */
  decision?: string
  /** Page URL when the call ran. */
  url?: string
  /** Time spent held by the user's pause. */
  heldMs?: number
  /** Policy-layer outcome: blocked, tainted, site-ask, site-trusted. */
  policy?: string
  policyReason?: string
  /** Strict mode (commit gate) covered this call: armed, or refused because it could not intercept. */
  strict?: 'armed' | 'refused'
  /** Commit-gate decisions on writes the page made during this call. */
  commit?: string[]
}

/**
 * Record the approval outcome of one call: `allowed` only when the user
 * approved a card, `auto-allowed` when a standing rule (a trusted site, a
 * session grant) passed it without one.
 */
export function auditedAuthorize(
  audited: AuditedCall,
  authorize: (prompt: ApprovalPrompt, onPrompt: () => void) => Promise<ApprovalAuthorization>,
): (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization> {
  return async (prompt) => {
    let prompted = false
    const result = await authorize(prompt, () => { prompted = true })
    audited.decision = result === 'approved' ? (prompted ? 'allowed' : 'auto-allowed') : result
    return result
  }
}

/** Remember what the policy layer (site rules, managed policy, taint) decided. */
export function auditedPolicy(audited: AuditedCall, hook: CallPolicyHook): CallPolicyHook {
  return (call, targets) => {
    const decision = hook(call, targets)
    if (decision.kind === 'deny') {
      audited.policy = 'blocked'
      audited.policyReason = decision.message
    } else if (decision.kind === 'force') {
      // Only a site "ask" rule is "site-ask"; any taint (or an unattributed force) is "tainted".
      const causes = decision.causes ?? []
      audited.policy = causes.length > 0 && causes.every((cause) => cause === 'site-ask') ? 'site-ask' : 'tainted'
      audited.policyReason = decision.reasons.join(' ')
    } else if (decision.kind === 'trust') {
      audited.policy = 'site-trusted'
    }
    return decision
  }
}

/** Note the page a call runs on; `strict` says whether strict mode covers it. */
export function noteCallTarget<T extends { id?: number; url?: string }>(audited: AuditedCall, target: T, strict: boolean): T {
  if (target.url !== undefined) audited.url = target.url
  if (target.id !== undefined) audited.tabId ??= target.id
  if (strict) audited.strict = 'armed'
  return target
}

/** The audit note for one settled call (sent as the audit-record RPC payload). */
export function auditNote(callId: string, audited: AuditedCall, navigatedTo?: string): Record<string, unknown> {
  const decision = audited.decision ?? 'not-required'
  return {
    callId,
    decision,
    ...(audited.url === undefined ? {} : { url: audited.url }),
    ...(navigatedTo === undefined ? {} : { navigatedTo }),
    ...(audited.heldMs === undefined ? {} : { heldMs: audited.heldMs }),
    ...(audited.policy === undefined ? {} : { policy: audited.policy }),
    ...(audited.policyReason === undefined ? {} : { policyReason: audited.policyReason.slice(0, 1_000) }),
    ...(audited.strict === undefined ? {} : { strict: audited.strict }),
    ...(audited.commit === undefined ? {} : { commit: audited.commit.slice(0, 20) }),
  }
}
