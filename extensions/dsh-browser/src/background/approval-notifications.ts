/**
 * Panel-independent approval surfaces: which approvals an OS notification may
 * decide, the notification itself, and the question forwarded to dsh's own
 * approval service when no side panel is open.
 *
 * Only a "quick" approval can be allowed from a notification: one whose whole
 * payload fits in its summary (no code, typed text, file paths, redaction
 * opt-outs, raw arguments, risky URL, browser permission, or developer-tools
 * consent). Everything else gets a "Review" button that opens the full card.
 * The class is recomputed whenever a button is clicked; the button index
 * alone never grants anything.
 *
 * @module
 */

import type { ApprovalDetail, ApprovalRequest } from '../security/approval.ts'

/** Whether a notification may allow an approval (`quick`) or must open the card (`review`). */
export type ApprovalNotificationClass = 'quick' | 'review'

/** Longest summary a notification shows whole; a longer one is never allowable there. */
export const MAX_NOTIFICATION_SUMMARY = 160
/** Longest origin list a notification shows whole. */
const MAX_NOTIFICATION_ORIGINS = 120
/** Longest (page-authored) tab title quoted in a notification. */
const MAX_NOTIFICATION_TITLE = 60

/** Classify one approval for the notification surface. */
export function approvalNotificationClass(request: ApprovalRequest): ApprovalNotificationClass {
  if (request.devTools === true || request.perCallOnly === true || request.forced === true || request.urlRisk === true
    || request.permission !== undefined || request.browserOnly === true) return 'review'
  // Allow is offered only when the notification can show the whole summary
  // and which site it acts on: never on a truncated or site-less description.
  if (request.summary.length > MAX_NOTIFICATION_SUMMARY || request.origins.length === 0
    || request.origins.join(', ').length > MAX_NOTIFICATION_ORIGINS) return 'review'
  for (const detail of request.details ?? []) {
    // A plain, non-risky destination is fully described by the summary.
    if (detail.kind === 'url' && !detail.url.risky && detail.url.userinfo !== true) continue
    return 'review'
  }
  return 'quick'
}

/** Notification buttons, in Chrome's button order. */
export type ApprovalNotificationButton = 'allow-once' | 'deny' | 'review'

/**
 * Buttons for one approval. Chrome shows at most two; Firefox shows none (a
 * click on the body opens the panel there).
 */
export function approvalNotificationButtons(
  request: ApprovalRequest,
  target: 'chrome' | 'firefox',
): ApprovalNotificationButton[] {
  if (target === 'firefox') return []
  return approvalNotificationClass(request) === 'quick' ? ['allow-once', 'deny'] : ['review', 'deny']
}

/** Copy for one approval notification. */
export interface ApprovalNotificationCopy {
  title: string
  /** Body; `{minutes}` is replaced with the time left to decide. */
  quickMessage: string
  reviewMessage: string
  buttons: Record<ApprovalNotificationButton, string>
}

export const APPROVAL_NOTIFICATION_COPY: Record<'en' | 'zh', ApprovalNotificationCopy> = {
  en: {
    title: 'Browser action awaiting approval',
    quickMessage: '{summary}\nOn {site}\nAllow it here, or open the assistant to review. Expires in {minutes} min.',
    reviewMessage: '{summary}\nOn {site}\nThis action needs a full review: open the assistant to see it. Expires in {minutes} min.',
    buttons: { 'allow-once': 'Allow once', deny: 'Deny', review: 'Review' },
  },
  zh: {
    title: '浏览器操作等待确认',
    quickMessage: '{summary}\n网站：{site}\n可在此允许，或打开助手查看详情。{minutes} 分钟内有效。',
    reviewMessage: '{summary}\n网站：{site}\n该操作需要完整审阅：请打开助手查看。{minutes} 分钟内有效。',
    buttons: { 'allow-once': '允许一次', deny: '拒绝', review: '审阅' },
  },
}

