/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, controlled-tab tool dispatch, and the panel port service.
 *
 * MV3 survival: opening the panel is what first claims a bridge connection
 * (merely loading the extension never probes). After that the connection is
 * kept up without a panel while the runtime lease is active (a tool call or
 * approval in flight, or activity within the idle window; see
 * runtime-lifecycle.ts): a heartbeat keeps the worker awake, a half-minute
 * `alarms` keepalive restarts it, and a lease mirrored in storage.session lets
 * a restarted worker reconnect to the address it last used, without
 * discovery. Once idle, the bridge closes and the worker may sleep.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', id, settings: Partial<Settings> }
 *   panel → bg: { type: 'devtools.detach', id }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'tab-affinity.return', id, revision }
 *   panel → bg: { type: 'panel.window', windowId }
 *   panel → bg: { type: 'selection.clear', selection? }
 *   panel → bg: { type: 'request-status' }
 *   panel → bg: { type: 'discovery.start', id }
 *   panel → bg: { type: 'discovery.cancel' }
 *   panel → bg: { type: 'pair.start', id, again?, auto? }
 *   panel → bg: { type: 'pair.cancel' }
 *   bg → panel: { type: 'pair.code', id, code, answerTimeoutMs }
 *   bg → panel: { type: 'pair.result', id, ok, reason? }
 *   panel → bg: { type: 'kill-switch.engage' }
 *   panel → bg: { type: 'kill-switch.release' }
 *   panel → bg: { type: 'agent.pause', mode: 'after-step' | 'take-over' }
 *   panel → bg: { type: 'agent.resume' }
 *   bg → panel: { type: 'agent.pause-state', state: PauseState }
 *   bg → panel: { type: 'kill-switch', engaged }
 *   bg → panel: { type: 'discovery.progress', id, done, total, instances }
 *   bg → panel: { type: 'discovery.result', id, ok, instances? | error? }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'settings.result', id, ok, error? }
 *   bg → panel: { type: 'devtools.status', supported, enabled, attached, tabId?, error? }
 *   bg → panel: { type: 'devtools.detach.result', id, ok, error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps, discovery, address?, failure?, killSwitch, standing }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'selection', selection }
 *   bg → panel: { type: 'tab-affinity', state }
 *   bg → panel: { type: 'tab-affinity.rebind.result', id, ok, error? }
 *   bg → panel: { type: 'tab-affinity.return.result', id, ok, error? }
 *
 * An `rpc` for the dev-loop link / unlink / list methods is completed here
 * (devLoopPanelRpc) instead of being forwarded as is.
 *
 * Other extension-page ports (each accepts extension pages only):
 *   "dsh-policy"   site policy taint state and clears (policy-runtime.ts)
 *   "dsh-watchers" standing page watchers (watcher-runtime.ts)
 *   "dsh-learning" workflows, site drivers, Watch me (learning.ts)
 *
 * Content-script messages (this extension's own frames, from a tab):
 *   DSH_CONTENT_READY  frame ready; answered with selection-watch and overlay state
 *   DSH_SELECTION      the user's page selection
 *   DSH_KILL_SWITCH    the on-page pill's Stop link
 *   DSH_AGENT_RESUME   the takeover banner's Resume (opens the panel only)
 *   DSH_WATCH_EVENT    a Watch me user event (learning.ts)
 *   DSH_WATCH_HIT      a page watcher's condition holds (watcher-runtime.ts)
 *
 * @module
 */

import {
  AUTO_REVIEW_CAPS_VERSION,
  REVIEW_CODES,
  type ReviewCode,
  BRIDGE_REVIEW_ASK_METHOD,
  BRIDGE_REVIEW_CANCEL_METHOD,
  BRIDGE_REVIEW_STATUS_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  BRIDGE_APPROVAL_ASK_METHOD,
  BRIDGE_APPROVAL_WITHDRAW_METHOD,
  BRIDGE_AUDIT_RECORD_METHOD,
  BRIDGE_STANDING_EVENT_METHOD,
  STANDING_WORK_CAPS_VERSION,
  isStandingWork,
  type StandingWork,
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_TOOL_HOLD_METHOD,
  HOST_APPROVALS_CAPS_VERSION,
  isRespondResult,
  type BridgeCaps,
  type RespondResult,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH, DEVTOOLS_CAPS_VERSION, parseBridgeConfigPayload } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { BridgeClient, InstalledTokenUnreadableError, loadInstalledToken, type BridgeFailure, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { OutageRecovery } from './outage-recovery.ts'
import { discoverInstances, planDiscovery, portOfUrl, readBridgeConfig } from './discovery.ts'
import { browserName, extensionOrigin, pairWithBridge, type PairingFailure } from './pairing.ts'
import { frameDocumentKey, listTabFrames } from './frames.ts'
import {
  dispatchOpenTab,
  dispatchToolCall,
  isNavigationCandidateTool,
  isTabManagementTool,
  callQuotedConsole,
  resetInputState,
  resetTabSnapshot,
  type InputRuntime,
  type ToolAnswer,
  type ToolCall,
} from './tools.ts'
import { createDebuggerBroker } from './debugger-broker.ts'
import { HOLD_EXPIRED_MESSAGE, PauseGate, type PauseRequest } from './pause-gate.ts'
import { capturePauseBaseline, prepareResume, type PauseBaseline, type ResumeFlowDeps } from './resume-flow.ts'
import { AgentOverlayController } from './agent-overlay.ts'
import { DialogController } from './dialogs.ts'
import { approveProgram, coverByProgram, endsSeries, ProgramGrants } from './run-program.ts'
import { PageWatcherRuntime } from './watcher-runtime.ts'
import { chromeFleetDeps, FLEETS_STORAGE_KEY, FleetRegistry, type FleetDeps } from './fleet.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { getUiLocale, loadUiLocalePreference, watchUiLocalePreference } from '../i18n.ts'
import { InteractionResponseRouter } from './responses.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
} from '../security/trusted-origins.ts'
import { TransientEventCache } from './transient-events.ts'
import {
  TabAffinityController,
  isTabAffinityDecision,
  type AffinityTab,
  type TabAffinityDecision,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { SelectionTracker, type SelectionSource } from './selection.ts'
import { parsePageSelection, parseSelectionCapture } from '../selection.ts'
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalCoordinator,
  type ApprovalRequestResult,
  type BackgroundApproval,
} from './approval-coordinator.ts'
import {
  APPROVAL_NOTIFICATION_COPY,
  approvalNotificationButtons,
  approvalNotificationOptions,
  hostApprovalReason,
} from './approval-notifications.ts'
import { RUNTIME_LEASE_STORAGE_KEY, RuntimeKeeper, RuntimeLease, STANDING_RETRY_BASE_MS, STANDING_RETRY_STORAGE_KEY, StandingBackoff } from './runtime-lifecycle.ts'
import {
  NO_HOST_STANDING,
  STANDING_HOST_STORAGE_KEY,
  hintAddressAllowed,
  normalizeBridgeUrl,
  parseStoredStandingHost,
  standingCount,
  storedStandingHost,
  type StandingSummary,
} from './standing-work.ts'
import { loadClientIdentity } from './client-identity.ts'
import type { BridgeClientIdentity } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { ExternalRequesters, isExternalSessionId } from './external-requesters.ts'
import { chromeDevLoopBrowser, DevLoopController } from './dev-loop.ts'
import {
  DEFAULT_SNAPSHOT_MAX_CHARS as DEVLOOP_MAX_CHARS,
  DEVLOOP_CAPTURE_TOOL,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { DevToolsError, devToolsSupported } from './debugger-session.ts'
import { createDevToolsController } from './devtools-controller.ts'
import {
  devToolsApprovalForCall,
  devToolsDecisionOutcome,
  devToolsGrantKind,
  isDevToolsTool,
  resolveApprovalGate,
} from './authorization.ts'
import { nextDevToolsAllowance, readDevToolsAllowance } from './devtools-allowance.ts'
import { DevToolsGrants } from './devtools-grants.ts'
import { BRIDGE_TAINT_CLEAR_METHOD, BRIDGE_TAINT_MARK_METHOD, isExtensionPageSender, PolicyRuntime, type TabProvenance } from './policy-runtime.ts'
import { normalizeTaintLocalOrigins, normalizeTaintTrustedSites, reconcileTrustConfirmed, servesBridge } from '../security/taint-exempt.ts'
import { splitSelectionMessage } from '../panel/selection.ts'
import { callPolicyTargets, forcedApprovalPrompt, originFromUrl, tabProvenanceOf } from './authorization.ts'
import { normalizeSitePattern, normalizeSiteRules, type SiteRuleEntry } from '../security/site-policy.ts'
import { CommitGate, STRICT_MODE_UNAVAILABLE } from './commit-gate.ts'
import { fixtureAllowedFor, LearningRuntime } from './learning.ts'
import { applyManagedOverrides, loadManagedPolicy } from '../security/managed-policy.ts'
import {
  LEGACY_RECENT_SESSION_STORAGE_KEY,
  PAGE_SESSION_CONTEXT_STORAGE_KEY,
  PageSessionContextTracker,
} from './session-continuity.ts'
import { approvalFailureMessage } from './answers.ts'
import { auditedAuthorize, auditedPolicy, auditNote, noteCallTarget, type AuditedCall } from './audit.ts'
import { StepLabels, STEP_LABELS_STORAGE_KEY } from '../shared/step-labels.ts'
import { AUTO_REVIEW_STORAGE_KEY, AutoReviewRegistry, autoReviewSentence, type ReviewSubject } from './auto-review.ts'
import { autoReviewEligibility, buildReviewAction } from '../security/auto-review.ts'
import { createDevLoopPanelRpc } from './dev-loop.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /**
   * Trusted everywhere except policy-restricted sites: no approval prompts,
   * but blocked / read-only / ask site rules, taint rules, and managed policy
   * still apply (see security/site-policy.ts).
   */
  unrestrictedBrowserAccess: boolean
  /**
   * High-privilege developer tools (element/CSS debugging, page JavaScript,
   * network capture). Off by default: while it is off every devtools call
   * raises its own approval prompt, and the origin allowlist never covers it.
   */
  allowDevTools: boolean
  /**
   * When the developer-tools allowance ends (epoch ms; 0 while off). Set by
   * the worker when the setting is turned on, see devtools-allowance.ts.
   */
  allowDevToolsUntil: number
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /**
   * Attach the debugger (Page domain) before clicks, key presses, pointer
   * gestures, and navigation so JavaScript dialogs are reported and can be
   * answered. Off by default: Chrome then shows its "being debugged" bar.
   */
  catchPageDialogs: boolean
  /** Restore the current tab and page path's conversation when the panel reopens. */
  autoResumeSession: boolean
  /**
   * Minutes an approval may wait while no side panel is open (notification,
   * dsh web UI or CLI). With a panel open the card waits one minute. Clamped
   * to 1–14 so the bridge's 15-minute hold can always cover it.
   */
  approvalTimeoutMinutes: number
  /** Per-site rules (blocked / read-only / ask / trusted), see security/site-policy.ts. */
  siteRules: SiteRuleEntry[]
  /** The built-in read-only rules (banking, password vaults, identity, cloud consoles). */
  siteDefaultsEnabled: boolean
  /** Site patterns under strict mode: agent-turn writes need approval (commit-gate.ts). */
  strictSites: string[]
  /**
   * 1 (or absent): before site policy, `unrestrictedBrowserAccess` skipped every
   * prompt. 2: it means "trusted everywhere except policy-restricted sites".
   */
  settingsVersion: number
  /** Show the ghost cursor, target outlines, and the "AI controlling" frame on pages. */
  showAgentOverlay: boolean
  /** Let the agent create standing page watchers (browser_watch); each one still needs its own card. */
  allowPageWatchers: boolean
  /** Pages served from this machine (loopback) do not taint a session (security/taint-exempt.ts). */
  taintExemptLocalPages: boolean
  /** Pages from sites the user marked trusted do not taint a session (security/taint-exempt.ts). */
  taintExemptTrustedSites: boolean
  /** Loopback origins the user said are their own pages (dev-loop links, the banner, Settings). */
  taintLocalOrigins: string[]
  /** Hosts whose pages are not treated as untrusted content: the banner's Trust. Relaxes no approval card. */
  taintTrustedSites: string[]
  /** Trusted site rules and always-allowed origins confirmed for the taint exemption (keys, taint-exempt.ts). */
  taintTrustConfirmed: string[]
  /**
   * Make the per-conversation "Approvals: Auto" control available
   * (docs/auto-review-design.md). Availability only: every conversation
   * starts with Auto off. Managed `disableAutoReview` pins it off.
   */
  offerAutoReview: boolean
}

/** Current settings schema; see {@link Settings.settingsVersion}. */
const SETTINGS_VERSION = 2

const SETTINGS_DEFAULTS: Settings = {
  // Empty address = auto-discover the local dsh (zero configuration); a manually entered address takes precedence.
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  unrestrictedBrowserAccess: false,
  allowDevTools: false,
  allowDevToolsUntil: 0,
  trustedActionOrigins: [],
  approvalNotifications: true,
  catchPageDialogs: false,
  autoResumeSession: true,
  approvalTimeoutMinutes: 10,
  siteRules: [],
  siteDefaultsEnabled: true,
  strictSites: [],
  settingsVersion: SETTINGS_VERSION,
  showAgentOverlay: true,
  allowPageWatchers: false,
  taintExemptLocalPages: true,
  taintExemptTrustedSites: true,
  taintLocalOrigins: [],
  taintTrustedSites: [],
  taintTrustConfirmed: [],
  offerAutoReview: true,
}

/** Longest no-panel approval window the bridge's hold can cover. */
const MAX_APPROVAL_TIMEOUT_MINUTES = 14

/**
 * Auto-discovery: DSH Desktop starts the Host with `--port 0`, so the local web port is
 * assigned by the system at every start and no fixed port list can predict it. Probe in this order:
 * the last address that worked → the `dsh web` default port → the plugin's fixed-port beacon (43189–43198).
 * It runs once when the panel opens, or when the user clicks "Detect"; not found is final, with no retry.
 * The one exception is a bridge that was connected and went away while a panel is open (DSH restarting):
 * that outage is retried for a bounded period, see "Outage recovery" below and outage-recovery.ts.
 */
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'
const LAST_BRIDGE_URL_KEY = 'dshLastBridgeUrl'
const DISCOVERY_LATCH_KEY = 'dshDiscoveryLatch'

/** Auto-discovery gate for one panel lease; `not-found` means no service was confirmed, so there is no retry. */
type DiscoveryLatch = 'idle' | 'running' | 'not-found'

/** Discovery status reported to the panel, separate from the transport status. */
type DiscoveryState = 'idle' | 'running' | 'found' | 'not-found'

let discoveryLatch: DiscoveryLatch = 'idle'
let discoveryState: DiscoveryState = 'idle'
/** The bridge address of the last successful connection, tried first at the next discovery. */
let lastBridgeUrl: string | undefined
/** The address the current connection actually uses (entered manually or discovered). */
let connectedAddress: string | undefined
/** The enumeration started by the user clicking "Detect"; only one runs at a time. */
let activeScan: { id: string; controller: AbortController } | undefined
/** Loopback check: only a local address falls back to auto-discovery when the connection fails. */
function isLocalBridgeAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}

/** Remember the address that worked, to try it first the next time the panel opens. */
function rememberBridgeUrl(url: string): void {
  if (lastBridgeUrl === url) return
  lastBridgeUrl = url
  void Promise.resolve(chrome.storage.local.set({ [LAST_BRIDGE_URL_KEY]: url })).catch(() => {})
}

/**
 * Discovered addresses whose peer failed the server proof during this panel
 * lease. Discovery skips them so a port squatter cannot pin the extension to
 * itself; the set resets with the lease or an explicit settings change.
 */
const rejectedBridgeUrls = new Set<string>()
/** The discovery answer the current connection attempt uses, if it came from discovery. */
let discoveredBridgeUrl: string | undefined

/** Drop a remembered address that turned out not to be our bridge. */
function forgetBridgeUrl(url: string): void {
  if (lastBridgeUrl === undefined) return
  const port = portOfUrl(url)
  if (lastBridgeUrl !== url && (port === undefined || portOfUrl(lastBridgeUrl) !== port)) return
  lastBridgeUrl = undefined
  const local = chrome.storage.local as chrome.storage.StorageArea & { remove?: (key: string) => Promise<void> }
  if (typeof local.remove === 'function') void Promise.resolve(local.remove(LAST_BRIDGE_URL_KEY)).catch(() => {})
}

/**
 * The peer at `url` could not prove the token (we closed it with 4002): it is
 * not our bridge. Forget it and, when discovery chose it, continue discovery
 * without it instead of retrying the squatter forever.
 */
function onBridgeProofRejected(url: string): void {
  const discovered = discoveredBridgeUrl
  forgetBridgeUrl(url)
  if (discovered !== undefined) forgetBridgeUrl(discovered)
  if (outageRecovery.active) {
    // Met while looking for a bridge that went away: it only rules this
    // address out. The panel keeps its conversation and the search goes on.
    rejectedBridgeUrls.add(url)
    if (discovered !== undefined) rejectedBridgeUrls.add(discovered)
    discoveredBridgeUrl = undefined
    connectedAddress = outageHomeUrl
    bridge?.hold()
    outageRecovery.soon()
    return
  }
  if (discovered === undefined) return
  rejectedBridgeUrls.add(discovered)
  rejectedBridgeUrls.add(url)
  discoveredBridgeUrl = undefined
  bridge?.stop()
  void settingsReady.then(() => startBridge())
}

/** Keep "not found" across service worker restarts, so a background restart does not retry silently. */
function persistDiscoveryLatch(value: DiscoveryLatch): void {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
  if (area === undefined) return
  void Promise.resolve(area.set({ [DISCOVERY_LATCH_KEY]: value })).catch(() => {})
}

/** Restore the gate and the most recent address left by the previous run. */
async function loadDiscoveryMemory(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(LAST_BRIDGE_URL_KEY)
    const remembered = stored?.[LAST_BRIDGE_URL_KEY]
    if (typeof remembered === 'string' && remembered !== '') lastBridgeUrl = remembered
  } catch {
    // The remembered address is only a shortcut; if it cannot be read, carry on as if there were none.
  }
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
  if (area === undefined) return
  try {
    const stored = await area.get(DISCOVERY_LATCH_KEY)
    if (stored?.[DISCOVERY_LATCH_KEY] === 'not-found') {
      discoveryLatch = 'not-found'
      discoveryState = 'not-found'
    }
  } catch {
    // Same as above: if it cannot be read, treat it as idle.
  }
}

const discoveryMemory = loadDiscoveryMemory()

/** Run auto-discovery once and return the first bridge address that answers. */
async function discoverBridgeUrl(
  shouldContinue: () => boolean,
  excludeUrl?: string,
): Promise<string | undefined> {
  await discoveryMemory
  if (!shouldContinue()) return undefined
  const previousState = discoveryState
  discoveryLatch = 'running'
  discoveryState = 'running'
  broadcastStatus()
  try {
    const instances = await discoverInstances(planDiscovery({
      ...(lastBridgeUrl === undefined ? {} : { rememberedUrl: lastBridgeUrl }),
      ...(excludeUrl === undefined ? {} : { excludeUrl }),
      excludeUrls: [...rejectedBridgeUrls],
    }), {
      probe: (port, timeoutMs) => readBridgeConfig(port, timeoutMs),
      shouldContinue,
    }, { stopAtFirstHit: true })
    // A pass that lost its lease (panel closed, newer settings) reports nothing
    // and leaves the confirmed state of the lease that replaced it untouched.
    if (!shouldContinue()) {
      discoveryState = previousState
      return undefined
    }
    const first = instances[0]
    if (first === undefined) {
      discoveryLatch = 'not-found'
      discoveryState = 'not-found'
      persistDiscoveryLatch('not-found')
      return undefined
    }
    discoveryLatch = 'idle'
    discoveryState = 'found'
    // Remembered only once the handshake proves the peer is our bridge
    // (`onHelloOk`): a squatter answering the probe must not become sticky.
    return first.wsUrl
  } finally {
    if (discoveryLatch === 'running') discoveryLatch = 'idle'
  }
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    if (!isLocalBridgeAddress(url)) return true
    const target = new URL(url)
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    return parseBridgeConfigPayload(await response.json() as unknown) !== undefined
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshSettings'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'

type StoredTabAffinity =
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }

let settings: Settings = { ...SETTINGS_DEFAULTS }
/** Site policy, managed policy, and session taint (policy-runtime.ts). */
const policyRuntime: PolicyRuntime = new PolicyRuntime({
  settings: () => settings,
  unrestricted: () => unrestrictedAccessEnabled(),
  clearBridgeTaint: async (sessionId) => { await gatewayRpc(BRIDGE_TAINT_CLEAR_METHOD, { sessionId: sessionId ?? null }) },
  // The banner's choices save through the same path as Settings.
  saveTaintTrust: async (change) => {
    await settingsReady
    await persistSettings({
      taintTrustedSites: [...settings.taintTrustedSites, ...change.sites],
      taintLocalOrigins: [...settings.taintLocalOrigins, ...change.localOrigins],
    })
  },
  // Whatever serves the DSH host (its web UI shows every session's transcript) is never exempt.
  neverExemptOrigin: (origin) => servesBridge(origin, [settings.bridgeUrl, discoveredBridgeUrl, lastBridgeUrl]),
  // A class of exemption the connected bridge does not honour is off here too.
  bridgeExemptions: () => caps?.taintExemptions,
  onManagedChange: (managed) => {
    // Managed values override user settings: re-apply them to what is loaded.
    if (!settingsLoaded) return
    const revokeUnrestricted = settings.unrestrictedBrowserAccess && managed.disableUnrestricted
    const revokeDevTools = settings.allowDevTools && managed.disableDevTools
    if (managed.disableAutoReview) autoReviews.endAll('managed')
    if (revokeUnrestricted || revokeDevTools) {
      void persistSettings({
        ...revokeUnrestricted ? { unrestrictedBrowserAccess: false } : {},
        ...revokeDevTools ? { allowDevTools: false } : {},
      }).catch(() => {})
    }
    policyRuntime.broadcast()
  },
  storage: (chrome.storage as { session?: chrome.storage.StorageArea }).session,
})
chrome.storage.onChanged?.addListener((_changes, area) => {
  if (area !== 'managed') return
  void loadManagedPolicy().then((managed) => { policyRuntime.setManaged(managed) })
})
let unrestrictedAccessActive = SETTINGS_DEFAULTS.unrestrictedBrowserAccess
let unrestrictedAccessRevision = 0
let unrestrictedRevocation: Promise<void> | undefined
let settingsPersistence = Promise.resolve()
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
/** What the bridge last said the Host holds for this install; restored from storage.local on boot (standing-work.ts). */
let hostStanding: StandingWork = NO_HOST_STANDING
/** Whether storage.local may hold a host hint (so "none" has something to clear). */
let hostStandingStored = false
/** `chrome.storage.local` key of {@link bridgeRefusal}. */
const BRIDGE_REFUSAL_KEY = 'dshBridgeRefusal'
/** Why the bridge ended the connection for good, when it did; only a user action or a new connection clears it. */
type BridgeRefusal = 'replaced' | 'token-mismatch' | 'version-mismatch' | 'origin-rejected'
const BRIDGE_REFUSALS: readonly string[] = ['replaced', 'token-mismatch', 'version-mismatch', 'origin-rejected']
/**
 * The bridge gave this install's slot to another browser (close code 4000)
 * or refused it for a reason only the user can fix (token, protocol version,
 * extension ID). While set, nothing reconnects headlessly and standing work
 * counts as zero: retrying would evict the other browser or repeat the
 * refusal. Cleared when a panel opens, the user reconnects or changes the
 * connection settings, or a connection succeeds. Persisted in storage.local.
 */
let bridgeRefusal: BridgeRefusal | undefined
/** Set once this worker decided the latch itself; the stored value then no longer applies. */
let bridgeRefusalDecided = false
const bridgeRefusalReady = (async (): Promise<void> => {
  try {
    const stored = (await chrome.storage.local.get(BRIDGE_REFUSAL_KEY))?.[BRIDGE_REFUSAL_KEY]
    if (!bridgeRefusalDecided && typeof stored === 'string' && BRIDGE_REFUSALS.includes(stored)) bridgeRefusal = stored as BridgeRefusal
  } catch { /* unreadable: no latch */ }
  bridgeRefusalDecided = true
})()

function setBridgeRefusal(next: BridgeRefusal | undefined): void {
  // Before the stored latch is read, a clear must still remove it.
  if (bridgeRefusal === next && bridgeRefusalDecided) return
  bridgeRefusalDecided = true
  bridgeRefusal = next
  void (async () => {
    await (next === undefined ? chrome.storage.local.remove(BRIDGE_REFUSAL_KEY) : chrome.storage.local.set({ [BRIDGE_REFUSAL_KEY]: next }))
  })().catch(() => {})
}
/** Spacing of reconnect attempts while only standing work wants an unreachable bridge. */
const standingRetry = new StandingBackoff()
/** Invalidates an asynchronous discovery attempt when its panel lease ends. */
let bridgeStartRevision = 0
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
const tabAffinity = new TabAffinityController()
const focusedWindow = new FocusedWindowTracker()
const selections = new SelectionTracker()

/** Whether this browser build can serve the developer-tools group at all. */
const devToolsCapability = devToolsSupported()

/**
 * One debugger attachment per tab, shared by the developer tools and trusted
 * input. Input holds it only around one call and lets it expire when idle.
 */
const debuggerBroker = createDebuggerBroker({
  onStateChange: () => { broadcastDevToolsState() },
  onCdpEvent: (tabId, method, params) => { dialogs.onCdpEvent(tabId, method, params) },
  onDetached: (tabId) => { dialogs.onDetached(tabId) },
})
{
  // Every debugger attachment (trusted input, dialogs, developer tools) stops
  // with the kill switch, even for a call that was already past its checks.
  const acquire = debuggerBroker.acquire.bind(debuggerBroker)
  debuggerBroker.acquire = async (...args: Parameters<typeof acquire>) => {
    await refuseWhileKilled()
    return await acquire(...args)
  }
}

/** Agent session and window of the latest agent call per strict-mode tab (approval routing). */
const commitGateCallers = new Map<number, { sessionId?: string; windowId: number }>()
/** Strict mode's commit-point gate (commit-gate.ts). */
const commitGate = new CommitGate({
  broker: debuggerBroker,
  ask: async (prompt, tabId) => {
    const caller = commitGateCallers.get(tabId)
    // A request held behind an unanswered card would hang the page: bound it.
    const signal = AbortSignal.timeout(120_000)
    const decision = await authorizeToolCall(prompt, signal, caller?.windowId ?? 0, { sessionId: caller?.sessionId, unrestrictedAccess: false, tabId })
    // Audit: attach the write decision to the agent call(s) running on this tab.
    for (const call of unsettledToolCalls) {
      if (call.tabId === tabId) (call.commit ??= []).push(decision === 'approved' ? 'allowed' : decision)
    }
    return decision
  },
})

/**
 * Arm or disarm the commit gate for one agent call's tab. Returns a refusal
 * when strict mode covers the tab but cannot intercept (fail closed).
 */
async function prepareCommitGate(
  target: { id?: number; url?: string; windowId?: number },
  sessionId: string | undefined,
): Promise<ToolAnswer | undefined> {
  if (target.id === undefined) return undefined
  if (!policyRuntime.strictFor(sessionId, target.url)) {
    if (commitGate.isArmed(target.id)) await commitGate.disarm(target.id)
    return undefined
  }
  if (!devToolsSupported()) return { ok: false, error: { code: 'action-failed', message: STRICT_MODE_UNAVAILABLE } }
  commitGateCallers.set(target.id, { ...sessionId === undefined ? {} : { sessionId }, windowId: target.windowId ?? 0 })
  try {
    await commitGate.arm(target.id)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'action-failed', message: `Strict mode could not intercept this tab's outgoing requests (${detail}); the call was refused rather than run unguarded.` },
    }
  }
  return undefined
}

/** The agent turn of a session ended: its strict tabs keep only the short grace. */
function commitGateTurnEnded(sessionId: string | undefined): void {
  for (const [tabId, caller] of commitGateCallers) {
    if (sessionId === undefined || caller.sessionId === sessionId) commitGate.turnEnded(tabId)
  }
}

/**
 * A tab opened by a strict tab inside an agent turn (Shift/Ctrl-click,
 * `target=_blank`, `window.open`) is gated too: its writes belong to the turn.
 */
chrome.tabs.onCreated?.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return
  if (!commitGate.adoptOpened(tab.id, tab.openerTabId)) return
  const caller = commitGateCallers.get(tab.openerTabId)
  commitGateCallers.set(tab.id, { ...caller?.sessionId === undefined ? {} : { sessionId: caller.sessionId }, windowId: tab.windowId })
  void commitGate.arm(tab.id).catch(() => { /* best effort: the opener's turn still gates the opener */ })
})

/** Run one agent call with the tab's commit gate armed and the agent turn marked. */
async function withCommitGate(
  activeCall: ActiveToolCall,
  target: { id?: number; url?: string; windowId?: number },
  sessionId: string | undefined,
  run: () => Promise<ToolAnswer>,
): Promise<ToolAnswer> {
  const refused = await prepareCommitGate(target, sessionId)
  if (refused !== undefined) {
    activeCall.strict = 'refused'
    return refused
  }
  if (target.id === undefined) return run()
  const tabId = target.id
  commitGate.callStarted(tabId, sessionId !== undefined)
  try {
    return await run()
  } finally {
    commitGate.callEnded(tabId)
  }
}

/**
 * JavaScript dialogs: CDP reports them while an attachment has the Page
 * domain; a liveness watchdog covers pages the debugger cannot see.
 */
const dialogs = new DialogController({
  debugger: {
    supported: devToolsCapability,
    arm: async (tabId) => {
      // Opt-in: pre-attaching shows Chrome's debugging bar on every action.
      if (!settingsLoaded || !settings.catchPageDialogs) return () => {}
      await refuseWhileKilled()
      const lease = await debuggerBroker.acquire(tabId, 'input', { domains: ['Page'] })
      return () => { void lease.release().catch(() => undefined) }
    },
    send: async (tabId, method, params) => {
      await refuseWhileKilled()
      const lease = await debuggerBroker.acquire(tabId, 'input')
      try {
        return await lease.session.send(method, params)
      } finally {
        await lease.release()
      }
    },
  },
})

/** Trusted input channel handed to the tool dispatcher. */
const inputRuntime: InputRuntime = {
  supported: devToolsCapability,
  async run(tabId, operation) {
    await refuseWhileKilled()
    // Page lets a dialog opened by the trusted input be reported at once.
    const lease = await debuggerBroker.acquire(tabId, 'input', { domains: ['Page'] })
    try {
      return await operation(lease.session)
    } finally {
      await lease.release()
    }
  },
}

/**
 * High-privilege developer tools. The controller refuses every call unless the
 * user's setting is on, and the background still routes each call through the
 * approval gate first.
 */
const devTools = createDevToolsController({
  broker: debuggerBroker,
  // Consent is enforced by the approval gate in `dispatchDevToolsTool`: with the
  // setting off every call raises its own dialog, and unrelated switches never
  // cover this group. The controller only owns capability and target policy.
  resolveTarget: async (sessionId) => {
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id === undefined) return undefined
    return {
      tabId: target.id,
      ...(target.url === undefined ? {} : { url: target.url }),
      ...(target.title === undefined ? {} : { title: target.title }),
    }
  },
  onStateChange: () => { broadcastDevToolsState() },
})
/** Timeline labels naming the element each call acted on (shared/step-labels.ts); for the panel only. */
const stepLabels = new StepLabels({
  read: async () => (await chrome.storage.session.get(STEP_LABELS_STORAGE_KEY))[STEP_LABELS_STORAGE_KEY],
  write: async (value) => { await chrome.storage.session.set({ [STEP_LABELS_STORAGE_KEY]: value }) },
})
/**
 * Auto review (docs/auto-review-design.md): which conversations have it on,
 * its limits, and one review at a time per conversation. Memory only
 * (`chrome.storage.session`): a browser restart turns it off everywhere.
 */
const autoReviews = new AutoReviewRegistry({
  read: async () => (await chrome.storage.session.get(AUTO_REVIEW_STORAGE_KEY))[AUTO_REVIEW_STORAGE_KEY],
  write: async (value) => { await chrome.storage.session.set({ [AUTO_REVIEW_STORAGE_KEY]: value }) },
}, Date.now, () => { broadcastAutoReviewState() })
const pageSessionContexts = new PageSessionContextTracker({
  read: async () => (await chrome.storage.session.get(PAGE_SESSION_CONTEXT_STORAGE_KEY))[PAGE_SESSION_CONTEXT_STORAGE_KEY],
  write: async (value) => {
    await chrome.storage.session.set({ [PAGE_SESSION_CONTEXT_STORAGE_KEY]: value })
  },
})
void chrome.storage.session.remove(LEGACY_RECENT_SESSION_STORAGE_KEY).catch(() => {})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/**
 * Ephemeral developer-tools grant for this panel lease. Set when the user
 * chooses "trust this session" on a devtools prompt; never persisted, and
 * never implied by the origin allowlist or unrestricted access.
 */
const devToolsGrants = new DevToolsGrants()
/** Approved browser_run programs; each step claims its own grant (run-program.ts). */
const programGrants = new ProgramGrants()
/** Tab fleets (fleet.ts): children's tool allowlists, their tabs, and where their cards show. */
const fleets = new FleetRegistry({
  get: async () => {
    const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
    return area === undefined ? undefined : (await area.get(FLEETS_STORAGE_KEY))[FLEETS_STORAGE_KEY]
  },
  set: async (value) => { await (chrome.storage as { session?: chrome.storage.StorageArea }).session?.set({ [FLEETS_STORAGE_KEY]: value }) },
})
/** Standing page watchers (watchers.ts); fires wake only sessions the bridge owns. */
const pageWatchers = new PageWatcherRuntime({
  enabled: () => settingsLoaded && settings.allowPageWatchers,
  blocked: () => killSwitchEngaged || pauseGate.holding(),
  shareContent: () => unrestrictedAccessEnabled() || settings.sharePageContent !== 'off',
  pageHidden: (url) => policyRuntime.pageHidden(url),
  rpc: (method, payload) => gatewayRpc(method, payload),
  noteTaint: (sessionId, origin) => { policyRuntime.recordInjection(sessionId, origin) },
  connected: () => bridgeForWatchHit(),
  // Live watchers are standing work: the runtime lease follows them.
  changed: () => { onStandingWorkChanged() },
})
/** Tool calls that are either withdrawable or completing an already-dispatched action. */
/** One in-flight agent call; its audit fields live in audit.ts. */
interface ActiveToolCall extends AuditedCall {
  controller: AbortController
  /** Tool name, so a revocation can target the developer-tools group only. */
  name: string
  unrestrictedAccess: boolean
  committed: boolean
  revocationRequested: boolean
  settled: Promise<void>
  settle: () => void
  /** Move the call's deadline later after the bridge granted an approval hold. */
  extendExpiry?: (expiresAt: number) => void
}

const activeToolCalls = new Map<string, ActiveToolCall>()
/** Disconnection drops result ownership, but dispatched operations must still settle before revocation. */
const unsettledToolCalls = new Set<ActiveToolCall>()
let lastPersistedAffinity: string | undefined
let affinityPersistence = Promise.resolve()
/** Per-session snapshot refreshes preserve prompt ordering without cross-session cancellation. */
const sessionSnapshotRefreshes = new Map<string, Promise<void>>()
interface ActiveFollowRefresh {
  controller: AbortController
  unrestrictedAccess: boolean
  settled: Promise<void>
  settle: () => void
}

const activeFollowRefreshes = new Map<string, ActiveFollowRefresh>()
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000

class TabAffinityRebindError extends Error {
  constructor(readonly code: 'no-active-tab' | 'timeout' | 'cancelled', message: string) {
    super(message)
    this.name = 'TabAffinityRebindError'
  }
}

/** Stable failures of one explicit "jump back to the assistant page" request. */
class TabAffinityReturnError extends Error {
  constructor(
    readonly code: 'stale-revision' | 'no-controlled-tab' | 'lost' | 'focus-failed' | 'activate-failed',
    message: string,
  ) {
    super(message)
    this.name = 'TabAffinityReturnError'
  }
}

function rebindAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new TabAffinityRebindError('cancelled', getUiLocale() === 'zh' ? '标签页绑定已取消' : 'Tab binding was cancelled')
}

function throwIfRebindAborted(signal: AbortSignal): void {
  if (signal.aborted) throw rebindAbortReason(signal)
}

/** Reject promptly on cancellation while safely consuming a late Chrome promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rebindAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(rebindAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(rebindAbortReason(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const raw = stored[STORAGE_KEY] as Partial<Settings> | undefined
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...raw })
  let migrate = false
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    migrate = true
  }
  // v1 -> v2 (site policy) needs no rewrite: every existing choice keeps its
  // value, the new fields take their defaults in normalizeSettings, and the
  // built-in read-only rules now apply, also under unrestricted access. The
  // next settings save records settingsVersion 2.
  // An allowance that ran out (or predates the time limit) is written back as
  // off, so nothing reading storage later takes it for a live choice.
  if (raw?.allowDevTools === true
    && !readDevToolsAllowance(raw.allowDevTools, raw.allowDevToolsUntil, Date.now()).allowDevTools) migrate = true
  if (migrate) await chrome.storage.local.set({ [STORAGE_KEY]: loaded })
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  const changesUnrestrictedAccess = typeof next.unrestrictedBrowserAccess === 'boolean'
  const accessRevision = changesUnrestrictedAccess ? ++unrestrictedAccessRevision : unrestrictedAccessRevision
  const updated = normalizeSettings({
    ...settings,
    ...next,
    // The worker alone decides when the allowance ends; a save can only turn
    // it on (opening a window) or off.
    ...nextDevToolsAllowance(settings, typeof next.allowDevTools === 'boolean' ? next.allowDevTools : undefined, Date.now()),
  })
  const revokesUnrestrictedAccess = settings.unrestrictedBrowserAccess && !updated.unrestrictedBrowserAccess
  // An allowance that ran out during an unrelated save is a change too.
  const changesDevTools = typeof next.allowDevTools === 'boolean' || settings.allowDevTools !== updated.allowDevTools
  const revokesDevTools = changesDevTools && (settings.allowDevTools || devToolsGrants.hasAny()) && !updated.allowDevTools
  const togglesOverlay = settings.showAgentOverlay !== updated.showAgentOverlay
  const togglesWatchers = settings.allowPageWatchers !== updated.allowPageWatchers
  // A trusted rule or always-allowed origin added now counts for the taint
  // exemption at once; ones that predate it wait for the user's confirmation.
  updated.taintTrustConfirmed = reconcileTrustConfirmed(settings, updated, next.taintTrustConfirmed ?? settings.taintTrustConfirmed)
  settings = updated
  // Which taint sources the banner can offer to trust follows the site rules and exemption settings.
  policyRuntime.broadcast()
  if (!updated.unrestrictedBrowserAccess) unrestrictedAccessActive = false
  if (revokesDevTools) devToolsGrants.clear()
  if (togglesOverlay) refreshActionBadges()
  // Turning page watchers off revokes every standing watcher.
  if (togglesWatchers) void (updated.allowPageWatchers ? Promise.resolve() : pageWatchers.clearAll()).then(() => { pageWatchers.broadcast() })
  syncSelectionWatch()
  // Turning the Setting off ends Auto review in every conversation.
  if (!updated.offerAutoReview) autoReviews.endAll('setting')
  broadcastAutoReviewState()
  let accessTransition: Promise<void> | undefined
  if (revokesUnrestrictedAccess) {
    let trackedRevocation!: Promise<void>
    trackedRevocation = revokeUnrestrictedAccess().finally(() => {
      if (unrestrictedRevocation !== trackedRevocation) return
      unrestrictedRevocation = undefined
      syncSelectionWatch()
    })
    unrestrictedRevocation = trackedRevocation
    accessTransition = trackedRevocation
  } else if (unrestrictedRevocation !== undefined) {
    accessTransition = unrestrictedRevocation
  }
  const persisted = updated
  const write = settingsPersistence.then(async () => {
    await accessTransition
    await chrome.storage.local.set({ [STORAGE_KEY]: persisted })
  })
  settingsPersistence = write.catch(() => {})
  await write
  if (changesUnrestrictedAccess
    && accessRevision === unrestrictedAccessRevision
    && settings.unrestrictedBrowserAccess
    && persisted.unrestrictedBrowserAccess
    && unrestrictedRevocation === undefined) {
    unrestrictedAccessActive = true
    syncSelectionWatch()
  }
  if (changesDevTools) {
    // Turning the allowance off is a revocation: detach the debugger and abort
    // every in-flight devtools call so the capability cannot outlive the choice.
    if (revokesDevTools) {
      cancelDevToolsCalls()
      await devTools.revoke()
    } else if (updated.allowDevTools) {
      devTools.resume()
      await prewarmDevTools()
    } else {
      // Still off: nothing to prewarm, and no consent was granted.
      devTools.resume()
    }
    broadcastDevToolsState()
  }
  armDevToolsExpiry()
}

/** Alarm that ends the developer-tools allowance when its window closes. */
const DEVTOOLS_EXPIRY_ALARM = 'dsh-devtools-allowance'

/** Schedule (or cancel) the end of the developer-tools allowance. */
function armDevToolsExpiry(): void {
  if (settings.allowDevTools) {
    chrome.alarms.create(DEVTOOLS_EXPIRY_ALARM, { when: settings.allowDevToolsUntil })
    return
  }
  void Promise.resolve(chrome.alarms.clear(DEVTOOLS_EXPIRY_ALARM)).catch(() => {})
}

/**
 * Turn the developer-tools allowance off once its window has closed. This is
 * a revocation like the user's own: grants are dropped, in-flight devtools
 * calls are cancelled and the debugger is detached.
 */
function expireDevToolsAllowance(): void {
  if (!settingsLoaded || !settings.allowDevTools || settings.allowDevToolsUntil > Date.now()) return
  void persistSettings({ allowDevTools: false }).catch(() => {})
}

function normalizeUserSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  const allowance = readDevToolsAllowance(candidate.allowDevTools, candidate.allowDevToolsUntil, Date.now())
  // A browser without a debugger API can never use the developer tools.
  const allowDevTools = allowance.allowDevTools && devToolsCapability
  return {
    ...candidate,
    sharePageContent,
    unrestrictedBrowserAccess: candidate.unrestrictedBrowserAccess === true,
    allowDevTools,
    allowDevToolsUntil: allowDevTools ? allowance.allowDevToolsUntil : 0,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    catchPageDialogs: candidate.catchPageDialogs === true && devToolsCapability,
    autoResumeSession: candidate.autoResumeSession !== false,
    approvalTimeoutMinutes: typeof candidate.approvalTimeoutMinutes === 'number' && Number.isFinite(candidate.approvalTimeoutMinutes)
      ? Math.min(MAX_APPROVAL_TIMEOUT_MINUTES, Math.max(1, Math.round(candidate.approvalTimeoutMinutes)))
      : SETTINGS_DEFAULTS.approvalTimeoutMinutes,
    siteRules: normalizeSiteRules(candidate.siteRules),
    siteDefaultsEnabled: candidate.siteDefaultsEnabled !== false,
    strictSites: Array.isArray(candidate.strictSites)
      ? [...new Set(candidate.strictSites.map(normalizeSitePattern).filter((entry): entry is string => entry !== undefined))].sort()
      : [],
    settingsVersion: SETTINGS_VERSION,
    showAgentOverlay: candidate.showAgentOverlay !== false,
    allowPageWatchers: candidate.allowPageWatchers === true,
    taintExemptLocalPages: candidate.taintExemptLocalPages !== false,
    taintExemptTrustedSites: candidate.taintExemptTrustedSites !== false,
    taintLocalOrigins: normalizeTaintLocalOrigins(candidate.taintLocalOrigins),
    taintTrustedSites: normalizeTaintTrustedSites(candidate.taintTrustedSites),
    taintTrustConfirmed: Array.isArray(candidate.taintTrustConfirmed)
      ? [...new Set(candidate.taintTrustConfirmed.filter((key): key is string => typeof key === 'string'))].sort()
      : [],
    offerAutoReview: candidate.offerAutoReview !== false,
  }
}

