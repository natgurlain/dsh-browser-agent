import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isLoopbackHttpUrl, loadEndpoint, pidAlive } from '../src/shim.mjs'

const bin = fileURLToPath(new URL('../bin/dsh-browser-mcp.mjs', import.meta.url))
const TOKEN = 'shim-test-token-0123456789abcdefghijklmnop'
const temps = []
after(async () => { for (const dir of temps) await rm(dir, { recursive: true, force: true }) })

/** A stand-in bridge endpoint that records what the shim sends. */
async function fakeBridge() {
  const seen = []
  let generation = 0
  const sessions = new Set()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ method: req.method, headers: req.headers, body: body === '' ? undefined : JSON.parse(body) })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
    if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); res.writeHead(204).end(); return }
    const message = JSON.parse(body)
    if (message.method === 'initialize') {
      const id = `s-${++generation}`
      sessions.add(id)
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }))
      return
    }
    if (!sessions.has(req.headers['mcp-session-id'])) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'unknown session' } })); return }
    if (message.id === undefined) { res.writeHead(202).end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method, session: req.headers['mcp-session-id'], version: req.headers['mcp-protocol-version'] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, seen, sessions, url: `http://127.0.0.1:${server.address().port}/mcp` }
}

async function home(url, { tokenMode = 0o600 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-shim-'))
  temps.push(dir)
  if (url !== undefined) await writeFile(join(dir, 'browser-mcp.json'), JSON.stringify({ url, pid: 1 }), { mode: 0o600 })
  await writeFile(join(dir, 'browser-mcp-token'), `${TOKEN}\n`, { mode: 0o600 })
  await chmod(join(dir, 'browser-mcp-token'), tokenMode)
  return dir
}

function shim(env) {
  const child = spawn(process.execPath, [bin], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  const waiters = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    lines.push(message)
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message) }
  })
  return {
    child,
    lines,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    next: (id) => {
      const found = lines.find((line) => line.id === id)
      if (found) return Promise.resolve(found)
      return new Promise((resolve) => waiters.push({ match: (line) => line.id === id, resolve }))
    },
  }
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } } }

test('proxies stdio to the endpoint with token, session and protocol headers, and ends the session on exit', async () => {
  const bridge = await fakeBridge()
  const dir = await home(bridge.url)
  const client = shim({ DSH_HOME: dir })
  client.send(init)
  assert.equal((await client.next(1)).result.protocolVersion, '2025-06-18')
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listed = await client.next(2)
  assert.deepEqual(listed.result, { echoed: 'tools/list', session: 's-1', version: '2025-06-18' })
  // Notifications produce no output.
  assert.equal(client.lines.length, 2)
  client.child.stdin.end()
  await once(client.child, 'exit')
  assert.equal(bridge.seen.at(-1).method, 'DELETE')
  assert.equal(bridge.sessions.size, 0)
  bridge.server.close()
})

test('replays initialize once when the bridge forgot the session (DSH restarted)', async () => {
  const bridge = await fakeBridge()
  const dir = await home(bridge.url)
  const client = shim({ DSH_HOME: dir })
  client.send(init)
  await client.next(1)
  bridge.sessions.clear()
  client.send({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } })
  const answered = await client.next('call')
  assert.equal(answered.result.session, 's-2')
  assert.ok(!client.lines.some((line) => String(line.id).startsWith('dsh-browser-mcp-reinit')), 'the replayed initialize stays inside the shim')
  client.child.stdin.end()
  await once(client.child, 'exit')
  bridge.server.close()
})

test('answers with an actionable error when DSH is not running', async () => {
  const dir = await home(undefined)
  const client = shim({ DSH_HOME: dir })
  client.send(init)
  const failed = await client.next(1)
  assert.equal(failed.error.code, -32000)
  assert.match(failed.error.message, /mcp: \{ enabled: true \}/u)
  client.child.stdin.end()
  await once(client.child, 'exit')
})

test('never sends the token to a non-loopback URL or reads a token others can read', async () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:1/mcp'), true)
  assert.equal(isLoopbackHttpUrl('http://localhost:1/mcp'), true)
  assert.equal(isLoopbackHttpUrl('https://127.0.0.1:1/mcp'), false)
  assert.equal(isLoopbackHttpUrl('http://evil.example/mcp'), false)
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1.evil.example/mcp'), false)
  const dir = await home('http://127.0.0.1:9/mcp')
  assert.match((await loadEndpoint({ DSH_HOME: dir, DSH_BROWSER_MCP_URL: 'http://evil.example/mcp' })).error, /loopback/u)
  assert.deepEqual(await loadEndpoint({ DSH_HOME: dir }), { url: 'http://127.0.0.1:9/mcp', token: TOKEN })
  if (process.platform !== 'win32') {
    const loose = await home('http://127.0.0.1:9/mcp', { tokenMode: 0o644 })
    assert.match((await loadEndpoint({ DSH_HOME: loose })).error, /no token file/u)
  }
})

test('never uses a stale endpoint file whose DSH process is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-stale-'))
  try {
    await writeFile(join(dir, 'browser-mcp-token'), 'x'.repeat(64), { mode: 0o600 })
    await writeFile(join(dir, 'browser-mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:9/mcp', pid: 424242 }), { mode: 0o600 })
    assert.match((await loadEndpoint({ DSH_HOME: dir }, () => false)).error, /stale/u)
    assert.equal((await loadEndpoint({ DSH_HOME: dir }, () => true)).url, 'http://127.0.0.1:9/mcp')
    await writeFile(join(dir, 'browser-mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:9/mcp', pid: 'x' }), { mode: 0o600 })
    assert.match((await loadEndpoint({ DSH_HOME: dir }, () => true)).error, /stale/u)
    assert.equal(pidAlive(process.pid), true)
    assert.equal(pidAlive(1, () => { throw Object.assign(new Error('perm'), { code: 'EPERM' }) }), true)
    assert.equal(pidAlive(2, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
