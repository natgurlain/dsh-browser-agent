import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { registerBrowserTools } from '../src/tools.ts'
import { registerPdfTool } from '../src/pdf-tools.ts'
import { registerScreenshotTool } from '../src/screenshot-tools.ts'
import { createMcpToolHost, MCP_TOOL_NAMES, type ToolRegistryLike } from '../src/mcp-tools.ts'
import { openExternalSession, resolveMcpToken } from '../src/mcp-mount.ts'
import { memorySessionLedger } from '../src/session-ledger.ts'
import { sessionIdOfExec, withExternalCaller } from '../src/external-caller.ts'

/** A real-enough tool registry: the plugin's definitions, keyed by name. */
function registry() {
  const definitions = new Map<string, Record<string, unknown>>()
  const ctx = {
    tools: {
      register: (definition: { name: string }) => {
        definitions.set(definition.name, definition as unknown as Record<string, unknown>)
        return () => { definitions.delete(definition.name) }
      },
    },
    get: (name: string) => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined,
  } as unknown as Context
  const tools: ToolRegistryLike = {
    schemas: () => [...definitions.values()].map((d) => ({ name: d.name as string, description: d.description as string, parameters: d.parameters })),
    get: (name) => definitions.get(name) as ReturnType<ToolRegistryLike['get']>,
  }
  return { ctx, tools, definitions }
}

const caller = { sessionId: 'mcp-1234', requester: 'claude-code' }

describe('MCP tool host', () => {
  function harness(result: unknown = { text: 'ok' }) {
    const { ctx, tools, definitions } = registry()
    const requestTool = vi.fn(async (..._args: unknown[]): Promise<unknown> => result)
    const bridge = { requestTool } as unknown as BridgeServer
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60, workspacePath: '/tmp/ws' })
    registerScreenshotTool(ctx, bridge, { toolTimeoutMs: 1_000 })
    registerPdfTool(ctx, bridge, { toolTimeoutMs: 1_000, workspacePath: '/tmp/ws' })
    // A foreign harness tool must never be served.
    ctx.tools.register({ name: 'bash', description: 'Run a shell command.', parameters: {} } as never)
    const taint = vi.fn()
    const host = createMcpToolHost(() => tools, { requestTool }, 1_000, taint)
    return { host, requestTool, definitions, taint }
  }

  it('lists exactly the bridge\'s browser tools with their DSH schemas and descriptions', () => {
    const { host, definitions } = harness()
    const listed = host.list()
    expect(listed.some((tool) => tool.name === 'bash')).toBe(false)
    expect(host.has('bash')).toBe(false)
    const click = listed.find((tool) => tool.name === 'browser_click')!
    expect(click.description).toBe(definitions.get('browser_click')!.description)
    expect(click.inputSchema).toEqual(definitions.get('browser_click')!.parameters)
    expect(listed.every((tool) => MCP_TOOL_NAMES.has(tool.name))).toBe(true)
  })

  it('runs the registered definition under the external session, labelled with the requester', async () => {
    const { host, requestTool } = harness({ text: 'Clicked.' })
    const signal = new AbortController().signal
    const result = await host.call('browser_click', { index: 3 }, caller, signal)
    expect(result).toEqual({ content: [{ type: 'text', text: 'Clicked.' }] })
    const [name, args, passedSignal, timeout, sessionId, callId, program, requester] = requestTool.mock.calls[0]!
    expect(program).toBeUndefined()
    expect([name, args, passedSignal, timeout, sessionId, requester]).toEqual(['browser_click', { index: 3 }, signal, 1_000, 'mcp-1234', 'claude-code'])
    expect(callId).toMatch(/^mcp-call-/u)
  })

  it('records Host-side taint for the external session after a page-quoting call', async () => {
    const { host, taint } = harness({ text: 'Page text' })
    await host.call('browser_get_text', {}, caller, new AbortController().signal)
    expect(taint).toHaveBeenCalledWith('mcp-1234', 'browser_get_text')
    taint.mockClear()
    await host.call('browser_follow_tab', { tabId: 3 }, caller, new AbortController().signal)
    expect(taint).not.toHaveBeenCalled()
  })

  it('validates arguments with the tool\'s own schema', async () => {
    const { host, requestTool } = harness()
    const result = await host.call('browser_click', { index: 'three' }, caller, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('reports extension failures as tool errors', async () => {
    const { host, requestTool } = harness()
    requestTool.mockRejectedValueOnce(Object.assign(new Error('The user denied this browser action.'), { code: 'action-failed' }))
    const result = await host.call('browser_press', { key: 'Enter' }, caller, new AbortController().signal)
    expect(result).toEqual({ content: [{ type: 'text', text: 'The user denied this browser action. (action-failed)' }], isError: true })
  })

  it('refuses workspace writes for external callers before touching the page', async () => {
    const { host, requestTool } = harness()
    const pdf = await host.call('browser_save_pdf', {}, caller, new AbortController().signal)
    expect(pdf.isError).toBe(true)
    expect(pdf.content[0]).toMatchObject({ text: expect.stringContaining('external (MCP) clients') })
    const extract = await host.call('browser_extract', { selector: 'table', saveTo: 'out.csv' }, caller, new AbortController().signal)
    expect(extract.isError).toBe(true)
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('returns screenshots as MCP image blocks', async () => {
    const { host, requestTool } = harness({ image: { data: 'iVBORw0', mediaType: 'image/png', width: 10, height: 5 } })
    const result = await host.call('browser_screenshot', { format: 'png' }, caller, new AbortController().signal)
    expect(result.content).toEqual([
      { type: 'text', text: 'Screenshot of the controlled tab\'s viewport (10x5).' },
      { type: 'image', data: 'iVBORw0', mimeType: 'image/png' },
    ])
    expect(requestTool.mock.calls[0]![4]).toBe('mcp-1234')
    expect((await host.call('browser_screenshot', { format: 'gif' }, caller, new AbortController().signal)).isError).toBe(true)
  })
})

describe('external caller identity', () => {
  it('prefers the Agent and never fabricates one', () => {
    expect(sessionIdOfExec({ agent: { id: 'a-1' } })).toBe('a-1')
    expect(sessionIdOfExec({})).toBeUndefined()
    const exec = withExternalCaller({}, caller)
    expect(sessionIdOfExec(exec)).toBe('mcp-1234')
    expect(Object.keys(exec)).toEqual([])
    expect((exec as { agent?: unknown }).agent).toBeUndefined()
  })
})

describe('MCP mount helpers', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('mints a 0600 token once and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-'))
    dirs.push(dir)
    const file = join(dir, 'browser-mcp-token')
    const token = await resolveMcpToken(file)
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(readFileSync(file, 'utf8').trim()).toBe(token)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await resolveMcpToken(file)).toBe(token)
  })

  it('records each client connection as an external session with a sanitized label', async () => {
    const ledger = memorySessionLedger()
    const opened = await openExternalSession(ledger, 'Claude‮ Code\n\u0000 (evil)')
    expect(opened.sessionId).toMatch(/^mcp-[0-9a-f-]{36}$/u)
    expect(opened.requester).toBe('Claude Code (evil)')
    expect(ledger.external(opened.sessionId)).toMatchObject({ kind: 'mcp', client: 'Claude Code (evil)' })
    expect(ledger.has(opened.sessionId)).toBe(false)
    expect((await openExternalSession(ledger, '')).requester).toBe('unknown client')
  })
})
