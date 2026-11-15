// Conversation-aware scripted replies for the Phase 3 smokes (page watchers,
// tab fleets). Parent and fleet-child conversations share one model server, so
// the reply is chosen from the conversation itself, never from a call counter.

const textOf = message => typeof message?.content === 'string'
  ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : ''

/**
 * @param {{ messages?: unknown[], tools?: unknown[] }} body - the chat-completions request.
 * @param {object} state - shared observations the smokes assert on.
 * @returns {{ tool: { name: string, args: object } } | { text: string } | undefined} undefined: not a Phase 3 conversation.
 */
export function phase3Reply(body, state) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const users = messages.filter(message => message.role === 'user')
  const firstUser = textOf(users[0])
  if (firstUser.includes('Generate the session title')) {
    return /PHASE3-|\[Page watcher/u.test(firstUser) ? { text: 'Phase 3 smoke' } : undefined
  }
  // The latest prompt that drives a Phase 3 step. Context the harness injects
  // after it (approval-policy notices, page snapshots) is also a user message.
  const lastUserIndex = messages.findLastIndex(message => message.role === 'user' && /PHASE3-|\[Page watcher/u.test(textOf(message)))
  const lastUser = lastUserIndex === -1 ? '' : textOf(messages[lastUserIndex])
  const toolsSinceUser = lastUserIndex === -1 ? [] : messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool')
  const offered = Array.isArray(body.tools) ? body.tools.map(tool => tool?.function?.name ?? tool?.name).filter(Boolean) : []

  // ---- A fleet worker (its first user message is the fleet prompt) ----
  if (users.some(message => textOf(message).includes('browser fleet worker'))) {
    const url = /already shows (\S+)\./u.exec(firstUser)?.[1] ?? ''
    state.fleetChildren ??= {}
    state.fleetChildren[url] = { ...state.fleetChildren[url], offered }
    const toolMessages = messages.filter(message => message.role === 'tool')
    if (toolMessages.length === 0) {
      // A read-only worker that tries to act first: the bridge must refuse it.
      if (/try-to-click/u.test(firstUser)) return { tool: { name: 'browser_click', args: { selector: 'h1' } } }
      return { tool: { name: 'browser_get_text', args: { selector: 'h1' } } }
    }
    const lastTool = textOf(toolMessages.at(-1))
    if (/try-to-click/u.test(firstUser) && toolMessages.length === 1) {
      state.fleetChildren[url].clickResult = lastTool
      return { tool: { name: 'browser_get_text', args: { selector: 'h1' } } }
    }
    if (offered.includes('structured_output') && !messages.some(message => message.role === 'assistant' && JSON.stringify(message.tool_calls ?? '').includes('structured_output'))) {
      const price = /\$\d+/u.exec(toolMessages.map(textOf).join('\n'))?.[0] ?? 'unknown'
      return { tool: { name: 'structured_output', args: { price } } }
    }
    return { text: 'Worker done.' }
  }

  // ---- A watcher woke the session ----
  if (lastUser.includes('[Page watcher') && toolsSinceUser.length === 0) {
    state.wakes ??= []
    state.wakes.push(lastUser)
    return { text: 'Watcher handled: it is back in stock.' }
  }

  // ---- The parent asks for a watcher ----
  if (lastUser.includes('PHASE3-WATCH')) {
    if (toolsSinceUser.length === 0) {
      return { tool: { name: 'browser_watch', args: { condition: { text: 'Back in stock' }, prompt: 'Tell the user the item is back in stock.', expiresInMinutes: 30 } } }
    }
    state.watchResult = textOf(toolsSinceUser.at(-1))
    return { text: 'Watching the page.' }
  }

  // ---- The parent asks for a fleet ----
  if (lastUser.includes('PHASE3-FANOUT')) {
    if (toolsSinceUser.length === 0) {
      const urls = lastUser.match(/https?:\/\/\S+/gu) ?? []
      return {
        tool: {
          name: 'browser_fanout',
          args: {
            tasks: urls.map((url, index) => ({ url, instruction: index === 0 && lastUser.includes('try-to-click') ? 'Read the price (try-to-click first)' : 'Read the price' })),
            outputSchema: { type: 'object', properties: { price: { type: 'string' } }, required: ['price'] },
          },
        },
      }
    }
    state.fanoutResult = textOf(toolsSinceUser.at(-1))
    return { text: 'Fleet done.' }
  }
  return undefined
}

