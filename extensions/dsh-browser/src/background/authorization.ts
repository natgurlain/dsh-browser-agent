/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import { frameDocumentKey, type TabFrame } from './frames.ts'
import type { ApprovalAuthorization, ApprovalDecision, ApprovalDetail, ApprovalPrompt } from '../security/approval.ts'
import { approvalBinding } from '../security/payload-binding.ts'
import { analyzeUrl } from '../security/url-risk.ts'
import type { DevToolsGrantKind } from './devtools-grants.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

const PAGE_READS = new Set(['browser_snapshot', 'browser_get_text'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_select',
  'browser_type',
  'browser_press',
  'browser_clipboard',
  'browser_upload',
  'browser_navigate',
  'browser_open_tab',
  'browser_back',
  'browser_forward',
  'browser_reload',
])

/**
 * The developer-tools group. These calls drive the page through the debugger
 * (CDP) instead of the content script, so they never consult the ordinary
 * origin allowlist: only the explicit developer-tools setting, a session grant
 * the user made in this browser, or a fresh per-call approval can pass.
 */
export const DEVTOOLS_TOOLS = new Set([
  'browser_devtools_elements',
  'browser_devtools_set_element_style',
  'browser_devtools_set_element_attribute',
  'browser_console_eval',
  'browser_console_logs',
  'browser_devtools_network',
  'browser_devtools_list_requests',
  'browser_devtools_get_request',
  'browser_devtools_request_body',
])

/** Model-settable switches that turn off devtools redaction; each needs its own approval. */
const SENSITIVE_OPT_OUTS = ['includeSensitiveHeaders', 'includeSensitiveBody'] as const

/** Whether a tool belongs to the developer-tools group. */
export function isDevToolsTool(name: string): boolean {
  return DEVTOOLS_TOOLS.has(name)
}

/**
 * The approval prompt for one developer-tools call.
 *
 * Every devtools call requires its own consent or an explicit developer-tools
 * setting/session grant. Origin trust and unrestricted access never cover it.
 * Console evaluation carries its full source, and redaction opt-outs are named
 * and marked per-call so no grant can cover them.
 * @param call - the tool call awaiting a decision.
 * @param frames - the controlled tab's frames, for the origin list.
 * @param locale - UI locale for the summary text.
 * @returns the prompt handed to the side panel.
 */
