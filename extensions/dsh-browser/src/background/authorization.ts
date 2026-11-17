/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import { frameDocumentKey, type TabFrame } from './frames.ts'
import type { ApprovalAuthorization, ApprovalDecision, ApprovalDetail, ApprovalPrompt } from '../security/approval.ts'
import { approvalBinding } from '../security/payload-binding.ts'
import { analyzeUrl } from '../security/url-risk.ts'
import { attributeRisk } from '../security/attribute-risk.ts'
import type { DevToolsGrantKind } from './devtools-grants.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'
import type { CallPolicyTargets, ForceCause } from '../security/call-policy.ts'
import type { TargetKind, TargetState, TargetStates } from '../shared/target-description.ts'

const PAGE_READS = new Set(['browser_snapshot', 'browser_get_text', 'browser_pdf_text'])
/**
 * Reads that always ask (unless unrestricted access is on), whatever the
 * page-sharing preference: they hand over more than the page text — pixels,
 * a document written to the host disk, or the browser's download history.
 */
const ALWAYS_ASK_READS = new Set(['browser_screenshot', 'browser_save_pdf', 'browser_downloads'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_select',
  'browser_hover',
  'browser_drag',
  'browser_dialog',
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
  const perCallOnly = optOuts.length > 0 || scriptAttributeChange(call)
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
    ...perCallOnly ? { perCallOnly: true as const } : {},
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
 * Whether a devtools call writes or removes a script-class attribute (handlers,
 * URLs, form targets, field identity): such changes always need their own card.
 */
function scriptAttributeChange(call: ToolCall): boolean {
  if (call.name !== 'browser_devtools_set_element_attribute') return false
  const value = typeof call.args.value === 'string' ? call.args.value : undefined
  if (call.args.remove !== true && value === undefined) return false
  return attributeRisk(typeof call.args.name === 'string' ? call.args.name : '', value) !== 'normal'
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
  /**
   * For browser_dialog: the dialog the answer would go to. It is shown on the
   * card and folded into the binding, so a different dialog at execution time
   * invalidates the approval.
   */
  dialog?: { type: string; message: string; defaultPrompt?: string }
  /** For browser_downloads: the optional downloads permission is not granted yet. */
  needsDownloadsPermission?: boolean
  /**
   * For a call that targets an element: what the page reported about that
   * element when the card was raised (content/describe.ts, read through
   * shared/target-description.ts). The card names the element from this,
   * never from anything the model wrote. Its kind and name are folded into
   * the binding, so an element that reads differently at execution time
   * invalidates the approval. Absent when the page was not asked at all
   * (callers outside the dispatcher): the card then names the locator only.
   */
  targets?: TargetStates
  /** A re-check found a locator naming another element than the one the card described. */
  targetMoved?: true
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
  const topOrigin = uniqueOrigins(frames.filter((frame) => frame.frameId === 0), frames)[0]
  const pageUrl = target === undefined ? undefined : effectiveFrameUrl(target, frames)
  return {
    ...prompt,
    ...prompt.kind === 'action' && call.name !== 'browser_open_tab'
      ? {
          review: {
            ...context.targets === undefined ? {} : { targets: context.targets },
            ...context.typedTargetSensitive === undefined ? {} : { typedTargetSensitive: context.typedTargetSensitive },
            ...pageUrl === undefined ? {} : { pageUrl },
            ...topOrigin === undefined ? {} : { topOrigin },
          },
        }
      : {},
    binding: approvalBinding({
      action: call.name,
      args: call.name === 'browser_dialog' ? { ...call.args, dialog: context.dialog ?? null } : call.args,
      origins: prompt.origins,
      ...target === undefined ? {} : { frameId: target.frameId, documentKey: frameDocumentKey(target) },
      ...context.targets === undefined || prompt.kind !== 'action' ? {} : { target: boundTargets(context) },
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
  if (ALWAYS_ASK_READS.has(call.name)) {
    return {
      kind: 'read',
      action: call.name,
      summary: summarizeAlwaysAskRead(call, locale) + (call.name === 'browser_downloads' && context.needsDownloadsPermission === true
        ? localized(locale, ' (first use: Allow also asks the browser for permission to read downloads)', '（首次使用：允许后浏览器还会请求读取下载记录的权限）')
        : ''),
      origins: call.name === 'browser_downloads' ? [] : uniqueOrigins(frames, frames),
      canTrust: false,
      ...call.name === 'browser_downloads' && typeof call.args.filenameRegex === 'string'
        ? { details: [{ kind: 'text' as const, value: call.args.filenameRegex, masked: false, label: localized(locale, 'File name pattern', '文件名匹配模式') }] }
        : {},
      ...call.name === 'browser_downloads' && context.needsDownloadsPermission === true ? { permission: 'downloads' as const } : {},
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
  // A paginated extraction also reads the page: under "ask" no action trust
  // may stand in for the read consent it needs.
  if (extractPaginates(call) && sharePageContent !== 'auto') canTrust = false
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
  const targetNote = targetNoteFor(call, locale, context)
  const stepLabel = stepLabelFor(call, locale, context)
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call, locale, context),
    ...targetNote === undefined ? {} : { targetNote },
    ...stepLabel === undefined ? {} : { stepLabel },
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust,
    ...extras,
  }
}

/**
 * The part of the target description an approval covers: per element, whether
 * it was found and its kind and name. The context line is left out on
 * purpose: a row's text can tick over (a counter, a timestamp) without the
 * element being a different one, and such a change must not void a card.
 */
function boundTargets(context: ApprovalContext): unknown {
  // `submits` / `inForm` only when set, so bindings of other elements are
  // unchanged: an element that turns into a submit control after the card
  // (or Auto approve) saw it voids the approval.
  const bound = (state: TargetState | undefined): unknown => state === undefined
    ? undefined
    : state.state === 'found'
      ? {
          state: state.state, kind: state.kind, name: state.name,
          ...state.submits === true ? { submits: true } : {},
          ...state.inForm === true ? { inForm: true } : {},
          // Where a link or a form goes, and what a selection chooses: a page that
          // retargets the element after the card was answered voids the approval.
          ...state.href === undefined ? {} : { href: state.href },
          ...state.form === undefined ? {} : { form: state.form },
          ...state.chosen === undefined ? {} : { chosen: state.chosen },
          // A link that turns into a download after the card (or Auto approve) saw it voids the approval.
          ...state.download === true ? { download: true } : {},
        }
      : { state: state.state }
  const targets = context.targets ?? {}
  return {
    target: bound(targets.target),
    from: bound(targets.from),
    to: bound(targets.to),
    ...context.targetMoved === true ? { moved: true } : {},
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
    case 'browser_dialog': {
      const locale = getUiLocale()
      const details: ApprovalDetail[] = [{
        kind: 'text',
        value: context.dialog?.message ?? '',
        masked: false,
        label: localized(locale, `Message of the page's ${context.dialog?.type ?? 'unknown'} dialog`, `页面 ${context.dialog?.type ?? 'unknown'} 对话框的内容`),
      }]
      if (typeof call.args.promptText === 'string') {
        details.push({ kind: 'text', value: call.args.promptText, masked: false, label: localized(locale, 'Text to enter in the prompt', '将填入输入框的文本') })
      }
      return details
    }
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

/**
 * The web origin a URL's content belongs to, for cards and frame origins.
 * Unlike `httpOrigin` (security/web-url.ts) this also accepts `blob:` URLs of
 * a web origin, which carry their creator's origin; opaque origins are none.
 */
/**
 * Where a tab stands, for the taint exemption (policy-runtime.ts): the top
 * page's effective origin and the effective origins of every frame. `opaque`
 * when the top page has no web origin.
 */
export function tabProvenanceOf(frames: TabFrame[]): { top?: string; frames: string[]; opaque: boolean; urls: string[] } {
  const top = uniqueOrigins(frames.filter((frame) => frame.frameId === 0), frames)[0]
  return { ...top === undefined ? {} : { top }, frames: uniqueOrigins(frames, frames), opaque: top === undefined, urls: frameUrls(frames, frames) }
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

/** How a call addresses an element: its selector, its snapshot index, or focus. */
function locatorText(locator: Record<string, unknown>, locale: UiLocale): string {
  if (typeof locator.selector === 'string' && locator.selector !== '') {
    const selector = safeInline(locator.selector, 160)
    return localized(locale, `selected element (${selector})`, `选择器元素（${selector}）`)
  }
  if (typeof locator.index === 'number') return localized(locale, `element [${locator.index}]`, `元素 [${locator.index}]`)
  return localized(locale, 'the focused element', '当前焦点元素')
}

const KIND_WORDS: Record<TargetKind, [english: string, chinese: string]> = {
  button: ['button', '按钮'],
  link: ['link', '链接'],
  checkbox: ['checkbox', '复选框'],
  radio: ['radio button', '单选按钮'],
  switch: ['switch', '开关'],
  tab: ['tab', '选项卡'],
  menuitem: ['menu item', '菜单项'],
  option: ['option', '选项'],
  slider: ['slider', '滑块'],
  combobox: ['dropdown', '下拉框'],
  listbox: ['list', '列表'],
  textbox: ['text field', '文本框'],
  searchbox: ['search field', '搜索框'],
  spinbutton: ['number field', '数字输入框'],
  select: ['dropdown', '下拉框'],
  textarea: ['text area', '多行文本框'],
  password: ['password field', '密码框'],
  email: ['email field', '邮箱输入框'],
  tel: ['phone field', '电话输入框'],
  url: ['address field', '网址输入框'],
  number: ['number field', '数字输入框'],
  date: ['date field', '日期输入框'],
  file: ['file chooser', '文件选择框'],
  color: ['colour picker', '颜色选择器'],
  editable: ['editable text', '可编辑文本'],
  image: ['image', '图片'],
  summary: ['expandable section', '可展开区域'],
  label: ['label', '标签'],
  clickable: ['element', '元素'],
  element: ['element', '元素'],
}

/**
 * Page-authored text as a card shows it: in quotation marks, which say "this
 * is what the page calls it". The text was reduced to bounded plain text that
 * cannot contain these marks (shared/target-description.ts `pageTextForCard`).
 */
function quoted(text: string, locale: UiLocale): string {
  return localized(locale, `“${text}”`, `「${text}」`)
}

/** A found element in words: `checkbox “Email notifications”`. */
function foundText(state: Extract<TargetState, { state: 'found' }>, locale: UiLocale): string {
  const kind = localized(locale, ...KIND_WORDS[state.kind])
  if (state.name === '') return localized(locale, `${kind} (no label)`, `${kind}（无标签）`)
  return localized(locale, `${kind} ${quoted(state.name, locale)}`, `${kind}${quoted(state.name, locale)}`)
}

/**
 * The element a call acts on, as the card names it. With a page report: the
 * element's kind and name, or a plain statement that it is not there (or
 * could not be checked). Without one: the locator.
 */
function targetText(locator: Record<string, unknown>, state: TargetState | undefined, locale: UiLocale): string {
  const where = locatorText(locator, locale)
  if (state === undefined) return where
  if (state.state === 'found') return foundText(state, locale)
  return state.state === 'missing'
    ? localized(locale, `${where} — not found on the page right now`, `${where}——当前页面上找不到`)
    : localized(locale, `${where} — could not be checked on the page right now`, `${where}——当前无法在页面上核对`)
}

function elementTarget(call: ToolCall, locale: UiLocale, context: ApprovalContext = {}): string {
  return targetText(call.args, context.targets?.target, locale)
}

function dragEnds(call: ToolCall): { from: Record<string, unknown>; to: Record<string, unknown> | undefined } {
  const end = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  return { from: end(call.args.from) ?? {}, to: typeof call.args.toOffset === 'object' && call.args.toOffset !== null ? undefined : end(call.args.to) }
}

/** The secondary line for one found element: how the call addresses it and where the page shows it. */
function notePart(locator: Record<string, unknown>, state: TargetState | undefined, locale: UiLocale): string | undefined {
  if (state?.state !== 'found') return undefined
  const address = typeof locator.selector === 'string' && locator.selector !== ''
    ? localized(locale, `selector: ${safeInline(locator.selector, 160)}`, `选择器：${safeInline(locator.selector, 160)}`)
    : locatorText(locator, locale)
  if (state.context === undefined) return address
  const place = state.context.kind === 'row'
    ? localized(locale, `in the row ${quoted(state.context.text, locale)}`, `所在行${quoted(state.context.text, locale)}`)
    : localized(locale, `in ${quoted(state.context.text, locale)}`, `位于${quoted(state.context.text, locale)}`)
  return `${address} · ${place}`
}

/** The card's secondary line for a call that targets an element (see `ApprovalPrompt.targetNote`). */
function targetNoteFor(call: ToolCall, locale: UiLocale, context: ApprovalContext): string | undefined {
  const targets = context.targets
  if (targets === undefined) return undefined
  if (call.name === 'browser_drag') {
    const ends = dragEnds(call)
    const from = notePart(ends.from, targets.from, locale)
    const to = ends.to === undefined ? undefined : notePart(ends.to, targets.to, locale)
    const parts = [
      ...from === undefined ? [] : [localized(locale, `from ${from}`, `起点：${from}`)],
      ...to === undefined ? [] : [localized(locale, `to ${to}`, `终点：${to}`)],
    ]
    return parts.length === 0 ? undefined : parts.join(localized(locale, '; ', '；'))
  }
  return notePart(call.args, targets.target, locale)
}

/** The click gesture in words. Only the known values are named; anything else reads "Click". */
function clickVerb(args: Record<string, unknown>, locale: UiLocale): string {
  if (args.action === 'dblclick' || args.clicks === 2) return localized(locale, 'Double-click', '双击')
  if (args.button === 'right') return localized(locale, 'Right-click', '右键点击')
  if (args.button === 'middle') return localized(locale, 'Middle-click', '中键点击')
  return localized(locale, 'Click', '点击')
}

/** The step-timeline label of a call whose element(s) were found (see `ApprovalPrompt.stepLabel`). */
function stepLabelFor(call: ToolCall, locale: UiLocale, context: ApprovalContext): string | undefined {
  const targets = context.targets
  if (targets === undefined) return undefined
  if (call.name === 'browser_drag') {
    if (targets.from?.state !== 'found') return undefined
    const from = foundText(targets.from, locale)
    if (targets.to === undefined) return localized(locale, `Drag ${from}`, `拖动${from}`)
    if (targets.to.state !== 'found') return undefined
    return localized(locale, `Drag ${from} to ${foundText(targets.to, locale)}`, `把${from}拖到${foundText(targets.to, locale)}`)
  }
  if (targets.target?.state !== 'found') return undefined
  const target = foundText(targets.target, locale)
  switch (call.name) {
    case 'browser_click': return localized(locale, `${clickVerb(call.args, locale)} ${target}`, `${clickVerb(call.args, locale)}${target}`)
    case 'browser_type': return localized(locale, `Type into ${target}`, `向${target}输入`)
    case 'browser_press': return localized(locale, `Press a key in ${target}`, `在${target}中按键`)
    case 'browser_select': return localized(locale, `Select in ${target}`, `在${target}中选择`)
    case 'browser_hover': return localized(locale, `Hover over ${target}`, `悬停在${target}上`)
    case 'browser_upload': return localized(locale, `Attach files to ${target}`, `向${target}附加文件`)
    case 'browser_clipboard': return call.args.action === 'write' ? undefined : localized(locale, `Paste into ${target}`, `粘贴到${target}`)
    default: return undefined
  }
}

function summarizeAction(call: ToolCall, locale: UiLocale, context: ApprovalContext): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  switch (call.name) {
    case 'browser_click': {
      const verb = clickVerb(call.args, locale)
      const state = context.targets?.target
      const located = typeof call.args.index === 'number' || (typeof call.args.selector === 'string' && call.args.selector !== '')
      const target = state !== undefined || located
        ? targetText(call.args, state, locale)
        : localized(locale, 'element [?]', '元素 [?]')
      return localized(locale, `${verb} ${target}${frame}`, `${verb}${state?.state === 'found' ? '' : ' '}${target}${frame}`)
    }
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      const masked = context.typedTargetSensitive !== false
      return localized(
        locale,
        `Type ${length} characters into ${elementTarget(call, locale, context)}${frame}${masked ? ' (sensitive field or not inspected: masked)' : ''}`,
        `向${elementTarget(call, locale, context)}输入 ${length} 个字符${frame}${masked ? '（敏感字段或未能检查：已遮盖）' : ''}`,
      )
    }
    case 'browser_press': {
      const key = safeInline(typeof call.args.key === 'string' ? call.args.key : '')
      // With an element (addressed, or the one that has focus) the card says where the key goes.
      const into = context.targets?.target === undefined ? undefined : elementTarget(call, locale, context)
      return into === undefined
        ? localized(locale, `Press “${key}”${frame}`, `发送按键「${key}」${frame}`)
        : localized(locale, `Press “${key}” in ${into}${frame}`, `在${into}中发送按键「${key}」${frame}`)
    }
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
        : context.targets?.target === undefined
          ? localized(locale, 'Paste the clipboard into the page', '把剪贴板内容粘贴到页面')
          : localized(locale, `Paste the clipboard into ${elementTarget(call, locale, context)}${frame}`, `把剪贴板内容粘贴到${elementTarget(call, locale, context)}${frame}`)
    }
    case 'browser_upload': {
      const count = Array.isArray(call.args.paths) ? call.args.paths.length : 0
      return localized(
        locale,
        `Attach ${count} local file(s) to ${elementTarget(call, locale, context)}${frame}`,
        `向${elementTarget(call, locale, context)}附加 ${count} 个本地文件${frame}`,
      )
    }
    case 'browser_select': return localized(
      locale,
      `Select option(s) in ${elementTarget(call, locale, context)}${frame} (arguments below)`,
      `在${elementTarget(call, locale, context)}中选择选项${frame}（参数见下方）`,
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
    case 'browser_hover': return localized(locale, `Move the pointer over ${elementTarget(call, locale, context)}${frame}`, `把指针移到${elementTarget(call, locale, context)}上${frame}`)
    case 'browser_drag': return localized(
      locale,
      `Drag ${describeDragEnd(call.args.from, locale, context.targets?.from)} to ${describeDragDestination(call, locale, context.targets?.to)}${frame}`,
      `把${describeDragEnd(call.args.from, locale, context.targets?.from)}拖到${describeDragDestination(call, locale, context.targets?.to)}${frame}`,
    )
    case 'browser_dialog': {
      const kind = context.dialog?.type ?? 'unknown'
      const accept = call.args.accept === true
      return accept
        ? localized(locale, `Answer the page's ${kind} dialog with OK (accept)`, `以「确定」回应页面的 ${kind} 对话框`)
        : localized(locale, `Answer the page's ${kind} dialog with Cancel (dismiss)`, `以「取消」回应页面的 ${kind} 对话框`)
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
    case 'browser_pdf_text':
      return localized(locale, 'Read the text of the PDF open in the controlled tab', '读取受控标签页中 PDF 的文本')
    case 'browser_wait':
      return localized(locale, 'Wait for a condition on the current page (arguments below)', '等待当前页面满足条件（参数见下方）')
    default:
      return localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域')
  }
}

/** One end of a drag: `{index}` or `{selector}`. */
function describeDragEnd(value: unknown, locale: UiLocale, state?: TargetState): string {
  const end = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  if ((typeof end.selector === 'string' && end.selector !== '') || typeof end.index === 'number') return targetText(end, state, locale)
  return localized(locale, '(no element given)', '（未指定元素）')
}

function describeDragDestination(call: ToolCall, locale: UiLocale, state?: TargetState): string {
  const offset = call.args.toOffset
  if (typeof offset === 'object' && offset !== null) {
    const { x, y } = offset as { x?: unknown; y?: unknown }
    return localized(locale, `an offset of (${String(x)}, ${String(y)}) px`, `偏移 (${String(x)}, ${String(y)}) 像素处`)
  }
  return describeDragEnd(call.args.to, locale, state)
}

function summarizeAlwaysAskRead(call: ToolCall, locale: UiLocale): string {
  switch (call.name) {
    case 'browser_save_pdf':
      return localized(locale, 'Save the current page as a PDF into the agent workspace (may contain sensitive content)', '把当前页面保存为 PDF 到代理工作区（可能包含敏感信息）')
    case 'browser_downloads': {
      const waiting = call.args.action === 'wait'
      return waiting
        ? localized(locale, 'Wait for a browser download to finish and report its local file path', '等待浏览器下载完成并报告其本地文件路径')
        : localized(locale, 'List recent browser downloads with their local file paths and source URLs', '列出最近的浏览器下载及其本地文件路径和来源 URL')
    }
    default:
      return localized(locale, 'Capture a screenshot of the current page (may contain sensitive content)', '截取当前页面的可视区域截图（可能包含敏感信息）')
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

const READ_TOOLS = new Set([
  ...PAGE_READS,
  'browser_extract',
  'browser_wait',
  'browser_scroll',
  'browser_hover',
  ...ALWAYS_ASK_READS,
])
/** Tools that read every frame of the tab, not just one. */
const WHOLE_TAB_READS = new Set(['browser_snapshot', 'browser_screenshot', 'browser_save_pdf'])

/**
 * Which origins a call reads, changes, or navigates to, for the policy layer
 * (call-policy.ts). History moves (back/forward) and system-clipboard writes
 * touch no page origin; navigation counts only its destination, so the agent
 * can always leave a read-only or blocked page.
 */
export function callPolicyTargets(call: ToolCall, frames: TabFrame[]): CallPolicyTargets {
  const pageOrigin = uniqueOrigins(frames.filter((frame) => frame.frameId === 0), frames)[0]
  const targets = callPolicyTargetsFor(call, frames)
  return pageOrigin === undefined || targets.destination !== undefined ? targets : { ...targets, pageOrigin }
}

function callPolicyTargetsFor(call: ToolCall, frames: TabFrame[]): CallPolicyTargets {
  const url = typeof call.args.url === 'string' ? call.args.url : undefined
  if (call.name === 'browser_navigate' || call.name === 'browser_open_tab') {
    return { reads: [], acts: [], ...url === undefined ? {} : { destination: url } }
  }
  if (call.name === 'browser_back' || call.name === 'browser_forward' || call.name === 'browser_downloads') return { reads: [], acts: [] }
  if (call.name === 'browser_clipboard' && call.args.action === 'write') return { reads: [], acts: [] }
  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const targetFrames = target === undefined ? [] : [target]
  const targetOrigins = uniqueOrigins(targetFrames, frames)
  if (WHOLE_TAB_READS.has(call.name)) return { reads: uniqueOrigins(frames, frames), acts: [], urls: frameUrls(frames, frames) }
  const devToolsRead = isDevToolsTool(call.name)
    && call.name !== 'browser_devtools_set_element_style'
    && call.name !== 'browser_devtools_set_element_attribute'
    && call.name !== 'browser_console_eval'
  const urls = frameUrls(targetFrames, frames)
  if ((READ_TOOLS.has(call.name) && !extractPaginates(call)) || devToolsRead) return { reads: targetOrigins, acts: [], urls }
  return {
    reads: [],
    acts: targetOrigins,
    urls,
    ...TYPING_TOOLS.has(call.name) && targetOrigins[0] !== undefined
      ? { typeTargetOrigin: targetOrigins[0] }
      : {},
  }
}

/** Calls that write model-chosen characters into a frame (taint's typing rule). */
const TYPING_TOOLS = new Set(['browser_type', 'browser_clipboard', 'browser_press', 'browser_dialog'])

/** Effective web URLs of frames (an about:blank or srcdoc frame inherits its parent's). */
function frameUrls(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const urls = new Set<string>()
  for (const frame of targets) {
    const url = effectiveFrameUrl(frame, allFrames)
    if (url !== undefined) urls.add(url)
  }
  return [...urls].sort()
}

function effectiveFrameUrl(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  try {
    const url = new URL(frame.url)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch { /* fall through to the parent */ }
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameUrl(parent, frames, visited)
}

/**
 * The prompt for a call the policy layer forces to ask: the ordinary card
 * (built as if page sharing were "ask", so reads have one too) plus the
 * reasons, never trustable, and marked so no shortcut can skip it.
 */
export function forcedApprovalPrompt(
  call: ToolCall,
  frames: TabFrame[],
  reasons: readonly string[],
  locale: UiLocale = getUiLocale(),
  context: ApprovalContext = {},
  causes?: readonly ForceCause[],
): ApprovalPrompt {
  const base = call.name === 'browser_open_tab' || isDevToolsTool(call.name)
    ? undefined
    : approvalPromptForCall(call, 'ask', frames, locale, context)
  const fallback = base ?? (isDevToolsTool(call.name)
    ? devToolsApprovalForCall(call, frames, locale)
    : approvalPromptForCall(call, 'ask', call.name === 'browser_open_tab' ? [] : frames, locale, context))
  const prompt: ApprovalPrompt = fallback ?? {
    kind: 'action',
    action: call.name,
    summary: call.name,
    origins: uniqueOrigins(frames.filter((frame) => frame.frameId === 0), frames),
    canTrust: false,
    details: [payloadDetail(call)],
    binding: approvalBinding({ action: call.name, args: call.args, origins: uniqueOrigins(frames.filter((frame) => frame.frameId === 0), frames) }),
  }
  return {
    ...prompt,
    canTrust: false,
    forced: true,
    perCallOnly: true,
    // Which rules forced it (Auto approve tells a site rule from the taint rules); not bound.
    ...causes === undefined || causes.length === 0 ? {} : { forcedBy: [...new Set(causes)] },
    details: [
      { kind: 'text', value: reasons.join('\n'), masked: false, label: localized(locale, 'Why this needs your approval', '为何需要您的批准') },
      ...prompt.details ?? [],
    ],
  }
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
  // A missing optional permission can only be granted from a user gesture.
  if (input.prompt.permission !== undefined) return 'prompt'
  // Site policy and taint rules run before every shortcut below.
  if (input.prompt.forced === true) return 'prompt'
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
