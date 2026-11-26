/**
 * `/browser-clear`: lift the untrusted-web-content restriction of the
 * conversation it is typed in, from DSH itself (the extension panel's Clear
 * does the same from the browser). A slash command is the user's own input:
 * the agent cannot run it, so clearing stays a user act.
 *
 * @module @natgurlain/dsh-browser-agent/src/taint-command
 */

import type { SessionTaintRegistry } from './session-taint.ts'

/** The command name (typed as `/browser-clear`). */
export const TAINT_CLEAR_COMMAND_NAME = 'browser-clear'

/** The slice of `ctx.commands` this module uses. */
export interface TaintCommandRegistry {
  register(definition: {
    name: string
    description: string
    handler: (invocation: { agent?: { id: unknown } }) => Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => unknown
}

/**
 * Register `/browser-clear`.
 * @param notifyCleared - tells the connected extensions, so their own record clears too.
 * @returns the disposer, or undefined when DSH offers no command registry.
 */
export function mountTaintClearCommand(
  commands: TaintCommandRegistry | undefined,
  registry: SessionTaintRegistry,
  notifyCleared: (sessionId: string) => void,
): (() => unknown) | undefined {
  if (typeof commands?.register !== 'function') return undefined
  return commands.register({
    name: TAINT_CLEAR_COMMAND_NAME,
    description: 'Turn shell, file and network tools back on after this conversation read untrusted web content',
    handler: async (invocation) => runTaintClear(registry, notifyCleared, invocation.agent?.id),
  })
}

/** The command's effect, separate for tests. */
export function runTaintClear(
  registry: SessionTaintRegistry,
  notifyCleared: (sessionId: string) => void,
  id: unknown,
): { kind: 'success' | 'error'; text: string } {
  if (id === undefined || id === null || String(id) === '') {
    return { kind: 'error', text: `/${TAINT_CLEAR_COMMAND_NAME} must be typed in the conversation to clear.` }
  }
  const sessionId = String(id)
  const own = registry.clear(sessionId)
  // Always told: the extension may hold a record the bridge has already forgotten (a Host restart).
  notifyCleared(sessionId)
  const inherited = registry.effective(sessionId)
  if (inherited !== undefined) {
    const parent = registry.ancestors(sessionId).find((ancestor) => registry.get(ancestor) !== undefined)
    return {
      kind: 'error',
      text: `This conversation is still restricted through the conversation it was started from${parent === undefined ? '' : ` (${parent})`}: run /${TAINT_CLEAR_COMMAND_NAME} there.`,
    }
  }
  return {
    kind: 'success',
    text: own
      ? 'Shell, file and network tools are back on for this conversation. Pages it reads later can restrict it again.'
      : 'This conversation was not restricted.',
  }
}
