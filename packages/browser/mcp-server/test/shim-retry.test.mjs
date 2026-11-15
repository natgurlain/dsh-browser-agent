import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { runShim } from '../src/shim.mjs'

const TOKEN = 'shim-retry-token-0123456789abcdefghijklmnop'

async function home(t, url) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'browser-mcp.json'), JSON.stringify({ url, pid: process.pid }), { mode: 0o600 })
  await writeFile(join(dir, 'browser-mcp-token'), TOKEN, { mode: 0o600 })
  return dir
}

function reply(status, body, extra = {}) {
  const headers = new Map(Object.entries({ 'content-type': 'application/json', ...extra }))
  return { status, headers: { get: (name) => headers.get(name) ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
}

const fetchError = (code) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })

/** Run the shim in-process against an injected fetch; returns the client side. */
function inProcess(t, env, fetch) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  stderr.resume()
  const lines = []
  createInterface({ input: stdout }).on('line', (line) => lines.push(JSON.parse(line)))
  const done = runShim({ stdin, stdout, stderr, env, fetch })
  t.after(() => { stdin.end() })
  return { lines, done, send: (message) => stdin.write(`${JSON.stringify(message)}\n`), end: () => stdin.end() }
}

/** A scripted bridge: `onCall(message, init)` may throw or return a reply for tools/call. */
function scripted(onCall) {
  const posts = []
  let sessions = 0
  const fetch = async (url, init) => {
    const message = init.body === undefined ? undefined : JSON.parse(init.body)
    posts.push({ url, method: init.method, message, headers: init.headers })
    if (init.method === 'DELETE') return reply(204)
    if (message.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': `s-${++sessions}` })
    if (message.id === undefined) return reply(202)
    if (message.method === 'tools/call') {
      const answer = await onCall(message, init, url)
      if (answer !== undefined) return answer
    }
    return reply(200, { jsonrpc: '2.0', id: message.id, result: { session: init.headers['mcp-session-id'], url } })
  }
  return { fetch, posts, count: (method) => posts.filter((post) => post.message?.method === method).length }
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
const call = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_click', arguments: {} } })
const until = async (predicate, ms = 3_000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const answerTo = (client, id) => client.lines.find((line) => line.id === id)

test('a tools/call whose answer took too long (client-side timeout) is never re-sent', async (t) => {
  // What Node's fetch throws after 300 s without response headers.
  const bridge = scripted(() => { throw fetchError('UND_ERR_HEADERS_TIMEOUT') })
  const dir = await home(t, 'http://127.0.0.1:9/mcp')
  const client = inProcess(t, { DSH_HOME: dir }, bridge.fetch)
  client.send(init)
  await until(() => answerTo(client, 1))
  client.send(call(2))
  await until(() => answerTo(client, 2))
  assert.equal(bridge.count('tools/call'), 1, 'the call was posted exactly once')
  assert.equal(bridge.count('initialize'), 1, 'no replayed initialize')
  assert.equal(answerTo(client, 2).error.code, -32000)
  assert.match(answerTo(client, 2).error.message, /not re-sent/u)
  client.end()
  assert.equal(await client.done, 0)
})

test('a refused connection is retried once on the same endpoint after a fresh initialize', async (t) => {
  let refuse = true
  const bridge = scripted(() => {
    if (refuse) { refuse = false; throw fetchError('ECONNREFUSED') }
    return undefined
  })
  const dir = await home(t, 'http://127.0.0.1:9/mcp')
  const client = inProcess(t, { DSH_HOME: dir }, bridge.fetch)
  client.send(init)
  await until(() => answerTo(client, 1))
  client.send(call(2))
  await until(() => answerTo(client, 2))
  assert.equal(answerTo(client, 2).result.session, 's-2', 'answered on the replayed session')
  assert.equal(bridge.count('tools/call'), 2)
  assert.equal(bridge.count('initialize'), 2)
  client.end()
  await client.done
})

test('after DSH restarts on another port the call goes to the new endpoint once', async (t) => {
  const dir = await home(t, 'http://127.0.0.1:9/mcp')
  const bridge = scripted(async (message, init_, url) => {
    if (url.includes(':9/')) {
      // The old DSH went away mid-call (any error) and the new one rewrote the endpoint file.
      await writeFile(join(dir, 'browser-mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:10/mcp', pid: process.pid }), { mode: 0o600 })
      throw fetchError('UND_ERR_SOCKET')
    }
    return undefined
  })
  const client = inProcess(t, { DSH_HOME: dir }, bridge.fetch)
  client.send(init)
  await until(() => answerTo(client, 1))
  client.send(call(2))
  await until(() => answerTo(client, 2))
  assert.equal(answerTo(client, 2).result.url, 'http://127.0.0.1:10/mcp')
  assert.equal(bridge.posts.filter((post) => post.message?.method === 'tools/call' && post.url.includes(':10/')).length, 1)
  client.end()
  await client.done
})

test('a call that fails the same way twice is reported, not retried again', async (t) => {
  const bridge = scripted(() => { throw fetchError('ECONNRESET') })
  const dir = await home(t, 'http://127.0.0.1:9/mcp')
  const client = inProcess(t, { DSH_HOME: dir }, bridge.fetch)
  client.send(init)
  await until(() => answerTo(client, 1))
  client.send(call(2))
  await until(() => answerTo(client, 2))
  assert.equal(bridge.count('tools/call'), 2)
  assert.equal(answerTo(client, 2).error.code, -32000)
  client.end()
  await client.done
})

test('in-flight calls are aborted when stdin ends, then the session is deleted', async (t) => {
  let signal
  const bridge = scripted((message, init_) => {
    signal = init_.signal
    return new Promise((resolve, reject) => {
      init_.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  })
  const dir = await home(t, 'http://127.0.0.1:9/mcp')
  const client = inProcess(t, { DSH_HOME: dir }, bridge.fetch)
  client.send(init)
  await until(() => answerTo(client, 1))
  client.send(call(2))
  await until(() => bridge.count('tools/call') === 1)
  client.end()
  const exited = await Promise.race([client.done, new Promise((resolve) => setTimeout(() => resolve('hung'), 2_000))])
  assert.equal(exited, 0)
  assert.equal(signal?.aborted, true)
  assert.equal(bridge.posts.at(-1).method, 'DELETE')
  assert.equal(bridge.count('tools/call'), 1, 'an aborted call is not retried')
})
