/**
 * Panel client of the background learning runtime (`dsh-learning` port):
 * one subscription for state pushes plus correlated requests.
 *
 * @module
 */

import type { LearningSettings } from '../background/learning.ts'
import type { RecordedStep } from '../shared/workflow-build.ts'
import type { SiteDriver } from '@natgurlain/dsh-bridge-browser/src/learning/site-drivers.ts'
import type { ProgramStep } from '../shared/repetition.ts'
import { openSidePort } from './side-port.ts'

/** What the background pushes. */
export interface LearningState {
  settings: LearningSettings
  siteDriversSupported: boolean
  steps: RecordedStep[]
  watching: { tabId: number; origin: string; events: number } | null
  suggestion: { tabId: number; origin: string; remaining: number; done: number; period: number; program: ProgramStep[]; labels: string[] } | null
  proposals: Array<{ driver: SiteDriver; droppedHeaders: string[] }>
  drivers: SiteDriver[]
}

export interface LearningClient {
  request<T = unknown>(type: string, body?: Record<string, unknown>): Promise<T>
  dispose(): void
}

/** Error texts the client surfaces (the panel passes localized ones). */
export interface LearningClientErrors {
  failed: string
  disconnected: string
}

const DEFAULT_ERRORS: LearningClientErrors = { failed: 'The request failed.', disconnected: 'Lost the connection to the extension. Try again.' }

/**
 * Open the learning port. It reconnects after a background restart
 * (side-port.ts) and subscribes again; requests in flight then fail.
 * @param sessionId - the panel's current conversation, when any.
 * @param onState - state listener.
 * @param errors - localized error texts.
 */
export function connectLearning(sessionId: string | undefined, onState: (state: LearningState) => void, errors: LearningClientErrors = DEFAULT_ERRORS): LearningClient {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const withSession = (message: Record<string, unknown>): Record<string, unknown> => ({ ...message, ...(sessionId === undefined ? {} : { sessionId }) })
  const failPending = (): void => {
    for (const entry of pending.values()) entry.reject(new Error(errors.disconnected))
    pending.clear()
  }
  const side = openSidePort({
    name: 'dsh-learning',
    subscribe: (post) => { post(withSession({ type: 'learning.subscribe', id: crypto.randomUUID() })) },
    onMessage: (message: unknown) => {
      const msg = message as { type?: string; id?: string; ok?: boolean; result?: unknown; error?: { message?: string }; state?: LearningState }
      if (msg.type === 'learning.state' && msg.state !== undefined) onState(msg.state)
      if (msg.type === 'learning.result' && msg.id !== undefined) {
        const entry = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.ok === true) entry?.resolve(msg.result)
        else entry?.reject(new Error(msg.error?.message ?? errors.failed))
      }
    },
    onDisconnect: failPending,
  })
  const request = <T>(type: string, body: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID()
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    if (!side.post(withSession({ type, id, ...body }))) {
      pending.delete(id)
      reject(new Error(errors.disconnected))
    }
  })
  return {
    request,
    // Requests still in flight are left unsettled: their component is gone.
    dispose: () => { side.dispose() },
  }
}
