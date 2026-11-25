/**
 * Auto approve's decision for one approval card (docs/auto-approve-design.md
 * §3, §4). Pure functions, so every branch is unit-tested.
 *
 * With Auto approve on for a conversation:
 * - an ordinary action runs at once: no card, no model call, no wait;
 * - a consequential action (committing or irreversible words, credentials,
 *   a step the taint rules flag after the conversation read untrusted page
 *   content, files, programs, standing watchers) goes to the silent reviewer
 *   first: its "allow" runs it, anything else shows the ordinary card;
 * - a few cards are never decided by Auto approve: the developer-tools
 *   allowance, a browser permission only a click can grant, a site the user
 *   or an administrator set to "ask", strict mode's commit gate, and MCP
 *   conversations from other apps.
 *
 * @module
 */

import {
  MAX_REVIEW_SCRIPT_CHARS,
  MAX_REVIEW_UNTRUSTED_CHARS,
  type AutoReviewVerb,
  type ConsequenceReason,
  type ReviewAction,
} from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import type { ApprovalPrompt } from './approval.ts'
import { pageTextForCard, type TargetDestination, type TargetState } from '../shared/target-description.ts'

/** Why Auto approve leaves a card to the user (stable codes; tests and the docs read them). */
export type AutoCardReason =
  | 'off'
  | 'external-session'
  | 'devtools'
  | 'permission'
  | 'site-rule'
  | 'opted-out'

/** What Auto approve does with one card. */
export type AutoPath =
  | { kind: 'run' }
  | { kind: 'review'; reasons: ConsequenceReason[] }
  | { kind: 'card'; reason: AutoCardReason }

/** What the background knows about the card's call. */
export interface AutoContext {
  /** Auto approve is on for the conversation whose panel shows the card. */
  on: boolean
  /** An external (MCP client) conversation from another app. */
  external: boolean
  /** The caller asked for the card itself (strict mode's commit gate). */
  optOut?: boolean
  /** The call's tool name. */
  tool: string
  /** The call's arguments. */
  args: Record<string, unknown>
  /**
   * Every origin the card names is one of the user's own local pages (the
   * taint exemption's confirmed loopback origins): developer tools there may
   * go through Auto approve.
   */
  localPage?: boolean
}

/**
 * Words that commit or cannot be undone, EN and ZH, matched on stems in a
 * control's name, its link or form address, a navigation address, the
 * options a selection chooses or a dialog's text. Deliberately narrow:
 * "Save", "Continue", "OK", "Apply" and "Accept" are ordinary, or every task
 * would wait on the reviewer.
 */
export const COMMIT_WORDS = new RegExp([
  String.raw`\b(?:send\w*|sent|delet\w*|remov\w*|trash\w*|discard\w*|eras\w*|purg\w*|destroy\w*|wipe\w*|submit\w*|post|publish\w*|share|unsubscrib\w*|transfer\w*|withdraw\w*|deactivat\w*|invite\w*|cancel\s+(?:order|subscription|plan|account|booking|membership))\b`,
  '发送|删除|移除|清空|销毁|提交|发布|发表|分享|退订|取消订阅|转账|提现|邀请|注销',
].join('|'), 'iu')

/**
 * Payments, purchases, account security, credentials and access. Any of
 * these in the name, the chosen options or the address makes the action
 * consequential.
 */
export const HIGH_RISK_WORDS = new RegExp([
  String.raw`\b(?:pay(?:ment)?s?|purchase\w*|buy(?:\s+now)?|checkout|check\s+out|place\s+order|order\s+now|billing|invoice|subscription|credit\s+card|card\s+number|bank|password|passcode|passkey|2fa|two[- ]factor|mfa|recovery|api\s+key|access\s+token|credential\w*|secret|delete\s+account|close\s+account|permission\w*|grant\s+access|add\s+member|ownership|forward\w*\s+(?:all\s+)?(?:incoming\s+)?mail|payout\w*|iban|wallet|beneficiar\w*|payee)\b`,
  '支付|付款|购买|下单|结算|充值|账单|发票|信用卡|银行|密码|验证码|口令|双重验证|两步验证|密钥|令牌|凭证|删除账户|删除账号|权限|授权|收款|钱包',
].join('|'), 'iu')

