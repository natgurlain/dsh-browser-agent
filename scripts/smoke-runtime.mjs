import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { zstdCompressSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const bridge = join(root, 'packages/browser/bridge-browser')
const require = createRequire(join(root, 'package.json'))
const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const bridgeRequire = createRequire(join(bridge, 'package.json'))
const { default: WebSocket } = await import(pathToFileURL(bridgeRequire.resolve('ws')).href)
const {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, BRIDGE_SESSION_PURGE_METHOD, BEACON_PORTS, BRIDGE_CONFIG_PATH,
  BRIDGE_CLOSE_CODES, BRIDGE_PROTOCOL_VERSION, PINNED_CHROME_EXTENSION_ID, computeBridgeProof, createBridgeNonce,
  BridgeFrameChannel, bridgeEndpointOfUrl, BRIDGE_APPROVAL_ASK_METHOD, BRIDGE_TOOL_HOLD_METHOD,
} = await import(pathToFileURL(join(bridge, 'lib/protocol.js')).href)
const temp = await mkdtemp(join(tmpdir(), 'dsh-runtime-smoke-'))
const home = join(temp, 'home')
const marker = join(temp, 'observation.json')
const patch = join(temp, 'smoke.patch.yml')
const sessionId = `session-${randomUUID()}`
const legacySessionId = `session-${randomUUID()}`
const worktreeSessions = [
  { dirty: false, failCleanup: false },
  { dirty: true, failCleanup: false },
  { dirty: false, failCleanup: true },
].map(entry => ({ sessionId: `session-${randomUUID()}`, ...entry }))
const worktreeRepository = join(temp, 'worktree-repository')
const legacyProject = temp.replace(/[\\/:]+/g, '-').replace(/[^A-Za-z0-9._-]/g,
  char => `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).replace(/^-+/, '')
const legacyDirectory = join(home, 'sessions', `--${legacyProject.slice(0, 251)}--`, legacySessionId)
const legacyFile = join(legacyDirectory, 'session.v2.jsonl.zstd')
// A released V2 envelope, read through the production migration catalog and
// the bridge. Keep the original bytes so the smoke also checks preservation.
const legacyLog = [
  { type: 'session', version: 2, id: legacySessionId, cwd: temp, createdAt: 1, isSeeded: false, delegationDepth: 0 },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'user/message', surfaceOp: 'append', data: { id: 'legacy-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Saved browser conversation' }] } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
].map((row, index) => JSON.stringify(index === 0 ? row : { ...row, seq: index - 1, time: index + 10 })).join('\n') + '\n'
// The JSONL container requires its header in a separate Zstandard frame.
const legacyBytes = Buffer.concat(legacyLog.trimEnd().split('\n').map(line => zstdCompressSync(Buffer.from(line + '\n'))))
const token = randomUUID()
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access' }
// 使用已关闭的本机端口验证真实连接失败及继续请求，不返回模拟模型响应。
const unavailableServer = createServer()
unavailableServer.listen(0, '127.0.0.1')
await once(unavailableServer, 'listening')
const unavailablePort = unavailableServer.address().port
await new Promise(resolve => unavailableServer.close(resolve))
// A scripted local model (OpenAI chat-completions streaming): asked by a user
// turn it calls `browser_press`; after the tool result it answers in text.
// It drives a real Agent turn so a real browser tool call reaches the bridge.
const scriptedModel = createHttpServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'scripted', object: 'model' }] }))
      return
    }
    const messages = JSON.parse(body).messages ?? []
    const afterTool = messages.at(-1)?.role === 'tool'
    const chunk = (delta, finish) => `data: ${JSON.stringify({
      id: 'scripted-1', object: 'chat.completion.chunk', created: 0, model: 'scripted',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(afterTool
      ? chunk({ role: 'assistant', content: 'Done.' }, null)
      : chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: 'browser_press', arguments: '{"key":"Enter"}' } }] }, null))
    res.write(chunk({}, afterTool ? 'stop' : 'tool_calls'))
    res.end('data: [DONE]\n\n')
  })
})
scriptedModel.listen(0, '127.0.0.1')
await once(scriptedModel, 'listening')
const scriptedPort = scriptedModel.address().port
const approvalLog = join(temp, 'approvals.jsonl')
// Do not inherit bridge settings or credentials from the developer's shell.
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
let host
let socket
let hostLog = ''
let succeeded = false

async function waitFor(check, label, timeout = 60_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (host && (host.exitCode !== null || host.signalCode !== null)) {
      throw new Error(`DSH exited (${host.exitCode ?? host.signalCode}) while waiting for ${label}`)
    }
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
  } finally { clearTimeout(timeout) }
}

