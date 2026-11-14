// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  APPROVAL_NOTIFICATION_COPY,
  MAX_HOST_APPROVAL_REASON,
  approvalNotificationButtons,
  approvalNotificationClass,
  approvalNotificationOptions,
  hostApprovalReason,
} from '../src/background/approval-notifications.ts'
import type { ApprovalRequest } from '../src/security/approval.ts'

const BASE: ApprovalRequest = {
  id: 'a1',
  kind: 'action',
  action: 'browser_click',
  summary: 'Click "Submit" on example.com',
  origins: ['https://example.com'],
  canTrust: true,
  binding: 'f'.repeat(64),
}

const url = (risky: boolean) => ({
  kind: 'url' as const,
  url: { href: 'https://example.com/a?b=1', origin: 'https://example.com', path: '/a', params: [], fragment: '', risky },
})

describe('approvalNotificationClass', () => {
  it('lets a notification decide only approvals whose summary is the whole payload', () => {
    expect(approvalNotificationClass(BASE)).toBe('quick')
    expect(approvalNotificationClass({ ...BASE, kind: 'read' })).toBe('quick')
    expect(approvalNotificationClass({ ...BASE, details: [url(false)] })).toBe('quick')
  })

  it.each([
    ['eval code', { details: [{ kind: 'code' as const, value: 'alert(1)' }] }],
    ['typing', { details: [{ kind: 'text' as const, value: 'hi', masked: false }] }],
    ['masked typing', { details: [{ kind: 'text' as const, value: 'pw', masked: true }] }],
    ['uploads', { details: [{ kind: 'paths' as const, values: ['/etc/passwd'] }] }],
    ['sensitive flags', { details: [{ kind: 'flags' as const, values: ['includeHidden'] }] }],
    ['raw arguments', { details: [{ kind: 'payload' as const, value: '{}' }] }],
    ['a risky url', { details: [url(true)] }],
    ['credentials in a url', { details: [{ kind: 'url' as const, url: { ...url(false).url, userinfo: true as const } }] }],
    ['developer tools', { devTools: true as const }],
    ['per-call-only approvals', { perCallOnly: true as const }],
    ['url risk', { urlRisk: true as const }],
    ['browser permissions', { permission: 'downloads' as const }],
  ])('requires the full card for %s', (_name, extra) => {
    expect(approvalNotificationClass({ ...BASE, ...extra } as ApprovalRequest)).toBe('review')
  })
})

describe('approval notification options', () => {
  it('offers Allow once / Deny for quick approvals and Review / Deny otherwise on Chrome', () => {
    expect(approvalNotificationButtons(BASE, 'chrome')).toEqual(['allow-once', 'deny'])
    expect(approvalNotificationButtons({ ...BASE, devTools: true }, 'chrome')).toEqual(['review', 'deny'])
    const options = approvalNotificationOptions({ ...BASE, devTools: true }, {
      target: 'chrome', iconUrl: 'icon.png', copy: APPROVAL_NOTIFICATION_COPY.en, minutes: 10,
    })
    expect(options.buttons).toEqual([{ title: 'Review' }, { title: 'Deny' }])
    expect(options.requireInteraction).toBe(true)
    expect(options.message).toContain('Expires in 10 min')
    expect(options.message).toContain('full review')
  })

  it('passes no buttons on Firefox, which does not support them', () => {
    expect(approvalNotificationButtons(BASE, 'firefox')).toEqual([])
    const options = approvalNotificationOptions(BASE, {
      target: 'firefox', iconUrl: 'icon.png', copy: APPROVAL_NOTIFICATION_COPY.zh, minutes: 0.2,
    })
    expect(options).not.toHaveProperty('buttons')
    expect(options).not.toHaveProperty('requireInteraction')
    expect(options.message).toContain('1 分钟')
  })

  it('shortens only an overlong summary in the notification body', () => {
    const options = approvalNotificationOptions({ ...BASE, summary: 'x'.repeat(400) }, {
      target: 'chrome', iconUrl: 'i', copy: APPROVAL_NOTIFICATION_COPY.en, minutes: 5,
    })
    expect(options.message.split('\n')[0]).toHaveLength(158)
  })
})

describe('hostApprovalReason', () => {
  it('carries the full payload verbatim with its binding', () => {
    const code = 'document.title = "x"\n'.repeat(50)
    const reason = hostApprovalReason({
      ...BASE,
      action: 'browser_console_eval',
      devTools: true,
      details: [
        { kind: 'code', value: code },
        { kind: 'text', value: 'typed', masked: false, label: 'Prompt answer' },
        { kind: 'paths', values: ['/a', '/b'] },
        url(true),
        { kind: 'flags', values: ['f'] },
        { kind: 'payload', value: '{"a":1}' },
      ],
    })!
    expect(reason).toContain(code)
    expect(reason).toContain('Prompt answer:\ntyped')
    expect(reason).toContain('/a\n/b')
    expect(reason).toContain('flagged')
    expect(reason).toContain('developer-tools')
    expect(reason).toContain(`Payload binding: ${'f'.repeat(64)}`)
    const { binding: _binding, ...unbound } = BASE
    expect(hostApprovalReason({ ...unbound, kind: 'read', origins: [] })).toContain('page read')
  })

  it('keeps masked text, browser permissions, and oversized payloads in the browser', () => {
    expect(hostApprovalReason({ ...BASE, details: [{ kind: 'text', value: 'pw', masked: true }] })).toBeUndefined()
    expect(hostApprovalReason({ ...BASE, permission: 'downloads' })).toBeUndefined()
    expect(hostApprovalReason({ ...BASE, details: [{ kind: 'code', value: 'x'.repeat(MAX_HOST_APPROVAL_REASON) }] })).toBeUndefined()
  })
})
