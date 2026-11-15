import { describe, expect, it, vi } from 'vitest'
import { startActivationCompat } from '../src/subagent-compat.ts'

const signal = new AbortController().signal
const parent = { id: 'session-parent' }
const flat = {
  provider: 'spawn', label: 'fleet 1', childId: 'child-1', signal, delivery: 'caller' as const,
  parent, prompt: [{ type: 'text' as const, text: 'read the page' }], outputSchema: { type: 'object' },
}

/** DSH 0.2.2-rc.2 and later: the task fields sit on the spec itself. */
function flatHost() {
  return {
    startActivation: vi.fn(async (spec: Record<string, unknown>) => {
      const owner = spec.parent as { id: string }
      return { childId: spec.childId, parentId: owner.id }
    }),
  }
}

/** DSH 0.2.2-rc.1: the task fields sit under `request`; a flat spec dies reading `request.maxDepth`. */
function nestedHost() {
  return {
    startActivation: vi.fn(async (spec: Record<string, unknown>) => {
      const request = spec.request as { maxDepth?: number; parent: { id: string } }
      void request.maxDepth
      return { childId: spec.childId, parentId: request.parent.id }
    }),
  }
}

describe('startActivationCompat', () => {
  it('passes the flat spec through unchanged on a current host', async () => {
    const host = flatHost()
    await expect(startActivationCompat(host, flat)).resolves.toEqual({ childId: 'child-1', parentId: 'session-parent' })
    expect(host.startActivation).toHaveBeenCalledTimes(1)
    expect(host.startActivation).toHaveBeenCalledWith(flat)
  })

  it('retries with the task fields under `request` on a 0.2.2-rc.1 host', async () => {
    const host = nestedHost()
    await expect(startActivationCompat(host, flat)).resolves.toEqual({ childId: 'child-1', parentId: 'session-parent' })
    expect(host.startActivation).toHaveBeenCalledTimes(2)
    expect(host.startActivation.mock.calls[1]![0]).toEqual({
      provider: 'spawn', label: 'fleet 1', childId: 'child-1', signal, delivery: 'caller',
      request: { parent, prompt: flat.prompt, outputSchema: flat.outputSchema },
    })
  })

  it('omits childId from the nested spec when the caller reserved none', async () => {
    const host = nestedHost()
    const { childId: _childId, ...withoutChild } = flat
    await startActivationCompat(host, { ...withoutChild, agentPreset: 'browser' })
    expect(host.startActivation.mock.calls[1]![0]).toEqual({
      provider: 'spawn', label: 'fleet 1', signal, delivery: 'caller',
      request: { parent, prompt: flat.prompt, outputSchema: flat.outputSchema, agentPreset: 'browser' },
    })
  })

  it('does not retry an error that is not a TypeError', async () => {
    const refusal = new Error('subagent creation requires the exact live parent agent')
    const host = { startActivation: vi.fn(async () => { throw refusal }) }
    await expect(startActivationCompat(host, flat)).rejects.toBe(refusal)
    expect(host.startActivation).toHaveBeenCalledTimes(1)
  })

  it('reports the nested host\'s own refusal after the retry', async () => {
    const refusal = new Error('reserved child ids require a local backend')
    const host = {
      startActivation: vi.fn(async (spec: Record<string, unknown>) => {
        void (spec.request as { maxDepth?: number }).maxDepth
        throw refusal
      }),
    }
    await expect(startActivationCompat(host, flat)).rejects.toBe(refusal)
  })

  it('keeps a current host\'s own TypeError instead of the retry\'s', async () => {
    const original = new TypeError('provider.prepare is not a function')
    const host = {
      startActivation: vi.fn(async (spec: Record<string, unknown>) => {
        if (spec.request === undefined) throw original
        throw new TypeError('Cannot read properties of undefined (reading \'id\')')
      }),
    }
    await expect(startActivationCompat(host, flat)).rejects.toBe(original)
    expect(host.startActivation).toHaveBeenCalledTimes(2)
  })
})
