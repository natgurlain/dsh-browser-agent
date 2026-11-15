/**
 * The MCP endpoint's tool surface: the bridge's own registered `browser_*`
 * tool definitions, read from `ctx.tools` (same names, descriptions and
 * schemas DSH Agents see) and executed through those same definitions with an
 * external-caller execution (external-caller.ts). Nothing here talks to the
 * extension directly except `browser_screenshot`, whose Agent result is an
 * attachment reference: for MCP the same wire call is answered with an image
 * block instead.
 *
 * Tools that write files into a DSH workspace refuse external callers.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { McpCallResult, McpCaller, McpContent, McpTool, McpToolHost } from './mcp-server.ts'
import { bridgeCallArgs, withExternalCaller } from './external-caller.ts'
import { DEVTOOLS_TOOL_NAMES } from './protocol.ts'
import { BROWSER_TOOL_NAMES } from './tools.ts'
import { resultTaintsSession } from './session-taint.ts'

/** Every tool name the endpoint may serve (when currently registered). */
export const MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...BROWSER_TOOL_NAMES,
  'browser_screenshot',
  'browser_save_pdf',
  ...DEVTOOLS_TOOL_NAMES,
])

/** The registry slice this module reads. */
export interface ToolRegistryLike {
  schemas(): ReadonlyArray<{ name: string; description: string; parameters: unknown }>
  get(name: string): {
    execute(args: unknown, exec: never): Promise<unknown>
    output: { render(args: unknown, value: never): ReadonlyArray<{ type: string; text?: string }> }
  } | undefined
}

/** The bridge slice this module uses (screenshot only). */
export interface BridgeLike {
  requestTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs?: number,
    sessionId?: string, callId?: string, program?: undefined, requester?: string): Promise<unknown>
}

/**
 * Build the MCP tool host.
 * @param tools - `ctx.tools` (global view: no Agent scope).
 * @param bridge - the bridge server (screenshot wire call).
 * @param toolTimeoutMs - per-call budget for the screenshot wire call.
 */
export function createMcpToolHost(
  tools: () => ToolRegistryLike | undefined,
  bridge: BridgeLike,
  toolTimeoutMs: number,
  /** Record Host-side taint for the external session (session-taint.ts lineage). */
  taint: (sessionId: string, tool: string) => void = () => {},
): McpToolHost {
  const served = (name: string): boolean => MCP_TOOL_NAMES.has(name) && tools()?.get(name) !== undefined
  return {
    has: served,
    list: (): McpTool[] => (tools()?.schemas() ?? [])
      .filter((schema) => MCP_TOOL_NAMES.has(schema.name))
      .map((schema) => ({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.parameters as Record<string, unknown>,
      })),
    call: async (name, args, caller, signal): Promise<McpCallResult> => {
      const definition = served(name) ? tools()?.get(name) : undefined
      if (definition === undefined) return failure(`unknown tool ${JSON.stringify(name)}`)
      const callId = `mcp-call-${randomUUID()}`
      const exec = withExternalCaller({
        callId,
        rootCallId: callId,
        name,
        arguments: args,
        signal,
        token: {},
        deferContext: () => {},
        concludeTurn: () => {},
      }, caller)
      try {
        if (name === 'browser_screenshot') return await screenshot(bridge, args, exec, toolTimeoutMs, caller)
        const value = await definition.execute(args, exec as never)
        return { content: toMcpContent(definition.output.render(args, value as never)) }
      } catch (error: unknown) {
        return failure(errorText(error))
      } finally {
        // Same rule as DSH sessions: page-quoting results (errors included) taint.
        if (resultTaintsSession(name)) taint(caller.sessionId, name)
      }
    },
  }
}

async function screenshot(bridge: BridgeLike, args: Record<string, unknown>, exec: object, toolTimeoutMs: number, _caller: McpCaller): Promise<McpCallResult> {
  const format = args.format ?? 'png'
  if (format !== 'png' && format !== 'jpeg') return failure('format must be "png" or "jpeg"')
  if (args.quality !== undefined && (typeof args.quality !== 'number' || !Number.isFinite(args.quality))) return failure('quality must be a number')
  for (const key of Object.keys(args)) if (key !== 'format' && key !== 'quality') return failure(`unknown argument ${JSON.stringify(key)}`)
  const wire = { format, ...(format === 'jpeg' && args.quality !== undefined ? { quality: args.quality } : {}) }
  const result = await bridge.requestTool('browser_screenshot', wire, (exec as { signal: AbortSignal }).signal, toolTimeoutMs, ...bridgeCallArgs(exec)) as {
    image?: { data?: unknown; mediaType?: unknown; width?: unknown; height?: unknown }
  }
  const image = result.image
  if (typeof image?.data !== 'string' || (image.mediaType !== 'image/png' && image.mediaType !== 'image/jpeg')) {
    return failure('The browser returned no usable screenshot.')
  }
  const size = typeof image.width === 'number' && typeof image.height === 'number' ? ` (${String(image.width)}x${String(image.height)})` : ''
  return {
    content: [
      { type: 'text', text: `Screenshot of the controlled tab's viewport${size}.` },
      { type: 'image', data: image.data, mimeType: image.mediaType },
    ],
  }
}

function toMcpContent(blocks: ReadonlyArray<{ type: string; text?: string }>): McpContent[] {
  const content: McpContent[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
  }
  return content.length === 0 ? [{ type: 'text', text: '(no text result)' }] : content
}

function failure(text: string): McpCallResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? `${error.message} (${code})` : error.message
  }
  return String(error)
}