async function start(reopen) {
  await rm(marker, { force: true })
  // The production bridge is registered through the normal profile command;
  // only test settings and the observation probe are additional patch rows.
  await writeFile(patch, [
    '- id: bridge-browser',
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    `    sessionWorkspacePath: ${JSON.stringify(join(temp, 'browser-sessions'))}`,
    '    deferSessionCreate: false',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      connection-check:',
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${unavailablePort}/v1`,
    '        headers:',
    '          Authorization: Bearer local-connection-check',
    '        models:',
    '          - id: connection-check',
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 0',
    '      scripted:',
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${scriptedPort}/v1`,
    '        headers:',
    '          Authorization: Bearer scripted',
    '        models:',
    '          - id: scripted',
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 0',
    '- insert:',
    '    - id: runtime-smoke-probe',
    `      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/runtime-probe.mjs')).href)}`,
    '      config:',
    `        sessionId: ${JSON.stringify(sessionId)}`,
    `        marker: ${JSON.stringify(marker)}`,
    `        reopen: ${reopen}`,
    `        profileManifest: ${JSON.stringify(join(home, 'profiles/web/package.json'))}`,
    `        expectedVersion: ${JSON.stringify(expectedVersion)}`,
    `        imagePath: ${JSON.stringify(join(root, 'extensions/dsh-browser/assets/icons/icon32.png'))}`,
    `        worktreeSessions: ${JSON.stringify(worktreeSessions)}`,
    `        approvalLog: ${JSON.stringify(approvalLog)}`,
    '',
  ].join('\n'))
  hostLog = ''
  host = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', data => { hostLog += data })
  host.stderr.on('data', data => { hostLog += data })
  let spawnError
  host.on('error', error => { spawnError = error })
  const base = await waitFor(() => {
    if (spawnError) throw spawnError
    return hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
  }, 'host readiness')
  const response = await fetch(`${base}/ext/bridge-config`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  const config = await response.json()
  assert.equal(config.wsUrl, base.replace('http:', 'ws:') + '/ext/bridge')
  // The host boots with `--port 0` exactly like DSH Desktop, so the fixed-port
  // discovery beacon is what lets the extension find this run. Its answer must
  // name the same single bridge URL, and it must not expose anything else.
  const beacon = await (async () => {
    const answers = []
    for (const port of BEACON_PORTS) {
      try {
        const probe = await fetch(`http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`, { signal: AbortSignal.timeout(2_000) })
        if (!probe.ok) continue
        const body = await probe.json()
        if (body?.beacon === true) answers.push(body)
      } catch {
        // No beacon on this candidate port.
      }
    }
    // A developer machine may run DSH Desktop on an earlier beacon port, and
    // its answer would otherwise be mistaken for this run's. Prefer the answer
    // that names the host webserver this smoke actually started; fall back to
    // the first beacon so a genuine mismatch still fails below.
    return answers.find(body => body.wsUrl === config.wsUrl) ?? answers[0]
  })()
  assert.ok(beacon, `no discovery beacon answered on ${BEACON_PORTS.join(', ')}`)
  assert.equal(beacon.wsUrl, config.wsUrl, 'beacon advertises the only real bridge URL')
  assert.ok(Number.isInteger(beacon.pid) && beacon.pid > 0, 'beacon reports the host process id')
  assert.equal(typeof beacon.startedAt, 'string')
  // Every client must prove the token, loopback included: a forged
  // chrome-extension Origin with a guessed proof, and a v1 (raw-token) hello,
  // are both closed before anything is forwarded.
  const rejected = async (origin, helloFrame) => {
    const probe = new WebSocket(config.wsUrl, { origin, handshakeTimeout: 10_000 })
    const seen = []
    probe.on('message', data => { seen.push(JSON.parse(data.toString())) })
    const closed = once(probe, 'close')
    await once(probe, 'open')
    if (helloFrame !== undefined) {
      await waitFor(() => seen.some(value => value.t === 'challenge'), 'bridge challenge', 10_000)
      probe.send(JSON.stringify(helloFrame))
    }
    const [code] = await closed
    assert.equal(seen.some(value => value.t === 'hello.ok'), false)
    return code
  }
  const caps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
  const endpoint = bridgeEndpointOfUrl(config.wsUrl)
  assert.equal(await rejected(`chrome-extension://${PINNED_CHROME_EXTENSION_ID}`, {
    t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce(), mac: createBridgeNonce(), endpoint, caps,
  }), BRIDGE_CLOSE_CODES.authFailed, 'a forged extension Origin without the token must be refused')
  // A relay on another port forwards a valid proof bound to the port the
  // victim dialed; the real bridge must refuse it.
  {
    const probe = new WebSocket(config.wsUrl, { handshakeTimeout: 10_000 })
    const seen = []
    probe.on('message', data => { seen.push(JSON.parse(data.toString())) })
    const closed = once(probe, 'close')
    await once(probe, 'open')
    const relayed = await waitFor(() => seen.find(value => value.t === 'challenge'), 'bridge challenge', 10_000)
    const nonce = createBridgeNonce()
    const elsewhere = { host: '127.0.0.1', port: BEACON_PORTS[0] === endpoint.port ? BEACON_PORTS[1] : BEACON_PORTS[0] }
    probe.send(JSON.stringify({
      t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, endpoint: elsewhere, caps,
      mac: await computeBridgeProof(token, 'client', relayed.nonce, nonce, elsewhere, { client: caps }),
    }))
    const [code] = await closed
    assert.equal(code, BRIDGE_CLOSE_CODES.authFailed, 'a handshake relayed from another port must be refused')
  }
  assert.equal(await rejected(`chrome-extension://${PINNED_CHROME_EXTENSION_ID}`, { t: 'hello', token: '', caps }),
    BRIDGE_CLOSE_CODES.versionMismatch, 'a v1 hello must be refused with a version mismatch')
  assert.equal(await rejected('chrome-extension://abcdefghijklmnopabcdefghijklmnop'),
    BRIDGE_CLOSE_CODES.originRejected, 'a foreign extension must be refused')
  // Firefox-style origin with the real token completes the mutual handshake.
  socket = new WebSocket(config.wsUrl, { origin: 'moz-extension://runtime-smoke', handshakeTimeout: 10_000 })
  const frames = []
  let socketError
  let channel
  socket.on('error', error => { socketError = error })
  socket.on('message', data => {
    const text = data.toString()
    const parsed = JSON.parse(text)
    if (channel === undefined || parsed.t === 'hello.ok') {
      frames.push(parsed)
      return
    }
    const opened = channel.open(text)
    if (opened === undefined) socketError = new Error(`bridge frame failed authentication: ${text.slice(0, 200)}`)
    else frames.push(opened)
  })
  await once(socket, 'open')
  async function frame(predicate) {
    return waitFor(() => {
      if (socketError) throw socketError
      const found = frames.find(predicate)
      if (found) return found
      if (socket.readyState === WebSocket.CLOSED) throw new Error(`Bridge closed: ${JSON.stringify(frames)}`)
    }, 'bridge response', 15_000)
  }
  const challenge = await frame(value => value.t === 'challenge')
  assert.equal(challenge.v, BRIDGE_PROTOCOL_VERSION)
  const clientNonce = createBridgeNonce()
  const sealed = BridgeFrameChannel.derive(token, 'client', challenge.nonce, clientNonce, endpoint)
  socket.send(JSON.stringify({
    t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: clientNonce, endpoint, caps,
    mac: await computeBridgeProof(token, 'client', challenge.nonce, clientNonce, endpoint, { client: caps }),
  }))
  // hello.ok is the last unsealed frame; everything after it is sealed.
  channel = sealed
  const accepted = await frame(value => value.t === 'hello.ok')
  assert.equal(accepted.mac, await computeBridgeProof(token, 'server', clientNonce, challenge.nonce, endpoint, { client: caps, server: accepted.caps }),
    'the bridge must prove knowledge of the token back')
  async function request(method, payload) {
    const id = randomUUID()
    socket.send(channel.seal({ t: 'rpc', id, method, payload }))
    return frame(value => value.t === 'rpc.result' && value.id === id)
  }
  async function send(method, payload) {
    const result = await request(method, payload)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      assert.deepEqual(result.result, { accepted: true })
      return { ok: true, value: result.result }
    }
    if (method === BRIDGE_SESSION_PURGE_METHOD) {
      assert.deepEqual(result.result, { purged: true })
      return { ok: true, value: result.result }
    }
    return result.result?.result
  }
  const rpc = async (method, payload) => {
    const envelope = await send(method, payload)
    assert.equal(envelope?.ok, true, JSON.stringify(envelope))
    return envelope.value
  }
  // Business failures are part of the contract, so the smoke also reads raw envelopes.
  rpc.raw = (method, payload) => send(method, payload)
  rpc.request = request
  rpc.base = base
  rpc.event = (method, sessionId, accept = () => true) => frame(value => value.t === 'event'
    && value.frame.method === method && value.frame.payload.sessionId === sessionId && accept(value.frame.payload))
  return rpc
}