/** User settings with enterprise overrides applied (managed values win). */
function normalizeSettings(candidate: Settings): Settings {
  return applyManagedOverrides(normalizeUserSettings(candidate), policyRuntime.managed)
}

/**
 * Keep extension storage to trusted contexts (this worker and extension
 * pages). Chrome's default lets content scripts read and write
 * `storage.local`; they run in the renderer of whatever page is open, and the
 * settings, the kill switch and the standing-work hint live there. No content
 * script of this extension uses storage. Firefox has no such API: there the
 * checks on what is read back are the only layer.
 */
function restrictStorageAccess(): void {
  type Restrictable = { setAccessLevel?: (options: { accessLevel: string }) => Promise<void> | void }
  const storage = (globalThis as { chrome?: { storage?: Record<string, Restrictable | undefined> } }).chrome?.storage
  for (const name of ['local', 'sync', 'session']) {
    try {
      const area = storage?.[name]
      if (typeof area?.setAccessLevel !== 'function') continue
      void Promise.resolve(area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => {})
    } catch { /* not supported here */ }
  }
}
restrictStorageAccess()

// The side panel owns the UI language preference, but approval notifications
// and tool error strings are formatted here, so mirror the same key into this
// worker's cache and keep following panel writes.
void loadUiLocalePreference()
watchUiLocalePreference()

/** Settings load is shared by every lazy connection trigger. */
let settingsLoaded = false
// Managed policy loads first: user settings are normalized against it, so a
// managed "disable unrestricted" can never lose a startup race.
const settingsReady = policyRuntime.ready.then(() => loadSettings()).then((loaded) => {
  settings = loaded
  unrestrictedAccessActive = loaded.unrestrictedBrowserAccess
  settingsLoaded = true
  armDevToolsExpiry()
})

/**
 * Arm the alarm that restarts the worker and the connection: every half
 * minute normally; one shot at the next retry time while a standing-work
 * reconnect is parked (creating an alarm replaces the one with the same name).
 */
function armBridgeKeepalive(): void {
  if (standingRetry.parked && panelPorts.size === 0) {
    chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { when: Math.max(standingRetry.retryAt, Date.now() + STANDING_RETRY_BASE_MS) })
    return
  }
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

function disarmBridgeKeepalive(): void {
  void Promise.resolve(chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM)).catch(() => {})
}

/** One status snapshot: transport state, capabilities, and discovery state. */
function statusPayload(): {
  type: 'status'
  state: BridgeState
  caps: BridgeCaps | null
  discovery: DiscoveryState
  address?: string
  failure?: BridgeFailure
  killSwitch: boolean
  /** Unattended work that keeps this browser connected with no panel open. */
  standing: StandingSummary
} {
  return {
    type: 'status',
    state: bridge?.state ?? ('stopped' as BridgeState),
    caps,
    discovery: discoveryState,
    killSwitch: killSwitchEngaged,
    standing: standingSummary(),
    ...(connectedAddress === undefined ? {} : { address: connectedAddress }),
    ...(bridge?.failure === undefined || bridge.state === 'connected'
      ? (bridge === null && outageGaveUp ? { failure: 'gave-up' as const } : {})
      : { failure: bridge.failure }),
  }
}

// ---- Kill switch and the "agent controls this tab" badge ----

const KILL_SWITCH_KEY = 'dshKillSwitch'
/** Keyboard command declared in the manifest (`commands`). */
const KILL_SWITCH_COMMAND = 'kill-switch'
/** While engaged, nothing reconnects the bridge until the user releases it. */
let killSwitchEngaged = false
let killSwitchLoaded = false
/** Where the switch persists: local survives browser restarts and extension reloads; session is read for older state. */
function killSwitchAreas(): chrome.storage.StorageArea[] {
  const storage = chrome.storage as { local?: chrome.storage.StorageArea; session?: chrome.storage.StorageArea }
  return [storage.local, storage.session].filter((area): area is chrome.storage.StorageArea => area !== undefined)
}
const killSwitchReady = (async (): Promise<void> => {
  for (const area of killSwitchAreas()) {
    try {
      const stored = await area.get(KILL_SWITCH_KEY)
      // A worker restart, browser restart, or extension reload must not
      // silently reconnect a stopped agent: only the user's Reconnect clears it.
      if (stored?.[KILL_SWITCH_KEY] === true) killSwitchEngaged = true
    } catch { /* unreadable area: keep looking */ }
  }
  killSwitchLoaded = true
  if (killSwitchEngaged) refreshActionBadges()
})()

function persistKillSwitch(): void {
  for (const area of killSwitchAreas()) {
    void Promise.resolve(area.set({ [KILL_SWITCH_KEY]: killSwitchEngaged })).catch(() => {})
  }
}

/** Debugger-backed input and dialog answers stop with the switch, even for calls already past their checks. */
async function refuseWhileKilled(): Promise<void> {
  if (!killSwitchLoaded) await killSwitchReady
  if (killSwitchEngaged) throw new DevToolsError('devtools-detached', 'The user stopped the agent (kill switch); nothing more is sent to the page.')
}

/** Tell every content script to stop loops already running (waits, scrolling, selects). */
function abortContentActions(): void {
  void Promise.resolve(chrome.tabs?.query?.({})).then((tabs) => {
    for (const tab of tabs ?? []) {
      if (tab.id === undefined) continue
      void Promise.resolve(chrome.tabs.sendMessage(tab.id, { type: 'DSH_ABORT' })).catch(() => undefined)
    }
  }).catch(() => undefined)
}

function broadcastKillSwitch(): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'kill-switch', engaged: killSwitchEngaged }) } catch { /* port closed */ }
  }
}

interface ActionBadgeApi {
  setBadgeText?(details: { text: string; tabId?: number }): Promise<void> | void
  setBadgeBackgroundColor?(details: { color: string; tabId?: number }): Promise<void> | void
  setTitle?(details: { title: string; tabId?: number }): Promise<void> | void
}

/** Tabs currently showing the "agent controls this tab" badge. */
const badgedTabs = new Set<number>()
const CONTROL_BADGE = { text: 'AI', color: '#1769aa' }
const STOPPED_BADGE = { text: 'OFF', color: '#b42318' }

function actionApi(): ActionBadgeApi | undefined {
  return (globalThis as { chrome?: { action?: ActionBadgeApi } }).chrome?.action
}

function setBadge(api: ActionBadgeApi, badge: { text: string; color: string }, tabId?: number): void {
  const target = tabId === undefined ? {} : { tabId }
  void Promise.resolve(api.setBadgeText?.({ text: badge.text, ...target })).catch(() => {})
  if (badge.text !== '') void Promise.resolve(api.setBadgeBackgroundColor?.({ color: badge.color, ...target })).catch(() => {})
}

/** Tabs the agent may operate right now: every session's controlled tab. */
function controlledTabIds(): Set<number> {
  const ids = new Set<number>()
  if (killSwitchEngaged || bridge?.state !== 'connected') return ids
  const controlled = tabAffinity.snapshot().controlled
  if (controlled !== null) ids.add(controlled.tabId)
  for (const tab of Object.values(tabAffinity.sessionMap())) ids.add(tab.tabId)
  return ids
}

/**
 * Keep the toolbar badge truthful: "AI" on each tab the agent controls while
 * connected, and a global "OFF" (on every tab) while the kill switch is engaged.
 */
function refreshActionBadges(): void {
  // The on-page frame and pill follow the same truth as the badge.
  agentOverlay.syncControl(controlledTabIds())
  const api = actionApi()
  if (api === undefined) return
  if (killSwitchEngaged) {
    setBadge(api, STOPPED_BADGE)
    // Tab-specific badges override the global one.
    for (const tabId of badgedTabs) setBadge(api, STOPPED_BADGE, tabId)
    return
  }
  setBadge(api, { text: '', color: '' })
  const wanted = controlledTabIds()
  for (const tabId of badgedTabs) {
    if (wanted.has(tabId)) continue
    setBadge(api, { text: '', color: '' }, tabId)
    badgedTabs.delete(tabId)
  }
  for (const tabId of wanted) {
    setBadge(api, CONTROL_BADGE, tabId)
    badgedTabs.add(tabId)
  }
}

/**
 * Stop the agent immediately: cancel pending approvals and every in-flight
 * tool call, revoke session/origin trust and developer-tools grants, turn
 * unrestricted access off, detach the debugger from every tab, and drop the
 * bridge until the user explicitly reconnects.
 */
async function engageKillSwitch(): Promise<void> {
  killSwitchEngaged = true
  persistKillSwitch()
  // Sent before the bridge drops so the audit log records why calls ended.
  if (rpc !== null && bridge?.connected === true) void rpc.request(BRIDGE_AUDIT_RECORD_METHOD, { event: 'kill-switch' }).catch(() => {})
  pauseGate.cancelAll()
  // Nothing may reconnect or resume while the switch is engaged.
  bridgeStartRevision += 1
  activeScan?.controller.abort()
  approvals.cancelAll()
  sessionTrustedActionOrigins.clear()
  devToolsGrants.clear()
  programGrants.clear()
  // Auto review ends everywhere; reviews in flight fall back to (cancelled) cards.
  autoReviews.endAll('kill-switch')
  // No series card may be raised for a run started before the switch, and its wait ends now.
  learning.disarmSeries()
  // Fleet children lose their tab bindings; the tabs stay open for the user.
  void fleets.releaseAll(fleetDeps(AbortSignal.abort(), async () => 'denied'))
  // Standing watchers are standing grants: the kill switch revokes them too.
  void pageWatchers.clearAll()
  // So are dev-loop links (the bridge drops its side and workflow schedules on the kill-switch record above).
  void devLoop.clear()
  for (const call of unsettledToolCalls) {
    call.revocationRequested = true
    call.controller.abort()
  }
  for (const refresh of activeFollowRefreshes.values()) refresh.controller.abort()
  cancelAllToolCalls()
  abortContentActions()
  interactionResponses.failAll(responseMessages().disconnected)
  transientEvents.clear()
  dialogs.clearAll()
  bridge?.stop()
  bridge = null
  rpc = null
  caps = null
  connectedAddress = undefined
  // Standing work ends with the switch: the Host hint is forgotten (stored
  // copy included), so nothing reconnects for it behind the switch.
  hostStandingStored = true
  setHostStanding(NO_HOST_STANDING)
  clearStandingRetry()
  // A watcher hit waiting for a reconnect stops waiting; its re-check sees the switch.
  for (const resolve of [...bridgeWaiters]) resolve()
  disarmBridgeKeepalive()
  refreshActionBadges()
  broadcastStatus()
  broadcastKillSwitch()
  await Promise.allSettled([
    devTools.detachAll(),
    debuggerBroker.detachAll(),
    settingsReady.then(() => settings.unrestrictedBrowserAccess
      ? persistSettings({ unrestrictedBrowserAccess: false })
      : undefined),
  ])
  broadcastDevToolsState()
}

/** Clear an engaged kill switch and reconnect (explicit user action only). */
async function releaseKillSwitch(): Promise<void> {
  if (!killSwitchEngaged) return
  killSwitchEngaged = false
  persistKillSwitch()
  setBridgeRefusal(undefined)
  discoveryLatch = 'idle'
  persistDiscoveryLatch('idle')
  refreshActionBadges()
  broadcastKillSwitch()
  if (panelPorts.size > 0) armBridgeKeepalive()
  await settingsReady
  await startBridge()
}

// ---- Show the agent on the page; pause, take over, resume ----

const agentOverlay = new AgentOverlayController({
  send: (tabId, message, target) => (target === undefined
    ? chrome.tabs.sendMessage(tabId, message)
    : chrome.tabs.sendMessage(tabId, message, target)),
  enabled: () => settingsLoaded && settings.showAgentOverlay,
  locale: () => getUiLocale(),
})

const PAUSE_KEY = 'dshAgentPause'
let persistedPause = 'null'
/** Tab facts recorded when the user paused; compared on resume. */
let pauseBaseline: Promise<PauseBaseline> | undefined

/** Tabs the agent is bound to, connected or not (the takeover banner goes there). */
function boundTabIds(): Set<number> {
  const ids = new Set<number>()
  const controlled = tabAffinity.snapshot().controlled
  if (controlled !== null) ids.add(controlled.tabId)
  for (const tab of Object.values(tabAffinity.sessionMap())) ids.add(tab.tabId)
  return ids
}

const pauseGate = new PauseGate({
  onChange: (state) => {
    const persisted = JSON.stringify(pauseGate.persisted() ?? null)
    if (persisted !== persistedPause) {
      persistedPause = persisted
      const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
      // A worker restart must not silently unpause the agent.
      if (area !== undefined) void Promise.resolve(area.set({ [PAUSE_KEY]: pauseGate.persisted() ?? null })).catch(() => {})
    }
    agentOverlay.setTakeover(state.mode === 'taken-over' ? boundTabIds() : new Set())
    for (const port of panelPorts) {
      try { port.postMessage({ type: 'agent.pause-state', state }) } catch { /* port closed */ }
    }
  },
})

const pauseReady = (async (): Promise<void> => {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
  try {
    const stored = area === undefined ? undefined : await area.get(PAUSE_KEY)
    pauseGate.restore(stored?.[PAUSE_KEY])
  } catch { /* unreadable: running */ }
})()

function resumeFlowDeps(): ResumeFlowDeps {
  const toFacts = (tab: chrome.tabs.Tab) => ({
    id: tab.id!,
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.openerTabId === undefined ? {} : { openerTabId: tab.openerTabId }),
  })
  return {
    queryTabs: async () => (await chrome.tabs.query({})).filter((tab) => tab.id !== undefined).map(toFacts),
    getTab: (tabId) => chrome.tabs.get(tabId).then(toFacts, () => undefined),
    boundSessions: () => {
      const controlled = tabAffinity.snapshot().controlled
      return controlled === null ? [] : tabAffinity.sessionIdsForTab(controlled.tabId)
    },
    sessionTab: (sessionId) => sessionId === ''
      ? tabAffinity.snapshot().controlled?.tabId
      : tabAffinity.getSessionTab(sessionId)?.tabId,
    shareDetails: () => unrestrictedAccessEnabled() || settings.sharePageContent !== 'off',
    pageHidden: (url) => policyRuntime.pageHidden(url),
    pageDelta: async (sessionId, tabId) => {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, 20_000)
      try {
        const target = await resolveToolTab(sessionId)
        if ('ok' in target || target.id !== tabId) return undefined
        const unrestrictedAccess = unrestrictedAccessEnabled()
        const answer = await dispatchToolCall(
          { id: crypto.randomUUID(), name: 'browser_snapshot', args: { delta: true } },
          unrestrictedAccess ? 'auto' : settings.sharePageContent,
          caps === null ? undefined : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars },
          (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId ?? 0, { sessionId, unrestrictedAccess }),
          controller.signal,
          target,
          () => tabAffinity.allowsTarget(tabId, sessionId),
          // Site rules and managed policy apply to the resume read like any other.
          { unrestrictedAccess, policy: policyRuntime.evaluator(sessionId, unrestrictedAccess) },
        )
        const text = answer.ok && typeof answer.result === 'object' && answer.result !== null
          ? (answer.result as { text?: unknown }).text
          : undefined
        return typeof text === 'string' ? text : undefined
      } finally {
        clearTimeout(timer)
      }
    },
    inject: async (sessionId, text) => {
      // An MCP client's session has no DSH conversation to inform.
      if (isExternalSessionId(sessionId)) return
      await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot: text, reason: 'resume' })
      const tabId = tabAffinity.getSessionTab(sessionId)?.tabId
      const url = tabId === undefined ? undefined : await chrome.tabs.get(tabId).then((tab) => tab.url, () => undefined)
      policyRuntime.recordInjection(sessionId, originFromUrl(url ?? ''))
    },
  }
}

/** "Pause after this step" or "Take over": hold every next tool call. */
async function pauseAgent(request: PauseRequest): Promise<void> {
  await pauseReady
  const wasRunning = !pauseGate.holding()
  pauseGate.pause(request)
  // Taking over hands the page to the user: their own writes are not the agent's.
  if (request === 'take-over') commitGateTurnEnded(undefined)
  // ... and a "do the remaining N" series does not continue blind over whatever they change.
  if (request === 'take-over') programGrants.onTakeOver()
  // Taking over ends Auto review: the user is in control, and turns it on again if they want it.
  if (request === 'take-over') autoReviews.endAll('take-over')
  if (wasRunning) pauseBaseline = capturePauseBaseline(resumeFlowDeps())
}

/** Tell the agent what changed, then release (or fail) the held calls. */
async function resumeAgent(): Promise<void> {
  await pauseReady
  // The kill switch already cancelled every held call; nothing resumes while it holds.
  if (killSwitchEngaged) {
    pauseGate.cancelAll()
    return
  }
  const baseline = pauseBaseline
  pauseBaseline = undefined
  await pauseGate.resume(async (held, context) => prepareResume(held, context, await baseline, resumeFlowDeps()))
}

/** Whether this browser offers Auto review at all right now (Setting, managed policy, bridge cap). */
function autoReviewOffered(): boolean {
  return settingsLoaded && settings.offerAutoReview && !policyRuntime.managed.disableAutoReview
    && caps?.autoReview === AUTO_REVIEW_CAPS_VERSION && bridge?.state === 'connected' && !killSwitchEngaged
}

/** Auto review on, for one conversation, now. */
function autoReviewOn(sessionId: string | undefined): boolean {
  return sessionId !== undefined && autoReviewOffered() && autoReviews.isOn(sessionId)
}

function autoReviewStatePayload(): Record<string, unknown> {
  return {
    type: 'auto-review.state',
    offered: autoReviewOffered(),
    // Why not, when it is not: the panel says so in one line.
    ...autoReviewOffered() ? {} : {
      unavailable: !settingsLoaded || !settings.offerAutoReview ? 'setting'
        : policyRuntime.managed.disableAutoReview ? 'managed'
          : killSwitchEngaged ? 'kill-switch'
            : bridge?.state !== 'connected' ? 'disconnected'
              : 'bridge',
    },
    sessions: autoReviews.views(),
  }
}

function broadcastAutoReviewState(): void {
  const payload = autoReviewStatePayload()
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Tell panels a review is running (the step shows "Reviewing…") or done. */
function broadcastReviewing(sessionId: string, toolCallId: string | undefined, label: string, active: boolean): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'auto-review.reviewing', sessionId, ...toolCallId === undefined ? {} : { toolCallId }, label, active }) } catch { /* port closed */ }
  }
}

