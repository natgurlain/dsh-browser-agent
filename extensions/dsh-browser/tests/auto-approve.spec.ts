// @vitest-environment jsdom
/**
 * Auto approve's decision in the extension (docs/auto-approve-design.md §3,
 * §4): off shows the card; on, an ordinary action runs with no model call; a
 * consequential one (committing words, credentials, taint-flagged steps,
 * files, programs, standing watchers) goes to the reviewer; a few cards are
 * never Auto. Also the action the reviewer is shown (no page content, capped
 * page strings), the registry (explicit choices kept, the Setting as default,
 * reviews aborted when turned off, a runaway guard that normal use never
 * trips) and the card's line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalPromptForCall, forcedApprovalPrompt, type ApprovalContext } from '../src/background/authorization.ts'
import { AUTO_APPROVE_KEPT, AutoApproveRegistry, autoApproveNote, RUNAWAY_LIMIT, RUNAWAY_WINDOW_MS, type AutoApproveStored } from '../src/background/auto-review.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ToolCall } from '../src/background/tools.ts'
import { fleetApprovalPrompt } from '../src/background/fleet.ts'
import { describeElement } from '../src/content/describe.ts'
import { MAX_REVIEW_UNTRUSTED_CHARS, parseReviewAction } from 'dsh-browser-agent/src/protocol.ts'
import { autoApprovePath, buildReviewAction, consequenceReasons, type AutoContext } from '../src/security/auto-review.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { TargetState } from '../src/shared/target-description.ts'

const FRAMES: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://shop.example/list?token=secret#frag' }]
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'call', name, args })
const found = (kind: string, name: string, extra: Record<string, unknown> = {}): TargetState => ({ state: 'found', kind, name, ...extra } as TargetState)
const SAME = (path: string) => ({ origin: 'https://shop.example', path, query: false })
const at = (target: TargetState): ApprovalContext => ({ targets: { target } })

/** An ordinary card as the page dispatcher raises it. */
function card(name: string, args: Record<string, unknown>, context: ApprovalContext = {}): ApprovalPrompt {
  return approvalPromptForCall(call(name, args), 'ask', FRAMES, 'en', context)!
}

function ctx(tool: string, args: Record<string, unknown> = {}, overrides: Partial<AutoContext> = {}): AutoContext {
  return { on: true, external: false, tool, args, ...overrides }
}

/** What Auto approve does with one tool call's card. */
function path(tool: string, args: Record<string, unknown>, context: ApprovalContext = {}, overrides: Partial<AutoContext> = {}) {
  return autoApprovePath(card(tool, args, context), ctx(tool, args, overrides))
}

afterEach(() => { document.body.innerHTML = '' })

