// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../src/security/approval.ts'
import {
  allowDecision,
  approvalReadyForSession,
  approvalSessionToFocus,
  offersDevToolsTrust,
  offersEvalTrust,
  revealInvisible,
} from '../src/panel/approvals.ts'

const request: ApprovalRequest = {
  id: 'approval-1',
  kind: 'action',
  action: 'browser_click',
  summary: 'Click element [3]',
  origins: ['https://example.com'],
  canTrust: true,
  sessionId: 'session-a',
}

describe('approval session presentation', () => {
  it('queues an approval until its owning session is ready', () => {
    expect(approvalReadyForSession(request, 'session-b', false)).toBe(false)
    expect(approvalSessionToFocus(request, 'session-b', false, true)).toBe('session-a')
    expect(approvalReadyForSession(request, 'session-a', true)).toBe(false)
    expect(approvalReadyForSession(request, 'session-a', false)).toBe(true)
  })

  it('makes invisible and bidi-control characters visible in approved payloads', () => {
    expect(revealInvisible('plain text\nnext line\ttab')).toBe('plain text\nnext line\ttab')
    expect(revealInvisible('safe‮txt.exe')).toBe('safe⟦U+202E⟧txt.exe')
    expect(revealInvisible('a​b⁦c﻿')).toBe('a⟦U+200B⟧b⟦U+2066⟧c⟦U+FEFF⟧')
    expect(revealInvisible('bell\u0007')).toBe('bell⟦U+0007⟧')
  })

  it('sends the eval-trust decision only when the box is ticked on an eval card', () => {
    const evalCard: ApprovalRequest = { ...request, action: 'browser_console_eval', devTools: true, grantOrigin: 'https://example.com', canTrust: false }
    expect(allowDecision(evalCard, false)).toBe('allow-once')
    expect(allowDecision(evalCard, true)).toBe('trust-eval-session')
    expect(allowDecision(request, true)).toBe('allow-once')
    expect(allowDecision({ ...evalCard, perCallOnly: true }, true)).toBe('allow-once')
    expect(offersEvalTrust(evalCard)).toBe(true)
    expect(offersEvalTrust({ ...evalCard, grantOrigin: undefined })).toBe(false)
    expect(offersDevToolsTrust(evalCard)).toBe(false)
    expect(offersDevToolsTrust({ ...evalCard, action: 'browser_console_logs' })).toBe(true)
    expect(offersDevToolsTrust({ ...evalCard, action: 'browser_devtools_get_request', perCallOnly: true })).toBe(false)
  })

  it('never switches the panel to an MCP client\'s session or a dev-loop coding session', () => {
    expect(approvalSessionToFocus({ ...request, sessionId: 'mcp-1', requester: 'Cursor' }, 'session-b', false, true)).toBeUndefined()
    expect(approvalSessionToFocus({ ...request, sessionId: 'mcp-2' }, 'session-b', false, true)).toBeUndefined()
    expect(approvalSessionToFocus({ ...request, sessionId: 'coding', devLoopFor: 'webapp — Fix login' }, 'session-b', false, true)).toBeUndefined()
  })

  it('keeps compatibility with approvals from an older bridge', () => {
    const unscoped = { ...request, sessionId: undefined }
    expect(approvalSessionToFocus(unscoped, 'session-b', false, true)).toBeUndefined()
    expect(approvalReadyForSession(unscoped, 'session-b', false)).toBe(true)
  })
})
