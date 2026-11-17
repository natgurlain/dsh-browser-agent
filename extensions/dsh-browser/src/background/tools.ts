/**
 * Tool dispatch: executes `tool.call` frames in an explicitly selected tab via
 * the content script and answers with the text-only result.
 *
 * The background service owns tab-affinity policy. Direct callers may omit a
 * target for backward-compatible active-tab dispatch in isolated tests.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from 'dsh-browser-agent/src/protocol.ts'
import type { ToolErrorCode } from 'dsh-browser-agent/src/protocol.ts'
import {
  allocateFrameBudgets,
  frameDocumentKey,
  frameOrigin,
  listTabFrames,
  type TabFrame,
} from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { approvalPromptForCall, callPolicyTargets, forcedApprovalPrompt, isConditionalPageWait, originFromUrl, type ApprovalContext } from './authorization.ts'
import type { CallPolicyDecision, CallPolicyTargets } from '../security/call-policy.ts'
import { approvalBinding } from '../security/payload-binding.ts'
import { waitForNextDocumentReady } from './navigation.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import type { StepTarget } from '../shared/repetition.ts'
import { pageLocation } from './run-program.ts'
import { DevToolsError } from './debugger-session.ts'
import { InputStateStore } from './input-state.ts'
import {
  InputError,
  dispatchKey,
  insertTextAtCaret,
  sendPasteShortcut,
  typeAsKeystrokes,
  setInputFiles,
  withFocusEmulation,
} from './input-actions.ts'
import type { InputSetupRequest, InputSetupResult } from '../shared/input-setup.ts'
import { writeClipboard } from './clipboard-write.ts'
import type { ClipboardWriteOutcome } from '../shared/clipboard.ts'
import { resolveDebuggerFrame } from './debugger-frame.ts'
import { capturedConsoleEntries } from './devtools-controller.ts'
import type { ConsoleEntry } from './devtools-network.ts'
import { dialogOpenMessage, unresponsiveMessage, type DialogRuntime, type OpenDialog } from './dialogs.ts'
import { DownloadsError, downloadsApi, hasDownloadsPermission, runDownloadsTool } from './downloads.ts'
import { readTabPdfText, savePagePdf } from './page-documents.ts'
import {
  clickMayRetry,
  dragIndices,
  drag as dispatchDrag,
  finishWatch,
  hover as dispatchHover,
  precheckClick,
  shouldSuggestTrusted,
  TRUSTED_HINT,
  trustedClick,
  type PointerContext,
} from './pointer-tools.ts'
import { parseHttpUrl } from '../security/web-url.ts'
import { approvalFailure, type ToolAnswer } from './answers.ts'
import { requestedModifiers, usableInput, type InputRuntime } from './input-actions.ts'
import { readTargetSlots, type TargetStates } from '../shared/target-description.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
  /** The Host holds this session (or an ancestor agent) tainted (protocol `tool.call.tainted`). */
  tainted?: true
  /** A session this one was spawned or forked from read taint-exempt pages (protocol `tool.call.inheritedExemptReads`). */
  inheritedExemptReads?: true
  /** Set by the bridge's program runner: this call is one step of an approved `browser_run`. */
  program?: { id: string; step: number }
  /** External (MCP) client label for a bridge-owned external session's call. */
  requester?: string
  /** The model's tool-call id (protocol `tool.call.toolCallId`): lets the panel mark that step. */
  toolCallId?: string
}

/** The wire answer for one tool call (answers.ts). */
export type { ToolAnswer } from './answers.ts'

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

const CONTENT_SCRIPT_FILE = 'content.js'
const ACTION_DELTA_TOOLS = new Set([
  'browser_click',
  'browser_hover',
  'browser_drag',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_clipboard',
  'browser_wait',
  'browser_select',
])
const ACTION_DELTA_GUIDANCE = 'The page settled and its current changes are included below. Continue from this state; take another snapshot only when broader page context is needed.'
const NAVIGATION_CANDIDATE_TOOLS = new Set([
  'browser_click',
  'browser_select',
  // A paginated extraction may follow next-page links.
  'browser_extract',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_open_tab',
])
const TAB_NATIVE_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
const STATE_CHANGING_PAGE_TOOLS = new Set([
  'browser_click',
  'browser_select',
  'browser_hover',
  'browser_drag',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_clipboard',
  'browser_upload',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
/** Tools that operate on the browser tab collection rather than one page document. */
export const TAB_MANAGEMENT_TOOL_NAMES = new Set([
  'browser_list_tabs',
  'browser_follow_tab',
  'browser_close_tab',
  // Browser-level, not page-level: reads the download list, not a document.
  'browser_downloads',
])
const NAVIGATION_SNAPSHOT_GUIDANCE = 'Navigation completed and the current page snapshot is included below. Use it directly instead of taking an immediate duplicate snapshot.'
const pendingInjections = new Map<number, Promise<void>>()
const snapshotDocumentsByTab = new Map<number, Map<number, string>>()

/** Forget delta/element state whenever the user explicitly follows a new tab. */
export function resetTabSnapshot(tabId: number): void {
  snapshotDocumentsByTab.delete(tabId)
}

/** Forget held modifiers for a tab that moved on. */
export function resetInputState(tabId: number): void {
  inputStates.reset(tabId)
}

/** Whether a successful tool may have changed the controlled tab's page URL. */
export function isNavigationCandidateTool(name: string): boolean {
  return NAVIGATION_CANDIDATE_TOOLS.has(name)
}

/** Whether a tool can run without first resolving the current controlled tab. */
export function isTabManagementTool(name: string): boolean {
  return TAB_MANAGEMENT_TOOL_NAMES.has(name)
}

/** Trusted input channel owned by the background entry point (input-actions.ts). */
export type { InputRuntime } from './input-actions.ts'

/** Tab-affinity services owned by the background entry point. */
export interface TabManagementContext {
  /** Skip all browser approval prompts after the user enables unrestricted access. */
  unrestrictedAccess: boolean
  /** Controlled tab for the calling session, when one still exists. */
  controlledTabId?: number
  /** Rebind subsequent tools to one existing tab without activating it. */
  followTab?: (tab: chrome.tabs.Tab) => void | Promise<void>
  /** Trusted input, when the platform and the user's browser allow it. */
  input?: InputRuntime
  /** Mark the point after which a state-changing operation cannot be withdrawn. */
  commitAction?: () => void
  /** Restore withdrawability when a content-script action was not delivered. */
  rollbackActionCommit?: () => void
  /** JavaScript dialog tracking and the page-call watchdog. */
  dialogs?: DialogRuntime
  /**
   * Site policy, managed policy, and taint rules (call-policy.ts). Evaluated
   * before unrestricted access, trusted origins, or page sharing can skip a
   * prompt; absent means the ordinary approval flow only.
   */
  policy?: CallPolicyHook
  /** On-page agent overlay (ghost cursor, target outline); best effort. */
  overlay?: ActionOverlay
  /**
   * Told the step-timeline label of a call whose target element was found on
   * the page ("Click button “Save”"): the panel shows it instead of the
   * generic "Click element". Never model-facing.
   */
  onStepLabel?: (label: string) => void
  /**
   * Whether a tab's page is one the agent may not see at all (blocked site,
   * outside the managed allowlist): browser_list_tabs withholds its title and URL.
   */
  tabHidden?: (url: string) => boolean
  /**
   * A "do the remaining N" step: what its element must still look like and,
   * for a series, the page it was approved on. The page is compared here, on
   * the frames listed for this very step; the element is compared by the
   * content script inside the action, on the element the action resolved. On
   * any difference the step fails and nothing is done to the page.
   */
  expect?: StepExpectation
}

/** What a "do the remaining N" step must still find (see {@link TabManagementContext.expect}). */
export interface StepExpectation {
  target: StepTarget
  /** A series only: the top document and its full location (query and fragment included). */
  page?: { documentKey: string; location: string }
}

/** Expected targets of the calls being dispatched, read when their action message is built. */
const stepExpectations = new WeakMap<ToolCall, StepTarget>()

/**
 * Whether a "do the remaining N" step may be dispatched at all: only a
 * selector-targeted click, type or select on the content route carries the
 * in-action element check, and a series step must still be on the document
 * and location its card was approved on.
 * @returns a failure answer in the user's words, or undefined when it may run.
 */
export function stepExpectationFailure(call: ToolCall, frames: TabFrame[], expect: StepExpectation): ToolAnswer | undefined {
  const zh = getUiLocale() === 'zh'
  if (!CHECKED_STEP_TOOLS.has(call.name) || inputRoute(call) !== 'content' || typeof call.args.selector !== 'string') {
    return { ok: false, error: { code: 'action-failed', message: zh ? '此步骤无法与已批准的行核对，因此未执行。' : 'This step cannot be checked against an approved row, so it was not run.' } }
  }
  if (expect.page === undefined) return undefined
  const top = frames.find((frame) => frame.frameId === 0)
  if (top !== undefined && frameDocumentKey(top) === expect.page.documentKey && pageLocation(top.url) === expect.page.location) return undefined
  return { ok: false, error: { code: 'action-failed', message: zh ? '页面已重新加载或已离开您批准时的页面。未执行任何操作。' : 'the page was reloaded or is no longer the one you approved this on. Nothing was done.' } }
}

/** Actions whose content-script implementation checks the element it resolved (content/actions.ts). */
const CHECKED_STEP_TOOLS: ReadonlySet<string> = new Set(['browser_click', 'browser_type', 'browser_select'])

/** Placeholder for the title and URL of a tab site policy hides. */
const TAB_HIDDEN = '(hidden by site policy)'

/** What the dispatcher asks of the on-page overlay. Never fails a call. */
export interface ActionOverlay {
  /** Point at the call's target in `frame` just before it runs. */
  beforeAction(tabId: number, frame: TabFrame, call: ToolCall): Promise<void>
  /**
   * Outline the call's target while its approval card is open. The outline
   * appears only once a card is really shown ({@link TabManagementContext.onCardShown}
   * side: `showPreview`), and `endPreview` always removes it.
   */
  armPreview?(tabId: number, frame: TabFrame, call: ToolCall): void
  endPreview?(call: ToolCall): void
  /** Keep the overlay out of a captured screenshot. */
  hiddenDuring<T>(tabId: number, run: () => Promise<T>): Promise<T>
}

/** Evaluate the policy layer for one call against the origins it touches. */
export type CallPolicyHook = (call: ToolCall, targets: CallPolicyTargets) => CallPolicyDecision

function policyDenied(message: string): ToolAnswer {
  return { ok: false, error: { code: 'action-failed', message } }
}

// ---- JavaScript dialogs (see dialogs.ts) ----

/**
 * Actions that commonly open a dialog: the debugger is armed around them.
 * Leaving a page can raise "leave site?" (beforeunload); the attachment
 * outlives the call for the broker's idle window, so it is still reported.
 */
const DIALOG_ARMED_TOOLS = new Set([
  'browser_click',
  'browser_press',
  'browser_hover',
  'browser_drag',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
])
/** Calls that still run while a dialog blocks the page. */
const DIALOG_EXEMPT_TOOLS = new Set([
  'browser_dialog',
  'browser_screenshot',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_downloads',
])

/** A guarded page call: its value, or the answer that replaces it. */
type Guarded<T> = { ok: true; value: T; dialog?: OpenDialog } | { ok: false; answer: ToolAnswer }

/**
 * Run one page call under the dialog watchdog: a dialog that opens meanwhile,
 * or a page that stops answering, ends the call early with a clear error
 * instead of the bridge's tool timeout.
 */
async function guardPage<T>(
  dialogs: DialogRuntime | undefined,
  tabId: number,
  frame: TabFrame,
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<Guarded<T>> {
  if (dialogs === undefined) return { ok: true, value: await operation }
  const outcome = await dialogs.guard(tabId, frame, operation, signal)
  switch (outcome.kind) {
    case 'answer':
      return { ok: true, value: outcome.value, ...(outcome.dialog === undefined ? {} : { dialog: outcome.dialog }) }
    case 'dialog':
      return {
        ok: false,
        answer: {
          ok: false,
          error: {
            code: 'action-failed',
            message: dialogOpenMessage(outcome.dialog, dialogs.canAnswer, 'The action was delivered and the page opened a JavaScript dialog before it finished.'),
          },
        },
      }
    case 'unresponsive':
      return { ok: false, answer: { ok: false, error: { code: 'timeout', message: unresponsiveMessage(outcome.waitedMs) } } }
  }
}

/** Append a dialog that opened while (or right after) an action answered. */
function withDialogNote(answer: ToolAnswer, dialog: OpenDialog | undefined, dialogs: DialogRuntime | undefined): ToolAnswer {
  const text = answerText(answer)
  if (dialog === undefined || dialogs === undefined || text === undefined) return answer
  const note = dialogOpenMessage(dialog, dialogs.canAnswer, 'The page opened a JavaScript dialog during the action.')
  return { ...answer, result: { ...(answer.result as Record<string, unknown>), text: `${text}\n\n${note}` } }
}

/** The dialog an approval for browser_dialog is bound to. */
function dialogApprovalContext(dialog: OpenDialog): ApprovalContext {
  return {
    dialog: {
      type: dialog.type,
      message: dialog.message,
      ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }),
    },
  }
}

/** Validate `browser_dialog` arguments. */
function dialogArgsError(args: Record<string, unknown>): ToolAnswer | undefined {
  if (typeof args.accept !== 'boolean') {
    return { ok: false, error: { code: 'bad-args', message: 'accept must be true (OK / leave) or false (Cancel / stay).' } }
  }
  if (args.promptText !== undefined && typeof args.promptText !== 'string') {
    return { ok: false, error: { code: 'bad-args', message: 'promptText must be a string.' } }
  }
  return undefined
}

/** Answer the open dialog after approval. */
async function answerDialog(
  tabId: number,
  call: ToolCall,
  dialogs: DialogRuntime,
  dialog: OpenDialog,
  commitAction?: () => void,
): Promise<ToolAnswer> {
  const accept = call.args.accept === true
  const promptText = typeof call.args.promptText === 'string' ? call.args.promptText : undefined
  commitAction?.()
  try {
    await dialogs.answer(tabId, accept, promptText)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'action-failed', message: `The dialog could not be answered: ${detail}` } }
  }
  const kind = dialog.type === 'unknown' ? 'dialog' : `${dialog.type} dialog`
  const how = accept ? (promptText === undefined ? 'OK' : `OK and ${promptText.length} character(s) of prompt text`) : 'Cancel'
  return {
    ok: true,
    result: { text: `Answered the ${kind} with ${how}. The page continues; call browser_snapshot to read the resulting state.` },
  }
}