describe('Auto approve: off, ordinary, consequential', () => {
  it('off: every card is the user\'s', () => {
    expect(path('browser_click', { index: 1 }, at(found('button', 'Show more')), { on: false })).toEqual({ kind: 'card', reason: 'off' })
  })

  it.each<[string, string, Record<string, unknown>, ApprovalContext]>([
    ['a click on an ordinary button', 'browser_click', { index: 1 }, at(found('button', 'Add to list'))],
    ['a click on "Save settings"', 'browser_click', { index: 1 }, at(found('button', 'Save settings'))],
    ['a click on "Continue"', 'browser_click', { index: 1 }, at(found('button', 'Continue'))],
    ['a search submitted with GET', 'browser_click', { index: 1 }, at(found('button', 'Search', { submits: true, form: { ...SAME('/search'), method: 'get' } }))],
    ['a same-site link', 'browser_click', { index: 1 }, at(found('link', 'Pricing', { href: SAME('/pricing') }))],
    ['typing into an ordinary field', 'browser_type', { index: 1, text: 'hello world' }, { targets: { target: found('textbox', 'Name') }, typedTargetSensitive: false }],
    ['Enter in a search box', 'browser_press', { key: 'Enter', index: 1 }, at(found('searchbox', 'Search', { inForm: true, form: { ...SAME('/search'), method: 'get' } }))],
    ['choosing an option', 'browser_select', { index: 1, value: 'jp' }, at(found('select', 'Country', { chosen: ['Japan'] }))],
    ['hovering', 'browser_hover', { index: 1 }, at(found('button', 'Menu'))],
    ['navigating to another site', 'browser_navigate', { url: 'https://news.example/today' }, {}],
    ['opening a tab', 'browser_open_tab', { url: 'https://docs.example/guide' }, {}],
    ['reading the page', 'browser_snapshot', {}, {}],
  ])('on: %s runs at once (no card, no model call)', (_label, tool, args, context) => {
    expect(path(tool, args, context)).toEqual({ kind: 'run' })
  })

  it.each<[string, string, Record<string, unknown>, ApprovalContext, string]>([
    ['"Send message"', 'browser_click', { index: 1 }, at(found('button', 'Send message')), 'commit-words'],
    ['"Delete"', 'browser_click', { index: 1 }, at(found('button', 'Delete')), 'commit-words'],
    ['"Publish post"', 'browser_click', { index: 1 }, at(found('button', 'Publish post')), 'commit-words'],
    ['"Unsubscribe"', 'browser_click', { index: 1 }, at(found('link', 'Unsubscribe', { href: SAME('/list/leave') })), 'commit-words'],
    ['"Transfer funds"', 'browser_click', { index: 1 }, at(found('button', 'Transfer funds')), 'commit-words'],
    ['"删除"', 'browser_click', { index: 1 }, at(found('button', '删除')), 'commit-words'],
    ['a link to /items/7/delete', 'browser_click', { index: 1 }, at(found('link', 'Item', { href: SAME('/items/7/delete') })), 'commit-words'],
    ['"Buy now"', 'browser_click', { index: 1 }, at(found('button', 'Buy now')), 'high-risk-words'],
    ['"Place order"', 'browser_click', { index: 1 }, at(found('button', 'Place order')), 'high-risk-words'],
    ['a link to /checkout', 'browser_click', { index: 1 }, at(found('link', 'Next', { href: SAME('/checkout') })), 'high-risk-words'],
    ['navigating to /billing', 'browser_navigate', { url: 'https://shop.example/billing' }, {}, 'high-risk-words'],
    ['a POST form submit', 'browser_click', { index: 1 }, at(found('button', 'Continue', { submits: true, form: { ...SAME('/wizard'), method: 'post' } })), 'submits-form'],
    ['Enter in a POST form', 'browser_press', { key: 'Enter', index: 1 }, at(found('textbox', 'Note', { inForm: true, form: { ...SAME('/notes'), method: 'post' } })), 'submits-form'],
    ['typing into a password field', 'browser_type', { index: 1, text: 'hunter2' }, { targets: { target: found('password', 'Password') }, typedTargetSensitive: true }, 'sensitive-field'],
    ['typing into a card-number field', 'browser_type', { index: 1, text: '4242' }, { targets: { target: found('textbox', 'Card', { sensitive: true }) }, typedTargetSensitive: true }, 'sensitive-field'],
    ['a download link', 'browser_click', { index: 1 }, at(found('link', 'Report', { href: SAME('/r.csv'), download: true })), 'files'],
    ['an upload', 'browser_upload', { index: 1, paths: ['/tmp/a'] }, at(found('file', 'Attach')), 'files'],
  ])('on: %s is consequential and goes to the reviewer', (_label, tool, args, context, reason) => {
    const result = path(tool, args, context)
    expect(result.kind).toBe('review')
    expect(result.kind === 'review' && result.reasons).toContain(reason)
  })

  it('a step the taint rules flag goes to the reviewer instead of a taint card', () => {
    const tainted = forcedApprovalPrompt(call('browser_type', { index: 1, text: 'secret' }), FRAMES, ['The session has read untrusted page content…'], 'en', { targets: { target: found('textbox', 'Search') }, typedTargetSensitive: false }, ['taint'])
    expect(tainted.forcedBy).toEqual(['taint'])
    expect(autoApprovePath(tainted, ctx('browser_type', { index: 1, text: 'secret' }))).toEqual({ kind: 'review', reasons: ['tainted'] })
    // A data-carrying navigation flagged by taint too.
    const away = forcedApprovalPrompt(call('browser_navigate', { url: 'https://evil.example/c?d=abc' }), FRAMES, ['…carries data…'], 'en', {}, ['taint'])
    expect(autoApprovePath(away, ctx('browser_navigate', { url: 'https://evil.example/c?d=abc' }))).toMatchObject({ kind: 'review', reasons: expect.arrayContaining(['tainted']) })
    // A fleet whose pages the taint rules flag.
    const fleet = fleetApprovalPrompt({ tasks: [{ url: 'https://a.example/', instruction: 'read' }], children: ['c1'], allowActions: false }, ['Page 1: tainted'], ['taint'])
    expect(autoApprovePath(fleet, ctx('browser_fanout'))).toMatchObject({ kind: 'review', reasons: ['tainted'] })
  })

  it('a program (and a "do the remaining N" series) is reviewed as a whole: its ordinary steps then skip their cards', () => {
    const program: ApprovalPrompt = { kind: 'action', action: 'browser_run', summary: 'Run 3 steps', origins: ['https://shop.example'], canTrust: false, browserOnly: true, binding: 'a'.repeat(64) }
    expect(autoApprovePath(program, ctx('browser_run', { steps: [] }))).toEqual({ kind: 'review', reasons: ['program'] })
  })

  it('a watcher and a site driver request are standing grants: reviewed', () => {
    const watcher: ApprovalPrompt = { kind: 'action', action: 'browser_watch', summary: 'Watch', origins: ['https://shop.example'], canTrust: false, forced: true, perCallOnly: true, binding: 'a'.repeat(64) }
    expect(autoApprovePath(watcher, ctx('browser_watch'))).toEqual({ kind: 'review', reasons: ['standing'] })
  })

  it.each<[string, ApprovalPrompt, Partial<AutoContext>, string]>([
    ['the developer-tools allowance', { kind: 'action', action: 'browser_console_eval', summary: 'Run JS', origins: [], canTrust: false, devTools: true }, {}, 'devtools'],
    ['a browser permission only a click can grant', { kind: 'action', action: 'browser_downloads', summary: 'Downloads', origins: [], canTrust: false, permission: 'downloads' }, {}, 'permission'],
    ['a site the user set to "ask"', { kind: 'action', action: 'browser_click', summary: 'Click', origins: [], canTrust: false, forced: true, forcedBy: ['site-ask', 'taint'] }, {}, 'site-rule'],
    ['strict mode\'s commit gate', { kind: 'action', action: 'network_commit', summary: 'POST', origins: [], canTrust: false, forced: true, perCallOnly: true }, { optOut: true }, 'opted-out'],
    ['an MCP conversation from another app', { kind: 'action', action: 'browser_click', summary: 'Click', origins: [], canTrust: false }, { external: true }, 'external-session'],
    ['a card naming an MCP requester', { kind: 'action', action: 'browser_click', summary: 'Click', origins: [], canTrust: false, requester: 'Some client' }, {}, 'external-session'],
  ])('never Auto: %s', (_label, prompt, overrides, reason) => {
    expect(autoApprovePath(prompt, ctx(prompt.action, {}, overrides))).toEqual({ kind: 'card', reason })
  })

  it('typing: an inspected ordinary field stays ordinary; a field not inspected counts as sensitive (L3)', () => {
    const typed = (context: ApprovalContext) => consequenceReasons(card('browser_type', { index: 1, text: 'hi' }, context), 'browser_type', { index: 1, text: 'hi' })
    expect(typed({ targets: { target: found('textbox', 'Name') }, typedTargetSensitive: false })).toEqual([])
    expect(typed({ targets: { target: found('textbox', 'Name') } })).toEqual(['sensitive-field'])
    // Other tools never had a sensitivity probe: no reason from its absence.
    expect(consequenceReasons(card('browser_click', { index: 1 }, at(found('button', 'Add'))), 'browser_click', { index: 1 })).toEqual([])
  })

  it('the binding covers "sensitive": a field that turns sensitive after the decision voids it (L3)', () => {
    const bind = (target: TargetState) => card('browser_type', { index: 1, text: 'hi' }, { targets: { target }, typedTargetSensitive: false }).binding
    expect(bind(found('textbox', 'Name', { sensitive: true }))).not.toBe(bind(found('textbox', 'Name')))
  })

  it('a site driver request on a site set to "Always ask" is left to the user (F1)', async () => {
    const { LearningRuntime } = await import('../src/background/learning.ts')
    const { memoryStorage } = await import('./support/chrome.ts')
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn(), get: vi.fn(async (id: number) => ({ id, url: 'https://crm.example/new', windowId: 1 })) },
      permissions: { contains: vi.fn(async () => false) },
      storage: { local: memoryStorage().area },
    })
    try {
      const driver = { format: 'dsh-site-driver/v1', origin: 'https://crm.example', name: 'add', description: '', method: 'POST', path: '/api/add', body: { type: 'json', template: '{"name":"{{name}}"}' }, headers: { 'content-type': 'application/json' }, tokens: [], params: [{ name: 'name' }] }
      const storage = memoryStorage({ dshLearningSettings: { siteDrivers: true, siteDriverOrigins: ['https://crm.example'] }, dshSiteDrivers: [driver] })
      const learning = new LearningRuntime({
        rpc: () => ({ request: vi.fn() }), bridgeConnected: () => true, agentActiveOnTab: () => false, halted: () => false,
        fixtureAllowed: () => true, capturedRequests: () => undefined, siteDriversSupported: true,
        activeTab: async () => ({ id: 7 } as chrome.tabs.Tab), storage: storage.area,
      } as ConstructorParameters<typeof LearningRuntime>[0])
      await learning.ready
      const seen: ApprovalPrompt[] = []
      const dispatch = (policy: () => ReturnType<NonNullable<Parameters<typeof learning.dispatchSiteDriver>[2]>>) => learning.dispatchSiteDriver(
        { id: 'c1', name: 'browser_site_driver', args: { origin: driver.origin, driver: 'add', params: { name: 'x' } }, sessionId: 's1' },
        { id: 7, url: 'https://crm.example/new' }, policy, async (prompt) => { seen.push(prompt); return 'denied' }, new AbortController().signal)
      await dispatch(() => ({ kind: 'force', reasons: ['Site policy asks before every agent call on https://crm.example (your site policy).'], causes: ['site-ask'] }))
      expect(seen[0]!.forcedBy).toEqual(['site-ask'])
      expect(autoApprovePath(seen[0]!, ctx('browser_site_driver'))).toEqual({ kind: 'card', reason: 'site-rule' })
      // Without a site rule a site driver request is a standing grant: reviewed.
      await dispatch(() => ({ kind: 'default' }))
      expect(seen[1]!.forcedBy).toBeUndefined()
      expect(autoApprovePath(seen[1]!, ctx('browser_site_driver'))).toEqual({ kind: 'review', reasons: ['standing'] })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('every forced prompt built from a policy decision carries its causes (F1, F2)', () => {
    // Element actions, navigation and new tabs (tools.ts), fleets (fleet.ts), developer tools (index.ts) share
    // forcedApprovalPrompt / fleetApprovalPrompt; site drivers and watchers are tested above.
    const askOnly = forcedApprovalPrompt(call('browser_click', { index: 1 }), FRAMES, ['ask'], 'en', at(found('button', 'Add')), ['site-ask'])
    expect(askOnly.forcedBy).toEqual(['site-ask'])
    expect(autoApprovePath(askOnly, ctx('browser_click', { index: 1 }))).toEqual({ kind: 'card', reason: 'site-rule' })
    for (const name of ['browser_navigate', 'browser_open_tab']) {
      const prompt = forcedApprovalPrompt(call(name, { url: 'https://crm.example/' }), [], ['ask'], 'en', {}, ['site-ask'])
      expect(autoApprovePath(prompt, ctx(name, { url: 'https://crm.example/' }))).toEqual({ kind: 'card', reason: 'site-rule' })
    }
    const fleet = fleetApprovalPrompt({ tasks: [{ url: 'https://crm.example/', instruction: 'read' }], children: ['c1'], allowActions: false }, ['Page 1: ask'], ['site-ask'])
    expect(autoApprovePath(fleet, ctx('browser_fanout'))).toEqual({ kind: 'card', reason: 'site-rule' })
  })

  it('Save, Continue, OK, Accept and Apply stay ordinary (no review, no latency)', () => {
    for (const name of ['Save', 'Continue', 'OK', 'Accept', 'Apply', 'Next', 'Done', 'Sign up for updates later']) {
      expect(consequenceReasons(card('browser_click', { index: 1 }, at(found('button', name))), 'browser_click', { index: 1 })).toEqual([])
    }
  })
})

