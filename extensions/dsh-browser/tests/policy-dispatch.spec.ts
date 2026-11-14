// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type CallPolicyHook, type ToolCall } from '../src/background/tools.ts'
import { callPolicyTargets, forcedApprovalPrompt, resolveApprovalGate } from '../src/background/authorization.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import { evaluateCallPolicy } from '../src/security/call-policy.ts'
import type { TaintRecord } from '../src/security/taint.ts'

const TAB = { id: 7, windowId: 1, url: 'https://mail.example/inbox', title: 'Inbox' }
const FRAMES: TabFrame[] = [
  { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://mail.example/inbox' },
  { frameId: 3, parentFrameId: 0, documentId: 'ad', url: 'https://ads.example/frame' },
]

function mockChrome() {
  const sendMessage = vi.fn(async (_tabId: number, message: unknown) => {
    const type = (message as { type?: string }).type
    if (type === 'DSH_PROBE_TYPE_TARGET') return { sensitive: false }
    return { ok: true, result: { text: 'done' } }
  })
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn(async () => [TAB]), get: vi.fn(async () => TAB), sendMessage },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]) },
    webNavigation: { getAllFrames: vi.fn(async () => FRAMES.map((frame) => ({ ...frame, tabId: TAB.id }))) },
    runtime: { onMessage: { addListener: () => {}, removeListener: () => {} } },
  } as unknown as typeof chrome)
  return { sendMessage }
}

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, args })
const actionSent = (sendMessage: ReturnType<typeof mockChrome>['sendMessage']) =>
  sendMessage.mock.calls.some(([, message]) => ['DSH_ACTION', 'DSH_SNAPSHOT'].includes((message as { type?: string }).type ?? '') || (message as { action?: unknown }).action !== undefined)

afterEach(() => { vi.unstubAllGlobals() })

describe('policy layer in dispatchToolCall', () => {
  it('refuses a call the policy denies, even under unrestricted access, without prompting', async () => {
    const { sendMessage } = mockChrome()
    const authorize = vi.fn(async () => 'approved' as const)
    const policy: CallPolicyHook = () => ({ kind: 'deny', message: 'mail.example is read-only by built-in default' })
    const answer = await dispatchToolCall(call('browser_click', { selector: '#send' }), 'auto', undefined, authorize, undefined, TAB, undefined, { unrestrictedAccess: true, policy })
    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('read-only') } })
    expect(authorize).not.toHaveBeenCalled()
    expect(actionSent(sendMessage)).toBe(false)
  })

  it('forces a fresh prompt under unrestricted access and runs only once approved', async () => {
    const { sendMessage } = mockChrome()
    const prompts: ApprovalPrompt[] = []
    const policy: CallPolicyHook = () => ({ kind: 'force', reasons: ['tainted session typing cross-origin'] })
    const denied = await dispatchToolCall(call('browser_type', { selector: '#to', text: 'hunter2' }), 'auto', undefined,
      async (prompt) => { prompts.push(prompt); return 'denied' }, undefined, TAB, undefined, { unrestrictedAccess: true, policy })
    expect(denied.ok).toBe(false)
    expect(prompts[0]).toMatchObject({ forced: true, perCallOnly: true, canTrust: false, action: 'browser_type' })
    expect(prompts[0]!.details?.[0]).toMatchObject({ kind: 'text', value: 'tainted session typing cross-origin' })
    expect(actionSent(sendMessage)).toBe(false)
    const approved = await dispatchToolCall(call('browser_type', { selector: '#to', text: 'hunter2' }), 'auto', undefined,
      async () => 'approved', undefined, TAB, undefined, { unrestrictedAccess: true, policy })
    expect(approved.ok).toBe(true)
  })

  it('skips the prompt for a site the user trusts', async () => {
    mockChrome()
    const authorize = vi.fn(async () => 'denied' as const)
    const policy: CallPolicyHook = () => ({ kind: 'trust' })
    const answer = await dispatchToolCall(call('browser_click', { selector: '#send' }), 'ask', undefined, authorize, undefined, TAB, undefined, { unrestrictedAccess: false, policy })
    expect(answer.ok).toBe(true)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('end to end: a tainted session typing into another origin asks even when unrestricted', async () => {
    mockChrome()
    const taint: TaintRecord = { sources: ['https://news.example'], firstTool: 'browser_snapshot', since: 0 }
    const policy: CallPolicyHook = (c, targets) => evaluateCallPolicy({
      name: c.name, args: c.args, targets, taint,
      site: { managed: [], user: [], defaultsEnabled: true, defaultTrusted: true },
    })
    const authorize = vi.fn(async () => 'denied' as const)
    await dispatchToolCall(call('browser_type', { selector: '#to', text: 'secret' }), 'auto', undefined, authorize, undefined, TAB, undefined, { unrestrictedAccess: true, policy })
    expect(authorize).toHaveBeenCalledOnce()
    authorize.mockClear()
    // Reading is not affected by taint.
    await dispatchToolCall(call('browser_get_text', {}), 'auto', undefined, authorize, undefined, TAB, undefined, { unrestrictedAccess: true, policy })
    expect(authorize).not.toHaveBeenCalled()
  })
})

