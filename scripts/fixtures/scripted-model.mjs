// A tiny OpenAI-compatible chat-completions server for the browser smoke: it
// answers with a scripted sequence of browser tool calls and then a final
// message, so a real Agent session drives the extension (timeline steps,
// session audit log, pause/resume injection) without any external model.
import { once } from 'node:events'
import { createServer } from 'node:http'

/**
 * @param {Array<{ name: string, args: Record<string, unknown> }>} steps - tool calls, in order.
 * @param {string} finalText - the closing assistant message.
 */
export async function startScriptedModel(steps, finalText) {
  const state = { requests: 0, sawResumeContext: false, toolResults: [] }
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { /* not JSON */ }
    if (!String(request.url).endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    state.requests += 1
    const messages = Array.isArray(body.messages) ? body.messages : []
    const text = message => typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content) ? message.content.map(part => part?.text ?? '').join('\n') : ''
    if (messages.some(message => message.role === 'user' && text(message).includes('paused browser control and has now resumed'))) {
      state.sawResumeContext = true
    }
    const toolMessages = messages.filter(message => message.role === 'tool')
    state.toolResults = toolMessages.map(text)
    const next = steps[toolMessages.length]
    // A step may "think" first, leaving the panel time to show the running controls.
    if (next?.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, next.delayMs))
    const id = `chatcmpl-${state.requests}`
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'scripted' }
    const delta = next === undefined
      ? { role: 'assistant', content: finalText }
      : { role: 'assistant', tool_calls: [{ index: 0, id: `call_${state.requests}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
    const finish = next === undefined ? 'stop' : 'tool_calls'
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    const message = next === undefined
      ? { role: 'assistant', content: finalText }
      : { role: 'assistant', content: null, tool_calls: delta.tool_calls.map(({ index: _index, ...call }) => call) }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    state,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