function broadcastStatus(): void {
  refreshActionBadges()
  broadcastAutoReviewState()
  const payload = statusPayload()
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Broadcast developer-tools support, attachment state, and the user's choice. */
function broadcastDevToolsState(): void {
  for (const port of panelPorts) postDevToolsState(port)
}

/** Report developer-tools state to one panel port. */
function postDevToolsState(port: chrome.runtime.Port): void {
  const state = devTools.state()
  try {
    port.postMessage({
      type: 'devtools.status',
      supported: state.supported,
      enabled: devToolsAllowed(),
      attached: state.attached,
      ...(state.tabId === undefined ? {} : { tabId: state.tabId }),
      ...(state.error === undefined ? {} : { error: state.error }),
    })
  } catch { /* port already closed */ }
}

function broadcastTabAffinity(): void {
  refreshActionBadges()
  const payload = { type: 'tab-affinity', state: tabAffinity.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Which window each panel port belongs to, so a quote stays in its window. */
const panelWindows = new WeakMap<chrome.runtime.Port, number>()
/** The conversation each live panel is displaying, used for close checkpoints. */
const panelActiveSessions = new WeakMap<chrome.runtime.Port, string>()

/**
 * Send one window's selection to that window's panels only.
 *
 * A panel must never be offered a quote from a page its own window is not
 * looking at, which also keeps an incognito window's highlight out of a
 * normal window's composer.
 */
function broadcastSelection(windowId: number): void {
  const payload = { type: 'selection', selection: selections.current(windowId) }
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastSelections(windowIds: readonly number[]): void {
  for (const windowId of windowIds) broadcastSelection(windowId)
}

/** Whether a window currently has a panel that can display its selection. */
function hasPanelInWindow(windowId: number): boolean {
  for (const port of panelPorts) {
    if (panelWindows.get(port) === windowId) return true
  }
  return false
}

/**
 * Tell a frame its quote is gone so re-selecting the same passage reports it
 * again; the content script deduplicates against the last text it sent.
 */
function resetSelectionDedupe(sources: readonly SelectionSource[]): void {
  for (const { tabId, frameId } of sources) {
    void Promise.resolve(chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_SELECTION_RESET' },
      { frameId },
    ))
      .catch(() => { /* no content script in this tab */ })
  }
}

/** Whether saved privacy settings currently allow page-selection capture. */
function selectionSharingEnabled(): boolean {
  // Until storage answers, `settings` still holds the defaults. Reporting the
  // default here would arm watchers for a user whose saved choice is `off`.
  return settingsLoaded && (unrestrictedAccessEnabled() || settings.sharePageContent !== 'off')
}

/** Whether unrestricted access is enabled and no earlier grant is still being revoked. */
function unrestrictedAccessEnabled(): boolean {
  return unrestrictedAccessActive && unrestrictedRevocation === undefined
}

/**
 * Whether the user has opted into developer tools without a per-call prompt.
 * The ephemeral session grant is applied by the approval gate instead, so this
 * reports only the persisted setting.
 */
function devToolsAllowed(): boolean {
  if (!settingsLoaded || !settings.allowDevTools) return false
  if (settings.allowDevToolsUntil > Date.now()) return true
  // The window closed before its alarm ran (a sleeping machine, a throttled
  // alarm): refuse now and run the revocation.
  expireDevToolsAllowance()
  return false
}

/** Page selections are captured only in a window with an open panel. */
function selectionWatchEnabled(windowId: number): boolean {
  return selectionSharingEnabled() && hasPanelInWindow(windowId)
}

let selectionWatchArmed = false
/** Distinguishes revisions issued by different MV3 worker lifetimes. */
const selectionWatchEpoch = crypto.randomUUID()
/** Orders arm/disarm commands so a slow delivery cannot undo a newer one. */
let selectionWatchRevision = 0

/**
 * Arm or disarm every content script. `selectionchange` fires on each drag in
 * each tab, so the watcher stays off until a panel can actually show a quote.
 *
 * Delivery is asynchronous, so each command carries a revision: a panel that
 * closes and reopens quickly must not leave watchers in the state of whichever
 * `tabs.query` happened to resolve last.
 */
function syncSelectionWatch(): void {
  const anyEnabled = selectionSharingEnabled()
    && [...panelPorts].some((port) => panelWindows.get(port) !== undefined)
  const wasArmed = selectionWatchArmed
  selectionWatchArmed = anyEnabled
  const revision = ++selectionWatchRevision
  if (wasArmed && !anyEnabled) {
    resetSelectionDedupe(selections.sourcesWithSelection())
    broadcastSelections(selections.clearAll())
  }
  void Promise.resolve(chrome.tabs.query({})).then((tabs) => {
    if (revision !== selectionWatchRevision) return
    for (const tab of tabs) {
      if (tab.id === undefined) continue
      const enabled = selectionWatchEnabled(tab.windowId)
      void Promise.resolve(chrome.tabs.sendMessage(tab.id, {
        type: 'DSH_SELECTION_WATCH',
        enabled,
        epoch: selectionWatchEpoch,
        revision,
      }))
        .catch(() => { /* no content script in this tab */ })
    }
  }).catch(() => {})
}

/**
 * Accept a capture from the page the user is actually looking at.
 *
 * `sender.tab` already carries the tab's window, active state, and incognito
 * flag, so admission needs no `chrome.tabs` call: a background page cannot
 * make the worker query Chrome by moving its own selection in a loop.
 */
function recordSelection(tab: chrome.tabs.Tab, frameId: number, value: unknown): void {
  if (!selectionWatchEnabled(tab.windowId)) return
  // Only the tab the user is looking at, in its own window, may set a quote.
  if (tab.id === undefined || tab.active !== true) return
  const capture = parseSelectionCapture(value)
  if (capture === null) return
  if (selections.capture({ windowId: tab.windowId, tabId: tab.id, frameId }, capture)) {
    broadcastSelection(tab.windowId)
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* port already closed */ }
  }
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: 'approval.request', request })
      delivered = true
    } catch { /* port already closed */ }
  }
  return delivered
}

const EXT_TARGET: 'chrome' | 'firefox' = import.meta.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome'

function backgroundApprovalTimeoutMs(): number {
  return settings.approvalTimeoutMinutes * 60_000
}

/**
 * Show one approval as an OS notification. Chrome gets Allow once / Deny for
 * approvals the notification fully describes and Review / Deny otherwise;
 * Firefox has no notification buttons, so its notification opens the sidebar.
 */
function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  void (async () => {
    // Name the tab the call acts on (its title is page-authored: quoted, capped).
    let tabTitle: string | undefined
    const tabId = request.sessionId === undefined
      ? tabAffinity.snapshot().controlled?.tabId
      : tabAffinity.getSessionTab(request.sessionId)?.tabId
    if (tabId !== undefined) {
      try { tabTitle = (await chrome.tabs.get(tabId)).title } catch { /* tab gone */ }
    }
    await chrome.notifications.create(approvalNotificationId(request.id), approvalNotificationOptions(request, {
      target: EXT_TARGET,
      iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
      copy: APPROVAL_NOTIFICATION_COPY[getUiLocale() === 'zh' ? 'zh' : 'en'],
      minutes: backgroundApprovalTimeoutMs() / 60_000,
      ...tabTitle === undefined ? {} : { tabTitle },
    }))
  })().catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

/** Approvals forwarded to dsh, by approval id → the tool call they gate. */
const forwardedApprovals = new Map<string, string>()
/** Room after an approval's own deadline for the approved call to run. */
const APPROVAL_HOLD_MARGIN_MS = 60_000

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: (id) => {
    broadcastApprovalResolved(id)
    const toolCallId = forwardedApprovals.get(id)
    if (toolCallId !== undefined) {
      forwardedApprovals.delete(id)
      // First answer wins: withdraw the question from dsh's other clients.
      void rpc?.request(BRIDGE_APPROVAL_WITHDRAW_METHOD, { toolCallId, approvalId: id }).catch(() => {})
    }
    runtimeKeeper.update()
  },
  background: onBackgroundApproval,
}, APPROVAL_TIMEOUT_MS, backgroundApprovalTimeoutMs)

/**
 * An approval with no side panel: hold its tool call on the bridge for the
 * longer no-panel window, and put it to dsh's approval service so the web UI
 * or CLI can answer. The answer must echo this request's id and payload
 * binding (ApprovalCoordinator.respondRemote), and can only allow once or deny.
 */
function onBackgroundApproval(approval: BackgroundApproval): void {
  runtimeLease.touch()
  runtimeKeeper.update()
  const { request, toolCallId } = approval
  const client = rpc
  if (toolCallId === undefined || client === null || bridge?.connected !== true
    || caps?.hostApprovals !== HOST_APPROVALS_CAPS_VERSION) return
  const holdMs = approval.deadline - Date.now() + APPROVAL_HOLD_MARGIN_MS
  void client.request(BRIDGE_TOOL_HOLD_METHOD, { toolCallId, holdMs }).then((result) => {
    const expiresAt = (result as { expiresAt?: unknown } | null)?.expiresAt
    if (typeof expiresAt === 'number') activeToolCalls.get(toolCallId)?.extendExpiry?.(expiresAt)
  }).catch(() => {})
  if (forwardedApprovals.has(request.id)) return
  const reason = hostApprovalReason(request)
  if (reason === undefined) return
  forwardedApprovals.set(request.id, toolCallId)
  void client.request(BRIDGE_APPROVAL_ASK_METHOD, {
    toolCallId,
    approvalId: request.id,
    ...(request.binding === undefined ? {} : { binding: request.binding }),
    reason,
  }, holdMs).then((result) => {
    const answer = result as { approvalId?: unknown; binding?: unknown; decision?: unknown } | null
    // dsh has answered: nothing is left there to withdraw.
    if (forwardedApprovals.get(request.id) === toolCallId) forwardedApprovals.delete(request.id)
    if (answer?.approvalId !== request.id) return
    if (answer.decision !== 'allow-once' && answer.decision !== 'deny') return
    approvals.respondRemote(request.id, typeof answer.binding === 'string' ? answer.binding : undefined, answer.decision)
  }).catch(() => {}).finally(() => {
    if (forwardedApprovals.get(request.id) === toolCallId) forwardedApprovals.delete(request.id)
  })
}

// ---- Panel-free runtime ----

const runtimeLease = new RuntimeLease({
  panels: () => panelPorts.size,
  toolCalls: () => activeToolCalls.size,
  approvals: () => approvals.size,
  standing: () => standingCount(standingSummary()),
})

// ---- Standing work (standing-work.ts) ----

/**
 * Unattended work that wants the connection. Zero while the kill switch is
 * engaged or not yet read, or while the bridge has refused this install
 * ({@link bridgeRefusal}); watchers count only while their setting is on.
 */
function standingSummary(): StandingSummary {
  if (!killSwitchLoaded || killSwitchEngaged || bridgeRefusal !== undefined) return { watchers: 0, schedules: 0, mcp: false }
  return {
    watchers: settingsLoaded && settings.allowPageWatchers ? pageWatchers.registry.list().length : 0,
    schedules: hostStanding.schedules,
    mcp: hostStanding.mcp,
  }
}

/** A watcher, the watcher setting, or the Host hint changed. */
function onStandingWorkChanged(): void {
  runtimeKeeper.update()
  broadcastStatus()
}

/** Adopt the bridge's hint and mirror it (with the address it came from) for the next browser start. */
function setHostStanding(work: StandingWork): void {
  const changed = work.schedules !== hostStanding.schedules || work.mcp !== hostStanding.mcp
  hostStanding = { schedules: work.schedules, mcp: work.mcp }
  const stored = storedStandingHost(hostStanding, connectedAddress)
  const area = (chrome.storage as { local?: chrome.storage.StorageArea }).local
  if (area !== undefined && (stored !== undefined || hostStandingStored)) {
    hostStandingStored = stored !== undefined
    // Never throws: the kill switch calls this in the middle of stopping everything.
    void (async () => {
      await (stored === undefined ? area.remove(STANDING_HOST_STORAGE_KEY) : area.set({ [STANDING_HOST_STORAGE_KEY]: stored }))
    })().catch(() => {})
  }
  if (changed) onStandingWorkChanged()
}

/**
 * The connection settings changed (address or token): what the previous
 * bridge said, and its address, no longer apply. Nothing may reconnect to a
 * bridge the user just left.
 */
function forgetStandingHost(): void {
  headlessBridgeUrl = undefined
  hostStandingStored = true
  setHostStanding(NO_HOST_STANDING)
  clearStandingRetry()
  runtimeKeeper.persistNow()
}

function persistStandingRetry(): void {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
  if (area === undefined) return
  const state = standingRetry.snapshot()
  void (async () => {
    await (state === undefined ? area.remove(STANDING_RETRY_STORAGE_KEY) : area.set({ [STANDING_RETRY_STORAGE_KEY]: state }))
  })().catch(() => {})
}

/**
 * Back to the normal reconnect cadence (connected, a panel opened, or nothing left to wait for).
 * @returns whether a reconnect was parked.
 */
function clearStandingRetry(): boolean {
  if (!standingRetry.parked) return false
  standingRetry.reset()
  persistStandingRetry()
  return true
}

/**
 * A headless attempt failed while only standing work wants the bridge: stop
 * retrying in a loop, let the worker sleep, and try again after a growing
 * delay (one-shot alarm). Never used while a panel, a call, or recent
 * activity wants the connection.
 */
function parkStandingReconnect(): void {
  standingRetry.fail()
  persistStandingRetry()
  bridgeStartRevision += 1
  const parked = bridge
  bridge = null
  rpc = null
  caps = null
  connectedAddress = undefined
  parked?.stop()
  armBridgeKeepalive()
  // A watcher hit waiting for this attempt has its answer now.
  for (const resolve of [...bridgeWaiters]) resolve()
}

/** Resolvers of watcher hits waiting for the bridge to come back. */
const bridgeWaiters = new Set<() => void>()
/** How long a watcher hit waits for a reconnecting bridge before it is recorded as a miss. */
const WATCH_HIT_CONNECT_WAIT_MS = 8_000
/** Earliest time another watcher hit may start a reconnect attempt of its own. */
let hitReconnectAt = 0

/**
 * A watcher hit passed its checks but the bridge is not connected: start a
 * headless attempt if none is running (at most one per
 * {@link STANDING_RETRY_BASE_MS}), and wait up to
 * {@link WATCH_HIT_CONNECT_WAIT_MS} for the connection. `startBridge` keeps
 * all its rules (kill switch, no headless discovery); the caller re-checks
 * the hit afterwards.
 */
async function bridgeForWatchHit(): Promise<void> {
  const connected = (): boolean => bridge?.connected === true
  if (connected()) return
  await runtimeRestored
  if (connected() || killSwitchEngaged || !runtimeWantsBridge()) return
  // Wait only for an attempt that is running or that this hit may start.
  const attempting = bridge?.active === true
  const mayStart = !attempting && panelPorts.size === 0 && Date.now() >= hitReconnectAt
  if (!attempting && !mayStart) return
  const waited = new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      bridgeWaiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, WATCH_HIT_CONNECT_WAIT_MS)
    bridgeWaiters.add(done)
  })
  if (mayStart) {
    hitReconnectAt = Date.now() + STANDING_RETRY_BASE_MS
    void settingsReady.then(() => startBridge()).catch(() => {})
  }
  await waited
}

/** The address a headless reconnect uses (the last connected one). */
let headlessBridgeUrl: string | undefined

const runtimeKeeper = new RuntimeKeeper(runtimeLease, {
  heartbeat: () => {
    bridge?.heartbeat()
    // Standing work alone does not keep a disconnected worker awake: the
    // retry alarm wakes it instead (parkStandingReconnect).
    if (runtimeLease.standingOnly() && bridge?.connected !== true) return
    // An extension API call also resets the worker's idle timer.
    try {
      void Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => {})
    } catch { /* not available in this context */ }
  },
  onActive: armBridgeKeepalive,
  onIdle: () => {
    if (panelPorts.size > 0) return
    bridgeStartRevision += 1
    bridge?.stop()
    clearStandingRetry()
    disarmBridgeKeepalive()
  },
  persist: (activeUntil) => {
    const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
    if (area === undefined) return
    const url = connectedAddress ?? headlessBridgeUrl
    void Promise.resolve(activeUntil === undefined || url === undefined
      ? area.remove(RUNTIME_LEASE_STORAGE_KEY)
      : area.set({ [RUNTIME_LEASE_STORAGE_KEY]: { activeUntil, url } })).catch(() => {})
  },
})

/** Sessions that sent this browser a tool call (bounded, most recent last). */
const runtimeSessions = new Set<string>()
const MAX_RUNTIME_SESSIONS = 32

function noteRuntimeSession(sessionId: string): void {
  runtimeSessions.delete(sessionId)
  runtimeSessions.add(sessionId)
  if (runtimeSessions.size > MAX_RUNTIME_SESSIONS) runtimeSessions.delete(runtimeSessions.values().next().value as string)
}

/** Whether anything wants the bridge connection: a panel or an active runtime lease. */
function runtimeWantsBridge(): boolean {
  return panelPorts.size > 0 || runtimeLease.active()
}

/** The session lease (and address) left by the previous worker instance. */
async function restoreRuntimeLease(): Promise<void> {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session
  if (area === undefined) return
  try {
    const stored = await area.get([RUNTIME_LEASE_STORAGE_KEY, STANDING_RETRY_STORAGE_KEY])
    standingRetry.restore(stored?.[STANDING_RETRY_STORAGE_KEY])
    const lease = stored?.[RUNTIME_LEASE_STORAGE_KEY] as { activeUntil?: unknown; url?: unknown } | undefined
    if (typeof lease?.activeUntil !== 'number' || typeof lease.url !== 'string') return
    runtimeLease.restore(lease.activeUntil)
    headlessBridgeUrl = lease.url
  } catch { /* unreadable: no lease */ }
}

/**
 * The Host hint left in storage.local: the only standing work that outlives
 * the browser session (watchers are session-bound by design). Dropped,
 * stored copy included, while the kill switch is engaged.
 */
async function restoreHostStanding(): Promise<void> {
  const area = (chrome.storage as { local?: chrome.storage.StorageArea }).local
  if (area === undefined) return
  try {
    const raw = (await area.get(STANDING_HOST_STORAGE_KEY))?.[STANDING_HOST_STORAGE_KEY]
    if (raw === undefined) return
    // A connection made meanwhile already delivered (and stored) a fresher hint.
    if (caps !== null && hostStandingStored) return
    const parsed = killSwitchEngaged || caps !== null ? undefined : parseStoredStandingHost(raw)
    // Never dial an address that appears only in the hint: it must be the
    // configured one, or the loopback address remembered after a proven handshake.
    await discoveryMemory
    const stored = parsed !== undefined && settingsLoaded
      && hintAddressAllowed(parsed.url, settings.bridgeUrl, lastBridgeUrl, isLocalBridgeAddress, BRIDGE_PATH) ? parsed : undefined
    if (stored === undefined) {
      await area.remove(STANDING_HOST_STORAGE_KEY)
      return
    }
    hostStandingStored = true
    hostStanding = { schedules: stored.schedules, mcp: stored.mcp }
    headlessBridgeUrl ??= stored.url
  } catch { /* unreadable: no hint */ }
}

/**
 * Restore what the previous worker instance (or, for the Host hint, the
 * previous browser session) left, and reconnect headlessly when the lease is
 * still held. The kill switch, the settings and the watcher registry are
 * read first: standing work depends on all three.
 */
const runtimeRestored = (async () => {
  await Promise.allSettled([killSwitchReady, settingsReady, pageWatchers.registry.ready, bridgeRefusalReady])
  await restoreRuntimeLease()
  await restoreHostStanding()
  runtimeKeeper.update()
  if (!runtimeLease.active() || panelPorts.size > 0) return
  if (runtimeLease.standingOnly() && !standingRetry.due()) {
    // A parked reconnect is not due yet: this wake-up (a tab event, a
    // message) does not shortcut the backoff. Boot cleared the alarm; re-arm it.
    armBridgeKeepalive()
    return
  }
  if (!settingsLoaded) return
  await startBridge()
})()

let clientIdentity: BridgeClientIdentity | undefined
const clientIdentityReady = loadClientIdentity(chrome.storage.local, EXT_TARGET)
  .then((identity) => { clientIdentity = identity })
  .catch(() => {})

function responseMessages(): { unavailable: string; timeout: string; duplicate: string; disconnected: string } {
  return getUiLocale() === 'zh'
    ? {
        unavailable: '未连接 dsh，无法提交回答',
        timeout: '提交回答超时，请重试',
        duplicate: '回答请求编号重复，请重试',
        disconnected: 'dsh 连接已断开，请重新连接后再试',
      }
    : {
        unavailable: 'dsh is not connected, so the answer could not be sent',
        timeout: 'Sending the answer timed out. Try again.',
        duplicate: 'The answer request ID was duplicated. Try again.',
        disconnected: 'The dsh connection was lost. Reconnect and try again.',
      }
}

function cancelPendingApprovals(sessionId?: string): void {
  approvals.cancelAll(sessionId)
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  const sessionTabs = tabAffinity.sessionMap()
  const hasSessionTabs = Object.keys(sessionTabs).length > 0
  const focusedSessionId = tabAffinity.focusedSession()
  const focus = focusedSessionId === null ? {} : { focusedSessionId }
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
      ...(state.pinned ? { pinned: true as const } : {}),
      ...(hasSessionTabs ? { sessionTabs } : {}),
      ...focus,
    }
  }
  return state.status === 'lost'
    ? { lost: true, ...(hasSessionTabs ? { sessionTabs } : {}), ...focus }
    : (hasSessionTabs ? { lost: true, sessionTabs, ...focus } : null)
}

function persistTabAffinity(): void {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return
  lastPersistedAffinity = serialized
  affinityPersistence = affinityPersistence.catch(() => {}).then(async () => {
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  }).catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
  })
}

function observeActiveSummary(summary: AffinityTab): void {
  const previousStatus = tabAffinity.snapshot().status
  if (!tabAffinity.observeActive(summary)) return
  if (previousStatus !== 'handoff' && tabAffinity.snapshot().status === 'handoff') {
    const focused = tabAffinity.focusedSession()
    if (focused !== null) {
      activeFollowRefreshes.get(focused)?.controller.abort()
      cancelPendingApprovals(focused)
    } else {
      cancelPendingApprovals()
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const tabs = chrome.tabs.query(query)
    const [tab] = signal === undefined ? await tabs : await abortable(tabs, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    observeActiveTab(tab)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  let record: StoredTabAffinity | null = null
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const focusedSessionId = (candidate as { focusedSessionId?: unknown } | undefined)?.focusedSessionId
    const focus = typeof focusedSessionId === 'string' && focusedSessionId.trim() !== '' ? { focusedSessionId } : {}
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const keptActiveTabId = (candidate as { keptActiveTabId?: unknown }).keptActiveTabId
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        lost: true,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record?.sessionTabs !== undefined) {
    const restoredSessions: Record<string, AffinityTab> = {}
    for (const [sid, storedTab] of Object.entries(record.sessionTabs)) {
      if (typeof storedTab?.tabId !== 'number' || !Number.isInteger(storedTab.tabId) || storedTab.tabId < 0) continue
      try {
        const live = summarizeTab(await chrome.tabs.get(storedTab.tabId))
        if (live !== null) restoredSessions[sid] = live
      } catch {
        // Closed tabs are deliberately pruned so the session fails closed.
      }
    }
    tabAffinity.restoreSessionTabs(restoredSessions)
  }
  tabAffinity.restoreFocusedSession(record?.focusedSessionId ?? null)

  if (record !== null && 'controlledTabId' in record) {
    try {
      const controlled = summarizeTab(await chrome.tabs.get(record.controlledTabId))
      if (controlled === null) tabAffinity.restoreLost()
      else tabAffinity.restoreControlled(controlled)
    } catch {
      tabAffinity.restoreLost()
    }
  } else if (record?.lost === true) {
    tabAffinity.restoreLost()
  }

  // Restore the pin before syncing the active tab: otherwise the sync would
  // surface a handoff prompt for a switch the user already said not to ask about.
  if (record !== null && 'pinned' in record && record.pinned === true) tabAffinity.restorePinned()
  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = tabAffinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      tabAffinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Refresh one session's recovery checkpoint from its actual controlled tab. */
async function checkpointSessionPage(sessionValue: unknown): Promise<void> {
  const sessionId = validSessionId(sessionValue)
  if (sessionId === undefined || isExternalSessionId(sessionId)) return
  await Promise.all([affinityReady, pageSessionContexts.ready])
  const bound = tabAffinity.getSessionTab(sessionId)
  if (bound === undefined) return
  try {
    const tab = await chrome.tabs.get(bound.tabId)
    if (tabAffinity.getSessionTab(sessionId)?.tabId !== bound.tabId) return
    pageSessionContexts.bind(sessionId, tab)
  } catch {
    // A concurrently closed tab is cleaned by tabs.onRemoved.
  }
}

/** Resolve the contextual hint only after the panel has identified its window. */
async function postResumeHint(port: chrome.runtime.Port, windowId: number): Promise<void> {
  await pageSessionContexts.ready
  let sessionId: string | null = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    if (tab !== undefined) sessionId = pageSessionContexts.candidate(tab)
  } catch {
    // Without an exact live page the panel must start a new conversation.
  }
  if (!panelPorts.has(port) || panelWindows.get(port) !== windowId) return
  try { port.postMessage({ type: 'session.resume-hint', sessionId }) } catch { /* port closed */ }
}

/** Re-checkpoint each open panel before issuing a bridge-epoch resume hint. */
function refreshPanelResumeHints(): void {
  for (const port of panelPorts) {
    const windowId = panelWindows.get(port)
    if (windowId === undefined) continue
    const sessionId = panelActiveSessions.get(port)
    const checkpoint = sessionId === undefined
      ? Promise.resolve()
      : checkpointSessionPage(sessionId)
    void checkpoint.then(() => postResumeHint(port, windowId), () => postResumeHint(port, windowId))
  }
}

/** Bind at prompt submission so a switch while the model is thinking is visible. */
async function ensureInitialTabBinding(sessionId?: string): Promise<boolean> {
  await affinityReady
  if (tabAffinity.resolveTarget(sessionId).kind !== 'initial') return true
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null) return false
    if (tabAffinity.bindInitial(summary, sessionId)) {
      persistTabAffinity()
      broadcastTabAffinity()
    }
    return true
  } catch {
    return false
  }
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing'): ToolAnswer {
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. In the side panel, choose whether to keep the previous page or follow the current page.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Select the current page in the side panel before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget(sessionId)
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      if (!await ensureInitialTabBinding(sessionId)) return affinityFailure('missing')
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget(sessionId)
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return tab
    } catch {
      const affectedSessions = tabAffinity.sessionIdsForTab(resolution.tab.tabId)
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        for (const sid of affectedSessions) {
          activeFollowRefreshes.get(sid)?.controller.abort()
          cancelPendingApprovals(sid)
        }
        persistTabAffinity()
        broadcastTabAffinity()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

/**
 * Pick a window for browser_open_tab without requiring an already-controlled page.
 * Handoff still blocks: the user must finish the keep/follow choice first.
 */
async function resolveOpenTabWindow(sessionId?: string): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget(sessionId)
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // Fall through to the focused window when the prior controlled tab is gone.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch { /* no focused window */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(
  tab: chrome.tabs.Tab,
  sessionId?: string,
  options: { active?: boolean } = {},
): boolean {
  const summary = summarizeTab(tab)
  if (summary === null) return false
  const sid = sessionId?.trim()
  bindOpenedTabAffinity(tabAffinity, summary, {
    active: options.active,
    sessionId: sid,
  })
  if (sid !== undefined && sid !== '') {
    void pageSessionContexts.ready.then(() => {
      pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
    })
  }
  persistTabAffinity()
  broadcastTabAffinity()
  return true
}

