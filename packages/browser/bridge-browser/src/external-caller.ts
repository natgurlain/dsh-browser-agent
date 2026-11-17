/**
 * Execution identity for browser tool calls that do not come from a DSH
 * Agent: an external MCP client acting under a bridge-owned external session
 * (mcp-server.ts). The same registered tool definitions run for both; this
 * module tells their dispatchers which session a call belongs to.
 *
 * An external call carries no `exec.agent` (there is no Agent to fake); the
 * session id and requester label ride on a private symbol instead, so no
 * DSH-side code mistakes the call for an Agent's.
 *
 * @module
 */

import { toolCallIdArg } from './server.ts'

/** Who an external call acts for. */
export interface ExternalCaller {
  /** Bridge-owned external session id (`mcp-…`). */
  sessionId: string
  /** Sanitized requester label for approval cards. */
  requester: string
}

const EXTERNAL_CALLER = Symbol('dsh-browser-agent.external-caller')

/**
 * Tag an execution object as an external caller's.
 * @param exec - the execution object handed to a tool's execute.
 * @param caller - the external session and requester.
 * @returns the same object, tagged.
 */
export function withExternalCaller<T extends object>(exec: T, caller: ExternalCaller): T {
  Object.defineProperty(exec, EXTERNAL_CALLER, { value: Object.freeze({ ...caller }), enumerable: false })
  return exec
}

/** The external caller of an execution, when it has one. */
export function externalCallerOf(exec: object): ExternalCaller | undefined {
  return (exec as { [EXTERNAL_CALLER]?: ExternalCaller })[EXTERNAL_CALLER]
}

/**
 * The session a browser tool call belongs to: the Agent's id, else the
 * external caller's session, else none (agentless call).
 */
export function sessionIdOfExec(exec: object): string | undefined {
  const agent = (exec as { agent?: { id?: unknown } }).agent
  if (agent !== undefined) return String(agent.id)
  return externalCallerOf(exec)?.sessionId
}

/**
 * The trailing `requestTool` arguments for one execution: nothing for an
 * agentless call; `[sessionId, callId?]` for an Agent; and
 * `[sessionId, callId | undefined, program: undefined, requester]` for an
 * external caller (never part of a `browser_run` program).
 */
export function bridgeCallArgs(exec: object): [] | [string] | [string, string] | [string, string | undefined, undefined, string] {
  const agent = (exec as { agent?: { id?: unknown } }).agent
  if (agent !== undefined) return [String(agent.id), ...toolCallIdArg(exec)]
  const external = externalCallerOf(exec)
  if (external === undefined) return []
  return [external.sessionId, toolCallIdArg(exec)[0], undefined, external.requester]
}

/** Thrown when an external caller asks for a tool that writes files on this machine. */
export const EXTERNAL_WRITE_REFUSAL = 'This tool writes files into a DSH workspace, which external (MCP) clients cannot do through the browser bridge; '
  + 'read the data and save it with your own tools instead. Nothing was written.'
