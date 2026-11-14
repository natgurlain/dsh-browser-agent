import type { BridgeState } from '../background/bridge.ts'
import type { UiLocale } from '../i18n.ts'

export interface PanelCopy {
  documentTitle: string
  status: Record<BridgeState, string>
  /** Status shown when the startup pass found no local dsh at all. */
  statusNotFound: string
  /** Specific refusals reported by the bridge (shown instead of the transport state). */
  bridgeFailure: Record<'token-mismatch' | 'version-mismatch' | 'origin-rejected' | 'busy', string>
  approval: {
    eyebrow: string
    readTitle: string
    actionTitle: string
    request: string
    origins: string
    unknownOrigin: string
    deny: string
    allowOnce: string
    alwaysAllowReads: string
    trustSession: string
    devToolsTitle: string
    trustDevTools: string
    readFootnote: string
    actionFootnote: string
    devToolsFootnote: string
    /** Label of the eval-trust checkbox on a console-eval card. */
    trustEval: (origin: string) => string
    /** Label of the developer-tools session trust button. */
    trustDevToolsOrigin: (origin: string) => string
    codeLabel: (characters: number) => string
    showCode: string
    hideCode: string
    typedTextLabel: string
    maskedText: (characters: number) => string
    reveal: string
    hide: string
    pathsLabel: (count: number) => string
    urlLabel: string
    queryParams: string
    fragmentLabel: string
    flagLong: string
    flagEntropy: string
    urlRiskNote: string
    flagsLabel: string
    payloadLabel: string
    flagDescriptions: Record<string, string>
    perCallNote: string
    fingerprint: string
  }
  tool: {
    running: string
    complete: string
    inProgress: string
    completed: string
    done: string
    labels: Record<string, string>
    overflow: (shown: string[], total: number) => string
  }
  tabHandoff: {
    eyebrow: string
    assistant: string
    you: string
    unknownTab: string
    closedTab: string
    questionTitle: string
    questionBody: (controlled: string, active: string) => string
    keep: string
    keepAlways: string
    follow: string
    /** Move the user's own tab back to the page the assistant is bound to. */
    returnToAssistant: string
    backgroundTitle: (controlled: string) => string
    backgroundBody: (active: string) => string
    pinnedBody: (active: string) => string
    askAgain: string
    followCurrent: string
    lostTitle: string
    lostBody: string
    useCurrent: string
  }
  question: {
    eyebrow: string
    title: string
    customAlternative: string
    customAnswer: string
    dismiss: string
    answer: string
    answering: string
    alreadyAnswered: string
    answerRejected: string
  }
  settings: {
    back: string
    eyebrow: string
    title: string
    language: string
    languageHelp: string
    languageAuto: string
    languageEnglish: string
    languageChinese: string
    bridgeAddress: string
    bridgeHelp: string
    bridgePlaceholder: string
    detect: string
    detectCancel: string
    detectHelp: string
    detectProgress: (done: number, total: number) => string
    detectEmpty: string
    detectPick: string
    detectCurrent: string
    detectConnected: (address: string) => string
    detectSource: Record<'fixed' | 'beacon', string>
    tokenHelp: string
    tokenPlaceholder: string
    pageSharing: string
    pageSharingHelp: string
    sharingAuto: string
    sharingAsk: string
    sharingOff: string
    unrestrictedBrowserAccess: string
    unrestrictedBrowserAccessHelp: string
    allowDevTools: string
    allowDevToolsHelp: string
    devToolsUnsupported: string
    devToolsOff: string
    devToolsIdle: string
    devToolsAttached: string
    devToolsError: string
    devToolsDetach: string
    approvalNotifications: string
    approvalNotificationsHelp: string
    approvalTimeout: string
    approvalTimeoutHelp: string
    catchPageDialogs: string
    catchPageDialogsHelp: string
    autoResumeSession: string
    autoResumeSessionHelp: string
    showAgentOverlay: string
    showAgentOverlayHelp: string
    trustedOrigins: string
    trustedOriginsHelp: string
    trustedOriginInput: string
    add: string
    invalidOrigin: string
    noTrustedOrigins: string
    remove: string
    removeOrigin: (origin: string) => string
    save: string
    cancel: string
    snapshotHint: (maxChars: number) => string
    relaySection: string
    relayHelp: string
    relayName: string
    relayNamePlaceholder: string
    relayProtocol: string
    relayProtocolClaude: string
    relayProtocolOpenai: string
    relayProtocolCodex: string
    relayBaseUrl: string
    relayToken: string
    relayTokenPlaceholder: (configured: boolean) => string
    relayModels: string
    relayModelsHelp: string
    relayModelsPlaceholder: string
    relayAdd: string
    relayRemove: string
    relaySetDefault: string
    relaySetDefaultHelp: string
    relayFetchModels: string
    relayFetching: string
    relayFetchOk: (count: number) => string
    relayNeedBaseUrl: string
    relayOpenaiListingNote: string
    relayTest: string
    relayTesting: string
    relayTestOk: (count: number, names: string) => string
    relayTestFailed: (reason: string) => string
    relayTestManualOnly: string
    relaySavedOk: string
    relaySaveFailed: (reason: string) => string
    relayEmpty: string
    relayInvalidName: string
  }
  update: {
    eyebrow: string
    title: string
    idleTitle: string
    idleBody: string
    checking: string
    checkingBody: string
    currentTitle: string
    currentBody: (latestVersion: string) => string
    availableTitle: (latestVersion: string) => string
    availableLoadingBody: string
    availableManagedBody: string
    availableCheckoutBody: string
    availableUnknownBody: string
    reloadReminder: string
    loadingInstall: string
    managedInstall: string
    checkoutInstall: string
    unknownInstall: string
    errorTitle: string
    errorBody: string
    check: string
    copyManagedCommand: string
    copyCheckoutCommand: string
    copied: string
    copyError: string
  }
  uninstall: {
    title: string
    runCommand: string
    copyCommand: string
    copied: string
    copyError: string
  }
  agentControl: {
    /** Holds the next browser action once the current one finishes. */
    pauseAfterStep: string
    pauseAfterStepHint: string
    takeOver: string
    takeOverHint: string
    resume: string
    resumeHint: string
    working: string
    pausedTitle: string
    pausedBody: (held: number) => string
    takenOverTitle: string
    takenOverBody: (held: number) => string
    resuming: string
  }
  timeline: {
    title: (count: number) => string
    expand: string
    collapse: string
    arguments: string
    result: string
    screenshot: string
    running: string
    failed: string
    decisions: Record<string, string>
    /** Policy-layer badges (site policy, taint, strict mode). */
    policies: Record<string, string>
    duration: (ms: number) => string
  }
  audit: {
    section: string
    help: string
    exportButton: string
    exporting: string
    exported: (count: number, verified: boolean) => string
    failed: (message: string) => string
  }
  killSwitch: {
    /** Toolbar button that stops the agent. */
    engage: string
    /** Tooltip naming the keyboard shortcut. */
    engageHint: string
    title: string
    body: string
    reconnect: string
  }
  textSize: {
    open: string
    title: string
    smaller: string
    larger: string
    reset: string
    value: (percent: string) => string
  }
  app: {
    openSettings: string
    settings: string
    openSessions: string
    sessions: string
    newSession: string
    sessionPickerLoading: string
    sessionPickerEmpty: string
    deleteSession: string
    deleteSessionConfirm: (title: string) => string
    deleteSessionFailed: (reason: string) => string
    deletePurgeFailed: (reason: string) => string
    emptyTitle: string
    emptyDescription: string
    overviewPage: string
    overviewPrompt: string
    assistant: string
    assistantWorking: string
    organizingResults: string
    thinking: string
    connectedPlaceholder: string
    disconnectedPlaceholder: string
    composerHelp: string
    sendMessage: string
    selectModel: string
    noModelsConfigured: string
    stopTurn: string
    continueGeneration: string
    stoppingTurn: string
    addImages: string
    imageUnavailable: string
    removeImage: (name: string) => string
    image: string
    imageLoading: string
    imageLoadFailed: string
    openImage: string
    openNamedImage: (name: string) => string
    imagePreview: string
    closeImage: string
    imageUnsupported: (name: string) => string
    imageTooMany: (max: number) => string
    imageTooLarge: (name: string, max: string) => string
    imageMessageTooLarge: (max: string) => string
    imageDimensionTooLarge: (name: string, max: number) => string
    imagePixelsTooLarge: (name: string, max: number) => string
    imageDecodeFailed: (name: string) => string
    imageModelUnsupported: string
    imageSubagentUnsupported: string
    imageSendFailed: (reason: string) => string
    selectionChip: string
    selectionAttached: string
    selectionTruncated: string
    removeSelection: string
    scrollToBottom: string
    permissionControl: string
    permissionMenu: string
    permissionReadOnly: string
    permissionWorkspaceWrite: string
    permissionFullAccess: string
    permissionAuto: string
    permissionCustom: string
    permissionExperimental: string
    permissionPendingHint: string
    permissionDefaultHint: (name: string) => string
    permissionConfirmTitle: (label: string) => string
    permissionConfirmBody: (label: string, preset: string) => string
    permissionConfirmAccept: string
    permissionConfirmCancel: string
    permissionSwitchFailed: (reason: string) => string
    permissionUnavailable: string
    modelUnavailable: string
    modelReasoning: string
    modelReasoningDefault: string
    retry: string
    slashMenu: string
    slashCommands: string
    slashSkills: string
    slashLocal: string
    slashUserOnly: string
    slashLocalModel: string
    slashEmpty: string
    slashProvisional: string
    unknownCommand: (name: string) => string
    commandFailed: (reason: string) => string
    commandSucceeded: string
    commandProvisional: string
    commandAttachmentsUnsupported: string
  }
}