function isToolAnswer(value: unknown): value is ToolAnswer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function isInjectablePage(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/** Inject the packaged content script once per tab, coalescing concurrent recovery attempts. */
async function injectContentScript(tabId: number): Promise<void> {
  let pending = pendingInjections.get(tabId)
  if (pending === undefined) {
    pending = chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT_FILE],
    }).then(() => undefined)
    pendingInjections.set(tabId, pending)
  }
  try {
    await pending
  } finally {
    if (pendingInjections.get(tabId) === pending) pendingInjections.delete(tabId)
  }
}

async function sendAction(
  tabId: number,
  call: ToolCall,
  frame: TabFrame,
  budget?: ContentBudget,
  includePageDelta: boolean = false,
  shareContent: boolean = false,
): Promise<unknown> {
  const expected = stepExpectations.get(call)
  return chrome.tabs.sendMessage(tabId, {
    type: 'DSH_ACTION',
    action: call.name,
    args: withoutFrame(call.args),
    ...budget === undefined ? {} : { budget },
    ...includePageDelta ? { includePageDelta: true } : {},
    ...shareContent ? { shareContent: true } : {},
    // A "do the remaining N" step: the content script compares the element this action resolves before acting on it.
    ...expected === undefined ? {} : { expect: { target: expected, zh: getUiLocale() === 'zh' } },
  }, frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId })
}

function contentScriptReceiverMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist')
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

/** Map a debugger failure to the model-facing vocabulary instead of masking it. */
function devToolsFailure(error: unknown): ToolAnswer | undefined {
  if (!(error instanceof DevToolsError)) return undefined
  return {
    ok: false,
    error: {
      code: error.code === 'devtools-conflict' ? 'input-unavailable' : 'action-failed',
      message: error.message,
    },
  }
}

function tabMetadataSnapshot(
  tabId: number,
  windowId: number | undefined,
  title: string | undefined,
  url: string | undefined,
  maxChars: number,
): ToolAnswer {
  const status = 'The current tab is available only through browser-level controls because its page DOM is protected or inaccessible. DOM snapshot, click, type, press, scroll, wait, and text extraction are unavailable here. Navigate, back, forward, and reload remain available.'
  const separator = '\n\n'
  const remaining = maxChars - status.length - separator.length
  if (remaining <= 0) return { ok: true, result: { text: status.slice(0, maxChars) } }
  return {
    ok: true,
    result: {
      text: `${status}${separator}${wrapUntrustedContent([
        `Tab ID: ${tabId}`,
        `Window ID: ${windowId ?? '(unknown)'}`,
        `Title: ${title ?? '(unknown)'}`,
        `URL: ${url ?? '(unknown)'}`,
      ].join('\n'), remaining)}`,
    },
  }
}

async function dispatchTabNativeTool(
  tabId: number,
  tabUrl: string | undefined,
  tabTitle: string | undefined,
  windowId: number | undefined,
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  commitAction?: () => void,
): Promise<ToolAnswer | undefined> {
  if (call.name === 'browser_snapshot') return tabMetadataSnapshot(tabId, windowId, tabTitle, tabUrl, budget.maxChars)
  if (!TAB_NATIVE_TOOLS.has(call.name)) return undefined
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()

  let operation: Promise<unknown>
  let text: string
  try {
    switch (call.name) {
      case 'browser_navigate': {
        const requested = parseHttpUrl(call.args.url)
        if (requested === undefined) {
          return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
        }
        commitAction?.()
        operation = chrome.tabs.update(tabId, { url: requested.href })
        text = `Navigating to ${requested.href}. Call browser_snapshot again after the page loads.`
        break
      }
      case 'browser_back':
        commitAction?.()
        operation = chrome.tabs.goBack(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_forward':
        commitAction?.()
        operation = chrome.tabs.goForward(tabId)
        text = 'Navigating through browser history. Call browser_snapshot again after the page loads.'
        break
      case 'browser_reload':
        commitAction?.()
        operation = chrome.tabs.reload(tabId)
        text = 'The page is reloading. Call browser_snapshot again after it loads.'
        break
      default:
        return undefined
    }
    resetTabSnapshot(tabId)
    await operation
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return unavailable(`The browser-level operation failed: ${detail}`)
  }
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  return { ok: true, result: { text, navigationPending: true } }
}

function cancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Preserve the factual approval outcome for the model without prescribing a response. */
function targetChanged(): ToolAnswer {
  return unavailable('The controlled tab changed during the operation. Confirm the page in the side panel before retrying.')
}

function isCancelled(call: ToolCall, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
    || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function withoutFrame(args: Record<string, unknown>): Record<string, unknown> {
  const { frame: _frame, ...rest } = args
  return rest
}

function requestedFrame(args: Record<string, unknown>): number {
  const value = args.frame
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return -1
  return value
}

function answerText(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const text = (answer.result as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function answerPageContent(answer: ToolAnswer): string | undefined {
  if (!answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const pageContent = (answer.result as { pageContent?: unknown }).pageContent
  return typeof pageContent === 'string' ? pageContent : undefined
}

function answerNavigationPending(answer: ToolAnswer): boolean {
  return answer.ok
    && typeof answer.result === 'object'
    && answer.result !== null
    && (answer.result as { navigationPending?: unknown }).navigationPending === true
}

/**
 * Whether the frame an action was sent to now holds another document (or is
 * gone): the action's own answer was lost because the page navigated.
 */
async function frameNavigatedAway(tabId: number, frame: TabFrame): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300))
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null | undefined
    try {
      frames = await chrome.webNavigation.getAllFrames({ tabId })
    } catch {
      return false
    }
    if (frames === null || frames === undefined || frames.length === 0) return false
    const current = frames.find((candidate) => candidate.frameId === frame.frameId)
    if (current === undefined) return frame.frameId !== 0
    if (frame.documentId !== undefined && current.documentId !== undefined) {
      if (current.documentId !== frame.documentId) return true
    } else if (current.url !== frame.url) {
      return true
    }
  }
  return false
}

/** The status of an action whose page navigated before the content script could answer. */
function navigatedDuringActionStatus(call: ToolCall): string {
  const verb = call.name === 'browser_click' ? 'Clicked'
    : call.name === 'browser_press' ? 'Pressed a key on'
      : call.name === 'browser_select' ? 'Chose an option in'
        : call.name === 'browser_type' ? 'Typed into'
          : 'Acted on'
  return `${verb} ${describeTarget(call.args)}. The page navigated to a new document while the action ran (for example, a form was submitted). Call browser_snapshot again after the page loads.`
}

/** Keep extension-authored action status outside the nonce-bound page-data boundary. */
function wrapActionDelta(status: string, pageContent: string, frame: TabFrame, maxChars: number): string {
  const prefix = `${status}\n${ACTION_DELTA_GUIDANCE}`
  const separator = '\n\n'
  const boundaryBudget = maxChars - prefix.length - separator.length
  if (boundaryBudget < 500) return prefix.slice(0, maxChars)
  const framedContent = frame.frameId === 0 ? pageContent : `${frameHeader(frame)}\n${pageContent}`
  return `${prefix}${separator}${wrapUntrustedContent(framedContent, boundaryBudget)}`
}

/** Per-tab held modifier state. */
const inputStates = new InputStateStore()

/** Failure of an internal content-script input setup request. */
class InputSetupError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'InputSetupError'
  }
}

/** Content-script response envelope for one setup request. */
interface InputSetupEnvelope {
  ok?: boolean
  result?: InputSetupResult
  error?: { code?: string; message?: string }
}

/** Ask one frame to measure, focus, mark, or report its frame chain. */
async function sendInputSetup(tabId: number, frame: TabFrame, request: InputSetupRequest): Promise<InputSetupResult> {
  const response = await chrome.tabs.sendMessage(
    tabId,
    { type: 'DSH_INPUT_SETUP', request },
    frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId },
  ) as InputSetupEnvelope | undefined
  if (typeof response !== 'object' || response === null || response.ok !== true || response.result === undefined) {
    const code = response?.error?.code
    const stable: ToolErrorCode = code === 'bad-args' || code === 'input-unavailable' || code === 'action-failed'
      ? code
      : 'action-failed'
    throw new InputSetupError(stable, response?.error?.message ?? 'The page did not answer the input setup request.')
  }
  return response.result
}

/** Validate the model-supplied modifier list. */
/** Report what the clipboard actually holds, including derived plain text. */
function describeClipboardWrite(outcome: ClipboardWriteOutcome): string {
  if (!outcome.rich) return `Wrote ${outcome.plainText.length} character(s) to the system clipboard.`
  if (outcome.plainDerived) {
    return `Wrote rich HTML to the system clipboard; the plain-text flavor is derived from the HTML (${outcome.plainText.length} characters).`
  }
  return `Wrote rich HTML and ${outcome.plainText.length} plain-text character(s) to the system clipboard.`
}

/** Describe the target in a status line without echoing page text. */
function describeTarget(args: Record<string, unknown>): string {
  if (args.index !== undefined) return `element [${String(args.index)}]`
  if (typeof args.selector === 'string') return `element (${args.selector})`
  return 'the focused element'
}

/**
 * After trusted input, wait for the frame to settle and attach an authorized page delta.
 * The `browser_wait` action already owns both behaviors for content-script
 * actions; reusing it keeps the result shape identical for real input.
 */
async function settleAfterInput(
  tabId: number,
  frame: TabFrame,
  status: string,
  budget: ContentBudget,
  includePageDelta: boolean,
  suffix = ' (trusted)',
): Promise<ToolAnswer> {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_ACTION', action: 'browser_wait', args: {}, budget, includePageDelta },
      frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId },
    )
    if (isToolAnswer(response)) {
      const pageContent = answerPageContent(response)
      if (includePageDelta && pageContent !== undefined) {
        return { ok: true, result: { text: wrapActionDelta(`${status}${suffix}`, pageContent, frame, budget.maxChars) } }
      }
    }
  } catch {
    // The page may be navigating; the trusted action itself already succeeded.
  }
  return { ok: true, result: { text: `${status}${suffix}` } }
}

