// @vitest-environment jsdom
/**
 * JavaScript dialogs in tool dispatch: fail-fast while a dialog blocks the
 * page, the watchdog around page calls, and the approval-gated answer tool.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchToolCall, type ToolAnswer, type ToolCall } from '../src/background/tools.ts'
import { DialogController, type DialogDebugger } from '../src/background/dialogs.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'

const TAB = { id: 42, windowId: 3, url: 'https://example.com/page', title: 'Example' }
const FRAMES = [{ frameId: 0, parentFrameId: -1, documentId: 'doc-main', url: TAB.url }]
const FAST = { stallMs: 5, probeTimeoutMs: 5, probeIntervalMs: 5, failedProbes: 2 }

interface Harness {
  actions: string[]
  /** Resolve or leave pending the content-script answer of one action. */
  respond: (name: string) => Promise<unknown>
}

function stubChrome(harness: Harness): void {
  vi.stubGlobal('chrome', {
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, message: { type?: string; action?: string }) => {
        if (message.type === 'DSH_ACTION') {
          harness.actions.push(message.action ?? '')
          return harness.respond(message.action ?? '')
        }
        return { ok: true, result: { sensitive: false } }
      }),
      query: vi.fn(async () => [TAB]),
      get: vi.fn(async () => TAB),
    },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: true }]) },
    webNavigation: { getAllFrames: vi.fn(async () => FRAMES), getFrame: vi.fn(async () => FRAMES[0]) },
    runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  })
}

function fakeDebugger(onArm?: (tabId: number) => void): DialogDebugger & { sent: Array<[string, Record<string, unknown>]> } {
  const sent: Array<[string, Record<string, unknown>]> = []
  return {
    supported: true,
    sent,
    arm: async (tabId) => { onArm?.(tabId); return () => {} },
    send: async (_tabId, method, params) => { sent.push([method, params]); return {} },
  }
}

