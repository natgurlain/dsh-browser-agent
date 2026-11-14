import { describe, expect, it, vi } from 'vitest'
import { createHostApprovalRequester } from '../src/host-approval.ts'

const request = (signal = new AbortController().signal) => ({ sessionId: 's1', toolName: 'browser_type', reason: 'why', signal })

describe('createHostApprovalRequester', () => {
  it('asks the approval service on behalf of the live agent', async () => {
    const agent = { id: 's1' }
    const service = { request: vi.fn(async () => 'allowed-once') }
    const ask = createHostApprovalRequester(() => service, () => ({ get: (id: never) => (id === 's1' ? agent : undefined) }))
    const req = request()
    await expect(ask(req)).resolves.toBe('allowed-once')
    expect(service.request).toHaveBeenCalledWith({ agent, toolName: 'browser_type', reason: 'why', signal: req.signal })
  })

  it('fails closed without a service, without an agent, on rogue outcomes, and on throws', async () => {
    const agents = () => ({ get: () => ({}) })
    await expect(createHostApprovalRequester(() => undefined, agents)(request())).resolves.toBe('unavailable')
    await expect(createHostApprovalRequester(() => ({ request: async () => 'allowed-once' }), () => undefined)(request()))
      .resolves.toBe('unavailable')
    await expect(createHostApprovalRequester(() => ({ request: async () => 'allowed-once' }), () => ({ get: () => undefined }))(request()))
      .resolves.toBe('unavailable')
    await expect(createHostApprovalRequester(() => ({ request: async () => 'yes' }), agents)(request())).resolves.toBe('unavailable')
    await expect(createHostApprovalRequester(() => ({ request: async () => { throw new Error('no turn') } }), agents)(request()))
      .resolves.toBe('unavailable')
    await expect(createHostApprovalRequester(() => ({ request: async () => 'rejected' }), agents)(request())).resolves.toBe('rejected')
  })

  it('does not ask once the browser has already withdrawn the question', async () => {
    const service = { request: vi.fn(async () => 'allowed-once') }
    const controller = new AbortController()
    controller.abort()
    await expect(createHostApprovalRequester(() => service, () => ({ get: () => ({}) }))(request(controller.signal)))
      .resolves.toBe('cancelled')
    expect(service.request).not.toHaveBeenCalled()
  })
})
