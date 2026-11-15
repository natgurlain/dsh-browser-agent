/**
 * `dsh-browser-mcp`: a stdio MCP server that proxies every JSON-RPC message
 * to the DSH browser bridge's loopback Streamable HTTP endpoint.
 *
 * MCP clients (Claude Code, Cursor, Codex) launch this process. It finds the
 * endpoint and its bearer token under the DSH home (written 0600 by the bridge
 * plugin when `mcp.enabled` is true), adds the token, the `Mcp-Session-Id`
 * and `MCP-Protocol-Version` headers, and writes the answers back to stdout.
 * All policy (pause, site rules, taint, kill switch, approval cards, audit)
 * lives in the bridge and the browser extension, not here.
 *
 * When DSH restarts (new port, new session table) the shim re-reads the
 * endpoint file and replays the client's `initialize` once, transparently.
 *
 * Zero dependencies; Node 20+.
 *
 * Environment:
 * - `DSH_HOME`: DSH home (default `~/.dsh`).
 * - `DSH_BROWSER_MCP_URL`: endpoint URL override (loopback http only).
 * - `DSH_BROWSER_MCP_TOKEN`: token override (otherwise read from the token file).
 *
 * @module
 */

import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

/** Token file written by the bridge plugin (under the DSH home). */
export const TOKEN_FILE_NAME = 'browser-mcp-token'
/** Endpoint file written by the bridge plugin (under the DSH home). */
export const ENDPOINT_FILE_NAME = 'browser-mcp.json'

const NOT_RUNNING = 'The DSH browser bridge MCP endpoint is not reachable. Start DSH with the bridge-browser plugin and set '
  + '`mcp: { enabled: true }` in its config (see the dsh-browser README), keep the browser extension connected, then retry.'

/** Resolve the DSH home exactly like `@deepseek-ai/dsh-home-paths`. */
export function dshHome(env) {
  const fromEnv = env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
  const expanded = selected === '~' ? homedir() : selected.startsWith('~/') ? join(homedir(), selected.slice(2)) : selected
  return resolve(expanded)
}

/** Whether a URL is a loopback http URL (the only kind the shim will send the token to). */
export function isLoopbackHttpUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
}

/**
 * Read a small private file: not a symlink, owned by this user and not
 * readable or writable by others (POSIX). Undefined when absent or untrusted.
 */
async function readPrivateFile(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) return undefined
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined
        if ((stat.mode & 0o077) !== 0) return undefined
      }
      return (await handle.readFile('utf8')).trim()
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Whether the process that wrote the endpoint file still runs. A stale file
 * from a crashed DSH names a port anything may now listen on: the token must
 * not go there. `EPERM` means the process exists (owned by someone else).
 */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Endpoint URL and token, or a reason they are unavailable. */
export async function loadEndpoint(env, isAlive = pidAlive) {
  const home = dshHome(env)
  let url = env.DSH_BROWSER_MCP_URL
  if (url === undefined || url === '') {
    const raw = await readPrivateFile(join(home, ENDPOINT_FILE_NAME))
    if (raw === undefined) return { error: NOT_RUNNING }
    let pid
    try {
      ({ url, pid } = JSON.parse(raw))
    } catch {
      return { error: NOT_RUNNING }
    }
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid))) {
      return { error: `${NOT_RUNNING} (the endpoint file in ${home} is stale: its DSH process is gone)` }
    }
  }
  if (typeof url !== 'string' || !isLoopbackHttpUrl(url)) {
    return { error: 'The DSH browser MCP endpoint must be a loopback http URL; refusing to send the token elsewhere.' }
  }
  const token = env.DSH_BROWSER_MCP_TOKEN !== undefined && env.DSH_BROWSER_MCP_TOKEN !== ''
    ? env.DSH_BROWSER_MCP_TOKEN
    : await readPrivateFile(join(home, TOKEN_FILE_NAME))
  if (token === undefined || token === '') return { error: `${NOT_RUNNING} (no token file in ${home})` }
  return { url, token }
}

/**
 * Run the shim until stdin ends.
 * @param io - `{ stdin, stdout, stderr, env, fetch? }`.
 * @returns the process exit code.
 */