/** Pointer helpers bound to one frame of one call (see pointer-tools.ts). */
function pointerContext(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget,
  runtime: InputRuntime | undefined,
  includePageDelta: boolean,
): PointerContext {
  return {
    tabId,
    frame,
    call,
    setup: (request) => sendInputSetup(tabId, frame, request),
    settle: (status, suffix) => settleAfterInput(tabId, frame, status, budget, includePageDelta, suffix),
    ...(runtime === undefined ? {} : { input: runtime }),
  }
}

/**
 * Classify how one call reaches the page.
 *
 * `content` stays in the frame, `trusted` prefers real input but degrades to
 * the frame for calls that have a synthetic equivalent, and `required` has no
 * synthetic equivalent at all.
 */
function inputRoute(call: ToolCall): 'content' | 'trusted' | 'required' | 'host' {
  switch (call.name) {
    case 'browser_press':
      if (call.args.trusted === true) return 'required'
      if (call.args.trusted === false) return 'content'
      if (Array.isArray(call.args.modifiers) || call.args.action !== undefined) return 'trusted'
      return 'content'
    case 'browser_type':
      if (call.args.trusted === true) return 'required'
      if (call.args.trusted === false) return 'content'
      if (call.args.mode === 'insert' || call.args.mode === 'keystrokes') return 'trusted'
      return 'content'
    case 'browser_clipboard':
      if (call.args.action === 'write') return 'host'
      return call.args.method === 'system' ? 'required' : 'content'
    case 'browser_upload':
      return 'required'
    case 'browser_click':
      return call.args.trusted === true ? 'required' : 'content'
    default:
      return 'content'
  }
}

/** Session text for a trusted-input failure. */
function trustedFailure(error: unknown): ToolAnswer | undefined {
  if (error instanceof InputError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  if (error instanceof InputSetupError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return undefined
}

/** Map a page-side selector failure to a model-facing answer. */
function inputUnavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'input-unavailable', message } }
}

/** Whether a runtime is present and supported. */
/** A token that only marks one file input for one upload call. */
function uploadToken(): string {
  return crypto.randomUUID()
}

async function snapshotAllFrames(
  tabId: number,
  allFrames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
): Promise<ToolAnswer> {
  // `frame` narrows the snapshot to one iframe: a canvas or editor frame is
  // usually bigger than the share it gets from a whole-page budget.
  const requested = call.args.frame
  let frames = allFrames
  let budgets: Map<number, ContentBudget>
  if (requested !== undefined) {
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 0) {
      return { ok: false, error: { code: 'bad-args', message: 'frame must be a non-negative integer.' } }
    }
    const single = allFrames.find((frame) => frame.frameId === requested)
    if (single === undefined) {
      return unavailable(`Frame ${requested} does not exist or has navigated. Call browser_snapshot again.`)
    }
    frames = [single]
    budgets = new Map([[single.frameId, { maxItems: budget.maxItems, maxChars: budget.maxChars }]])
  } else {
    budgets = allocateFrameBudgets(allFrames, budget)
  }
  const scoped = requested !== undefined
  const previous = snapshotDocumentsByTab.get(tabId) ?? new Map<number, string>()
  const deltaRequested = call.args.delta === true

  const settled = await Promise.allSettled(frames.map(async (frame) => {
    const sameDocument = previous.get(frame.frameId) === frameDocumentKey(frame)
    const frameCall: ToolCall = {
      ...call,
      args: deltaRequested && sameDocument ? call.args : { ...call.args, delta: false },
    }
    const response = await sendAction(tabId, frameCall, frame, budgets.get(frame.frameId))
    return { frame, response }
  }))

  const sections: string[] = []
  const capturedDocuments = new Map<number, string>()
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]!
    const frame = frames[index]!
    if (outcome.status === 'rejected') {
      if (frame.frameId === 0) throw outcome.reason
      sections.push(frameHeader(frame), '(This iframe was inaccessible or destroyed while loading.)')
      continue
    }
    const answer = outcome.value.response
    if (!isToolAnswer(answer)) {
      if (frame.frameId === 0) return unavailable('The page content script returned an invalid response.')
      sections.push(frameHeader(frame), '(This iframe returned an invalid response.)')
      continue
    }
    const text = answerText(answer)
    if (text === undefined) {
      if (frame.frameId === 0) return answer
      sections.push(frameHeader(frame), `(This iframe could not be read: ${answer.error?.message ?? 'unknown error'})`)
      continue
    }
    capturedDocuments.set(frame.frameId, frameDocumentKey(frame))
    if (frame.frameId === 0 && !scoped) sections.push(text)
    else sections.push(frameHeader(frame), text)
  }

  if (deltaRequested && !scoped) {
    const liveIds = new Set(frames.map((frame) => frame.frameId))
    const removed = [...previous.keys()].filter((frameId) => frameId !== 0 && !liveIds.has(frameId))
    if (removed.length > 0) sections.push(`\nRemoved iframes: ${removed.join(', ')}`)
  }

  // A scoped snapshot must not erase the other frames' delta baselines.
  const nextDocuments = scoped ? new Map(previous) : new Map<number, string>()
  for (const [frameId, key] of capturedDocuments) nextDocuments.set(frameId, key)
  snapshotDocumentsByTab.set(tabId, nextDocuments)
  return { ok: true, result: { text: wrapUntrustedContent(sections.join('\n'), budget.maxChars) } }
}

function frameHeader(frame: TabFrame): string {
  return `\n--- iframe frame=${frame.frameId} parent=${frame.parentFrameId} origin=${frameOrigin(frame)} ---`
}

function stripDuplicateSnapshotPrompt(status: string): string {
  return status.replace(/ Call browser_snapshot again after (?:navigation settles|the page loads|it loads)\.$/, '')
}

/**
 * Policy hooks of in-flight page calls, for the snapshot taken after a
 * navigation they caused (threaded by call object so the long dispatch
 * signatures stay unchanged).
 */
const landingPolicies = new WeakMap<ToolCall, CallPolicyHook>()

/**
 * Calls whose result carries console text collected for the whole tab while
 * the debugger was attached. That text can come from any frame and quote
 * anything the page talked to, so such a result is never exempt from taint
 * (policy-runtime.ts). Keyed by the call object, like {@link landingPolicies}.
 */
const consoleQuotingCalls = new WeakSet<ToolCall>()

/** Whether the result of `call` carries console errors of its tab. */
export function callQuotedConsole(call: ToolCall): boolean {
  return consoleQuotingCalls.has(call)
}

/**
 * Site policy for the page a navigation actually landed on (redirects,
 * script navigations, and child frames included): undefined when it may be
 * snapshotted, otherwise the answer to return instead — no page content.
 */
function landedPageWithheld(
  call: ToolCall,
  frames: TabFrame[],
  status: string,
  policy: CallPolicyHook | undefined,
): ToolAnswer | undefined {
  if (policy === undefined) return undefined
  const snapshotCall: ToolCall = { ...call, name: 'browser_snapshot', args: {} }
  const decision = policy(snapshotCall, callPolicyTargets(snapshotCall, frames))
  if (decision.kind === 'deny') {
    return { ok: true, result: { text: `${stripDuplicateSnapshotPrompt(status)}\nThe navigation landed on a blocked site; no page content was captured. ${decision.message}` } }
  }
  if (decision.kind === 'force') {
    return { ok: true, result: { text: `${stripDuplicateSnapshotPrompt(status)}\nThe page it landed on needs the user's approval before it is read (site policy), so no snapshot was captured. Call browser_snapshot to request it.` } }
  }
  return undefined
}

async function snapshotAfterNavigation(
  tabId: number,
  call: ToolCall,
  status: string,
  budget: ContentBudget,
  targetStillAllowed?: () => boolean,
  policy: CallPolicyHook | undefined = landingPolicies.get(call),
): Promise<ToolAnswer | undefined> {
  const prefix = `${stripDuplicateSnapshotPrompt(status)}\n${NAVIGATION_SNAPSHOT_GUIDANCE}`
  const snapshotMaxChars = budget.maxChars - prefix.length - 2
  const frames = await listTabFrames(tabId, undefined)
  if (targetStillAllowed?.() === false) return targetChanged()
  const withheld = landedPageWithheld(call, frames, status, policy)
  if (withheld !== undefined) return withheld
  if (snapshotMaxChars < 500) return undefined
  const answer = await snapshotAllFrames(
    tabId,
    frames,
    { ...call, name: 'browser_snapshot', args: {} },
    { ...budget, maxChars: snapshotMaxChars },
  )
  const snapshot = answerText(answer)
  if (snapshot === undefined) return undefined
  return { ok: true, result: { text: `${prefix}\n\n${snapshot}` } }
}

/** Require a usable trusted-input runtime, or fail with the stable code. */
function requireInput(runtime: InputRuntime | undefined): InputRuntime {
  if (!usableInput(runtime)) {
    throw new InputError(
      'input-unavailable',
      'This browser has no trusted input channel (it needs the Chrome debugger). '
      + 'Target elements by index or selector instead, or install the Chrome build.',
    )
  }
  return runtime
}

/** Focus (and optionally select) the addressed target before trusted input. */
async function prepareInputTarget(
  tabId: number,
  frame: TabFrame,
  args: Record<string, unknown>,
  select: 'none' | 'contents' | 'end',
): Promise<void> {
  if (args.index === undefined && typeof args.selector !== 'string') return
  await sendInputSetup(tabId, frame, {
    op: 'prepare',
    ...(args.index === undefined ? {} : { index: args.index as number }),
    ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
    select,
  })
}

/** Validated `paths` argument for `browser_upload`. */
function requestedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InputError('bad-args', 'paths must be a non-empty list of local file paths.')
  }
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new InputError('bad-args', 'paths must be a non-empty list of local file paths.')
    }
    paths.push(entry)
  }
  return paths
}

/** Trusted keyboard: real key events, including held modifiers. */
async function trustedPress(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget,
  runtime: InputRuntime | undefined,
  includePageDelta: boolean,
): Promise<ToolAnswer | undefined> {
  const args = call.args
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '') throw new InputError('bad-args', 'key must not be empty.')
  if (args.action !== undefined && args.action !== 'press' && args.action !== 'down' && args.action !== 'up') {
    throw new InputError('bad-args', 'action must be press, down, or up.')
  }
  const action = args.action === 'down' || args.action === 'up' ? args.action : 'press'
  const modifiers = requestedModifiers(args)
  const repeat = args.repeat === undefined ? 1 : args.repeat
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
    throw new InputError('bad-args', 'repeat must be an integer between 1 and 100.')
  }
  const input = requireInput(runtime)
  await prepareInputTarget(tabId, frame, args, 'none')
  await input.run(tabId, async (client) => {
    await withFocusEmulation(client, async () => {
      await dispatchKey(client, inputStates.get(tabId), { key, action, modifiers, repeat })
    })
  })
  const chord = modifiers.length === 0 ? key : `${modifiers.join('+')}+${key}`
  return settleAfterInput(tabId, frame, `sent key "${chord}"${repeat > 1 ? ` x${repeat}` : ''}`, budget, includePageDelta)
}

/** Trusted text: a caret insertion or per-character key events. */
async function trustedType(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget,
  runtime: InputRuntime | undefined,
  includePageDelta: boolean,
): Promise<ToolAnswer | undefined> {
  const args = call.args
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new InputError('bad-args', 'text must not be empty.')
  const mode = args.mode === 'keystrokes' ? 'keystrokes' : 'insert'
  const input = requireInput(runtime)
  const selection = args.replace === true ? 'contents' : args.mode === 'insert' || args.mode === 'keystrokes' ? 'none' : 'end'
  await prepareInputTarget(tabId, frame, args, selection)
  await input.run(tabId, async (client) => {
    await withFocusEmulation(client, async () => {
      if (mode === 'keystrokes') await typeAsKeystrokes(client, inputStates.get(tabId), text)
      else await insertTextAtCaret(client, text)
    })
  })
  return settleAfterInput(
    tabId,
    frame,
    `entered ${text.length} characters into ${describeTarget(args)} (${mode})`,
    budget,
    includePageDelta,
  )
}

