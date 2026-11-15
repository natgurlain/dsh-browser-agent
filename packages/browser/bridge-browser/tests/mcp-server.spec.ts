import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpHttpServer, MCP_PROTOCOL_VERSIONS, type McpCaller, type McpToolHost } from '../src/mcp-server.ts'

const TOKEN = 't'.repeat(16) + 'X9-abcdefghijklmnop'

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: unknown }

/** Raw HTTP so the test controls Host and Origin (fetch forbids both). */
function send(port: number, init: {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  raw?: string
}): Promise<Reply> {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: init.method ?? 'POST',
      headers: {
        host: `127.0.0.1:${String(port)}`,
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...init.headers,
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text === '' ? undefined : JSON.parse(text) as unknown })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const servers: McpHttpServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

function host(overrides: Partial<McpToolHost> = {}): McpToolHost & { calls: Array<{ name: string; args: unknown; caller: McpCaller }> } {
  const calls: Array<{ name: string; args: unknown; caller: McpCaller }> = []
  return {
    calls,
    list: () => [{ name: 'browser_click', description: 'Click.', inputSchema: { type: 'object', properties: {} } }],
    has: (name) => name === 'browser_click',
    call: async (name, args, caller) => {
      calls.push({ name, args, caller })
      return { content: [{ type: 'text', text: 'Clicked.' }] }
    },
    ...overrides,
  }
}

async function start(tools: McpToolHost = host(), extra: Partial<ConstructorParameters<typeof McpHttpServer>[0]> = {}) {
  let n = 0
  const openSession = vi.fn(async (clientName: string): Promise<McpCaller> => ({ sessionId: `mcp-${String(++n)}`, requester: clientName }))
  const server = new McpHttpServer({ token: TOKEN, tools, openSession, serverInfo: { name: 'dsh-browser', version: '0' }, ...extra })
  servers.push(server)
  const bound = await server.listen(0)
  return { server, address: bound.address, port: bound.port, url: bound.url, openSession }
}

async function initialize(port: number, clientInfo: Record<string, unknown> = { name: 'claude-code', version: '1' }) {
  const answer = await send(port, {
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo } },
  })
  expect(answer.status).toBe(200)
  const session = answer.headers['mcp-session-id'] as string
  expect(typeof session).toBe('string')
  return { session, answer }
}

