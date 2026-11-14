/**
 * JavaScript dialogs (alert, confirm, prompt, beforeunload).
 *
 * A native dialog blocks the page's main thread: the content script cannot
 * answer, so an action that opens one used to hang until the bridge's tool
 * timeout and stall every later call. Two signals end that:
 *
 * - CDP: while the tab's debugger has the Page domain enabled, Chrome reports
 *   `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed`. Chrome
 *   hands a dialog only to DevTools clients that had Page enabled when it
 *   opened, and `Page.enable` itself cannot complete while a dialog blocks the
 *   renderer, so the debugger is armed *before* actions that commonly open
 *   dialogs (attach on demand, released through the broker's idle policy).
 * - Liveness: without CDP (Firefox, a DevTools conflict), a page action that
 *   stops answering is probed with a trivial injected script. A blocked main
 *   thread cannot run it, so a few failed probes mean "the tab stopped
 *   responding" and the call fails early instead of waiting ~90 s.
 *
 * Dialog text is page-authored and therefore untrusted; callers wrap it.
 *
 * @module
 */

import type { TabFrame } from './frames.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'

/** Character ceiling of a dialog report (the message is page text, wrapped). */
const DIALOG_REPORT_MAX_CHARS = 4_000

/** Dialog kinds CDP reports. `unknown` marks a stall the debugger could not identify. */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'unknown'

/** One open (or suspected) dialog in a tab. */
export interface OpenDialog {
  tabId: number
  type: DialogType
  /** Page-authored message (untrusted). */
  message: string
  /** Default text of a prompt(). */
  defaultPrompt?: string
  /** Document URL that opened it, when known. */
  url?: string
  /** `cdp`: reported by the debugger. `unresponsive`: inferred from failed liveness probes. */
  source: 'cdp' | 'unresponsive'
  /** Set when the debugger detached after the report, so its close may have been missed. */
  stale?: true
  openedAt: number
}

/** Longest dialog message kept; longer page text is cut with a marker. */
const MAX_MESSAGE_CHARS = 2_000

function normalizeType(value: unknown): DialogType {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload' ? value : 'unknown'
}

function clip(value: string): string {
  return value.length <= MAX_MESSAGE_CHARS ? value : `${value.slice(0, MAX_MESSAGE_CHARS)}…`
}

/** Short model-facing description: `confirm "Delete this item?"`. */
export function describeDialog(dialog: OpenDialog): string {
  if (dialog.type === 'unknown') return 'unidentified dialog (the page stopped responding)'
  const message = JSON.stringify(dialog.message.replace(/\s+/g, ' ').trim())
  const prompt = dialog.type === 'prompt' && dialog.defaultPrompt !== undefined && dialog.defaultPrompt !== ''
    ? ` (default ${JSON.stringify(dialog.defaultPrompt)})`
    : ''
  return `${dialog.type} ${message}${prompt}`
}

/** The guidance appended wherever a dialog is reported. */
export function dialogGuidance(dialog: OpenDialog, canAnswer: boolean): string {
  if (dialog.type === 'unknown') {
    // Chrome hands a dialog only to debugger clients that were listening when
    // it opened; one the extension did not see usually cannot be answered here.
    return 'Ask the user to answer or close it in the browser, then retry. '
      + (canAnswer ? 'browser_dialog can try to answer it, but usually only dialogs reported as "dialog open: <type> dialog" can be answered from here.' : '')
  }
  if (!canAnswer) {
    return 'This browser cannot answer native dialogs from the extension (no debugger). Ask the user to answer or close it, then retry.'
  }
  if (dialog.type === 'prompt') {
    return 'The page is blocked until it is answered: call browser_dialog {accept: true, promptText} or {accept: false}.'
  }
  return 'The page is blocked until it is answered: call browser_dialog {accept: true} (OK/leave) or {accept: false} (Cancel/stay).'
}

/**
 * Model-facing dialog report. The first line names the dialog kind; the
 * page-authored message follows inside the untrusted-content boundary.
 * @param lead - optional sentence placed before the guidance.
 */
export function dialogOpenMessage(dialog: OpenDialog, canAnswer: boolean, lead?: string): string {
  const head = `dialog open: ${dialog.type === 'unknown' ? describeDialog(dialog) : `${dialog.type} dialog`}.`
  const text = [head, lead, dialogGuidance(dialog, canAnswer)].filter((part) => part !== undefined && part !== '').join(' ')
  if (dialog.type === 'unknown') return text
  return `${text}\n${wrapUntrustedContent(describeDialog(dialog), DIALOG_REPORT_MAX_CHARS)}`
}

/** Error text for a page that stopped answering without an identifiable dialog. */
export function unresponsiveMessage(waitedMs: number): string {
  return `The page stopped responding for ${Math.round(waitedMs / 100) / 10}s while the action ran. `
    + 'A native JavaScript dialog (alert, confirm, prompt, or "leave site?") is the usual cause; the content script cannot see it. '
    + 'Ask the user to answer or close it in the browser, then retry.'
}