interface AuthorizeOptions {
  /** Session whose panel shows the card (and whose grants apply). */
  sessionId?: string | undefined
  /** Access mode the call started under; defaults to the current one. */
  unrestrictedAccess?: boolean
  /** Tab the card is about, when it is not the session's tab (commit gate, devtools). */
  tabId?: number | undefined
  toolCallId?: string
  /** Told when a card is actually shown (the audit log tells user approvals from standing rules). */
  onPrompt?: () => void
  /**
   * Set only by the ordinary tab-bound page dispatcher: this card may be
   * decided by Auto review if the floor allows it. Every other caller leaves
   * it undefined, so no other card is ever reviewed.
   */
  autoReview?: AutoReviewRequest
}

/** What Auto review needs to know about the call behind a card. */
interface AutoReviewRequest {
  call: ToolCall
  /** The session whose panel shows the call's cards (a fleet child's parent). */
  approvalSession: string | undefined
  /** A program grant covers the call. */
  program: boolean
  /** Title of the tab the call acts on (page-authored). */
  title?: string
  /** Auto review approved the card (the audit log records `auto-reviewed`). */
  onAutoReviewed: () => void
}

/** Longest a review RPC may take; the bridge answers "ask" after 9 s itself. */
const AUTO_REVIEW_RPC_TIMEOUT_MS = 15_000

/** A side panel is open and showing this conversation. */
function autoReviewVisible(sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false
  for (const port of panelPorts) if (panelActiveSessions.get(port) === sessionId) return true
  return false
}

function autoReviewFloor(prompt: ApprovalPrompt, request: AutoReviewRequest): ReturnType<typeof autoReviewEligibility> {
  const { call } = request
  const sessionId = call.sessionId
  return autoReviewEligibility(prompt, {
    enabled: autoReviewOn(sessionId),
    // Nobody watching (no panel, or another conversation in front): the card waits as usual.
    visible: autoReviewVisible(sessionId),
    ...sessionId === undefined ? {} : { sessionId },
    external: isExternalSessionId(sessionId),
    pageAction: true,
    program: request.program || call.program !== undefined,
    fleetChild: request.approvalSession !== sessionId,
    tainted: call.tainted === true || policyRuntime.get(sessionId) !== undefined,
    tool: call.name,
    args: call.args,
  })
}

/**
 * Let Auto review decide one card, if the deterministic floor allows it
 * (security/auto-review.ts). `approved` is applied by the caller exactly like
 * the user's "Allow once" for this card's binding; anything else shows the
 * card, with `note` as its one extra line.
 */
async function autoReviewCard(prompt: ApprovalPrompt, request: AutoReviewRequest, signal: AbortSignal): Promise<{ kind: 'approved' } | { kind: 'card'; note?: string; limit?: true }> {
  const { call } = request
  const sessionId = call.sessionId
  const zh = getUiLocale() === 'zh'
  const eligibility = autoReviewFloor(prompt, request)
  if (!eligibility.eligible || sessionId === undefined) return { kind: 'card' }
  const subject: ReviewSubject = {
    tool: eligibility.tool,
    ...(() => {
      const target = prompt.review?.targets?.target ?? prompt.review?.targets?.from
      return target?.state === 'found' ? { kind: target.kind } : {}
    })(),
    assessment: eligibility.assessment,
  }
  const budget = autoReviews.budget(sessionId)
  if (budget === 'turn-limit') return { kind: 'card', note: autoReviewSentence('turn-limit', subject, zh), limit: true }
  if (budget !== 'ok') return { kind: 'card', note: autoReviewSentence(budget, subject, zh) }
  const client = rpc
  if (client === null || prompt.binding === undefined) return { kind: 'card', note: autoReviewSentence('failed', subject, zh) }
  const binding = prompt.binding
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  signal.addEventListener('abort', onAbort, { once: true })
  const reviewId = crypto.randomUUID()
  const label = prompt.stepLabel ?? prompt.summary
  broadcastReviewing(sessionId, call.toolCallId, label, true)
  try {
    return await autoReviews.serialized(sessionId, controller, async () => {
      if (controller.signal.aborted || !autoReviewOn(sessionId)) return { kind: 'card' as const }
      // Every review costs a model call: they are capped per hour, not only the approvals.
      autoReviews.noteAttempt(sessionId)
      const counts = autoReviews.counts(sessionId)
      const action = buildReviewAction(prompt, eligibility.tool, call.args, {
        tainted: call.tainted === true || policyRuntime.get(sessionId) !== undefined,
        approvedThisTurn: counts.turn,
        ...request.title === undefined ? {} : { title: request.title },
        recent: counts.recent,
      }, eligibility.assessment)
      const cancel = (): void => { void client.request(BRIDGE_REVIEW_CANCEL_METHOD, { toolCallId: call.id, reviewId }).catch(() => {}) }
      controller.signal.addEventListener('abort', cancel, { once: true })
      let answer: { reviewId?: unknown; binding?: unknown; decision?: unknown; code?: unknown; userTurn?: unknown } | null
      try {
        answer = await client.request(BRIDGE_REVIEW_ASK_METHOD, { toolCallId: call.id, reviewId, binding, action }, AUTO_REVIEW_RPC_TIMEOUT_MS) as typeof answer
      } catch {
        return { kind: 'card' as const, note: autoReviewSentence('failed', subject, zh) }
      } finally {
        controller.signal.removeEventListener('abort', cancel)
      }
      // Turned off, a new message, the call cancelled: whatever came back, the user decides.
      if (controller.signal.aborted || !autoReviewOn(sessionId)) return { kind: 'card' as const }
      // Only an answer about exactly this card counts.
      if (answer?.reviewId !== reviewId || answer.binding !== binding) return { kind: 'card' as const, note: autoReviewSentence('failed', subject, zh) }
      if (typeof answer.userTurn === 'string') autoReviews.noteUserTurn(sessionId, answer.userTurn)
      const code: ReviewCode = (REVIEW_CODES as readonly unknown[]).includes(answer.code) ? answer.code as ReviewCode : 'failed'
      if (answer.decision === 'allow' && code === 'allowed') {
        // Nobody may have been watching while the model thought: decide the floor again now.
        const again = autoReviewFloor(prompt, request)
        if (!again.eligible) return { kind: 'card' as const, ...again.reason === 'not-visible' || again.reason === 'off' ? {} : { note: autoReviewSentence('changed', subject, zh) } }
        // The same rule, requiring the same words, as the answer was about.
        if (JSON.stringify(again.assessment) !== JSON.stringify(eligibility.assessment)) return { kind: 'card' as const, note: autoReviewSentence('changed', subject, zh) }
        if (autoReviews.budget(sessionId) !== 'ok') return { kind: 'card' as const, note: autoReviewSentence('message-limit', subject, zh) }
        autoReviews.noteApproved(sessionId, label)
        return { kind: 'approved' as const }
      }
      return { kind: 'card' as const, note: autoReviewSentence(code === 'allowed' ? 'failed' : code, subject, zh) }
    })
  } catch {
    return { kind: 'card', note: autoReviewSentence('failed', subject, zh) }
  } finally {
    signal.removeEventListener('abort', onAbort)
    broadcastReviewing(sessionId, call.toolCallId, label, false)
  }
}

async function authorizeToolCall(
  unlabelledPrompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  options: AuthorizeOptions = {},
): Promise<ApprovalAuthorization> {
  const { sessionId, tabId, toolCallId, onPrompt } = options
  const unrestrictedAccess = options.unrestrictedAccess ?? unrestrictedAccessEnabled()
  if (signal.aborted) return 'cancelled'
  // An MCP client's card says which client is asking.
  const prompt = externalRequesters.label(unlabelledPrompt, sessionId)
  const grantKind = devToolsGrantKind(prompt)
  const gate = resolveApprovalGate({
    prompt,
    devToolsAllowed: devToolsAllowed(),
    devToolsSessionGrant: grantKind !== undefined && devToolsGrants.covers(grantKind, sessionId, prompt.grantOrigin!),
    unrestrictedAccess,
    coveredByTrustedOrigins: actionCoveredByTrustedOrigins(
      prompt,
      sessionTrustedActionOrigins,
      settings.trustedActionOrigins,
    ),
  })
  if (gate !== 'prompt') return gate
  let shown = prompt
  if (options.autoReview !== undefined) {
    const reviewed = await autoReviewCard(prompt, options.autoReview, signal)
    if (signal.aborted) return 'cancelled'
    // Exactly like the user's "Allow once" for this card: the dispatcher
    // re-reads the page and re-checks the binding before anything runs.
    if (reviewed.kind === 'approved') {
      options.autoReview.onAutoReviewed()
      return 'approved'
    }
    if (reviewed.note !== undefined) shown = { ...shown, autoReviewNote: reviewed.note }
    if (reviewed.limit === true) shown = { ...shown, autoReviewLimit: true }
  }
  onPrompt?.()
  const result: ApprovalRequestResult = await approvals.request(shown, signal, windowId, sessionId, toolCallId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  // The user approved the "continue?" card: Auto may approve another batch this turn.
  if (shown.autoReviewLimit === true && decision !== 'deny' && options.autoReview?.call.sessionId !== undefined) {
    autoReviews.noteContinued(options.autoReview.call.sessionId)
  }
  if (prompt.devTools === true) {
    // A grant covers (agent session, origin) for DEVTOOLS_GRANT_TTL_MS, ends
    // when its tab leaves the origin, and is cleared when the last side panel
    // closes, the worker stops, or the user revokes the setting.
    const outcome = devToolsDecisionOutcome(prompt, decision)
    if (outcome.grant !== undefined) {
      if (panelPorts.size === 0) return 'cancelled'
      devToolsGrants.grant(outcome.grant, sessionId, prompt.grantOrigin!, tabId)
    }
    if (outcome.authorization === 'approved') devTools.resume()
    return outcome.authorization
  }
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/**
 * A prompt carrying a page selection puts page-authored text into the
 * session: taint it here and on the Host before the prompt is forwarded.
 */
async function taintAttachedSelection(sessionId: string, payload: unknown): Promise<void> {
  const content = (payload as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    const attached = splitSelectionMessage(text)
    if (attached === null) continue
    await policyRuntime.ready
    // A selection made on an exempt page (local, or a site the user trusts) taints neither side.
    if (policyRuntime.recordSelection(sessionId, originFromUrl(attached.selection.url), attached.selection.url).exempt) return
    await gatewayRpc(BRIDGE_TAINT_MARK_METHOD, { sessionId }).catch(() => { /* older bridge: extension taint still applies */ })
    return
  }
}

/** Capture the newly controlled tab and seed it into this session's next Agent step. */
async function refreshFollowedPage(sessionId: string, tabId: number): Promise<void> {
  if (isExternalSessionId(sessionId)) return
  activeFollowRefreshes.get(sessionId)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeRefresh: ActiveFollowRefresh = {
    controller,
    unrestrictedAccess,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeFollowRefreshes.set(sessionId, activeRefresh)
  try {
    await policyRuntime.ready
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    // The evaluator also collects which frames the snapshot read (taint exemption).
    const provenance = policyRuntime.provenanceEvaluator(sessionId, unrestrictedAccess)
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      unrestrictedAccess ? 'auto' : settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, { sessionId, unrestrictedAccess }),
      controller.signal,
      target,
      () => target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
      // Site rules, managed policy, and taint apply to the injected read too:
      // a blocked page is refused, an ask page shows its card.
      { unrestrictedAccess, policy: provenance.policy },
    )
    if (!answer.ok || controller.signal.aborted || !tabAffinity.allowsTarget(tabId, sessionId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    const origin = originFromUrl(target.url ?? '')
    // Decided and recorded in one step, before the bridge is told: a snapshot
    // of local or user-trusted pages only (every frame) taints neither side.
    const frames = provenance.origins()
    const urls = provenance.urls()
    if (policyRuntime.injectionExempt(sessionId, origin, frames, urls) && policyRuntime.recordInjection(sessionId, origin, frames, urls).exempt) {
      const local = policyRuntime.restsOnLocalPage([...origin === undefined ? [] : [origin], ...frames ?? []])
      await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot, taintExempt: true, ...local ? { taintExemptLocal: true } : {} })
      return
    }
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
    policyRuntime.recordInjection(sessionId, origin, frames)
  } finally {
    activeRefresh.settle()
    if (activeFollowRefreshes.get(sessionId) === activeRefresh) activeFollowRefreshes.delete(sessionId)
  }
}

async function refreshSessionSnapshot(sessionId: string): Promise<void> {
  await affinityReady
  const target = await resolveToolTab(sessionId)
  if (!('ok' in target) && target.id !== undefined) {
    await refreshFollowedPage(sessionId, target.id)
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}): Promise<void> {
  await affinityReady
  await syncActiveTab()
  const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
  const accepted = tabAffinity.decide(response.decision, response.revision, sid)
  const controlled = accepted && response.decision === 'follow'
    ? tabAffinity.snapshot().controlled
    : null
  if (controlled !== null) resetTabSnapshot(controlled.tabId)
  if (accepted) {
    persistTabAffinity()
    if (controlled !== null && sid !== undefined) {
      await pageSessionContexts.ready
      pageSessionContexts.bind(sid, { id: controlled.tabId, ...controlled })
    }
  }
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/**
 * Bring the user's own visible tab back to the page the assistant is bound to.
 *
 * This is the only path that moves the user's visible tab, and it only runs
 * after an explicit click. The binding never changes: the controlled tab is
 * still exactly the page the user already approved, so observing it as the
 * active tab resolves the handoff back to `following` without widening what any
 * tool may touch. Every failure leaves the binding and the visible tab alone
 * (except a vanished tab, which fails closed into `lost`).
 */
async function returnToControlledTab(revision: number, panelWindowId: number | undefined): Promise<void> {
  await affinityReady
  const state = tabAffinity.snapshot()
  const controlled = state.controlled
  if (controlled === null) {
    throw new TabAffinityReturnError('no-controlled-tab', getUiLocale() === 'zh'
      ? '助手没有可返回的页面'
      : 'The assistant has no page to return to')
  }
  if (state.revision !== revision) {
    throw new TabAffinityReturnError('stale-revision', getUiLocale() === 'zh'
      ? '标签页状态已变化，请重新选择'
      : 'The tab state changed, so this choice no longer applies')
  }
  const tabId = controlled.tabId
  let live: chrome.tabs.Tab
  try {
    // Read the tab itself rather than the snapshot: the user may have dragged it
    // into another window since the binding was recorded.
    live = await chrome.tabs.get(tabId)
  } catch {
    // The approved page is gone: fail closed and let every panel show `lost`.
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (tabAffinity.removeTab(tabId)) {
      for (const sid of affectedSessions) {
        activeFollowRefreshes.get(sid)?.controller.abort()
        cancelPendingApprovals(sid)
      }
      persistTabAffinity()
      broadcastTabAffinity()
    }
    throw new TabAffinityReturnError('lost', getUiLocale() === 'zh'
      ? '受控标签页已关闭，无法返回'
      : 'The controlled tab was closed, so there is no page to return to')
  }
  if (panelWindowId === undefined || live.windowId !== panelWindowId) {
    try {
      await chrome.windows.update(live.windowId, { focused: true })
    } catch {
      throw new TabAffinityReturnError('focus-failed', getUiLocale() === 'zh'
        ? '无法切换到助手页面所在的窗口'
        : 'The window holding the assistant page could not be focused')
    }
  }
  try {
    await chrome.tabs.update(tabId, { active: true })
  } catch {
    throw new TabAffinityReturnError('activate-failed', getUiLocale() === 'zh'
      ? '无法切换到助手页面'
      : 'The assistant page could not be activated')
  }
  // Chrome also emits tabs.onActivated, but that path only accepts activations
  // from the focused window. Observing the tab directly keeps the state
  // deterministic for the panel that is waiting on this acknowledgement.
  const observed = await chrome.tabs.get(tabId).then(summarizeTab, () => null)
  if (observed !== null) observeActiveSummary(observed)
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToActive(signal: AbortSignal, sessionId?: string): Promise<void> {
  await abortable(Promise.all([affinityReady, pageSessionContexts.ready]).then(() => undefined), signal)
  const tab = await syncActiveTab(undefined, signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  commitTabAffinityRebind(summary, sessionId)
}

/** Commit one explicit tab handoff and clear stale element references. */
function commitTabAffinityRebind(
  summary: AffinityTab,
  sessionId?: string,
  mode: 'active' | 'background' = 'active',
): void {
  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  if (sessionId !== undefined) {
    activeFollowRefreshes.get(sessionId)?.controller.abort()
    cancelPendingApprovals(sessionId)
  }
  if (mode === 'active') tabAffinity.rebindActive(summary, sessionId)
  else tabAffinity.rebindControlled(summary, sessionId)
  if (sessionId !== undefined) {
    pageSessionContexts.bind(sessionId, { id: summary.tabId, ...summary })
  }
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

async function followModelSelectedTab(tab: chrome.tabs.Tab, sessionId?: string): Promise<void> {
  const summary = summarizeTab(tab)
  if (summary === null) throw new Error('the selected tab has no usable identifier')
  await pageSessionContexts.ready
  commitTabAffinityRebind(summary, sessionId, 'background')
}

/** Push the negotiated snapshot budget to the controlled page (the active page when none is bound yet). */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // The content script is not injected in the page yet: the next snapshot still uses the default budget, which is acceptable.
  }
}

/** Requester labels of external (MCP client) sessions, for their approval cards. */
const externalRequesters = new ExternalRequesters()

/** Dev loop: localhost tabs the user linked to a DSH coding session (dev-loop.ts). */
const devLoop = new DevLoopController(chromeDevLoopBrowser())

/** Panel dev-loop RPCs the background completes (dev-loop.ts). */
const devLoopPanelRpc = createDevLoopPanelRpc(devLoop, gatewayRpc, undefined, (origin) => {
  // Linking a tab into the dev loop says "this is my app": its pages are the user's own.
  void settingsReady.then(() => persistSettings({ taintLocalOrigins: [...settings.taintLocalOrigins, origin] })).catch(() => {})
})

/** Learning features (workflows, site drivers, Watch me, failure fixtures); all default off. */
const learning = new LearningRuntime({
  rpc: () => rpc,
  bridgeConnected: () => bridge?.state === 'connected',
  agentActiveOnTab: (tabId) => [...unsettledToolCalls].some((active) => active.tabId === tabId),
  halted: () => killSwitchEngaged || pauseGate.state().mode !== 'running',
  // A fixture saves the page to disk without a card: only where page reads are
  // automatic (sharing "auto") and the policy layer neither denies nor forces
  // a fresh decision (blocked, read-only/ask site, taint).
  fixtureAllowed: (sessionId, url) => fixtureAllowedFor(settings.sharePageContent, (origin) => policyRuntime.evaluate(
    { name: 'browser_snapshot', args: {}, ...(sessionId === undefined ? {} : { sessionId }) }, { reads: [origin], acts: [], pageOrigin: origin, urls: [url] },
  ).kind, url),
  capturedRequests: (tabId) => devTools.capturedRequests?.(tabId),
  siteDriversSupported: devToolsCapability,
  activeTab: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0],
})
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return undefined
  const msg = message as { type?: unknown; event?: unknown } | null
  if (msg?.type === 'DSH_WATCH_EVENT') void learning.onWatchEvent(sender.tab.id, sender.frameId ?? 0, msg.event)
  return undefined
})

