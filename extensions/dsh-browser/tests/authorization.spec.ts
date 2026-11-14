// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { approvalPromptForCall, originFromUrl } from '../src/background/authorization.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ToolCall } from '../src/background/tools.ts'

const FRAMES: TabFrame[] = [
  { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://app.example/page' },
  { frameId: 4, parentFrameId: 0, documentId: 'child', url: 'https://login.example.net/form' },
  { frameId: 5, parentFrameId: 4, documentId: 'about', url: 'about:blank' },
]

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call', name, args }
}

describe('approvalPromptForCall', () => {
  it('asks before reading and names every effective frame origin', () => {
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', FRAMES, 'zh')).toMatchObject({
      kind: 'read',
      origins: ['https://app.example', 'https://login.example.net'],
      canTrust: false,
    })
    expect(approvalPromptForCall(call('browser_snapshot'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('scopes a frame-local action to the frame origin and masks typed text by default', () => {
    const prompt = approvalPromptForCall(call('browser_type', {
      frame: 4,
      index: 7,
      text: 'my-password-must-not-appear',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      kind: 'action',
      origins: ['https://login.example.net'],
      canTrust: true,
    })
    expect(prompt?.summary).toContain('27 个字符')
    expect(prompt?.summary).not.toContain('my-password')
    // An uninspected target fails closed: the text is carried but masked.
    expect(prompt?.details).toEqual([{ kind: 'text', value: 'my-password-must-not-appear', masked: true }])
  })

  it('shows typed text for non-sensitive targets and names selector targets', () => {
    const prompt = approvalPromptForCall(call('browser_type', {
      selector: 'textarea[name="comment"]',
      text: 'Hello there',
    }), 'auto', FRAMES, 'en', { typedTargetSensitive: false })
    expect(prompt?.summary).toBe('Type 11 characters into selected element (textarea[name="comment"])')
    expect(prompt?.details).toEqual([{ kind: 'text', value: 'Hello there', masked: false }])
    const sensitive = approvalPromptForCall(call('browser_type', { index: 2, text: '123456' }), 'auto', FRAMES, 'en', { typedTargetSensitive: true })
    expect(sensitive?.details).toEqual([{ kind: 'text', value: '123456', masked: true }])
    expect(sensitive?.summary).toContain('masked')
    const focused = approvalPromptForCall(call('browser_type', { text: 'x' }), 'auto', FRAMES, 'en', { typedTargetSensitive: false })
    expect(focused?.summary).toBe('Type 1 characters into the focused element')
  })

  it('lists every upload path in full', () => {
    const paths = ['/home/user/Documents/tax-return-2025.pdf', 'C:\\Users\\me\\.ssh\\id_ed25519']
    const prompt = approvalPromptForCall(call('browser_upload', { selector: '#upload', paths }), 'auto', FRAMES, 'en')
    expect(prompt?.summary).toBe('Attach 2 local file(s) to selected element (#upload)')
    expect(prompt?.details).toEqual([{ kind: 'paths', values: paths }])
  })

  it('binds the prompt to the exact payload and target document', () => {
    const typed = call('browser_type', { index: 7, text: 'abc' })
    const before = approvalPromptForCall(typed, 'auto', FRAMES, 'en')!
    expect(before.binding).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalPromptForCall(typed, 'auto', FRAMES, 'en')!.binding).toBe(before.binding)
    expect(approvalPromptForCall(call('browser_type', { index: 7, text: 'abd' }), 'auto', FRAMES, 'en')!.binding).not.toBe(before.binding)
    const navigated = FRAMES.map((frame) => frame.frameId === 0 ? { ...frame, documentId: 'top-2' } : frame)
    expect(approvalPromptForCall(typed, 'auto', navigated, 'en')!.binding).not.toBe(before.binding)
  })

  it('never offers persistent trust for cross-origin navigation', () => {
    const prompt = approvalPromptForCall(call('browser_navigate', {
      url: 'https://bank.example/transfer?token=secret#confirm',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      origins: ['https://app.example', 'https://bank.example'],
      canTrust: false,
      summary: '导航到 https://bank.example/transfer?token=secret#confirm',
    })
    expect(prompt?.details?.[0]).toMatchObject({
      kind: 'url',
      url: { href: 'https://bank.example/transfer?token=secret#confirm', params: [{ name: 'token', value: 'secret' }], fragment: 'confirm' },
    })
    expect(prompt?.urlRisk).toBeUndefined()
  })

  it('shows the full destination URL with decoded and flagged query values', () => {
    const prompt = approvalPromptForCall(call('browser_open_tab', {
      url: 'https://docs.example/guide?q=caf%C3%A9&sid=9f86d081884c7d659a2feaa0c55ad015#section',
    }), 'auto', FRAMES, 'en')

    expect(prompt).toMatchObject({
      origins: ['https://docs.example'],
      canTrust: true,
      urlRisk: true,
    })
    expect(prompt?.summary).toContain('sid=9f86d081884c7d659a2feaa0c55ad015#section')
    expect(prompt?.details?.[0]).toMatchObject({
      kind: 'url',
      url: {
        params: [
          { source: 'query', name: 'q', value: 'café' },
          { source: 'query', name: 'sid', value: '9f86d081884c7d659a2feaa0c55ad015', flag: 'entropy' },
        ],
      },
    })
  })

  it('approves opening a new tab against only the destination origin', () => {
    const prompt = approvalPromptForCall(call('browser_open_tab', {
      url: 'https://docs.example/guide?token=secret#section',
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      origins: ['https://docs.example'],
      canTrust: true,
      summary: '在新标签页打开 https://docs.example/guide?token=secret#section',
    })
  })

  it('labels background tab opens in the approval summary', () => {
    const prompt = approvalPromptForCall(call('browser_open_tab', {
      url: 'https://docs.example/guide',
      active: false,
    }), 'auto', FRAMES, 'zh')

    expect(prompt).toMatchObject({
      origins: ['https://docs.example'],
      canTrust: true,
      summary: '在后台新标签页打开 https://docs.example/guide',
    })
  })

  it('does not offer trust for invalid navigation and keeps key summaries on one bounded line', () => {
    expect(approvalPromptForCall(call('browser_navigate', { url: 'javascript:alert(1)' }), 'auto', FRAMES, 'zh'))
      .toMatchObject({ canTrust: false })

    const prompt = approvalPromptForCall(call('browser_press', { key: `Enter\n${'x'.repeat(100)}` }), 'auto', FRAMES, 'zh')
    expect(prompt?.summary).not.toContain('\n')
    expect(prompt?.summary.length).toBeLessThan(70)
  })

  it('keeps read-only viewport tools outside the approval path', () => {
    expect(approvalPromptForCall(call('browser_scroll', { direction: 'down' }), 'auto', FRAMES, 'zh')).toBeUndefined()
    expect(approvalPromptForCall(call('browser_wait'), 'auto', FRAMES, 'zh')).toBeUndefined()
  })

  it('renders approval summaries in English for non-Chinese browsers', () => {
    expect(approvalPromptForCall(call('browser_type', {
      index: 3,
      text: 'secret',
    }), 'auto', FRAMES, 'en')?.summary).toBe(
      'Type 6 characters into element [3] (sensitive field or not inspected: masked)',
    )
    expect(approvalPromptForCall(call('browser_snapshot'), 'ask', FRAMES, 'en')?.summary)
      .toBe('Read the current page and accessible iframes')
  })
})

describe('originFromUrl', () => {
  it('accepts web/blob origins and rejects browser-internal or invalid URLs', () => {
    expect(originFromUrl('https://example.com/path?q=1')).toBe('https://example.com')
    expect(originFromUrl('blob:https://example.com/id')).toBe('https://example.com')
    expect(originFromUrl('chrome://settings')).toBeUndefined()
    expect(originFromUrl('not a url')).toBeUndefined()
  })
})