export async function runShim(io) {
  const doFetch = io.fetch ?? globalThis.fetch
  const log = (text) => { io.stderr.write(`dsh-browser-mcp: ${text}\n`) }
  const write = (message) => { io.stdout.write(`${JSON.stringify(message)}\n`) }
  const state = { endpoint: undefined, sessionId: undefined, protocolVersion: undefined, initParams: undefined, reinits: 0 }
  const inflight = new Set()

  const endpoint = async (refresh) => {
    if (refresh || state.endpoint === undefined || 'error' in state.endpoint) state.endpoint = await loadEndpoint(io.env)
    return state.endpoint
  }

  const post = async (target, message) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${target.token}`,
    }
    if (state.sessionId !== undefined && message.method !== 'initialize') headers['mcp-session-id'] = state.sessionId
    if (state.protocolVersion !== undefined && message.method !== 'initialize') headers['mcp-protocol-version'] = state.protocolVersion
    const response = await doFetch(target.url, { method: 'POST', headers, body: JSON.stringify(message) })
    const text = await response.text()
    let body
    if (text !== '') {
      const type = response.headers.get('content-type') ?? ''
      body = type.includes('text/event-stream') ? parseSse(text) : safeJson(text)
    }
    return { status: response.status, sessionId: response.headers.get('mcp-session-id') ?? undefined, body }
  }

  const initialize = async (target, message) => {
    const answer = await post(target, message)
    if (answer.status === 200 && answer.sessionId !== undefined) {
      state.sessionId = answer.sessionId
      const version = answer.body?.result?.protocolVersion
      if (typeof version === 'string') state.protocolVersion = version
    }
    return answer
  }

  /** Replay the client's initialize against a restarted bridge (once per failure). */
  const reinitialize = async (target) => {
    if (state.initParams === undefined) return false
    state.sessionId = undefined
    state.reinits += 1
    const answer = await initialize(target, { jsonrpc: '2.0', id: `dsh-browser-mcp-reinit-${state.reinits}`, method: 'initialize', params: state.initParams })
    if (answer.status !== 200 || state.sessionId === undefined) return false
    await post(target, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)
    log('reconnected to the DSH browser bridge (new MCP session)')
    return true
  }

  const isRequest = (message) => message.id !== undefined && message.id !== null && typeof message.method === 'string'
  const fail = (message, text) => { if (isRequest(message)) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } }) }

  const handle = async (message) => {
    let target = await endpoint(false)
    if ('error' in target) {
      fail(message, target.error)
      return
    }
    if (message.method === 'initialize') state.initParams = message.params
    let answer
    try {
      answer = message.method === 'initialize' ? await initialize(target, message) : await post(target, message)
    } catch {
      // DSH may have restarted on another port: re-read the endpoint and retry once.
      const previous = target.url
      target = await endpoint(true)
      if ('error' in target) {
        fail(message, target.error)
        return
      }
      try {
        if (message.method !== 'initialize' && (target.url !== previous || state.sessionId !== undefined)) {
          if (!await reinitialize(target)) throw new Error('reinitialize failed')
        }
        answer = message.method === 'initialize' ? await initialize(target, message) : await post(target, message)
      } catch {
        fail(message, NOT_RUNNING)
        return
      }
    }
    if (answer.status === 404 && message.method !== 'initialize' && await reinitialize(target).catch(() => false)) {
      answer = await post(target, message).catch(() => undefined)
      if (answer === undefined) {
        fail(message, NOT_RUNNING)
        return
      }
    }
    if (answer.status === 202 || answer.body === undefined) {
      if (answer.status >= 400) fail(message, `the DSH browser bridge refused the request (HTTP ${answer.status})`)
      return
    }
    const bodies = Array.isArray(answer.body) ? answer.body : [answer.body]
    let answered = false
    for (const body of bodies) {
      if (body !== null && typeof body === 'object' && body.jsonrpc === '2.0') {
        write(body)
        if (body.id === message.id) answered = true
      }
    }
    if (!answered && answer.status >= 400) {
      const reason = typeof answer.body?.error === 'string' ? answer.body.error : `HTTP ${answer.status}`
      fail(message, `the DSH browser bridge refused the request: ${reason}`)
    }
  }

  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    const message = safeJson(line)
    if (message === undefined || typeof message !== 'object' || message === null || Array.isArray(message)) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON-RPC message' } })
      continue
    }
    // Calls run concurrently: a tools/call may wait on a browser approval
    // while the client sends ping or notifications/cancelled.
    const task = handle(message).catch((error) => {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      fail(message, 'internal shim error')
    })
    inflight.add(task)
    void task.finally(() => inflight.delete(task))
  }
  await Promise.allSettled([...inflight])
  // The client went away: end the MCP session so its external session stops.
  const target = state.endpoint
  if (state.sessionId !== undefined && target !== undefined && !('error' in target)) {
    await doFetch(target.url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${target.token}`, 'mcp-session-id': state.sessionId },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined)
  }
  return 0
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Collect the JSON `data:` payloads of an SSE body (servers may answer this way). */
function parseSse(text) {
  const messages = []
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    const parsed = data === '' ? undefined : safeJson(data)
    if (parsed !== undefined) messages.push(parsed)
  }
  return messages
}