/**
 * Route one tool.call frame: tab resolution, fleet allowlists, the pause gate,
 * site policy, cards and the commit gate, then the dispatch path for its tool;
 * the answer (or a cancel / internal error) goes back as tool.result.
 */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  activeToolCalls.get(call.id)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeCall: ActiveToolCall = {
    controller,
    name: call.name,
    unrestrictedAccess,
    committed: false,
    revocationRequested: false,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  unsettledToolCalls.add(activeCall)
  if (call.sessionId !== undefined) noteRuntimeSession(call.sessionId)
  externalRequesters.note(call)
  runtimeLease.touch()
  runtimeKeeper.update()
  const commitAction = (): void => { activeCall.committed = true }
  const rollbackActionCommit = (): void => {
    activeCall.committed = false
    if (activeCall.revocationRequested) controller.abort()
  }
  const expire = (): void => {
    if (!activeCall.committed) controller.abort()
  }
  let expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(expire, Math.max(0, call.expiresAt - Date.now()))
  activeCall.extendExpiry = (expiresAt) => {
    if (call.expiresAt === undefined || expiresAt <= call.expiresAt || controller.signal.aborted) return
    call.expiresAt = expiresAt
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = setTimeout(expire, Math.max(0, expiresAt - Date.now()))
  }
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  const sharePageContent = unrestrictedAccess ? 'auto' : settings.sharePageContent
  const policy = auditedPolicy(activeCall, policyRuntime.hook(call.id, call.sessionId, unrestrictedAccess))
  // browser_run: an approved program stands in for this step's ordinary card only (run-program.ts).
  // The step must run on the tab the program was approved on.
  const programTarget = tabAffinity.resolveTarget(call.sessionId)
  const programTabId = programTarget.kind === 'target' ? programTarget.tab.tabId : undefined
  const programCover = programGrants.claim(call, programTabId)
  // Anything else that may change the page ends a "do the remaining N" series: its rows are no longer what the card showed.
  // In its own session now; on whichever tab the call turns out to act on once that tab is resolved (below).
  const seriesForeign = endsSeries(call, programCover)
  if (seriesForeign) programGrants.onForeignCall(call.sessionId)
  const endSeriesOnTab = (target: { id?: number }): void => {
    if (seriesForeign && target.id !== undefined) programGrants.onForeignTabAction(target.id)
  }
  // A claimed step reports how it ended; only a step that was done lets its series go on.
  let programStepDone = false
  // A fleet worker's cards show under its parent's session; its allowlist is enforced here too (fleet.ts).
  // Both are read once the persisted fleets are loaded, before any dispatch path runs.
  let approvalSession = call.sessionId
  let fleetRefusal: string | undefined
  /**
   * Every card this call raises: audited, cancelled with the call, under its
   * access mode, shown in `session`'s panel. `label` adds card context.
   */
  const authorizeFor = (session: string | undefined, label?: (prompt: ApprovalPrompt) => ApprovalPrompt, review?: { title?: string }) => (
    (prompt: ApprovalPrompt, windowId: number): Promise<ApprovalAuthorization> => auditedAuthorize(activeCall, (shown, onPrompt, onAutoReviewed) => authorizeToolCall(
      label === undefined ? shown : label(shown), controller.signal, windowId, {
        sessionId: session,
        unrestrictedAccess,
        toolCallId: call.id,
        // A card is really shown: outline the element it names on the page (agent-overlay.ts).
        onPrompt: () => { onPrompt(); agentOverlay.showPreview(call.id) },
        // Only the ordinary page dispatcher below asks for this (docs/auto-review-design.md §5 row 2).
        ...review === undefined ? {} : {
          autoReview: {
            call,
            approvalSession: session,
            program: programCover !== undefined,
            ...review.title === undefined ? {} : { title: review.title },
            onAutoReviewed,
          },
        },
      },
    ))(prompt)
  )
  // Tab-bound cards show under the fleet parent's session (approvalSession); lane cards under the call's own.
  const approve = (windowId: number, review?: { title?: string }): ((prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>) => coverByProgram(
    programCover,
    (prompt) => authorizeFor(approvalSession, undefined, review)(prompt, windowId),
    () => { activeCall.decision = 'program-approved' },
  )
  let policyTabOrigin: string | undefined
  const managementDispatch = async (): Promise<ToolAnswer> => {
    await affinityReady
    const affinity = tabAffinity.snapshot()
    let windowId = affinity.active?.windowId ?? affinity.controlled?.windowId
    if (windowId === undefined) {
      try {
        windowId = (await chrome.windows.getLastFocused()).id
      } catch { /* approvals can still report unavailable without a focused window */ }
    }
    const controlledTabId = call.sessionId === undefined
      ? affinity.controlled?.tabId
      : tabAffinity.getSessionTab(call.sessionId)?.tabId
    return dispatchToolCall(
      call,
      sharePageContent,
      budget,
      approve(windowId ?? 0),
      controller.signal,
      undefined,
      undefined,
      {
        unrestrictedAccess,
        ...(controlledTabId === undefined ? {} : { controlledTabId }),
        followTab: (tab) => followModelSelectedTab(tab, call.sessionId),
        input: inputRuntime,
        dialogs,
        commitAction,
        rollbackActionCommit,
        policy,
        tabHidden: (url) => policyRuntime.pageHidden(url, unrestrictedAccess),
      },
    )
  }
  const dispatch = (): Promise<ToolAnswer> => policyRuntime.ready.then(() => {
    // A subagent or fork of a tainted session: the Host says so on the call.
    if (call.tainted === true) policyRuntime.markHostTaint(call.sessionId)
    // A fork or subagent of a session that read exempt pages may hold their content.
    if (call.inheritedExemptReads === true) policyRuntime.noteInheritedExemptReads(call.sessionId)
  }).then(() => fleets.ready).then(() => {
    approvalSession = fleets.approvalSession(call.sessionId)
    fleetRefusal = fleets.refusal(call)
  }).then((): ToolAnswer | Promise<ToolAnswer> => fleetRefusal !== undefined
    ? { ok: false, error: { code: 'action-failed', message: fleetRefusal } } satisfies ToolAnswer
    : call.name === DEVLOOP_CAPTURE_TOOL
    // Dev loop: a read of the user-linked localhost tab only, under this
    // call's site policy, taint rules and read-approval settings.
    ? devLoop.capture(call, (target) => {
        policyTabOrigin = originFromUrl(target.url ?? '')
        return dispatchToolCall(
          { id: call.id, name: 'browser_snapshot', args: { delta: true }, ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }) },
          sharePageContent,
          budget,
          // The card says it is a dev-loop read for the linked coding session.
          (prompt) => authorizeFor(call.sessionId, (shown) => ({ ...shown, devLoopFor: devLoop.linkOf(call.sessionId)?.label ?? 'a linked coding session' }))(prompt, target.windowId ?? 0),
          controller.signal,
          target,
          () => devLoop.allowsTarget(call.sessionId, target.id),
          { unrestrictedAccess, policy },
        )
      }, (text) => text.slice(0, budget?.maxChars ?? DEVLOOP_MAX_CHARS))
    : call.name === 'browser_fanout'
    ? fleets.open(call, {
        ...fleetDeps(controller.signal, authorizeFor(call.sessionId)),
        // Every task URL is judged like a browser_open_tab to it (blocked/managed deny, taint and ask force the card).
        policy: auditedPolicy(activeCall, policyRuntime.evaluator(call.sessionId, unrestrictedAccess)),
      })
    : call.name === 'browser_fleet_release'
    ? fleets.releaseCall(call, fleetDeps(controller.signal, async () => 'denied'))
    : isTabManagementTool(call.name)
    ? managementDispatch()
    : isDevToolsTool(call.name)
    ? dispatchDevToolsTool(call, activeCall, controller.signal)
    : call.name === 'browser_watch' || call.name === 'browser_watches'
    ? pageWatchers.dispatch(call, {
        resolveTab: (sessionId) => resolveToolTab(sessionId),
        allowsTab: (tabId, sessionId) => tabAffinity.allowsTarget(tabId, sessionId),
        authorize: authorizeFor(call.sessionId),
        signal: controller.signal,
      })
    : call.name === 'browser_run'
    ? approveProgram(call, {
        grants: programGrants,
        resolveTab: () => resolveToolTab(call.sessionId),
        listFrames: listTabFrames,
        authorize: authorizeFor(call.sessionId),
        signal: controller.signal,
        // Only "Do the remaining N" runs longer than one program, and only as the extension built it.
        allowSeries: (sessionId, steps, tabId, documentKey) => learning.claimSeries(sessionId, steps, tabId, documentKey),
        cardNote: (sessionId, steps) => learning.cardNote(sessionId, steps),
        onContinued: () => { activeCall.decision = 'program-approved' },
      })
    : call.name === 'browser_open_tab'
    ? resolveOpenTabWindow(call.sessionId).then((target) => 'ok' in target
      ? target
      : dispatchOpenTab(
          call,
          target.windowId,
          sharePageContent,
          budget,
          approve(target.windowId),
          controller.signal,
          (tab) => bindOpenedTab(tab, call.sessionId, { active: call.args.active !== false }),
          (tabId) => tabAffinity.allowsTarget(tabId, call.sessionId),
          commitAction,
          policy,
        ))
    : call.name === 'browser_site_driver'
    ? resolveToolTab(call.sessionId).then((target) => 'ok' in target
      ? target
      : (policyTabOrigin = originFromUrl(target.url ?? ''), withCommitGate(activeCall, target, call.sessionId, () => learning.dispatchSiteDriver(
          call,
          (endSeriesOnTab(target), noteCallTarget(activeCall, target, policyRuntime.strictFor(call.sessionId, target.url))),
          policy,
          approve(target.windowId),
          controller.signal,
        ))))
    : resolveToolTab(call.sessionId).then((target) => 'ok' in target
      ? target
      : (policyTabOrigin = originFromUrl(target.url ?? ''), withCommitGate(activeCall, target, call.sessionId, () => dispatchToolCall(
          call,
          sharePageContent,
          budget,
          // The one path whose ordinary cards Auto review may decide.
          approve(target.windowId, { ...target.title === undefined ? {} : { title: target.title } }),
          controller.signal,
          (endSeriesOnTab(target), noteCallTarget(activeCall, target, policyRuntime.strictFor(call.sessionId, target.url))),
          () => target.id !== undefined && tabAffinity.allowsTarget(target.id, call.sessionId),
          {
            unrestrictedAccess, input: inputRuntime, dialogs, commitAction, rollbackActionCommit, policy: learning.wrapPolicy(call, target, policy), overlay: agentOverlay,
            onStepLabel: (label) => { stepLabels.note(call.id, label) },
            // A "do the remaining N" step acts only on an element that still looks as its card showed it, on the page the card was approved on.
            ...(programCover?.target === undefined ? {} : { expect: { target: programCover.target, ...(programCover.page === undefined ? {} : { page: programCover.page }) } }),
          },
        ))))
  )
  // Paused or taken over: the call waits here, before any tab resolution,
  // policy check, or approval card, so nothing can approve or run it.
  void heldDispatch(call, activeCall, dispatch).then(
    async (answer) => {
      // Untrusted page content entered the session: taint it (security/taint.ts),
      // unless everything the call could have quoted is exempt (local pages,
      // sites the user trusts). The tab is looked at again only when that is possible.
      const after = policyRuntime.mayExempt(call.sessionId) ? await tabProvenanceAfter(activeCall.tabId) : undefined
      // Sent on the result frame: the bridge then leaves the session's shell and file tools on.
      const verdict = policyRuntime.recordResult(call, answer.ok, policyTabOrigin, after, { quotesConsole: callQuotedConsole(call) })
      const taintExempt = verdict.exempt
        ? { taintExempt: true as const, ...verdict.local === true ? { taintExemptLocal: true as const } : {} }
        : {}
      learning.recordResult(call, answer, {
        ...(activeCall.tabId === undefined ? {} : { tabId: activeCall.tabId }),
        ...(activeCall.url === undefined ? {} : { url: activeCall.url }),
        ...(activeCall.decision === undefined ? {} : { decision: activeCall.decision }),
        ...(activeCall.policy === undefined ? {} : { policy: activeCall.policy }),
      })
      if (activeToolCalls.get(call.id) !== activeCall) return
      // A committed browser_open_tab already rebound affinity; prefer that
      // factual success over a generic cancel that would leave the model wrong.
      if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      if (answer.ok) {
        if (isNavigationCandidateTool(call.name)) await checkpointSessionPage(call.sessionId)
        const navigatedTo = await navigationAfter(call, activeCall)
        if (activeToolCalls.get(call.id) !== activeCall) return
        const socket = bridge
        if (socket === null) return
        recordAuditNote(call, activeCall, navigatedTo)
        // Before the result leaves: the bridge sends the next step only after it.
        if (programCover !== undefined && call.program !== undefined) {
          programStepDone = true
          programGrants.settle(call.program, true)
        }
        socket.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result, ...taintExempt })
      } else {
        const socket = bridge
        if (socket === null) return
        recordAuditNote(call, activeCall)
        socket.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error!, ...taintExempt })
      }
    },
    (error: unknown) => {
      // An internal error: nothing reached a verdict, so drop the per-call records unjudged.
      policyRuntime.forgetCall(call.id)
      learning.forgetCall(call.id)
      if (activeToolCalls.get(call.id) !== activeCall) return
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      bridge?.send({
        t: 'tool.result',
        id: call.id,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    // Failed, denied, cancelled, expired or never answered: a series step that was not done ends its series.
    if (programCover !== undefined && call.program !== undefined && !programStepDone) programGrants.settle(call.program, false)
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    unsettledToolCalls.delete(activeCall)
    activeCall.settle()
    if (activeToolCalls.get(call.id) === activeCall) activeToolCalls.delete(call.id)
    runtimeLease.touch()
    runtimeKeeper.update()
  })
}

/** Browser operations for a tab fleet (fleet.ts); tab affinity stays here. */
function fleetDeps(signal: AbortSignal, authorize: FleetDeps['authorize']): FleetDeps {
  return chromeFleetDeps(signal, authorize, {
    sessionWindow: async (sessionId) => {
      const target = await resolveToolTab(sessionId)
      return 'ok' in target ? undefined : target.windowId
    },
    bindChild: (childId, tab) => {
      const summary = summarizeTab(tab as chrome.tabs.Tab)
      if (summary === null) return
      tabAffinity.bindSession(childId, summary)
      persistTabAffinity()
      broadcastTabAffinity()
    },
    unbindChild: (childId) => {
      if (tabAffinity.unbindSession(childId)) {
        persistTabAffinity()
        broadcastTabAffinity()
      }
    },
  })
}

/** Hold the call while the user has paused the agent, then run it (or fail it closed). */
async function heldDispatch(call: ToolCall, activeCall: ActiveToolCall, dispatch: () => Promise<ToolAnswer>): Promise<ToolAnswer> {
  await pauseReady
  const outcome = await pauseGate.hold(call, activeCall.controller.signal)
  switch (outcome.kind) {
    case 'not-held':
      return dispatch()
    case 'released':
      activeCall.heldMs = outcome.heldMs
      return dispatch()
    case 'cancelled':
      return { ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } }
    case 'expired':
      activeCall.heldMs = outcome.heldMs
      activeCall.decision = 'held-expired'
      return { ok: false, error: { code: 'timeout', message: HOLD_EXPIRED_MESSAGE } }
    case 'failed':
      activeCall.heldMs = outcome.heldMs
      return { ok: false, error: { code: 'action-failed', message: outcome.message } }
  }
}

async function navigationAfter(call: ToolCall, activeCall: ActiveToolCall): Promise<string | undefined> {
  if (!isNavigationCandidateTool(call.name) || activeCall.tabId === undefined) return undefined
  try {
    const url = (await chrome.tabs.get(activeCall.tabId)).url
    return url !== undefined && url !== activeCall.url ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * The origins of the call's tab once the call settled (top page and every
 * frame), for the taint exemption. Undefined when the tab or its frame tree
 * cannot be read: the exemption then falls back to what the call itself named.
 */
async function tabProvenanceAfter(tabId: number | undefined): Promise<TabProvenance | undefined> {
  if (tabId === undefined) return undefined
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    if (frames === null || frames === undefined || frames.length === 0) return undefined
    return tabProvenanceOf(frames.map((frame) => ({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url })))
  } catch {
    return undefined
  }
}

/** Annotate the bridge's audit entry for this call; sent ahead of its tool.result. */
function recordAuditNote(call: ToolCall, activeCall: ActiveToolCall, navigatedTo?: string): void {
  if (rpc === null || bridge?.connected !== true) return
  void rpc.request(BRIDGE_AUDIT_RECORD_METHOD, auditNote(call.id, activeCall, navigatedTo)).catch(() => {})
}

function cancelToolCall(id: string): void {
  const call = activeToolCalls.get(id)
  if (call !== undefined && !call.committed) call.controller.abort()
}

/**
 * Run one developer-tools call: approve it, then hand it to the debugger
 * controller. Devtools calls take a dedicated path because they never touch the
 * content script and must not be satisfied by the page-sharing relaxations.
 */
async function dispatchDevToolsTool(call: ToolCall, activeCall: ActiveToolCall, signal: AbortSignal): Promise<ToolAnswer> {
  if (signal.aborted) return devToolsCancelled()
  const target = await resolveToolTab(call.sessionId)
  if ('ok' in target) return target
  noteCallTarget(activeCall, target, policyRuntime.strictFor(call.sessionId, target.url))
  // Developer tools can change the page: a "do the remaining N" series on this tab ends.
  if (target.id !== undefined) programGrants.onForeignTabAction(target.id)
  if (signal.aborted) return devToolsCancelled()
  const frames = await listTabFrames(target.id!, target.url)
  await policyRuntime.ready
  const policy = auditedPolicy(activeCall, (policyCall, targets) => policyRuntime.evaluate(policyCall, targets, false))
  const decision = policy(call, callPolicyTargets(call, frames))
  if (decision.kind === 'deny') return { ok: false, error: { code: 'action-failed', message: decision.message } }
  // Devtools keep their own consent surface: site trust never skips it, but
  // an ask site or a taint rule makes every call ask.
  const prompt = decision.kind === 'force'
    ? forcedApprovalPrompt(call, frames, decision.reasons)
    : devToolsApprovalForCall(call, frames)
  const authorization = await auditedAuthorize(activeCall, (shown, onPrompt) => authorizeToolCall(
    shown, signal, target.windowId ?? 0, { sessionId: call.sessionId, tabId: target.id, toolCallId: call.id, onPrompt },
  ))(prompt)
  if (signal.aborted) return devToolsCancelled()
  if (authorization !== 'approved') {
    return {
      ok: false,
      error: { code: authorization === 'timed-out' ? 'timeout' : 'action-failed', message: approvalFailureMessage(prompt, authorization) },
    }
  }
  try {
    const validate = async (executionTarget: { tabId: number }): Promise<void> => {
      if (signal.aborted) throw new Error('The developer-tools call was cancelled.')
      const current = await resolveToolTab(call.sessionId)
      if ('ok' in current || current.id !== target.id || executionTarget.tabId !== target.id) {
        throw new Error('The controlled tab changed while approval was pending. Request approval again.')
      }
      const currentFrames = await listTabFrames(target.id!, current.url)
      if (signal.aborted || frames.length !== currentFrames.length || frames.some((frame) => {
        const currentFrame = currentFrames.find((candidate) => candidate.frameId === frame.frameId)
        return currentFrame === undefined || frameDocumentKey(frame) !== frameDocumentKey(currentFrame)
      })) {
        throw new Error('The page changed while approval was pending. Request approval again.')
      }
      // The approval covers exactly the payload shown on the card.
      if (devToolsApprovalForCall(call, currentFrames).binding !== prompt.binding) {
        throw new Error('The request changed while approval was pending. Request approval again.')
      }
    }
    // Page JavaScript can send requests too: strict mode guards devtools calls.
    return await withCommitGate(activeCall, target, call.sessionId, async () => ({
      ok: true,
      result: await devTools.handle(call.name, call.args, call.sessionId, validate),
    }))
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: signal.aborted ? 'bridge-closed' : 'action-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function devToolsCancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The browser tool call was cancelled.' } }
}

/** Abort every in-flight developer-tools call (setting revoked). */
function cancelDevToolsCalls(tabId?: number): void {
  for (const call of activeToolCalls.values()) {
    if (isDevToolsTool(call.name) && !call.committed && (tabId === undefined || call.tabId === tabId)) {
      call.controller.abort()
    }
  }
}

/**
 * Attach the debugger to the controlled tab as soon as the user enables the
 * allowance, so network capture sees traffic from the start instead of only
 * after the first devtools call.
 */
async function prewarmDevTools(): Promise<void> {
  await affinityReady
  const target = await resolveToolTab()
  if ('ok' in target || target.id === undefined) return
  await devTools.prewarm(target.id).catch(() => {
    // Attach is lazy by design: a tab that cannot be debugged right now only
    // surfaces an error when a devtools call actually needs it.
  })
}

async function revokeUnrestrictedAccess(): Promise<void> {
  const calls = [...unsettledToolCalls].filter((call) => call.unrestrictedAccess)
  const refreshes = [...activeFollowRefreshes.values()].filter((refresh) => refresh.unrestrictedAccess)
  for (const call of calls) {
    call.revocationRequested = true
    if (!call.committed) call.controller.abort()
  }
  for (const refresh of refreshes) refresh.controller.abort()
  await Promise.allSettled([
    ...calls.map(async (call) => { await call.settled }),
    ...refreshes.map(async (refresh) => { await refresh.settled }),
  ])
}

function cancelAllToolCalls(): void {
  for (const call of activeToolCalls.values()) {
    if (!call.committed) call.controller.abort()
  }
  activeToolCalls.clear()
}

