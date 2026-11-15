/** A `BridgeServer` stand-in that records `requestTool` calls. */
import { vi } from 'vitest'
import type { BridgeServer } from '../../src/server.ts'

/** One recorded `requestTool` call, by parameter name. */
export interface RecordedToolCall {
  name: string
  args: Record<string, unknown>
  signal: AbortSignal
  timeoutMs?: number
  sessionId?: string
  callId?: string
  program?: { id: string; step: number }
  requester?: string
}

type Handler = (name: string, args: Record<string, unknown>, call: RecordedToolCall) => unknown

/**
 * @param handler - the extension's answer per call (defaults to `{ text: 'ok' }`).
 * @returns the bridge, its `requestTool` mock and the recorded calls.
 */
export function fakeBridge(handler: Handler = () => ({ text: 'ok' })) {
  const calls: RecordedToolCall[] = []
  const requestTool = vi.fn(async (
    name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs?: number,
    sessionId?: string, callId?: string, program?: { id: string; step: number }, requester?: string,
  ): Promise<unknown> => {
    const call: RecordedToolCall = {
      name, args, signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(callId === undefined ? {} : { callId }),
      ...(program === undefined ? {} : { program }),
      ...(requester === undefined ? {} : { requester }),
    }
    calls.push(call)
    return handler(name, args, call)
  })
  return { bridge: { requestTool } as unknown as BridgeServer, requestTool, calls }
}

/** Per-tool share of the model-facing description budget (characters). */
export const DESCRIPTION_BUDGET = 170
