import type { BridgeState } from '../background/bridge.ts'
import type { UiLocale } from '../i18n.ts'
import type { SiteRule } from '../security/site-policy.ts'

export interface PanelCopy {
  documentTitle: string
  status: Record<BridgeState, string>
  /** Status shown when the startup pass found no local dsh at all. */
  statusNotFound: string
  /** Specific refusals reported by the bridge (shown instead of the transport state). */
  bridgeFailure: Record<'token-mismatch' | 'version-mismatch' | 'origin-rejected' | 'busy' | 'no-token' | 'token-unreadable' | 'gave-up', string>
  /** One-step pairing with the DSH host (PairingCard). */
  pairing: {
    title: string
    /** Lead shown when this install has no token yet. */
    needed: string
    /** What pairing is, shown before a request was made. */
    help: string
    start: string
    retry: string
    asking: string
    codeLabel: string
    /** The call to action under the code. */
    enter: string
    enterHelp: string
    paired: string
    /** For an install that already holds a token: the button, what it is for, and the confirmation. */
    again: string
    againHelp: string
    againWarning: string
    againConfirm: string
    cancel: string
    /** One message per `PairingFailure` of the background. */
    failure: Record<'wrong-code' | 'expired' | 'replaced' | 'busy' | 'paused' | 'unreachable' | 'unsupported' | 'version-mismatch' | 'untrusted' | 'cancelled' | 'has-token' | 'auto-limit', string>
  }
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
    readFootnote: string
    actionFootnote: string
    devToolsFootnote: string
    /** Label of the eval-trust checkbox on a console-eval card. */
    trustEval: (origin: string) => string
    /** Label of the developer-tools session trust button. */
    trustDevToolsOrigin: (origin: string) => string
    codeLabel: (characters: number) => string
    typedTextLabel: string
    maskedText: (characters: number) => string
    reveal: string
    hide: string
    pathsLabel: (count: number) => string
    /** Heading of a program series' folded row list. */
    rowsLabel: (count: number) => string
    rowsFirst: string
    rowsLast: string
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
    /** Label of the requester row on an external (MCP) client's card. */
    requestedBy: string
    /** The external client, by its self-reported name. */
    mcpClient: (name: string) => string
    /** A dev-loop read for a linked coding session. */
    devLoop: (session: string) => string
  }
  tool: {
    running: string
    complete: string
    labels: Record<string, string>
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
    token: string
    pageSnapshots: string
    textSizeHelp: string
    reconnect: string
    discard: string
    unsavedChanges: string
    appliesImmediately: string
    learnMore: string
    groups: Record<'access' | 'debugger', string>
    sections: Record<'connection' | 'appearance' | 'permissions' | 'behaviour' | 'automation' | 'models' | 'about', { title: string; help: string }>
    language: string
    languageHelp: string
    languageAuto: string
    languageEnglish: string
    languageChinese: string
    theme: string
    themeHelp: string
    themeAuto: string
    themeLight: string
    themeDark: string
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
    /** Why the browser stays connected (and reconnects) with the panel closed. */
    staysConnected: (standing: { watchers: number; schedules: number; mcp: boolean }) => string
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
    unrestrictedBrowserAccessMore: string
    allowDevTools: string
    allowDevToolsHelp: string
    allowDevToolsMore: string
    devToolsUnsupported: string
    devToolsOff: string
    devToolsIdle: string
    devToolsAttached: string
    devToolsError: string
    devToolsDetach: string
    approvalNotifications: string
    approvalNotificationsHelp: string
    approvalNotificationsMore: string
    approvalTimeout: string
    approvalTimeoutHelp: string
    approvalTimeoutMore: string
    catchPageDialogs: string
    catchPageDialogsHelp: string
    catchPageDialogsMore: string
    autoResumeSession: string
    autoResumeSessionHelp: string
    showAgentOverlay: string
    showAgentOverlayHelp: string
    allowPageWatchers: string
    allowPageWatchersHelp: string
    allowPageWatchersMore: string
    trustedOrigins: string
    trustedOriginsHelp: string
    trustedOriginsMore: string
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
  autoReview: {
    /** Accessible name of the composer control. */
    control: string
    chipAsk: string
    chipAuto: string
    optionAsk: string
    optionAskHelp: string
    optionAuto: string
    optionAutoHelp: string
    /** The unobtrusive indicator while Auto is on. */
    on: (minutesLeft: number) => string
    turnOff: string
    /** Why Auto ended for this conversation. */
    ended: Record<string, string>
    /** Why the control is disabled (one line). */
    unavailable: Record<string, string>
    notStarted: string
    dialogTitle: string
    dialogBody: string[]
    dialogConfirm: string
    dialogCancel: string
    /** The running step while the reviewer decides. */
    reviewing: string
    /** Timeline badge of a step Auto review approved. */
    badge: string
    /** Prefix of the reviewer's reason in a timeline row's details. */
    reasonPrefix: string
    /** The fixed line under a row Auto review approved. */
    approvedLine: string
    /** Other conversations with Auto on (panel line), and its one-click off. */
    otherOn: (count: number) => string
    turnAllOff: string
    settingLabel: string
    settingHelp: string
    settingMore: string
    settingManaged: string
  }
  audit: {
    section: string
    help: string
    more: string
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
  /** Settings → Site policy (security/site-policy.ts). */
  sitePolicy: {
    title: string
    rulesTitle: string
    help: string
    more: string
    builtIn: string
    builtInHelp: (patterns: number) => string
    patternLabel: string
    noRules: string
    invalidPattern: string
    patternPlaceholder: string
    ruleLabel: string
    rules: Record<SiteRule, string>
    add: string
    remove: string
    removeItem: (item: string) => string
    strictTitle: string
    strictHelp: string
    strictMore: string
    strictUnavailable: string
    strictSiteLabel: string
    noStrictSites: string
    managedIntro: string
    managedNoUnrestricted: string
    managedNoDevTools: string
    managedNoScreenshots: string
    managedAllowedOnly: (origins: readonly string[]) => string
    /** The one sentence shown wherever a site is marked trusted (Settings and the banner's "Trust"). */
    trustedNote: string
    exemptLocal: string
    exemptLocalHelp: string
    exemptLocalMore: string
    exemptTrusted: string
    exemptTrustedHelp: string
    exemptTrustedMore: string
    managedNoLocalExemption: string
    managedNoTrustedExemption: string
    /** The user's own local pages (loopback origins). */
    localOriginsLabel: string
    localOriginInput: string
    localOriginInvalid: string
    noLocalOrigins: string
    /** Sites whose pages are not treated as untrusted content (the banner's Trust). */
    taintTrustedLabel: string
    noTaintTrusted: string
    /** Trusted rules and always-allowed origins from before the exemption existed. */
    keepQuestion: (count: number) => string
    keepAll: string
    keepOne: string
  }
  /** Session taint banner (security/taint.ts). */
  taint: {
    /** `sites`: host names, comma-separated (at most three). */
    body: (sites: string) => string
    unknownSource: string
    more: (count: number) => string
    clear: string
    trust: (site: string) => string
    trustMany: string
    /** Around the site name in the confirmation: "Trust <site>?". */
    trustConfirmLead: string
    trustConfirmEnd: string
    /** What trusting does, in the confirmation. */
    trustEffects: string
    confirmTrust: string
    cancel: string
    /** A local page among the sources: "are these yours?". */
    localQuestion: (host: string) => string
    localYes: string
  }
  /** Active page watchers card. */
  watchers: {
    label: string
    title: (count: number) => string
    then: string
    minutesLeft: (minutes: number) => string
    hoursLeft: (hours: number) => string
    lastMiss: (reason: string) => string
    cancel: string
  }
  /** Settings → Dev loop. */
  devLoop: {
    title: string
    help: string
    more: string
    caution: string
    cautionMore: string
    openLocalhost: string
    unlink: string
    noLinks: string
    linkTab: string
    noSessions: string
    sessionLabel: string
    link: string
  }
  /** Learning features: chat-view panel and settings section. */
  learning: {
    label: string
    sensitiveStep: string
    stepsRecorded: (count: number) => string
    saveAsWorkflow: string
    workflowName: string
    description: string
    descriptionPlaceholder: string
    saveHelp: string
    variable: string
    variableName: string
    save: string
    savedTo: (path: string) => string
    clearRecording: string
    savedWorkflows: string
    stepCount: (count: number) => string
    everyMinutesLabel: string
    minutesPlaceholder: string
    scheduleHint: string
    schedule: string
    scheduled: string
    schedules: string
    everyMinutes: (minutes: number) => string
    cancel: string
    scheduleCancelled: string
    watchIdle: string
    watching: (origin: string, events: number) => string
    watchMe: string
    stopWatching: string
    repeated: (times: number) => string
    done: string
    /** `steps`: the run's true total; `more`: rows are left beyond what one run does. */
    doRemaining: (remaining: number, steps?: number, more?: boolean) => string
    /** A long run stopped part-way with `rows` rows left; `skipped` names a row it left part-done. */
    stoppedEarly: (rows: number, skipped?: string) => string
    /** Why an offer stays within one program although more rows exist. */
    rowsIndistinct: string
    continueRemaining: (rows: number) => string
    proposedDriver: string
    parameters: string
    tokenSource: (kind: string, name: string) => string
    dropped: string
    saveDriver: string
    driverSaved: string
    discard: string
    siteDrivers: string
    deleteDriver: string
    exportDrivers: string
    importDrivers: string
    imported: (count: number) => string
    settingsTitle: string
    settingsHelp: string
    settingsMore: string
    workflowsTitle: string
    workflowsHelp: string
    workflowsMore: string
    watchMeTitle: string
    watchMeHelp: string
    watchMeMore: string
    driversTitle: string
    driversHelp: string
    driversUnavailable: string
    driversMore: string
    driverSiteLabel: string
    invalidDriverSite: string
    add: string
    remove: string
    removeItem: (item: string) => string
    fixturesTitle: string
    fixturesHelp: string
    fixturesMore: string
    requestFailed: string
    disconnected: string
  }
  app: {
    openSettings: string
    settings: string
    openSessions: string
    sessions: string
    newSession: string
    /** Shown when a reconnect finds that DSH no longer has the conversation the panel was on. */
    conversationGone: string
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
  documentTitle: 'dsh Browser Agent',
  status: {
    connected: 'Connected',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    stopped: 'Disconnected',
  },
  statusNotFound: 'No service found',
  bridgeFailure: {
    'token-mismatch': 'Token mismatch or untrusted bridge: check that DSH is running, or pair again in Settings',
    'version-mismatch': 'Version mismatch: update the dsh plugin and the extension together',
    'origin-rejected': 'DSH refused this extension: check that DSH is running, or pair again in Settings',
    busy: 'Bridge busy, retrying…',
    'no-token': 'Not paired with DSH yet',
    'token-unreadable': 'The installed bridge token could not be read; retrying',
    'gave-up': 'DSH has not come back for 10 minutes. Start DSH, then choose Detect or Reconnect.',
  },
  pairing: {
    title: 'Pair with DSH',
    needed: 'This browser is not connected to DSH yet.',
    help: 'Connect this browser to the DSH on this computer. It shows a short code that you type into DSH once; there is no token to copy.',
    start: 'Pair with DSH',
    retry: 'Ask again',
    asking: 'Asking DSH…',
    codeLabel: 'Pairing code',
    enter: 'Enter this code in DeepSeek Harness',
    enterHelp: 'DeepSeek Harness now shows "A browser wants to connect". Type the code there and press Enter. The same field is under Settings → General → Pair a browser; in a terminal session, run /browser-pair followed by the code. Type the code only into DeepSeek Harness itself.',
    paired: 'Paired. Connecting…',
    again: 'Pair again…',
    againHelp: 'This browser has been connected to DSH before. If it cannot connect, first check that DSH is running.',
    againWarning: 'Pair again only if you reinstalled DSH or reset its bridge token. If you did neither, do not continue: check that DSH is running, because something else may be answering in its place.',
    againConfirm: 'Pair again',
    cancel: 'Cancel',
    failure: {
      'wrong-code': 'The code entered in DSH was not this one. A code works for one try: ask again for a new code.',
      expired: 'No code was entered in time. Open DSH, then ask again.',
      replaced: 'Another request took this one\'s place: something else on this computer is asking to pair. Ask again, and in DSH enter only the code shown here.',
      'auto-limit': 'Pairing was asked several times without success. Check that DSH is open, then ask again.',
      busy: 'DSH is receiving too many pairing requests. Wait a minute, then ask again.',
      paused: 'Pairing is paused in DSH. Resume it there (Settings → General → Pair a browser, or /browser-pair resume), then ask again.',
      unreachable: 'No DSH was found on this computer. Start DSH, then ask again.',
      unsupported: 'This DSH browser plugin cannot pair (it is too old, or pairing is switched off). Update it, or paste the token instead.',
      'version-mismatch': 'The DSH plugin and this extension are different versions. Update them together.',
      untrusted: 'The other side did not prove that it was given this code, so nothing was saved. Check that DSH itself is running on this computer, then ask again.',
      cancelled: 'Pairing was cancelled.',
      'has-token': 'This browser already holds a DSH token. Use "Pair again…" in Settings only if you reinstalled DSH or reset its token.',
    },
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
    readFootnote: 'Esc to deny · You can disable automatic reading in Settings at any time',
    actionFootnote: 'Esc to deny · Temporary trust ends when the side panel closes · Text for sensitive fields starts masked',
    devToolsFootnote: 'Developer tools expose page internals and captured traffic. Trust covers this conversation on this site for 30 minutes, ends when the tab leaves the site or the side panel closes, and never covers JavaScript or unredacted traffic. Chrome blocks its own DevTools while this runs.',
    trustEval: (origin) => `Trust JavaScript on ${origin} for this conversation (30 min)`,
    trustDevToolsOrigin: (origin) => `Trust developer tools on ${origin} for this conversation (30 min)`,
    codeLabel: (characters) => `JavaScript to run (${characters} characters)`,
    typedTextLabel: 'Text to type',
    maskedText: (characters) => `Masked: ${characters} characters for a sensitive or uninspected field`,
    reveal: 'Reveal',
    hide: 'Hide',
    pathsLabel: (count) => `Local files to attach (${count})`,
    rowsLabel: (count) => `Show all ${count} rows (open a row for its exact steps)`,
    rowsFirst: 'First row:',
    rowsLast: 'Last row:',
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
    requestedBy: 'Requested by',
    mcpClient: (name) => `MCP client “${name}” (name reported by the client)`,
    devLoop: (session) => `Dev loop for the coding session “${session}” (read-only page check after its edit)`,
  },
  tool: {
    running: 'Working on page',
    complete: 'Page action',
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
      browser_run: 'Run step program',
      browser_watch: 'Watch page',
      browser_watches: 'List page watchers',
      browser_fanout: 'Run tabs in parallel',
      browser_fleet_release: 'Release tab fleet',
      browser_workflow_list: 'List workflows',
      browser_workflow_run: 'Run workflow',
    },
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
    eyebrow: 'Browser agent',
    title: 'Settings',
    token: 'Token',
    pageSnapshots: 'Page snapshots',
    textSizeHelp: 'Scales all text in the panel.',
    reconnect: 'Reconnect',
    discard: 'Discard',
    unsavedChanges: 'Unsaved changes',
    appliesImmediately: 'Applies immediately',
    learnMore: 'Learn more',
    groups: { access: 'Access', debugger: 'Debugger' },
    sections: {
      connection: { title: 'Connection', help: 'How this panel reaches dsh on your computer.' },
      appearance: { title: 'Appearance', help: 'Language, colours and text size. Changes apply immediately.' },
      permissions: { title: 'Permissions & safety', help: 'What the assistant may read and do, and on which sites.' },
      behaviour: { title: 'Behaviour', help: 'Approvals, conversations and what you see on the page.' },
      automation: { title: 'Automation', help: 'Page watchers, Auto review, the dev loop and experimental learning features.' },
      models: { title: 'Models & API relay', help: 'Use your own API relay as a model provider.' },
      about: { title: 'About', help: 'Updates, audit log and uninstall.' },
    },
    language: 'Language',
    languageHelp: 'Language of the panel and its notifications.',
    languageAuto: 'Automatic (follow Chrome)',
    languageEnglish: 'English',
    languageChinese: '中文',
    theme: 'Theme',
    themeHelp: 'Automatic follows your browser or system.',
    themeAuto: 'Automatic (follow system)',
    themeLight: 'Light',
    themeDark: 'Dark',
    bridgeAddress: 'Bridge address',
    bridgeHelp: 'Leave blank to find dsh on this computer automatically.',
    bridgePlaceholder: 'Auto-detect',
    detect: 'Detect',
    detectCancel: 'Cancel',
    detectHelp: 'Lists every dsh on this computer, including desktop beacon ports 43189–43198.',
    detectProgress: (done, total) => `Detecting ${done} / ${total} ports…`,
    detectEmpty: 'No service found.',
    detectPick: 'Select an instance to fill in its address.',
    detectCurrent: 'in use',
    detectConnected: (address) => `Connected to ${address}`,
    staysConnected: ({ watchers, schedules, mcp }) => `Stays connected with the panel closed for: ${[
      ...watchers > 0 ? [`${String(watchers)} page watcher${watchers === 1 ? '' : 's'}`] : [],
      ...schedules > 0 ? [`${String(schedules)} workflow schedule${schedules === 1 ? '' : 's'}`] : [],
      ...mcp ? ['MCP clients'] : [],
    ].join(', ')}`,
    detectSource: { fixed: 'fixed port', beacon: 'beacon' },
    tokenHelp: 'Only needed for Firefox and remote deployments.',
    tokenPlaceholder: 'Paste the bridge token',
    pageSharing: 'Page content sharing',
    pageSharingHelp: 'When the assistant may read the text of a page.',
    sharingAuto: 'Automatic (default)',
    sharingAsk: 'Ask every time',
    sharingOff: 'Off',
    unrestrictedBrowserAccess: 'Allow unrestricted browser control',
    unrestrictedBrowserAccessHelp: 'Reads and acts on every site without asking, except sites your site rules restrict.',
    unrestrictedBrowserAccessMore: 'Trust every site except those your site policy restricts: the model reads pages, inspects open tab titles and URLs, and acts—including following and closing tabs—without confirmation. Blocked, read-only, and always-ask sites (including the built-in protections), untrusted-content safeguards, and managed policy still apply. Browser-protected page content remains inaccessible.',
    allowDevTools: 'Allow developer tools',
    allowDevToolsHelp: 'High privilege: inspect and change pages, run JavaScript, read network requests. Turns itself off after 8 hours.',
    allowDevToolsMore: 'High privilege: lets the model inspect and modify page elements and CSS, run JavaScript in the page, and read captured network requests. Off by default, where every call asks for approval. When on, it applies to every site and turns itself off after 8 hours. Running JavaScript still asks on every call unless you tick "Trust JavaScript on this site for this conversation" on its card, which lasts 30 minutes; reading unredacted headers or bodies always asks. Chrome cannot keep its own DevTools open on a tab while this is attached.',
    devToolsUnsupported: 'Unavailable — this browser does not provide the debugger API.',
    devToolsOff: 'Off — every call asks for approval.',
    devToolsIdle: 'Enabled — the debugger attaches on the first call. JavaScript still asks each time.',
    devToolsAttached: 'Debugger attached',
    devToolsError: 'Last error:',
    devToolsDetach: 'Detach now',
    catchPageDialogs: 'Catch page dialogs',
    catchPageDialogsHelp: 'Lets the agent see and answer alert and confirm dialogs. Shows Chrome\'s debugging bar.',
    catchPageDialogsMore: 'Attach the debugger before clicks, key presses, and navigation so alert/confirm/prompt/leave-site dialogs are reported and the agent can answer them. While attached, Chrome shows a "being debugged" bar that can shift the page.',
    approvalNotifications: 'Browser approval notifications',
    approvalNotificationsHelp: 'Notifies you when an approval arrives while the side panel is closed.',
    approvalNotificationsMore: 'Simple actions can be allowed from the notification; code, typing, and uploads open the full card.',
    approvalTimeout: 'Approval wait with the panel closed',
    approvalTimeoutHelp: 'Minutes an unanswered approval waits before it is denied (1–14).',
    approvalTimeoutMore: 'How long an approval waits for an answer while the side panel is closed — from a notification, the dsh web UI, or the CLI — before it is denied. 1–14 minutes.',
    autoResumeSession: "Resume this page's conversation",
    autoResumeSessionHelp: 'Reopens the conversation for this tab and page. Other pages start a new one.',
    showAgentOverlay: 'Show the agent on the page',
    showAgentOverlayHelp: 'Marks each target before the agent acts. Controlled tabs get a coloured frame and a Stop button.',
    allowPageWatchers: 'Allow the agent to watch pages',
    allowPageWatchersHelp: 'The agent may ask to keep watching a page. Each watcher needs your approval.',
    allowPageWatchersMore: 'A watcher wakes the agent when something on the page changes. Turning this off cancels every watcher.',
    trustedOrigins: 'Always-allowed domains',
    trustedOriginsHelp: 'Actions on these domains never ask for confirmation.',
    trustedOriginsMore: 'The approval dialog can trust a domain for the current side-panel session only. Domains added here permanently skip action confirmation when every known origin is trusted. Wildcards include the base domain and subdomains, and stay scoped to their scheme and port; `*.example.com` defaults to HTTPS.',
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
    relayHelp: 'Each profile becomes one provider route. Saved changes take effect on the next message, without a restart. Removing a saved profile applies immediately.',
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
    idleBody: 'Compare this build with the latest GitHub release.',
    checking: 'Checking…',
    checkingBody: 'Reading the latest release tag from GitHub.',
    currentTitle: 'No update found',
    currentBody: (latestVersion) => `Latest release: v${latestVersion}.`,
    availableTitle: (latestVersion) => `Version ${latestVersion} is available`,
    availableLoadingBody: 'Confirming how this extension was installed before offering an update command.',
    availableManagedBody: 'Copy the update command and run it in Terminal. It installs exactly this release and verifies its checksums first.',
    availableCheckoutBody: 'Pull or switch to the revision you want in the original checkout, then rerun its installer.',
    availableUnknownBody: 'This copy predates install-source metadata. Use the same update flow you originally installed with; no command will be copied.',
    reloadReminder: 'After updating, open chrome://extensions, find “dsh Browser Agent,” click the rotating-arrow Reload button on its card, then restart dsh.',
    loadingInstall: 'Identifying install…',
    managedInstall: 'Managed install',
    checkoutInstall: 'Local checkout',
    unknownInstall: 'Install source unknown',
    errorTitle: 'Could not check for updates',
    errorBody: 'Check your network connection and try again. The check also fails while no public release exists.',
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
      'auto-reviewed': 'Auto review',
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
  autoReview: {
    control: 'Approvals',
    chipAsk: 'Approvals: Ask',
    chipAuto: 'Approvals: Auto',
    optionAsk: 'Ask',
    optionAskHelp: 'You answer every approval card.',
    optionAuto: 'Auto review',
    optionAutoHelp: 'Approves an action only when you named it, or it is plainly harmless; this conversation\'s model checks it fits.',
    on: (minutes) => `Auto review on · ${minutes} min left`,
    turnOff: 'Turn off',
    ended: {
      expired: 'Auto review ended after 60 minutes. Turn it on again to continue.',
      'kill-switch': 'Auto review ended when you stopped the agent.',
      'take-over': 'Auto review ended when you took over.',
      managed: 'Auto review was turned off by your administrator.',
      setting: 'Auto review is turned off in Settings.',
    },
    unavailable: {
      setting: 'Turned off in Settings.',
      managed: 'Turned off by your administrator.',
      'kill-switch': 'Not available while the agent is stopped.',
      disconnected: 'Not connected to DSH.',
      bridge: 'Update the DSH browser bridge to use Auto review.',
      'host-unsupported': 'This DSH version cannot run Auto review.',
      'no-model': 'Choose a model for this conversation first.',
      'external-session': 'Not available for conversations from other apps.',
      disabled: 'Turned off in the DSH browser bridge configuration.',
    },
    notStarted: 'Takes effect once this conversation has started.',
    dialogTitle: 'Turn on Auto review for this conversation?',
    dialogBody: [
      'Auto approves an action only when you named it, or it is plainly harmless. Named: your latest message contains the button\'s or option\'s full name ("click Save settings") or the exact text to type. Plainly harmless: a same-site link, "Show more"-style controls, hovering, moving around in a text field.',
      'This conversation\'s model then checks the action fits your request and can always ask you instead. Anything else shows the usual card, with a line saying what to write next time. Words like "only read", "don\'t", "tell me if" or "draft" in your message stop it. Payments, purchases, security and account settings always ask, as do the cards that protect your data (sensitive fields, other sites, uploads, the clipboard, developer tools, site rules).',
      'On the current site an approved action can do what your own click could do, and a page can give a harmful control the name you used. Each reviewed action makes one extra call to this conversation\'s model through DSH (your account and quota), sending your messages from this panel, the action, the element\'s label and the page address.',
      'Auto review pauses while this conversation is not shown in a panel, ends after 60 minutes, when you stop the agent or take over, and asks before continuing after 25 approvals since your last message.',
    ],
    dialogConfirm: 'Turn on Auto review',
    dialogCancel: 'Keep asking',
    reviewing: 'Reviewing…',
    badge: 'Auto',
    reasonPrefix: 'Auto review\'s note (model text)',
    approvedLine: 'Approved by Auto review',
    otherOn: (count) => `Auto review is on in ${count} other conversation${count === 1 ? '' : 's'}.`,
    turnAllOff: 'Turn all off',
    settingLabel: 'Offer Auto review',
    settingHelp: 'Shows "Approvals: Auto" next to the composer. Every conversation still starts with Ask.',
    settingMore: 'With Auto review on in a conversation (and that conversation open in a panel), its own model approves small page actions that fit your request; sending, saving, deleting, sharing and unclear buttons run only when your latest message asks for them. Each reviewed action costs one extra model call and sends your messages from the panel, the action, the element\'s label and the page address to that model. Protective cards always ask.',
    settingManaged: 'Your administrator turned Auto review off.',
  },
  audit: {
    section: 'Audit log',
    help: 'Browser actions and approvals are kept in a tamper-evident log on this computer.',
    more: 'Every browser action, approval, navigation, and result is written to a tamper-evident (hash-chained) log on this computer. Typed text and secrets are never stored.',
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
  sitePolicy: {
    title: 'Site policy',
    rulesTitle: 'Site rules',
    help: 'Rules for specific sites. They apply before every other setting.',
    more: '"Unrestricted access" trusts every site except these. Patterns: example.com (and subdomains), *bank*, github.com/settings.',
    builtIn: 'Built-in protections',
    builtInHelp: (patterns) => `Banking and payment, password vaults, account pages, and cloud consoles are read-only (${String(patterns)} patterns).`,
    patternLabel: 'Site pattern',
    noRules: 'No site rules yet.',
    invalidPattern: 'Enter a site such as example.com, *bank* or github.com/settings.',
    patternPlaceholder: 'example.com or *.bank.com',
    ruleLabel: 'Rule',
    rules: { blocked: 'Blocked (no reads)', 'read-only': 'Read-only', ask: 'Always ask', trusted: 'Trusted' },
    add: 'Add',
    remove: 'Remove',
    removeItem: (item) => `Remove ${item}`,
    strictTitle: 'Strict mode (commit gate)',
    strictHelp: 'On these sites, form submissions and write requests during an agent action wait for your approval.',
    strictMore: 'On these sites, every POST/PUT/PATCH/DELETE or form submission the page sends during an agent action waits for your approval, with the fields shown (sensitive ones masked). It attaches the debugger, so Chrome shows its debugging bar. WebSocket messages and sendBeacon cannot be intercepted.',
    strictUnavailable: 'Unavailable in this browser: strict mode needs the Chrome debugger.',
    strictSiteLabel: 'Strict mode site',
    noStrictSites: 'No strict-mode sites yet.',
    managedIntro: 'Managed by your administrator (overrides the settings above):',
    managedNoUnrestricted: 'Unrestricted access is disabled.',
    managedNoDevTools: 'Developer tools are disabled.',
    managedNoScreenshots: 'Screenshots are disabled.',
    managedAllowedOnly: (origins) => `Only these sites are allowed: ${origins.join(', ') || '(none)'}`,
    trustedNote: 'Pages from trusted sites are not treated as untrusted content.',
    exemptLocal: 'Don\'t restrict sessions that only read local pages',
    exemptLocalHelp: 'Your own pages on this computer (localhost, 127.0.0.1) are not treated as untrusted content.',
    exemptLocalMore: 'Only the local addresses listed here count: ones you linked for the dev loop, confirmed on the banner, or added below. A conversation that reads anything else is restricted as usual, and sending data to a local address then still asks. A local page that shows content you did not write (a mail or feed reader, a proxy) can still carry instructions aimed at the agent.',
    exemptTrusted: 'Don\'t restrict sessions that only read sites I trust',
    exemptTrustedHelp: 'Pages from sites you trust (https only) are not treated as untrusted content.',
    exemptTrustedMore: 'Counts: the sites listed here (added with "Trust" on the banner), sites with a Trusted rule, and always-allowed domains, unless a stricter rule covers the site. A trusted site that shows other people\'s content (comments, tickets, mail) can still carry instructions aimed at the agent. Sending data to a trusted site from a restricted conversation still asks.',
    managedNoLocalExemption: 'Local pages restrict a session like any other page.',
    managedNoTrustedExemption: 'Trusted sites restrict a session like any other page.',
    localOriginsLabel: 'My local pages',
    localOriginInput: 'Local address',
    localOriginInvalid: 'Enter a local address such as http://localhost:3000',
    noLocalOrigins: 'No local pages yet.',
    taintTrustedLabel: 'Sites not treated as untrusted content',
    noTaintTrusted: 'None yet. Use "Trust" on the banner when a conversation is restricted.',
    keepQuestion: (count) => `${String(count)} site${count === 1 ? '' : 's'} you trusted earlier will no longer restrict conversations. Keep?`,
    keepAll: 'Keep all',
    keepOne: 'Keep',
  },
  taint: {
    body: (sites) => `This conversation read web pages that could contain instructions (${sites}), so risky actions ask first and shell and file tools are off.`,
    unknownSource: 'an unknown origin',
    more: (count) => `+${String(count)} more`,
    clear: 'Clear',
    trust: (site) => `Trust ${site}`,
    trustMany: 'Trust these sites…',
    trustConfirmLead: 'Trust ',
    trustConfirmEnd: '?',
    trustEffects: 'Pages from this site and its subdomains (https) will no longer restrict conversations. This conversation gets its shell and file tools back once every site it read is trusted. Approval cards for actions on the site do not change.',
    confirmTrust: 'Trust',
    cancel: 'Cancel',
    localQuestion: (host) => `Treat pages from ${host} as yours?`,
    localYes: 'Yes, they are mine',
  },
  watchers: {
    label: 'Page watchers',
    title: (count) => `Watching ${String(count)} page${count === 1 ? '' : 's'}`,
    then: 'Then: ',
    minutesLeft: (minutes) => `${String(minutes)} min left`,
    hoursLeft: (hours) => `${String(hours)} h left`,
    lastMiss: (reason) => ` · last wake missed (${reason})`,
    cancel: 'Cancel',
  },
  devLoop: {
    title: 'Dev loop',
    help: 'Link a localhost tab to a DSH coding session so it sees console errors and failed requests.',
    more: 'Link a localhost tab to a DSH coding session. After each turn in which that session edits files, it receives this tab\'s new console errors, failed requests and page changes as read-only context. It can never be prompted from here.',
    caution: 'If your local app renders untrusted data, that text can reach the coding session.',
    cautionMore: 'User content and scraped or proxied pages count as untrusted data. Set devLoop.trustLoopback: false in the bridge config to treat such injections as untrusted web content (the session then becomes read-only until you clear it).',
    openLocalhost: 'Open the localhost page (localhost, 127.0.0.1 or [::1]) in this window first.',
    unlink: 'Unlink',
    noLinks: 'No tab is linked.',
    linkTab: 'Link this tab to a coding session…',
    noSessions: 'No DSH coding session found. Start one in DSH (Desktop or CLI) first.',
    sessionLabel: 'Coding session',
    link: 'Link',
  },
  learning: {
    label: 'Learning',
    sensitiveStep: '(asked at replay, never stored)',
    stepsRecorded: (count) => `${String(count)} step(s) recorded in this conversation`,
    saveAsWorkflow: 'Save as workflow',
    workflowName: 'Workflow name',
    description: 'Description',
    descriptionPlaceholder: 'What it does (optional)',
    saveHelp: 'Untick steps to leave out. Tick "variable" on a typed value to make it a parameter (its current value becomes the default). Only runs recorded with the setting on can be saved.',
    variable: 'variable',
    variableName: 'Variable name',
    save: 'Save',
    savedTo: (path) => `Saved to ${path}`,
    clearRecording: 'Clear recording',
    savedWorkflows: 'Saved workflows',
    stepCount: (count) => `${String(count)} steps`,
    everyMinutesLabel: 'Every N minutes',
    minutesPlaceholder: 'min',
    scheduleHint: 'Runs in this conversation; at least every minute. Approval cards still ask, and fail closed when nobody answers.',
    schedule: 'Schedule',
    scheduled: 'Scheduled.',
    schedules: 'Schedules',
    everyMinutes: (minutes) => `every ${String(minutes)} min`,
    cancel: 'Cancel',
    scheduleCancelled: 'Schedule cancelled.',
    watchIdle: 'Show me once or twice; I\'ll offer to do the rest.',
    watching: (origin, events) => `Watching ${origin} · ${String(events)} input(s)`,
    watchMe: 'Watch me',
    stopWatching: 'Stop watching',
    repeated: (times) => `You did this ${String(times)} times:`,
    done: 'Done.',
    doRemaining: (remaining, steps, more) => more === true
      ? `Do the next ${String(remaining)} like this (${String(steps ?? remaining)} steps, the most one run does)`
      : steps !== undefined && steps > remaining
      ? `Do the remaining ${String(remaining)} like this (${String(steps)} steps)`
      : `Do the remaining ${String(remaining)} like this`,
    stoppedEarly: (rows, skipped) => `${rows > 0 ? `The run stopped with ${String(rows)} rows left.` : 'The run stopped.'}${skipped === undefined ? '' : ` “${skipped}” was left part-done and is skipped; do it by hand.`}${rows > 0 ? ' Continuing looks at the page as it is now and asks you again.' : ''}`,
    rowsIndistinct: 'These rows can\'t be told apart, so only 25 steps at a time.',
    continueRemaining: (rows) => `Continue with the ${String(rows)} rows left`,
    proposedDriver: 'Proposed site driver',
    parameters: 'Parameters',
    tokenSource: (kind, name) => `read from page ${kind} "${name}" each time (never stored)`,
    dropped: 'Dropped (no page source)',
    saveDriver: 'Save driver',
    driverSaved: 'Driver saved.',
    discard: 'Discard',
    siteDrivers: 'Site drivers',
    deleteDriver: 'Delete',
    exportDrivers: 'Export drivers',
    importDrivers: 'Import…',
    imported: (count) => `Imported ${String(count)} driver(s).`,
    settingsTitle: 'Learning (experimental)',
    settingsHelp: 'Off by default. Records what happens in the browser so it can be repeated.',
    settingsMore: 'Every replayed action still goes through site rules, the pause and kill switches, and approval cards.',
    workflowsTitle: 'Record runs for "Save as workflow"',
    workflowsHelp: 'Keeps the agent\'s successful steps so a run can be saved as a workflow.',
    workflowsMore: 'Keeps the agent\'s successful steps in memory with how to find each element again (role, name, text, CSS). Values typed into password or other sensitive fields are never recorded. Saved workflows are JSON files in the session workspace and become skills; they can be replayed or scheduled.',
    watchMeTitle: 'Watch me',
    watchMeHelp: 'Adds a "Watch me" button that records your own clicks and typing so the agent can repeat them.',
    watchMeMore: 'Shows a "Watch me" button. While it is on, your own clicks and typing on the current tab are recorded (passwords never; sensitive fields masked) to offer "Do the remaining N like this" after you repeat something twice.',
    driversTitle: 'Site drivers',
    driversHelp: 'Learns the request behind an agent action on sites you list and proposes a reusable tool.',
    driversUnavailable: 'Unavailable in this browser: site drivers need the Chrome debugger.',
    driversMore: 'For the sites listed below, learns the same-origin request behind an agent action (needs developer tools allowed, so network capture runs) and proposes a reusable tool. Nothing is saved until you approve it; secrets and cookies are never stored. Every use shows the exact request on an approval card.',
    driverSiteLabel: 'Site for drivers',
    invalidDriverSite: 'Enter a site address such as https://shop.example.com.',
    add: 'Add',
    remove: 'Remove',
    removeItem: (item) => `Remove ${item}`,
    fixturesTitle: 'Save failures as test fixtures',
    fixturesHelp: 'When a step fails, saves the page and the intended action in the session workspace.',
    fixturesMore: 'When a step fails (element not found, page guard, failed after a retry, other errors), saves the page and the intended action under browser-fixtures/ in the session workspace. Denied, timed-out and cancelled steps and blocked sites are never captured. Sensitive field values are masked; a full MHTML copy is used only for pages without sensitive fields and if you grant the page-capture permission.',
    requestFailed: 'The request failed.',
    disconnected: 'Lost the connection to the extension. Try again.',
  },
  app: {
    openSettings: 'Open settings',
    settings: 'Settings',
    openSessions: 'Session history',
    sessions: 'Sessions',
    newSession: 'New chat',
    conversationGone: 'DSH no longer has the previous conversation (it may have been restarted or reset), so a new chat was started.',
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
    'token-mismatch': '令牌不匹配或桥接不可信：请确认 DSH 正在运行，或在设置中重新配对',
    'version-mismatch': '版本不匹配：请同时更新 dsh 插件和扩展',
    'origin-rejected': 'DSH 拒绝了此扩展：请确认 DSH 正在运行，或在设置中重新配对',
    busy: '桥接繁忙，正在重试…',
    'no-token': '尚未与 DSH 配对',
    'token-unreadable': '无法读取已安装的桥接令牌，正在重试',
    'gave-up': 'DSH 已有 10 分钟没有恢复。请启动 DSH，然后选择“自动检测”或“重新连接”。',
  },
  pairing: {
    title: '与 DSH 配对',
    needed: '此浏览器尚未连接到 DSH。',
    help: '将此浏览器连接到本机的 DSH。这里会显示一个简短的配对码，只需在 DSH 中输入一次，无需复制令牌。',
    start: '与 DSH 配对',
    retry: '重新请求',
    asking: '正在请求 DSH…',
    codeLabel: '配对码',
    enter: '请在 DeepSeek Harness 中输入此配对码',
    enterHelp: 'DeepSeek Harness 此时会显示「有浏览器请求连接」。在那里输入配对码并按回车。同样的输入框也在 设置 → 通用 → 配对浏览器 中；在终端会话中，可运行 /browser-pair 加上配对码。配对码只能输入到 DeepSeek Harness 本身。',
    paired: '配对成功，正在连接…',
    again: '重新配对…',
    againHelp: '此浏览器之前已连接过 DSH。如果无法连接，请先确认 DSH 正在运行。',
    againWarning: '仅当你重新安装了 DSH 或重置了它的桥接令牌时才需要重新配对。如果都没有，请不要继续：请确认 DSH 正在运行，因为可能有其他程序在冒充它应答。',
    againConfirm: '重新配对',
    cancel: '取消',
    failure: {
      'wrong-code': '在 DSH 中输入的不是这个配对码。一个配对码只能尝试一次：请重新请求以获取新的配对码。',
      expired: '未在有效时间内输入配对码。请打开 DSH 后重新请求。',
      replaced: '另一个请求占用了此请求的位置：本机上有其他程序在请求配对。请重新请求，并且只在 DSH 中输入这里显示的配对码。',
      'auto-limit': '已多次自动请求配对但未成功。请确认 DSH 已打开，然后重新请求。',
      busy: 'DSH 收到的配对请求过多。请等待一分钟后重新请求。',
      paused: 'DSH 中的配对已暂停。请在那里恢复（设置 → 通用 → 配对浏览器，或 /browser-pair resume），然后重新请求。',
      unreachable: '未在本机找到 DSH。请启动 DSH 后重新请求。',
      unsupported: '此 DSH 浏览器插件无法配对（版本过旧或已关闭配对）。请更新插件，或改为粘贴令牌。',
      'version-mismatch': 'DSH 插件与此扩展的版本不一致，请同时更新两者。',
      untrusted: '对方未能证明它收到了这个配对码，因此未保存任何内容。请确认本机上运行的确实是 DSH，然后重新请求。',
      cancelled: '配对已取消。',
      'has-token': '此浏览器已持有 DSH 令牌。仅当你重新安装了 DSH 或重置了令牌时，才在设置中使用「重新配对…」。',
    },
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
    readFootnote: 'Esc 拒绝 · 可随时在设置中关闭自动读取',
    actionFootnote: 'Esc 拒绝 · 关闭侧栏后临时信任失效 · 敏感字段的输入内容默认遮盖',
    devToolsFootnote: '开发者工具会暴露页面内部结构与抓包内容。信任仅覆盖本对话在此站点上的调用，30 分钟后、标签页离开该站点或侧栏关闭时失效，且从不覆盖 JavaScript 执行与不脱敏的抓包内容。附加期间 Chrome 自身无法在该标签页打开开发者工具。',
    trustEval: (origin) => `本对话中信任在 ${origin} 上执行 JavaScript（30 分钟）`,
    trustDevToolsOrigin: (origin) => `本对话中信任 ${origin} 上的开发者工具（30 分钟）`,
    codeLabel: (characters) => `将执行的 JavaScript（${characters} 个字符）`,
    typedTextLabel: '将输入的文本',
    maskedText: (characters) => `已遮盖：${characters} 个字符（敏感字段或未能检查的字段）`,
    reveal: '显示',
    hide: '隐藏',
    pathsLabel: (count) => `将附加的本地文件（${count} 个）`,
    rowsLabel: (count) => `显示全部 ${count} 行（展开某一行可查看具体步骤）`,
    rowsFirst: '第一行：',
    rowsLast: '最后一行：',
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
    requestedBy: '请求方',
    mcpClient: (name) => `MCP 客户端“${name}”（名称由客户端自报）`,
    devLoop: (session) => `编码会话“${session}”的开发闭环（编辑后对页面的只读检查）`,
  },
  tool: {
    running: '正在操作页面',
    complete: '页面操作',
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
      browser_run: '运行步骤程序',
      browser_watch: '监视页面',
      browser_watches: '列出页面监视',
      browser_fanout: '并行运行多个标签页',
      browser_fleet_release: '释放标签页组',
      browser_workflow_list: '列出工作流',
      browser_workflow_run: '运行工作流',
    },
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
    token: '令牌 Token',
    pageSnapshots: '页面快照',
    textSizeHelp: '缩放侧栏中的所有文字。',
    reconnect: '重新连接',
    discard: '放弃更改',
    unsavedChanges: '有未保存的更改',
    appliesImmediately: '立即生效',
    learnMore: '了解详情',
    groups: { access: '访问', debugger: '调试器' },
    sections: {
      connection: { title: '连接', help: '侧栏如何连接本机的 dsh。' },
      appearance: { title: '外观', help: '语言、配色和字号。更改立即生效。' },
      permissions: { title: '权限与安全', help: '助手可以读取和操作什么，以及在哪些站点上。' },
      behaviour: { title: '行为', help: '审批、会话以及页面上的显示。' },
      automation: { title: '自动化', help: '页面监视、自动审核、开发闭环和实验性的学习功能。' },
      models: { title: '模型与中转服务', help: '把你自己的 API 中转站用作模型提供方。' },
      about: { title: '关于', help: '更新、审计日志和卸载。' },
    },
    language: '界面语言',
    languageHelp: '助手侧栏与通知所用的语言。',
    languageAuto: '自动（跟随 Chrome）',
    languageEnglish: 'English',
    languageChinese: '中文',
    theme: '外观主题',
    themeHelp: '“自动”会跟随浏览器或系统设置。',
    themeAuto: '自动（跟随系统）',
    themeLight: '浅色',
    themeDark: '深色',
    bridgeAddress: '桥地址',
    bridgeHelp: '留空则自动查找本机的 dsh。',
    bridgePlaceholder: '自动检测',
    detect: '自动检测',
    detectCancel: '取消',
    detectHelp: '列出本机所有 dsh 实例，包括桌面版信标端口 43189–43198。',
    detectProgress: (done, total) => `正在探测 ${done} / ${total} 个端口…`,
    detectEmpty: '未找到服务。',
    detectPick: '点击实例即可填入它的地址。',
    detectCurrent: '当前使用',
    detectConnected: (address) => `已连接：${address}`,
    staysConnected: ({ watchers, schedules, mcp }) => `面板关闭后仍保持连接：${[
      ...watchers > 0 ? [`${String(watchers)} 个页面监视`] : [],
      ...schedules > 0 ? [`${String(schedules)} 个定时工作流`] : [],
      ...mcp ? ['MCP 客户端'] : [],
    ].join('、')}`,
    detectSource: { fixed: '固定端口', beacon: '信标' },
    tokenHelp: '仅 Firefox 和远程部署需要填写。',
    tokenPlaceholder: '粘贴桥令牌',
    pageSharing: '页面内容共享',
    pageSharingHelp: '助手何时可以读取页面文字。',
    sharingAuto: '自动共享（默认）',
    sharingAsk: '每次询问',
    sharingOff: '关闭',
    unrestrictedBrowserAccess: '允许模型完全控制浏览器',
    unrestrictedBrowserAccessHelp: '无需确认即可读取并操作所有站点，站点规则限制的站点除外。',
    unrestrictedBrowserAccessMore: '信任除站点策略限制之外的所有站点：模型无需确认即可读取页面、查看已打开标签页的标题和链接，并执行包括跟随、关闭标签页在内的操作。被禁止、只读和每次询问的站点（包括内置保护）、不受信任内容防护以及管理员策略仍然生效。浏览器受保护页面的内容仍不可访问。',
    allowDevTools: '允许开发者工具',
    allowDevToolsHelp: '高权限：查看并修改页面、执行 JavaScript、读取网络请求。8 小时后自动关闭。',
    allowDevToolsMore: '高权限功能：允许模型查看并修改页面元素与 CSS、在页面中执行 JavaScript、读取已捕获的网络请求。默认关闭，关闭时每次调用都会弹出审批。开启后对所有站点生效，8 小时后自动关闭。执行 JavaScript 仍会每次确认，除非您在审批卡上勾选“本对话中信任在该站点上执行 JavaScript”（有效 30 分钟）；读取不脱敏的请求头或正文始终需要确认。附加调试器期间，Chrome 无法在同一标签页打开自带的开发者工具。',
    devToolsUnsupported: '不可用 —— 当前浏览器未提供调试器 API。',
    devToolsOff: '已关闭 —— 每次调用都会请求审批。',
    devToolsIdle: '已开启 —— 首次调用时附加调试器；执行 JavaScript 仍需逐次确认。',
    devToolsAttached: '调试器已附加',
    devToolsError: '最近一次错误：',
    devToolsDetach: '立即断开',
    catchPageDialogs: '捕获页面对话框',
    catchPageDialogsHelp: '让代理看到并回应 alert、confirm 等对话框。会显示 Chrome 调试提示栏。',
    catchPageDialogsMore: '在点击、按键和导航前连接调试器，以便报告 alert/confirm/prompt/离开页面对话框并由代理回应。连接期间 Chrome 会显示“正在调试”提示栏，可能使页面位移。',
    approvalNotifications: '浏览器审批通知',
    approvalNotificationsHelp: '侧栏关闭时收到审批请求，通过系统通知提醒你。',
    approvalNotificationsMore: '简单操作可在通知中直接允许；代码、输入和上传会打开完整审批卡片。',
    approvalTimeout: '侧栏关闭时的审批等待',
    approvalTimeoutHelp: '审批请求无人回答时，等待多少分钟后自动拒绝（1–14）。',
    approvalTimeoutMore: '侧栏关闭时，审批请求（通知、dsh 网页端或命令行均可回答）等待多久后自动拒绝。范围 1–14 分钟。',
    autoResumeSession: '续接当前页面会话',
    autoResumeSessionHelp: '重新打开此标签页当前页面的会话；其他页面会新建会话。',
    showAgentOverlay: '在页面上显示助手操作',
    showAgentOverlayHelp: '助手操作前标出目标；受控标签页显示彩色边框和停止按钮。',
    allowPageWatchers: '允许助手监视页面',
    allowPageWatchersHelp: '助手可以请求持续监视页面。每个监视都需要您批准。',
    allowPageWatchersMore: '页面变化时，监视会唤醒助手。关闭此项会取消全部监视。',
    trustedOrigins: '永久免确认域名',
    trustedOriginsHelp: '这些域名上的操作不再请求确认。',
    trustedOriginsMore: '审批框可只信任本次侧栏会话。这里添加的域名仅在所有已知来源均受信任时免除操作确认。通配符包含主域及其子域，并严格区分协议和端口；`*.example.com` 默认使用 HTTPS。',
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
    relayHelp: '每个档案对应一条提供方路由。保存后下一条消息即生效，无需重启。删除已保存的档案会立即生效。',
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
    idleBody: '与 GitHub 上的最新发布版本进行比较。',
    checking: '正在检查…',
    checkingBody: '正在读取 GitHub 上的最新发布版本号。',
    currentTitle: '未发现更新',
    currentBody: (latestVersion) => `最新发布版本：v${latestVersion}。`,
    availableTitle: (latestVersion) => `发现新版本 ${latestVersion}`,
    availableLoadingBody: '正在确认此扩展的安装来源，然后再提供更新命令。',
    availableManagedBody: '复制更新命令并在终端运行。它只安装这一发布版本，并会先校验校验和。',
    availableCheckoutBody: '请先在原 checkout 中 pull 或切换到目标 revision，再重新运行其中的安装脚本。',
    availableUnknownBody: '这个副本没有安装来源记录。请沿用最初的更新方式；这里不会复制可能覆盖来源的命令。',
    reloadReminder: '更新完成后，打开 chrome://extensions，找到“dsh 浏览器助手”，点击卡片上的“重新加载”旋转箭头，然后重启 dsh。',
    loadingInstall: '正在识别安装来源…',
    managedInstall: '托管安装',
    checkoutInstall: '本地 checkout',
    unknownInstall: '安装来源未知',
    errorTitle: '暂时无法检查更新',
    errorBody: '请检查网络连接，然后重试。尚无公开发布版本时检查也会失败。',
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
      'auto-reviewed': '自动审核',
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
  autoReview: {
    control: '审批方式',
    chipAsk: '审批：询问',
    chipAuto: '审批：自动',
    optionAsk: '询问',
    optionAskHelp: '每个审批卡片都由您决定。',
    optionAuto: '自动审核',
    optionAutoHelp: '只批准您点名的操作或明显无害的操作；本对话的模型会检查它是否符合您的请求。',
    on: (minutes) => `自动审核已开启 · 剩余 ${minutes} 分钟`,
    turnOff: '关闭',
    ended: {
      expired: '自动审核已在 60 分钟后结束。如需继续，请重新开启。',
      'kill-switch': '您停止了代理，自动审核已结束。',
      'take-over': '您接管了页面，自动审核已结束。',
      managed: '管理员已关闭自动审核。',
      setting: '自动审核已在设置中关闭。',
    },
    unavailable: {
      setting: '已在设置中关闭。',
      managed: '已被管理员关闭。',
      'kill-switch': '代理已停止，暂不可用。',
      disconnected: '未连接到 DSH。',
      bridge: '请更新 DSH 浏览器桥接插件以使用自动审核。',
      'host-unsupported': '此 DSH 版本无法运行自动审核。',
      'no-model': '请先为本对话选择模型。',
      'external-session': '来自其他应用的对话不可用。',
      disabled: '已在 DSH 浏览器桥接配置中关闭。',
    },
    notStarted: '对话开始后生效。',
    dialogTitle: '为本对话开启自动审核？',
    dialogBody: [
      '自动审核只批准您点名的操作，或明显无害的操作。点名：您最新的消息里包含按钮或选项的完整名称（“点击保存设置”），或要输入的原文。明显无害：同站链接、“显示更多”一类的控件、悬停、在文本框内移动光标。',
      '随后由本对话的模型检查该操作是否符合您的请求，它随时可以改为询问您。其他操作都会显示常规卡片，并附一句下次该怎么说。消息中出现“只看”“不要”“告诉我是否”“草拟”等字眼时不会自动批准。支付、购买、安全与账户设置始终询问；保护数据的卡片（敏感字段、其他站点、上传、剪贴板、开发者工具、站点规则）也始终询问。',
      '在当前站点上，被批准的操作能做到您亲手点击能做到的事，页面也可能给有害的控件起您用过的名字。每个被审核的操作会通过 DSH 额外调用一次本对话的模型（使用您的账户和额度），发送您在此面板中的消息、操作本身、元素标签和页面地址。',
      '本对话不在面板中显示时自动审核暂停；60 分钟后、您停止代理或接管页面时结束；自您上一条消息起批准 25 个操作后，会先询问您是否继续。',
    ],
    dialogConfirm: '开启自动审核',
    dialogCancel: '继续逐一询问',
    reviewing: '正在审核…',
    badge: '自动',
    reasonPrefix: '自动审核的说明（模型文本）',
    approvedLine: '由自动审核批准',
    otherOn: (count) => `另有 ${count} 个对话开启了自动审核。`,
    turnAllOff: '全部关闭',
    settingLabel: '提供自动审核',
    settingHelp: '在输入框旁显示“审批：自动”。每个对话仍默认为询问。',
    settingMore: '在某个对话中开启自动审核（且该对话在面板中打开）后，由它自己的模型批准符合您请求的小型页面操作；发送、保存、删除、分享及作用不明的按钮只有在您最新的消息要求时才会执行。每个被审核的操作需要额外调用一次模型，并向该模型发送您在面板中的消息、操作、元素标签和页面地址。保护性卡片始终会询问。',
    settingManaged: '管理员已关闭自动审核。',
  },
  audit: {
    section: '审计日志',
    help: '浏览器操作和审批会写入本机上防篡改的日志。',
    more: '每次浏览器操作、审批、跳转和结果都会写入本机上防篡改（哈希链）的日志。输入的文字和密钥不会被记录。',
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
  sitePolicy: {
    title: '站点策略',
    rulesTitle: '站点规则',
    help: '针对特定站点的规则，优先于其他所有设置。',
    more: '「完全访问」信任除这些站点外的所有站点。格式：example.com（含子域名）、*bank*、github.com/settings。',
    builtIn: '内置保护',
    builtInHelp: (patterns) => `银行与支付、密码库、账户页面和云控制台默认只读（${String(patterns)} 条规则）。`,
    patternLabel: '站点规则',
    noRules: '还没有站点规则。',
    invalidPattern: '请输入站点，例如 example.com、*bank* 或 github.com/settings。',
    patternPlaceholder: 'example.com 或 *.bank.com',
    ruleLabel: '规则',
    rules: { blocked: '禁止（不可读取）', 'read-only': '只读', ask: '每次询问', trusted: '信任' },
    add: '添加',
    remove: '移除',
    removeItem: (item) => `移除 ${item}`,
    strictTitle: '严格模式（提交闸门）',
    strictHelp: '在这些站点上，代理操作期间的表单提交和写入请求需要您批准。',
    strictMore: '在这些站点上，代理操作期间页面发出的每个 POST/PUT/PATCH/DELETE 或表单提交都需要您批准，并显示字段（敏感字段已遮盖）。它会附加调试器，Chrome 会显示调试提示条。WebSocket 消息和 sendBeacon 无法拦截。',
    strictUnavailable: '此浏览器不可用：严格模式需要 Chrome 调试器。',
    strictSiteLabel: '严格模式站点',
    noStrictSites: '还没有严格模式站点。',
    managedIntro: '由管理员管理（优先于上方设置）：',
    managedNoUnrestricted: '已禁用完全访问。',
    managedNoDevTools: '已禁用开发者工具。',
    managedNoScreenshots: '已禁用截图。',
    managedAllowedOnly: (origins) => `仅允许以下站点：${origins.join('、') || '（无）'}`,
    trustedNote: '受信任站点的页面不会被当作不受信任的内容。',
    exemptLocal: '只读取本地页面的会话不受限制',
    exemptLocalHelp: '本机上你自己的页面（localhost、127.0.0.1）不会被当作不受信任的内容。',
    exemptLocalMore: '只有此处列出的本地地址才算：为开发循环关联的、在横幅上确认的，或在下方添加的。读取其他内容的对话照常受限，此后向本地地址发送数据仍需询问。显示非你本人内容的本地页面（邮件或订阅阅读器、代理）仍可能带有针对助手的指令。',
    exemptTrusted: '只读取受信任站点的会话不受限制',
    exemptTrustedHelp: '你信任的站点（仅限 https）的页面不会被当作不受信任的内容。',
    exemptTrustedMore: '包括：此处列出的站点（通过横幅上的「信任」添加）、设为「信任」的站点规则和永久免确认域名，除非有更严格的规则覆盖该站点。显示他人内容（评论、工单、邮件）的受信任站点仍可能带有针对助手的指令。受限的对话向受信任站点发送数据仍需询问。',
    managedNoLocalExemption: '本地页面与其他页面一样会限制会话。',
    managedNoTrustedExemption: '受信任站点与其他页面一样会限制会话。',
    localOriginsLabel: '我的本地页面',
    localOriginInput: '本地地址',
    localOriginInvalid: '请输入本地地址，例如 http://localhost:3000',
    noLocalOrigins: '暂无本地页面。',
    taintTrustedLabel: '不被当作不受信任内容的站点',
    noTaintTrusted: '暂无。对话受限时可在横幅上点「信任」。',
    keepQuestion: (count) => `你之前信任的 ${String(count)} 个站点将不再限制对话。是否保留？`,
    keepAll: '全部保留',
    keepOne: '保留',
  },
  taint: {
    body: (sites) => `本对话读取了可能包含指令的网页（${sites}），因此高风险操作会先询问，命令行与文件工具已停用。`,
    unknownSource: '未知来源',
    more: (count) => `另有 ${String(count)} 个`,
    clear: '清除',
    trust: (site) => `信任 ${site}`,
    trustMany: '信任这些站点…',
    trustConfirmLead: '信任 ',
    trustConfirmEnd: '？',
    trustEffects: '该站点及其子域名（https）的页面今后不再限制对话。本对话读取的所有站点都受信任后，命令行与文件工具恢复可用。该站点上操作的审批卡片不变。',
    confirmTrust: '信任',
    cancel: '取消',
    localQuestion: (host) => `把 ${host} 的页面当作你自己的页面？`,
    localYes: '是，是我的',
  },
  watchers: {
    label: '页面监视',
    title: (count) => `正在监视 ${String(count)} 个页面`,
    then: '触发后：',
    minutesLeft: (minutes) => `剩余 ${String(minutes)} 分钟`,
    hoursLeft: (hours) => `剩余 ${String(hours)} 小时`,
    lastMiss: (reason) => ` · 上次未送达（${reason}）`,
    cancel: '取消',
  },
  devLoop: {
    title: '开发闭环',
    help: '将本地页面标签关联到 DSH 编码会话，让它看到控制台错误和失败请求。',
    more: '将本地页面标签关联到 DSH 编码会话。该会话每次编辑文件后，会以只读上下文收到此标签新的控制台错误、失败请求和页面变化；此处永远不会向它发送提示。',
    caution: '如果本地应用会渲染不可信数据，这些文本可能借此进入编码会话。',
    cautionMore: '用户内容、抓取或代理的页面都属于不可信数据。可在桥接配置中设置 devLoop.trustLoopback: false，将此类注入视为不可信网页内容（会话随后变为只读，直到你清除）。',
    openLocalhost: '请先在此窗口打开本地页面（localhost、127.0.0.1 或 [::1]）。',
    unlink: '取消关联',
    noLinks: '尚未关联任何标签。',
    linkTab: '将此标签关联到编码会话…',
    noSessions: '未找到 DSH 编码会话。请先在 DSH（桌面版或 CLI）中开始一个会话。',
    sessionLabel: '编码会话',
    link: '关联',
  },
  learning: {
    label: '学习',
    sensitiveStep: '（重放时询问，从不存储）',
    stepsRecorded: (count) => `本会话已记录 ${String(count)} 步`,
    saveAsWorkflow: '保存为工作流',
    workflowName: '工作流名称',
    description: '描述',
    descriptionPlaceholder: '用途（可选）',
    saveHelp: '取消勾选可排除步骤。在输入值上勾选「变量」即可将其设为参数（当前值作为默认值）。只能保存在开启该设置后记录的运行。',
    variable: '变量',
    variableName: '变量名',
    save: '保存',
    savedTo: (path) => `已保存到 ${path}`,
    clearRecording: '清除记录',
    savedWorkflows: '已保存的工作流',
    stepCount: (count) => `${String(count)} 步`,
    everyMinutesLabel: '每 N 分钟',
    minutesPlaceholder: '分钟',
    scheduleHint: '在本会话中运行；最短每分钟一次。批准卡片仍会询问，无人回应时默认拒绝。',
    schedule: '定时',
    scheduled: '已定时。',
    schedules: '定时任务',
    everyMinutes: (minutes) => `每 ${String(minutes)} 分钟`,
    cancel: '取消',
    scheduleCancelled: '已取消定时。',
    watchIdle: '示范一两次，我来完成剩下的。',
    watching: (origin, events) => `正在观察 ${origin} · ${String(events)} 次输入`,
    watchMe: '观察我',
    stopWatching: '停止观察',
    repeated: (times) => `您已重复 ${String(times)} 次：`,
    done: '完成。',
    doRemaining: (remaining, steps, more) => more === true
      ? `按同样方式完成接下来的 ${String(remaining)} 项（共 ${String(steps ?? remaining)} 步，单次运行的上限）`
      : steps !== undefined && steps > remaining
      ? `按同样方式完成剩余 ${String(remaining)} 项（共 ${String(steps)} 步）`
      : `按同样方式完成剩余 ${String(remaining)} 项`,
    stoppedEarly: (rows, skipped) => `${rows > 0 ? `运行已停止，还剩 ${String(rows)} 行。` : '运行已停止。'}${skipped === undefined ? '' : `“${skipped}”只完成了一部分，已跳过；请手动完成。`}${rows > 0 ? '继续时会按页面当前的样子重新询问您。' : ''}`,
    rowsIndistinct: '这些行无法相互区分，因此每次最多执行 25 步。',
    continueRemaining: (rows) => `继续处理剩下的 ${String(rows)} 行`,
    proposedDriver: '建议的站点驱动',
    parameters: '参数',
    tokenSource: (kind, name) => `每次从页面 ${kind} "${name}" 读取（从不存储）`,
    dropped: '已丢弃（无页面来源）',
    saveDriver: '保存驱动',
    driverSaved: '驱动已保存。',
    discard: '丢弃',
    siteDrivers: '站点驱动',
    deleteDriver: '删除',
    exportDrivers: '导出驱动',
    importDrivers: '导入…',
    imported: (count) => `已导入 ${String(count)} 个驱动。`,
    settingsTitle: '学习功能（实验性）',
    settingsHelp: '默认全部关闭。记录浏览器中的操作以便重复执行。',
    settingsMore: '每个重放的操作仍然经过站点规则、暂停与紧急停止以及批准卡片。',
    workflowsTitle: '记录运行以便「保存为工作流」',
    workflowsHelp: '保留代理成功执行的步骤，以便将运行保存为工作流。',
    workflowsMore: '在内存中保存代理成功执行的步骤以及重新定位每个元素的方式（角色、名称、文本、CSS）。输入到密码等敏感字段的值从不记录。保存的工作流是会话工作区中的 JSON 文件并注册为技能，可重放或定时运行。',
    watchMeTitle: '观察我',
    watchMeHelp: '显示「观察我」按钮，记录您自己的点击和输入，让代理照着重复。',
    watchMeMore: '显示「观察我」按钮。开启观察时，会记录您在当前标签页上的点击和输入（从不记录密码，敏感字段被遮盖），在您重复两次后提供「按同样方式完成剩余 N 项」。',
    driversTitle: '站点驱动',
    driversHelp: '在您列出的站点上学习代理操作背后的请求，并建议可复用的工具。',
    driversUnavailable: '此浏览器不可用：站点驱动需要 Chrome 调试器。',
    driversMore: '对下方列出的站点，学习代理操作背后的同源请求（需允许开发者工具以进行网络捕获）并建议一个可复用的工具。经您批准才会保存；从不存储密钥和 Cookie。每次使用都会在批准卡片上显示确切请求。',
    driverSiteLabel: '站点驱动的站点',
    invalidDriverSite: '请输入站点地址，例如 https://shop.example.com。',
    add: '添加',
    remove: '移除',
    removeItem: (item) => `移除 ${item}`,
    fixturesTitle: '将失败保存为测试样例',
    fixturesHelp: '步骤失败时，将页面和预期操作保存到会话工作区。',
    fixturesMore: '步骤失败（找不到元素、页面防护拦截、重试后仍失败、其他错误）时，将页面和预期操作保存到会话工作区的 browser-fixtures/ 下。被拒绝、超时和取消的步骤以及被禁止的站点从不保存。敏感字段值会被遮盖；仅当页面没有敏感字段且您授予页面捕获权限时才保存完整 MHTML。',
    requestFailed: '请求失败。',
    disconnected: '与扩展的连接已断开，请重试。',
  },
  app: {
    openSettings: '打开设置',
    settings: '设置',
    openSessions: '历史会话',
    sessions: '会话',
    newSession: '新对话',
    conversationGone: 'DSH 中已没有之前的对话（它可能已重启或重置），因此已开始新对话。',
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
