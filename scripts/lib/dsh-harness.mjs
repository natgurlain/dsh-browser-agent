// Shared harness for the real-DSH smokes (scripts/smoke-runtime.mjs,
// scripts/smoke-browser.mjs): resolve the dsh CLI and the bridge, scrub the
// environment, run CLI commands with a timeout, start `dsh web` and stop it
// (SIGTERM, then SIGKILL), poll, build llm-pi-ai provider rows, and stream
// OpenAI-style chat-completions replies from scripted models.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createTcpServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Repository root (with a trailing separator, like `new URL('../')`). */
export const root = fileURLToPath(new URL('../../', import.meta.url))

/** Caps of a text-only test client (a stand-in browser extension). */
export const BASE_CAPS = Object.freeze({ textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 })

/**
 * Where the dsh CLI and the bridge package live, with requires rooted at each.
 *
 * `DSH_SMOKE_CLI` names the `lib/bin.js` of a DSH installed somewhere else.
 * The smoke then runs that host against this checkout's bridge, which keeps
 * its own node_modules: the layout of a linked checkout loaded by a DSH of
 * another release (the desktop app, a global install). `hostVersion` is the
 * version of the DSH that will run, whichever it is.
 */
export function resolveDsh(env = process.env) {
  const require = createRequire(join(root, 'package.json'))
  const bridge = join(root, 'packages/browser/bridge-browser')
  const external = env.DSH_SMOKE_CLI !== undefined && env.DSH_SMOKE_CLI !== ''
  const cli = external ? resolve(env.DSH_SMOKE_CLI) : join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
  const hostManifest = JSON.parse(readFileSync(join(dirname(dirname(realpathSync(cli))), 'package.json'), 'utf8'))
  assert.equal(hostManifest.name, '@deepseek-ai/dsh', `${cli} is not the lib/bin.js of an @deepseek-ai/dsh package`)
  return { root, bridge, cli, external, hostVersion: hostManifest.version, require, bridgeRequire: createRequire(join(bridge, 'package.json')) }
}

/**
 * Fail early when the bridge's `lib/` (what DSH loads) is missing or older
 * than its `src/`: the smokes import a few helpers (protocol constants, the
 * audit-log verifier) straight from source, and a stale build would be checked
 * against newer source.
 */
export function assertBridgeBuilt(dsh) {
  const lib = join(dsh.bridge, 'lib/index.js')
  let built
  try {
    built = statSync(lib).mtimeMs
  } catch {
    throw new Error(`The bridge is not built (${lib} is missing): run \`pnpm -r build\` first.`)
  }
  const stale = readdirSync(join(dsh.bridge, 'src'), { recursive: true })
    .filter(name => /\.(?:ts|js)$/u.test(name))
    .find(name => statSync(join(dsh.bridge, 'src', name)).mtimeMs > built)
  if (stale !== undefined) throw new Error(`The bridge build is older than src/${stale}: run \`pnpm -r build\` first.`)
}

/**
 * The environment for a smoke DSH: its own home, telemetry off, and no bridge
 * settings or credentials inherited from the developer's shell.
 */
export function smokeEnv(home, extra = {}) {
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...extra }
  delete env.DSH_EXT_TOKEN
  delete env.DSH_BROWSER_SESSION_WORKSPACE
  return env
}

/** Run the dsh CLI to completion; fails on a non-zero exit or after `timeout` ms. */
export async function runCli(cli, args, { env, cwd = root, timeout = 120_000 } = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  try {
    const [code, signal] = await once(child, 'exit')
    assert.equal(code, 0, `dsh ${args.join(' ')} failed (${code ?? signal}): ${output}`)
  } finally {
    clearTimeout(timer)
  }
  return output
}

/** Register the working-tree bridge in the `web` profile, as the installers do. */
export function addBridgePlugin(dsh, env) {
  return runCli(dsh.cli, ['plugin', '--profile', 'web', 'add', '-w', `@natgurlain/dsh-bridge-browser@link:${dsh.bridge}`], { env })
}

/**
 * Poll `check` until it returns a truthy value. With `host` (from
 * {@link startHost}) the wait fails as soon as DSH exits, and errors carry its log.
 */
export async function waitFor(check, label, { timeout = 60_000, host } = {}) {
  const deadline = Date.now() + timeout
  const tail = () => (host === undefined ? '' : `\n--- dsh log ---\n${host.log.slice(-8_000)}`)
  while (Date.now() < deadline) {
    if (host?.exited()) throw new Error(`DSH exited (${host.child.exitCode ?? host.child.signalCode}) while waiting for ${label}${tail()}`)
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}${tail()}`)
}

/** A loopback port nothing listens on (bound, then released): a real connection failure. */
export async function closedPort() {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/**
 * Patch lines for one `llm-pi-ai` provider (indented to sit under
 * `    providers:`): OpenAI chat completions on a loopback port, no retries.
 * @param {Array<string | { id: string, input?: string[] }>} models
 */
export function providerYaml(name, port, models, { input } = {}) {
  const lines = [
    `      ${name}:`,
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${port}/v1`,
    '        headers:',
    `          Authorization: Bearer local-${name}`,
    '        models:',
  ]
  for (const model of models) {
    const entry = typeof model === 'string' ? { id: model, input } : model
    lines.push(`          - id: ${entry.id}`)
    if (entry.input !== undefined) lines.push(`            input: [${entry.input.join(', ')}]`)
  }
  lines.push('        retryPolicy:', '          mode: normal', '          maxRetries: 0')
  return lines
}

/**
 * Start `dsh web --patch <patch> --port 0` and wait for its URL.
 * @returns `{ child, base, log, exited(), stop() }`; `stop` sends SIGTERM and
 * SIGKILL after `killAfter` ms, so a hung DSH cannot hang the smoke.
 */
export async function startHost({ cli, patch, env, cwd = root, readyTimeout = 60_000, killAfter = 10_000 }) {
  const child = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let spawnError
  const host = {
    child,
    log: '',
    base: undefined,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    async stop() {
      if (host.exited() || spawnError !== undefined) return
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), killAfter)
      try { await exit } finally { clearTimeout(timer) }
    },
  }
  child.stdout.on('data', data => { host.log += data })
  child.stderr.on('data', data => { host.log += data })
  child.on('error', error => { spawnError = error })
  host.base = await waitFor(() => {
    if (spawnError !== undefined) throw spawnError
    return host.log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
  }, 'DSH startup', { timeout: readyTimeout, host })
  return host
}

/** Read a request body as JSON (`{}` when empty or not JSON). */
export async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}')
  } catch {
    return {}
  }
}

const randomId = () => Math.random().toString(36).slice(2, 10)

/**
 * Write one streamed chat-completions answer (the only SSE writer of the
 * smokes' scripted models).
 * @param reply - `{ text }` or `{ tool: { name, args, id? } }`.
 * @param options - `{ id?, model? }`; a string is taken as the model name.
 */
export function streamReply(response, reply, options = {}) {
  const { id = `chatcmpl-${randomId()}`, model = 'scripted' } = typeof options === 'string' ? { model: options } : options
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  const delta = 'tool' in reply
    ? { role: 'assistant', tool_calls: [{ index: 0, id: reply.tool.id ?? `call_${randomId()}`, type: 'function', function: { name: reply.tool.name, arguments: typeof reply.tool.args === 'string' ? reply.tool.args : JSON.stringify(reply.tool.args) } }] }
    : { role: 'assistant', content: reply.text }
  const finish = 'tool' in reply ? 'tool_calls' : 'stop'
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}
