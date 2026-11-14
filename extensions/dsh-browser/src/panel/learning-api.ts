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

/**
 * Open the learning port.
 * @param sessionId - the panel's current conversation, when any.
 * @param onState - state listener.
 */
export function connectLearning(sessionId: string | undefined, onState: (state: LearningState) => void): LearningClient {
  const port = chrome.runtime.connect({ name: 'dsh-learning' })
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  port.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string; id?: string; ok?: boolean; result?: unknown; error?: { message?: string }; state?: LearningState }
    if (msg.type === 'learning.state' && msg.state !== undefined) onState(msg.state)
    if (msg.type === 'learning.result' && msg.id !== undefined) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok === true) entry?.resolve(msg.result)
      else entry?.reject(new Error(msg.error?.message ?? 'failed'))
    }
  })
  port.onDisconnect.addListener(() => {
    for (const entry of pending.values()) entry.reject(new Error('disconnected'))
    pending.clear()
  })
  const request = <T>(type: string, body: Record<string, unknown> = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID()
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    try {
      port.postMessage({ type, id, ...(sessionId === undefined ? {} : { sessionId }), ...body })
    } catch (error: unknown) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  void request('learning.subscribe').catch(() => {})
  return { request, dispose: () => { try { port.disconnect() } catch { /* closed */ } } }
}