/** Address paths that say payment, purchase, account security, credentials or access. */
export const HIGH_RISK_PATHS = /\/(?:checkout|payment|payments|pay|billing|purchase|password|passwords|2fa|mfa|tokens|keys|credentials|permissions|ownership)(?:\/|$)/iu

/** A path as words: segments split on separators, percent-decoding tried. */
export function pathWords(path: string | undefined): string {
  if (path === undefined) return ''
  let decoded = path
  try { decoded = decodeURIComponent(path) } catch { /* keep it raw */ }
  return decoded.split(/[/_.\-+~]+/u).filter((part) => part !== '').join(' ')
}

function pathOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.pathname : undefined
  } catch {
    return undefined
  }
}

function destinationPath(destination: TargetDestination | undefined): string | undefined {
  return destination === undefined || 'other' in destination ? undefined : destination.path
}

/** Whether any of the texts carries a committing word. */
function commits(...texts: Array<string | undefined>): boolean {
  return texts.some((text) => typeof text === 'string' && text !== '' && COMMIT_WORDS.test(text))
}

/** Whether any of the texts (or paths) carries a high-risk word. */
function highRisk(texts: Array<string | undefined>, paths: Array<string | undefined> = []): boolean {
  return texts.some((text) => typeof text === 'string' && text !== '' && HIGH_RISK_WORDS.test(text))
    || paths.some((path) => typeof path === 'string' && (HIGH_RISK_PATHS.test(path) || HIGH_RISK_WORDS.test(pathWords(path))))
}

const ENTER_KEYS = new Set(['enter', 'return', 'numpadenter'])

/** Whether a key press is Enter (with or without modifiers). */
function pressesEnter(args: Record<string, unknown>): boolean {
  const key = typeof args.key === 'string' ? args.key : ''
  const base = (key.split('+').at(-1) ?? '').trim().toLowerCase()
  return ENTER_KEYS.has(base)
}

function found(state: TargetState | undefined): Extract<TargetState, { state: 'found' }> | undefined {
  return state?.state === 'found' ? state : undefined
}

/**
 * Why this action is consequential, from the card and the extension's own
 * facts; empty for an ordinary action.
 */
export function consequenceReasons(prompt: ApprovalPrompt, tool: string, args: Record<string, unknown>): ConsequenceReason[] {
  const reasons = new Set<ConsequenceReason>()
  const facts = prompt.review
  const targets = facts?.targets
  const target = found(targets?.target) ?? found(targets?.from)
  const to = found(targets?.to)

  // The taint rules flagged this step, or it is a standing grant that can act later.
  if (prompt.forced === true) {
    if (prompt.forcedBy?.includes('taint') === true) reasons.add('tainted')
    if (prompt.forcedBy === undefined) reasons.add(tool === 'browser_watch' || tool === 'browser_site_driver' ? 'standing' : 'tainted')
  }
  if (tool === 'browser_watch' || tool === 'browser_site_driver') reasons.add('standing')
  if (prompt.urlRisk === true) reasons.add('url-risk')
  if (tool === 'browser_run' || tool === 'browser_workflow_run') reasons.add('program')
  if (tool === 'browser_upload' || tool === 'browser_downloads' || tool === 'browser_save_pdf'
    || (tool === 'browser_extract' && typeof args.saveTo === 'string' && args.saveTo !== '')) reasons.add('files')
  if (target?.download === true) reasons.add('files')

  // Credentials and payment fields.
  // For typing, a field the content script did not clear as non-sensitive counts as sensitive (as the card masks it).
  // An ordinary field on a normal page is always inspected (false), so ordinary typing stays ordinary.
  if (target?.kind === 'password' || target?.sensitive === true || (tool === 'browser_type' && facts?.typedTargetSensitive !== false)) reasons.add('sensitive-field')

  // Words: the control's name, the chosen options, where its link or form goes, the navigation address.
  const linkPath = destinationPath(target?.href)
  const formPath = destinationPath(target?.form)
  const navigationPath = tool === 'browser_navigate' || tool === 'browser_open_tab' ? pathOf(args.url) : undefined
  const enter = tool === 'browser_press' && pressesEnter(args)
  const activates = tool === 'browser_click' || enter || tool === 'browser_select' || tool === 'browser_drag'
  const names = activates ? [target?.name, to?.name, ...target?.chosen ?? []] : []
  const submitting = (tool === 'browser_click' && target?.submits === true) || (enter && target?.inForm === true)
  const paths = [linkPath, navigationPath, submitting ? formPath : undefined]
  const dialogText = tool === 'browser_dialog' && args.accept !== false ? prompt.summary : undefined
  if (commits(...names, dialogText, ...paths.map(pathWords))) reasons.add('commit-words')
  const typedInto = tool === 'browser_type' ? target?.name : undefined
  if (highRisk([...names, typedInto, dialogText], paths)) reasons.add('high-risk-words')
  // A form that writes (POST) when this click or Enter submits it.
  if (submitting && target?.form !== undefined && !('other' in target.form) && target.form.method === 'post') reasons.add('submits-form')

  return [...reasons]
}