describe('policy targets and forced prompts', () => {
  it('classifies reads, actions, and navigation', () => {
    expect(callPolicyTargets(call('browser_snapshot'), FRAMES)).toEqual({ reads: ['https://ads.example', 'https://mail.example'], acts: [] })
    expect(callPolicyTargets(call('browser_get_text', { frame: 3 }), FRAMES)).toEqual({ reads: ['https://ads.example'], acts: [] })
    expect(callPolicyTargets(call('browser_click', { index: 1 }), FRAMES)).toEqual({ reads: [], acts: ['https://mail.example'] })
    expect(callPolicyTargets(call('browser_type', { index: 1, text: 'x' }), FRAMES)).toMatchObject({ typeTargetOrigin: 'https://mail.example' })
    expect(callPolicyTargets(call('browser_navigate', { url: 'https://x.example/' }), FRAMES)).toEqual({ reads: [], acts: [], destination: 'https://x.example/' })
    expect(callPolicyTargets(call('browser_clipboard', { action: 'write', text: 'x' }), FRAMES)).toEqual({ reads: [], acts: [] })
    expect(callPolicyTargets(call('browser_extract', { paginate: { nextSelector: '.n' } }), FRAMES).acts).toEqual(['https://mail.example'])
    expect(callPolicyTargets(call('browser_console_eval', { expression: '1' }), FRAMES).acts).toEqual(['https://mail.example'])
    expect(callPolicyTargets(call('browser_console_logs'), FRAMES).reads).toEqual(['https://mail.example'])
  })

  it('builds a forced card for reads and file writes that would not otherwise ask', () => {
    const prompt = forcedApprovalPrompt(call('browser_save_pdf'), FRAMES, ['why'], 'en')
    expect(prompt).toMatchObject({ forced: true, kind: 'read', canTrust: false })
    expect(typeof prompt.binding).toBe('string')
    const clip = forcedApprovalPrompt(call('browser_clipboard', { action: 'write', text: 'leak' }), FRAMES, ['why'], 'en')
    expect(clip).toMatchObject({ forced: true, action: 'browser_clipboard' })
    // Deterministic: recomputing gives the same binding.
    expect(forcedApprovalPrompt(call('browser_save_pdf'), FRAMES, ['why'], 'en').binding).toBe(prompt.binding)
  })

  it('never lets unrestricted access, trusted origins, or grants skip a forced prompt', () => {
    const prompt = forcedApprovalPrompt(call('browser_click', { index: 1 }), FRAMES, ['ask site'], 'en')
    expect(resolveApprovalGate({ prompt, devToolsAllowed: true, devToolsSessionGrant: true, unrestrictedAccess: true, coveredByTrustedOrigins: true })).toBe('prompt')
    const devtools = forcedApprovalPrompt(call('browser_console_logs'), FRAMES, ['ask site'], 'en')
    expect(devtools.devTools).toBe(true)
    expect(resolveApprovalGate({ prompt: devtools, devToolsAllowed: true, devToolsSessionGrant: true, unrestrictedAccess: true, coveredByTrustedOrigins: true })).toBe('prompt')
  })
})