describe('what the reviewer is shown', () => {
  it('the verb, the control, the page (origin and path only), the destination, the typed text; nothing else from the page', () => {
    const prompt = card('browser_type', { index: 1, text: 'Running late, sorry' }, { targets: { target: found('textbox', 'Message', { context: { kind: 'section', text: 'Reply to Dana' } }) }, typedTargetSensitive: false })
    const action = buildReviewAction(prompt, 'browser_type', { index: 1, text: 'Running late, sorry' }, { tainted: true, title: 'Inbox' }, ['tainted'])
    expect(action).toEqual({
      tool: 'browser_type', verb: 'type', targetKind: 'textbox', reasons: ['tainted'], tainted: true,
      untrusted: { name: 'Message', context: 'Reply to Dana', title: 'Inbox', url: 'https://shop.example/list', typed: 'Running late, sorry' },
    })
    expect(parseReviewAction(action)).toEqual(action)
  })

  it('never the text typed into a sensitive field; page strings are capped', () => {
    const prompt = card('browser_type', { index: 1, text: 'hunter2' }, { targets: { target: found('password', 'Password') }, typedTargetSensitive: true })
    expect(buildReviewAction(prompt, 'browser_type', { index: 1, text: 'hunter2' }, { tainted: false }, ['sensitive-field']).untrusted).not.toHaveProperty('typed')
    const long = card('browser_click', { index: 1 }, at(found('button', 'Send')))
    const action = buildReviewAction(long, 'browser_click', { index: 1 }, { tainted: false, title: 'x'.repeat(5_000) }, ['commit-words'])
    expect(action.untrusted.title!.length).toBeLessThanOrEqual(MAX_REVIEW_UNTRUSTED_CHARS)
    expect(parseReviewAction(action)).toBeDefined()
  })

  it('a card without an element (a program) carries its summary instead', () => {
    const prompt: ApprovalPrompt = { kind: 'action', action: 'browser_run', summary: 'Run 3 steps on shop.example', origins: ['https://shop.example'], canTrust: false, binding: 'a'.repeat(64) }
    expect(buildReviewAction(prompt, 'browser_run', {}, { tainted: false }, ['program'])).toMatchObject({ verb: 'run-program', targetKind: 'none', untrusted: { summary: 'Run 3 steps on shop.example' } })
  })
})