/**
 * Authenticate one more bridge client with its own caps (a second browser
 * install). Returns its frames and a sealed rpc helper.
 */
async function connectClient(wsUrl, clientCaps) {
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 })
  const frames = []
  let channel
  let ready = false
  const closed = once(ws, 'close')
  ws.on('message', data => {
    const text = data.toString()
    if (!ready) { frames.push(JSON.parse(text)); return }
    const opened = channel.open(text)
    if (opened === undefined) throw new Error('bridge frame failed authentication')
    frames.push(opened)
  })
  await once(ws, 'open')
  const challenge = await waitFor(() => frames.find(value => value.t === 'challenge'), 'challenge', 10_000)
  const endpoint = bridgeEndpointOfUrl(wsUrl)
  const nonce = createBridgeNonce()
  channel = BridgeFrameChannel.derive(token, 'client', challenge.nonce, nonce, endpoint)
  ws.send(JSON.stringify({
    t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, endpoint, caps: clientCaps,
    mac: await computeBridgeProof(token, 'client', challenge.nonce, nonce, endpoint, { client: clientCaps }),
  }))
  const ok = await waitFor(() => frames.find(value => value.t === 'hello.ok'), 'hello.ok', 10_000)
  ready = true
  const send = frame => ws.send(channel.seal(frame))
  const request = async (method, payload, timeout = 30_000) => {
    const id = randomUUID()
    send({ t: 'rpc', id, method, payload })
    return waitFor(() => frames.find(value => value.t === 'rpc.result' && value.id === id), `${method} result`, timeout)
  }
  return { ws, frames, ok, send, request, closed }
}