const EN: PanelCopy = {
  documentTitle: 'dsh Browser Assistant',
  status: {
    connected: 'Connected',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    stopped: 'Disconnected',
  },
  statusNotFound: 'No service found',
  bridgeFailure: {
    'token-mismatch': 'Token mismatch or untrusted bridge: check the bridge token in Settings',
    'version-mismatch': 'Version mismatch: update the dsh plugin and the extension together',
    'origin-rejected': 'Unrecognized extension ID: add it to allowedChromeExtensionIds',
    busy: 'Bridge busy, retrying…',
  },
  approval: {
    eyebrow: 'Security check',
    readTitle: 'Allow page access?',
    actionTitle: 'Allow page action?',
    request: 'Request',
    origins: 'Origins involved',
    unknownOrigin: 'Unknown origin',
    deny: 'Deny',
    allowOnce: 'Allow once',
    alwaysAllowReads: 'Always allow reads',
    trustSession: 'Trust this domain for this session',
    devToolsTitle: 'Allow developer tools?',
    trustDevTools: 'Trust developer tools for this session',
    readFootnote: 'Esc to deny · You can disable automatic reading in Settings at any time',
    actionFootnote: 'Esc to deny · Temporary trust ends when the side panel closes · Text for sensitive fields starts masked',
    devToolsFootnote: 'Developer tools expose page internals and captured traffic. Trust covers this conversation on this site for 30 minutes, ends when the tab leaves the site or the side panel closes, and never covers JavaScript or unredacted traffic. Chrome blocks its own DevTools while this runs.',
    trustEval: (origin) => `Trust JavaScript on ${origin} for this conversation (30 min)`,
    trustDevToolsOrigin: (origin) => `Trust developer tools on ${origin} for this conversation (30 min)`,
    codeLabel: (characters) => `JavaScript to run (${characters} characters)`,
    showCode: 'Show code',
    hideCode: 'Hide code',
    typedTextLabel: 'Text to type',
    maskedText: (characters) => `Masked: ${characters} characters for a sensitive or uninspected field`,
    reveal: 'Reveal',
    hide: 'Hide',
    pathsLabel: (count) => `Local files to attach (${count})`,
    urlLabel: 'Full destination URL',
    queryParams: 'Decoded parameters',
    fragmentLabel: 'Fragment',
    flagLong: 'long value',
    flagEntropy: 'looks like a token or secret',
    urlRiskNote: 'This URL carries data that could be leaked to the destination. Trusted domains still ask for these.',
    flagsLabel: 'Redaction turned off for this call',
    payloadLabel: 'Request arguments',
    flagDescriptions: {
      includeSensitiveHeaders: 'includeSensitiveHeaders — reveals Authorization, Cookie, Set-Cookie and similar header values',
      includeSensitiveBody: 'includeSensitiveBody — reveals bodies of authentication-looking requests',
    },
    perCallNote: 'This call always needs its own approval; no setting or session trust covers it.',
    fingerprint: 'Approval fingerprint',
  },
  tool: {
    running: 'Working on page',
    complete: 'Page action',
    inProgress: 'In progress',
    completed: 'Completed',
    done: 'Done',
    labels: {
      browser_snapshot: 'Read page',
      browser_click: 'Click element',
      browser_type: 'Enter text',
      browser_press: 'Press key',
      browser_scroll: 'Scroll page',
      browser_navigate: 'Open page',
      browser_open_tab: 'Open new tab',
      browser_list_tabs: 'List open tabs',
      browser_follow_tab: 'Follow tab',
      browser_close_tab: 'Close tab',
      browser_back: 'Go back',
      browser_forward: 'Go forward',
      browser_reload: 'Reload page',
      browser_get_text: 'Extract text',
      browser_wait: 'Wait for page',
      browser_select: 'Select option',
      browser_extract: 'Extract data',
      browser_devtools_elements: 'Inspect element',
      browser_devtools_set_element_style: 'Edit element CSS',
      browser_devtools_set_element_attribute: 'Edit element attribute',
      browser_console_eval: 'Run page JavaScript',
      browser_console_logs: 'Read page console',
      browser_devtools_network: 'Control network capture',
      browser_devtools_list_requests: 'List network requests',
      browser_devtools_get_request: 'Read request detail',
      browser_devtools_request_body: 'Read request body',
      browser_screenshot: 'Take screenshot',
      browser_hover: 'Hover element',
      browser_drag: 'Drag element',
      browser_clipboard: 'Paste from clipboard',
      browser_upload: 'Upload file',
      browser_dialog: 'Answer page dialog',
      browser_downloads: 'Check downloads',
      browser_save_pdf: 'Save page as PDF',
      browser_pdf_text: 'Read PDF text',
    },
    overflow: (shown, total) => `${shown.join(' → ')} → ${total - shown.length} more`,
  },
  tabHandoff: {
    eyebrow: 'Page handoff',
    assistant: 'Assistant',
    you: 'You',
    unknownTab: 'Untitled tab',
    closedTab: 'Closed tab',
    questionTitle: 'Follow your current page?',
    questionBody: (controlled, active) => `It is still bound to “${controlled}”, while you moved to “${active}”. Browser actions are paused until you choose.`,
    keep: 'Assistant stays on the original page',
    keepAlways: 'Assistant stays & stop asking',
    follow: 'Assistant follows the current page',
    returnToAssistant: 'Jump back to the assistant page',
    backgroundTitle: () => 'Assistant stays on the original page',
    backgroundBody: (active) => `You are viewing “${active}”. Future browser actions still run on the original page.`,
    pinnedBody: (active) => `You are viewing “${active}”. Future browser actions still run on the original page, and switching tabs will not ask again.`,
    askAgain: 'Ask on tab switch',
    followCurrent: 'Follow the current page',
    lostTitle: 'The controlled tab was closed',
    lostBody: 'Browser actions are paused to avoid operating the wrong page.',
    useCurrent: 'Use current page',
  },
  question: {
    eyebrow: 'Waiting for your answer',
    title: 'The assistant needs your input',
    customAlternative: 'Or type a different answer',
    customAnswer: 'Type your answer',
    dismiss: 'Dismiss',
    answer: 'Answer',
    answering: 'Answering…',
    alreadyAnswered: 'This question was already handled in another window.',
    answerRejected: 'The answer was not accepted. Review it and try again.',
  },
  settings: {
    back: 'Back to chat',
    eyebrow: 'Browser assistant',
    title: 'Settings',
    language: 'Language',
    languageHelp: 'Language of the assistant panel and its notifications. Takes effect immediately.',
    languageAuto: 'Automatic (follow Chrome)',
    languageEnglish: 'English',
    languageChinese: '中文',
    bridgeAddress: 'Bridge address',
    bridgeHelp: 'Leave blank to detect a local service automatically',
    bridgePlaceholder: 'Auto-detect (desktop beacon 43189–43198 included)',
    detect: 'Detect',
    detectCancel: 'Cancel',
    detectHelp: 'Probes this machine once and lists every local dsh instance.',
    detectProgress: (done, total) => `Detecting ${done} / ${total} ports…`,
    detectEmpty: 'No service found.',
    detectPick: 'Select an instance to fill in its address.',
    detectCurrent: 'in use',
    detectConnected: (address) => `Connected to ${address}`,
    detectSource: { fixed: 'fixed port', beacon: 'beacon' },
    tokenHelp: 'Required by Firefox and remote deployments',
    tokenPlaceholder: 'Required for Firefox / remote deployments',
    pageSharing: 'Page content sharing',
    pageSharingHelp: 'Control when the assistant can read page text',
    sharingAuto: 'Share automatically (default)',
    sharingAsk: 'Ask every time',
    sharingOff: 'Off',
    unrestrictedBrowserAccess: 'Allow unrestricted browser control',
    unrestrictedBrowserAccessHelp: 'Trust every site except those your site policy restricts: the model reads pages, inspects open tab titles and URLs, and acts—including following and closing tabs—without confirmation. Blocked, read-only, and always-ask sites (including the built-in protections), untrusted-content safeguards, and managed policy still apply. Browser-protected page content remains inaccessible.',
    allowDevTools: 'Allow developer tools',
    allowDevToolsHelp: 'High privilege: lets the model inspect and modify page elements and CSS, run JavaScript in the page, and read captured network requests. Off by default, where every call asks for approval. Even when on, running JavaScript and reading unredacted headers or bodies still ask on every call. Chrome cannot keep its own DevTools open on a tab while this is attached.',
    devToolsUnsupported: 'Unavailable — this browser does not provide the debugger API.',
    devToolsOff: 'Off — every call asks for approval.',
    devToolsIdle: 'Enabled — the debugger attaches on the first call. JavaScript still asks each time.',
    devToolsAttached: 'Debugger attached',
    devToolsError: 'Last error:',
    devToolsDetach: 'Detach now',
    catchPageDialogs: 'Catch page dialogs — shows Chrome\'s debugging bar',
    catchPageDialogsHelp: 'Attach the debugger before clicks, key presses, and navigation so alert/confirm/prompt/leave-site dialogs are reported and the agent can answer them. While attached, Chrome shows a "being debugged" bar that can shift the page.',
    approvalNotifications: 'Browser approval notifications',
    approvalNotificationsHelp: 'Notify you when an approval arrives while the side panel is closed. Simple actions can be allowed from the notification; code, typing, and uploads open the full card.',
    approvalTimeout: 'Approval wait without the side panel (minutes)',
    approvalTimeoutHelp: 'How long an approval waits for an answer while the side panel is closed — from a notification, the dsh web UI, or the CLI — before it is denied. 1–14 minutes.',
    autoResumeSession: "Resume this page's conversation",
    autoResumeSessionHelp: 'Reopen the conversation associated with this tab and page path; other pages start a new conversation',
    showAgentOverlay: 'Show the agent on the page',
    showAgentOverlayHelp: 'A ghost cursor and outline mark each target before the agent acts, and controlled tabs get a colored frame with a Stop button',
    trustedOrigins: 'Always-allowed domains',
    trustedOriginsHelp: 'The approval dialog can trust a domain for the current side-panel session only. Domains added here permanently skip action confirmation when every known origin is trusted. Wildcards include the base domain and subdomains, and stay scoped to their scheme and port; `*.example.com` defaults to HTTPS.',
    trustedOriginInput: 'Domain to always trust (e.g. https://example.com or https://*.example.com)',
    add: 'Add',
    invalidOrigin: 'Enter an http:// or https:// origin, or a wildcard such as https://*.example.com.',
    noTrustedOrigins: 'No domains are currently trusted.',
    remove: 'Remove',
    removeOrigin: (origin) => `Remove ${origin}`,
    save: 'Save & Connect',
    cancel: 'Cancel',
    snapshotHint: (maxChars) => `Page snapshots are limited to ${maxChars} characters and longer content is truncated. Change snapshotMaxChars in the dsh plugin to adjust this limit.`,
    relaySection: 'Models & API relay',
    relayHelp: 'Point the assistant at your own API relay. Each profile becomes one provider route; changes take effect on the next message without a restart.',
    relayName: 'Profile name',
    relayNamePlaceholder: 'e.g. my-relay',
    relayProtocol: 'API format',
    relayProtocolClaude: 'Claude (Anthropic Messages)',
    relayProtocolOpenai: 'OpenAI (Chat Completions)',
    relayProtocolCodex: 'Codex (OpenAI Responses)',
    relayBaseUrl: 'Base URL',
    relayToken: 'Token',
    relayTokenPlaceholder: (configured) => configured ? 'Saved — type to replace' : 'API token for the relay',
    relayModels: 'Models',
    relayModelsHelp: 'One model per line as `id, context window` — e.g. `claude-sonnet-4-5, 200000`. The context window is optional.',
    relayModelsPlaceholder: 'model-id, 128000',
    relayFetchModels: 'Fetch models',
    relayFetching: 'Fetching models…',
    relayFetchOk: (count) => `Filled in ${count} models from the relay.`,
    relayNeedBaseUrl: 'Enter a base URL first.',
    relayOpenaiListingNote: ' (listed via the relay\'s OpenAI-compatible endpoint)',
    relayAdd: 'Add profile',
    relayRemove: 'Remove profile',
    relaySetDefault: 'Use as default model',
    relaySetDefaultHelp: 'New conversations start with the first model of this profile',
    relayTest: 'Test connection',
    relayTesting: 'Testing…',
    relayTestOk: (count, names) => `OK — ${count} model(s): ${names}`,
    relayTestFailed: (reason) => `Failed: ${reason}`,
    relayTestManualOnly: 'This protocol does not support listing models; fill them in manually.',
    relaySavedOk: 'Relay profiles saved.',
    relaySaveFailed: (reason) => `Saving failed: ${reason}`,
    relayEmpty: 'No relay profiles yet.',
    relayInvalidName: 'Enter a profile name.',
  },
  update: {
    eyebrow: 'Release channel',
    title: 'Updates',
    idleTitle: 'Ready to check',
    idleBody: 'Compare this build with the version on GitHub main.',
    checking: 'Checking…',
    checkingBody: 'Reading the latest extension manifest from GitHub.',
    currentTitle: 'No update found',
    currentBody: (latestVersion) => `Repository version: v${latestVersion}.`,
    availableTitle: (latestVersion) => `Version ${latestVersion} is available`,
    availableLoadingBody: 'Confirming how this extension was installed before offering an update command.',
    availableManagedBody: 'Copy the managed update command and run it in Terminal.',
    availableCheckoutBody: 'Pull or switch to the revision you want in the original checkout, then rerun its installer.',
    availableUnknownBody: 'This copy predates install-source metadata. Use the same update flow you originally installed with; no command will be copied.',
    reloadReminder: 'After updating, open chrome://extensions, find “dsh Browser Assistant,” click the rotating-arrow Reload button on its card, then restart dsh.',
    loadingInstall: 'Identifying install…',
    managedInstall: 'Managed install',
    checkoutInstall: 'Local checkout',
    unknownInstall: 'Install source unknown',
    errorTitle: 'Could not check for updates',
    errorBody: 'Check your network connection and try again.',
    check: 'Check for updates',
    copyManagedCommand: 'Copy update command',
    copyCheckoutCommand: 'Copy checkout command',
    copied: 'Command copied',
    copyError: 'Could not copy the command. Run the installer from the original installation source instead.',
  },
  uninstall: {
    title: 'Uninstall dsh-browser',
    runCommand: 'Run this command in Terminal.',
    copyCommand: 'Copy uninstall command',
    copied: 'Command copied',
    copyError: 'Copy failed',
  },
  agentControl: {
    pauseAfterStep: 'Pause after this step',
    pauseAfterStepHint: 'Let the current browser action finish, then hold the next one until you resume',
    takeOver: 'Take over',
    takeOverHint: 'Pause the agent and use the page yourself; resume to hand control back',
    resume: 'Resume',
    resumeHint: 'Tell the agent what changed and continue',
    working: 'The agent is using the browser',
    pausedTitle: 'Paused',
    pausedBody: (held) => held === 0 ? 'The next browser action will wait for you.' : `${held} browser action${held === 1 ? ' is' : 's are'} waiting for you.`,
    takenOverTitle: "You're in control",
    takenOverBody: (held) => held === 0 ? 'Use the page freely. Resume when done.' : `Use the page freely; ${held} agent action${held === 1 ? ' is' : 's are'} waiting. Resume when done.`,
    resuming: 'Resuming…',
  },
  timeline: {
    title: (count) => `${count} browser step${count === 1 ? '' : 's'}`,
    expand: 'Show details',
    collapse: 'Hide details',
    arguments: 'Arguments',
    result: 'Result',
    screenshot: 'Screenshot',
    running: 'Running',
    failed: 'Failed',
    decisions: {
      'not-required': 'Auto',
      'auto-allowed': 'Trusted',
      'program-approved': 'Program approved',
      allowed: 'Approved',
      denied: 'Denied',
      'timed-out': 'Timed out',
      unavailable: 'No approval',
      cancelled: 'Cancelled',
      'held-expired': 'Paused too long',
    },
    policies: {
      blocked: 'Blocked by site policy',
      tainted: 'Needs review (tainted)',
      'site-ask': 'Site asks first',
      'strict-armed': 'Strict mode',
      'strict-refused': 'Strict mode: refused',
    },
    duration: (ms) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`,
  },
  audit: {
    section: 'Audit log',
    help: 'Every browser action, approval, navigation, and result is written to a tamper-evident (hash-chained) log on this computer. Typed text and secrets are never stored.',
    exportButton: 'Export audit log',
    exporting: 'Exporting…',
    exported: (count, verified) => `Exported ${count} entr${count === 1 ? 'y' : 'ies'}${verified ? ' — chain verified' : ' — chain verification FAILED'}`,
    failed: (message) => `Could not export the audit log: ${message}`,
  },
  killSwitch: {
    engage: 'Stop the agent',
    engageHint: 'Stop the agent now — shortcut Ctrl+Shift+K (⌘⇧K on Mac, Alt+Shift+K in Firefox)',
    title: 'Agent stopped',
    body: 'Pending approvals and running browser actions were cancelled, session trust and developer-tools grants were revoked, unrestricted access was turned off, the debugger was detached, and the connection to dsh was closed.',
    reconnect: 'Reconnect',
  },
  textSize: {
    open: 'Text size',
    title: 'Text size',
    smaller: 'Smaller text',
    larger: 'Larger text',
    reset: 'Reset',
    value: (percent) => `Text size ${percent}`,
  },
  app: {
    openSettings: 'Open settings',
    settings: 'Settings',
    openSessions: 'Session history',
    sessions: 'Sessions',
    newSession: 'New chat',
    sessionPickerLoading: 'Loading…',
    sessionPickerEmpty: 'No past sessions yet',
    deleteSession: 'Delete session',
    deleteSessionConfirm: (title) => `Delete “${title}”? Its conversation history will be removed permanently.`,
    deleteSessionFailed: (reason) => `Delete failed: ${reason}`,
    deletePurgeFailed: (reason) => `Removed from the list, but file cleanup failed (it may reappear after dsh restarts): ${reason}`,
    emptyTitle: 'Hand me the current page',
    emptyDescription: 'I can read the page, find information, and click, fill, or navigate for you.',
    overviewPage: 'Give me an overview',
    overviewPrompt: 'First give me an overview of the current page, tell me the most important information, and wait for my next instruction.',
    assistant: 'Assistant',
    assistantWorking: 'Assistant is working',
    organizingResults: 'Organizing results',
    thinking: 'Thinking',
    connectedPlaceholder: 'Tell me what you want to do on this page…',
    disconnectedPlaceholder: 'Connect to dsh to get started',
    composerHelp: 'Enter to send · Shift + Enter for a new line',
    sendMessage: 'Send message',
    selectModel: 'Model',
    noModelsConfigured: 'No models yet — Host has no routable models.',
    stopTurn: 'Stop generating',
    continueGeneration: 'Continue generating',
    stoppingTurn: 'Stopping…',
    addImages: 'Add images',
    imageUnavailable: 'This dsh host does not advertise image input',
    removeImage: (name) => `Remove ${name}`,
    image: 'Image',
    imageLoading: 'Loading…',
    imageLoadFailed: 'Could not load · Retry',
    openImage: 'Open original image',
    openNamedImage: (name) => `Open ${name}`,
    imagePreview: 'Image preview',
    closeImage: 'Close image preview',
    imageUnsupported: (name) => `${name} is not an image format supported by this dsh host.`,
    imageTooMany: (max) => `You can attach up to ${max} images to one message.`,
    imageTooLarge: (name, max) => `${name} is larger than the per-image limit of ${max}.`,
    imageMessageTooLarge: (max) => `The images in this message exceed the combined limit of ${max}.`,
    imageDimensionTooLarge: (name, max) => `${name} exceeds the maximum width or height of ${max}px.`,
    imagePixelsTooLarge: (name, max) => `${name} exceeds the ${max.toLocaleString()}-pixel limit.`,
    imageDecodeFailed: (name) => `${name} could not be decoded as an image.`,
    imageModelUnsupported: 'The current model does not support images; switch to a model that does.',
    imageSubagentUnsupported: 'Subagent sessions do not support images yet.',
    imageSendFailed: (reason) => `Sending images failed (${reason}). Your draft has been restored; try again.`,
    selectionChip: '1 selection',
    selectionAttached: 'Selected text',
    selectionTruncated: '(truncated)',
    removeSelection: 'Remove the selected text',
    scrollToBottom: 'Scroll to latest',
    permissionControl: 'Permission preset',
    permissionMenu: 'Permission presets',
    permissionReadOnly: 'Read only',
    permissionWorkspaceWrite: 'Workspace edits',
    permissionFullAccess: 'Full access',
    permissionAuto: 'Auto review',
    permissionCustom: 'Custom',
    permissionExperimental: 'EXP',
    permissionPendingHint: 'Applies when the first message creates this chat',
    permissionDefaultHint: (name) => `New chats start from ${name}`,
    permissionConfirmTitle: (label) => `Switch to ${label}?`,
    permissionConfirmBody: (label, preset) => preset === 'danger-full-access'
      ? `Full access runs file and command operations without asking for approval. Only continue if you trust this conversation (${label}).`
      : `Auto review is experimental: a separate reviewer judges each risky call. Only continue if you accept that risk (${label}).`,
    permissionConfirmAccept: 'Switch',
    permissionConfirmCancel: 'Cancel',
    permissionSwitchFailed: (reason) => `Could not switch the permission preset: ${reason}`,
    permissionUnavailable: 'This dsh host does not expose permission presets',
    modelUnavailable: 'Could not load the model list',
    modelReasoning: 'Reasoning effort',
    modelReasoningDefault: 'Default',
    retry: 'Retry',
    slashMenu: 'Commands and skills',
    slashCommands: 'Commands',
    slashSkills: 'Skills',
    slashLocal: 'This panel',
    slashUserOnly: 'User only',
    slashLocalModel: 'Choose the model for the next turn',
    slashEmpty: 'No matching command or skill',
    slashProvisional: 'Available once the first message creates this chat',
    unknownCommand: (name) => `/${name} is not a command or skill, so it was not sent. Start the line with a space to send it as text.`,
    commandFailed: (reason) => `Command failed: ${reason}`,
    commandSucceeded: 'Command finished',
    commandProvisional: 'This command needs a real chat: send the first message first',
    commandAttachmentsUnsupported: 'Commands do not take attachments here. Remove the images or selection, or send the text as a message instead.',
  },
}

const ZH: PanelCopy = {
  documentTitle: 'dsh 浏览器助手',
  status: {
    connected: '已连接',
    connecting: '连接中…',
    reconnecting: '重连中…',
    stopped: '未连接',
  },
  statusNotFound: '未找到服务',
  bridgeFailure: {
    'token-mismatch': '令牌不匹配或桥接不可信：请在设置中检查桥接令牌',
    'version-mismatch': '版本不匹配：请同时更新 dsh 插件和扩展',
    'origin-rejected': '扩展 ID 未被允许：请将其加入 allowedChromeExtensionIds',
    busy: '桥接繁忙，正在重试…',
  },
  approval: {
    eyebrow: '安全检查',
    readTitle: '允许读取页面？',
    actionTitle: '允许执行页面操作？',
    request: '请求',
    origins: '涉及来源',
    unknownOrigin: '未知来源',
    deny: '拒绝',
    allowOnce: '仅允许这一次',
    alwaysAllowReads: '始终允许读取',
    trustSession: '本次会话信任此域',
    devToolsTitle: '允许使用开发者工具？',
    trustDevTools: '本次会话信任开发者工具',
    readFootnote: 'Esc 拒绝 · 可随时在设置中关闭自动读取',
    actionFootnote: 'Esc 拒绝 · 关闭侧栏后临时信任失效 · 敏感字段的输入内容默认遮盖',
    devToolsFootnote: '开发者工具会暴露页面内部结构与抓包内容。信任仅覆盖本对话在此站点上的调用，30 分钟后、标签页离开该站点或侧栏关闭时失效，且从不覆盖 JavaScript 执行与不脱敏的抓包内容。附加期间 Chrome 自身无法在该标签页打开开发者工具。',
    trustEval: (origin) => `本对话中信任在 ${origin} 上执行 JavaScript（30 分钟）`,
    trustDevToolsOrigin: (origin) => `本对话中信任 ${origin} 上的开发者工具（30 分钟）`,
    codeLabel: (characters) => `将执行的 JavaScript（${characters} 个字符）`,
    showCode: '显示代码',
    hideCode: '隐藏代码',
    typedTextLabel: '将输入的文本',
    maskedText: (characters) => `已遮盖：${characters} 个字符（敏感字段或未能检查的字段）`,
    reveal: '显示',
    hide: '隐藏',
    pathsLabel: (count) => `将附加的本地文件（${count} 个）`,
    urlLabel: '完整目标 URL',
    queryParams: '解码后的参数',
    fragmentLabel: '片段',
    flagLong: '值过长',
    flagEntropy: '疑似令牌或密钥',
    urlRiskNote: '此 URL 携带的数据可能被泄露给目标站点。即使是受信任的域名，也会对此类请求再次确认。',
    flagsLabel: '本次调用将关闭脱敏',
    payloadLabel: '调用参数',
    flagDescriptions: {
      includeSensitiveHeaders: 'includeSensitiveHeaders —— 显示 Authorization、Cookie、Set-Cookie 等请求头的值',
      includeSensitiveBody: 'includeSensitiveBody —— 显示疑似认证请求的正文',
    },
    perCallNote: '此调用每次都需要单独确认，任何设置或会话信任都不能代替。',
    fingerprint: '审批指纹',
  },
  tool: {
    running: '正在操作页面',
    complete: '页面操作',
    inProgress: '进行中',
    completed: '已完成',
    done: '完成',
    labels: {
      browser_snapshot: '读取页面',
      browser_click: '点击元素',
      browser_type: '填写内容',
      browser_press: '按下按键',
      browser_scroll: '滚动页面',
      browser_navigate: '打开页面',
      browser_open_tab: '打开新标签页',
      browser_list_tabs: '列出标签页',
      browser_follow_tab: '跟随标签页',
      browser_close_tab: '关闭标签页',
      browser_back: '返回上一页',
      browser_forward: '前进下一页',
      browser_reload: '刷新页面',
      browser_get_text: '提取文字',
      browser_wait: '等待页面',
      browser_select: '选择选项',
      browser_extract: '提取数据',
      browser_devtools_elements: '查看元素',
      browser_devtools_set_element_style: '修改元素 CSS',
      browser_devtools_set_element_attribute: '修改元素属性',
      browser_console_eval: '执行页面 JS',
      browser_console_logs: '读取控制台',
      browser_devtools_network: '控制网络抓包',
      browser_devtools_list_requests: '列出网络请求',
      browser_devtools_get_request: '查看请求详情',
      browser_devtools_request_body: '读取请求正文',
      browser_screenshot: '截取页面截图',
      browser_hover: '悬停元素',
      browser_drag: '拖动元素',
      browser_clipboard: '从剪贴板粘贴',
      browser_upload: '上传文件',
      browser_dialog: '回应页面对话框',
      browser_downloads: '查看下载',
      browser_save_pdf: '将页面保存为 PDF',
      browser_pdf_text: '读取 PDF 文本',
    },
    overflow: (shown, total) => `${shown.join(' → ')} 等${total}个工具`,
  },
  tabHandoff: {
    eyebrow: '页面交接',
    assistant: '助手',
    you: '你',
    unknownTab: '未命名标签页',
    closedTab: '已关闭的标签页',
    questionTitle: '助手要跟随当前页面吗？',
    questionBody: (controlled, active) => `助手仍绑定“${controlled}”，你刚切到“${active}”。选择前，浏览器操作会暂停。`,
    keep: '助手留在原页面',
    keepAlways: '助手留在原页面并不再询问',
    follow: '助手跟随当前页面',
    returnToAssistant: '跳转回到助手页面',
    backgroundTitle: () => '助手仍在原页面',
    backgroundBody: (active) => `你正在查看“${active}”，后续浏览器操作仍会在原页面执行。`,
    pinnedBody: (active) => `你正在查看“${active}”，后续浏览器操作仍会在原页面执行；切换标签页时不会再询问。`,
    askAgain: '切换标签页时重新询问',
    followCurrent: '改为跟随当前页面',
    lostTitle: '受控标签页已关闭',
    lostBody: '为避免操作错页，浏览器操作已暂停。',
    useCurrent: '使用当前页面',
  },
  question: {
    eyebrow: '等待你的回答',
    title: '助手需要你确认',
    customAlternative: '或输入其他答案',
    customAnswer: '输入你的答案',
    dismiss: '放弃',
    answer: '回答',
    answering: '回答中…',
    alreadyAnswered: '这个问题已在另一个窗口中处理。',
    answerRejected: '回答未被接受，请检查后重试。',
  },
  settings: {
    back: '返回对话',
    eyebrow: '浏览器助手',
    title: '设置',
    language: '界面语言',
    languageHelp: '助手侧栏与通知所用语言，切换后立即生效。',
    languageAuto: '自动（跟随 Chrome）',
    languageEnglish: 'English',
    languageChinese: '中文',
    bridgeAddress: '桥地址',
    bridgeHelp: '留空时自动检测本机服务',
    bridgePlaceholder: '自动检测（含桌面版信标 43189–43198）',
    detect: '自动检测',
    detectCancel: '取消',
    detectHelp: '探测一次本机，并列出所有本地 dsh 实例。',
    detectProgress: (done, total) => `正在探测 ${done} / ${total} 个端口…`,
    detectEmpty: '未找到服务。',
    detectPick: '点击实例即可填入它的地址。',
    detectCurrent: '当前使用',
    detectConnected: (address) => `已连接：${address}`,
    detectSource: { fixed: '固定端口', beacon: '信标' },
    tokenHelp: 'Firefox 和远程部署需要填写',
    tokenPlaceholder: 'Firefox / 远程部署时填写',
    pageSharing: '页面内容共享',
    pageSharingHelp: '控制助手何时可以读取页面文字',
    sharingAuto: '自动共享（默认）',
    sharingAsk: '每次询问',
    sharingOff: '关闭',
    unrestrictedBrowserAccess: '允许模型完全控制浏览器',
    unrestrictedBrowserAccessHelp: '信任除站点策略限制之外的所有站点：模型无需确认即可读取页面、查看已打开标签页的标题和链接，并执行包括跟随、关闭标签页在内的操作。被禁止、只读和每次询问的站点（包括内置保护）、不受信任内容防护以及管理员策略仍然生效。浏览器受保护页面的内容仍不可访问。',
    allowDevTools: '允许开发者工具',
    allowDevToolsHelp: '高权限功能：允许模型查看并修改页面元素与 CSS、在页面中执行 JavaScript、读取已捕获的网络请求。默认关闭，关闭时每次调用都会弹出审批。即使开启，执行 JavaScript 以及读取不脱敏的请求头或正文仍会每次确认。附加调试器期间，Chrome 无法在同一标签页打开自带的开发者工具。',
    devToolsUnsupported: '不可用 —— 当前浏览器未提供调试器 API。',
    devToolsOff: '已关闭 —— 每次调用都会请求审批。',
    devToolsIdle: '已开启 —— 首次调用时附加调试器；执行 JavaScript 仍需逐次确认。',
    devToolsAttached: '调试器已附加',
    devToolsError: '最近一次错误：',
    devToolsDetach: '立即断开',
    catchPageDialogs: '捕获页面对话框——会显示 Chrome 调试提示栏',
    catchPageDialogsHelp: '在点击、按键和导航前连接调试器，以便报告 alert/confirm/prompt/离开页面对话框并由代理回应。连接期间 Chrome 会显示“正在调试”提示栏，可能使页面位移。',
    approvalNotifications: '浏览器审批通知',
    approvalNotificationsHelp: '侧栏关闭时收到审批请求，通过系统通知提醒你。简单操作可在通知中直接允许；代码、输入和上传会打开完整审批卡片。',
    approvalTimeout: '侧栏关闭时的审批等待（分钟）',
    approvalTimeoutHelp: '侧栏关闭时，审批请求（通知、dsh 网页端或命令行均可回答）等待多久后自动拒绝。范围 1–14 分钟。',
    autoResumeSession: '续接当前页面会话',
    autoResumeSessionHelp: '重新打开当前标签页此页面的会话；其他页面会新建会话',
    showAgentOverlay: '在页面上显示助手操作',
    showAgentOverlayHelp: '助手操作前用光标和高亮框标出目标，受控标签页显示彩色边框和停止按钮',
    trustedOrigins: '永久免确认域名',
    trustedOriginsHelp: '审批框可只信任本次侧栏会话。这里添加的域名仅在所有已知来源均受信任时免除操作确认。通配符包含主域及其子域，并严格区分协议和端口；`*.example.com` 默认使用 HTTPS。',
    trustedOriginInput: '要永久信任的域名（如 https://example.com 或 https://*.example.com）',
    add: '添加',
    invalidOrigin: '请输入 http://、https:// 来源或 https://*.example.com 形式的通配符。',
    noTrustedOrigins: '尚未信任任何域名。',
    remove: '移除',
    removeOrigin: (origin) => `移除 ${origin}`,
    save: '保存并连接',
    cancel: '取消',
    snapshotHint: (maxChars) => `页面快照上限为 ${maxChars} 字符，超出内容会被截断。可在 dsh 插件中调整 snapshotMaxChars。`,
    relaySection: '模型与中转服务',
    relayHelp: '把助手接到你自己的 API 中转站。每个档案对应一条提供方路由，保存后下一条消息即生效，无需重启。',
    relayName: '档案名称',
    relayNamePlaceholder: '例如 my-relay',
    relayProtocol: '接口格式',
    relayProtocolClaude: 'Claude（Anthropic Messages）',
    relayProtocolOpenai: 'OpenAI（Chat Completions）',
    relayProtocolCodex: 'Codex（OpenAI Responses）',
    relayBaseUrl: '中转地址 Base URL',
    relayToken: '令牌 Token',
    relayTokenPlaceholder: (configured) => configured ? '已保存 — 输入可替换' : '中转站的 API 令牌',
    relayModels: '模型列表',
    relayModelsHelp: '每行一个模型，格式 `模型ID, 上下文窗口` — 如 `claude-sonnet-4-5, 200000`。上下文窗口可省略。',
    relayModelsPlaceholder: 'model-id, 128000',
    relayFetchModels: '获取模型列表',
    relayFetching: '正在获取模型列表…',
    relayFetchOk: (count) => `已从中转站填入 ${count} 个模型。`,
    relayNeedBaseUrl: '请先填写中转地址 Base URL。',
    relayOpenaiListingNote: '（经中转站的 OpenAI 兼容接口列出）',
    relayAdd: '添加档案',
    relayRemove: '删除档案',
    relaySetDefault: '设为默认模型',
    relaySetDefaultHelp: '新会话将默认使用该档案的第一个模型',
    relayTest: '测试连接',
    relayTesting: '测试中…',
    relayTestOk: (count, names) => `连接成功 — ${count} 个模型：${names}`,
    relayTestFailed: (reason) => `连接失败：${reason}`,
    relayTestManualOnly: '该协议不支持在线列出模型，请手动填写模型列表。',
    relaySavedOk: '中转配置已保存。',
    relaySaveFailed: (reason) => `保存失败：${reason}`,
    relayEmpty: '还没有中转档案。',
    relayInvalidName: '请填写档案名称。',
  },
  update: {
    eyebrow: '发布通道',
    title: '软件更新',
    idleTitle: '可以检查新版本',
    idleBody: '与 GitHub main 上的扩展版本进行比较。',
    checking: '正在检查…',
    checkingBody: '正在读取 GitHub 上的最新扩展清单。',
    currentTitle: '未发现更新',
    currentBody: (latestVersion) => `仓库版本：v${latestVersion}。`,
    availableTitle: (latestVersion) => `发现新版本 ${latestVersion}`,
    availableLoadingBody: '正在确认此扩展的安装来源，然后再提供更新命令。',
    availableManagedBody: '复制托管更新命令并在终端运行。',
    availableCheckoutBody: '请先在原 checkout 中 pull 或切换到目标 revision，再重新运行其中的安装脚本。',
    availableUnknownBody: '这个副本没有安装来源记录。请沿用最初的更新方式；这里不会复制可能覆盖来源的命令。',
    reloadReminder: '更新完成后，打开 chrome://extensions，找到“dsh 浏览器助手”，点击卡片上的“重新加载”旋转箭头，然后重启 dsh。',
    loadingInstall: '正在识别安装来源…',
    managedInstall: '托管安装',
    checkoutInstall: '本地 checkout',
    unknownInstall: '安装来源未知',
    errorTitle: '暂时无法检查更新',
    errorBody: '请检查网络连接，然后重试。',
    check: '检查更新',
    copyManagedCommand: '复制更新命令',
    copyCheckoutCommand: '复制 checkout 命令',
    copied: '命令已复制',
    copyError: '无法复制命令，请回到原安装来源重新运行安装脚本。',
  },
  uninstall: {
    title: '卸载 dsh-browser',
    runCommand: '在终端运行以下命令。',
    copyCommand: '复制卸载命令',
    copied: '命令已复制',
    copyError: '复制失败',
  },
  agentControl: {
    pauseAfterStep: '本步后暂停',
    pauseAfterStepHint: '当前浏览器操作完成后，暂停下一步，直到你点击继续',
    takeOver: '接管',
    takeOverHint: '暂停助手，由你直接操作页面；完成后点击继续交还控制',
    resume: '继续',
    resumeHint: '告知助手期间的变化并继续',
    working: '助手正在操作浏览器',
    pausedTitle: '已暂停',
    pausedBody: (held) => held === 0 ? '下一步浏览器操作将等待你继续。' : `有 ${held} 个浏览器操作正在等待。`,
    takenOverTitle: '由你接管',
    takenOverBody: (held) => held === 0 ? '你可以自由操作页面，完成后点击继续。' : `你可以自由操作页面；有 ${held} 个助手操作在等待，完成后点击继续。`,
    resuming: '正在继续…',
  },
  timeline: {
    title: (count) => `${count} 个浏览器步骤`,
    expand: '展开详情',
    collapse: '收起详情',
    arguments: '参数',
    result: '结果',
    screenshot: '截图',
    running: '进行中',
    failed: '失败',
    decisions: {
      'not-required': '自动',
      'auto-allowed': '已信任',
      'program-approved': '程序已批准',
      allowed: '已批准',
      denied: '已拒绝',
      'timed-out': '已超时',
      unavailable: '无法审批',
      cancelled: '已取消',
      'held-expired': '暂停超时',
    },
    policies: {
      blocked: '已被站点策略阻止',
      tainted: '需审核（已受污染）',
      'site-ask': '站点要求确认',
      'strict-armed': '严格模式',
      'strict-refused': '严格模式：已拒绝',
    },
    duration: (ms) => ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`,
  },
  audit: {
    section: '审计日志',
    help: '每次浏览器操作、审批、跳转和结果都会写入本机上防篡改（哈希链）的日志。输入的文字和密钥不会被记录。',
    exportButton: '导出审计日志',
    exporting: '正在导出…',
    exported: (count, verified) => `已导出 ${count} 条记录${verified ? '，哈希链校验通过' : '，哈希链校验失败'}`,
    failed: (message) => `无法导出审计日志：${message}`,
  },
  killSwitch: {
    engage: '停止代理',
    engageHint: '立即停止代理——快捷键 Ctrl+Shift+K（Mac 为 ⌘⇧K，Firefox 为 Alt+Shift+K）',
    title: '代理已停止',
    body: '已取消待确认的请求和正在执行的浏览器操作，撤销会话信任与开发者工具授权，关闭不受限访问，断开调试器，并关闭与 dsh 的连接。',
    reconnect: '重新连接',
  },
  textSize: {
    open: '字号',
    title: '字号',
    smaller: '缩小字号',
    larger: '放大字号',
    reset: '恢复默认',
    value: (percent) => `字号 ${percent}`,
  },
  app: {
    openSettings: '打开设置',
    settings: '设置',
    openSessions: '历史会话',
    sessions: '会话',
    newSession: '新对话',
    sessionPickerLoading: '加载中…',
    sessionPickerEmpty: '暂无历史会话',
    deleteSession: '删除会话',
    deleteSessionConfirm: (title) => `确定删除「${title}」吗？对话历史将被永久移除。`,
    deleteSessionFailed: (reason) => `删除失败：${reason}`,
    deletePurgeFailed: (reason) => `已从列表移除，但文件清理失败（dsh 重启后可能再次出现）：${reason}`,
    emptyTitle: '把当前页面交给我',
    emptyDescription: '我可以阅读页面、查找信息，也可以替你点击、填写和导航。',
    overviewPage: '先概览这个页面',
    overviewPrompt: '请先概览当前页面，告诉我最重要的信息，并等待我的下一步指令。',
    assistant: '助手',
    assistantWorking: '助手正在处理',
    organizingResults: '正在整理结果',
    thinking: '正在思考',
    connectedPlaceholder: '告诉我想在这个页面做什么…',
    disconnectedPlaceholder: '连接 dsh 后即可开始',
    composerHelp: 'Enter 发送 · Shift + Enter 换行',
    sendMessage: '发送消息',
    selectModel: '模型',
    noModelsConfigured: '暂无模型 — Host 尚未提供可用模型。',
    stopTurn: '停止生成',
    continueGeneration: '继续生成',
    stoppingTurn: '正在停止…',
    addImages: '添加图片',
    imageUnavailable: '当前 dsh 宿主未声明图片输入能力',
    removeImage: (name) => `移除 ${name}`,
    image: '图片',
    imageLoading: '加载中…',
    imageLoadFailed: '加载失败 · 重试',
    openImage: '查看原图',
    openNamedImage: (name) => `查看 ${name}`,
    imagePreview: '图片预览',
    closeImage: '关闭图片预览',
    imageUnsupported: (name) => `${name} 不是当前 dsh 宿主支持的图片格式。`,
    imageTooMany: (max) => `每条消息最多可添加 ${max} 张图片。`,
    imageTooLarge: (name, max) => `${name} 超过单张图片 ${max} 的限制。`,
    imageMessageTooLarge: (max) => `本条消息的图片总大小超过 ${max}。`,
    imageDimensionTooLarge: (name, max) => `${name} 的宽或高超过 ${max}px。`,
    imagePixelsTooLarge: (name, max) => `${name} 超过 ${max.toLocaleString()} 像素的限制。`,
    imageDecodeFailed: (name) => `无法将 ${name} 解码为图片。`,
    imageModelUnsupported: '当前模型不支持图片，请切换到支持图片的模型。',
    imageSubagentUnsupported: '子智能体会话暂不支持图片。',
    imageSendFailed: (reason) => `图片发送失败（${reason}）。草稿已恢复，请重试。`,
    selectionChip: '1 处选中内容',
    selectionAttached: '选中的网页内容',
    selectionTruncated: '（已截断）',
    removeSelection: '移除选中内容',
    scrollToBottom: '回到最新消息',
    permissionControl: '权限模式',
    permissionMenu: '权限模式',
    permissionReadOnly: '仅可查看',
    permissionWorkspaceWrite: '工作区内修改',
    permissionFullAccess: '完全权限',
    permissionAuto: 'Auto review',
    permissionCustom: '自定义',
    permissionExperimental: 'EXP',
    permissionPendingHint: '发送第一条消息创建会话时生效',
    permissionDefaultHint: (name) => `新会话默认：${name}`,
    permissionConfirmTitle: (label) => `切换到「${label}」？`,
    permissionConfirmBody: (label, preset) => preset === 'danger-full-access'
      ? `完全权限（${label}）下文件与命令操作不再逐次征求批准。请仅在你信任本对话时继续。`
      : `Auto review 是实验能力：由独立审查者判断每次风险调用。请确认你接受该风险（${label}）。`,
    permissionConfirmAccept: '切换',
    permissionConfirmCancel: '取消',
    permissionSwitchFailed: (reason) => `切换权限模式失败：${reason}`,
    permissionUnavailable: '当前 dsh 宿主未提供权限模式',
    modelUnavailable: '模型列表加载失败',
    modelReasoning: '推理强度',
    modelReasoningDefault: '默认',
    retry: '重试',
    slashMenu: '命令与 Skill',
    slashCommands: '命令',
    slashSkills: 'Skill',
    slashLocal: '面板自带',
    slashUserOnly: '仅用户可调用',
    slashLocalModel: '选择下一轮使用的模型',
    slashEmpty: '没有匹配的命令或 Skill',
    slashProvisional: '发送第一条消息创建会话后可用',
    unknownCommand: (name) => `/${name} 不是命令或 Skill，已阻止发送。若想按普通文本发送，请在行首加一个空格。`,
    commandFailed: (reason) => `命令执行失败：${reason}`,
    commandSucceeded: '命令已执行',
    commandProvisional: '这条命令需要真实会话：请先发送第一条消息',
    commandAttachmentsUnsupported: '命令不支持附件：请先移除图片或选中内容，或把它作为普通消息发送。',
  },
}

export const PANEL_COPY: Record<UiLocale, PanelCopy> = { en: EN, zh: ZH }