/** Clipboard write (host path) and system-clipboard paste (trusted path). */
async function trustedClipboard(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget,
  runtime: InputRuntime | undefined,
  includePageDelta: boolean,
): Promise<ToolAnswer | undefined> {
  const args = call.args
  const text = typeof args.text === 'string' ? args.text : ''
  const html = typeof args.html === 'string' && args.html !== '' ? args.html : undefined
  if (args.action === 'write') {
    if (text === '' && html === undefined) throw new InputError('bad-args', 'text or html is required for a clipboard write.')
    const outcome = await writeClipboard({ text, ...(html === undefined ? {} : { html }) })
    return { ok: true, result: { text: describeClipboardWrite(outcome) } }
  }
  const input = requireInput(runtime)
  if (text !== '' || html !== undefined) {
    await writeClipboard({ text, ...(html === undefined ? {} : { html }) })
  }
  await prepareInputTarget(tabId, frame, args, 'none')
  await input.run(tabId, async (client) => {
    await withFocusEmulation(client, async () => {
      await sendPasteShortcut(client, inputStates.get(tabId), navigator.userAgent)
    })
  })
  return settleAfterInput(tabId, frame, `pasted the system clipboard into ${describeTarget(args)}`, budget, includePageDelta)
}

/** File attachment: mark the input, let the browser process read the paths. */
async function trustedUpload(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  runtime: InputRuntime | undefined,
): Promise<ToolAnswer | undefined> {
  const args = call.args
  if (args.index === undefined && typeof args.selector !== 'string') {
    throw new InputError('bad-args', 'browser_upload needs index or selector for the file input.')
  }
  const paths = requestedPaths(args.paths)
  const input = requireInput(runtime)
  const token = uploadToken()
  const mark = await sendInputSetup(tabId, frame, {
    op: 'upload-mark',
    token,
    ...(args.index === undefined ? {} : { index: args.index as number }),
    ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
  })
  if (mark.op !== 'upload-mark') {
    throw new InputSetupError('action-failed', 'The page returned an unexpected upload result.')
  }
  try {
    await input.run(tabId, async (client) => {
      if (frame.frameId === 0) {
        await setInputFiles(client, mark.selector, paths)
        return
      }
      const target = await resolveDebuggerFrame(client, tabId, frame)
      await setInputFiles(target.client, mark.selector, paths, target.uniqueId)
    })
  } finally {
    void sendInputSetup(tabId, frame, { op: 'upload-clear', token }).catch(() => undefined)
  }
  return {
    ok: true,
    result: { text: `Attached ${paths.length} file(s) to ${describeTarget(args)}.` },
  }
}

/**
 * Dispatch one call through the trusted input channel.
 *
 * @returns the answer, or undefined when the call should fall back to the
 *   content script's synthetic path.
 */
async function dispatchTrustedInput(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget,
  runtime: InputRuntime | undefined,
  includePageDelta: boolean,
): Promise<ToolAnswer | undefined> {
  const route = inputRoute(call)
  if (route === 'content') return undefined
  if (route === 'trusted' && !usableInput(runtime)) return undefined
  try {
    switch (call.name) {
      case 'browser_clipboard':
        return await trustedClipboard(tabId, frame, call, budget, runtime, includePageDelta)
      case 'browser_upload':
        return await trustedUpload(tabId, frame, call, runtime)
      case 'browser_press':
        return await trustedPress(tabId, frame, call, budget, runtime, includePageDelta)
      case 'browser_type':
        return await trustedType(tabId, frame, call, budget, runtime, includePageDelta)
      case 'browser_click':
        return await trustedClick(pointerContext(tabId, frame, call, budget, runtime, includePageDelta))
      default:
        return undefined
    }
  } catch (error: unknown) {
    const mapped = trustedFailure(error)
    if (mapped !== undefined) return mapped
    throw error
  }
}

async function dispatchOnce(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  includeActionDelta: boolean = false,
  commitAction?: () => void,
  rollbackActionCommit?: () => void,
  inputRuntime?: InputRuntime,
  dialogs?: DialogRuntime,
): Promise<ToolAnswer> {
  // Chrome hands a dialog only to debugger clients that had the Page domain
  // enabled when it opened, so arm before actions that commonly open one.
  const release = dialogs !== undefined && DIALOG_ARMED_TOOLS.has(call.name) && !isCancelled(call, signal)
    ? await dialogs.arm(tabId)
    : undefined
  try {
    return await dispatchOnceArmed(
      tabId, frames, call, budget, signal, targetStillAllowed, includeActionDelta,
      commitAction, rollbackActionCommit, inputRuntime, dialogs,
    )
  } finally {
    release?.()
  }
}

async function dispatchOnceArmed(
  tabId: number,
  frames: TabFrame[],
  call: ToolCall,
  budget: ContentBudget,
  signal: AbortSignal | undefined,
  targetStillAllowed: (() => boolean) | undefined,
  includeActionDelta: boolean,
  commitAction: (() => void) | undefined,
  rollbackActionCommit: (() => void) | undefined,
  inputRuntime: InputRuntime | undefined,
  dialogs: DialogRuntime | undefined,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (call.name === 'browser_snapshot') return snapshotAllFrames(tabId, frames, call, budget)

  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  if (frame === undefined) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  const route = inputRoute(call)
  const syntheticFallback = route === 'trusted'
  const hasSnapshotBaseline = snapshotDocumentsByTab.get(tabId)?.get(frameId) === frameDocumentKey(frame)
  // Sharing allows page-authored verification details even without a baseline.
  const shareContent = includeActionDelta && ACTION_DELTA_TOOLS.has(call.name)
  const stateChangingAction = STATE_CHANGING_PAGE_TOOLS.has(call.name)
  const pointer = pointerContext(tabId, frame, call, budget, inputRuntime, includeActionDelta && hasSnapshotBaseline)
  if (call.name === 'browser_hover' || call.name === 'browser_drag') {
    if (isCancelled(call, signal)) return cancelled()
    commitAction?.()
    const run = async (): Promise<ToolAnswer> => {
      try {
        return (call.name === 'browser_hover' ? await dispatchHover(pointer) : await dispatchDrag(pointer))
      } catch (error: unknown) {
        const mapped = trustedFailure(error)
        if (mapped !== undefined) return mapped
        throw error
      }
    }
    const guarded = await guardPage(dialogs, tabId, frame, run(), signal)
    return guarded.ok ? withDialogNote(guarded.value, guarded.dialog, dialogs) : guarded.answer
  }
  // Every click is hit-tested first: a covered target is refused instead of
  // clicking whatever lies on top of it.
  let clickCheck: Awaited<ReturnType<typeof precheckClick>> | undefined
  if (call.name === 'browser_click' && route === 'content') {
    clickCheck = await precheckClick(pointer, clickMayRetry(call.args, inputRuntime))
    if (clickCheck.kind === 'refuse') return clickCheck.answer
  }
  if (route !== 'content') {
    // Commit before dispatching: a trusted gesture cannot be withdrawn once the
    // browser has delivered it, so the deadline must not abort it mid-flight.
    if (stateChangingAction) commitAction?.()
    const trustedWatch = stateChangingAction ? watchOpenedTabs(tabId) : undefined
    const trustedConsoleMark = stateChangingAction ? consoleErrorMark(tabId) : undefined
    let guarded: Guarded<ToolAnswer | undefined>
    try {
      guarded = await guardPage(
        dialogs, tabId, frame,
        dispatchTrustedInput(tabId, frame, call, budget, inputRuntime, includeActionDelta && hasSnapshotBaseline),
        signal,
      )
    } finally {
      trustedWatch?.stop()
    }
    if (!guarded.ok) return guarded.answer
    const trusted = guarded.value
    if (trusted !== undefined) {
      const errors = trustedConsoleMark === undefined ? [] : consoleErrorsSince(tabId, trustedConsoleMark)
      if (errors.length > 0) consoleQuotingCalls.add(call)
      return withDialogNote(withSideEffects(trusted, trustedWatch?.stop() ?? [], errors, shareContent, budget.maxChars), guarded.dialog, dialogs)
    }
    if (!syntheticFallback) {
      return inputUnavailable('This browser has no trusted input channel for this action.')
    }
  }
  if (call.name === 'browser_extract') {
    return dispatchExtract(tabId, frame, call, budget, signal, targetStillAllowed, commitAction)
  }
  if (call.name === 'browser_wait' && typeof call.args.urlMatches === 'string' && call.args.urlMatches !== '') {
    const waited = await waitForTabUrl(tabId, call, signal)
    if (waited.answer !== undefined) return waited.answer
    if (!waitHasPageConditions(call.args)) return { ok: true, result: { text: waited.status } }
    // The remaining conditions run in the (possibly new) document.
    const refreshed = (await listTabFrames(tabId, undefined)).find((candidate) => candidate.frameId === frameId)
    if (refreshed === undefined) return unavailable(`Frame ${frameId} disappeared while waiting. Call browser_snapshot again.`)
    const rest = await dispatchOnce(tabId, [refreshed], {
      ...call,
      args: { ...withoutUrlCondition(call.args), timeoutMs: waited.remainingMs },
    }, budget, signal, targetStillAllowed, includeActionDelta, commitAction, rollbackActionCommit, inputRuntime)
    const restText = answerText(rest)
    return restText === undefined ? rest : { ok: true, result: { text: `${waited.status} ${restText}` } }
  }
  // The effect watch (a MutationObserver in the page) must end on every exit path.
  const pendingWatch = clickCheck?.kind === 'proceed' ? clickCheck.watch : undefined
  const endPendingWatch = (): void => {
    if (pendingWatch !== undefined) void finishWatch(pointer, pendingWatch, 0)
  }
  // No await occurs between this guard and tabs.sendMessage, so an expired
  // approval cannot cross the final state-changing dispatch boundary.
  if (isCancelled(call, signal)) {
    endPendingWatch()
    return cancelled()
  }
  if (targetStillAllowed?.() === false) {
    endPendingWatch()
    return targetChanged()
  }
  const requestPageDelta = includeActionDelta && hasSnapshotBaseline && ACTION_DELTA_TOOLS.has(call.name)
  const tabWatch = stateChangingAction ? watchOpenedTabs(tabId) : undefined
  const consoleMark = stateChangingAction ? consoleErrorMark(tabId) : undefined
  const navigationWait = includeActionDelta && isNavigationCandidateTool(call.name)
    ? waitForNextDocumentReady(tabId, frameId, frame.documentId, signal)
    : undefined
  let response: unknown
  let dialogDuringAction: OpenDialog | undefined
  try {
    if (stateChangingAction) commitAction?.()
    const guarded = await guardPage(dialogs, tabId, frame, sendAction(
      tabId,
      call,
      frame,
      requestPageDelta ? budget : undefined,
      requestPageDelta,
      shareContent,
    ), signal)
    if (!guarded.ok) {
      navigationWait?.cancel()
      tabWatch?.stop()
      endPendingWatch()
      return guarded.answer
    }
    response = guarded.value
    dialogDuringAction = guarded.dialog
  } catch (error: unknown) {
    if (stateChangingAction && contentScriptReceiverMissing(error)) rollbackActionCommit?.()
    // A click that submits a form (or a handler that navigates) can replace
    // the document before the content script answers: the action ran and the
    // page moved on. Report that, not a failure.
    const navigated = stateChangingAction && !contentScriptReceiverMissing(error) && !isCancelled(call, signal)
      && await frameNavigatedAway(tabId, frame)
    if (!navigated) {
      navigationWait?.cancel()
      tabWatch?.stop()
      endPendingWatch()
      throw error
    }
    response = { ok: true, result: { text: navigatedDuringActionStatus(call), navigationPending: true } }
  }
  const openedTabs = tabWatch?.stop() ?? []
  if (isCancelled(call, signal)) {
    navigationWait?.cancel()
    endPendingWatch()
    return cancelled()
  }
  if (!isToolAnswer(response)) {
    navigationWait?.cancel()
    endPendingWatch()
    return unavailable('The page content script returned an invalid response.')
  }
  const rawText = answerText(response)
  if (rawText === undefined) {
    navigationWait?.cancel()
    if (pendingWatch !== undefined) await finishWatch(pointer, pendingWatch, 0)
    return response
  }
  // A synthetic click that changed nothing observable is never re-sent
  // automatically (its handler may have run invisibly; a second activation
  // would repeat it): the result says how to ask for real input instead.
  let effectHint = ''
  if (clickCheck?.kind === 'proceed' && pendingWatch !== undefined && !answerNavigationPending(response)) {
    const report = await finishWatch(pointer, pendingWatch)
    if (shouldSuggestTrusted(clickCheck.measured, report)) effectHint = TRUSTED_HINT
  } else if (pendingWatch !== undefined) {
    await finishWatch(pointer, pendingWatch, 0)
  }
  const consoleErrors = consoleMark === undefined ? [] : consoleErrorsSince(tabId, consoleMark)
  if (consoleErrors.length > 0) consoleQuotingCalls.add(call)
  const text = `${syntheticFallback ? `${rawText} (synthetic)` : rawText}${effectHint}${describeSideEffects(openedTabs, consoleErrors, shareContent)}`
  if (answerNavigationPending(response) && navigationWait !== undefined) {
    // A "leave site?" dialog stops the navigation: report it at once instead
    // of waiting for a document that cannot arrive.
    const leaving = dialogs?.watch(tabId)
    const ready = await (leaving === undefined
      ? navigationWait.ready
      : Promise.race([navigationWait.ready, leaving.opened.then((dialog) => { dialogDuringAction = dialog; navigationWait.cancel(); return false })]))
    leaving?.cancel()
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (ready) {
      try {
        const snapshot = await snapshotAfterNavigation(tabId, call, text, budget, targetStillAllowed)
        if (snapshot !== undefined) return snapshot
      } catch {
        // Preserve the successful navigation status when the replacement page
        // becomes unavailable before its opportunistic snapshot completes.
      }
    }
  } else {
    navigationWait?.cancel()
  }
  if (call.name === 'browser_get_text') {
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  }
  const contentParts = [
    requestPageDelta || shareContent ? answerPageContent(response) : undefined,
    shareContent && consoleErrors.length > 0 ? renderConsoleErrors(consoleErrors) : undefined,
  ].filter((part): part is string => part !== undefined && part !== '')
  const pageContent = contentParts.length === 0 ? undefined : contentParts.join('\n\n')
  return withDialogNote({
    ok: true,
    result: {
      text: pageContent === undefined ? text : wrapActionDelta(text, pageContent, frame, budget.maxChars),
    },
  }, dialogDuringAction, dialogs)
}

