// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCoordinator } from '../src/background/approval-coordinator.ts'
import { approvalNotificationClass, hostApprovalReason } from '../src/background/approval-notifications.ts'
import type { ApprovalPrompt, ApprovalRequest } from '../src/security/approval.ts'

const BINDING = 'b'.repeat(64)
const FORCED: ApprovalPrompt = {
  kind: 'action',
  action: 'browser_clipboard',
  summary: 'Write text to the system clipboard',
  origins: [],
  canTrust: false,
  forced: true,
  binding: BINDING,
}

describe('policy-forced cards outside the side panel', () => {
  it('are never allowed by a Host-forwarded answer, though a deny still settles them', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-12345678f001')
    const coordinator = new ApprovalCoordinator({
      deliver: () => false,
      notify: () => {},
      clearNotification: () => {},
      resolved: () => {},
    })
    const pending = coordinator.request(FORCED, new AbortController().signal, 1)
    const id = '12345678-1234-4234-8234-12345678f001'
    expect(coordinator.respondRemote(id, BINDING, 'allow-once')).toBe(false)
    expect(coordinator.respondFromNotification(id, 'allow-once')).toBe(false)
    expect(coordinator.size).toBe(1)
    expect(coordinator.respondRemote(id, BINDING, 'deny')).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'decision', decision: 'deny' })
    vi.restoreAllMocks()
  })

  it('are not forwarded to the Host and need a full review from a notification', () => {
    const request: ApprovalRequest = { ...FORCED, id: 'x' }
    expect(hostApprovalReason(request)).toBeUndefined()
    expect(approvalNotificationClass(request)).toBe('review')
    expect(hostApprovalReason({ ...request, forced: undefined })).toContain('Tool: browser_clipboard')
  })
})