// ---- Outage recovery (outage-recovery.ts) ----

/** The current client completed a handshake: only a bridge that was connected has outages to recover. */
let bridgeWasConnected = false
/** The address that was connected when the outage began: the only one whose refusal is an answer. */
let outageHomeUrl: string | undefined
/** Discovered addresses that refused this install during the outage; they belong to something else. */
const outageRefusedUrls = new Set<string>()
/** Discovered addresses whose dial failed without a refusal; tried again once the others had their turn. */
const outageFailedUrls = new Set<string>()
/** The outage period ended with the bridge still away; reported until the next connection attempt. */
let outageGaveUp = false

const outageRecovery = new OutageRecovery({
  now: () => Date.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
  attempt: attemptOutageRecovery,
  giveUp: giveUpOutage,
})

/**
 * A connected bridge dropped while a panel is open: keep looking for it
 * instead of leaving it to one keepalive-driven discovery pass, whose miss
 * would stop the connection and cost the panel its conversation. With no
 * panel open nothing here runs (the panel-free rules are unchanged), and a
 * refusal from the address that was connected is an answer, not an outage.
 */
function beginOutageRecoveryIfDue(): void {
  const client = bridge
  if (outageRecovery.active || client === null || !bridgeWasConnected) return
  if (client.state !== 'reconnecting' || panelPorts.size === 0 || killSwitchEngaged) return
  if (connectedAddress === undefined) return
  if (client.failure !== undefined && BRIDGE_REFUSALS.includes(client.failure)) return
  outageHomeUrl = connectedAddress
  outageRefusedUrls.clear()
  outageFailedUrls.clear()
  outageRecovery.begin()
}

/**
 * One look for the bridge: the address that was connected first, then the
 * ordinary local discovery (the remembered port, the `dsh web` default and
 * the beacon ports; loopback only), so a DSH restarted on another port is
 * found. Nothing is latched and the discovery status is left alone: a miss
 * here only means "not yet". Whatever is found still has to pass the mutual
 * handshake before anything is trusted or sent.
 */
async function attemptOutageRecovery(): Promise<void> {
  const client = bridge
  const home = outageHomeUrl
  if (client === null || home === undefined) {
    outageRecovery.end()
    return
  }
  const waiting = (): boolean => bridge === client && outageRecovery.active && client.state === 'reconnecting'
    && panelPorts.size > 0 && !killSwitchEngaged
  // Dialing or handshaking right now: that attempt's outcome comes first.
  if (!waiting()) return
  if (!rejectedBridgeUrls.has(home) && await probeBridge(home)) {
    if (!waiting()) return
    // It answers again: dial it now, unless it is being retried at the slower
    // pace of a refusal already (`busy`, a token that cannot be read yet).
    if (connectedAddress === home && client.failure !== undefined) return
    discoveredBridgeUrl = undefined
    connectedAddress = home
    client.redirect(home, settings.token)
    broadcastStatus()
    return
  }
  if (!waiting() || !isLocalBridgeAddress(home)) return
  await discoveryMemory
  const instances = await discoverInstances(planDiscovery({
    ...(lastBridgeUrl === undefined ? {} : { rememberedUrl: lastBridgeUrl }),
    excludeUrl: home,
    excludeUrls: [...rejectedBridgeUrls, ...outageRefusedUrls, ...outageFailedUrls],
  }), {
    probe: (port, timeoutMs) => readBridgeConfig(port, timeoutMs),
    shouldContinue: waiting,
  }, { stopAtFirstHit: true })
  if (!waiting()) return
  // The first answer that is on this computer and was not already ruled out:
  // recovery never leaves the loopback, whatever a discovery answer advertises.
  const candidate = instances.map(instance => ({ found: instance.wsUrl, url: normalizeBridgeUrl(instance.wsUrl, BRIDGE_PATH) }))
    .find(({ found, url }) => isLocalBridgeAddress(url)
      && ![found, url].some(address => rejectedBridgeUrls.has(address) || outageRefusedUrls.has(address) || outageFailedUrls.has(address)))
  if (candidate === undefined) {
    // Every candidate had its turn: the ones that merely failed get another.
    outageFailedUrls.clear()
    return
  }
  if (candidate.url === connectedAddress) return
  const { found, url } = candidate
  discoveredBridgeUrl = found
  connectedAddress = url
  client.redirect(url, settings.token)
  broadcastStatus()
}

/** The retry period ended: stop with "not found", as a failed discovery pass does. */
function giveUpOutage(): void {
  const client = bridge
  // An answer arrived meanwhile (connected, or a refusal being shown): that stands.
  if (client === null || client.state === 'connected' || client.failure !== undefined) return
  outageGaveUp = true
  discoveryLatch = 'not-found'
  discoveryState = 'not-found'
  persistDiscoveryLatch('not-found')
  bridgeStartRevision += 1
  bridge = null
  rpc = null
  connectedAddress = undefined
  discoveredBridgeUrl = undefined
  client.stop()
  broadcastStatus()
}

/**
 * (Re)start the bridge with the current settings.
 *
 * Order of preference: a filled-in address is tried first (it is the user's
 * choice), and only a *loopback* address that fails its pre-flight falls back
 * to one automatic discovery pass. With no address the pass runs directly.
 * Nothing retries once that pass finds nothing.
 */
async function startBridge(): Promise<void> {
  if (!runtimeWantsBridge()) return
  if (!killSwitchLoaded) await killSwitchReady
  // The kill switch holds the bridge down until the user reconnects.
  if (killSwitchEngaged) {
    broadcastStatus()
    return
  }
  // One automatic pass per lease: a second panel in another window joins it
  // instead of launching a competing scan. Checked before the revision bump so
  // a duplicate trigger cannot invalidate the pass it is deferring to.
  if (discoveryLatch === 'running') return
  // An explicit (re)start replaces whatever an outage recovery was doing.
  outageRecovery.end()
  outageGaveUp = false
  const revision = ++bridgeStartRevision
  const lease = (): boolean => revision === bridgeStartRevision && runtimeWantsBridge()
  let url = settings.bridgeUrl
  let discovered: string | undefined
  if (panelPorts.size === 0) {
    // The bridge ended this install's connection for good: no headless
    // reconnect until the user comes back (a panel, Reconnect, new settings).
    await bridgeRefusalReady
    if (bridgeRefusal !== undefined) return
    // Headless (panel-free) reconnect: only an address already in use, never
    // a discovery pass the user did not ask for.
    await discoveryMemory
    if (!lease()) return
    if (url === '') url = headlessBridgeUrl ?? lastBridgeUrl ?? ''
    if (url === '' && runtimeLease.standingOnly()) {
      // Nothing to dial for standing work yet: wait like after any failed attempt.
      parkStandingReconnect()
      broadcastStatus()
      return
    }
  } else if (url !== '') {
    if (isLocalBridgeAddress(url) && !await probeBridge(url)) {
      if (!lease()) return
      discovered = await discoverBridgeUrl(lease, url)
      url = discovered ?? ''
    }
  } else if (discoveryLatch !== 'not-found') {
    discovered = await discoverBridgeUrl(lease)
    url = discovered ?? ''
  } else {
    // Already confirmed absent in this lease: report and wait for the user.
    url = ''
  }
  // Discovery is asynchronous. A panel may have closed or a newer settings
  // update may have started while its fetches were in flight.
  if (!lease()) return
  discoveredBridgeUrl = discovered
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    connectedAddress = undefined
    broadcastStatus()
    return
  }
  // A manually entered address often has only the host part (e.g. ws://127.0.0.1:3080); the bridge
  // path is a protocol constant, so it is filled in when missing, to avoid a failed connection to the root path.
  // An invalid URL is passed unchanged to the WebSocket constructor, which reports the error.
  url = normalizeBridgeUrl(url, BRIDGE_PATH)
  // The hello must carry this install's identity.
  if (clientIdentity === undefined) {
    await clientIdentityReady
    if (!lease()) return
  }
  connectedAddress = url
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') {
          cancelAllToolCalls()
          interactionResponses.failAll(responseMessages().disconnected)
          transientEvents.clear()
        }
        if (state === 'connected') {
          bridgeWasConnected = true
          outageRecovery.end()
        } else if (state === 'stopped') {
          bridgeWasConnected = false
          outageRecovery.end()
        } else if (state === 'reconnecting' && client === bridge && outageRecovery.active) {
          const refused = client.failure !== undefined && BRIDGE_REFUSALS.includes(client.failure)
          if (connectedAddress !== undefined && connectedAddress !== outageHomeUrl) {
            // An address found while looking for the bridge did not take this
            // install. A refusal means it is some other DSH: ruled out for
            // this outage. Anything else (not ready yet, a dropped dial) is
            // set aside until the other candidates had their turn. Either way
            // the search goes on; only the address that was connected can
            // refuse for good.
            const ruledOut = refused ? outageRefusedUrls : outageFailedUrls
            ruledOut.add(connectedAddress)
            discoveredBridgeUrl = undefined
            connectedAddress = outageHomeUrl
            client.hold()
            outageRecovery.soon()
          } else if (refused) {
            // The bridge that was connected answers and refuses: not an outage.
            outageRecovery.end()
          }
        }
        // Replaced by another browser, or refused for a reason only the user
        // can fix: latch it, so no headless start (this worker or a restarted
        // one) reclaims the slot or repeats the refusal.
        if (state !== 'connected' && state !== 'connecting') {
          const refusal = client.replaced ? 'replaced' : client.failure
          if (refusal !== undefined && BRIDGE_REFUSALS.includes(refusal) && bridgeRefusal !== refusal) {
            setBridgeRefusal(refusal as BridgeRefusal)
            onStandingWorkChanged()
          }
        }
        // Only standing work wants this connection and the attempt failed:
        // back off instead of retrying every few seconds (this client is done).
        if (state === 'reconnecting' && client === bridge && runtimeLease.standingOnly()) {
          parkStandingReconnect()
          broadcastStatus()
          return
        }
        if (state === 'reconnecting' && client === bridge) beginOutageRecoveryIfDue()
        broadcastStatus()
        learning.onBridgeState(state)
        if (state === 'stopped') refreshPanelResumeHints()
        if (state === 'stopped' && !runtimeWantsBridge()) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event' && frame.frame.method === BRIDGE_STANDING_EVENT_METHOD) {
          // The bridge's own sealed notice; never shown to panels. A malformed one
          // changes nothing, and neither does one on a connection whose hello.ok
          // carried no standing cap: an older bridge does not reserve this method,
          // so there it could be a Host-stream event that merely uses the name.
          if (caps?.standing !== undefined && isStandingWork(frame.frame.payload)) setHostStanding(frame.frame.payload)
          return
        }
        if (frame.t === 'event') {
          // Traffic of a session that has used this browser keeps a panel-free
          // runtime alive while its agent works; other sessions never do.
          const eventSessionId = (frame.frame.payload as { sessionId?: unknown } | null)?.sessionId
          if (typeof eventSessionId === 'string' && runtimeSessions.has(eventSessionId)) runtimeLease.touch()
          transientEvents.ingest(frame)
          const sessionEvent = frame.frame.method === 'session/event'
            ? (frame.frame.payload as { event?: { type?: unknown } } | null)?.event
            : undefined
          if (sessionEvent?.type === 'turn/end' && typeof eventSessionId === 'string') commitGateTurnEnded(eventSessionId)
          broadcastEvent(frame)
        }
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'respond.result') interactionResponses.route(frame)
        // rpc.result is settled by the rpc facade (wrapped below).
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        headlessBridgeUrl = connectedAddress
        // Connected: normal cadence again, and the Host's standing work as of
        // now (an older bridge sends none, which clears a stored hint).
        if (clearStandingRetry()) armBridgeKeepalive()
        setBridgeRefusal(undefined)
        setHostStanding(negotiated.standing ?? NO_HOST_STANDING)
        for (const resolve of [...bridgeWaiters]) resolve()
        runtimeKeeper.update()
        // The address just became known: record it for a headless reconnect.
        runtimeKeeper.persistNow()
        // The peer proved the token: only now is a discovered address worth
        // trying first next time.
        if (discoveredBridgeUrl !== undefined) rememberBridgeUrl(discoveredBridgeUrl)
        broadcastStatus()
        void pushBudgetToControlledTab(negotiated)
      },
      onServerProofRejected: onBridgeProofRejected,
    }, probeBridge, runtimeWantsBridge, () => ({
      // Advertised as soon as the platform can serve it, so the host registers
      // the developer-tools group; the user's setting and per-call approval
      // still gate every one of those calls.
      ...devToolsCapability ? { devTools: { version: DEVTOOLS_CAPS_VERSION } } : {},
      // This build handles the bridge's standing-work events.
      standingUpdates: STANDING_WORK_CAPS_VERSION,
      // One bridge connection per install: other browsers and profiles keep theirs.
      ...clientIdentity === undefined ? {} : { client: clientIdentity },
    }))
    bridge = client
    rpc = createRpc(client)
    bridgeWasConnected = false
  }
  bridge.start(url, settings.token)
}

/** The pairing request in flight, if any: one at a time, and a new one withdraws the old. */
let activePairing: AbortController | undefined

/** Pairing requests the panel may start by itself (not on a click) while panels stay open. */
const MAX_AUTOMATIC_PAIRINGS = 3
/** How many it has started since the first panel of this sitting opened. */
let automaticPairings = 0

/**
 * One-step pairing (pairing.ts): ask the DSH host for the bridge token, show
 * the code the user types there, and once the exchange verified store the
 * token like a typed one and connect. The request goes to the bridge this install
 * is already trying to reach: the address in use, else the filled-in one,
 * else the first local instance discovery finds.
 * @param onCode - receives the code to display while the request waits.
 * @returns the failure, or `undefined` once the token is stored.
 */
async function pairWithHost(
  onCode: (code: string, answerTimeoutMs: number) => void,
  options: { again: boolean; auto: boolean },
): Promise<PairingFailure | undefined> {
  const { again } = options
  await settingsReady
  // What nobody clicked for is bounded: each request shows a code a wrong
  // peer may guess at once, and a panel that keeps asking by itself would
  // hand out guesses without the user doing anything.
  if (options.auto) {
    if (automaticPairings >= MAX_AUTOMATIC_PAIRINGS) return 'auto-limit'
    automaticPairings += 1
  }
  // An install that already holds a token pairs only when the user explicitly
  // asked to pair again: a connection that merely fails (a process answering
  // on the bridge's port, a bridge that is down) must never start a pairing
  // by itself, and whatever happens the old token stays until a new one verified.
  // A token file that is there but unreadable right now counts as a token held.
  const installed = await loadInstalledToken().catch((error: unknown) => error instanceof InstalledTokenUnreadableError ? 'unreadable' : '')
  if (!again && (settings.token !== '' || installed !== '')) return 'has-token'
  activePairing?.abort()
  const controller = new AbortController()
  activePairing = controller
  try {
    await settingsReady
    const filledIn = settings.bridgeUrl === '' ? undefined : normalizeBridgeUrl(settings.bridgeUrl, BRIDGE_PATH)
    let url = connectedAddress ?? filledIn
    if (url === undefined) {
      await discoveryMemory
      url = (await discoverInstances(planDiscovery({
        ...(lastBridgeUrl === undefined ? {} : { rememberedUrl: lastBridgeUrl }),
        excludeUrls: [...rejectedBridgeUrls],
      }), {
        probe: (port, timeoutMs) => readBridgeConfig(port, timeoutMs),
        shouldContinue: () => !controller.signal.aborted,
      }, { stopAtFirstHit: true }))[0]?.wsUrl
    }
    if (controller.signal.aborted) return 'cancelled'
    if (url === undefined) return 'unreachable'
    const paired = await pairWithBridge(url, { origin: extensionOrigin(), name: browserName(), onCode, signal: controller.signal })
    if (!paired.ok) return paired.reason
    await persistSettings({ token: paired.token })
    // A new token is a new connection: drop what belonged to the old one.
    forgetStandingHost()
    setBridgeRefusal(undefined)
    rejectedBridgeUrls.clear()
    discoveryLatch = 'idle'
    persistDiscoveryLatch('idle')
    // This bridge proved it was given the code the user read here: prefer it next time.
    if (url !== filledIn) rememberBridgeUrl(url)
    if (panelPorts.size > 0) {
      await startBridge()
      broadcastStatus()
    }
    return undefined
  } finally {
    if (activePairing === controller) activePairing = undefined
  }
}

/**
 * Enumerate every local instance for the settings picker.
 *
 * Unlike the startup pass this never stops early: every fixed and beacon group
 * is probed so the picker can list every local instance.
 * Results stream back to the requesting panel; cancellation ends the pass.
 * @param port - panel port that asked.
 * @param id - request id echoed on every message.
 */
