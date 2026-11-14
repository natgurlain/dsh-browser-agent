// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ExternalRequesters } from '../src/background/external-requesters.ts'
import { APPROVAL_NOTIFICATION_COPY, approvalNotificationOptions } from '../src/background/approval-notifications.ts'
import type { ApprovalPrompt, ApprovalRequest } from '../src/security/approval.ts'

const prompt: ApprovalPrompt = { kind: 'action', action: 'browser_click', summary: 'Click "Buy" on shop.example', origins: ['https://shop.example'], canTrust: true }

describe('external requesters', () => {
  it('labels an MCP session\'s approval cards with the client that asked', () => {
    const requesters = new ExternalRequesters()
    requesters.note({ sessionId: 'mcp-1', requester: 'Claude Code' })
    expect(requesters.label(prompt, 'mcp-1')).toEqual({ ...prompt, requester: 'Claude Code' })
  })

  it('never labels a DSH Agent session, even when a frame claims a requester', () => {
    const requesters = new ExternalRequesters()
    requesters.note({ sessionId: 'session-1', requester: 'Claude Code' })
    expect(requesters.label(prompt, 'session-1')).toBe(prompt)
    expect(requesters.label(prompt, undefined)).toBe(prompt)
  })

  it('still marks an external session whose label was never seen, and drops malformed labels', () => {
    const requesters = new ExternalRequesters()
    requesters.note({ sessionId: 'mcp-2', requester: 'bad\nlabel' })
    expect(requesters.labelOf('mcp-2')).toBe('unknown MCP client')
  })

  it('names the client in the OS notification too', () => {
    const request: ApprovalRequest = { ...prompt, id: 'a', sessionId: 'mcp-1', requester: 'Cursor' }
    const options = approvalNotificationOptions(request, { target: 'chrome', iconUrl: 'i.png', copy: APPROVAL_NOTIFICATION_COPY.en, minutes: 5 })
    expect(options.message).toMatch(/^\[MCP: Cursor\] Click "Buy"/u)
  })
})