// ---- Content tools: extraction, conditional waits, action side effects ----

/** Tabs a page opened (window.open, target=_blank) while one action ran. */
function watchOpenedTabs(tabId: number): { stop: () => number[] } {
  const onCreated = chrome.tabs?.onCreated
  if (onCreated === undefined) return { stop: () => [] }
  const opened: number[] = []
  const listener = (tab: chrome.tabs.Tab): void => {
    if (tab.openerTabId === tabId && tab.id !== undefined) opened.push(tab.id)
  }
  onCreated.addListener(listener)
  let stopped = false
  return {
    stop: () => {
      if (!stopped) {
        stopped = true
        onCreated.removeListener(listener)
      }
      return [...opened]
    },
  }
}

/** The last console entry index before an action, when developer-tools capture is on. */
function consoleErrorMark(tabId: number): number | undefined {
  const entries = capturedConsoleEntries(tabId)
  if (entries === undefined) return undefined
  return entries.reduce((max, entry) => Math.max(max, entry.index), 0)
}

/** Console errors and uncaught exceptions recorded after a mark. */
function consoleErrorsSince(tabId: number, mark: number): ConsoleEntry[] {
  return (capturedConsoleEntries(tabId) ?? [])
    .filter((entry) => entry.index > mark && (entry.level === 'error' || entry.level === 'exception'))
}

const MAX_REPORTED_CONSOLE_ERRORS = 5

function renderConsoleErrors(errors: ConsoleEntry[]): string {
  const lines = errors.slice(0, MAX_REPORTED_CONSOLE_ERRORS).map((entry) => `  [${entry.level}] ${entry.text.slice(0, 300)}`)
  const more = errors.length > MAX_REPORTED_CONSOLE_ERRORS ? `\n  …${errors.length - MAX_REPORTED_CONSOLE_ERRORS} more` : ''
  return `Console errors during the action:\n${lines.join('\n')}${more}`
}

/** Extension-authored facts about an action's side effects (no page text). */
function describeSideEffects(openedTabs: number[], consoleErrors: ConsoleEntry[], shareContent: boolean): string {
  const facts: string[] = []
  if (openedTabs.length > 0) {
    facts.push(`The page opened ${openedTabs.length === 1 ? 'a new tab' : `${openedTabs.length} new tabs`} (tabId ${openedTabs.join(', ')}); call browser_follow_tab to control it.`)
  }
  if (consoleErrors.length > 0) {
    facts.push(`${consoleErrors.length} console error(s) were logged during the action${shareContent ? '' : '; read them with browser_console_logs'}.`)
  }
  return facts.length === 0 ? '' : ` ${facts.join(' ')}`
}

/**
 * Append side effects to an answer produced outside the content script
 * (trusted input): opened tabs and console errors. Console text stays inside
 * a fresh untrusted boundary and only under page sharing.
 */
function withSideEffects(
  answer: ToolAnswer,
  openedTabs: number[],
  consoleErrors: ConsoleEntry[],
  shareContent: boolean,
  maxChars: number,
): ToolAnswer {
  const text = answerText(answer)
  const facts = describeSideEffects(openedTabs, consoleErrors, shareContent)
  if (text === undefined || facts === '') return answer
  const quoted = shareContent && consoleErrors.length > 0
    ? `\n\n${wrapUntrustedContent(renderConsoleErrors(consoleErrors), Math.max(500, Math.floor(maxChars / 4)))}`
    : ''
  return { ...answer, result: { ...(answer.result as object), text: `${text}${facts}${quoted}` } }
}

/** Default and maximum time a browser_wait condition may take. */
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const MAX_WAIT_TIMEOUT_MS = 25_000
const URL_POLL_MS = 100

/** Whether a wait also has conditions that must be checked inside the page. */
function waitHasPageConditions(args: Record<string, unknown>): boolean {
  return (typeof args.text === 'string' && args.text !== '')
    || (typeof args.selector === 'string' && args.selector !== '')
    || args.networkIdle === true
}

function withoutUrlCondition(args: Record<string, unknown>): Record<string, unknown> {
  const { urlMatches: _urlMatches, ...rest } = args
  return rest
}

/** A URL condition: `/regex/flags`, else a plain substring. */
function urlMatcher(pattern: string): ((url: string) => boolean) | undefined {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern)
  if (regex === null) return (url) => url.includes(pattern)
  try {
    const compiled = new RegExp(regex[1]!, regex[2])
    return (url) => compiled.test(url)
  } catch {
    return undefined
  }
}

/**
 * Wait until the controlled tab's URL matches. Polled from the background
 * because a cross-document navigation would destroy a content-script waiter.
 */
async function waitForTabUrl(
  tabId: number,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<{ answer?: ToolAnswer; status: string; remainingMs: number }> {
  const pattern = String(call.args.urlMatches)
  const matches = urlMatcher(pattern)
  if (matches === undefined) {
    return { answer: { ok: false, error: { code: 'bad-args', message: `urlMatches is not a valid /regex/: ${pattern}` } }, status: '', remainingMs: 0 }
  }
  const requested = typeof call.args.timeoutMs === 'number' && call.args.timeoutMs > 0 ? call.args.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS
  const timeoutMs = Math.min(requested, MAX_WAIT_TIMEOUT_MS)
  const startedAt = Date.now()
  for (;;) {
    if (isCancelled(call, signal)) return { answer: cancelled(), status: '', remainingMs: 0 }
    let url = ''
    try {
      url = (await chrome.tabs.get(tabId)).url ?? ''
    } catch {
      return { answer: unavailable('The controlled tab closed while waiting.'), status: '', remainingMs: 0 }
    }
    const elapsed = Date.now() - startedAt
    if (matches(url)) {
      return { status: `URL matched ${pattern} after ${elapsed}ms.`, remainingMs: Math.max(1, timeoutMs - elapsed) }
    }
    if (elapsed >= timeoutMs) {
      return {
        answer: { ok: false, error: { code: 'action-failed', message: `browser_wait timed out after ${elapsed}ms: the URL did not match ${pattern}.` } },
        status: '',
        remainingMs: 0,
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, Math.min(URL_POLL_MS, timeoutMs - elapsed)) })
  }
}

/** Pagination request for browser_extract. */
interface PaginateSpec {
  nextSelector: string
  maxPages: number
}

const DEFAULT_EXTRACT_PAGES = 5
const MAX_EXTRACT_PAGES = 20
const MAX_EXTRACT_ROWS = 10_000
/** Rows shown inline when the caller does not save to a file. */
const INLINE_EXTRACT_ROWS = 100
/** Rows sampled into the result when the bridge saves the full set. */
const SAVED_EXTRACT_SAMPLE = 5
const SAME_PAGE_RETRIES = 4
const SAME_PAGE_RETRY_MS = 400

function parsePaginate(value: unknown): PaginateSpec | ToolAnswer | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: { code: 'bad-args', message: 'paginate must be { nextSelector, maxPages }.' } }
  }
  const record = value as Record<string, unknown>
  if (typeof record.nextSelector !== 'string' || record.nextSelector === '') {
    return { ok: false, error: { code: 'bad-args', message: 'paginate.nextSelector must be a CSS selector for the next-page control.' } }
  }
  const maxPages = record.maxPages ?? DEFAULT_EXTRACT_PAGES
  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1) {
    return { ok: false, error: { code: 'bad-args', message: 'paginate.maxPages must be a positive integer.' } }
  }
  return { nextSelector: record.nextSelector, maxPages: Math.min(maxPages, MAX_EXTRACT_PAGES) }
}

/** Rows one content-script extraction returned. */
interface ExtractedPage {
  columns: string[]
  rows: Record<string, unknown>[]
}

function extractedPage(answer: unknown): ExtractedPage | undefined {
  if (!isToolAnswer(answer) || !answer.ok || typeof answer.result !== 'object' || answer.result === null) return undefined
  const data = (answer.result as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  const { columns, rows } = data as { columns?: unknown; rows?: unknown }
  if (!Array.isArray(columns) || !Array.isArray(rows)) return undefined
  return {
    columns: columns.map(String),
    rows: rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row)),
  }
}

/**
 * browser_extract: read rows from the frame, optionally clicking a "next"
 * control between pages. Pagination runs here rather than in the page so a
 * full document navigation between pages does not lose the collected rows.
 */
