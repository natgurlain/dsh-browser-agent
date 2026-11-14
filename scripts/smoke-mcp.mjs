/**
 * Runtime smoke for the bridge's MCP endpoint (Phase 3.2), run by
 * smoke-runtime.mjs against a real DSH host with `mcp.enabled: true`.
 *
 * A real MCP client (`@modelcontextprotocol/client`) launches the
 * `dsh-browser-mcp` stdio shim, which proxies to the bridge's loopback
 * endpoint. A bridge client stands in for the browser extension and its side
 * panel: it receives the external session's `tool.call` frames, checks the
 * requester label the approval card would show, sees that the bridge refuses
 * to put the approval to dsh (the panel answers it), and answers allow/deny.
 */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * @param {object} deps
 * @param {string} deps.root - repository root.
 * @param {string} deps.home - DSH_HOME of the smoke host.
 * @param {string} deps.wsUrl - bridge WebSocket URL.
 * @param {Function} deps.connectClient - authenticated bridge client factory.
 * @param {Function} deps.waitFor - polling helper.
 * @param {object} deps.methods - protocol constants.
 */
export async function smokeMcp({ root, home, wsUrl, connectClient, waitFor, methods }) {
  const { Client } = await import('@modelcontextprotocol/client')
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')

  // The plugin wrote its endpoint and a separate token, both private.
  const endpointFile = join(home, 'browser-mcp.json')
  const tokenFile = join(home, 'browser-mcp-token')
  const endpoint = await waitFor(async () => {
    try { return JSON.parse(await readFile(endpointFile, 'utf8')) } catch { return undefined }
  }, 'MCP endpoint file', 30_000)
  assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u, 'the MCP endpoint listens on loopback only')
  if (process.platform !== 'win32') {
    assert.equal((await stat(endpointFile)).mode & 0o777, 0o600)
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600)
  }
  const token = (await readFile(tokenFile, 'utf8')).trim()
  assert.notEqual(token, (await readFile(join(home, 'ext-bridge-token'), 'utf8').catch(() => '')).trim(),
    'the MCP token is not the extension bridge token')

  // Transport refusals before any session exists.
  const url = new URL(endpoint.url)
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: url.port, path: '/mcp', method: 'POST', headers: {
      host: url.host, 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers,
    } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
  })
  assert.equal(await raw({ authorization: 'Bearer wrong' }), 401, 'a wrong MCP token is refused')
  assert.equal(await raw({ origin: 'https://evil.example' }), 403, 'a browser Origin is refused (CSRF)')
  assert.equal(await raw({ host: `rebind.example:${url.port}` }), 403, 'a foreign Host is refused (DNS rebinding)')

  // The extension + side panel stand-in.
  const caps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60, client: { id: 'smoke-mcp-panel-01', browser: 'chrome' } }
  const panel = await connectClient(wsUrl, caps)
  const toolCalls = () => panel.frames.filter(value => value.t === 'tool.call')

  const client = new Client({ name: 'smoke-mcp-client', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'packages/browser/mcp-server/bin/dsh-browser-mcp.mjs')],
    env: { PATH: process.env.PATH ?? '', DSH_HOME: home },
    stderr: 'pipe',
  })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    for (const expected of ['browser_snapshot', 'browser_click', 'browser_press', 'browser_navigate', 'browser_screenshot']) {
      assert.ok(names.includes(expected), `MCP lists ${expected}`)
    }
    assert.ok(names.every(name => name.startsWith('browser_')), `MCP lists browser tools only: ${names.join(', ')}`)
    const press = tools.find(tool => tool.name === 'browser_press')
    assert.equal(press.inputSchema.type, 'object')
    assert.ok(press.description.length > 20, 'the DSH description is carried over')

    const pressThroughMcp = async (decision) => {
      // The stand-in is the most recently active install, so the call routes to it.
      await panel.request('session.list', {})
      const before = toolCalls().length
      const result = client.callTool({ name: 'browser_press', arguments: { key: 'Enter' } })
      const call = await waitFor(() => toolCalls()[before], 'MCP tool call at the extension', 30_000)
      assert.equal(call.name, 'browser_press')
      assert.deepEqual(call.args, { key: 'Enter' })
      assert.match(call.sessionId, /^mcp-[0-9a-f-]{36}$/u, 'the call carries the bridge-owned external session')
      assert.equal(call.requester, 'smoke-mcp-client', 'the approval card can say which MCP client is asking')
      // No DSH turn exists for an MCP session: the bridge never forwards its approvals to dsh.
      const asked = await panel.request(methods.BRIDGE_APPROVAL_ASK_METHOD, {
        toolCallId: call.id, approvalId: `smoke-mcp-${randomUUID()}`, binding: 'c'.repeat(64), reason: 'Press Enter (MCP)',
      })
      assert.equal(asked.ok, true, JSON.stringify(asked))
      assert.equal(asked.result.decision, 'unavailable', 'MCP approvals are answered in the browser only')
      // The side panel answers the card.
      panel.send(decision === 'allow'
        ? { t: 'tool.result', id: call.id, ok: true, result: { text: 'Pressed Enter.' } }
        : { t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'The user denied this browser action.' } })
      return { call, result: await result }
    }

    const allowed = await pressThroughMcp('allow')
    assert.deepEqual(allowed.result.content, [{ type: 'text', text: 'Pressed Enter.' }])
    assert.notEqual(allowed.result.isError, true)
    const denied = await pressThroughMcp('deny')
    assert.equal(denied.result.isError, true)
    assert.match(denied.result.content[0].text, /denied this browser action/u)
    const sessionId = allowed.call.sessionId
    assert.equal(denied.call.sessionId, sessionId, 'one MCP connection keeps one external session')

    // Bad arguments never reach the browser (the tool's own schema validates).
    const before = toolCalls().length
    const invalid = await client.callTool({ name: 'browser_click', arguments: { index: 'first' } })
    assert.equal(invalid.isError, true)
    assert.equal(toolCalls().length, before)
    // Workspace writes are refused for external callers.
    const pdf = await client.callTool({ name: 'browser_save_pdf', arguments: {} })
    assert.equal(pdf.isError, true)

    // The external session is the bridge's, but never a DSH session: the
    // panel cannot read, prompt, inject into, or purge it.
    for (const [method, payload] of [
      ['session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }] }],
      ['session.history', { sessionId }],
      [methods.BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot: 'Page: x' }],
      [methods.BRIDGE_SESSION_PURGE_METHOD, { sessionId }],
    ]) {
      const refused = await panel.request(method, payload)
      const error = refused.ok ? refused.result?.result?.error : refused.error
      assert.equal(error?.code, 'forbidden', `${method}: ${JSON.stringify(refused)}`)
    }
    // It is recorded in the ledger as external, and every action was audited.
    const ledger = JSON.parse(await readFile(join(home, 'browser-bridge-sessions.json'), 'utf8'))
    assert.ok(ledger.some(row => row?.id === sessionId && row.external?.client === 'smoke-mcp-client'))
    assert.ok(!ledger.includes(sessionId), 'an external session is never an owned DSH session')
    const auditDir = join(home, 'browser-audit')
    const auditFile = (await readdir(auditDir)).find(name => name.includes(sessionId))
    assert.ok(auditFile, 'the MCP session has its own audit log')
    const audit = (await readFile(join(auditDir, auditFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(audit.filter(entry => JSON.stringify(entry).includes('browser_press')).length >= 2, 'both MCP calls are in the audit log')
  } finally {
    await client.close()
    panel.ws.close()
  }
}
