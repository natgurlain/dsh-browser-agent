import test from 'node:test'
import assert from 'node:assert/strict'
import { appendEventTypeRun, runOne } from '../lib/run-one.mjs'
import { makeTaskInstance } from '../lib/tasks.mjs'
import { startBenchmarkSite } from '../site/server.mjs'

test('event diagnostics use lossless run-length encoding', () => {
  const eventTypeRuns = []
  for (const type of ['assistant/chunk', 'assistant/chunk', 'tool/call', 'tool/result', 'tool/result']) {
    appendEventTypeRun(eventTypeRuns, type)
  }

  assert.deepEqual(eventTypeRuns, [
    { type: 'assistant/chunk', count: 2 },
    { type: 'tool/call', count: 1 },
    { type: 'tool/result', count: 2 },
  ])
  assert.deepEqual(eventTypeRuns.flatMap((run) => Array(run.count).fill(run.type)), [
    'assistant/chunk',
    'assistant/chunk',
    'tool/call',
    'tool/result',
    'tool/result',
  ])
})

test('V3 benchmark measures first live token before settlement and counts durable usage once', async (t) => {
  const site = await startBenchmarkSite({ port: 0 })
  t.after(() => site.close())
  const instance = makeTaskInstance('order_lookup', 1, 'v3-metrics', site.origin)
  const calls = []
  let listener
  const client = {
    async rpc(method) {
      calls.push(method)
      if (method === 'session.create') return { sessionId: 'session-metrics' }
      if (method === 'session.modelCatalog') return { default: { provider: 'fixture', model: 'fixture-model' }, routableProviders: ['fixture'] }
      if (method === 'session.history') return { projections: { values: { sessionStats: { llmMs: 27 } } } }
      assert.equal(method, 'session.prompt')
      assert.ok(calls.indexOf('session/follow') < calls.indexOf('session.prompt'))
      const at = performance.now()
      const event = (type, data, offset) => listener({ type: 'session/event', sessionId: 'session-metrics', event: { type, data } }, at + offset)
      event('turn/start', { turn: 1 }, 0)
      listener({ type: 'session/assistant-stream', sessionId: 'session-metrics', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '', index: 0 } } }, at + 5)
      listener({ type: 'session/assistant-stream', sessionId: 'session-metrics', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'answer', index: 0 } } }, at + 10)
      event('tool/call', { callId: 'tool-1', name: 'browser_snapshot', arguments: {} }, 15)
      event('tool/result', { message: { source: { callId: 'tool-1' }, content: [] } }, 20)
      event('assistant/message', {
        message: { content: [{ type: 'text', text: instance.expected.value }], source: { kind: 'model', provider: 'fixture', model: 'fixture-model' } },
        usage: { inputTokens: 100, outputTokens: 5 },
        stream: [],
      }, 35)
      event('turn/end', { reason: { kind: 'completed' } }, 40)
      return { accepted: true }
    },
    async followSession() { calls.push('session/follow') },
    onFrame(callback) { listener = callback; return () => { listener = undefined } },
  }
  const result = await runOne({
    backend: { backend: 'extension', client },
    extensionBrowser: { prepare: async () => {} },
    instance, siteOrigin: site.origin, workspace: '/tmp/benchmark', timeoutMs: 500,
  })
  assert.equal(result.success, true)
  assert.ok(Math.abs(result.timings.completionMs - result.timings.ttftMs - 30) < 0.02)
  assert.deepEqual(result.tokens, { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
  assert.equal(result.timings.llmMs, 27)
})

test('an extension run applies the task settings, binds the session to the tab, and records refused tool calls', async (t) => {
  const site = await startBenchmarkSite({ port: 0 })
  t.after(() => site.close())
  const steps = []
  let listener
  const client = {
    async rpc(method) {
      if (method === 'session.create') {
        steps.push('session.create')
        return { sessionId: 'session-bind' }
      }
      if (method === 'session.modelCatalog') return { default: { provider: 'fixture', model: 'fixture-model' }, routableProviders: ['fixture'] }
      if (method === 'session.history') return {}
      assert.equal(method, 'session.prompt')
      steps.push('session.prompt')
      const at = performance.now()
      const event = (type, data, offset) => listener({ type: 'session/event', sessionId: 'session-bind', event: { type, data } }, at + offset)
      event('turn/start', { turn: 1 }, 0)
      event('tool/call', { callId: 'tool-1', name: 'browser_click', arguments: { index: 1 } }, 5)
      event('tool/result', { message: { role: 'tool', source: { callId: 'tool-1' }, isError: true, content: [{ type: 'text', text: 'Error: denied' }] } }, 10)
      event('tool/call', { callId: 'tool-2', name: 'browser_dialog', arguments: { accept: true } }, 15)
      event('tool/result', { message: { role: 'tool', toolCallId: 'tool-2', source: {}, isError: false, content: [{ type: 'text', text: 'ok' }] } }, 20)
      event('turn/end', { reason: { kind: 'completed' } }, 25)
      return { accepted: true }
    },
    async followSession() {},
    onFrame(callback) { listener = callback; return () => { listener = undefined } },
  }
  const extensionBrowser = {
    configure: async (settings) => { steps.push(['configure', settings]) },
    prepare: async () => { steps.push('prepare') },
    bindSession: async (sessionId) => { steps.push(['bindSession', sessionId]) },
  }
  const run = (taskId) => runOne({
    backend: { backend: 'extension', client },
    extensionBrowser,
    instance: makeTaskInstance(taskId, 1, `bind-${taskId}`, site.origin),
    siteOrigin: site.origin, workspace: '/tmp/benchmark', timeoutMs: 500,
  })
  const result = await run('confirm_delete')
  // Dialogs are caught only for the task that raises one; the session is bound before the prompt.
  assert.deepEqual(steps, [['configure', { catchPageDialogs: true }], 'prepare', 'session.create', ['bindSession', 'session-bind'], 'session.prompt'])
  assert.deepEqual(result.tools.calls.map((call) => [call.name, call.ok]), [['browser_click', false], ['browser_dialog', true]])
  steps.length = 0
  await run('contact_form')
  assert.deepEqual(steps[0], ['configure', { catchPageDialogs: false }])
})
