/**
 * Auto review's deterministic floor (docs/auto-review-design.md §5, §9).
 *
 * Decided by the extension BEFORE any model is asked, and never widened by
 * the reviewer's answer: which approval cards a reviewer may decide at all,
 * what each action would commit (its commit class), and the structured
 * action the reviewer is shown. Pure functions only, so every rule is
 * unit-tested.
 *
 * The rule of thumb: only actions the extension can show to be harmless are
 * "low" (the reviewer may allow them when they fit the task). Everything that
 * commits something, and every button whose name does not clearly say it is
 * harmless, is at least "medium": the bridge then lets it through only when
 * the user's newest message asks for that kind of action on that target. A
 * word list can never be complete, so the default for buttons is "needs your
 * words", not "harmless".
 *
 * @module
 */

import {
  AUTO_REVIEW_TOOLS,
  MAX_REVIEW_RECENT,
  MAX_REVIEW_UNTRUSTED_CHARS,
  type AutoReviewTool,
  type CommitClass,
  type ReviewAction,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { ApprovalPrompt } from './approval.ts'
import { pageTextForCard, type TargetDestination, type TargetKind, type TargetState } from '../shared/target-description.ts'

/** Why a card is not reviewed (stable codes; tests and the audit read them). */
export type IneligibleReason =
  | 'off'
  | 'not-visible'
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
  | 'navigation-query'
  | 'tainted-navigation'
  | 'typed-line-break'
  | 'link-destination'
  | 'form-destination'
  | 'data-in-path'
  | 'press-key'
  | 'select-unresolved'
  | 'download'

/** What the extension concluded about an eligible action. */
export interface Assessment {
  commitClass: CommitClass
  /** Native structure: a submit control, or Enter in a field with a form owner. */
  formSubmitLikely: boolean
  /** Payment, purchase, security, credential or access words in the name, context, options or address. */
  highRiskWords: boolean
  /** Only where computed: a navigation, link or form destination on the current page's origin. */
  sameOrigin?: boolean
  /** The navigation, link or form destination (origin + path). */
  destination?: string
}

export type Eligibility =
  | { eligible: true; tool: AutoReviewTool; assessment: Assessment }
  | { eligible: false; reason: IneligibleReason }

/** Where the call came from, as the background's router knows it. */
export interface ReviewCallContext {
  /** Auto review is on for the conversation (toggle, Setting, managed policy, bridge cap, connection, expiry). */
  enabled: boolean
  /** A side panel is open and showing this conversation (nobody watching: no Auto approval). */
  visible?: boolean
  sessionId?: string
  /** An external (MCP client) session: there is no user instruction source. */
  external: boolean
  /** The ordinary tab-bound page-action dispatcher raised the card. */
  pageAction: boolean
  /** A `browser_run` program or series step. */
  program: boolean
  /** The card shows under another session (a fleet child's parent). */
  fleetChild: boolean
  /** The conversation has read web pages that taint it. */
  tainted?: boolean
  /** The call's tool name. */
  tool: string
  /** The call's arguments (for navigation's destination and the key of a press). */
  args: Record<string, unknown>
}

const REVIEW_TOOLS: ReadonlySet<string> = new Set(AUTO_REVIEW_TOOLS)

/** Kinds a reviewer never decides for, whatever the page says about sensitivity. */
const NEVER_KINDS: ReadonlySet<TargetKind> = new Set(['password', 'file'])

/** Kinds a person types into. */
const TEXT_KINDS: ReadonlySet<TargetKind> = new Set([
  'textbox', 'searchbox', 'spinbutton', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'editable', 'combobox',
])
/** Kinds that are pressed and whose effect only their page code knows. */
const BUTTON_KINDS: ReadonlySet<TargetKind> = new Set(['button', 'menuitem', 'clickable', 'element', 'image', 'label'])
/** Kinds that hold a choice or open a section: low unless their words say otherwise. */
const CHOICE_KINDS: ReadonlySet<TargetKind> = new Set(['checkbox', 'radio', 'switch', 'slider', 'tab', 'option', 'summary', 'select', 'listbox', 'color'])

/**
 * Commit classes by the words of a name or a path, EN and ZH, matched on
 * stems. Checked in order; the first match wins.
 */
const CLASS_WORDS: ReadonlyArray<readonly [CommitClass, RegExp]> = [
  ['delete', /\b(?:delet\w*|remov\w*|trash\w*|bin|archiv\w*|discard\w*|eras\w*|purg\w*|destroy\w*|empty|clear(?:ed)?|wipe\w*)\b|删除|移除|回收站|废纸篓|垃圾箱|归档|清空|丢弃|销毁/iu],
  ['send', /\b(?:send\w*|sent|forward\w*|repl(?:y|ies|ied)|respond\w*|e-?mail(?:ed)?)\b|发送|转发|回复|发给/iu],
  ['share', /\b(?:share\w*|unshare\w*|publish\w*|make\s+(?:it\s+)?(?:public|private)|public|private|everyone|anyone|visib\w*|invit\w*)\b|分享|共享|公开|发布|邀请|所有人|任何人/iu],
  ['submit', /\b(?:submit\w*|post(?:ed|ing)?|comment(?:ed)?|checkout|check\s+out|order)\b|提交|发表|评论|下单/iu],
  ['save', /\b(?:sav(?:e|ed|ing)|updat\w*|apply|applied)\b|保存|更新|应用/iu],
  ['account', /\b(?:log\s*out|log\s*in|sign\s*(?:out|in|up)|logout|login|signout|signin|signup|subscrib\w*|unsubscrib\w*|follow\w*|unfollow\w*|join\w*|leav\w*|block\w*|report\w*|mute\w*)\b|登录|退出|登出|注册|订阅|退订|关注|加入|屏蔽|举报/iu],
  ['change', /\b(?:transfer\w*|mov(?:e|ed|ing)|merg\w*|revok\w*|reset\w*|deploy\w*|enabl\w*|disabl\w*|turn\s+(?:on|off)|install\w*|uninstall\w*|approv\w*|declin\w*|reject\w*|accept\w*|cancel\s+(?:order|subscription|plan|account|booking)|book\w*|reserv\w*|restor\w*|rename\w*|assign\w*)\b|转移|移动|合并|撤销|重置|部署|启用|停用|开启|关闭|批准|拒绝|接受|预订|预约|恢复|重命名|分配/iu],
  ['confirm', /\b(?:done|ok|okay|yes|confirm\w*|continue|proceed|finish\w*|complete|agree\w*|got\s+it|i\s+understand)\b|确定|确认|继续|完成|同意|好的/iu],
]

/**
 * Payments, purchases, account security, credentials and access. Any of these
 * in the name, context, chosen options or the address: always the user's call.
 */
const HIGH_RISK_WORDS = new RegExp([
  String.raw`\b(?:pay(?:ment)?s?|purchase\w*|buy(?:\s+now)?|checkout|check\s+out|place\s+order|order\s+now|transfer|withdraw\w*|wire|billing|invoice|subscription|credit\s+card|card\s+number|bank|password|passcode|passkey|2fa|two[- ]factor|mfa|security|recovery|api\s+key|access\s+token|token|credential\w*|secret|delete\s+account|close\s+account|deactivat\w*|permission\w*|grant\s+access|add\s+member|invite\s+member|admin\w*|owner\w*|ownership|super\s?user|root)\b`,
  '支付|付款|购买|下单|结算|转账|提现|充值|账单|发票|订阅|信用卡|银行|密码|验证码|口令|双重验证|两步验证|安全|恢复|密钥|令牌|凭证|注销|删除账户|删除账号|账户设置|账号设置|权限|授权|管理员|所有者',
].join('|'), 'iu')

/** Address paths that say payment, account security, credentials, administration, or destruction. */
const HIGH_RISK_PATHS = /\/(?:checkout|payment|payments|pay|billing|purchase|security|password|passwords|2fa|mfa|tokens|keys|credentials|admin|permissions|members|ownership)(?:\/|$)/iu

/** Selection options that hand out access. */
const SHARE_OPTIONS = /\b(?:public|private|everyone|anyone|editor|member|viewer|guest|collaborator|commenter|maintainer|developer|write|access)\b|公开|私密|所有人|任何人|编辑者|成员|查看者|访客/iu

/** Fields where typed text decides who or what receives something: recipients, addresses, links, amounts. */
const ADDRESS_FIELD = /\b(?:to|cc|bcc|recipients?|e-?mail|address|url|link|website|amount|quantity|qty|price|share\s+with|invite|phone)\b|收件人|抄送|密送|邮箱|地址|网址|链接|金额|数量|价格|分享给|邀请/iu
const ADDRESS_KINDS: ReadonlySet<TargetKind> = new Set(['email', 'url', 'tel', 'number', 'spinbutton'])

/**
 * The words a harmless button's name may consist of (EN): verbs that only
 * show, hide or move around, and the UI nouns they act on. A button is low
 * only when EVERY word of its name is one of these ("Show more", "Next
 * page", "Expand all comments"); "Close issue", "Cancel membership" or "Go
 * live" are not. Any other button is at least medium.
 */
const HARMLESS_WORDS = new Set([
  'open', 'show', 'view', 'see', 'expand', 'collapse', 'more', 'less', 'load', 'read', 'next', 'previous', 'prev', 'back', 'close',
  'dismiss', 'hide', 'menu', 'options', 'details', 'info', 'help', 'filter', 'filters', 'sort', 'preview', 'zoom', 'in', 'out',
  'toggle', 'refresh', 'scroll', 'page', 'pages', 'all', 'comments', 'replies', 'results', 'items', 'list', 'panel', 'dialog',
  'sidebar', 'navigation', 'nav', 'section', 'thread', 'up', 'down', 'top', 'bottom', 'first', 'last', 'older', 'newer', 'the',
  'a', 'an', 'cancel', 'go', 'to', 'tab', 'tabs', 'image', 'images', 'photo', 'photos', 'text', 'description', 'answer', 'answers',
])
const HARMLESS_ZH = /^(?:打开|显示|查看|展开|收起|更多|下一页|上一页|返回|关闭|菜单|详情|帮助|筛选|排序|刷新|预览|加载)(?:更多|详情|菜单|全部|评论|回复|内容|结果)?$/u

/** Keys that only move focus, scroll or dismiss. */
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Esc', 'PageUp', 'PageDown', 'Home', 'End', 'Up', 'Down', 'Left', 'Right'])
const ENTER_KEYS = new Set(['Enter', 'Return', 'NumpadEnter'])
const SPACE_KEYS = new Set([' ', 'Space', 'Spacebar'])
const MODIFIER_NAMES: Record<string, string> = {
  shift: 'Shift', control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', os: 'Meta',
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

function hasQueryOrFragment(value: unknown): boolean {
  if (typeof value !== 'string') return true
  try {
    const url = new URL(value)
    return url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')
  } catch {
    return true
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

/** A path as words: segments split on separators, percent-decoding tried. */
function pathWords(path: string | undefined): string {
  if (path === undefined) return ''
  let decoded = path
  try { decoded = decodeURIComponent(path) } catch { /* keep it raw */ }
  return decoded.split(/[/_.\-+~]+/u).filter((part) => part !== '').join(' ')
}

/**
 * Whether a path segment looks like it carries a host, a URL or data rather
 * than a page name: dots with a top-level domain, percent-encoding, or a long
 * run that mixes letters and digits.
 */
export function pathCarriesData(path: string | undefined): boolean {
  if (path === undefined) return false
  return path.split('/').some((segment) => /%[0-9a-f]{2}/iu.test(segment)
    || /[a-z0-9-]\.[a-z]{2,}(?:$|[^a-z])/iu.test(segment)
    || (segment.length >= 12 && /\d/u.test(segment) && /[a-z]/iu.test(segment)))
}

/** The commit class the words of a name, path or option say, if any. */
export function classOfWords(...texts: Array<string | undefined>): CommitClass | undefined {
  const text = texts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ')
  if (text === '') return undefined
  for (const [cls, pattern] of CLASS_WORDS) if (pattern.test(text)) return cls
  return undefined
}

/** Whether a button's own name says it only shows, hides or moves around. */
export function harmlessButtonName(name: string): boolean {
  const trimmed = name.trim()
  if (HARMLESS_ZH.test(trimmed)) return true
  const words = trimmed.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  return words.length > 0 && words.every((word) => HARMLESS_WORDS.has(word) || /^\d+$/u.test(word))
}

function highRisk(...texts: Array<string | undefined>): boolean {
  return texts.some((text) => typeof text === 'string' && text !== '' && HIGH_RISK_WORDS.test(text))
}

function destinationText(destination: TargetDestination | undefined): string | undefined {
  return destination === undefined || 'other' in destination ? undefined : `${destination.origin}${destination.path}`
}

type Classified = { reason: IneligibleReason } | Assessment

function no(reason: IneligibleReason): { reason: IneligibleReason } {
  return { reason }
}

/** A click (or Space/Enter on a focused control) on one found element. */
function classifyClick(target: Extract<TargetState, { state: 'found' }>, topOrigin: string | undefined, tainted: boolean): Classified {
  const name = target.name
  const context = target.context?.text
  // A link: where it goes decides. Cross-origin, query-carrying or non-web destinations are the user's call.
  if (target.href !== undefined) {
    // A download writes a file to the user's disk: never Auto.
    if (target.download === true) return no('download')
    const href = target.href
    if ('other' in href || topOrigin === undefined || href.origin !== topOrigin || href.query) return no('link-destination')
    if (tainted && pathCarriesData(href.path)) return no('data-in-path')
    const cls = classOfWords(name, pathWords(href.path))
    return {
      commitClass: cls ?? (target.kind === 'link' || CHOICE_KINDS.has(target.kind) || harmlessButtonName(name) ? 'none' : 'unknown'),
      formSubmitLikely: false,
      highRiskWords: highRisk(name, context, href.path) || HIGH_RISK_PATHS.test(href.path),
      sameOrigin: true,
      destination: destinationText(href),
    }
  }
  // A submit control: where its form goes decides too, and it is at least a submission.
  if (target.submits === true) {
    const form = target.form
    if (form === undefined || 'other' in form || topOrigin === undefined || form.origin !== topOrigin) return no('form-destination')
    return {
      commitClass: classOfWords(name, pathWords(form.path)) ?? 'submit',
      formSubmitLikely: true,
      highRiskWords: highRisk(name, context, form.path) || HIGH_RISK_PATHS.test(form.path),
      sameOrigin: true,
      destination: destinationText(form),
    }
  }
  const cls = classOfWords(name)
  // A link the page reported no destination for is an unclear button.
  if (BUTTON_KINDS.has(target.kind) || target.kind === 'link') {
    // The structural default: a button that does not clearly say it is harmless needs the user's words.
    return { commitClass: cls ?? (name !== '' && harmlessButtonName(name) ? 'none' : 'unknown'), formSubmitLikely: false, highRiskWords: highRisk(name, context) }
  }
  // Checkboxes, switches, tabs and options name a preference, not an action
  // ("Email notifications"): only words that change who can see something count.
  return { commitClass: cls === 'share' ? 'share' : 'none', formSubmitLikely: false, highRiskWords: highRisk(name, context) }
}

/** Typing (or a character key) into a found text field. */
function classifyTyping(target: Extract<TargetState, { state: 'found' }>, tainted: boolean): Classified {
  const address = ADDRESS_KINDS.has(target.kind) || ADDRESS_FIELD.test(target.name)
  return {
    // Typing page data into the site it came from needs the user's words too.
    commitClass: address ? 'address' : tainted ? 'type' : 'none',
    formSubmitLikely: false,
    highRiskWords: highRisk(target.name, target.context?.text),
  }
}

/** The key of a press and its modifiers, from `key` (a chord) and `modifiers`. */
export function parseKeyPress(args: Record<string, unknown>): { key: string; modifiers: string[] } | undefined {
  const raw = args.key
  if (typeof raw !== 'string' || raw === '') return undefined
  let key = raw
  let named: unknown[] = []
  if (raw.length > 1 && raw.includes('+')) {
    const parts = raw.split('+')
    if (raw.endsWith('++')) {
      key = '+'
      named = parts.slice(0, -2)
    } else {
      key = parts.at(-1)!
      named = parts.slice(0, -1)
    }
    if (key === '') return undefined
  }
  named = [...named, ...Array.isArray(args.modifiers) ? args.modifiers : []]
  const modifiers: string[] = []
  for (const name of named) {
    if (typeof name !== 'string') return undefined
    const canonical = MODIFIER_NAMES[name.trim().toLowerCase()]
    if (canonical === undefined) return undefined
    if (!modifiers.includes(canonical)) modifiers.push(canonical)
  }
  return { key, modifiers }
}

/** A key press on the focused (or addressed) element. */
function classifyPress(target: Extract<TargetState, { state: 'found' }>, args: Record<string, unknown>, topOrigin: string | undefined, tainted: boolean): Classified {
  if (args.action !== undefined && args.action !== 'press') return no('press-key')
  const press = parseKeyPress(args)
  if (press === undefined) return no('press-key')
  // Control, Alt and Meta make app shortcuts with unknown effects.
  if (press.modifiers.some((modifier) => modifier !== 'Shift')) return no('press-key')
  const { key } = press
  const field = TEXT_KINDS.has(target.kind)
  if (NAVIGATION_KEYS.has(key)) return { commitClass: 'none', formSubmitLikely: false, highRiskWords: false }
  if (ENTER_KEYS.has(key) && field) {
    // Shift+Enter in a multi-line field is a line break: typing.
    if (press.modifiers.includes('Shift') && (target.kind === 'textarea' || target.kind === 'editable')) return classifyTyping(target, tainted)
    if (target.inForm === true) {
      // Enter submits the field's form: where that form goes decides too.
      const form = target.form
      if (form === undefined || 'other' in form || topOrigin === undefined || form.origin !== topOrigin) return no('form-destination')
      return { commitClass: classOfWords(pathWords(form.path)) ?? 'submit', formSubmitLikely: true, highRiskWords: highRisk(target.name, target.context?.text, form.path) || HIGH_RISK_PATHS.test(form.path), sameOrigin: true, destination: destinationText(form) }
    }
    // Enter in a message box sends; in any other field its page code decides.
    return { commitClass: target.kind === 'textarea' || target.kind === 'editable' ? 'send' : 'submit', formSubmitLikely: false, highRiskWords: highRisk(target.name, target.context?.text) }
  }
  if ((ENTER_KEYS.has(key) || SPACE_KEYS.has(key)) && !field) {
    // Space or Enter on a button, link or control is a click on it.
    return classifyClick(target, topOrigin, tainted)
  }
  // A character (Space included) into a text field is typing.
  if (field && ([...key].length === 1 || SPACE_KEYS.has(key))) return classifyTyping(target, tainted)
  // Single-key app shortcuts (#, e, Delete, …) on anything else: their effect is unknown.
  return no('press-key')
}

/**
 * The eligibility floor and the classification together: whether Auto
 * review may decide this card, and what the action would commit.
 */
export function autoReviewEligibility(prompt: ApprovalPrompt, call: ReviewCallContext): Eligibility {
  const refuse = (reason: IneligibleReason): Eligibility => ({ eligible: false, reason })
  if (!call.enabled) return refuse('off')
  if (call.visible === false) return refuse('not-visible')
  if (call.sessionId === undefined || call.sessionId === '') return refuse('no-session')
  if (call.external) return refuse('external-session')
  if (!call.pageAction) return refuse('not-page-action')
  if (call.program) return refuse('program')
  if (call.fleetChild) return refuse('fleet-child')
  if (prompt.kind !== 'action') return refuse('not-action')
  if (prompt.forced === true) return refuse('forced')
  if (prompt.perCallOnly === true) return refuse('per-call-only')
  if (prompt.permission !== undefined) return refuse('permission')
  if (prompt.devTools === true) return refuse('devtools')
  if (prompt.browserOnly === true) return refuse('browser-only')
  if (prompt.urlRisk === true) return refuse('url-risk')
  if (prompt.requester !== undefined) return refuse('external-requester')
  if (prompt.devLoopFor !== undefined) return refuse('dev-loop')
  if (prompt.binding === undefined || prompt.binding === '') return refuse('no-binding')
  if (prompt.action !== call.tool || !REVIEW_TOOLS.has(call.tool)) return refuse('tool')
  const facts = prompt.review
  if (facts?.policy !== 'default') return refuse('policy')
  const tool = call.tool as AutoReviewTool
  const tainted = call.tainted === true
  const found = (slot: 'target' | 'from' | 'to'): Extract<TargetState, { state: 'found' }> | IneligibleReason => {
    const state = facts.targets?.[slot]
    if (state?.state !== 'found') return 'target-not-found'
    if (state.sensitive === true || NEVER_KINDS.has(state.kind)) return 'sensitive-target'
    return state
  }
  let classified: Classified
  switch (tool) {
    case 'browser_navigate': {
      const destination = originOf(call.args.url)
      if (destination === undefined || facts.topOrigin === undefined || destination !== facts.topOrigin) return refuse('cross-origin-navigation')
      // The reviewer is shown origin and path only: a query or fragment is the user's call.
      if (hasQueryOrFragment(call.args.url)) return refuse('navigation-query')
      // After reading web pages, a navigation can carry what was read: always the user's call.
      if (tainted) return refuse('tainted-navigation')
      const path = pathOf(call.args.url as string)
      classified = {
        commitClass: classOfWords(pathWords(path)) ?? 'none',
        formSubmitLikely: false,
        highRiskWords: highRisk(pathWords(path)) || (path !== undefined && HIGH_RISK_PATHS.test(path)),
        sameOrigin: true,
        destination: `${destination}${path ?? ''}`,
      }
      break
    }
    case 'browser_click':
    case 'browser_hover': {
      const target = found('target')
      if (typeof target === 'string') return refuse(target)
      classified = tool === 'browser_hover'
        ? { commitClass: 'none', formSubmitLikely: false, highRiskWords: false }
        : classifyClick(target, facts.topOrigin, tainted)
      break
    }
    case 'browser_type': {
      const target = found('target')
      if (typeof target === 'string') return refuse(target)
      // Undefined means "not inspected", which counts as sensitive.
      if (facts.typedTargetSensitive !== false) return refuse('sensitive-target')
      // A line break typed key by key can press Enter and submit the form, a tab
      // can move focus onto a button that a typed space then presses: the user decides.
      // eslint-disable-next-line no-control-regex
      if (typeof call.args.text === 'string' && /[\u0000-\u001F\u007F]/u.test(call.args.text)) return refuse('typed-line-break')
      classified = classifyTyping(target, tainted)
      break
    }
    case 'browser_press': {
      const target = found('target')
      if (typeof target === 'string') return refuse(target)
      classified = classifyPress(target, call.args, facts.topOrigin, tainted)
      break
    }
    case 'browser_select': {
      const target = found('target')
      if (typeof target === 'string') return refuse(target)
      // Only a native select whose chosen options the page itself named.
      if (target.chosen === undefined || target.chosen.length === 0) return refuse('select-unresolved')
      // A select whose page code submits on change: its form must stay on this origin.
      if (target.autoSubmit === true && target.form !== undefined && ('other' in target.form || facts.topOrigin === undefined || target.form.origin !== facts.topOrigin)) return refuse('form-destination')
      const chosen = target.chosen.join(' · ')
      const cls = classOfWords(target.name, chosen) ?? (SHARE_OPTIONS.test(chosen) ? 'share' : target.autoSubmit === true ? 'submit' : 'none')
      classified = { commitClass: cls, formSubmitLikely: target.autoSubmit === true, highRiskWords: highRisk(target.name, target.context?.text, chosen) }
      break
    }
    case 'browser_drag': {
      const from = found('from')
      if (typeof from === 'string') return refuse(from)
      const dropsOnElement = !(typeof call.args.toOffset === 'object' && call.args.toOffset !== null)
      const to = dropsOnElement ? found('to') : undefined
      if (typeof to === 'string') return refuse(to)
      classified = {
        commitClass: classOfWords(to?.name, from.name) ?? 'none',
        formSubmitLikely: false,
        highRiskWords: highRisk(from.name, to?.name, to?.context?.text),
      }
      break
    }
  }
  if ('reason' in classified) return refuse(classified.reason)
  return { eligible: true, tool, assessment: classified }
}

const TARGET_CLASS_OF: ReadonlyArray<readonly [ReviewAction['targetClass'], ReadonlySet<TargetKind>]> = [
  ['button', new Set(['button', 'menuitem', 'tab', 'summary'])],
  ['field', TEXT_KINDS],
  ['control', new Set(['checkbox', 'radio', 'switch', 'slider', 'select', 'listbox', 'color', 'option', 'file'])],
]

/** How the element presents itself, from its kind (never from page prose). */
export function targetClass(state: TargetState | undefined): ReviewAction['targetClass'] {
  if (state?.state !== 'found') return 'none'
  if (state.kind === 'link' || state.href !== undefined) return 'link'
  for (const [cls, kinds] of TARGET_CLASS_OF) if (kinds.has(state.kind)) return cls
  return 'other'
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
export function buildReviewAction(prompt: ApprovalPrompt, tool: AutoReviewTool, args: Record<string, unknown>, extras: ReviewExtras, assessment: Assessment): ReviewAction {
  const facts = prompt.review
  const target = facts?.targets?.target ?? facts?.targets?.from
  const found = target?.state === 'found' ? target : undefined
  const to = facts?.targets?.to?.state === 'found' ? facts.targets.to : undefined
  const typed = tool === 'browser_type' && facts?.typedTargetSensitive === false ? untrustedText(args.text) : undefined
  const options = tool === 'browser_select' ? (found?.chosen ?? []).map(untrustedText).filter((value): value is string => value !== undefined).slice(0, 5) : []
  const recent = extras.recent.slice(-MAX_REVIEW_RECENT).map(untrustedText).filter((value): value is string => value !== undefined)
  const press = tool === 'browser_press' ? parseKeyPress(args) : undefined
  const put = <K extends keyof ReviewAction['untrusted']>(key: K, value: string | undefined): Partial<ReviewAction['untrusted']> => {
    const text = untrustedText(value)
    return text === undefined ? {} : { [key]: text }
  }
  const untrusted: ReviewAction['untrusted'] = {
    ...put('name', found?.name),
    ...put('context', found?.context?.text),
    ...put('title', extras.title),
    ...put('url', originAndPath(facts?.pageUrl)),
    ...put('destination', assessment.destination),
    ...put('dropTarget', tool === 'browser_drag' ? to?.name : undefined),
    ...typed === undefined ? {} : { typed },
    ...options.length === 0 ? {} : { options },
    ...recent.length === 0 ? {} : { recent },
  }
  const repeat = tool === 'browser_press' && typeof args.repeat === 'number' && Number.isSafeInteger(args.repeat) && args.repeat >= 1 && args.repeat <= 100 ? args.repeat : undefined
  return {
    tool,
    verb: verbOf(tool, args),
    targetKind: found?.kind ?? 'none',
    targetClass: targetClass(found),
    commitClass: assessment.commitClass,
    formSubmitLikely: assessment.formSubmitLikely,
    highRiskWords: assessment.highRiskWords,
    ...assessment.sameOrigin === undefined ? {} : { sameOrigin: assessment.sameOrigin },
    tainted: extras.tainted,
    approvedThisTurn: Math.max(0, Math.min(10_000, Math.floor(extras.approvedThisTurn))),
    ...tool === 'browser_type' && typeof args.text === 'string' ? { typedChars: args.text.length } : {},
    ...press === undefined ? {} : { key: press.key.slice(0, 40), ...press.modifiers.length === 0 ? {} : { modifiers: press.modifiers }, ...repeat === undefined ? {} : { repeat } },
    untrusted,
  }
}
