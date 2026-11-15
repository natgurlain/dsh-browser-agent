/**
 * Content script entry. Routes the background's messages:
 *
 * - `DSH_ACTION`: run a browser action against the real page and answer with
 *   a text result (actions.ts);
 * - `DSH_OVERLAY`: the on-page agent overlay (overlay.ts);
 * - `DSH_INPUT_SETUP`: focus/selection/geometry for the debugger-driven
 *   pointer and keyboard (input-support.ts), never model-facing;
 * - `DSH_WATCH_ARM`: standing page watchers (watch.ts);
 * - `DSH_LEARN_*`, `DSH_WATCH` / `DSH_WATCH_PROBE`, `DSH_SITE_DRIVER_FETCH`:
 *   the default-off learning features (learning.ts);
 * - `DSH_SELECTION_WATCH` / `DSH_SELECTION_RESET`, `DSH_TARGET_INFO`,
 *   `DSH_BUDGET`, `DSH_ABORT`: selection reports, the approval-time
 *   sensitivity probe, snapshot budgets and the kill switch.
 *
 * On load it announces `DSH_CONTENT_READY`; the reply restores the selection
 * watcher, the overlay and "Watch me" on the new document.
 *
 * The content script is the only part that touches the page. What leaves it
 * is structured text (snapshots, action results, matched excerpts), masked
 * values, and sanitized fixtures, each gated by the background.
 *
 * @module
 */

import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { abortRunningActions, runAction, ActionError, resolveActionTarget, typeTargetIsSensitive } from './actions.ts'
import { AgentOverlay, type OverlayCopy, type PointKind } from './overlay.ts'
import { ElementIds } from './ids.ts'
import { handleInputSetup } from './input-support.ts'
import { handleLearningMessage, setWatching } from './learning.ts'
import { SelectionWatcher } from './selection.ts'
import { armPageWatch } from './watch.ts'
import type { InputSetupRequest } from '../shared/input-setup.ts'
import type { SnapshotBudget } from './snapshot.ts'

/** Negotiated snapshot budgets, patched in from the background via message. */
let budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS }

const ids = new ElementIds()

const selectionWatcher = new SelectionWatcher((selection) => {
  void chrome.runtime.sendMessage({ type: 'DSH_SELECTION', selection }).catch(() => {})
})

const overlay = new AgentOverlay({
  killSwitch: () => { void chrome.runtime.sendMessage({ type: 'DSH_KILL_SWITCH' }).catch(() => {}) },
  resume: () => { void chrome.runtime.sendMessage({ type: 'DSH_AGENT_RESUME' }).catch(() => {}) },
})

const CONTENT_SCRIPT_LISTENER = '__dshBrowserContentScriptListener__'
const CONTENT_SELECTION_WATCHER = '__dshBrowserSelectionWatcher__'
const CONTENT_OVERLAY = '__dshBrowserAgentOverlay__'
const CONTENT_LEARNING_WATCH = '__dshBrowserLearningWatch__'
type ContentListener = typeof onMessage

/** A tool-call result for the bridge. */
export interface ToolResult {
  ok: boolean
  result?: { text: string; pageContent?: string; navigationPending?: boolean }
  error?: { code: string; message: string }
}

function onMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): true | undefined {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  if (msg.type === 'DSH_WATCH_ARM') {
    // Standing page watchers the user approved for this tab (top frame only).
    armPageWatch((message as { watches?: unknown }).watches)
    return
  }
  if (msg.type === 'DSH_INPUT_SETUP') {
    // Internal trusted-input plumbing: focus/selection/geometry for the
    // background's debugger-driven pointer and keyboard. Never model-facing.
    const request = (message as { request?: InputSetupRequest }).request
    if (request === undefined) {
      sendResponse({ ok: false, error: { code: 'bad-args', message: 'input setup request is missing.' } })
      return
    }
    try {
      sendResponse({ ok: true, result: handleInputSetup(request, ids) })
    } catch (error: unknown) {
      sendResponse({
        ok: false,
        error: {
          code: error instanceof ActionError ? error.code : 'action-failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
    return
  }
  if (msg.type === 'DSH_OVERLAY') {
    handleOverlay(message as OverlayCommand).then(
      () => { sendResponse({ ok: true }) },
      () => { sendResponse({ ok: false }) },
    )
    return true
  }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) {
      budget = { ...budget, ...incoming }
      sendResponse({ ok: true, result: { text: `快照预算已更新: ${JSON.stringify(budget)}` } })
    }
    return
  }
  if (msg.type === 'DSH_SELECTION_WATCH') {
    const command = message as { enabled?: unknown; epoch?: unknown; revision?: unknown }
    const epoch = typeof command.epoch === 'string' ? command.epoch : undefined
    const revision = typeof command.revision === 'number' ? command.revision : undefined
    selectionWatcher.setEnabled(command.enabled === true, revision, epoch)
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_TARGET_INFO') {
    // Approval-time probe: only a sensitivity bit leaves the page.
    const args = (message as { args?: Record<string, unknown> }).args ?? {}
    sendResponse({ ok: true, result: { sensitive: typeTargetIsSensitive(args, ids) } })
    return
  }
  if (msg.type === 'DSH_SELECTION_RESET') {
    // The panel dropped this frame's quote; let the same passage be re-reported.
    selectionWatcher.resetDedupe()
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'DSH_ABORT') {
    // Kill switch: stop waits and scroll/select loops already running here.
    abortRunningActions()
    sendResponse({ ok: true })
    return
  }
  if (typeof msg.type === 'string' && /^DSH_(?:LEARN_|WATCH|SITE_DRIVER_)/u.test(msg.type)) {
    // Phase 3 learning features (default off; the background gates every message).
    return handleLearningMessage(message as { type?: string } & Record<string, unknown>, ids, sendResponse) === true ? true : undefined
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as {
    action?: string
    args?: Record<string, unknown>
    budget?: Partial<SnapshotBudget>
    includePageDelta?: boolean
    shareContent?: boolean
  }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  const actionBudget = actionMsg.budget === undefined ? budget : { ...budget, ...actionMsg.budget }
  void runAction(action, args, {
    ids,
    budget: actionBudget,
    includePageDelta: actionMsg.includePageDelta === true,
    shareContent: actionMsg.shareContent === true,
  }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true // async response
}

interface OverlayCommand {
  op?: unknown
  on?: unknown
  hidden?: unknown
  kind?: unknown
  args?: unknown
  label?: unknown
  copy?: Partial<OverlayCopy>
}

const POINT_KINDS = new Set<PointKind>(['click', 'hover', 'drag', 'type', 'select', 'press', 'upload', 'scroll'])

function overlayTarget(args: unknown): Element | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  try {
    return resolveActionTarget(args as Record<string, unknown>, ids)
  } catch {
    return undefined
  }
}

/** Apply one overlay command from the background; never throws into the page. */
async function handleOverlay(command: OverlayCommand): Promise<void> {
  switch (command.op) {
    case 'control':
      overlay.setControl(command.on === true, command.copy)
      return
    case 'takeover':
      overlay.setTakeover(command.on === true, command.copy)
      return
    case 'hide':
      overlay.setHidden(command.hidden === true)
      return
    case 'acting':
      overlay.markActing()
      return
    case 'point': {
      const kind = command.kind as PointKind
      if (!POINT_KINDS.has(kind)) return
      const args = (typeof command.args === 'object' && command.args !== null ? command.args : {}) as Record<string, unknown>
      const targets = kind === 'drag'
        ? [overlayTarget(args.from), overlayTarget(args.to)].filter((el): el is Element => el !== undefined)
        : [overlayTarget(args)].filter((el): el is Element => el !== undefined)
      if (targets.length === 0) return
      await overlay.point(kind, targets, typeof command.label === 'string' ? command.label : undefined, command.copy)
      return
    }
  }
}

// executeScript is used to recover tabs opened before extension install/reload.
// Replace any stale listener left in the isolated world so a reload always
// installs a listener belonging to the current extension context.
const contentGlobal = globalThis as typeof globalThis & {
  [CONTENT_SCRIPT_LISTENER]?: ContentListener
  [CONTENT_SELECTION_WATCHER]?: { dispose: () => void }
  [CONTENT_OVERLAY]?: { dispose: () => void }
  [CONTENT_LEARNING_WATCH]?: { dispose: () => void }
}
const previousListener = contentGlobal[CONTENT_SCRIPT_LISTENER]
if (previousListener !== undefined) {
  try { chrome.runtime.onMessage.removeListener(previousListener) } catch { /* stale extension context */ }
}
// A replaced content script keeps its page listeners until this instance
// releases them: `selectionchange` is a document listener, not an extension one.
contentGlobal[CONTENT_SELECTION_WATCHER]?.dispose()
contentGlobal[CONTENT_OVERLAY]?.dispose()
contentGlobal[CONTENT_LEARNING_WATCH]?.dispose()
contentGlobal[CONTENT_SCRIPT_LISTENER] = onMessage
contentGlobal[CONTENT_SELECTION_WATCHER] = selectionWatcher
contentGlobal[CONTENT_OVERLAY] = overlay
contentGlobal[CONTENT_LEARNING_WATCH] = { dispose: () => { setWatching(false) } }
chrome.runtime.onMessage.addListener(onMessage)

// A navigation action answers before unloading. The replacement content
// script announces when the new document can accept its automatic snapshot,
// and learns from the reply whether a side panel wants selection reports,
// whether the agent overlay is showing, and whether "Watch me" is recording
// this tab (a navigation would otherwise end the recording silently).
void chrome.runtime.sendMessage({ type: 'DSH_CONTENT_READY' }).then((response: unknown) => {
  if (typeof response !== 'object' || response === null) return
  const ready = response as {
    selectionWatch?: unknown
    selectionWatchEpoch?: unknown
    selectionWatchRevision?: unknown
    overlay?: { control?: unknown; takeover?: unknown; copy?: Partial<OverlayCopy> }
    watchMe?: unknown
  }
  if (typeof ready.overlay === 'object' && ready.overlay !== null) {
    if (ready.overlay.control === true) overlay.setControl(true, ready.overlay.copy)
    if (ready.overlay.takeover === true) overlay.setTakeover(true, ready.overlay.copy)
  }
  const epoch = typeof ready.selectionWatchEpoch === 'string' ? ready.selectionWatchEpoch : undefined
  const revision = typeof ready.selectionWatchRevision === 'number' ? ready.selectionWatchRevision : undefined
  selectionWatcher.setEnabled(ready.selectionWatch === true, revision, epoch)
  if (ready.watchMe === true) setWatching(true)
}).catch(() => {})