describe('what the page reports (content script)', () => {
  it('a submit control reports its form and method; a real link its destination; a download link says so', () => {
    window.history.replaceState(null, '', '/inbox')
    document.body.innerHTML = '<form action="/notes" method="post"><input id="n" aria-label="Note"><button id="b">Post note</button></form><a id="r" href="/articles/7">Article</a><a id="d" href="/files/r.csv" download>Report</a><a id="j" href="javascript:void(0)">Archive</a>'
    expect(describeElement(document.getElementById('b')!)).toMatchObject({ kind: 'button', submits: true, form: { path: '/notes', method: 'post' } })
    expect(describeElement(document.getElementById('n')!)).toMatchObject({ inForm: true, form: { path: '/notes', method: 'post' } })
    expect(describeElement(document.getElementById('r')!)).toMatchObject({ kind: 'link', href: { path: '/articles/7', query: false } })
    expect(describeElement(document.getElementById('d')!)).toMatchObject({ download: true })
    expect(describeElement(document.getElementById('j')!)).not.toHaveProperty('href')
    // The removed "named" rule facts are no longer reported.
    for (const id of ['b', 'n', 'r']) {
      const description = describeElement(document.getElementById(id)!)
      for (const gone of ['rendered', 'sameName', 'rowKey', 'disclosure', 'empty', 'newTab', 'suggests', 'dialogOpen']) expect(description).not.toHaveProperty(gone)
    }
  })
})

