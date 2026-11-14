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

  it('passes the model tool call id so a UI can attach the question to it', async () => {
    const service = { request: vi.fn(async () => 'rejected') }
    const ask = createHostApprovalRequester(() => service, () => ({ get: () => ({ session: {} }) }))
    await ask({ ...request(), callId: 'call-7' })
    expect(service.request).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-7' }))
  })

  it('leaves the decision to the browser when dsh would reject without asking (never policy)', async () => {
    const session = { id: 's1' }
    const request1 = vi.fn(async () => 'rejected')
    const overridden = { request: request1, overrideOf: (s: unknown) => (s === session ? 'never' : undefined), config: { policy: 'ask' } }
    await expect(createHostApprovalRequester(() => overridden, () => ({ get: () => ({ session }) }))(request())).resolves.toBe('unavailable')
    expect(request1).not.toHaveBeenCalled()
    const request2 = vi.fn(async () => 'rejected')
    const defaulted = { request: request2, overrideOf: () => undefined, config: { policy: 'never' } }
    await expect(createHostApprovalRequester(() => defaulted, () => ({ get: () => ({ session }) }))(request())).resolves.toBe('unavailable')
    expect(request2).not.toHaveBeenCalled()
    const asking = { request: vi.fn(async () => 'rejected'), overrideOf: () => 'ask', config: { policy: 'never' } }
    await expect(createHostApprovalRequester(() => asking, () => ({ get: () => ({ session }) }))(request())).resolves.toBe('rejected')
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