async function dispatchExtract(
  tabId: number,
  frame: TabFrame,
  call: ToolCall,
  budget: ContentBudget,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
  commitAction?: () => void,
): Promise<ToolAnswer> {
  const paginate = parsePaginate(call.args.paginate)
  if (paginate !== undefined && 'ok' in paginate) return paginate
  const maxPages = paginate?.maxPages ?? 1
  const extractArgs: Record<string, unknown> = {
    ...call.args.schema === undefined ? {} : { schema: call.args.schema },
    ...call.args.table === undefined ? {} : { table: call.args.table },
    ...call.args.limit === undefined ? {} : { limit: call.args.limit },
  }
  let current = frame
  let lastReadUrl = frame.url
  const columns: string[] = []
  const rows: Record<string, unknown>[] = []
  let previousSignature: string | undefined
  let pages = 0
  let stopReason = maxPages === 1 ? '' : `reached maxPages=${maxPages}`
  // One approval covers one origin: the frame's (and, for a subframe, the
  // top document's) origin when the call was approved.
  const approvedOrigin = originFromUrl(frame.url)
  const approvedTopOrigin = paginate === undefined || frame.frameId === 0
    ? undefined
    : originFromUrl((await listTabFrames(tabId, undefined)).find((candidate) => candidate.frameId === 0)?.url ?? '')
  /** Re-read the frame after a next-page click; a reason to stop, or the current frame. */
  const recheckFrame = async (): Promise<TabFrame | string> => {
    const frames = await listTabFrames(tabId, undefined)
    const refreshed = frames.find((candidate) => candidate.frameId === current.frameId)
    if (refreshed === undefined) return 'the frame disappeared after navigation'
    const top = frames.find((candidate) => candidate.frameId === 0)
    const landed = originFromUrl(refreshed.url)
    if (approvedOrigin === undefined || landed !== approvedOrigin
      || (approvedTopOrigin !== undefined && originFromUrl(top?.url ?? '') !== approvedTopOrigin)) {
      return 'the next page is on another origin; nothing was read there (call browser_extract again on that page if needed)'
    }
    return refreshed
  }
  while (pages < maxPages) {
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    let page: ExtractedPage | undefined
    for (let attempt = 0; ; attempt += 1) {
      const answer = await sendAction(tabId, { ...call, args: extractArgs }, current)
      page = extractedPage(answer)
      if (page === undefined) {
        if (pages === 0) return isToolAnswer(answer) && !answer.ok ? answer : unavailable('The page content script returned an invalid extraction.')
        stopReason = 'the next page could not be read'
        break
      }
      const signature = JSON.stringify(page.rows.slice(0, 3))
      // A client-side pager may re-render a moment after the click settles.
      if (signature !== previousSignature || page.rows.length === 0 || attempt >= SAME_PAGE_RETRIES) {
        if (signature === previousSignature && page.rows.length > 0) {
          stopReason = 'the next control did not change the rows'
          page = undefined
        }
        previousSignature = signature
        break
      }
      await new Promise((resolve) => { setTimeout(resolve, SAME_PAGE_RETRY_MS) })
    }
    if (page === undefined) break
    pages += 1
    lastReadUrl = current.url
    for (const column of page.columns) if (!columns.includes(column)) columns.push(column)
    rows.push(...page.rows.slice(0, MAX_EXTRACT_ROWS - rows.length))
    if (rows.length >= MAX_EXTRACT_ROWS) {
      stopReason = `reached the ${MAX_EXTRACT_ROWS}-row cap`
      break
    }
    if (paginate === undefined || pages >= maxPages) break
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    commitAction?.()
    const navigation = waitForNextDocumentReady(tabId, current.frameId, current.documentId, signal)
    const click = await sendAction(tabId, { ...call, name: 'browser_click', args: { selector: paginate.nextSelector } }, current)
      .catch((error: unknown) => ({ ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } }))
    if (!isToolAnswer(click) || !click.ok) {
      navigation.cancel()
      const detail = isToolAnswer(click) ? click.error?.message ?? '' : ''
      stopReason = `no next page${detail === '' ? '' : ` (${detail})`}`
      break
    }
    if (answerNavigationPending(click)) {
      if (!await navigation.ready) {
        stopReason = 'the next page did not finish loading'
        break
      }
    } else {
      navigation.cancel()
    }
    // Every page is re-bound to the approval, whether or not the click
    // reported a navigation (a script may navigate later, or silently).
    const rechecked = await recheckFrame()
    if (typeof rechecked === 'string') {
      stopReason = rechecked
      break
    }
    if (rechecked.documentId !== current.documentId) previousSignature = undefined
    current = rechecked
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
  }
  const pagesText = paginate === undefined ? '' : ` from ${pages} page(s)`
  const stopped = stopReason === '' ? '' : ` (stopped: ${stopReason})`
  const summary = `Extracted ${rows.length} row(s)${pagesText}${stopped}; ${columns.length} column(s).`
  const saving = typeof call.args.saveTo === 'string' && call.args.saveTo !== ''
  const shown = rows.slice(0, saving ? SAVED_EXTRACT_SAMPLE : INLINE_EXTRACT_ROWS)
  // Column names come from the page (table headers), so they stay inside the boundary.
  const body = [`Columns: ${JSON.stringify(columns)}`, ...shown.map((row) => JSON.stringify(row))].join('\n')
  const note = saving
    ? `Sample of the first ${shown.length} row(s):`
    : rows.length > shown.length
      ? `Showing ${shown.length} of ${rows.length} rows; pass saveTo to write all rows to a file.`
      : 'Rows (one JSON object per line):'
  const text = `${summary}\n${note}\n${wrapUntrustedContent(shown.length === 0 ? `${body}\n(no rows)` : body, Math.max(500, budget.maxChars - summary.length - note.length - 2))}`
  return { ok: true, result: { text, data: { columns, rows, pages, url: lastReadUrl } } }
}

function requestedTabId(args: Record<string, unknown>): number | undefined {
  const value = args.tabId
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tabUrl(tab: chrome.tabs.Tab): string {
  return tab.url ?? tab.pendingUrl ?? ''
}

function approvalDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    const display = url.protocol === 'http:' || url.protocol === 'https:'
      ? `${url.origin}${url.pathname}`
      : `${url.protocol}//${url.host}${url.pathname}`
    return display.replace(/\s+/g, ' ').slice(0, 160)
  } catch {
    return '(unknown URL)'
  }
}

function tabManagementApproval(call: ToolCall, tab?: chrome.tabs.Tab): ApprovalPrompt {
  const locale = getUiLocale()
  if (call.name === 'browser_list_tabs') {
    return {
      kind: 'read',
      action: call.name,
      summary: locale === 'zh' ? '读取所有已打开标签页的标题和链接' : 'Read the titles and URLs of all open tabs',
      origins: [],
      canTrust: false,
    }
  }
  const url = tab === undefined ? '' : tabUrl(tab)
  const origin = originFromUrl(url)
  const display = approvalDisplayUrl(url)
  return {
    kind: 'action',
    action: call.name,
    summary: call.name === 'browser_follow_tab'
      ? (call.args.activate === true
        ? (locale === 'zh' ? `跟随并切换到标签页 ${tab?.id ?? '?'}：${display}` : `Follow and activate tab ${tab?.id ?? '?'}: ${display}`)
        : (locale === 'zh' ? `跟随标签页 ${tab?.id ?? '?'}：${display}` : `Follow tab ${tab?.id ?? '?'}: ${display}`))
      : (locale === 'zh' ? `关闭标签页 ${tab?.id ?? '?'}：${display}` : `Close tab ${tab?.id ?? '?'}: ${display}`),
    origins: origin === undefined ? [] : [origin],
    canTrust: false,
    // Bound to the arguments and the tab's exact URL at prompt time.
    binding: approvalBinding({ action: call.name, args: call.args, origins: [url] }),
  }
}

async function authorizeTabManagement(
  prompt: ApprovalPrompt,
  unrestrictedAccess: boolean,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolAnswer | undefined> {
  if (unrestrictedAccess) return undefined
  const authorization = authorize === undefined ? 'unavailable' : await authorize(prompt)
  if (isCancelled(call, signal)) return cancelled()
  return authorization === 'approved' ? undefined : approvalFailure(prompt, authorization)
}

async function findTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }
}

async function dispatchTabManagementTool(
  call: ToolCall,
  budget: ContentBudget,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  context: TabManagementContext,
): Promise<ToolAnswer> {
  if (call.name === 'browser_downloads') return dispatchDownloadsTool(call, budget, authorize, signal, context)
  if (call.name === 'browser_list_tabs') {
    const approval = tabManagementApproval(call)
    const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
    if (rejected !== undefined) return rejected
    const tabs = await chrome.tabs.query({})
    if (isCancelled(call, signal)) return cancelled()
    const records = tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .sort((left, right) => left.windowId - right.windowId || left.index - right.index)
      .map((tab) => {
        // Blocked sites and origins outside the managed allowlist: not even
        // their title or address reaches the model.
        const hidden = context.tabHidden?.(tabUrl(tab)) === true
        return {
          tabId: tab.id,
          windowId: tab.windowId,
          index: tab.index,
          active: tab.active,
          controlled: tab.id === context.controlledTabId,
          title: hidden ? TAB_HIDDEN : tab.title ?? '',
          url: hidden ? TAB_HIDDEN : tabUrl(tab),
        }
      })
    return {
      ok: true,
      result: { text: wrapUntrustedContent(JSON.stringify({ tabs: records }, null, 2), budget.maxChars) },
    }
  }

  const tabId = requestedTabId(call.args)
  if (tabId === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'tabId must be a non-negative safe integer returned by browser_list_tabs.' } }
  }
  const before = await findTab(tabId)
  if (before === undefined) return unavailable(`Tab ${tabId} is no longer open. Call browser_list_tabs again.`)
  if (context.policy !== undefined) {
    // Following a tab hands it to the agent (blocked sites refuse); closing it changes it.
    const origin = originFromUrl(tabUrl(before))
    const origins = origin === undefined ? [] : [origin]
    const decision = context.policy(call, call.name === 'browser_close_tab' ? { reads: [], acts: origins } : { reads: origins, acts: [] })
    if (decision.kind === 'deny') return policyDenied(decision.message)
  }
  const approval = tabManagementApproval(call, before)
  const rejected = await authorizeTabManagement(approval, context.unrestrictedAccess, authorize, call, signal)
  if (rejected !== undefined) return rejected
  const current = await findTab(tabId)
  if (current === undefined) return unavailable(`Tab ${tabId} closed while approval was pending. Call browser_list_tabs again.`)
  if (tabUrl(current) !== tabUrl(before)) {
    return unavailable(`Tab ${tabId} navigated while approval was pending. Call browser_list_tabs again before retrying.`)
  }
  if (!context.unrestrictedAccess && tabManagementApproval(call, current).binding !== approval.binding) {
    return unavailable('The request changed while approval was pending. Call the tool again to request a new approval.')
  }
  if (isCancelled(call, signal)) return cancelled()

  if (call.name === 'browser_follow_tab') {
    if (context.followTab === undefined) return unavailable('The browser could not bind the selected tab in this session.')
    const activate = call.args.activate === true
    context.commitAction?.()
    await context.followTab(current)
    if (activate) {
      if (current.windowId !== undefined) {
        try {
          await chrome.windows.update(current.windowId, { focused: true })
        } catch {
          return unavailable(`Tab ${tabId} was followed but its window could not be focused.`)
        }
      }
      try {
        await chrome.tabs.update(tabId, { active: true })
      } catch {
        return unavailable(`Tab ${tabId} was followed but could not be activated.`)
      }
    }
    return {
      ok: true,
      result: {
        text: activate
          ? `Tab ${tabId} is now the controlled and active tab. Call browser_snapshot before operating its page.`
          : `Tab ${tabId} is now the controlled tab. Call browser_snapshot before operating its page.`,
      },
    }
  }
  if (call.name === 'browser_close_tab') {
    try {
      context.commitAction?.()
      await chrome.tabs.remove(tabId)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return unavailable(`Tab ${tabId} could not be closed: ${detail}`)
    }
    return {
      ok: true,
      result: {
        text: tabId === context.controlledTabId
          ? `Closed controlled tab ${tabId}. Call browser_list_tabs and browser_follow_tab before the next page operation.`
          : `Closed tab ${tabId}.`,
      },
    }
  }
  return unavailable(`Unsupported tab-management tool: ${call.name}`)
}

/**
 * `browser_downloads`: always asks (download paths and URLs reveal browsing);
 * the first use also asks the browser for the optional downloads permission.
 */
async function dispatchDownloadsTool(
  call: ToolCall,
  budget: ContentBudget,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  context: TabManagementContext,
): Promise<ToolAnswer> {
  const needsPermission = !(await hasDownloadsPermission())
  if (isCancelled(call, signal)) return cancelled()
  const approval = approvalPromptForCall(call, 'auto', [], undefined, { needsDownloadsPermission: needsPermission })
  if (approval !== undefined && (!context.unrestrictedAccess || needsPermission)) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (authorization !== 'approved') return approvalFailure(approval, authorization)
  }
  try {
    if (needsPermission) context.commitAction?.()
    const text = await runDownloadsTool(call.args, (await hasDownloadsPermission()) ? downloadsApi() : undefined, signal)
    if (isCancelled(call, signal)) return cancelled()
    return { ok: true, result: { text: wrapUntrustedContent(text, budget.maxChars) } }
  } catch (error: unknown) {
    if (error instanceof DownloadsError) return { ok: false, error: { code: error.code, message: error.message } }
    throw error
  }
}

/** Parse the model-supplied screenshot capture options. */
function screenshotCaptureOptions(call: ToolCall): { format: 'png' | 'jpeg'; quality: number } | ToolAnswer {
  const format = call.args.format === undefined ? 'png' : call.args.format
  if (format !== 'png' && format !== 'jpeg') {
    return { ok: false, error: { code: 'action-failed', message: 'format must be "png" or "jpeg".' } }
  }
  const quality = call.args.quality === undefined ? 85 : call.args.quality
  if (typeof quality !== 'number' || !Number.isInteger(quality) || quality < 1 || quality > 100) {
    return { ok: false, error: { code: 'action-failed', message: 'quality must be an integer between 1 and 100.' } }
  }
  return { format, quality }
}