/**
 * What Auto approve does with one card that the ordinary flow would show
 * (the policy gate already returned "prompt").
 */
export function autoApprovePath(prompt: ApprovalPrompt, context: AutoContext): AutoPath {
  if (!context.on) return { kind: 'card', reason: 'off' }
  if (context.external || prompt.requester !== undefined) return { kind: 'card', reason: 'external-session' }
  if (context.optOut === true) return { kind: 'card', reason: 'opted-out' }
  // The developer-tools allowance is its own consent, unchanged by Auto approve,
  // except on the user's own local pages (their dev server): reads run, and
  // JavaScript or element changes go to the reviewer. Redaction opt-outs and
  // script-class attribute changes (perCallOnly) always keep their card.
  if (prompt.devTools === true) {
    if (context.localPage !== true || prompt.perCallOnly === true || prompt.origins.length === 0) return { kind: 'card', reason: 'devtools' }
    if (prompt.kind === 'read') return { kind: 'run' }
    // The reviewer judges code only on its full text: none, or too long to show, keeps the card.
    return pageScriptText(context.tool, context.args) === undefined ? { kind: 'card', reason: 'devtools' } : { kind: 'review', reasons: ['page-script'] }
  }
  // A browser permission can only be granted from a click on the card.
  if (prompt.permission !== undefined) return { kind: 'card', reason: 'permission' }
  // A site the user (or an administrator) set to "ask": their narrower rule wins.
  if (prompt.forced === true && prompt.forcedBy?.includes('site-ask') === true) return { kind: 'card', reason: 'site-rule' }
  const reasons = consequenceReasons(prompt, context.tool, context.args)
  return reasons.length === 0 ? { kind: 'run' } : { kind: 'review', reasons }
}

/** Origin and path of a URL, without query or fragment (secrets live there). */
export function originAndPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

/**
 * Page- or agent-authored text as the reviewer may see it: one plain line,
 * capped at {@link MAX_REVIEW_UNTRUSTED_CHARS} UTF-16 code units (what the
 * bridge counts), never split inside a character.
 */
export function untrustedText(value: unknown): string | undefined {
  let text = pageTextForCard(value, MAX_REVIEW_UNTRUSTED_CHARS)
  while (text.length > MAX_REVIEW_UNTRUSTED_CHARS) {
    const chars = [...text]
    text = `${chars.slice(0, chars.length - 2).join('')}…`
  }
  return text === '' ? undefined : text
}

const VERBS: Record<string, AutoReviewVerb> = {
  browser_click: 'click',
  browser_type: 'type',
  browser_select: 'select',
  browser_press: 'press',
  browser_drag: 'drag',
  browser_hover: 'hover',
  browser_navigate: 'navigate',
  browser_back: 'navigate',
  browser_open_tab: 'open-tab',
  browser_upload: 'upload',
  browser_downloads: 'download',
  browser_clipboard: 'clipboard',
  browser_dialog: 'dialog',
  browser_run: 'run-program',
  browser_workflow_run: 'run-program',
  browser_watch: 'watch',
  browser_fanout: 'fan-out',
  browser_site_driver: 'site-request',
  browser_save_pdf: 'save-file',
  browser_extract: 'save-file',
}

/** Facts the background adds to the card's own. */
export interface ReviewExtras {
  /** The conversation has read untrusted web page content. */
  tainted: boolean
  /** The tab's title (page-authored). */
  title?: string
}