/** Debugger access the dialog controller needs; the broker satisfies it. */
export interface DialogDebugger {
  /** Whether the platform can attach a debugger at all. */
  supported: boolean
  /**
   * Attach (or join) the tab's debugger with the Page domain and keep it for
   * a short idle window. Resolves to a release function.
   */
  arm(tabId: number): Promise<() => void>
  /** Send one command on the tab's attachment, attaching when needed. */
  send(tabId: number, method: string, params: Record<string, unknown>): Promise<unknown>
}

/** Liveness probe: resolves true when the frame's main thread answered in time. */
export type LivenessProbe = (tabId: number, frame: TabFrame | undefined, timeoutMs: number) => Promise<boolean>

/** The surface tool dispatch uses. */
export interface DialogRuntime {
  /** Whether `browser_dialog` can answer dialogs on this platform. */
  readonly canAnswer: boolean
  /** The tab's open dialog, re-validating records whose close may have been missed. */
  current(tabId: number, frame?: TabFrame): Promise<OpenDialog | undefined>
  /** Arm dialog reporting before an action; resolves to a release (never throws). */
  arm(tabId: number): Promise<() => void>
  /** Observe the next dialog that opens in a tab. */
  watch(tabId: number): { opened: Promise<OpenDialog>; cancel(): void }
  /** Run a page call, failing early when a dialog opens or the page stops responding. */
  guard<T>(tabId: number, frame: TabFrame | undefined, operation: Promise<T>, signal?: AbortSignal): Promise<GuardOutcome<T>>
  /** Answer the tab's dialog. */
  answer(tabId: number, accept: boolean, promptText?: string): Promise<void>
}

/** How a guarded page call ended. */
export type GuardOutcome<T> =
  | { kind: 'answer'; value: T; dialog?: OpenDialog }
  | { kind: 'dialog'; dialog: OpenDialog }
  | { kind: 'unresponsive'; waitedMs: number }

/** Timing of the liveness watchdog; tests shrink it. */
export interface WatchdogTiming {
  /** How long a page call may run before liveness probing starts. */
  stallMs: number
  /** Budget of one probe. */
  probeTimeoutMs: number
  /** Pause between probes while the page still answers. */
  probeIntervalMs: number
  /** Consecutive failed probes that mean "unresponsive". */
  failedProbes: number
}

export const DEFAULT_WATCHDOG_TIMING: WatchdogTiming = {
  stallMs: 1_500,
  probeTimeoutMs: 1_000,
  probeIntervalMs: 500,
  failedProbes: 2,
}

/** Default liveness probe: run a no-op in the frame's document. */
export const scriptingLivenessProbe: LivenessProbe = async (tabId, frame, timeoutMs) => {
  const target = frame?.documentId !== undefined
    ? { tabId, documentIds: [frame.documentId] }
    : { tabId, frameIds: [frame?.frameId ?? 0] }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target, func: () => true }).then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Dependencies of {@link DialogController}. */
export interface DialogControllerOptions {
  debugger?: DialogDebugger
  probe?: LivenessProbe
  timing?: Partial<WatchdogTiming>
  now?: () => number
  /** Notified whenever a tab's dialog state changes (badge, panel). */
  onChange?: (tabId: number, dialog: OpenDialog | undefined) => void
}

/**
 * Per-tab dialog state fed by CDP events, plus the watchdog that guards page
 * calls. One instance lives in the background worker.
 */
export class DialogController implements DialogRuntime {
  private readonly dialogs = new Map<number, OpenDialog>()
  private readonly watchers = new Map<number, Set<(dialog: OpenDialog) => void>>()
  private readonly timing: WatchdogTiming
  private readonly probe: LivenessProbe
  private readonly now: () => number

  constructor(private readonly options: DialogControllerOptions = {}) {
    this.timing = { ...DEFAULT_WATCHDOG_TIMING, ...options.timing }
    this.probe = options.probe ?? scriptingLivenessProbe
    this.now = options.now ?? Date.now
  }

  get canAnswer(): boolean {
    return this.options.debugger?.supported === true
  }

  /** Feed one CDP event from any attachment. */
  onCdpEvent(tabId: number, method: string, params: unknown): void {
    if (method === 'Page.javascriptDialogOpening') {
      const value = (params ?? {}) as { type?: unknown; message?: unknown; defaultPrompt?: unknown; url?: unknown }
      const dialog: OpenDialog = {
        tabId,
        type: normalizeType(value.type),
        message: clip(typeof value.message === 'string' ? value.message : ''),
        ...(typeof value.defaultPrompt === 'string' ? { defaultPrompt: clip(value.defaultPrompt) } : {}),
        ...(typeof value.url === 'string' && value.url !== '' ? { url: value.url } : {}),
        source: 'cdp',
        openedAt: this.now(),
      }
      this.set(tabId, dialog)
      for (const watcher of [...(this.watchers.get(tabId) ?? [])]) watcher(dialog)
      return
    }
    if (method === 'Page.javascriptDialogClosed') this.clear(tabId)
  }