export function devToolsApprovalForCall(
  call: ToolCall,
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt {
  const destructive = call.name === 'browser_devtools_set_element_style'
    || call.name === 'browser_devtools_set_element_attribute'
    || call.name === 'browser_console_eval'
  const frameId = requestedFrame(call.args)
  const top = frames.filter((frame) => frame.frameId === 0)
  const target = frames.find((frame) => frame.frameId === frameId)
  const origins = uniqueOrigins(target === undefined ? top : [...top, target], frames)
  const grantOrigin = target === undefined ? undefined : effectiveFrameOrigin(target, frames)
  const optOuts = SENSITIVE_OPT_OUTS.filter((name) => call.args[name] === true)
  const details: ApprovalDetail[] = []
  if (call.name === 'browser_console_eval') {
    details.push({ kind: 'code', value: typeof call.args.expression === 'string' ? call.args.expression : '' })
  }
  if (optOuts.length > 0) details.push({ kind: 'flags', values: [...optOuts] })
  return {
    kind: destructive ? 'action' : 'read',
    action: call.name,
    summary: summarizeDevToolsAction(call, locale, optOuts),
    origins,
    // Session trust for devtools is granted through the dedicated prompt path,
    // never as a blanket "trust this origin for every browser action".
    canTrust: false,
    devTools: true,
    ...details.length === 0 ? {} : { details },
    ...grantOrigin === undefined ? {} : { grantOrigin },
    ...optOuts.length === 0 ? {} : { perCallOnly: true as const },
    binding: approvalBinding({
      action: call.name,
      args: call.args,
      origins,
      frameId,
      ...target === undefined ? {} : { documentKey: frameDocumentKey(target) },
    }),
  }
}

/**
 * Which session grant could satisfy a devtools prompt, if any.
 * Redaction opt-outs and prompts without a known origin have none.
 */
export function devToolsGrantKind(prompt: ApprovalPrompt): DevToolsGrantKind | undefined {
  if (prompt.devTools !== true || prompt.perCallOnly === true || prompt.grantOrigin === undefined) return undefined
  return prompt.action === 'browser_console_eval' ? 'eval' : 'devtools'
}

/**
 * Turn a panel decision on a devtools card into an authorization plus at most
 * one grant. A trust decision that does not match the card's grant kind (for
 * example a forged "trust session" on a redaction opt-out) approves only this
 * call and grants nothing.
 */
export function devToolsDecisionOutcome(
  prompt: ApprovalPrompt,
  decision: ApprovalDecision,
): { authorization: 'approved' | 'denied'; grant?: DevToolsGrantKind } {
  if (decision === 'deny' || decision === 'always-allow-reads') return { authorization: 'denied' }
  const kind = devToolsGrantKind(prompt)
  if (decision === 'trust-session' && kind === 'devtools') return { authorization: 'approved', grant: 'devtools' }
  if (decision === 'trust-eval-session' && kind === 'eval') return { authorization: 'approved', grant: 'eval' }
  return { authorization: 'approved' }
}

function summarizeDevToolsAction(call: ToolCall, locale: UiLocale, optOuts: readonly string[]): string {
  const detail = inlineArg(call)
  const index = safeInline(String(call.args.index ?? '?'))
  const unredacted = optOuts.length === 0
    ? ''
    : localized(locale, ` — UNREDACTED: ${optOuts.join(', ')}`, ` —— 不脱敏：${optOuts.join('、')}`)
  switch (call.name) {
    case 'browser_devtools_elements':
      return localized(locale, `Inspect page element (${detail})`, `查看页面元素（${detail}）`)
    case 'browser_devtools_set_element_style':
      return localized(locale, `Modify live CSS on page element (${detail})`, `修改页面元素 CSS（${detail}）`)
    case 'browser_devtools_set_element_attribute': {
      // Name and full value: an on* handler or javascript: URL is effectively code.
      const name = JSON.stringify(typeof call.args.name === 'string' ? call.args.name : '')
      const change = call.args.remove === true
        ? localized(locale, `remove ${name}`, `删除 ${name}`)
        : typeof call.args.value === 'string'
          ? `${name} = ${JSON.stringify(call.args.value)}`
          : localized(locale, `read ${name}`, `读取 ${name}`)
      return localized(locale, `Change page element attribute (${detail}): ${change}`, `修改页面元素属性（${detail}）：${change}`)
    }
    case 'browser_console_eval': {
      const length = typeof call.args.expression === 'string' ? call.args.expression.length : 0
      const frame = typeof call.args.frame === 'number' && call.args.frame !== 0 ? call.args.frame : undefined
      return localized(
        locale,
        `Run JavaScript in the page (${length} characters${frame === undefined ? '' : `, frame ${frame}`}; full source below)`,
        `在页面中执行 JavaScript（${length} 个字符${frame === undefined ? '' : `，iframe ${frame}`}；完整代码见下方）`,
      )
    }
    case 'browser_console_logs':
      return localized(locale, 'Read the page console output', '读取页面控制台输出')
    case 'browser_devtools_network':
      return localized(locale, `Control network capture (${safeInline(typeof call.args.action === 'string' ? call.args.action : 'status')})`, `控制网络抓包（${safeInline(typeof call.args.action === 'string' ? call.args.action : 'status')}）`)
    case 'browser_devtools_list_requests':
      return localized(locale, 'List captured network requests', '列出已捕获的网络请求')
    case 'browser_devtools_get_request':
      return localized(locale, `Read one captured request in full, including headers (index ${index})${unredacted}`, `查看单条网络请求的完整内容，含请求头（序号 ${index}）${unredacted}`)
    case 'browser_devtools_request_body':
      return localized(locale, `Read a captured request or response body (index ${index})${unredacted}`, `读取已捕获的请求或响应正文（序号 ${index}）${unredacted}`)
    default:
      return `${call.name}${unredacted}`
  }
}

/** A short, non-secret hint about which element a call targets. */
function inlineArg(call: ToolCall): string {
  if (typeof call.args.selector === 'string' && call.args.selector !== '') return safeInline(call.args.selector, 160)
  if (typeof call.args.index === 'number') {
    const frame = typeof call.args.frame === 'number' && call.args.frame !== 0 ? `, frame ${call.args.frame}` : ''
    return `snapshot index ${call.args.index}${frame}`
  }
  return 'no selector given'
}

/** Facts about the call's target that the background learned before prompting. */
export interface ApprovalContext {
  /**
   * For browser_type: whether the content script judged the target field
   * sensitive. `undefined` (not inspected) masks, failing closed.
   */
  typedTargetSensitive?: boolean
}

/**
 * Whether a browser_wait call inspects the page (text, selector, network or
 * URL conditions). Such a wait answers "is this on the page", so it is a page
 * read; a bare settle/delay wait is not.
 */
export function isConditionalPageWait(args: Record<string, unknown>): boolean {
  return (typeof args.text === 'string' && args.text !== '')
    || (typeof args.selector === 'string' && args.selector !== '')
    || (typeof args.urlMatches === 'string' && args.urlMatches !== '')
    || args.networkIdle === true
}

/** browser_extract clicks a "next" control between pages, which changes page state. */
function extractPaginates(call: ToolCall): boolean {
  return call.name === 'browser_extract' && call.args.paginate !== undefined
}

/** Reads of page content: prompt under "ask", blocked under "off". */
function isPageRead(call: ToolCall): boolean {
  return PAGE_READS.has(call.name)
    || (call.name === 'browser_extract' && !extractPaginates(call))
    || (call.name === 'browser_wait' && isConditionalPageWait(call.args))
}

/** The verbatim call arguments, shown on the card for tools whose payload decides what happens. */
function payloadDetail(call: ToolCall): ApprovalDetail {
  return { kind: 'payload', value: JSON.stringify(call.args, null, 2) }
}

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
  context: ApprovalContext = {},
): ApprovalPrompt | undefined {
  const prompt = unboundPromptForCall(call, sharePageContent, frames, locale, context)
  if (prompt === undefined) return undefined
  // Reads are bound to the call and origins; actions also to the target document.
  const target = prompt.kind === 'action' && call.name !== 'browser_open_tab'
    ? frames.find((frame) => frame.frameId === requestedFrame(call.args))
    : undefined
  return {
    ...prompt,
    binding: approvalBinding({
      action: call.name,
      args: call.args,
      origins: prompt.origins,
      ...target === undefined ? {} : { frameId: target.frameId, documentKey: frameDocumentKey(target) },
    }),
  }
}

function unboundPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale,
  context: ApprovalContext,
): ApprovalPrompt | undefined {
  // A screenshot photographs exactly what the user sees — passwords, private
  // messages, account balances included — so it always prompts, regardless of
  // the page-content sharing preference. Only unrestricted access skips it.
  if (call.name === 'browser_screenshot') {
    return {
      kind: 'read',
      action: call.name,
      summary: localized(locale, 'Capture a screenshot of the current page (may contain sensitive content)', '截取当前页面的可视区域截图（可能包含敏感信息）'),
      origins: uniqueOrigins(frames, frames),
      canTrust: false,
    }
  }
  if (isPageRead(call)) {
    if (sharePageContent !== 'ask') return undefined
    const targetFrames = call.name === 'browser_snapshot'
      ? frames
      : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
    return {
      kind: 'read',
      action: call.name,
      summary: summarizeRead(call, locale),
      origins: uniqueOrigins(targetFrames, frames),
      canTrust: false,
      ...call.name === 'browser_extract' || call.name === 'browser_wait' ? { details: [payloadDetail(call)] } : {},
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name) && !extractPaginates(call)) return undefined
  const details = actionDetails(call, context)
  const url = call.name === 'browser_navigate' || call.name === 'browser_open_tab'
    ? analyzeUrl(typeof call.args.url === 'string' ? call.args.url : '')
    : undefined
  const extras: Partial<ApprovalPrompt> = {
    ...details.length === 0 ? {} : { details },
    ...url?.risky === true ? { urlRisk: true as const } : {},
  }
  if (call.name === 'browser_open_tab') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    return {
      kind: 'action',
      action: call.name,
      summary: summarizeAction(call, locale, context),
      // A new tab does not mutate the current page; only the destination matters.
      origins: destination === undefined ? [] : [destination],
      canTrust: destination !== undefined,
      ...extras,
    }
  }
  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
  let canTrust = origins.length === 1 && call.name !== 'browser_back' && call.name !== 'browser_forward'
  // Clipboard writes affect the user's system clipboard and uploads hand local
  // files to a page; neither is an origin-scoped permission.
  if (call.name === 'browser_clipboard' || call.name === 'browser_upload') canTrust = false
  if (call.name === 'browser_navigate') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    if (destination !== undefined && !origins.includes(destination)) origins.push(destination)
    // Do not let an invalid, opaque, or cross-origin navigation become a
    // back door for adding the current page to the persistent allowlist.
    canTrust = destination !== undefined && origins.length === 1 && origins[0] === destination
  }
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call, locale, context),
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust,
    ...extras,
  }
}

