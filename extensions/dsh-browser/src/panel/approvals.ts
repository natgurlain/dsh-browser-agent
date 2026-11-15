import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { isExternalSessionId } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'

/**
 * Characters that render as nothing or reorder text: bidi embeddings,
 * overrides and isolates, zero-width characters, other format controls, and
 * C0/C1 controls other than newline and tab. A model-chosen payload could use
 * them to make the card read differently from what runs.
 */
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻]/g

/**
 * Make invisible and direction-changing characters visible as `⟦U+XXXX⟧`
 * markers so an approved payload reads exactly as it will run.
 */
export function revealInvisible(value: string): string {
  return value.replace(INVISIBLE, (char) => `⟦U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`)
}

/** Whether a card offers the "trust JavaScript on <origin> for this session" box. */
export function offersEvalTrust(request: ApprovalRequest): boolean {
  return request.devTools === true
    && request.action === 'browser_console_eval'
    && request.perCallOnly !== true
    && request.grantOrigin !== undefined
}

/** Whether a card offers the developer-tools session trust button. */
export function offersDevToolsTrust(request: ApprovalRequest): boolean {
  return request.devTools === true
    && request.action !== 'browser_console_eval'
    && request.perCallOnly !== true
    && request.grantOrigin !== undefined
}

/** The decision the Allow button sends, given the eval-trust box state. */
export function allowDecision(request: ApprovalRequest, trustEvalTicked: boolean): ApprovalDecision {
  return trustEvalTicked && offersEvalTrust(request) ? 'trust-eval-session' : 'allow-once'
}

/** Show an approval only after its owning session has finished loading. */
export function approvalReadyForSession(
  request: ApprovalRequest | undefined,
  sessionId: string | null,
  sessionChanging: boolean,
): boolean {
  if (request === undefined || sessionChanging) return false
  return request.sessionId === undefined || request.sessionId === sessionId
}

/** Identify the session the panel must load before presenting an approval. */
export function approvalSessionToFocus(
  request: ApprovalRequest | undefined,
  sessionId: string | null,
  sessionChanging: boolean,
  connected: boolean,
): string | undefined {
  if (!connected || request?.sessionId === undefined || sessionChanging || request.sessionId === sessionId) {
    return undefined
  }
  // MCP clients' external sessions and dev-loop reads for a coding session
  // have no conversation the panel may open (or prompt).
  if (request.requester !== undefined || request.devLoopFor !== undefined || isExternalSessionId(request.sessionId)) {
    return undefined
  }
  return request.sessionId
}