/** Decode a captureVisibleTab data URL into base64 pixels and media type. */
function decodeCaptureDataUrl(dataUrl: string): { data: string; mediaType: string } | undefined {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return undefined
  const header = /^data:([^;,]+);base64$/.exec(dataUrl.slice(0, comma))
  if (header === null) return undefined
  const data = dataUrl.slice(comma + 1)
  return data === '' ? undefined : { data, mediaType: header[1] ?? '' }
}

async function measureImageBytes(data: string, mediaType: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }))
    try {
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  } catch {
    // Dimensions are advisory metadata; the capture stays deliverable.
    return undefined
  }
}

/**
 * Capture the controlled tab's viewport. `captureVisibleTab` photographs the
 * active tab of the window, so a controlled-but-inactive tab is a hard error
 * rather than a silent capture of the wrong page.
 */
async function dispatchScreenshot(
  tab: Pick<chrome.tabs.Tab, 'id' | 'url'> & { active?: boolean; windowId?: number },
  call: ToolCall,
  signal?: AbortSignal,
  targetStillAllowed?: () => boolean,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const options = screenshotCaptureOptions(call)
  if ('ok' in options) return options
  let active = tab.active
  let windowId = tab.windowId
  if (active === undefined || windowId === undefined) {
    const fresh = await findTab(tab.id!)
    if (fresh === undefined) return unavailable('The controlled tab closed before the screenshot was captured.')
    active = fresh.active
    windowId = fresh.windowId
  }
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  if (active !== true) {
    return unavailable('The controlled tab is not the active tab of its window, so its viewport cannot be captured. Activate the tab first, then retry.')
  }
  if (windowId === undefined) {
    return unavailable('The controlled tab has no window, so its viewport cannot be captured.')
  }
  // `captureVisibleTab` photographs the last composited frame. A window that is
  // not focused can hand back a stale image that no longer matches the DOM, so
  // fail clearly instead of presenting old pixels as the current state.
  const windowsApi = (globalThis as {
    chrome?: { windows?: { get?: (id: number) => Promise<{ focused?: boolean }> } }
  }).chrome?.windows
  if (typeof windowsApi?.get === 'function') {
    try {
      const win = await windowsApi.get(windowId)
      if (win.focused === false) {
        return unavailable('The browser window is not focused, so a captured frame could be stale. Bring it to the front (browser_follow_tab { activate: true }) and retry.')
      }
    } catch {
      // A closed window is reported by the capture call itself.
    }
  }
  let dataUrl: string
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: options.format,
      ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
    })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return unavailable(`The screenshot could not be captured: ${detail}`)
  }
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const captured = decodeCaptureDataUrl(dataUrl)
  if (captured === undefined) return unavailable('The browser returned the screenshot in an unsupported format.')
  const dimensions = await measureImageBytes(captured.data, captured.mediaType)
  return {
    ok: true,
    result: {
      image: {
        data: captured.data,
        mediaType: captured.mediaType,
        ...dimensions === undefined ? {} : dimensions,
      },
    },
  }
}

/**
 * Dispatch one tool call to the selected tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @param budget - snapshot limits to restore after on-demand content-script injection.
 * @param signal - bridge lifetime; cancellation prevents any not-yet-sent page action.
 * @param targetTab - tab selected by the background affinity controller.
 * @param targetStillAllowed - final fail-closed guard after asynchronous approval/navigation checks.
 * @param tabManagement - access mode and affinity callbacks for tab collection tools.
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget?: ContentBudget,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
  signal?: AbortSignal,
  targetTab?: Pick<chrome.tabs.Tab, 'id' | 'url' | 'title'> & { windowId?: number },
  targetStillAllowed?: () => boolean,
  tabManagement: TabManagementContext = { unrestrictedAccess: false },
): Promise<ToolAnswer> {
  if (call.name === 'browser_open_tab') {
    return unavailable('browser_open_tab must be dispatched through the background open-tab path.')
  }
  if (isCancelled(call, signal)) return cancelled()
  const effectiveBudget = budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }
  if (isTabManagementTool(call.name)) {
    return dispatchTabManagementTool(call, effectiveBudget, authorize, signal, tabManagement)
  }
  // Privacy boundary: with sharing off, no page content may leave the page.
  if (!tabManagement.unrestrictedAccess
    && sharePageContent === 'off'
    && (call.name === 'browser_snapshot' || call.name === 'browser_get_text' || call.name === 'browser_screenshot'
      || call.name === 'browser_extract' || (call.name === 'browser_wait' && isConditionalPageWait(call.args))
      || call.name === 'browser_save_pdf' || call.name === 'browser_pdf_text')) {
    return { ok: false, error: { code: 'action-failed', message: 'Page content sharing is disabled in Settings > Page content sharing.' } }
  }
  const tab = targetTab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (isCancelled(call, signal)) return cancelled()
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
  }
  if (targetStillAllowed?.() === false) return targetChanged()
  const frames = await listTabFrames(tab.id, tab.url)
  if (isCancelled(call, signal)) return cancelled()
  if (targetStillAllowed?.() === false) return targetChanged()
  const frameError = validateFrameTarget(call, frames)
  if (frameError !== undefined) return frameError
  if (!isInjectablePage(tab.url) && !TAB_NATIVE_TOOLS.has(call.name) && call.name !== 'browser_screenshot') {
    return unavailable('The current page DOM is protected by the browser. Only snapshot metadata, navigate, back, forward, and reload are available on this page.')
  }
  const targetError = validateElementTarget(call, tab.id, frames)
  if (targetError !== undefined) return targetError
  const dialogs = tabManagement.dialogs
  const topFrame = frames.find((frame) => frame.frameId === 0)
  let openDialog: OpenDialog | undefined
  if (call.name === 'browser_dialog') {
    const argsError = dialogArgsError(call.args)
    if (argsError !== undefined) return argsError
    if (dialogs === undefined || !dialogs.canAnswer) {
      return inputUnavailable('This browser cannot answer native JavaScript dialogs from the extension (it needs the Chrome debugger). Ask the user to answer or close the dialog, then retry.')
    }
    openDialog = await dialogs.current(tab.id, topFrame)
    if (openDialog === undefined) {
      return { ok: false, error: { code: 'action-failed', message: 'No JavaScript dialog is open in the controlled tab.' } }
    }
  } else if (dialogs !== undefined && !DIALOG_EXEMPT_TOOLS.has(call.name)) {
    // Fail fast: a page blocked by a dialog cannot answer anything else.
    const blocking = await dialogs.current(tab.id, topFrame)
    if (blocking !== undefined) {
      return { ok: false, error: { code: 'action-failed', message: dialogOpenMessage(blocking, dialogs.canAnswer) } }
    }
  }
  if (isCancelled(call, signal)) return cancelled()
  const decision: CallPolicyDecision = tabManagement.policy?.(call, callPolicyTargets(call, frames)) ?? { kind: 'default' }
  if (decision.kind === 'deny') return policyDenied(decision.message)
  // A navigation this call causes is judged again on the page it lands on.
  if (tabManagement.policy !== undefined) landingPolicies.set(call, tabManagement.policy)
  const skipsPrompt = decision.kind === 'trust' || (tabManagement.unrestrictedAccess && decision.kind !== 'force')
  // What the page says the call's element is, asked now: the card (and the
  // timeline) name the element from this, never from the model's arguments.
  const approvalContext: ApprovalContext = openDialog !== undefined
    ? dialogApprovalContext(openDialog)
    : targetsElement(call) && isInjectablePage(tab.url)
      ? await probeTargets(tab.id, call, frames, false)
      : {}
  if (isCancelled(call, signal)) return cancelled()
  // Recomputed after approval and after content-script recovery: the same
  // decision must yield the same card, or the page changed under it.
  const promptFor = (current: TabFrame[], context: ApprovalContext): ApprovalPrompt | undefined => decision.kind === 'force'
    ? forcedApprovalPrompt(call, current, decision.reasons, undefined, context, decision.causes)
    : approvalPromptForCall(call, sharePageContent, current, undefined, context)
  const approval = skipsPrompt ? undefined : promptFor(frames, approvalContext)
  const stepLabel = approval?.stepLabel
    ?? (approvalContext.targets === undefined ? undefined : approvalPromptForCall(call, 'auto', frames, undefined, approvalContext)?.stepLabel)
  if (stepLabel !== undefined) tabManagement.onStepLabel?.(stepLabel)
  if (approval !== undefined) {
    const previewFrame = approvalContext.targets === undefined ? undefined : frames.find((candidate) => candidate.frameId === requestedFrame(call.args))
    if (previewFrame !== undefined) tabManagement.overlay?.armPreview?.(tab.id, previewFrame, call)
    let authorization: ApprovalAuthorization
    try {
      authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    } finally {
      if (previewFrame !== undefined) tabManagement.overlay?.endPreview?.(call)
    }
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    if (authorization !== 'approved') {
      return approvalFailure(approval, authorization)
    }
  }
  let executionFrames = frames
  if (approval !== undefined) {
    executionFrames = await listTabFrames(tab.id, tab.url)
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    let refreshedContext = approvalContext
    if (openDialog !== undefined && dialogs !== undefined) {
      // The approval names one dialog; a different (or no) dialog now means
      // the card no longer describes what would be answered.
      openDialog = await dialogs.current(tab.id, executionFrames.find((frame) => frame.frameId === 0))
      if (openDialog === undefined) {
        return { ok: false, error: { code: 'action-failed', message: 'The dialog closed while approval was pending.' } }
      }
      refreshedContext = dialogApprovalContext(openDialog)
    } else if (approvalContext.targets !== undefined) {
      // The card named an element. Look again: if the locator now names
      // another element, or the element reads differently, the binding below
      // no longer matches and the call is refused.
      const again = await probeTargets(tab.id, call, executionFrames, true)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      refreshedContext = {
        ...approvalContext,
        ...again.targets === undefined ? {} : { targets: again.targets },
        ...again.targetMoved === true ? { targetMoved: true as const } : {},
      }
    }
    const refreshedApproval = promptFor(executionFrames, refreshedContext)
    if (refreshedApproval === undefined
      || !sameApprovalBoundary(approval, refreshedApproval)
      || (approval.kind === 'action' && !sameTargetDocument(call, frames, executionFrames))) {
      return unavailable('The page changed while approval was pending. Call browser_snapshot again before retrying.')
    }
    const refreshedTargetError = validateElementTarget(call, tab.id, executionFrames)
    if (refreshedTargetError !== undefined) return refreshedTargetError
  }
  if (call.name === 'browser_dialog' && openDialog !== undefined && dialogs !== undefined) {
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    return answerDialog(tab.id, call, dialogs, openDialog, tabManagement.commitAction)
  }
  if (call.name === 'browser_save_pdf' || call.name === 'browser_pdf_text') {
    if (isCancelled(call, signal)) return cancelled()
    if (targetStillAllowed?.() === false) return targetChanged()
    try {
      return call.name === 'browser_save_pdf'
        ? await savePagePdf({ ...tab, id: tab.id }, call.args, tabManagement.input)
        : await readTabPdfText({ ...tab, id: tab.id }, call.args, effectiveBudget.maxChars, signal)
    } catch (error: unknown) {
      const mapped = devToolsFailure(error)
      if (mapped !== undefined) return mapped
      throw error
    }
  }
  if (!isInjectablePage(tab.url)) {
    if (call.name === 'browser_screenshot') {
      return unavailable('A screenshot cannot be captured on this page: the browser protects pages outside http and https.')
    }
    return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
      ?? unavailable('The current page DOM is protected by the browser.')
  }
  if (call.name === 'browser_screenshot') {
    const overlay = tabManagement.overlay
    return overlay === undefined
      ? await dispatchScreenshot(tab, call, signal, targetStillAllowed)
      : await overlay.hiddenDuring(tab.id, () => dispatchScreenshot(tab, call, signal, targetStillAllowed))
  }
  if (tabManagement.overlay !== undefined) {
    const frame = executionFrames.find((candidate) => candidate.frameId === requestedFrame(call.args))
    if (frame !== undefined) {
      await tabManagement.overlay.beforeAction(tab.id, frame, call).catch(() => {})
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
    }
  }
  if (tabManagement.expect !== undefined) {
    // A series step: the page is read again right before the action is sent, not as it was when the call arrived or its card was answered.
    if (tabManagement.expect.page !== undefined) {
      executionFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
    }
    const refusal = stepExpectationFailure(call, executionFrames, tabManagement.expect)
    if (refusal !== undefined) return refusal
    stepExpectations.set(call, tabManagement.expect.target)
  }
  try {
    return await dispatchOnce(
      tab.id,
      executionFrames,
      call,
      effectiveBudget,
      signal,
      targetStillAllowed,
      tabManagement.unrestrictedAccess || sharePageContent === 'auto',
      tabManagement.commitAction,
      tabManagement.rollbackActionCommit,
      tabManagement.input,
      tabManagement.dialogs,
    )
  } catch (error: unknown) {
    if (isCancelled(call, signal)) return cancelled()
    const trustedFailureAnswer = devToolsFailure(error)
    if (trustedFailureAnswer !== undefined) return trustedFailureAnswer
    if (!contentScriptReceiverMissing(error)) {
      const detail = error instanceof Error ? error.message : String(error)
      return unavailable(`The browser operation failed after it was dispatched: ${detail}`)
    }
    // Manifest content scripts do not run retroactively in tabs that were
    // already open when an unpacked extension was installed or reloaded.
    // Recover in place so the user never has to refresh and lose page state.
    try {
      await injectContentScript(tab.id)
    } catch {
      return await dispatchTabNativeTool(tab.id, tab.url, tab.title, tab.windowId, call, effectiveBudget, signal, targetStillAllowed, tabManagement.commitAction)
        ?? unavailable('The content script could not be loaded on this page. Its DOM does not support browser operations.')
    }
    try {
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedFrames = await listTabFrames(tab.id, tab.url)
      if (isCancelled(call, signal)) return cancelled()
      if (targetStillAllowed?.() === false) return targetChanged()
      const refreshedTargetError = validateElementTarget(call, tab.id, refreshedFrames)
      if (refreshedTargetError !== undefined) return refreshedTargetError
      // A "do the remaining N" step is held to its page on this second dispatch too: the content script was reloaded in between.
      const refreshedRefusal = tabManagement.expect === undefined ? undefined : stepExpectationFailure(call, refreshedFrames, tabManagement.expect)
      if (refreshedRefusal !== undefined) return refreshedRefusal
      if (approval !== undefined) {
        const refreshedApproval = promptFor(refreshedFrames, approvalContext)
        if (refreshedApproval === undefined
          || !sameApprovalBoundary(approval, refreshedApproval)
          || (approval.kind === 'action' && !sameTargetDocument(call, executionFrames, refreshedFrames))) {
          return unavailable('The page changed while the content script was loading. Call browser_snapshot again before retrying.')
        }
      }
      return await dispatchOnce(
        tab.id,
        refreshedFrames,
        call,
        effectiveBudget,
        signal,
        targetStillAllowed,
        tabManagement.unrestrictedAccess || sharePageContent === 'auto',
        tabManagement.commitAction,
        tabManagement.rollbackActionCommit,
        tabManagement.input,
        tabManagement.dialogs,
      )
    } catch (error: unknown) {
      const trustedFailureAnswer = devToolsFailure(error)
      if (trustedFailureAnswer !== undefined) return trustedFailureAnswer
      const detail = error instanceof Error ? error.message : String(error)
      return unavailable(`The content script did not answer after it was loaded (${detail}). Call browser_snapshot again before retrying.`)
    }
  }
}

function validateFrameTarget(call: ToolCall, frames: TabFrame[]): ToolAnswer | undefined {
  if (call.name === 'browser_snapshot') return undefined
  const frameId = requestedFrame(call.args)
  if (frameId < 0) return { ok: false, error: { code: 'action-failed', message: 'frame must be a non-negative integer.' } }
  if (!frames.some((frame) => frame.frameId === frameId)) {
    return unavailable(`Frame ${frameId} does not exist or has navigated. Call browser_snapshot again.`)
  }
  return undefined
}

const INDEX_TARGETED_TOOLS = new Set([
  'browser_click',
  'browser_select',
  'browser_hover',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_clipboard',
  'browser_upload',
])

function validateElementTarget(call: ToolCall, tabId: number, frames: TabFrame[]): ToolAnswer | undefined {
  // A selector or "the focused element" is self-contained; only
  // a snapshot index needs a snapshot of the same document to resolve.
  const indexed = call.name === 'browser_drag'
    ? dragIndices(call.args).length > 0
    : INDEX_TARGETED_TOOLS.has(call.name) && call.args.index !== undefined
  if (!indexed) return undefined
  const frameId = requestedFrame(call.args)
  const frame = frames.find((candidate) => candidate.frameId === frameId)
  const snapshotted = snapshotDocumentsByTab.get(tabId)?.get(frameId)
  if (frame === undefined || snapshotted === undefined || snapshotted !== frameDocumentKey(frame)) {
    return unavailable('The element reference does not belong to the current document. Call browser_snapshot again for current frame and index values.')
  }
  return undefined
}

/**
 * Whether the prompt recomputed right before execution still describes what
 * the user approved: same kind, action, and origins, and the same payload
 * binding (tool name + arguments + origins + target document).
 */