/** The payload a state-changing call would carry out, for verbatim display. */
function actionDetails(call: ToolCall, context: ApprovalContext): ApprovalDetail[] {
  switch (call.name) {
    case 'browser_type':
      return [{
        kind: 'text',
        value: typeof call.args.text === 'string' ? call.args.text : '',
        masked: context.typedTargetSensitive !== false,
      }]
    case 'browser_upload':
      return [{ kind: 'paths', values: Array.isArray(call.args.paths) ? call.args.paths.map((path) => String(path)) : [] }]
    case 'browser_select':
    case 'browser_extract':
      return [payloadDetail(call)]
    case 'browser_navigate':
    case 'browser_open_tab': {
      const url = analyzeUrl(typeof call.args.url === 'string' ? call.args.url : '')
      return url === undefined ? [] : [{ kind: 'url', url }]
    }
    default:
      return []
  }
}

function requestedFrame(args: Record<string, unknown>): number {
  return typeof args.frame === 'number' && Number.isInteger(args.frame) && args.frame >= 0 ? args.frame : 0
}

function uniqueOrigins(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const origins = new Set<string>()
  for (const frame of targets) {
    const origin = effectiveFrameOrigin(frame, allFrames)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins].sort()
}

function effectiveFrameOrigin(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  const direct = originFromUrl(frame.url)
  if (direct !== undefined) return direct
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameOrigin(parent, frames, visited)
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

function elementTarget(call: ToolCall, locale: UiLocale): string {
  if (typeof call.args.selector === 'string' && call.args.selector !== '') {
    const selector = safeInline(call.args.selector, 160)
    return localized(locale, `selected element (${selector})`, `选择器元素（${selector}）`)
  }
  if (typeof call.args.index === 'number') return localized(locale, `element [${call.args.index}]`, `元素 [${call.args.index}]`)
  return localized(locale, 'the focused element', '当前焦点元素')
}

function summarizeAction(call: ToolCall, locale: UiLocale, context: ApprovalContext): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  switch (call.name) {
    case 'browser_click': {
      const index = typeof call.args.index === 'number' ? call.args.index : '?'
      const target = typeof call.args.selector === 'string'
        ? `selected element (${safeInline(call.args.selector, 160)})`
        : `element [${index}]`
      const targetZh = typeof call.args.selector === 'string'
        ? `选择器元素（${safeInline(call.args.selector, 160)}）`
        : `元素 [${index}]`
      const gesture = typeof call.args.action === 'string' && call.args.action !== 'click' ? ` ${call.args.action}` : ''
      return localized(locale, `${gesture.trim() === '' ? 'Click' : gesture.trim()} ${target}${frame}`, `${gesture === '' ? '点击' : gesture.trim()} ${targetZh}${frame}`)
    }
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      const masked = context.typedTargetSensitive !== false
      return localized(
        locale,
        `Type ${length} characters into ${elementTarget(call, locale)}${frame}${masked ? ' (sensitive field or not inspected: masked)' : ''}`,
        `向${elementTarget(call, locale)}输入 ${length} 个字符${frame}${masked ? '（敏感字段或未能检查：已遮盖）' : ''}`,
      )
    }
    case 'browser_press': return localized(
      locale,
      `Press “${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}”${frame}`,
      `发送按键「${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}」${frame}`,
    )
    case 'browser_navigate': return localized(
      locale,
      `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
      `导航到 ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
    )
    case 'browser_open_tab': {
      const destination = displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)
      return call.args.active === false
        ? localized(
          locale,
          `Open a background tab at ${destination}`,
          `在后台新标签页打开 ${destination}`,
        )
        : localized(
          locale,
          `Open a new tab at ${destination}`,
          `在新标签页打开 ${destination}`,
        )
    }
    case 'browser_clipboard': {
      const writing = call.args.action === 'write'
      const html = typeof call.args.html === 'string' && call.args.html !== ''
      return writing
        ? localized(
          locale,
          `Write ${html ? 'text and rich HTML' : 'text'} to the system clipboard`,
          `向系统剪贴板写入${html ? '文本与富文本' : '文本'}`,
        )
        : localized(locale, 'Paste the clipboard into the page', '把剪贴板内容粘贴到页面')
    }
    case 'browser_upload': {
      const count = Array.isArray(call.args.paths) ? call.args.paths.length : 0
      return localized(
        locale,
        `Attach ${count} local file(s) to ${elementTarget(call, locale)}${frame}`,
        `向${elementTarget(call, locale)}附加 ${count} 个本地文件${frame}`,
      )
    }
    case 'browser_select': return localized(
      locale,
      `Select option(s) in ${elementTarget(call, locale)}${frame} (arguments below)`,
      `在${elementTarget(call, locale)}中选择选项${frame}（参数见下方）`,
    )
    case 'browser_extract': {
      const pages = typeof call.args.paginate === 'object' && call.args.paginate !== null
        ? (call.args.paginate as { maxPages?: unknown }).maxPages
        : undefined
      return localized(
        locale,
        `Extract rows across pages, clicking the next-page control up to ${typeof pages === 'number' ? pages : 5} pages${frame} (arguments below)`,
        `跨页提取数据行，最多点击下一页控件 ${typeof pages === 'number' ? pages : 5} 页${frame}（参数见下方）`,
      )
    }
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    default: return call.name
  }
}