describe('the registry', () => {
  function store(initial?: AutoApproveStored) {
    let value: unknown = initial
    return { read: vi.fn(async () => value), write: vi.fn(async (next: AutoApproveStored) => { value = next }), get value() { return value } }
  }
  function panelStore(initial?: string[]) {
    let value: unknown = initial
    return { read: vi.fn(async () => value), write: vi.fn(async (ids: string[]) => { value = ids }), get value() { return value } }
  }

  it('the Setting decides a conversation the user never switched; an explicit choice wins and is kept', async () => {
    const kept = store({ v: 1, sessions: { a: false } })
    const registry = new AutoApproveRegistry(kept, Date.now, () => {}, panelStore())
    await registry.ready
    registry.notePanel('fresh')
    expect(registry.isOn('fresh', false)).toBe(false)
    expect(registry.isOn('fresh', true)).toBe(true)
    // Switched off stays off, even when new conversations start on.
    expect(registry.isOn('a', true)).toBe(false)
    registry.set('b', true)
    expect(registry.isOn('b', false)).toBe(true)
    expect(kept.value).toEqual({ v: 1, sessions: { a: false, b: true } })
    // A restart reads them back.
    const again = new AutoApproveRegistry(kept)
    await again.ready
    expect(again.isOn('b', false)).toBe(true)
    registry.forget('b')
    expect(registry.choice('b')).toBeUndefined()
    expect(registry.isOn(undefined, true)).toBe(false)
  })

  it('the Setting applies only to conversations prompted or created in the side panel, also after a restart', async () => {
    const kept = store()
    const panel = panelStore()
    const registry = new AutoApproveRegistry(kept, Date.now, () => {}, panel)
    await registry.ready
    // A DSH session from the terminal or the CLI (not "mcp-") can drive the browser too: it never starts in Auto.
    expect(registry.isOn('tui-session', true)).toBe(false)
    registry.notePanel('panel-session')
    expect(registry.isOn('panel-session', true)).toBe(true)
    // An explicit choice still applies to any conversation.
    registry.set('tui-session', true)
    expect(registry.isOn('tui-session', false)).toBe(true)
    // A service-worker restart reads them back (session storage; a browser restart forgets them until the next panel prompt).
    expect(panel.value).toEqual(['panel-session'])
    const again = new AutoApproveRegistry(kept, Date.now, () => {}, panel)
    await again.ready
    expect(again.isOn('panel-session', true)).toBe(true)
    expect(again.panelSessions()).toEqual(['panel-session'])
  })

  it('before the stored choices load, a stored "off" never reads as the Setting\'s "on" (L1)', async () => {
    let release!: (value: unknown) => void
    const registry = new AutoApproveRegistry({ read: () => new Promise((resolve) => { release = resolve }), write: async () => {} }, Date.now, () => {}, panelStore(['conv-x', 'conv-y']))
    const early = registry.isOn('conv-x', true)
    release({ v: 1, sessions: { 'conv-x': false } })
    await registry.ready
    expect(early).toBe(false)
    expect(registry.isOn('conv-x', true)).toBe(false)
    expect(registry.isOn('conv-y', true)).toBe(true)
  })

  it('an explicit "off" outlives 500 newer "on" choices (L2)', async () => {
    const registry = new AutoApproveRegistry(store(), Date.now, () => {}, panelStore())
    await registry.ready
    registry.notePanel('conv-off')
    registry.set('conv-off', false)
    for (let index = 0; index < AUTO_APPROVE_KEPT; index += 1) registry.set(`c${String(index)}`, true)
    expect(registry.choice('conv-off')).toBe(false)
    expect(registry.isOn('conv-off', true)).toBe(false)
    expect(Object.keys(registry.views())).toHaveLength(AUTO_APPROVE_KEPT)
  })

  it('keeps a bounded number of choices', async () => {
    const registry = new AutoApproveRegistry(store())
    await registry.ready
    for (let index = 0; index < AUTO_APPROVE_KEPT + 20; index += 1) registry.set(`s${String(index)}`, true)
    expect(Object.keys(registry.views())).toHaveLength(AUTO_APPROVE_KEPT)
    expect(registry.choice('s0')).toBeUndefined()
  })

  it('turning Auto off, deleting the conversation or the kill switch aborts reviews in flight', async () => {
    const registry = new AutoApproveRegistry(store())
    const one = new AbortController()
    const two = new AbortController()
    const three = new AbortController()
    registry.track('a', one)
    registry.track('b', two)
    registry.track('c', three)
    registry.set('a', false)
    expect(one.signal.aborted).toBe(true)
    registry.forget('b')
    expect(two.signal.aborted).toBe(true)
    registry.abortAll()
    expect(three.signal.aborted).toBe(true)
  })

  it('the runaway guard trips only at an absurd rate, never in normal use', () => {
    let now = 0
    const registry = new AutoApproveRegistry(store(), () => now)
    // A busy real task: an action every 200 ms for ten minutes.
    for (let step = 0; step < 3_000; step += 1) {
      now += 200
      expect(registry.runaway('s')).toBe(false)
      registry.noteApproved('s')
    }
    // A loop gone wrong: RUNAWAY_LIMIT approvals inside one window.
    for (let step = 0; step < RUNAWAY_LIMIT; step += 1) registry.noteApproved('loop')
    expect(registry.runaway('loop')).toBe(true)
    now += RUNAWAY_WINDOW_MS + 1
    expect(registry.runaway('loop')).toBe(false)
  })
})

describe('the card\'s line', () => {
  it('a denial shows the reviewer\'s one-line reason, attributed; other outcomes a fixed sentence', () => {
    expect(autoApproveNote('denied', 'You only asked to read the inbox.', false)).toBe('Auto approve\'s reviewer asked you: You only asked to read the inbox.')
    expect(autoApproveNote('denied', '您只要求阅读收件箱。', true)).toBe('自动批准的审核模型请您决定：您只要求阅读收件箱。')
    expect(autoApproveNote('timeout', 'ignored', false)).toBe('Auto approve\'s reviewer did not answer in time, so you decide.')
    expect(autoApproveNote('failed', undefined, false)).toBe('Auto approve could not review this step, so you decide.')
    expect(autoApproveNote('denied', `a\nb ${'x'.repeat(500)}`, false).length).toBeLessThan(260)
  })
})