/** Build `chrome.notifications.create` options for one approval. */
export function approvalNotificationOptions(
  request: ApprovalRequest,
  options: { target: 'chrome' | 'firefox'; iconUrl: string; copy: ApprovalNotificationCopy; minutes: number; tabTitle?: string },
): chrome.notifications.NotificationOptions<true> {
  const buttons = approvalNotificationButtons(request, options.target)
  const quick = approvalNotificationClass(request) === 'quick'
  const template = quick ? options.copy.quickMessage : options.copy.reviewMessage
  // Only a review notification may shorten (it decides nothing).
  const base = request.requester !== undefined ? `[MCP: ${request.requester}] ${request.summary}`
    : request.devLoopFor !== undefined ? `[Dev loop] ${request.summary}`
    : request.summary
  const summary = quick || base.length <= MAX_NOTIFICATION_SUMMARY
    ? base
    : `${base.slice(0, MAX_NOTIFICATION_SUMMARY - 3)}…`
  const origins = request.origins.length === 0 ? '?' : request.origins.join(', ')
  const title = (options.tabTitle ?? '').replace(/\s+/g, ' ').trim()
  const site = title === ''
    ? origins
    : `${origins} (tab "${title.length > MAX_NOTIFICATION_TITLE ? `${title.slice(0, MAX_NOTIFICATION_TITLE - 1)}…` : title}")`
  return {
    type: 'basic',
    iconUrl: options.iconUrl,
    title: options.copy.title,
    message: template.replace('{summary}', () => summary).replace('{site}', () => site).replace('{minutes}', String(Math.max(1, Math.round(options.minutes)))),
    // Firefox rejects `requireInteraction` and `buttons`.
    ...(options.target === 'chrome'
      ? { requireInteraction: true, buttons: buttons.map((button) => ({ title: options.copy.buttons[button] })) }
      : {}),
  }
}

/** Largest question forwarded to dsh (mirror of the bridge's limit). */
export const MAX_HOST_APPROVAL_REASON = 32 * 1024

function renderDetail(detail: ApprovalDetail): string | undefined {
  switch (detail.kind) {
    case 'code': return `JavaScript to run:\n${detail.value}`
    case 'text':
      // Masked text is sensitive (password fields, uninspected inputs): it is
      // never sent off the browser, so such approvals stay in the panel.
      if (detail.masked) return undefined
      return `${detail.label ?? 'Text to type'}:\n${detail.value}`
    case 'paths': return `Local files handed to the page:\n${detail.values.join('\n')}`
    case 'url': return `Destination URL${detail.url.risky ? ' (flagged: may carry smuggled data)' : ''}:\n${detail.url.href}`
    case 'flags': return `Redaction opt-outs requested: ${detail.values.join(', ')}`
    case 'payload': return `Arguments:\n${detail.value}`
    // A program series is read row by row in the panel only.
    case 'rows': return undefined
  }
}

/**
 * The question put to dsh's approval service for one browser approval, with
 * the full payload verbatim (never truncated). `undefined` means the approval
 * may only be answered in the browser: it needs a browser permission prompt
 * (a user gesture), carries masked text, or is too large to show whole.
 */
export function hostApprovalReason(request: ApprovalRequest): string | undefined {
  if (request.permission !== undefined) return undefined
  // Site policy / taint / strict-mode cards are decided in the browser only:
  // the Host-side answerer sits in the agent's own harness, which is exactly
  // what a tainted session must not be able to approve through.
  if (request.forced === true) return undefined
  // A program series ("do the remaining N") is the user's own request from the
  // panel, and only the panel can show its rows.
  if (request.browserOnly === true) return undefined
  const sections: string[] = [
    `Browser ${request.kind === 'read' ? 'page read' : 'action'} awaiting approval (dsh browser assistant; the side panel is closed).`,
    `Tool: ${request.action}`,
    `Summary: ${request.summary}`,
  ]
  if (request.origins.length > 0) sections.push(`Origins: ${request.origins.join(', ')}`)
  if (request.devTools === true) sections.push('This is a developer-tools operation (high privilege).')
  for (const detail of request.details ?? []) {
    const rendered = renderDetail(detail)
    if (rendered === undefined) return undefined
    sections.push(rendered)
  }
  if (request.binding !== undefined) sections.push(`Payload binding: ${request.binding}`)
  sections.push('Allowing approves exactly this call, once.')
  const reason = sections.join('\n\n')
  return reason.length > MAX_HOST_APPROVAL_REASON ? undefined : reason
}
