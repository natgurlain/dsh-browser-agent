/**
 * Auto review's deterministic floor (docs/auto-review-design.md §5, §9).
 *
 * Decided by the extension BEFORE any model is asked, and never widened by
 * the reviewer's answer: which approval cards a reviewer may decide at all,
 * how commit-like the action is, and the structured action the reviewer is
 * shown. Pure functions only, so every rule is unit-tested.
 *
 * @module
 */

import {
  AUTO_REVIEW_TOOLS,
  MAX_REVIEW_RECENT,
  MAX_REVIEW_UNTRUSTED_CHARS,
  type AutoReviewTool,
  type ReviewAction,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { ApprovalPrompt } from './approval.ts'
import { pageTextForCard, type TargetKind, type TargetState } from '../shared/target-description.ts'

/** Why a card is not reviewed (stable codes; tests and the audit read them). */
export type IneligibleReason =
  | 'off'
  | 'no-session'
  | 'external-session'
  | 'not-page-action'
  | 'program'
  | 'fleet-child'
  | 'not-action'
  | 'forced'
  | 'per-call-only'
  | 'permission'
  | 'devtools'
  | 'browser-only'
  | 'url-risk'
  | 'external-requester'
  | 'dev-loop'
  | 'no-binding'
  | 'policy'
  | 'tool'
  | 'target-not-found'
  | 'sensitive-target'
  | 'cross-origin-navigation'

export type Eligibility = { eligible: true; tool: AutoReviewTool } | { eligible: false; reason: IneligibleReason }

/** Where the call came from, as the background's router knows it. */
export interface ReviewCallContext {
  /** Auto review is on for the conversation (toggle, Setting, managed policy, bridge cap, connection, expiry). */
  enabled: boolean
  sessionId?: string
  /** An external (MCP client) session: there is no user instruction source. */
  external: boolean
  /** The ordinary tab-bound page-action dispatcher raised the card. */
  pageAction: boolean
  /** A `browser_run` program or series step. */
  program: boolean
  /** The card shows under another session (a fleet child's parent). */
  fleetChild: boolean
  /** The call's tool name. */
  tool: string
  /** The call's arguments (for navigation's destination and the key of a press). */
  args: Record<string, unknown>
}

const REVIEW_TOOLS: ReadonlySet<string> = new Set(AUTO_REVIEW_TOOLS)

/** Kinds a reviewer never decides for, whatever the page says about sensitivity. */
const NEVER_KINDS: ReadonlySet<TargetKind> = new Set(['password', 'file'])

function targetSlots(tool: string, args: Record<string, unknown>): Array<'target' | 'from' | 'to'> {
  if (tool === 'browser_drag') {
    const to = args.toOffset !== undefined && typeof args.toOffset === 'object' && args.toOffset !== null ? [] : ['to' as const]
    return ['from', ...to]
  }
  if (tool === 'browser_navigate') return []
  return ['target']
}

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * The eligibility floor: whether Auto review may decide this card. Every
 * condition must hold; the first that fails is the reason.
 */
export function autoReviewEligibility(prompt: ApprovalPrompt, call: ReviewCallContext): Eligibility {
  const no = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason })
  if (!call.enabled) return no('off')
  if (call.sessionId === undefined || call.sessionId === '') return no('no-session')
  if (call.external) return no('external-session')
  if (!call.pageAction) return no('not-page-action')
  if (call.program) return no('program')
  if (call.fleetChild) return no('fleet-child')
  if (prompt.kind !== 'action') return no('not-action')
  if (prompt.forced === true) return no('forced')
  if (prompt.perCallOnly === true) return no('per-call-only')
  if (prompt.permission !== undefined) return no('permission')
  if (prompt.devTools === true) return no('devtools')
  if (prompt.browserOnly === true) return no('browser-only')
  if (prompt.urlRisk === true) return no('url-risk')
  if (prompt.requester !== undefined) return no('external-requester')
  if (prompt.devLoopFor !== undefined) return no('dev-loop')
  if (prompt.binding === undefined || prompt.binding === '') return no('no-binding')
  if (prompt.action !== call.tool || !REVIEW_TOOLS.has(call.tool)) return no('tool')
  const facts = prompt.review
  if (facts?.policy !== 'default') return no('policy')
  for (const slot of targetSlots(call.tool, call.args)) {
    const state = facts.targets?.[slot]
    if (state?.state !== 'found') return no('target-not-found')
    if (state.sensitive === true || NEVER_KINDS.has(state.kind)) return no('sensitive-target')
  }
  // Undefined means "not inspected", which counts as sensitive.
  if (call.tool === 'browser_type' && facts.typedTargetSensitive !== false) return no('sensitive-target')
  if (call.tool === 'browser_navigate') {
    const destination = originOf(call.args.url)
    if (destination === undefined || facts.topOrigin === undefined || destination !== facts.topOrigin) return no('cross-origin-navigation')
  }
  return { eligible: true, tool: call.tool as AutoReviewTool }
}

/**
 * Words that name an action which commits something: sending, saving,
 * deleting, confirming (English and Chinese). Matched on the element's name.
 */
