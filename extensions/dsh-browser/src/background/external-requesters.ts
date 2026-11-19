/**
 * Requester labels of bridge-owned external sessions (MCP clients such as
 * Claude Code, Cursor or Codex driving the browser through the bridge).
 *
 * The bridge stamps each external session's `tool.call` with the client's
 * sanitized, self-reported name. The background remembers it per session so
 * every approval card that session raises says which MCP client is asking,
 * and so Host-session surfaces (panel focus, snapshot injection, resume) can
 * tell such a session apart: it has no DSH conversation behind it.
 *
 * @module
 */

import { isExternalSessionId, isRequesterLabel } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import type { ApprovalPrompt } from '../security/approval.ts'

/** Most external sessions remembered (oldest forgotten first). */
const MAX_REMEMBERED = 64

/** Per-session requester labels of external callers. */
export class ExternalRequesters {
  private readonly labels = new Map<string, string>()

  /** Record the requester of one tool call (ignored for Agent sessions). */
  note(call: { sessionId?: string; requester?: string }): void {
    const { sessionId, requester } = call
    if (!isExternalSessionId(sessionId) || requester === undefined || !isRequesterLabel(requester)) return
    this.labels.delete(sessionId!)
    this.labels.set(sessionId!, requester)
    while (this.labels.size > MAX_REMEMBERED) this.labels.delete(this.labels.keys().next().value as string)
  }

  /** The requester label of a session, when it is an external one. */
  labelOf(sessionId: string | undefined): string | undefined {
    if (!isExternalSessionId(sessionId)) return undefined
    return this.labels.get(sessionId!) ?? 'unknown MCP client'
  }

  /** The prompt, labelled with its external requester when it has one. */
  label<P extends ApprovalPrompt>(prompt: P, sessionId: string | undefined): P {
    const requester = this.labelOf(sessionId)
    return requester === undefined ? prompt : { ...prompt, requester }
  }
}

/** Whether a session id is an external (MCP) session with no DSH conversation. */
export { isExternalSessionId }