function summarizeRead(call: ToolCall, locale: UiLocale): string {
  switch (call.name) {
    case 'browser_snapshot':
      return localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
    case 'browser_extract':
      return localized(locale, 'Extract structured rows from the current page (arguments below)', '从当前页面提取结构化数据行（参数见下方）')
    case 'browser_wait':
      return localized(locale, 'Wait for a condition on the current page (arguments below)', '等待当前页面满足条件（参数见下方）')
    default:
      return localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域')
  }
}

/** The complete serialized URL: query and fragment included, never truncated. */
function displayUrl(value: string, locale: UiLocale): string {
  try {
    return new URL(value).href
  } catch {
    return localized(locale, '(invalid URL)', '(无效 URL)')
  }
}

function localized(locale: UiLocale, english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}

/** Inputs the approval gate evaluates before a prompt is even sent. */
export interface ApprovalGateInput {
  prompt: ApprovalPrompt
  /** Persisted "allow developer tools" setting. */
  devToolsAllowed: boolean
  /**
   * Whether an unexpired session grant of the prompt's own grant kind
   * (`devToolsGrantKind`) covers this agent session and the prompt's origin.
   */
  devToolsSessionGrant: boolean
  /** The user's blanket browser-control switch. */
  unrestrictedAccess: boolean
  /** Result of the persistent + session origin allowlist for ordinary actions. */
  coveredByTrustedOrigins: boolean
}

/**
 * Decide whether an approval prompt can be skipped.
 *
 * Developer tools are their own consent surface: unrestricted access and the
 * persistent origin allowlist deliberately do not cover them, so enabling
 * either can never hand the model the debugger. Within the group, console
 * evaluation is covered only by its own eval grant (never the setting), and
 * redaction opt-outs are never covered at all. Ordinary actions keep the
 * existing shortcut semantics.
 *
 * @param input - the prompt plus the policy state it is evaluated against.
 * @returns the authorization to apply, or `'prompt'` when the user must decide.
 */
export function resolveApprovalGate(input: ApprovalGateInput): ApprovalAuthorization | 'prompt' {
  if (input.prompt.devTools === true) {
    const kind = devToolsGrantKind(input.prompt)
    if (input.prompt.perCallOnly === true) return 'prompt'
    if (input.prompt.action === 'browser_console_eval') {
      return kind === 'eval' && input.devToolsSessionGrant ? 'approved' : 'prompt'
    }
    if (input.devToolsAllowed || (kind === 'devtools' && input.devToolsSessionGrant)) return 'approved'
    return 'prompt'
  }
  if (input.unrestrictedAccess || input.coveredByTrustedOrigins) return 'approved'
  return 'prompt'
}