describe('McpHttpServer', () => {
  it('binds the loopback interface only', async () => {
    const { address, url } = await start()
    // The socket's own address, not a literal: binding 0.0.0.0 would fail here.
    expect(address).toBe('127.0.0.1')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
  })

  it('refuses a missing or wrong token, any Origin, a foreign Host, and non-JSON bodies before anything runs', async () => {
    const tools = host()
    const { port, openSession } = await start(tools)
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    expect((await send(port, { body: init, headers: { authorization: '' } })).status).toBe(401)
    expect((await send(port, { body: init, headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await send(port, { body: init, headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await send(port, { body: init, headers: { origin: 'null' } })).status).toBe(403)
    // DNS rebinding: a page on evil.example resolved to 127.0.0.1 still sends its own Host.
    expect((await send(port, { body: init, headers: { host: `evil.example:${String(port)}` } })).status).toBe(403)
    expect((await send(port, { body: init, headers: { host: '127.0.0.1:1' } })).status).toBe(403)
    expect((await send(port, { body: init, headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await send(port, { body: init, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    expect(openSession).not.toHaveBeenCalled()
    expect(tools.calls).toEqual([])
  })

  it('refuses non-loopback peers', async () => {
    const { port } = await start(host(), { remoteAddressOverride: '192.168.1.5' })
    expect((await send(port, { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(403)
  })

  it('initializes one external session per client connection and negotiates the protocol version', async () => {
    const { port, openSession } = await start()
    const { session, answer } = await initialize(port, { name: 'cursor', title: 'Cursor', version: '1' })
    expect(openSession).toHaveBeenCalledWith('Cursor')
    expect(answer.body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-browser' } } })
    const second = await initialize(port)
    expect(second.session).not.toBe(session)
    const future = await send(port, { body: { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } } })
    expect((future.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0])
  })

  it('lists and calls tools for the session\'s external caller', async () => {
    const tools = host()
    const { port } = await start(tools)
    const { session } = await initialize(port)
    const headers = { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' }
    expect((await send(port, { headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202)
    const listed = await send(port, { headers, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })
    expect(listed.body).toMatchObject({ result: { tools: [{ name: 'browser_click' }] } })
    const called = await send(port, { headers, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_click', arguments: { index: 2 } } } })
    expect(called.body).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Clicked.' }] } })
    expect(tools.calls).toEqual([{ name: 'browser_click', args: { index: 2 }, caller: { sessionId: 'mcp-1', requester: 'claude-code' } }])
    const unknown = await send(port, { headers, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bash', arguments: {} } } })
    expect(unknown.body).toMatchObject({ id: 4, error: { code: -32602 } })
    const nope = await send(port, { headers, body: { jsonrpc: '2.0', id: 5, method: 'resources/list' } })
    expect(nope.body).toMatchObject({ id: 5, error: { code: -32601 } })
    expect((await send(port, { headers, body: { jsonrpc: '2.0', id: 6, method: 'ping' } })).body).toEqual({ jsonrpc: '2.0', id: 6, result: {} })
  })

  it('requires a known session, ends it on DELETE, and refuses batches and server streams', async () => {
    const { port, server } = await start()
    const call = { jsonrpc: '2.0', id: 9, method: 'tools/list' }
    expect((await send(port, { body: call })).status).toBe(400)
    expect((await send(port, { body: call, headers: { 'mcp-session-id': 'forged' } })).status).toBe(404)
    const { session } = await initialize(port)
    expect((await send(port, { body: [call], headers: { 'mcp-session-id': session } })).status).toBe(400)
    expect((await send(port, { method: 'GET', headers: { 'mcp-session-id': session } })).status).toBe(405)
    expect((await send(port, { body: call, headers: { 'mcp-session-id': session, 'mcp-protocol-version': '1999-01-01' } })).status).toBe(400)
    expect((await send(port, { raw: '{', headers: { 'mcp-session-id': session } })).status).toBe(400)
    expect(server.sessionCount()).toBe(1)
    expect((await send(port, { method: 'DELETE', headers: { 'mcp-session-id': session } })).status).toBe(204)
    expect(server.sessionCount()).toBe(0)
    expect((await send(port, { body: call, headers: { 'mcp-session-id': session } })).status).toBe(404)
  })

  it('bounds bodies', async () => {
    const { port } = await start(host(), { maxBodyBytes: 64 })
    expect((await send(port, { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: 'x'.repeat(200) } } })).status).toBe(413)
  })

  it('aborts an in-flight call on notifications/cancelled', async () => {
    let seen: AbortSignal | undefined
    const tools = host({
      call: (_name, _args, _caller, signal) => {
        seen = signal
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => { resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true }) })
        })
      },
    })
    const { port } = await start(tools)
    const { session } = await initialize(port)
    const headers = { 'mcp-session-id': session }
    const pending = send(port, { headers, body: { jsonrpc: '2.0', id: 'c1', method: 'tools/call', params: { name: 'browser_click', arguments: {} } } })
    await vi.waitFor(() => { expect(seen).toBeDefined() })
    expect((await send(port, { headers, body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'c1' } } })).status).toBe(202)
    expect(seen?.aborted).toBe(true)
    expect((await pending).body).toMatchObject({ id: 'c1', result: { isError: true } })
  })

  it('aborts an in-flight call when the client drops the HTTP request', async () => {
    let seen: AbortSignal | undefined
    const tools = host({
      call: (_name, _args, _caller, signal) => {
        seen = signal
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => { resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true }) })
        })
      },
    })
    const { port } = await start(tools)
    const { session } = await initialize(port)
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'd1', method: 'tools/call', params: { name: 'browser_click', arguments: {} } })
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        host: `127.0.0.1:${String(port)}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-session-id': session,
      },
    })
    req.on('error', () => {})
    req.end(body)
    await vi.waitFor(() => { expect(seen).toBeDefined() })
    expect(seen?.aborted).toBe(false)
    req.destroy()
    await vi.waitFor(() => { expect(seen?.aborted).toBe(true) })
  })

  it('expires idle sessions and evicts the least recently used one when full', async () => {
    let now = 0
    const { port, server } = await start(host(), { maxSessions: 2, idleMs: 1_000, now: () => now })
    const first = await initialize(port)
    now = 10
    await initialize(port)
    now = 20
    await initialize(port)
    expect(server.sessionCount()).toBe(2)
    expect((await send(port, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'mcp-session-id': first.session } })).status).toBe(404)
    now = 5_000
    expect((await send(port, { body: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { 'mcp-session-id': 'x' } })).status).toBe(404)
    expect(server.sessionCount()).toBe(0)
  })
})
