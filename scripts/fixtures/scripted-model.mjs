// A tiny OpenAI-compatible chat-completions server for the browser smoke: it
// answers with a scripted sequence of browser tool calls and then a final
// message, so a real Agent session drives the extension (timeline steps,
// session audit log, pause/resume injection) without any external model.
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readJson, streamReply } from '../lib/dsh-harness.mjs'

/** Opens the bridge's fixed Auto review policy (packages/browser/bridge-browser/src/auto-review.ts). */
export const REVIEW_POLICY_MARKER = 'DSH_BROWSER_AUTO_REVIEW_POLICY v1'

const textOfMessage = message => typeof message?.content === 'string'
  ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : ''

/** Whether a chat-completions request is an Auto review (the bridge's reviewer), not the agent. */
export function isReviewRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some(message => (message.role === 'system' || message.role === 'developer') && textOfMessage(message).startsWith(REVIEW_POLICY_MARKER))
    || (typeof body?.system === 'string' && body.system.startsWith(REVIEW_POLICY_MARKER))
}

/** The review's single user message (USER_MESSAGES, PENDING_ACTION, UNTRUSTED_PAGE_DATA). */
export function reviewInput(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.filter(message => message.role === 'user').map(textOfMessage).join('\n')
}

/**
 * An honest scripted reviewer: allows a low-risk action, asks for anything
 * commit-like unless the user's own messages say to submit or send, and
 * always asks for high risk. It reads only the trusted sections.
 */
export function honestReviewer(body) {
  const input = reviewInput(body)
  const trusted = input.split('UNTRUSTED_PAGE_DATA')[0] ?? ''
  const users = trusted.split('PENDING_ACTION')[0] ?? ''
  const facts = trusted.slice(users.length)
  if (/"high_risk_words": true/u.test(facts)) return { decision: 'ask', risk: 'high', reason: 'Payments and account settings always need you.' }
  if (/"commit_like": true|"form_submit_likely": true/u.test(facts)) {
    return /\b(?:submit|send|post|save)\b/iu.test(users)
      ? { decision: 'allow', risk: 'medium', reason: 'You asked to send this.' }
      : { decision: 'ask', risk: 'medium', reason: 'You did not ask to submit or send anything.' }
  }
  return { decision: 'allow', risk: 'low', reason: 'A small in-page step that fits your request.' }
}

/**
 * A step with `gate: '<name>'` is not answered until `release('<name>')`: the
 * model "thinks" for exactly as long as the smoke needs to set something up
 * (click Pause, see it acknowledged), instead of for a fixed time the smoke
 * then has to beat.
 *
 * `state.log` records every request (when it arrived, how many tool results
 * it carried, which step it was answered with): a second request carrying no
 * new tool result is a retry; one carrying a result means that step ran.
 * @param {Array<{ name: string, args: Record<string, unknown>, delayMs?: number, gate?: string }>} steps - tool calls, in order.
 * @param {string} finalText - the closing assistant message.
 */
export async function startScriptedModel(steps, finalText, options = {}) {
  const state = { requests: 0, sawResumeContext: false, toolResults: [], log: [], reviews: [] }
  /**
   * Answers Auto review requests, which never count as agent requests:
   * returns `{ decision, risk, reason }`, `{ text }` (raw output), `{ hang: true }`
   * (never answers, for timeouts) or a promise of one. Default: always ask.
   */
  let reviewer = options.reviewer ?? (() => ({ decision: 'ask', risk: 'low', reason: 'Scripted reviewer: ask.' }))
  const startedAt = Date.now()
  const released = new Set()
  const waiting = new Map()
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    if (!String(request.url).endsWith('/chat/completions')) {
      response.writeHead(404).end()
      return
    }
    if (isReviewRequest(body)) {
      const entry = { atMs: Date.now() - startedAt, input: reviewInput(body) }
      state.reviews.push(entry)
      const answer = await reviewer(body, state)
      entry.answer = answer
      if (answer?.hang === true) {
        await new Promise(resolve => { response.on('close', resolve) })
        return
      }
      const text = typeof answer?.text === 'string' ? answer.text : JSON.stringify({ decision: answer.decision, risk: answer.risk, reason: answer.reason })
      if (body.stream === true) {
        streamReply(response, { text }, { id: `chatcmpl-review-${state.reviews.length}`, model: body.model ?? 'scripted' })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `chatcmpl-review-${state.reviews.length}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model ?? 'scripted', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
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
    const entry = { atMs: Date.now() - startedAt, toolResults: toolMessages.length, answer: next?.name ?? 'final text' }
    state.log.push(entry)
    // A step may "think" first, leaving the panel time to show the running controls.
    if (next?.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, next.delayMs))
    if (next?.gate !== undefined && !released.has(next.gate)) {
      entry.gated = next.gate
      await new Promise(resolve => { waiting.set(next.gate, [...(waiting.get(next.gate) ?? []), resolve]) })
    }
    entry.answeredAtMs = Date.now() - startedAt
    const id = `chatcmpl-${state.requests}`
    const model = body.model ?? 'scripted'
    const callId = `call_${state.requests}`
    if (body.stream === true) {
      streamReply(response, next === undefined ? { text: finalText } : { tool: { name: next.name, args: next.args, id: callId } }, { id, model })
      return
    }
    const base = { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model }
    const finish = next === undefined ? 'stop' : 'tool_calls'
    const message = next === undefined
      ? { role: 'assistant', content: finalText }
      : { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    state,
    /** Let every step gated on `name` answer, now and from here on. */
    release: (name) => {
      released.add(name)
      for (const resolve of waiting.get(name) ?? []) resolve()
      waiting.delete(name)
    },
    /** Replace the reviewer (see `options.reviewer`). */
    setReviewer: (next) => { reviewer = next },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}