const COMMIT_WORDS = new RegExp([
  String.raw`\b(?:submit|send|post|publish|save|apply|confirm|delete|remove|discard|archive|reply|comment|share|invite|update|create|place order|order now|checkout|check out|pay|buy|purchase|subscribe|unsubscribe|sign out|log out|logout|sign in|log in|login|sign up|register|transfer|withdraw|deposit|accept|approve|decline|reject|unfollow|follow|block|report|merge|deploy|revoke|grant|reset|cancel (?:order|subscription|plan|account)|close account|leave|join|book|reserve|upload|install|uninstall|enable|disable|turn (?:on|off))\b`,
  '提交|发送|发布|保存|应用|确认|确定|删除|移除|丢弃|归档|回复|评论|分享|邀请|更新|创建|下单|结算|支付|付款|购买|订阅|退订|退出|登出|登录|注册|转账|提现|充值|接受|同意|批准|拒绝|关注|取消关注|屏蔽|举报|合并|部署|撤销|授权|重置|预订|预约|上传|安装|卸载|启用|停用|开启|关闭',
].join('|'), 'iu')

/**
 * Words for payments, purchases, account security, credentials and access:
 * an action whose name, context or page address says this is high risk and
 * always goes to the user.
 */
const HIGH_RISK_WORDS = new RegExp([
  String.raw`\b(?:pay(?:ment)?s?|purchase|buy(?: now)?|checkout|check out|place order|order now|transfer|withdraw|wire|billing|invoice|subscription|credit card|card number|bank|password|passcode|passkey|2fa|two[- ]factor|mfa|security|recovery|api key|access token|token|credential|secret|delete account|close account|deactivate|permission|grant access|add member|invite member|admin)\b`,
  '支付|付款|购买|下单|结算|转账|提现|充值|账单|发票|订阅|信用卡|银行|密码|验证码|口令|双重验证|两步验证|安全|恢复|密钥|令牌|凭证|注销|删除账户|删除账号|账户设置|账号设置|权限|授权|管理员',
].join('|'), 'iu')

/** Page address paths that say payment, account security or credentials. */
const HIGH_RISK_PATHS = /\/(?:checkout|payment|payments|pay|billing|purchase|security|password|passwords|2fa|mfa|tokens|keys|credentials|admin|permissions)(?:\/|$)/iu

const ENTER_KEYS = /(?:^|\+)(?:Enter|NumpadEnter|Return)$/iu

/** Kinds a person types into. */
const FIELD_KINDS: ReadonlySet<TargetKind> = new Set([
  'textbox', 'searchbox', 'spinbutton', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'editable', 'password', 'combobox',
])
/** Kinds that are pressed. */
const BUTTON_KINDS: ReadonlySet<TargetKind> = new Set(['button', 'menuitem', 'option', 'tab', 'summary'])
/** Kinds that hold a choice. */
const CONTROL_KINDS: ReadonlySet<TargetKind> = new Set(['checkbox', 'radio', 'switch', 'slider', 'select', 'listbox', 'color', 'file'])

/** How the element presents itself, from its kind (never from page prose). */
export function targetClass(state: TargetState | undefined): ReviewAction['targetClass'] {
  if (state?.state !== 'found') return 'none'
  if (state.kind === 'link') return 'link'
  if (BUTTON_KINDS.has(state.kind)) return 'button'
  if (FIELD_KINDS.has(state.kind)) return 'field'
  if (CONTROL_KINDS.has(state.kind)) return 'control'
  return 'other'
}

/** How commit-like one action is, deterministically. */
export interface CommitAssessment {
  /** Native structure: a submit control, or Enter in a field with a form owner (or an editable area). */
  formSubmitLikely: boolean
  /** Structure or EN/ZH name says it commits something. */
  commitLike: boolean
  /** Payment, purchase, security, credential or access words in the name, context or address. */
  highRiskWords: boolean
}

/**
 * Judge one action's commit-likeness. Structure first (a page cannot hide a
 * submit button behind a role), then the element's name.
 */
export function assessCommit(tool: string, args: Record<string, unknown>, states: ApprovalPrompt['review'], pageUrl?: string, destination?: string): CommitAssessment {
  const target = states?.targets?.target
  const found = target?.state === 'found' ? target : undefined
  const key = typeof args.key === 'string' ? args.key : ''
  const enter = tool === 'browser_press' && ENTER_KEYS.test(key)
  const formSubmitLikely = (tool === 'browser_click' && found?.submits === true)
    || (enter && (found?.inForm === true || found?.submits === true))
  const enterInEditable = enter && found !== undefined && (found.kind === 'textarea' || found.kind === 'editable')
  const names = [found?.name, states?.targets?.from?.state === 'found' ? states.targets.from.name : undefined, states?.targets?.to?.state === 'found' ? states.targets.to.name : undefined]
    .filter((value): value is string => typeof value === 'string' && value !== '')
  // A drag or hover does not commit by its name alone; a click, press, select or type may.
  const nameCommits = tool !== 'browser_hover' && names.some((name) => COMMIT_WORDS.test(name))
  const contexts = [found?.context?.text].filter((value): value is string => typeof value === 'string' && value !== '')
  const paths = [pageUrl, destination].map(pathOf).filter((value): value is string => value !== undefined)
  const highRiskWords = [...names, ...contexts].some((text) => HIGH_RISK_WORDS.test(text))
    || paths.some((path) => HIGH_RISK_PATHS.test(path))
  return {
    formSubmitLikely,
    commitLike: formSubmitLikely || enterInEditable || nameCommits,
    highRiskWords,
  }
}

function pathOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new URL(value).pathname
  } catch {
    return undefined
  }
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

/** Page- or agent-authored text as the reviewer may see it: one plain line, capped. */
export function untrustedText(value: unknown): string | undefined {
  const text = pageTextForCard(value, MAX_REVIEW_UNTRUSTED_CHARS)
  return text === '' ? undefined : text
}

function verbOf(tool: AutoReviewTool, args: Record<string, unknown>): ReviewAction['verb'] {
  switch (tool) {
    case 'browser_click':
      if (args.action === 'dblclick' || args.clicks === 2) return 'double-click'
      if (args.button === 'right') return 'right-click'
      return 'click'
    case 'browser_type': return 'type'
    case 'browser_select': return 'select'
    case 'browser_hover': return 'hover'
    case 'browser_press': return 'press'
    case 'browser_drag': return 'drag'
    case 'browser_navigate': return 'navigate'
  }
}

/** Selected option labels/values of a browser_select call (agent-authored). */
function selectedOptions(args: Record<string, unknown>): string[] {
  const values: unknown[] = []
  for (const key of ['label', 'value', 'labels', 'values', 'option', 'options']) {
    const entry = args[key]
    if (Array.isArray(entry)) values.push(...entry)
    else if (entry !== undefined) values.push(entry)
  }
  return values.map(untrustedText).filter((value): value is string => value !== undefined).slice(0, 5)
}

/** Facts the background adds to the card's own. */
export interface ReviewExtras {
  tainted: boolean
  approvedThisTurn: number
  /** The tab's title (page-authored). */
  title?: string
  /** Labels of the actions Auto approved this turn, newest last. */
  recent: readonly string[]
}

/**
 * The structured action the reviewer is shown, built only from the
 * extension's own facts plus capped untrusted strings.
 */
export function buildReviewAction(prompt: ApprovalPrompt, tool: AutoReviewTool, args: Record<string, unknown>, extras: ReviewExtras): ReviewAction {
  const facts = prompt.review
  const target = facts?.targets?.target ?? facts?.targets?.from
  const found = target?.state === 'found' ? target : undefined
  const destination = tool === 'browser_navigate' && typeof args.url === 'string' ? args.url : undefined
  const commit = assessCommit(tool, args, facts, facts?.pageUrl, destination)
  const typed = tool === 'browser_type' && facts?.typedTargetSensitive === false ? untrustedText(args.text) : undefined
  const options = tool === 'browser_select' ? selectedOptions(args) : []
  const recent = extras.recent.slice(-MAX_REVIEW_RECENT).map(untrustedText).filter((value): value is string => value !== undefined)
  const untrusted: ReviewAction['untrusted'] = {
    ...untrustedText(found?.name) === undefined ? {} : { name: untrustedText(found?.name)! },
    ...untrustedText(found?.context?.text) === undefined ? {} : { context: untrustedText(found?.context?.text)! },
    ...untrustedText(extras.title) === undefined ? {} : { title: untrustedText(extras.title)! },
    ...untrustedText(originAndPath(facts?.pageUrl)) === undefined ? {} : { url: untrustedText(originAndPath(facts?.pageUrl))! },
    ...untrustedText(originAndPath(destination)) === undefined ? {} : { destination: untrustedText(originAndPath(destination))! },
    ...typed === undefined ? {} : { typed },
    ...options.length === 0 ? {} : { options },
    ...recent.length === 0 ? {} : { recent },
  }
  const key = tool === 'browser_press' && typeof args.key === 'string' ? args.key.slice(0, 40) : undefined
  return {
    tool,
    verb: verbOf(tool, args),
    targetKind: found?.kind ?? 'none',
    targetClass: targetClass(found),
    ...commit,
    sameOrigin: tool !== 'browser_navigate' || (originAndPath(destination) !== undefined && new URL(destination!).origin === facts?.topOrigin),
    tainted: extras.tainted,
    approvedThisTurn: Math.max(0, Math.min(10_000, Math.floor(extras.approvedThisTurn))),
    ...tool === 'browser_type' && typeof args.text === 'string' ? { typedChars: args.text.length } : {},
    ...key === undefined ? {} : { key },
    untrusted,
  }
}

/** Longest reviewer reason shown on a card or timeline row. */
export const MAX_REVIEW_REASON_CHARS = 160

/** The reviewer's reason as the panel may show it: page-text rules, capped. */
export function reviewReasonForCard(value: unknown): string {
  return pageTextForCard(value, MAX_REVIEW_REASON_CHARS)
}
