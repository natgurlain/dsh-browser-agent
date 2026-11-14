// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { approvalPromptForCall, isConditionalPageWait } from '../src/background/authorization.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ToolCall } from '../src/background/tools.ts'
import { approvalBinding } from '../src/security/payload-binding.ts'

const FRAMES: TabFrame[] = [
  { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/page' },
  { frameId: 4, parentFrameId: 0, documentId: 'child', url: 'https://login.example.net/form' },
]

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call', name, args }
}

describe('content tool approvals', () => {
  it('asks before selecting, shows the full payload, and binds it', () => {
    const args = { index: 3, values: ['a', 'b'] }
    const prompt = approvalPromptForCall(call('browser_select', args), 'auto', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'action', action: 'browser_select', origins: ['https://app.example'], canTrust: true })
    expect(prompt?.summary).toContain('Select option(s) in element [3]')
    expect(prompt?.details).toEqual([{ kind: 'payload', value: JSON.stringify(args, null, 2) }])
    expect(prompt?.binding).toBe(approvalBinding({
      action: 'browser_select', args, origins: ['https://app.example'], frameId: 0, documentKey: 'top',
    }))
    // A different value is a different approval.
    const other = approvalPromptForCall(call('browser_select', { index: 3, values: ['c'] }), 'auto', FRAMES, 'en')
    expect(other?.binding).not.toBe(prompt?.binding)
  })

  it('treats single-page extraction as a page read under the sharing setting', () => {
    const args = { table: '#t', saveTo: 'out/rows.csv', frame: 4 }
    expect(approvalPromptForCall(call('browser_extract', args), 'auto', FRAMES, 'en')).toBeUndefined()
    const prompt = approvalPromptForCall(call('browser_extract', args), 'ask', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'read', origins: ['https://login.example.net'], canTrust: false })
    expect(prompt?.details).toEqual([{ kind: 'payload', value: JSON.stringify(args, null, 2) }])
  })

  it('asks before paginated extraction, which clicks a next-page control', () => {
    const args = { table: '#t', paginate: { nextSelector: '.next', maxPages: 3 } }
    const prompt = approvalPromptForCall(call('browser_extract', args), 'auto', FRAMES, 'en')
    expect(prompt).toMatchObject({ kind: 'action', origins: ['https://app.example'] })
    expect(prompt?.summary).toContain('up to 3 pages')
    expect(prompt?.details?.[0]).toMatchObject({ kind: 'payload' })
  })

  it('treats conditional waits as reads and leaves the plain settle alone', () => {
    expect(isConditionalPageWait({ ms: 100 })).toBe(false)
    expect(isConditionalPageWait({ text: 'Saved' })).toBe(true)
    expect(isConditionalPageWait({ urlMatches: '/done' })).toBe(true)
    expect(approvalPromptForCall(call('browser_wait', { ms: 100 }), 'ask', FRAMES, 'en')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_wait', { selector: '.toast' }), 'ask', FRAMES, 'en')).toMatchObject({
      kind: 'read',
      details: [{ kind: 'payload' }],
    })
    expect(approvalPromptForCall(call('browser_wait', { selector: '.toast' }), 'auto', FRAMES, 'en')).toBeUndefined()
  })

  it('keeps scrolling unprompted, including element and infinite scrolling', () => {
    expect(approvalPromptForCall(call('browser_scroll', { selector: '#list', direction: 'down', untilItems: 50 }), 'ask', FRAMES, 'en')).toBeUndefined()
  })
})
