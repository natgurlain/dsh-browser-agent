/**
 * The bridge's own audit RPCs, kept out of server.ts so the transport only
 * routes them. `bridge.audit.record` is applied synchronously, before the
 * server yields, so an annotation sent ahead of its `tool.result` frame is
 * always written ahead of the result entry.
 *
 * @module @natgurlain/dsh-bridge-browser/src/audit-rpc
 */

import type { AuditAnnotation, BridgeAuditObserver } from './audit-log.ts'
import { BRIDGE_AUDIT_EXPORT_METHOD, BRIDGE_AUDIT_RECORD_METHOD } from './protocol.ts'
import { errorMessage, isRecord } from './host-api.ts'

/** What the server hands the audit RPC handler. */
export interface AuditRpcContext {
  /** Registry key of the extension connection that sent the RPC. */
  connection?: string
  /** Whether that connection is the one the call was dispatched to. */
  ownsCall?: (callId: string) => boolean
  audit?: BridgeAuditObserver
  exportAudit?: (sessionId: string | undefined) => Promise<unknown>
  allowsSession?: (sessionId: string) => Promise<boolean>
  /** The user engaged the kill switch: revoke standing grants (schedules, dev-loop links). */
  onKillSwitch?: (connection: string | undefined) => void
}

/** One RPC answer. */
export type AuditRpcAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

const ANNOTATION_STRINGS = ['decision', 'url', 'navigatedTo', 'policy', 'policyReason', 'strict'] as const

/**
 * Handle one audit RPC.
 * @returns undefined when `method` is not an audit method.
 */
export function handleAuditRpc(method: string, payload: unknown, context: AuditRpcContext): Promise<AuditRpcAnswer> | undefined {
  if (method === BRIDGE_AUDIT_RECORD_METHOD) return Promise.resolve(record(payload, context))
  if (method === BRIDGE_AUDIT_EXPORT_METHOD) return exportLog(payload, context)
  return undefined
}

function record(payload: unknown, context: AuditRpcContext): AuditRpcAnswer {
  if (!isRecord(payload)) return badRequest('payload must be an object')
  if (payload.event === 'kill-switch') {
    context.audit?.killSwitch(context.connection)
    context.onKillSwitch?.(context.connection)
    return { ok: true, result: { recorded: context.audit !== undefined } }
  }
  if (typeof payload.callId !== 'string' || payload.callId === '') return badRequest('callId must be a non-empty string')
  const annotation: AuditAnnotation = {}
  for (const key of ANNOTATION_STRINGS) {
    const value = payload[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > 4096) return badRequest(`${key} must be a string`)
    annotation[key] = value
  }
  if (payload.commit !== undefined) {
    if (!Array.isArray(payload.commit) || payload.commit.length > 20 || !payload.commit.every((entry) => typeof entry === 'string' && entry.length <= 32)) {
      return badRequest('commit must be a short list of decisions')
    }
    annotation.commit = payload.commit as string[]
  }
  if (payload.heldMs !== undefined) {
    if (typeof payload.heldMs !== 'number' || !Number.isFinite(payload.heldMs) || payload.heldMs < 0) return badRequest('heldMs must be a non-negative number')
    annotation.heldMs = Math.round(payload.heldMs)
  }
  if (context.ownsCall !== undefined && !context.ownsCall(payload.callId)) {
    return { ok: false, error: { code: 'forbidden', message: 'the call was not dispatched to this connection' } }
  }
  context.audit?.annotated(payload.callId, annotation)
  return { ok: true, result: { recorded: context.audit !== undefined } }
}

async function exportLog(payload: unknown, context: AuditRpcContext): Promise<AuditRpcAnswer> {
  if (context.exportAudit === undefined) return { ok: false, error: { code: 'unavailable', message: 'the audit log is disabled' } }
  if (payload !== undefined && !isRecord(payload)) return badRequest('payload must be an object')
  const sessionId = payload?.sessionId
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.trim() === '')) {
    return badRequest('sessionId must be a non-empty string')
  }
  if (sessionId !== undefined && context.allowsSession !== undefined && !await context.allowsSession(sessionId).catch(() => false)) {
    return { ok: false, error: { code: 'forbidden', message: `session ${JSON.stringify(sessionId)} is not available to the browser bridge` } }
  }
  try {
    return { ok: true, result: await context.exportAudit(sessionId) }
  } catch (error: unknown) {
    return { ok: false, error: { code: 'internal', message: errorMessage(error) } }
  }
}

function badRequest(message: string): AuditRpcAnswer {
  return { ok: false, error: { code: 'bad-request', message } }
}
