import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { closedPort, providerYaml, runCli, smokeEnv, startHost, streamReply, waitFor } from '../lib/dsh-harness.mjs'

function fakeCli(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-harness-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'fake-dsh.mjs')
  writeFileSync(file, body)
  return file
}

test('startHost reads the URL and stop() falls back to SIGKILL when DSH ignores SIGTERM', async (t) => {
  const cli = fakeCli(t, `process.on('SIGTERM', () => {}); console.log('dsh web: http://127.0.0.1:4321'); setInterval(() => {}, 1000)\n`)
  const host = await startHost({ cli, patch: 'unused.yml', env: process.env, killAfter: 300 })
  assert.equal(host.base, 'http://127.0.0.1:4321')
  const started = Date.now()
  await host.stop()
  assert.ok(host.exited())
  // Windows has no catchable SIGTERM: kill() terminates at once.
  if (process.platform !== 'win32') assert.equal(host.child.signalCode, 'SIGKILL')
  assert.ok(Date.now() - started < 5_000)
  await host.stop() // idempotent
})

test('waitFor fails fast with the log once the host has exited', async (t) => {
  const cli = fakeCli(t, `console.log('dsh web: http://127.0.0.1:4322'); console.log('boom detail'); setTimeout(() => process.exit(3), 200)\n`)
  const host = await startHost({ cli, patch: 'unused.yml', env: process.env })
  await assert.rejects(waitFor(() => false, 'never', { timeout: 10_000, host }), /DSH exited \(3\) while waiting for never[\s\S]*boom detail/u)
})

test('runCli fails on a non-zero exit and kills a hung command', async (t) => {
  const failing = fakeCli(t, `console.error('nope'); process.exit(2)\n`)
  await assert.rejects(runCli(failing, ['x'], { env: process.env }), /failed \(2\): nope/u)
  const hung = fakeCli(t, 'setInterval(() => {}, 1000)\n')
  await assert.rejects(runCli(hung, ['x'], { env: process.env, timeout: 200 }), /failed \(SIGKILL\)/u)
})

test('closedPort is a port nothing listens on', async () => {
  const port = await closedPort()
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.on('connect', () => { socket.destroy(); reject(new Error('something listens')) })
    socket.on('error', (error) => { error.code === 'ECONNREFUSED' ? resolve() : reject(error) })
  })
})

test('smokeEnv scrubs inherited bridge settings', () => {
  process.env.DSH_EXT_TOKEN = 'leak'
  try {
    const env = smokeEnv('/tmp/home', { EXTRA: '1' })
    assert.equal(env.DSH_HOME, '/tmp/home')
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
    assert.equal(env.EXTRA, '1')
    assert.equal('DSH_EXT_TOKEN' in env, false)
  } finally {
    delete process.env.DSH_EXT_TOKEN
  }
})

test('providerYaml writes one llm-pi-ai provider without retries', () => {
  assert.deepEqual(providerYaml('scripted', 9, ['a', { id: 'b', input: ['text'] }], { input: ['text', 'image'] }), [
    '      scripted:',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:9/v1',
    '        headers:',
    '          Authorization: Bearer local-scripted',
    '        models:',
    '          - id: a',
    '            input: [text, image]',
    '          - id: b',
    '            input: [text]',
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 0',
  ])
})

test('streamReply writes an OpenAI-style stream for text and tool calls', async () => {
  const capture = () => {
    const stream = new PassThrough()
    let text = ''
    stream.on('data', (chunk) => { text += chunk })
    stream.writeHead = (status, headers) => { stream.status = status; stream.headers = headers; return stream }
    return { stream, text: () => text }
  }
  const tool = capture()
  streamReply(tool.stream, { tool: { name: 'browser_press', args: { key: 'Enter' }, id: 'call_1' } }, { id: 'c1', model: 'm' })
  await new Promise((resolve) => setImmediate(resolve))
  const events = tool.text().split('\n\n').filter(Boolean)
  assert.equal(tool.stream.headers['content-type'], 'text/event-stream')
  assert.equal(events.at(-1), 'data: [DONE]')
  const first = JSON.parse(events[0].slice(6))
  assert.equal(first.model, 'm')
  assert.deepEqual(first.choices[0].delta.tool_calls[0], { index: 0, id: 'call_1', type: 'function', function: { name: 'browser_press', arguments: '{"key":"Enter"}' } })
  assert.equal(JSON.parse(events[1].slice(6)).choices[0].finish_reason, 'tool_calls')
  const text = capture()
  streamReply(text.stream, { text: 'Done.' }, 'legacy-model-name')
  await new Promise((resolve) => setImmediate(resolve))
  const parsed = JSON.parse(text.text().split('\n\n')[0].slice(6))
  assert.equal(parsed.model, 'legacy-model-name')
  assert.equal(parsed.choices[0].delta.content, 'Done.')
})