async function observation(file = marker) {
  return waitFor(async () => {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }, 'persisted session observation')
}

async function stop() {
  socket?.terminate()
  socket = undefined
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const exited = once(host, 'exit')
  host.kill('SIGTERM')
  const timeout = setTimeout(() => host.kill('SIGKILL'), 10_000)
  try { await exited } finally { clearTimeout(timeout) }
  host = undefined
}

try {
  await mkdir(home, { recursive: true })
  await mkdir(worktreeRepository)
  execFileSync('git', ['init', '--quiet', worktreeRepository], { env })
  execFileSync('git', ['-c', 'user.name=Runtime Smoke', '-c', 'user.email=runtime-smoke@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Initial worktree fixture'],
  { cwd: worktreeRepository, env })
  await mkdir(legacyDirectory, { recursive: true })
  await writeFile(legacyFile, legacyBytes)
  await command(['plugin', '--profile', 'web', 'add', '-w', `@natgurlain/dsh-bridge-browser@link:${bridge}`])
  await command(['plugin', '--profile', 'web', 'add', `@deepseek-ai/dsh-experimental-tool-worktree@${expectedVersion}`])
  // The fixture sessions need a fixed id and directory, which the bridge no
  // longer lets its client choose. They are placed as the owner through the
  // probe, and recorded in the bridge's session ledger as an earlier bridge
  // run would have left them; `foreignSessionId` is not in the ledger.
  const foreignSessionId = `session-${randomUUID()}`
  await writeFile(join(home, 'browser-bridge-sessions.json'),
    JSON.stringify([sessionId, ...worktreeSessions.map(entry => entry.sessionId)]), { mode: 0o600 })
  let rpc = await start(false)
  const place = async (id, cwd) => {
    const response = await fetch(`${rpc.base}/smoke/create-session`, {
      method: 'POST', body: JSON.stringify({ sessionId: id, cwd }), signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).sessionId, id)
  }
  await place(sessionId, temp)
  const initial = await observation()
  assert.equal(initial.sessionId, sessionId)
  for (const entry of worktreeSessions) {
    await place(entry.sessionId, worktreeRepository)
    await observation(`${marker}.${entry.sessionId}`)
  }
  await place(foreignSessionId, temp)
  // The bridge mints its own sessions: a requested id or directory is dropped.
  const minted = await rpc('session.create', { sessionId: foreignSessionId, cwd: worktreeRepository })
  assert.notEqual(minted.sessionId, foreignSessionId)
  // A session the bridge did not create stays readable but cannot be driven.
  await rpc('session.history', { sessionId: foreignSessionId })
  for (const [method, payload] of [
    ['session.prompt', { sessionId: foreignSessionId, mode: 'queue', content: [{ type: 'text', text: 'hi' }] }],
    ['commands.execute', { sessionId: foreignSessionId, line: '/plan' }],
    [BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId: foreignSessionId, snapshot: 'Page: x' }],
    [BRIDGE_SESSION_PURGE_METHOD, { sessionId: foreignSessionId }],
  ]) {
    const refused = await rpc.request(method, payload)
    const error = refused.ok ? refused.result?.result?.error : refused.error
    assert.equal(error?.code, 'forbidden', `${method}: ${JSON.stringify(refused)}`)
  }
  assert.equal((await rpc('session.list', {})).items.some(item => item.sessionId === foreignSessionId), false,
    'the panel lists only the bridge\'s own sessions')
  // Snapshot injection and prompts need a restricted preset; under a
  // full-access Host default, switching back to one is the allowed way out.
  const startingPreset = (await rpc('session.permissions', { sessionId })).current
  const switchedFromFullAccess = !['read-only', 'workspace-write'].includes(startingPreset)
  if (switchedFromFullAccess) {
    const refused = await rpc.request(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot: 'Page: refused' })
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'forbidden')
    await rpc('commands.execute', { sessionId, line: '/permission workspace-write' })
  }
  const image = await rpc('session.attachment', { sessionId, attachment: initial.attachment })
  assert.deepEqual(image.attachment, initial.attachment)
  assert.equal(Buffer.from(image.data, 'base64').byteLength, initial.attachment.bytes)
  assert.ok(image.attachment.width > 0 && image.attachment.height > 0)
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  await rpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot: 'Page: runtime smoke snapshot' })
  const history = await rpc('session.history', { sessionId })
  assert.ok(Array.isArray(history.events))
  const observedState = await rpc.event('session/state', sessionId, state => state.active && !state.running)
  assert.equal(observedState.frame.payload.queue.some(item => item.placement === 'context'), true)
  assert.equal(history.projections.values.imageLimits.maxImageBytes, 50 * 1024 * 1024)
  const older = await rpc('session.history', { sessionId, beforeSeq: history.events.at(-1).event.seq, maxMessages: 1 })
  assert.ok(older.events.every(({ event }) => event.seq < history.events.at(-1).event.seq))
  const selectedModel = { provider: 'smoke-provider', model: 'smoke-model' }
  assert.deepEqual((await rpc('session.models', { sessionId })).current, selectedModel)
  const injected = history.events.flatMap(({ event }) => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .find(message => message.source.kind === 'browser-context')
  // DSH 0.2 producer-owned kinds use `browser-context` (not plugin:<package>).
  assert.ok(injected, 'the live inbox must retain the producer-owned browser snapshot')
  assert.ok(injected.content.some(block => block.type === 'text' && block.text.includes('runtime smoke snapshot')))
  // A snapshot refused while the session ran full access never reached the Agent.
  assert.equal(JSON.stringify(history.events).includes('Page: refused'), false, 'a refused injection must not land')
  const migrated = await rpc('session.history', { sessionId: legacySessionId })
  assert.ok(migrated.events.some(({ event }) => event.type === 'system/message'), 'V2 migration must insert the V3 system head')
  assert.equal(migrated.events.find(({ event }) => event.type === 'user/message')?.event.data.content[0].text, 'Saved browser conversation')
  assert.deepEqual(await readFile(legacyFile), legacyBytes, 'migration must preserve the original V2 log')

  // ---- Multi-connection bridge and approvals answered by another owner client ----
  {
    const wsUrl = rpc.base.replace('http:', 'ws:') + '/ext/bridge'
    const baseCaps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }
    const chrome = await connectClient(wsUrl, { ...baseCaps, client: { id: 'smoke-chrome-0001', browser: 'chrome' } })
    const firefox = await connectClient(wsUrl, { ...baseCaps, client: { id: 'smoke-firefox-001', browser: 'firefox' } })
    assert.equal(chrome.ok.caps.hostApprovals, 1, 'the real bridge forwards approvals to dsh')
    // Two installs coexist with the original (legacy) connection.
    await delay(200)
    assert.equal(chrome.ws.readyState, WebSocket.OPEN)
    assert.equal(firefox.ws.readyState, WebSocket.OPEN)
    assert.equal(socket.readyState, WebSocket.OPEN)
    // The same install reconnecting replaces only itself.
    const firefoxAgain = await connectClient(wsUrl, { ...baseCaps, client: { id: 'smoke-firefox-001', browser: 'firefox' } })
    const [replacedCode] = await firefox.closed
    assert.equal(replacedCode, BRIDGE_CLOSE_CODES.replaced)
    assert.equal(chrome.ws.readyState, WebSocket.OPEN)
    // Holds and forwarded approvals only name calls this connection was sent.
    const foreignHold = await chrome.request(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: 'not-mine', holdMs: 1_000 })
    assert.equal(foreignHold.error?.code, 'not-found')

    // A real Agent turn, driven from the Chrome install, calls a browser tool.
    const approvalSession = (await rpc('session.create', { cwd: temp })).sessionId
    await rpc('session.selectModel', { sessionId: approvalSession, provider: 'scripted', model: 'scripted' })
    const pressOnce = async (decisionMarker) => {
      const before = chrome.frames.filter(value => value.t === 'tool.call').length
      const prompted = await chrome.request('session.prompt', {
        sessionId: approvalSession, mode: 'queue', content: [{ type: 'text', text: 'Press Enter.' }],
      })
      assert.equal(prompted.ok, true, JSON.stringify(prompted))
      const call = await waitFor(() => chrome.frames.filter(value => value.t === 'tool.call')[before], 'browser tool call', 60_000)
      assert.equal(call.name, 'browser_press')
      assert.equal(call.sessionId, approvalSession, 'the call carries its Agent session')
      assert.equal(firefoxAgain.frames.some(value => value.t === 'tool.call'), false, 'the session routes to the install that prompted it')
      // No side panel: hold the call, then ask dsh's approval service.
      const hold = await chrome.request(BRIDGE_TOOL_HOLD_METHOD, { toolCallId: call.id, holdMs: 120_000 })
      assert.ok(hold.result.expiresAt > call.expiresAt, 'the hold extends the call deadline')
      const binding = 'b'.repeat(64)
      const asked = await chrome.request(BRIDGE_APPROVAL_ASK_METHOD, {
        toolCallId: call.id, approvalId: `smoke-${randomUUID()}`, binding,
        reason: `Press Enter on example.com ${decisionMarker}`, sessionId: 'spoofed-session',
      }, 60_000)
      assert.equal(asked.ok, true, JSON.stringify(asked))
      assert.equal(asked.result.binding, binding, 'the answer echoes the payload binding asked about')
      // The extension acts on the decision.
      chrome.send(asked.result.decision === 'allow-once'
        ? { t: 'tool.result', id: call.id, ok: true, result: { text: 'Pressed Enter.' } }
        : { t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'The user denied this browser action.' } })
      return asked.result.decision
    }
    assert.equal(await pressOnce('SMOKE-ALLOW'), 'allow-once')
    const logged = (await readFile(approvalLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(logged[0].toolName, 'browser_press')
    assert.equal(logged[0].sessionId, approvalSession, 'the session comes from the bridge record, not the payload')
    assert.match(logged[0].reason, /Press Enter on example\.com/)
    await waitFor(async () => (await rpc('session.state', { sessionId: approvalSession })).running === false, 'turn end', 60_000)
    assert.equal(await pressOnce('SMOKE-DENY'), 'deny')
    await waitFor(async () => (await rpc('session.state', { sessionId: approvalSession })).running === false, 'turn end', 60_000)
    const approvalHistory = JSON.stringify((await rpc('session.history', { sessionId: approvalSession })).events)
    assert.match(approvalHistory, /Pressed Enter\./)
    assert.match(approvalHistory, /denied this browser action/)
    chrome.ws.close()
    firefoxAgain.ws.close()
  }

  await stop()
  rpc = await start(true)
  assert.equal((await observation()).source, 'prepared')
  for (const entry of worktreeSessions) {
    const worktree = await observation(`${marker}.${entry.sessionId}`)
    await rpc('session.history', { sessionId: entry.sessionId })
    await rpc('session.models', { sessionId: entry.sessionId })
    await rpc('session.permissions', { sessionId: entry.sessionId })
    await rpc('commands.list', { sessionId: entry.sessionId, passive: true })
    await rpc('skills.list', { sessionId: entry.sessionId })
    assert.equal((await rpc('session.state', { sessionId: entry.sessionId })).active, false,
      'browsing history and composer directories must leave the Agent inactive')
    if (entry.failCleanup) {
      // 暂时撤销隔离仓库配置的读取权限，验证真实 Git 失败后的归档恢复和重试。
      const gitConfig = join(worktreeRepository, '.git/config')
      const configMode = (await stat(gitConfig)).mode
      await chmod(gitConfig, 0)
      try {
        const failed = await rpc.request(BRIDGE_SESSION_PURGE_METHOD, { sessionId: entry.sessionId })
        assert.equal(failed.ok, false, JSON.stringify(failed))
        assert.match(failed.error.message, /worktree cleanup failed/)
        assert.equal((await rpc('workspace.list', {})).archivedSessionIds.includes(entry.sessionId), false)
        assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === entry.sessionId))
        assert.ok((await rpc('session.history', { sessionId: entry.sessionId })).events.length > 0)
      } finally {
        await chmod(gitConfig, configMode)
      }
      await rm(`${marker}.cleanup-${entry.sessionId}`)
    }
    await rpc(BRIDGE_SESSION_PURGE_METHOD, { sessionId: entry.sessionId })
    const cleanup = await observation(`${marker}.cleanup-${entry.sessionId}`)
    assert.equal(cleanup.cleanup.status, entry.dirty ? 'retained' : 'removed')
    assert.equal(existsSync(worktree.path), entry.dirty)
    if (entry.dirty) assert.equal(await readFile(join(worktree.path, 'user-note.txt'), 'utf8'), 'Keep this file.\n')
    execFileSync('git', ['show-ref', '--verify', `refs/heads/${worktree.branch}`], { cwd: worktreeRepository, env })
  }
  assert.equal((await rpc('session.state', { sessionId })).active, false)
  await rpc('session.history', { sessionId, beforeSeq: 1, maxMessages: 1 })
  assert.equal((await rpc('session.state', { sessionId })).active, false, 'passive pagination must leave a cold Agent inactive')
  assert.deepEqual((await rpc('session.models', { sessionId })).current, selectedModel)
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  const reopened = (await rpc('session.history', { sessionId })).events
  await rpc.event('session/state', sessionId, state => !state.active)
  const restoredImage = await rpc('session.attachment', { sessionId, attachment: initial.attachment })
  assert.equal(restoredImage.data, image.data)
  assert.deepEqual(reopened.slice(0, history.events.length), history.events)
  // A graceful shutdown disposes the Agent through agent-loop's teardown, which
  // cancels the live machine with `machine.cancel({ kind: 'disposed' })` and no
  // `keepInbox` — only the user's stop button preserves pending input. The
  // unclaimed browser snapshot is therefore recorded as one canceled inbox
  // splice. Assert that exact contract: a future runtime that starts preserving
  // the inbox across disposal changes this row and must update the expectation
  // deliberately, instead of silently dropping the pending page context.
  const shutdown = reopened.slice(history.events.length)
  assert.equal(shutdown.length, 1, `restart must record one inbox splice: ${JSON.stringify(shutdown)}`)
  const splice = shutdown[0]?.event
  assert.equal(splice?.type, 'agent/inbox/spliced')
  assert.equal(splice.data.outcome, 'canceled')
  // A preset switch on a live Agent also queues its own context notice.
  assert.equal(splice.data.removedCount, switchedFromFullAccess ? 2 : 1, JSON.stringify(splice))
  const reopenedLegacy = await rpc('session.history', { sessionId: legacySessionId })
  // 历史订阅保持被动读取，迁移后的历史前缀保持一致。
  assert.deepEqual(reopenedLegacy.events.slice(0, migrated.events.length), migrated.events)
  assert.deepEqual(await readFile(legacyFile), legacyBytes)
  // Composer controls: the panel reaches the Host permission preset table and
  // its slash-command/skill directories through bridge-owned Host methods.
  const presetCatalog = await rpc('permission.catalog', {})
  const presetValues = presetCatalog.options.map(option => option.value)
  assert.ok(presetValues.includes('read-only'), 'the catalog must expose read-only')
  assert.ok(presetValues.includes('workspace-write'), 'the catalog must expose workspace-write')
  assert.ok(presetValues.includes('danger-full-access'), 'the catalog must expose danger-full-access')
  assert.equal(typeof presetCatalog.defaultPreset, 'string')
  assert.ok(presetValues.includes(presetCatalog.defaultPreset), 'the default must be a selectable preset')
  assert.ok(presetCatalog.options.every(option => typeof option.name === 'string' && option.name !== ''))

  const initialPermissions = await rpc('session.permissions', { sessionId })
  assert.equal(initialPermissions.routable, true)
  assert.equal(initialPermissions.provisional, false)
  assert.ok(['read-only', 'workspace-write'].includes(initialPermissions.current), initialPermissions.current)
  assert.deepEqual(initialPermissions.options, presetCatalog.options)

  const commandNames = (await rpc('commands.list', { sessionId })).commands.map(command => command.name)
  assert.ok(commandNames.includes('permission'), `the command directory must expose /permission: ${JSON.stringify(commandNames)}`)
  assert.ok(commandNames.includes('plan'), `the command directory must expose /plan: ${JSON.stringify(commandNames)}`)

  const permissionCommand = await rpc('commands.execute', { sessionId, line: '/permission read-only' })
  assert.equal(permissionCommand.result.kind, 'success')
  assert.equal((await rpc('session.permissions', { sessionId })).current, 'read-only')
  await rpc('session.history', { sessionId })
  // Full access is refused over the bridge unless the plugin config allows it,
  // through both the permission control and the /permission command.
  for (const [method, payload] of [
    ['session.setPermission', { sessionId, preset: 'danger-full-access' }],
    ['commands.execute', { sessionId, line: '/permission danger-full-access' }],
  ]) {
    const refused = await rpc.raw(method, payload)
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'forbidden')
    assert.match(refused.error.message, /allowDangerFullAccess/)
  }
  assert.equal((await rpc('session.permissions', { sessionId })).current, 'read-only')
  await rpc('session.setPermission', { sessionId, preset: 'workspace-write' })
  await rpc.event('session/projection', sessionId, projection => projection.changes.some(change => (
    change.key === 'permissions' && change.val.currentValue === 'workspace-write'
  )))
  assert.equal((await rpc('session.permissions', { sessionId })).current, 'workspace-write')

  // Least privilege: methods outside the extension's needs, and sessions
  // outside its scope, never reach the Host.
  for (const method of ['host.openPath', 'settings.update', 'workspace.create']) {
    const refused = await rpc.raw(method, {})
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'forbidden')
  }
  const foreign = await rpc.raw('session.history', { sessionId: `session-${randomUUID()}` })
  assert.equal(foreign.ok, false, JSON.stringify(foreign))
  assert.equal(foreign.error.code, 'forbidden')

  const unknownCommand = await rpc.raw('commands.execute', { sessionId, line: '/definitely-not-a-command' })
  assert.equal(unknownCommand.ok, false, JSON.stringify(unknownCommand))
  assert.equal(unknownCommand.error.code, 'bad-request')
  // A preset the Host table cannot vouch for is refused as possibly full access.
  const unknownPreset = await rpc.raw('session.setPermission', { sessionId, preset: 'custom' })
  assert.equal(unknownPreset.ok, false, JSON.stringify(unknownPreset))
  assert.equal(unknownPreset.error.code, 'forbidden')

  const skillDirectory = await rpc('skills.list', { sessionId })
  assert.ok(Array.isArray(skillDirectory.skills))
  assert.ok(skillDirectory.skills.every(skill => (
    typeof skill.name === 'string' && skill.name !== '' && typeof skill.modelInvocable === 'boolean'
  )))

  const retrySession = (await rpc('session.create', { cwd: temp })).sessionId
  await rpc('session.selectModel', { sessionId: retrySession, provider: 'connection-check', model: 'connection-check' })
  await Promise.all([
    rpc('session.history', { sessionId: retrySession }),
    rpc('session.history', { sessionId: retrySession }),
    rpc('session.prompt', {
      sessionId: retrySession, mode: 'queue', content: [{ type: 'text', text: 'Say hello.' }],
    }),
  ])
  const originalCursor = (await rpc('session.state', { sessionId })).cursor
  await rpc('session.setPermission', { sessionId, preset: 'read-only' })
  await rpc.event('session/projection', sessionId, projection => projection.seq > originalCursor
    && projection.changes.some(change => change.key === 'permissions' && change.val.currentValue === 'read-only'))
  await rpc.event('session/state', sessionId, state => state.cursor > originalCursor)
  const failed = await rpc.event('session/projection', retrySession, projection => projection.changes.some(change => (
    change.key === 'conversationContinuation' && typeof change.val === 'number'
  )))
  const failureSeq = failed.frame.payload.seq
  await rpc.event('session/state', retrySession, state => !state.running && state.cursor >= failureSeq)
  await rpc('session.prompt', { sessionId: retrySession, mode: 'queue', content: [] })
  await rpc.event('session/event', retrySession, payload => payload.event.type === 'turn/end' && payload.event.seq > failureSeq)
  const retried = await rpc('session.history', { sessionId: retrySession })
  const messages = retried.events.filter(({ event }) => event.type === 'user/message').map(({ event }) => event.data)
  assert.equal(messages.filter(message => message.source.kind === 'user').length, 1)
  assert.ok(messages.some(message => message.source.kind === 'retry' && message.content.length === 0))
  const endings = retried.events.filter(({ event }) => event.type === 'turn/end')
  assert.equal(endings.length, 2)
  assert.ok(endings.every(({ event }) => event.data.reason.kind === 'error' && event.data.reason.error.code === 'TRANSPORT'))

  // A prompt whose text looks like a command stays a prompt: it must not
  // switch the preset on the Host's side either.
  await rpc('session.setPermission', { sessionId: retrySession, preset: 'read-only' })
  const promptCursor = (await rpc('session.state', { sessionId: retrySession })).cursor
  await rpc('session.prompt', {
    sessionId: retrySession, mode: 'queue', content: [{ type: 'text', text: '/permission danger-full-access' }],
  })
  await rpc.event('session/event', retrySession, payload => payload.event.type === 'turn/end' && payload.event.seq > promptCursor)
  assert.equal((await rpc('session.permissions', { sessionId: retrySession })).current, 'read-only',
    'prompt text must never act as a /permission command')

  console.log('Real DSH smoke passed: discovery, mutual authentication (forged Origins and v1 clients refused), multi-client bridge with per-install replacement and session routing, browser approvals forwarded to dsh and answered by another owner client (allow and deny), least-privilege fencing (full access refused), image storage and reads, passive history, concurrent history and prompt admission, independent session observations, model and permission selection, Host commands and skills, V2 migration, browser context, continuation after a real transport failure, and session deletion including worktree cleanup failure and retry')
  succeeded = true
} catch (error) {
  console.error(hostLog)
  console.error(`Smoke artifacts retained at ${temp}`)
  throw error
} finally {
  await stop()
  scriptedModel.close()
  if (succeeded) await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