  /** The tab's debugger detached: a later close cannot be observed any more. */
  onDetached(tabId: number): void {
    const dialog = this.dialogs.get(tabId)
    if (dialog !== undefined && dialog.stale !== true) this.dialogs.set(tabId, { ...dialog, stale: true })
  }

  /** A top-level navigation or tab close ends any dialog. */
  clear(tabId: number): void {
    if (!this.dialogs.delete(tabId)) return
    this.options.onChange?.(tabId, undefined)
  }

  /** Forget every record (kill switch). */
  clearAll(): void {
    for (const tabId of [...this.dialogs.keys()]) this.clear(tabId)
  }

  /** Synchronous view of the last known state, without re-validation. */
  peek(tabId: number): OpenDialog | undefined {
    return this.dialogs.get(tabId)
  }

  async current(tabId: number, frame?: TabFrame): Promise<OpenDialog | undefined> {
    const dialog = this.dialogs.get(tabId)
    if (dialog === undefined) return undefined
    if (dialog.source === 'cdp' && dialog.stale !== true) return dialog
    // Inferred or possibly-missed-close records are confirmed by the page
    // itself: a page that runs a script again is no longer blocked.
    const alive = await this.probe(tabId, frame, this.timing.probeTimeoutMs)
    if (alive) {
      if (this.dialogs.get(tabId) === dialog) this.clear(tabId)
      return undefined
    }
    return this.dialogs.get(tabId)
  }

  async arm(tabId: number): Promise<() => void> {
    const debuggerAccess = this.options.debugger
    if (debuggerAccess?.supported !== true) return () => {}
    try {
      return await debuggerAccess.arm(tabId)
    } catch {
      // A DevTools conflict or a protected tab: the liveness watchdog remains.
      return () => {}
    }
  }

  watch(tabId: number): { opened: Promise<OpenDialog>; cancel(): void } {
    let listener!: (dialog: OpenDialog) => void
    const opened = new Promise<OpenDialog>((resolve) => { listener = resolve })
    const set = this.watchers.get(tabId) ?? new Set()
    set.add(listener)
    this.watchers.set(tabId, set)
    return {
      opened,
      cancel: () => {
        set.delete(listener)
        if (set.size === 0 && this.watchers.get(tabId) === set) this.watchers.delete(tabId)
      },
    }
  }

  async guard<T>(tabId: number, frame: TabFrame | undefined, operation: Promise<T>, signal?: AbortSignal): Promise<GuardOutcome<T>> {
    const watch = this.watch(tabId)
    let settled = false
    const answer = operation.then((value): GuardOutcome<T> => {
      const dialog = this.dialogs.get(tabId)
      return { kind: 'answer', value, ...(dialog === undefined ? {} : { dialog }) }
    })
    const viaDialog = watch.opened.then((dialog): GuardOutcome<T> => ({ kind: 'dialog', dialog }))
    const started = this.now()
    const watchdog = (async (): Promise<GuardOutcome<T> | undefined> => {
      await sleep(this.timing.stallMs, signal)
      let failures = 0
      while (!settled && signal?.aborted !== true) {
        const alive = await this.probe(tabId, frame, this.timing.probeTimeoutMs)
        if (settled) return undefined
        if (alive) {
          failures = 0
          await sleep(this.timing.probeIntervalMs, signal)
          continue
        }
        failures += 1
        if (failures < this.timing.failedProbes) continue
        const known = this.dialogs.get(tabId)
        if (known !== undefined) return { kind: 'dialog', dialog: known }
        const waitedMs = this.now() - started
        const suspected: OpenDialog = {
          tabId, type: 'unknown', message: '', source: 'unresponsive', openedAt: this.now(),
          ...(frame?.url === undefined ? {} : { url: frame.url }),
        }
        this.set(tabId, suspected)
        return { kind: 'unresponsive', waitedMs }
      }
      return undefined
    })()
    try {
      return await Promise.race([
        answer,
        viaDialog,
        watchdog.then((outcome) => outcome ?? answer),
      ])
    } finally {
      settled = true
      watch.cancel()
      // The abandoned page call settles (or not) on its own once the dialog
      // closes; its late answer is intentionally dropped.
      answer.catch(() => undefined)
    }
  }

  async answer(tabId: number, accept: boolean, promptText?: string): Promise<void> {
    const debuggerAccess = this.options.debugger
    if (debuggerAccess?.supported !== true) {
      throw new Error('This browser cannot answer native dialogs from the extension (no debugger).')
    }
    await debuggerAccess.send(tabId, 'Page.handleJavaScriptDialog', {
      accept,
      ...(promptText === undefined ? {} : { promptText }),
    })
    this.clear(tabId)
  }

  private set(tabId: number, dialog: OpenDialog): void {
    this.dialogs.set(tabId, dialog)
    this.options.onChange?.(tabId, dialog)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