function sameApprovalBoundary(before: ApprovalPrompt, after: ApprovalPrompt): boolean {
  return before.kind === after.kind
    && before.action === after.action
    && before.origins.length === after.origins.length
    && before.origins.every((origin, index) => origin === after.origins[index])
    && before.binding !== undefined
    && before.binding === after.binding
}

/** Tools whose card names the element they act on. */
const ELEMENT_ACTION_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_hover',
  'browser_drag',
  'browser_upload',
  'browser_press',
  'browser_clipboard',
])

function targetsElement(call: ToolCall): boolean {
  return ELEMENT_ACTION_TOOLS.has(call.name) && !(call.name === 'browser_clipboard' && call.args.action === 'write')
}

function hasLocator(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { index, selector } = value as Record<string, unknown>
  return index !== undefined || (typeof selector === 'string' && selector !== '')
}

/** The slots a call addresses with a locator (a slot the page does not report on is "not checked"). */
function expectedSlots(call: ToolCall): Array<keyof TargetStates> {
  if (call.name === 'browser_drag') {
    return [...hasLocator(call.args.from) ? ['from' as const] : [], ...hasLocator(call.args.to) ? ['to' as const] : []]
  }
  return hasLocator(call.args) ? ['target'] : []
}

/**
 * Ask the target frame what the call's element is: for browser_type whether
 * it is a sensitive field (so the card masks the text), and for every
 * element action the element's kind, label, and row or section (so the card
 * says what will be acted on). `recheck` asks again after approval without
 * replacing the first answer's element binding. Any failure (no content
 * script yet, frame gone) leaves the sensitivity undefined, which masks, and
 * the element "not checked", which the card says.
 */
async function probeTargets(tabId: number, call: ToolCall, frames: TabFrame[], recheck: boolean): Promise<ApprovalContext> {
  const expected = expectedSlots(call)
  const unknown = readTargetSlots(undefined, expected).targets
  const frame = frames.find((candidate) => candidate.frameId === requestedFrame(call.args))
  if (frame === undefined) return { targets: unknown }
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_TARGET_INFO', tool: call.name, args: withoutFrame(call.args), ...recheck ? { recheck: true } : {} },
      frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId },
    ) as { ok?: unknown; result?: { sensitive?: unknown; targets?: unknown } } | undefined
    if (response?.ok !== true) return { targets: unknown }
    const read = readTargetSlots(response.result?.targets, expected)
    return {
      ...typeof response.result?.sensitive === 'boolean' ? { typedTargetSensitive: response.result.sensitive } : {},
      targets: read.targets,
      ...read.moved ? { targetMoved: true as const } : {},
    }
  } catch {
    return { targets: unknown }
  }
}

function sameTargetDocument(call: ToolCall, before: TabFrame[], after: TabFrame[]): boolean {
  const frameId = requestedFrame(call.args)
  const beforeFrame = before.find((frame) => frame.frameId === frameId)
  const afterFrame = after.find((frame) => frame.frameId === frameId)
  return beforeFrame !== undefined
    && afterFrame !== undefined
    && frameDocumentKey(beforeFrame) === frameDocumentKey(afterFrame)
}

async function removeCreatedTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // The tab may already have been closed by the user or another tool.
  }
}

/**
 * Open a URL in a new tab, then optionally snapshot it once the document is ready.
 * Affinity rebinding is owned by the caller via `bindCreatedTab`.
 *
 * Creates a blank tab first, arms the readiness listener, then navigates so a
 * fast `document_idle` cannot announce readiness before the listener exists.
 * Cancellation before affinity bind rolls the orphan tab back; after bind the
 * open is treated as committed and reported as success even if the call expires.
 */
export async function dispatchOpenTab(
  call: ToolCall,
  windowId: number,
  sharePageContent: 'ask' | 'auto' | 'off',
  budget: ContentBudget | undefined,
  authorize: ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) | undefined,
  signal: AbortSignal | undefined,
  bindCreatedTab: (tab: chrome.tabs.Tab) => boolean,
  targetStillAllowed: (tabId: number) => boolean,
  commitAction?: () => void,
  policy?: CallPolicyHook,
): Promise<ToolAnswer> {
  if (isCancelled(call, signal)) return cancelled()
  const parsed = parseHttpUrl(call.args.url)
  if (parsed === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'url must be a complete http or https URL.' } }
  }
  const active = call.args.active !== false

  const decision: CallPolicyDecision = policy?.(call, callPolicyTargets(call, [])) ?? { kind: 'default' }
  if (decision.kind === 'deny') return policyDenied(decision.message)
  const promptFor = (): ApprovalPrompt | undefined => decision.kind === 'force'
    ? forcedApprovalPrompt(call, [], decision.reasons, undefined, {}, decision.causes)
    : decision.kind === 'trust' ? undefined : approvalPromptForCall(call, sharePageContent, [])
  const approval = promptFor()
  if (approval !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(approval)
    if (isCancelled(call, signal)) return cancelled()
    if (authorization !== 'approved') return approvalFailure(approval, authorization)
    // The approval covers exactly the URL shown on the card.
    if (promptFor()?.binding !== approval.binding) {
      return unavailable('The request changed while approval was pending. Call the tool again to request a new approval.')
    }
  }
  const approvedUrl = parseHttpUrl(call.args.url)
  if (approvedUrl === undefined || approvedUrl.href !== parsed.href) {
    return unavailable('The request changed while approval was pending. Call the tool again to request a new approval.')
  }

  let created: chrome.tabs.Tab
  try {
    // No URL yet: register the readiness wait before the http(s) navigation.
    created = await chrome.tabs.create({ active, windowId })
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to open a new browser tab.',
      },
    }
  }
  if (created.id === undefined) {
    return { ok: false, error: { code: 'action-failed', message: 'Chrome created a tab without an id.' } }
  }
  const tabId = created.id
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }

  const navigationWait = waitForNextDocumentReady(tabId, 0, undefined, signal)
  try {
    created = await chrome.tabs.update(tabId, { url: parsed.href })
  } catch (error: unknown) {
    navigationWait.cancel()
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: {
        code: 'action-failed',
        message: error instanceof Error ? error.message : 'Failed to navigate the new browser tab.',
      },
    }
  }

  const ready = await navigationWait.ready
  if (isCancelled(call, signal)) {
    await removeCreatedTab(tabId)
    return cancelled()
  }
  commitAction?.()
  if (!bindCreatedTab(created.id === undefined ? { ...created, id: tabId } : created)) {
    await removeCreatedTab(tabId)
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The new tab could not become the controlled browser target.' },
    }
  }

  // Affinity is committed: further cancellation must not claim the tab was never opened.
  resetTabSnapshot(tabId)
  if (!targetStillAllowed(tabId)) return targetChanged()

  const status = active
    ? `Opened a new tab at ${parsed.href}.`
    : `Opened a new background tab at ${parsed.href}.`
  if (!ready || sharePageContent === 'off' || isCancelled(call, signal)) {
    return {
      ok: true,
      result: {
        text: sharePageContent === 'off'
          ? `${status} Page content sharing is disabled, so no snapshot was captured.`
          : `${status} Call browser_snapshot again after the page loads.`,
      },
    }
  }

  try {
    const snapshot = await snapshotAfterNavigation(
      tabId,
      call,
      status,
      budget ?? { maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS },
      () => targetStillAllowed(tabId),
      policy,
    )
    if (snapshot !== undefined) return snapshot
  } catch {
    // Keep the successful open when the replacement page is not yet readable.
  }
  return {
    ok: true,
    result: { text: `${status} Call browser_snapshot again after the page loads.` },
  }
}