async function runPanelDiscovery(port: chrome.runtime.Port, id: string): Promise<void> {
  activeScan?.controller.abort()
  const controller = new AbortController()
  activeScan = { id, controller }
  discoveryLatch = 'idle'
  discoveryState = 'running'
  persistDiscoveryLatch('idle')
  broadcastStatus()
  const reply = (message: unknown): void => {
    try { port.postMessage(message) } catch { /* port closed */ }
  }
  try {
    await discoveryMemory
    const instances = await discoverInstances(planDiscovery({
      ...(lastBridgeUrl === undefined ? {} : { rememberedUrl: lastBridgeUrl }),
    }), {
      probe: (candidate, timeoutMs) => readBridgeConfig(candidate, timeoutMs),
      shouldContinue: () => !controller.signal.aborted,
      onProgress: (progress) => {
        if (activeScan?.id !== id) return
        reply({
          type: 'discovery.progress',
          id,
          done: progress.done,
          total: progress.total,
          instances: progress.instances,
        })
      },
    }, { stopAtFirstHit: false })
    if (activeScan?.id !== id) return
    if (controller.signal.aborted) {
      // A cancelled scan keeps whatever state the bridge already had.
      discoveryState = bridge?.state === 'connected' ? 'found' : 'idle'
      broadcastStatus()
      reply({ type: 'discovery.result', id, ok: false, error: { code: 'cancelled', message: 'discovery cancelled' } })
      return
    }
    if (instances.length > 0) {
      discoveryLatch = 'idle'
      discoveryState = 'found'
    } else {
      discoveryLatch = 'not-found'
      discoveryState = 'not-found'
      persistDiscoveryLatch('not-found')
    }
    broadcastStatus()
    reply({ type: 'discovery.result', id, ok: true, instances })
  } catch (error) {
    if (activeScan?.id !== id) return
    discoveryLatch = 'idle'
    reply({
      type: 'discovery.result',
      id,
      ok: false,
      error: { code: 'scan-failed', message: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    if (activeScan?.id === id) activeScan = undefined
  }
}

/** Gateway RPC with a helpful error when the bridge is down. */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与 token）'
      : 'dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

// ---- Content script messages ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  if (sender.tab?.id === undefined) return
  const type = (message as { type?: unknown }).type
  if (type === 'DSH_CONTENT_READY') {
    // navigation.ts also listens for this frame-ready announcement; only this
    // listener answers it, telling a fresh document whether to watch
    // selections. The revision lets a slow reply lose to a newer broadcast.
    const overlay = agentOverlay.readyState(sender.tab.id, sender.frameId)
    sendResponse({
      selectionWatch: selectionWatchEnabled(sender.tab.windowId),
      selectionWatchEpoch: selectionWatchEpoch,
      selectionWatchRevision: selectionWatchRevision,
      ...(overlay === undefined ? {} : { overlay }),
      ...(learning.watchMeReady(sender.tab.id, sender.frameId, sender.url) ? { watchMe: true } : {}),
    })
    return
  }
  if (type === 'DSH_KILL_SWITCH') {
    // The on-page pill's Stop link (trusted user clicks only, in a closed shadow root).
    void engageKillSwitch()
    return
  }
  if (type === 'DSH_AGENT_RESUME') {
    // The takeover banner's Resume button, only from a tab showing it. A page
    // can tamper with what surrounds the in-page banner, so it never resumes
    // by itself: it opens the side panel, whose Resume confirms.
    if (pauseGate.state().mode === 'taken-over' && boundTabIds().has(sender.tab.id)) openAssistantPanel(sender.tab.windowId)
    return
  }
  if (type !== 'DSH_SELECTION' || sender.tab === undefined) return
  recordSelection(sender.tab, sender.frameId ?? 0, (message as { selection?: unknown }).selection)
})

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (policyRuntime.connect(port)) return
  if (pageWatchers.connect(port)) return
  if (learning.connect(port)) return
  if (port.name !== 'dsh-panel') return
  // Content scripts run beside untrusted pages and can open ports too: the
  // panel port (settings, approvals, pairing) is for this extension's own pages only.
  if (!isExtensionPageSender(port.sender)) {
    port.disconnect()
    return
  }
  const wasIdle = panelPorts.size === 0
  // A new sitting: the panel may ask to pair by itself a few times again.
  if (wasIdle) automaticPairings = 0
  const tabAffinityRebinds = new Map<string, {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()
  // In-flight "jump back to the assistant page" requests. Activation is
  // idempotent, but a double click must not race two acknowledgements.
  const tabAffinityReturns = new Set<string>()
  panelPorts.add(port)
  // A panel restores the normal reconnect cadence, and is the user coming
  // back after the bridge refused or replaced this install.
  clearStandingRetry()
  setBridgeRefusal(undefined)
  if (wasIdle) armBridgeKeepalive()
  runtimeKeeper.update()
  void settingsReady.then(syncSelectionWatch)
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    // One automatic pass per panel lease: a confirmed miss stays terminal until
    // the lease ends or the user asks again (settings save / "Detect").
    if (discoveryLatch === 'not-found') return
    if (bridge === null || bridge.state === 'stopped') return startBridge()
    // The bridge dropped while no panel was open: this panel waits for it.
    beginOutageRecoveryIfDue()
  })
  try { port.postMessage(statusPayload()) } catch { /* port closed */ }
  void killSwitchReady.then(() => {
    try { port.postMessage({ type: 'kill-switch', engaged: killSwitchEngaged }) } catch { /* port closed */ }
  })
  void pauseReady.then(() => {
    try { port.postMessage({ type: 'agent.pause-state', state: pauseGate.state() }) } catch { /* port closed */ }
  })
  broadcastDevToolsState()
  void affinityReady.then(async () => {
    await syncActiveTab()
    try { port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() }) } catch { /* port closed */ }
  })
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        const rpcSessionId = typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null
          ? (rpcMsg.payload as { sessionId?: string }).sessionId
          : undefined
        const refresh = rpcSessionId === undefined
          ? Promise.resolve()
          : sessionSnapshotRefreshes.get(rpcSessionId) ?? Promise.resolve()
        const devLoopAnswer = devLoopPanelRpc(rpcMsg.method, rpcMsg.payload)
        if (devLoopAnswer !== undefined) {
          void devLoopAnswer.then(
            (result) => { try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ } },
            (error: unknown) => {
              try {
                port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: false, error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) } })
              } catch { /* port closed */ }
            },
          )
          break
        }
        // A session prompted from this browser keeps its panel-free runtime
        // alive while it works, even after the panel closes.
        if (rpcMsg.method === 'session.prompt' && typeof rpcSessionId === 'string') noteRuntimeSession(rpcSessionId)
        // A new message from the user: pending reviews are dropped (their cards show) and the counters start again.
        if (rpcMsg.method === 'session.prompt' && typeof rpcSessionId === 'string') autoReviews.noteUserMessage(rpcSessionId)
        // The conversation is deleted: Auto ends with it.
        if (rpcMsg.method === BRIDGE_SESSION_PURGE_METHOD && typeof rpcSessionId === 'string') autoReviews.end(rpcSessionId, 'conversation-ended')
        const prepare = rpcMsg.method === 'session.prompt'
          ? Promise.resolve().then(async () => {
              await refresh
              if (typeof rpcSessionId === 'string') await taintAttachedSelection(rpcSessionId, rpcMsg.payload)
              return rpcSessionId === undefined || tabAffinity.getSessionTab(rpcSessionId) !== undefined
            })
          : Promise.resolve(true)
        void prepare.then((ready) => {
          if (!ready) throw new Error('This session is not bound to a live browser tab')
          return gatewayRpc(rpcMsg.method, rpcMsg.payload)
        }).then(
          (result) => {
            try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'rpc.result',
                id: rpcMsg.id,
                ok: false,
                error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        const messages = responseMessages()
        interactionResponses.begin(
          port,
          response.id,
          () => bridge?.send({
            t: 'respond',
            id: response.id as string,
            rpcId: response.rpcId as string,
            result: response.result as RespondResult,
          }) === true,
          messages,
        )
        break
      }
      case 'settings': {
        const settingsMsg = message as { id?: unknown; settings: Partial<Settings> }
        const requestId = typeof settingsMsg.id === 'string' ? settingsMsg.id : undefined
        void settingsReady.then(async () => {
          try {
            const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token }
            await persistSettings(settingsMsg.settings)
            const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
              || settings.token !== previousConnection.token
            if (connectionChanged) {
              // A pairing request still waiting was addressed to the previous bridge.
              activePairing?.abort()
              // The hint and the headless address belong to the previous connection.
              forgetStandingHost()
              setBridgeRefusal(undefined)
              // An explicit address supersedes a confirmed miss from this lease.
              rejectedBridgeUrls.clear()
              discoveryLatch = 'idle'
              persistDiscoveryLatch('idle')
            }
            if (panelPorts.size > 0) {
              if (connectionChanged) await startBridge()
              broadcastStatus()
            } else if (connectionChanged) {
              // The settings write outlived its originating panel. Do not keep a
              // healthy socket authenticated with stale connection settings: make
              // the next explicit panel lease start from the persisted values.
              bridgeStartRevision += 1
              bridge?.stop()
              bridge = null
              rpc = null
              caps = null
              broadcastStatus()
              disarmBridgeKeepalive()
            }
            if (requestId !== undefined) {
              try { port.postMessage({ type: 'settings.result', id: requestId, ok: true }) } catch { /* port closed */ }
            }
          } catch (error: unknown) {
            if (requestId === undefined) return
            try {
              port.postMessage({
                type: 'settings.result',
                id: requestId,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          }
        })
        break
      }
      case 'panel.window': {
        // The panel reports its own window; a side panel has no sender.tab.
        const registration = message as { windowId?: unknown }
        if (typeof registration.windowId !== 'number'
          || !Number.isInteger(registration.windowId)
          || registration.windowId < 0) break
        panelWindows.set(port, registration.windowId)
        syncSelectionWatch()
        try {
          port.postMessage({ type: 'selection', selection: selections.current(registration.windowId) })
        } catch { /* port closed */ }
        void postResumeHint(port, registration.windowId)
        break
      }
      case 'devtools.detach': {
        // The user asked for an immediate detach from the settings page; keep
        // the persisted allowance but drop the current attachment.
        const request = message as { id?: unknown }
        void devTools.detachAll().then(
          () => {
            broadcastDevToolsState()
            if (typeof request.id === 'string') {
              try { port.postMessage({ type: 'devtools.detach.result', id: request.id, ok: true }) } catch { /* port closed */ }
            }
          },
          (error: unknown) => {
            if (typeof request.id !== 'string') return
            try {
              port.postMessage({
                type: 'devtools.detach.result',
                id: request.id,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'discovery.start': {
        // Manual scan from the settings page: enumerate every local instance.
        const request = message as { id?: unknown }
        if (typeof request.id !== 'string') break
        void runPanelDiscovery(port, request.id)
        break
      }
      case 'discovery.cancel': {
        activeScan?.controller.abort()
        break
      }
      case 'pair.start': {
        // Only the extension's own panel reaches this port. The panel gets the code to display, never the token.
        const request = message as { id?: unknown; again?: unknown; auto?: unknown }
        if (typeof request.id !== 'string') break
        const id = request.id
        const post = (reply: unknown): void => { try { port.postMessage(reply) } catch { /* panel closed */ } }
        void pairWithHost((code, answerTimeoutMs) => { post({ type: 'pair.code', id, code, answerTimeoutMs }) }, { again: request.again === true, auto: request.auto === true }).then(
          reason => reason,
          (): PairingFailure => 'unreachable',
        ).then((reason) => {
          post(reason === undefined ? { type: 'pair.result', id, ok: true } : { type: 'pair.result', id, ok: false, reason })
        })
        break
      }
      case 'pair.cancel': {
        activePairing?.abort()
        break
      }
      case 'kill-switch.engage':
        void engageKillSwitch()
        break
      case 'kill-switch.release':
        void releaseKillSwitch()
        break
      case 'agent.pause': {
        const mode = (message as { mode?: unknown }).mode
        if (mode === 'after-step' || mode === 'take-over') void pauseAgent(mode)
        break
      }
      case 'agent.resume':
        void resumeAgent()
        break
      case 'auto-review.set': {
        // Only this extension's own panel reaches this port (checked above).
        const request = message as { sessionId?: unknown; enabled?: unknown }
        const sid = validSessionId(request.sessionId)
        if (sid === undefined || isExternalSessionId(sid)) break
        void Promise.all([settingsReady, autoReviews.ready]).then(() => {
          if (request.enabled === true && autoReviewOffered()) autoReviews.enable(sid)
          else if (request.enabled === false) autoReviews.end(sid, 'user')
          broadcastAutoReviewState()
        })
        break
      }
      case 'auto-review.set-all': {
        // "Turn all off" from the panel's line about other conversations.
        void autoReviews.ready.then(() => {
          autoReviews.endAll('user')
          broadcastAutoReviewState()
        })
        break
      }
      case 'auto-review.status': {
        const request = message as { id?: unknown; sessionId?: unknown }
        const sid = validSessionId(request.sessionId)
        if (typeof request.id !== 'string' || sid === undefined) break
        const requestId = request.id
        const reply = (result: Record<string, unknown>): void => {
          try { port.postMessage({ type: 'auto-review.status.result', id: requestId, sessionId: sid, ...result }) } catch { /* port closed */ }
        }
        if (!autoReviewOffered() || rpc === null) {
          reply({ available: false, reason: autoReviewStatePayload().unavailable ?? 'bridge' })
          break
        }
        void rpc.request(BRIDGE_REVIEW_STATUS_METHOD, { sessionId: sid }).then(
          (result) => {
            const status = result as { available?: unknown; reason?: unknown; model?: unknown } | null
            reply(status?.available === true
              ? { available: true, ...typeof status.model === 'string' ? { model: status.model.slice(0, 120) } : {} }
              : { available: false, reason: typeof status?.reason === 'string' ? status.reason : 'bridge' })
          },
          () => { reply({ available: false, reason: 'bridge' }) },
        )
        break
      }
      case 'selection.clear': {
        // The user sent, dismissed, or explicitly abandoned this window's
        // quote. A send/dismiss names the value it acted on so a newer capture
        // that arrived while work was in flight cannot be cleared by mistake.
        const windowId = panelWindows.get(port)
        if (windowId === undefined) break
        const request = message as { selection?: unknown }
        const expected = request.selection === undefined ? undefined : parsePageSelection(request.selection)
        if (expected === null) break
        const source = selections.source(windowId)
        const cleared = expected === undefined
          ? selections.clear(windowId)
          : selections.clearIfCurrent(windowId, expected)
        if (cleared && source !== null) resetSelectionDedupe([source])
        // Also repairs a panel that acted on a stale attachment.
        broadcastSelection(windowId)
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown; isNew?: boolean }
        const sid = validSessionId(session.sessionId)
        if (sid === undefined) {
          panelActiveSessions.delete(port)
        } else {
          panelActiveSessions.set(port, sid)
          if (session.isNew === true) {
            const bind = Promise.all([affinityReady, pageSessionContexts.ready]).then(async () => {
              const tab = await syncActiveTab()
              const summary = tab === undefined ? null : summarizeTab(tab)
              if (summary === null) throw new Error('No active tab is available to bind this session')
              if (tabAffinity.getSessionTab(sid) === undefined) tabAffinity.bindNewSession(sid, summary)
              pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
              resetTabSnapshot(summary.tabId)
              persistTabAffinity()
              broadcastTabAffinity()
              await refreshSessionSnapshot(sid)
            }).catch(() => {})
            sessionSnapshotRefreshes.set(sid, bind)
            void bind.finally(() => {
              if (sessionSnapshotRefreshes.get(sid) === bind) sessionSnapshotRefreshes.delete(sid)
            })
          } else if (tabAffinity.focusSession(sid)) {
            persistTabAffinity()
            broadcastTabAffinity()
          }
        }
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number' || !isTabAffinityDecision(response.decision)) break
        const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        }).catch(() => {})
        if (response.decision === 'follow' && sid !== undefined) {
          sessionSnapshotRefreshes.set(sid, decision)
          void decision.finally(() => {
            if (sessionSnapshotRefreshes.get(sid) === decision) sessionSnapshotRefreshes.delete(sid)
          })
        } else {
          void decision
        }
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        const rebindSessionId = validSessionId(request.sessionId) ?? panelActiveSessions.get(port)
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToActive(controller.signal, rebindSessionId).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.rebind.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityRebindError ? error.code : 'no-active-tab',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => {
          const current = tabAffinityRebinds.get(requestId)
          if (current?.controller !== controller) return
          clearTimeout(current.timer)
          tabAffinityRebinds.delete(requestId)
        })
        break
      }
      case 'tab-affinity.return': {
        const request = message as { id?: unknown; revision?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        if (tabAffinityReturns.has(requestId)) break
        if (typeof request.revision !== 'number') {
          try {
            port.postMessage({
              type: 'tab-affinity.return.result',
              id: requestId,
              ok: false,
              error: { code: 'bad-request', message: 'the tab affinity revision is missing' },
            })
          } catch { /* port closed */ }
          break
        }
        tabAffinityReturns.add(requestId)
        void returnToControlledTab(request.revision, panelWindows.get(port)).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.return.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.return.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityReturnError ? error.code : 'return-failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => { tabAffinityReturns.delete(requestId) })
        break
      }
      case 'request-status':
        try {
          port.postMessage(statusPayload())
          port.postMessage(autoReviewStatePayload())
          port.postMessage({ type: 'kill-switch', engaged: killSwitchEngaged })
          // A push on connect cannot reach a panel that has not subscribed yet,
          // so the status request is also the pull path for developer tools.
          postDevToolsState(port)
          port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() })
          const statusWindowId = panelWindows.get(port)
          if (statusWindowId !== undefined) {
            port.postMessage({ type: 'selection', selection: selections.current(statusWindowId) })
          }
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
          approvals.replay((request) => {
            port.postMessage({ type: 'approval.request', request })
            return true
          })
          const resumeWindowId = panelWindows.get(port)
          if (resumeWindowId !== undefined) void postResumeHint(port, resumeWindowId)
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    for (const operation of tabAffinityRebinds.values()) {
      clearTimeout(operation.timer)
      operation.controller.abort(new TabAffinityRebindError('cancelled', getUiLocale() === 'zh'
        ? '后台连接已断开，标签页绑定已取消'
        : 'The background connection was lost, so tab binding was cancelled'))
    }
    tabAffinityRebinds.clear()
    tabAffinityReturns.clear()
    const panelWindowId = panelWindows.get(port)
    const panelSessionId = panelActiveSessions.get(port)
    panelActiveSessions.delete(port)
    panelPorts.delete(port)
    // Nobody is left to read the code: withdraw a pairing request that is still waiting.
    if (panelPorts.size === 0) activePairing?.abort()
    if (panelSessionId !== undefined) void checkpointSessionPage(panelSessionId)
    interactionResponses.removePort(port)
    if (panelWindowId !== undefined && !hasPanelInWindow(panelWindowId)) {
      const source = selections.source(panelWindowId)
      if (selections.clear(panelWindowId) && source !== null) resetSelectionDedupe([source])
    }
    syncSelectionWatch()
    if (panelPorts.size === 0) {
      devToolsGrants.clear()
      cancelDevToolsCalls()
      // A session the user just left running may still need the browser: the
      // runtime lease keeps an established connection for the idle window.
      if (bridge?.state === 'connected') runtimeLease.touch()
      // Recovery is for a user who is there; panel-free reconnects keep their own rules.
      outageRecovery.end()
      outageGaveUp = false
      if (!runtimeWantsBridge()) {
        bridgeStartRevision += 1
        bridge?.suspendReconnect()
      }
      sessionTrustedActionOrigins.clear()
      approvals.notifyPending()
      // A fresh panel lease re-runs the automatic pass, so a miss is not final
      // for the browser session — only for the lease it was observed in.
      activeScan?.controller.abort()
      rejectedBridgeUrls.clear()
      discoveryLatch = 'idle'
      discoveryState = 'idle'
      persistDiscoveryLatch('idle')
      if (bridge?.state !== 'connected' && !runtimeWantsBridge()) disarmBridgeKeepalive()
    }
    runtimeKeeper.update()
  })
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  openAssistantPanel(windowId)
})

/**
 * Notification buttons (Chrome only). The button's meaning is recomputed from
 * the pending request, and the coordinator re-checks that a notification may
 * allow it at all: detailed approvals (code, typing, uploads, flags) can only
 * be denied here or reviewed in the panel.
 */
chrome.notifications.onButtonClicked?.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const request = approvals.get(id)
  const windowId = approvals.windowId(id)
  if (request === undefined || windowId === undefined) {
    clearApprovalNotification(id)
    return
  }
  const button = approvalNotificationButtons(request, EXT_TARGET)[buttonIndex]
  if (button === 'review') {
    clearApprovalNotification(id)
    openAssistantPanel(windowId)
    return
  }
  if (button === 'allow-once' || button === 'deny') approvals.respondFromNotification(id, button)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    observeActiveSummary({ tabId, windowId, title: '', url: '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (focusedWindow.isCurrent(activationRevision)) observeActiveTab(tab)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // The old document is gone even though Chrome transfers the tab identity.
  broadcastSelections(selections.clearTab(removedTabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.replaceTab(removedTabId, addedTabId)
  })
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    resetTabSnapshot(removedTabId)
    resetTabSnapshot(addedTabId)
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  broadcastSelections(selections.clearTab(tabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.removeTab(tabId)
  })
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

// A committed navigation replaces a document; a same-document history or
// fragment update does not, and must not drop a quote still on the screen.
// Matching the exact frame keeps an iframe's navigation from invalidating a
// quote taken from its parent page, and vice versa.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  // Developer-tools grants end once their tab leaves the granted origin.
  if (frameId === 0) devToolsGrants.onTopFrameCommit(tabId, url)
  // A "do the remaining N" series ends with the document it was approved on.
  if (frameId === 0) programGrants.onTopFrameNavigation(tabId, url, false)
  cancelDevToolsCalls(tabId)
  broadcastSelections(selections.clearTab(tabId, frameId))
  // A new top-level document drops any modifier or button held by a trusted
  // input sequence; keeping it would leak state into the next page.
  if (frameId === 0) {
    // A new top-level document has no dialog of the old one.
    dialogs.clear(tabId)
    resetInputState(tabId)
    // Only the input hold is stale after a navigation. The developer-tools
    // capture must survive navigation (it re-syncs frames and keeps buffering),
    // so never detach the whole tab here.
    void debuggerBroker.detachOwner(tabId, 'input').catch(() => undefined)
  }
})

// A closed tab cannot stay debugged; release the attachment immediately so the
// "being debugged" banner never outlives its page.
chrome.tabs.onRemoved.addListener((tabId) => {
  agentOverlay.forget(tabId)
  dialogs.clear(tabId)
  resetInputState(tabId)
  devTools.releaseTab(tabId)
  commitGateCallers.delete(tabId)
  resetTabSnapshot(tabId)
  learning.forgetTab(tabId)
  void commitGate.forget(tabId)
})

// Ports are cleaned up by their own disconnect; only the window's quote is
// left behind when the whole window goes away.
chrome.windows.onRemoved.addListener((windowId) => {
  selections.clear(windowId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DEVTOOLS_EXPIRY_ALARM) {
    void settingsReady.then(expireDevToolsAllowance)
    return
  }
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  void runtimeRestored.then(onKeepaliveAlarm)
})

function onKeepaliveAlarm(): void {
  if (panelPorts.size === 0) {
    runtimeKeeper.update()
    if (!runtimeLease.active()) {
      if (bridge === null || bridge.state !== 'connected') disarmBridgeKeepalive()
      return
    }
    if (runtimeLease.standingOnly() && !standingRetry.due()) {
      // A parked standing-work reconnect: not before its retry time.
      armBridgeKeepalive()
      return
    }
    // Panel-free runtime: the worker was restarted, or the socket dropped.
    if (bridge === null || bridge.state === 'reconnecting') void settingsReady.then(() => startBridge())
    return
  }
  // An outage of a connected bridge is retried on its own schedule, for a
  // bounded period; this alarm only makes sure an overdue attempt runs.
  beginOutageRecoveryIfDue()
  if (outageRecovery.active) {
    outageRecovery.tick()
    return
  }
  // A confirmed miss is terminal for this lease: do not re-probe in the
  // background, and do not wake the worker for it either.
  if (discoveryLatch === 'not-found') return
  // `stopped` is intentionally terminal until an explicit panel reopen or
  // settings save. In particular, code 4000 means another browser owns the
  // single bridge slot and the keepalive must not reclaim it.
  if (bridge === null || bridge.state === 'reconnecting') {
    void settingsReady.then(() => startBridge())
  }
}

// ---- Kill switch shortcut ----

// Ctrl+Shift+K / Cmd+Shift+K by default; users rebind it on the browser's
// extension shortcuts page. Test harnesses without the API skip it.
;(chrome as unknown as { commands?: { onCommand?: { addListener(listener: (command: string) => void): void } } })
  .commands?.onCommand?.addListener((command) => {
    if (command === KILL_SWITCH_COMMAND) void engageKillSwitch()
  })

// ---- Boot ----

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function openAssistantPanel(windowId?: number): void {
  if (import.meta.env.EXT_TARGET === 'firefox') {
    const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
    if (sidebar === undefined) return
    void Promise.resolve(sidebar.open()).catch(() => {})
    return
  }
  if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => {})
}

// Open the side panel when the toolbar icon is clicked.
// Chrome 116+ uses chrome.sidePanel; Firefox has no sidePanel API, so the
// action click opens the sidebar via sidebarAction.open() (user gesture).
if (import.meta.env.EXT_TARGET === 'firefox') {
  chrome.action.onClicked.addListener(() => { openAssistantPanel() })
} else {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
}

// Alarms survive some extension/service-worker restarts. Remove any stale
// schedule left by an older eager-connection build; onConnect re-arms it, and
// so does the runtime lease (onActive, and the restore path once
// runtimeRestored has read storage). This unconditional disarm runs before
// either can: the restore path awaits storage first.
disarmBridgeKeepalive()

// A single-page app changes route without a new document: a "do the
// remaining N" series ends when its tab's path changes (query and fragment
// may change; the rows are checked one by one anyway).
for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated] as Array<typeof chrome.webNavigation.onHistoryStateUpdated | undefined>) {
  event?.addListener(({ tabId, frameId, url }) => {
    if (frameId === 0) programGrants.onTopFrameNavigation(tabId, url, true)
  })
}

// `settingsReady` intentionally has no bridge-start continuation: opening a
// side panel is the first action allowed to claim the bridge connection.
// The one exception is standing work the user opted into (runtimeRestored):
// a Host hint stored by an earlier connection reconnects headlessly. Alarms
// may not survive a browser restart, so this listener exists to have the
// browser start the worker (and with it runtimeRestored) at startup.
;(chrome.runtime as { onStartup?: { addListener(listener: () => void): void } }).onStartup?.addListener(() => {})

// Dev loop: keep the error collector installed across navigations of a
// linked tab, and end links when their tab closes.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId === 0) void devLoop.onCommitted(tabId, url)
})
chrome.tabs.onRemoved.addListener((tabId) => { void devLoop.onRemoved(tabId) })
