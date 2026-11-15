/**
 * Tool answers shared by every dispatch lane (tools, watchers, fleets,
 * programs, pointer, documents, learning): the answer shapes, plain
 * failures, the cancel answer, and the "approval not granted" answers.
 *
 * Wording note: learning.ts `classifyFailure` skips failure fixtures for
 * messages matching /denied|declined|not approved|timed out|approval request|cancelled/ in
 * addition to the approval decision itself; keep that true for every
 * message built here (answers.spec.ts checks it).
 *
 * @module
 */

import type { ToolError, ToolErrorCode } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** A settled answer whose `ok` narrows it (lanes that always set one or the other). */
export type SettledAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: ToolError }

/** One failed answer. */
export function fail(message: string, code: ToolErrorCode = 'action-failed'): { ok: false; error: { code: ToolErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

/** What a call answers when it was cancelled (kill switch, bridge cancel, expiry). */
export const CANCELLED_MESSAGE = 'Tool call was cancelled'

export function cancelledAnswer(): { ok: false; error: { code: 'action-failed'; message: string } } {
  return { ok: false, error: { code: 'action-failed', message: CANCELLED_MESSAGE } }
}

/** The model-facing text for an ordinary approval card that was not granted. */
export function approvalFailureMessage(prompt: Pick<ApprovalPrompt, 'action'>, authorization: Exclude<ApprovalAuthorization, 'approved'>): string {
  switch (authorization) {
    case 'denied':
      return `The user denied the browser approval request for "${prompt.action}".`
    case 'unavailable':
      return `No browser side panel was available to receive or complete the approval request for "${prompt.action}".`
    case 'timed-out':
      return `The browser approval request for "${prompt.action}" timed out before the user responded.`
    case 'cancelled':
      return `The browser approval request for "${prompt.action}" was cancelled.`
  }
}

/** The answer for an ordinary approval card that was not granted. */
export function approvalFailure(prompt: Pick<ApprovalPrompt, 'action'>, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  const code: ToolErrorCode = authorization === 'timed-out' ? 'timeout' : authorization === 'cancelled' ? 'bridge-closed' : 'action-failed'
  return { ok: false, error: { code, message: approvalFailureMessage(prompt, authorization) } }
}

/**
 * The answer for a lane's own card (watcher, fleet, program) that was not
 * granted: `denied` says the user said no; anything else names the outcome.
 * @param deniedMessage - e.g. "The user declined the tab fleet."
 * @param subject - e.g. "The tab fleet" (→ "The tab fleet was not approved (timed-out).")
 */
export function notApprovedAnswer(
  deniedMessage: string,
  subject: string,
  authorization: Exclude<ApprovalAuthorization, 'approved'>,
): { ok: false; error: { code: 'timeout' | 'action-failed'; message: string } } {
  return {
    ok: false,
    error: {
      code: authorization === 'timed-out' ? 'timeout' : 'action-failed',
      message: authorization === 'denied' ? deniedMessage : `${subject} was not approved (${authorization}).`,
    },
  }
}
