/**
 * Auto review's deterministic rules (docs/auto-review-design.md §5, §8, §9).
 *
 * Decided by the extension BEFORE any model is asked, and never widened by
 * the reviewer's answer: which approval cards a reviewer may decide at all,
 * and by which rule. The promise to the user is short: Auto approves an
 * action only when **you named it, or it is plainly harmless**.
 *
 * - `harmless` (this file decides): a real same-site link, a control that
 *   only shows or hides part of the page and is called so ("Show more"),
 *   hover, and moving around inside a text field with navigation keys.
 * - `named` (the bridge checks against the user's newest panel message):
 *   everything else that is eligible. The action carries the exact phrases
 *   the message must contain — the control's full name, every chosen option,
 *   both ends of a drag — or the exact text to be typed.
 * - Anything else is never Auto: the card waits for the user.
 *
 * The rules decide what CAN be approved; the conversation's model then
 * decides whether it SHOULD be. Pure functions only, so every rule is
 * unit-tested.
 *
 * @module
 */

import {
  AUTO_REVIEW_TOOLS,
  MAX_REVIEW_EXACT_TEXT_CHARS,
  MAX_REVIEW_RECENT,
  MAX_REVIEW_UNTRUSTED_CHARS,
  type AutoReviewRule,
  type AutoReviewTool,
  type CommitClass,
  type ReviewAction,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { ApprovalPrompt } from './approval.ts'
import { MAX_TARGET_NAME_CHARS, pageTextForCard, type TargetDestination, type TargetKind, type TargetState } from '../shared/target-description.ts'

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
  | 'navigation-words'
  | 'tainted-navigation'
  | 'typed-line-break'
  | 'typed-length'
  | 'field-not-empty'
  | 'link-destination'
  | 'form-destination'
  | 'data-in-path'
  | 'press-key'
  | 'select-unresolved'
  | 'download'
  | 'unnamed'
  | 'drag-offset'

/** What the extension concluded about an eligible action. */
export interface Assessment {
  /** Which rule makes it auto-approvable (see {@link AutoReviewRule}). */
  rule: AutoReviewRule
  /** For `named`: the phrases the newest panel message must contain verbatim. */
  mustName?: string[]
  /** For `named` typing: the full text, which the message must contain verbatim. */
  exactText?: string
  /** For `named` typing into a recipient/address/link/amount field: a whole-token match. */
  exactToken?: boolean
  /** What it would commit, for the reviewer's prompt and the card's sentence. */
  commitClass: CommitClass
  /** Native structure: a submit control, or a select whose page acts on change. */
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
  /** The call's arguments (for navigation's destination, the typed text and the key of a press). */
  args: Record<string, unknown>
}

const REVIEW_TOOLS: ReadonlySet<string> = new Set(AUTO_REVIEW_TOOLS)

/** Kinds a reviewer never decides for, whatever the page says about sensitivity. */
const NEVER_KINDS: ReadonlySet<TargetKind> = new Set(['password', 'file'])

/** Kinds a person types into. */
const TEXT_KINDS: ReadonlySet<TargetKind> = new Set([
  'textbox', 'searchbox', 'spinbutton', 'textarea', 'email', 'tel', 'url', 'number', 'date', 'editable', 'combobox',
])
/**
 * Where navigation keys only move the caret, focus or scroll: free-text
 * fields, links and buttons. On a select, radio group, slider, spin button,
 * date or combobox an arrow key changes the value, so it is never Auto.
 */
const NAVIGATION_TARGETS: ReadonlySet<TargetKind> = new Set(['textbox', 'searchbox', 'textarea', 'editable', 'email', 'url', 'tel', 'link', 'button'])
/** Text fields where a repeated navigation key is still only caret movement. */
const CARET_FIELDS: ReadonlySet<TargetKind> = new Set(['textbox', 'searchbox', 'textarea', 'editable', 'email', 'url', 'tel'])
/** Most repeats of a navigation key Auto may approve (in a text field only). */
const MAX_NAVIGATION_REPEAT = 10

/**
 * Commit classes by the words of a name or a path, EN and ZH, matched on
 * stems. Checked in order; the first match wins. They only label the action
 * for the reviewer and the card's sentence, and turn a same-site link into a
 * `named` action; they never make anything approvable.
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

/** Fields where typed text decides who or what receives something: recipients, addresses, links, amounts. */
const ADDRESS_FIELD = /\b(?:to|cc|bcc|recipients?|e-?mail|address|url|link|website|amount|quantity|qty|price|share\s+with|invite|phone)\b|收件人|抄送|密送|邮箱|地址|网址|链接|金额|数量|价格|分享给|邀请/iu
const ADDRESS_KINDS: ReadonlySet<TargetKind> = new Set(['email', 'url', 'tel', 'number', 'spinbutton'])

/**
 * The words a harmless disclosure's name may consist of: a few verbs that
 * only show or hide, and the UI nouns they act on. Only for elements that are
 * disclosures by their own markup (aria-expanded, `<summary>`, a popup
 * button), and only when EVERY word of the name is listed ("Show more",
 * "Show 12 replies", "Details"). Deliberately short: "toggle", "open",
 * "read", "hide", "go", "dismiss", "answer", "up" and "down" are not here,
 * because a page can attach anything to them. "Close", "cancel" and "next"
 * are kept and documented as residues: on a disclosure they rarely do more
 * than close or page, but the page decides.
 */
const HARMLESS_WORDS = new Set([
  'show', 'more', 'less', 'expand', 'collapse', 'next', 'previous', 'prev', 'back', 'menu', 'details', 'close', 'cancel',
  'all', 'comments', 'replies', 'results', 'items', 'options', 'info', 'page', 'pages', 'section', 'thread',
  'the', 'a', 'an', 'of',
])
const HARMLESS_ZH = /^(?:显示|展开|收起|更多|下一页|上一页|返回|菜单|详情|关闭|取消)(?:更多|详情|菜单|全部|评论|回复|内容|结果)?$/u

/** Keys that only move focus, the caret, or scroll (on the kinds in {@link NAVIGATION_TARGETS}). */
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

/** Whether a disclosure's own name says it only shows or hides (every word in the short list). */
export function harmlessDisclosureName(name: string): boolean {
  const trimmed = name.trim()
  if (HARMLESS_ZH.test(trimmed)) return true
  const words = trimmed.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  return words.length > 0 && words.every((word) => HARMLESS_WORDS.has(word) || /^\d+$/u.test(word))
    && words.some((word) => !/^\d+$/u.test(word) && !['the', 'a', 'an', 'of'].includes(word))
}

/**
 * Whether a name can be required verbatim: at least 3 letters or digits (2
 * for Chinese), as the bridge's check requires, and not cut short when it was
 * read (a cut name would let a message naming only its start through). A
 * control that cannot be named ("OK", an icon) is never Auto: its card simply
 * waits, without a model call.
 */
function nameable(name: string): boolean {
  const count = name.match(/[\p{L}\p{N}]/gu)?.length ?? 0
  if (count < (/\p{Script=Han}/u.test(name) ? 2 : 3)) return false
  return !([...name].length >= MAX_TARGET_NAME_CHARS && name.endsWith('…'))
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

/** A `named` assessment that requires the given phrases. */
function named(mustName: string[], rest: Omit<Assessment, 'rule' | 'mustName'>): Classified {
  if (mustName.length === 0 || !mustName.every(nameable)) return no('unnamed')
  return { rule: 'named', mustName, ...rest }
}

/** A click (or Space/Enter on a focused control) on one found element. */
function classifyClick(target: Extract<TargetState, { state: 'found' }>, topOrigin: string | undefined, tainted: boolean): Classified {
  const name = target.name
  const context = target.context?.text
  // A download writes a file to the user's disk: never Auto.
  if (target.download === true) return no('download')
  // A real link (describe drops empty, fragment-only, javascript: and same-document ones): where it goes decides.
  if (target.href !== undefined) {
    const href = target.href
    if ('other' in href || topOrigin === undefined || href.origin !== topOrigin || href.query) return no('link-destination')
    if (tainted && pathCarriesData(href.path)) return no('data-in-path')
    if (!nameable(name)) return no('unnamed')
    // The path, not the name, says what a GET does ("/logout", "/items/7/delete").
    const cls = classOfWords(pathWords(href.path))
    const facts = {
      commitClass: cls ?? 'none' as CommitClass,
      formSubmitLikely: false,
      highRiskWords: highRisk(name, context, href.path) || HIGH_RISK_PATHS.test(href.path),
      sameOrigin: true,
      destination: destinationText(href),
    }
    // A link whose path says it commits something needs the user's words.
    return cls === undefined ? { rule: 'harmless', ...facts } : named([name], facts)
  }
  // A submit control: where its form goes decides too, and it is at least a submission.
  if (target.submits === true) {
    const form = target.form
    if (form === undefined || 'other' in form || topOrigin === undefined || form.origin !== topOrigin) return no('form-destination')
    return named([name], {
      commitClass: classOfWords(name, pathWords(form.path)) ?? 'submit',
      formSubmitLikely: true,
      highRiskWords: highRisk(name, context, form.path) || HIGH_RISK_PATHS.test(form.path),
      sameOrigin: true,
      destination: destinationText(form),
    })
  }
  const cls = classOfWords(name)
  // A disclosure called "Show more" only shows more; anything else it might do is the page's residue.
  if (target.disclosure === true && nameable(name) && harmlessDisclosureName(name)) {
    return { rule: 'harmless', commitClass: 'none', formSubmitLikely: false, highRiskWords: highRisk(name, context) }
  }
  // Every other control — button, menu item, option, tree item, checkbox,
  // radio, switch, tab, summary, a link without a real destination, an
  // unknown element — needs its full name in the user's message.
  return named([name], { commitClass: cls ?? 'unknown', formSubmitLikely: false, highRiskWords: highRisk(name, context) })
}

/** The key of a press and its modifiers, from `key` (a chord) and `modifiers`. */
export function parseKeyPress(args: Record<string, unknown>): { key: string; modifiers: string[] } | undefined {
  const raw = args.key
  if (typeof raw !== 'string' || raw === '') return undefined
  let key = raw
  let listed: unknown[] = []
  if (raw.length > 1 && raw.includes('+')) {
    const parts = raw.split('+')
    if (raw.endsWith('++')) {
      key = '+'
      listed = parts.slice(0, -2)
    } else {
      key = parts.at(-1)!
      listed = parts.slice(0, -1)
    }
    if (key === '') return undefined
  }
  listed = [...listed, ...Array.isArray(args.modifiers) ? args.modifiers : []]
  const modifiers: string[] = []
  for (const name of listed) {
    if (typeof name !== 'string') return undefined
    const canonical = MODIFIER_NAMES[name.trim().toLowerCase()]
    if (canonical === undefined) return undefined
    if (!modifiers.includes(canonical)) modifiers.push(canonical)
  }
  return { key, modifiers }
}

/** The repeat count of a press (1 when absent); undefined when malformed. */
function repeatOf(args: Record<string, unknown>): number | undefined {
  if (args.repeat === undefined) return 1
  return typeof args.repeat === 'number' && Number.isSafeInteger(args.repeat) && args.repeat >= 1 ? args.repeat : undefined
}

/** A key press on the focused (or addressed) element. */
function classifyPress(target: Extract<TargetState, { state: 'found' }>, args: Record<string, unknown>, topOrigin: string | undefined, tainted: boolean): Classified {
  if (args.action !== undefined && args.action !== 'press') return no('press-key')
  const press = parseKeyPress(args)
  const repeat = repeatOf(args)
  if (press === undefined || repeat === undefined) return no('press-key')
  // Control, Alt and Meta make app shortcuts with unknown effects.
  if (press.modifiers.some((modifier) => modifier !== 'Shift')) return no('press-key')
  const { key } = press
  if (NAVIGATION_KEYS.has(key)) {
    // On a select, radio, slider or spin button an arrow changes the value.
    if (!NAVIGATION_TARGETS.has(target.kind)) return no('press-key')
    if (repeat > 1 && (!CARET_FIELDS.has(target.kind) || repeat > MAX_NAVIGATION_REPEAT)) return no('press-key')
    return { rule: 'harmless', commitClass: 'none', formSubmitLikely: false, highRiskWords: false }
  }
  const field = TEXT_KINDS.has(target.kind)
  // Space or Enter on a button, link or control is a click on it, once.
  if ((ENTER_KEYS.has(key) || SPACE_KEYS.has(key)) && !field && press.modifiers.length === 0 && repeat === 1) {
    return classifyClick(target, topOrigin, tainted)
  }
  // Enter in a field submits or sends; a character key is typing one
  // character, which can never be named (three characters at least): the
  // user decides both.
  return no('press-key')
}

/** Typing into a found text field. */
function classifyTyping(target: Extract<TargetState, { state: 'found' }>, args: Record<string, unknown>, tainted: boolean): Classified {
  const text = args.text
  if (typeof text !== 'string') return no('typed-length')
  // A line break typed key by key can press Enter and submit the form, a tab
  // can move focus onto a button that a typed space then presses.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/u.test(text)) return no('typed-line-break')
  if (text.length > MAX_REVIEW_EXACT_TEXT_CHARS || (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 3) return no('typed-length')
  // Appending to what is there could finish a sentence the page or an earlier step began.
  if (args.replace !== true && target.empty !== true) return no('field-not-empty')
  const address = ADDRESS_KINDS.has(target.kind) || ADDRESS_FIELD.test(target.name)
  return {
    rule: 'named',
    exactText: text,
    ...address ? { exactToken: true } : {},
    commitClass: address ? 'address' : tainted ? 'type' : 'none',
    formSubmitLikely: false,
    highRiskWords: highRisk(target.name, target.context?.text),
  }
}

/**
 * The deterministic rules: whether Auto review may decide this card, and by
 * which rule.
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
      // A typed address names no control: one whose path says it commits something is the user's call.
      if (classOfWords(pathWords(path)) !== undefined) return refuse('navigation-words')
      classified = {
        rule: 'harmless',
        commitClass: 'none',
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
        ? { rule: 'harmless', commitClass: 'none', formSubmitLikely: false, highRiskWords: false }
        : classifyClick(target, facts.topOrigin, tainted)
      break
    }
    case 'browser_type': {
      const target = found('target')
      if (typeof target === 'string') return refuse(target)
      // Undefined means "not inspected", which counts as sensitive.
      if (facts.typedTargetSensitive !== false) return refuse('sensitive-target')
      classified = classifyTyping(target, call.args, tainted)
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
      // Every chosen option, verbatim.
      classified = named([...target.chosen], {
        commitClass: classOfWords(target.name, chosen) ?? (target.autoSubmit === true ? 'submit' : 'none'),
        formSubmitLikely: target.autoSubmit === true,
        highRiskWords: highRisk(target.name, target.context?.text, chosen),
      })
      break
    }
    case 'browser_drag': {
      const from = found('from')
      if (typeof from === 'string') return refuse(from)
      // A drag by offset (a slider, a canvas) moves a value nobody named.
      if (typeof call.args.toOffset === 'object' && call.args.toOffset !== null) return refuse('drag-offset')
      const to = found('to')
      if (typeof to === 'string') return refuse(to)
      if (from.kind === 'slider' || to.kind === 'slider') return refuse('drag-offset')
      // Both ends, verbatim.
      classified = named([from.name, to.name], {
        commitClass: classOfWords(to.name, from.name) ?? 'unknown',
        formSubmitLikely: false,
        highRiskWords: highRisk(from.name, to.name, to.context?.text),
      })
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
    rule: assessment.rule,
    // The phrases and text the bridge checks verbatim: exactly as the page reported them, uncut.
    ...assessment.rule === 'named' && assessment.mustName !== undefined ? { mustName: [...assessment.mustName] } : {},
    ...assessment.rule === 'named' && assessment.exactText !== undefined ? { exactText: assessment.exactText } : {},
    ...assessment.rule === 'named' && assessment.exactToken === true ? { exactToken: true } : {},
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