async function run(
  call: ToolCall,
  dialogs: DialogController,
  authorize: (prompt: ApprovalPrompt) => Promise<'approved' | 'denied'> = async () => 'approved',
  unrestrictedAccess = true,
): Promise<ToolAnswer> {
  return dispatchToolCall(
    call, 'auto', { maxItems: 60, maxChars: 12_000 }, authorize, undefined, TAB, () => true,
    { unrestrictedAccess, followTab: async () => undefined, dialogs },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dialogs during actions', () => {
  it('arms the debugger around a click and fails fast when the click opens a dialog', async () => {
    let dialogs!: DialogController
    const armed: number[] = []
    dialogs = new DialogController({ debugger: fakeDebugger((tabId) => { armed.push(tabId) }), probe: async () => true, timing: { ...FAST, stallMs: 10_000 } })
    stubChrome({
      actions: [],
      // The click handler calls confirm(): the content script never answers.
      respond: async () => {
        setTimeout(() => { dialogs.onCdpEvent(42, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete everything?' }) }, 1)
        return new Promise(() => {})
      },
    })
    const answer = await run({ id: '1', name: 'browser_click', args: { selector: '#delete' } }, dialogs)
    expect(armed).toEqual([42])
    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toMatch(/^dialog open: confirm dialog\. The action was delivered/)
    expect(answer.error?.message).toContain('Delete everything?')
    expect(answer.error?.message).toContain('browser_dialog')
  })

  it('refuses later page calls immediately while the dialog is open', async () => {
    const dialogs = new DialogController({ debugger: fakeDebugger(), probe: async () => false, timing: FAST })
    dialogs.onCdpEvent(42, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' })
    const harness: Harness = { actions: [], respond: async () => ({ ok: true, result: { text: 'x' } }) }
    stubChrome(harness)
    const answer = await run({ id: '2', name: 'browser_snapshot', args: {} }, dialogs)
    expect(answer.error?.message).toMatch(/^dialog open: alert dialog\./)
    expect(harness.actions).toEqual([])
  })

  it('reports a page that stopped responding without a debugger', async () => {
    const dialogs = new DialogController({ probe: async () => false, timing: FAST })
    stubChrome({ actions: [], respond: async () => new Promise(() => {}) })
    const started = Date.now()
    const answer = await run({ id: '3', name: 'browser_click', args: { selector: '#x' } }, dialogs)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(answer.error?.code).toBe('timeout')
    expect(answer.error?.message).toMatch(/^The page is not responding \(.*\) — a JavaScript dialog .* may be open\. Ask the user .*Catch page dialogs/)
  })

  it('appends a dialog that opened while the action still answered', async () => {
    const dialogs = new DialogController({ debugger: fakeDebugger(), probe: async () => true, timing: FAST })
    stubChrome({
      actions: [],
      respond: async () => {
        dialogs.onCdpEvent(42, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Thanks!' })
        return { ok: true, result: { text: 'Clicked (#ok).' } }
      },
    })
    const answer = await run({ id: '4', name: 'browser_click', args: { selector: '#ok' } }, dialogs)
    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toMatch(/Clicked \(#ok\)\.\n\ndialog open: alert dialog\./)
  })
})

describe('browser_dialog', () => {
  it('asks with the dialog message and the full answer on the card, then answers it', async () => {
    const debuggerAccess = fakeDebugger()
    const dialogs = new DialogController({ debugger: debuggerAccess, probe: async () => true, timing: FAST })
    dialogs.onCdpEvent(42, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Your name?', defaultPrompt: 'x' })
    stubChrome({ actions: [], respond: async () => ({ ok: true }) })
    const prompts: ApprovalPrompt[] = []
    const answer = await run(
      { id: '5', name: 'browser_dialog', args: { accept: true, promptText: 'Ada' } },
      dialogs,
      async (prompt) => { prompts.push(prompt); return 'approved' },
      false,
    )
    expect(answer.ok).toBe(true)
    expect(prompts[0]).toMatchObject({ kind: 'action', action: 'browser_dialog' })
    expect(prompts[0]!.details).toEqual([
      expect.objectContaining({ kind: 'text', value: 'Your name?', masked: false }),
      expect.objectContaining({ kind: 'text', value: 'Ada', masked: false }),
    ])
    expect(debuggerAccess.sent).toEqual([['Page.handleJavaScriptDialog', { accept: true, promptText: 'Ada' }]])
    expect(dialogs.peek(42)).toBeUndefined()
  })

  it('refuses when a different dialog replaced the approved one', async () => {
    const debuggerAccess = fakeDebugger()
    const dialogs = new DialogController({ debugger: debuggerAccess, probe: async () => true, timing: FAST })
    dialogs.onCdpEvent(42, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Keep draft?' })
    stubChrome({ actions: [], respond: async () => ({ ok: true }) })
    const answer = await run({ id: '6', name: 'browser_dialog', args: { accept: true } }, dialogs, async () => {
      dialogs.onCdpEvent(42, 'Page.javascriptDialogClosed', {})
      dialogs.onCdpEvent(42, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete account?' })
      return 'approved'
    }, false)
    expect(answer.ok).toBe(false)
    expect(debuggerAccess.sent).toEqual([])
  })

  it('explains that Firefox cannot answer native dialogs', async () => {
    const dialogs = new DialogController({ probe: async () => true, timing: FAST })
    stubChrome({ actions: [], respond: async () => ({ ok: true }) })
    const answer = await run({ id: '7', name: 'browser_dialog', args: { accept: false } }, dialogs)
    expect(answer.error?.code).toBe('input-unavailable')
    expect(answer.error?.message).toMatch(/Chrome debugger/)
  })

  it('reports when no dialog is open', async () => {
    const dialogs = new DialogController({ debugger: fakeDebugger(), probe: async () => true, timing: FAST })
    stubChrome({ actions: [], respond: async () => ({ ok: true }) })
    const answer = await run({ id: '8', name: 'browser_dialog', args: { accept: true } }, dialogs)
    expect(answer.error?.message).toBe('No JavaScript dialog is open in the controlled tab.')
  })
})