/**
 * The structured action the reviewer is shown, built only from the
 * extension's own facts plus capped untrusted strings: the verb, the
 * control's visible name and section, the page title and address (origin and
 * path), the destination, and the text to be typed (never into a sensitive
 * field). No page content.
 */
/**
 * The full text a page-script step runs or sets, for the reviewer. Empty when
 * there is none or it is longer than the reviewer may see: the caller then
 * shows the card ({@link pageScriptReviewable}).
 */
export function pageScriptText(tool: string, args: Record<string, unknown>): string | undefined {
  const body = tool === 'browser_console_eval'
    ? typeof args.expression === 'string' ? args.expression : undefined
    : tool === 'browser_devtools_set_element_style'
      ? Array.isArray(args.properties)
        ? args.properties.map((entry) => {
          const record = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}
          return `${String(record.name)}: ${String(record.value)}${record.important === true ? ' !important' : ''}`
        }).join('\n')
        : undefined
      : tool === 'browser_devtools_set_element_attribute'
        ? `${String(args.name)}: ${args.remove === true ? '(remove)' : typeof args.value === 'string' ? args.value : '(read)'}`
        : undefined
  if (body === undefined || body.trim() === '') return undefined
  // The arguments that change where it runs or how far it reaches, whole, so the reviewer judges what really runs.
  const context = scriptContext(tool, args)
  const text = context.length === 0 ? body : `${context.join('\n')}\n---\n${body}`
  return text.length > MAX_REVIEW_SCRIPT_CHARS ? undefined : text
}

function scriptContext(tool: string, args: Record<string, unknown>): string[] {
  const lines: string[] = []
  if (tool !== 'browser_console_eval') {
    if (typeof args.selector === 'string' && args.selector !== '') lines.push(`[target selector: ${args.selector}]`)
    else if (typeof args.index === 'number') lines.push(`[target: snapshot element ${args.index}]`)
    else lines.push('[target: the focused element]')
  }
  if (args.frame !== undefined) lines.push(`[frame: ${JSON.stringify(args.frame)}]`)
  if (tool === 'browser_devtools_set_element_style' && args.mode === 'rule') {
    lines.push('[mode: rule: edits the matching stylesheet rule, so every element that rule matches changes]')
  }
  if (tool === 'browser_console_eval' && args.awaitPromise === true) lines.push('[awaitPromise: waits for a returned promise]')
  return lines
}

function scriptField(tool: string, args: Record<string, unknown>): { script?: string } {
  const text = pageScriptText(tool, args)
  return text === undefined ? {} : { script: text }
}

export function buildReviewAction(prompt: ApprovalPrompt, tool: string, args: Record<string, unknown>, extras: ReviewExtras, reasons: ConsequenceReason[]): ReviewAction {
  const facts = prompt.review
  const target = found(facts?.targets?.target) ?? found(facts?.targets?.from)
  const put = <K extends keyof ReviewAction['untrusted']>(key: K, value: unknown): Partial<ReviewAction['untrusted']> => {
    const text = untrustedText(value)
    return text === undefined ? {} : { [key]: text }
  }
  const destination = target?.href !== undefined && !('other' in target.href) ? `${target.href.origin}${target.href.path}`
    : target?.submits === true && target.form !== undefined && !('other' in target.form) ? `${target.form.origin}${target.form.path}`
      : tool === 'browser_navigate' || tool === 'browser_open_tab' ? originAndPath(typeof args.url === 'string' ? args.url : undefined)
        : undefined
  const sensitive = target?.sensitive === true || target?.kind === 'password' || facts?.typedTargetSensitive !== false
  return {
    tool,
    verb: VERBS[tool] ?? 'other',
    targetKind: target?.kind ?? 'none',
    reasons,
    tainted: extras.tainted,
    untrusted: {
      ...put('name', target?.name),
      ...put('context', target?.context?.text),
      ...target === undefined ? put('summary', prompt.stepLabel ?? prompt.summary) : {},
      ...put('title', extras.title),
      ...put('url', originAndPath(facts?.pageUrl)),
      ...put('destination', destination),
      ...tool === 'browser_type' && !sensitive ? put('typed', args.text) : {},
      ...tool === 'browser_press' ? put('key', typeof args.key === 'string' ? args.key.slice(0, 40) : undefined) : {},
      ...reasons.includes('page-script') ? scriptField(tool, args) : {},
    },
  }
}
