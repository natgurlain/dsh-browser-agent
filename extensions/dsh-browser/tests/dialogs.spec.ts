// @vitest-environment jsdom
/**
 * JavaScript dialog tracking and the page-call watchdog.
 */
import { describe, expect, it, vi } from 'vitest'
import { DialogController, describeDialog, dialogOpenMessage, unresponsiveMessage, type DialogDebugger } from '../src/background/dialogs.ts'

const FAST = { stallMs: 5, probeTimeoutMs: 5, probeIntervalMs: 5, failedProbes: 2 }

function fakeDebugger(): DialogDebugger & { sent: Array<[number, string, Record<string, unknown>]>; armed: number[] } {
  const sent: Array<[number, string, Record<string, unknown>]> = []
  const armed: number[] = []
  return {
    supported: true,
    sent,
    armed,
    arm: async (tabId) => { armed.push(tabId); return () => {} },
    send: async (tabId, method, params) => { sent.push([tabId, method, params]); return {} },
  }
}

describe('dialog tracking', () => {
  it('records CDP dialog openings and clears them on close', () => {
    const changes: Array<[number, unknown]> = []
    const controller = new DialogController({ onChange: (tabId, dialog) => { changes.push([tabId, dialog?.type]) } })
    controller.onCdpEvent(7, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete it?', url: 'https://a.test/' })
    expect(controller.peek(7)).toMatchObject({ type: 'confirm', message: 'Delete it?', source: 'cdp' })
    expect(describeDialog(controller.peek(7)!)).toBe('confirm "Delete it?"')
    controller.onCdpEvent(7, 'Page.javascriptDialogClosed', { result: true })
    expect(controller.peek(7)).toBeUndefined()
    expect(changes).toEqual([[7, 'confirm'], [7, undefined]])
  })

  it('names the default text of a prompt and tells the model how to answer', () => {
    const controller = new DialogController({ debugger: fakeDebugger() })
    controller.onCdpEvent(1, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', defaultPrompt: 'Ada' })
    const message = dialogOpenMessage(controller.peek(1)!, controller.canAnswer)
    expect(message).toMatch(/^dialog open: prompt dialog\./)
    expect(message).toContain('prompt "Name?" (default "Ada")')
    expect(message).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(message).toContain('browser_dialog {accept: true, promptText}')
  })

  it('sends the user, not browser_dialog, to an unidentified blocking dialog', async () => {
    const controller = new DialogController({ debugger: fakeDebugger(), probe: async () => false, timing: FAST })
    await controller.guard(8, undefined, new Promise(() => {}))
    const message = dialogOpenMessage(controller.peek(8)!, controller.canAnswer)
    expect(message).toMatch(/^dialog open: unidentified dialog \(the page stopped responding\)\. Ask the user to answer or close it/)
    expect(unresponsiveMessage(3_000)).toMatch(/Ask the user to answer or close it/)
    // The action may already have run: no blind "retry" advice (#11).
    expect(unresponsiveMessage(3_000)).toMatch(/may already have been delivered.*browser_snapshot before repeating/)
    expect(unresponsiveMessage(3_000)).not.toMatch(/then retry/)
  })

  it('re-validates a record whose close may have been missed', async () => {
    const probe = vi.fn(async () => true)
    const controller = new DialogController({ probe, timing: FAST })
    controller.onCdpEvent(3, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
    expect(await controller.current(3)).toMatchObject({ type: 'alert' })
    expect(probe).not.toHaveBeenCalled()
    controller.onDetached(3)
    expect(await controller.current(3)).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('answers through the debugger and clears the record', async () => {
    const debuggerAccess = fakeDebugger()
    const controller = new DialogController({ debugger: debuggerAccess })
    controller.onCdpEvent(5, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?' })
    await controller.answer(5, true, 'Grace')
    expect(debuggerAccess.sent).toEqual([[5, 'Page.handleJavaScriptDialog', { accept: true, promptText: 'Grace' }]])
    expect(controller.peek(5)).toBeUndefined()
  })

  it('refuses to answer without a debugger', async () => {
    const controller = new DialogController()
    expect(controller.canAnswer).toBe(false)
    await expect(controller.answer(1, true)).rejects.toThrow(/no debugger/)
  })
})

describe('guarded page calls', () => {
  it('passes a prompt answer through untouched', async () => {
    const controller = new DialogController({ probe: async () => true, timing: FAST })
    expect(await controller.guard(1, undefined, Promise.resolve('done'))).toEqual({ kind: 'answer', value: 'done' })
  })

  it('fails fast when a dialog opens while the call is pending', async () => {
    const controller = new DialogController({ probe: async () => true, timing: { ...FAST, stallMs: 10_000 } })
    const pending = new Promise<string>(() => {})
    const outcome = controller.guard(9, undefined, pending)
    controller.onCdpEvent(9, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved!' })
    expect(await outcome).toMatchObject({ kind: 'dialog', dialog: { type: 'alert', message: 'Saved!' } })
  })

  it('reports an unresponsive page after consecutive failed probes', async () => {
    const probe = vi.fn(async () => false)
    const controller = new DialogController({ probe, timing: FAST })
    const outcome = await controller.guard(4, undefined, new Promise(() => {}))
    expect(outcome.kind).toBe('unresponsive')
    expect(probe).toHaveBeenCalledTimes(2)
    // The suspected dialog is remembered so the next call fails immediately…
    expect(controller.peek(4)).toMatchObject({ type: 'unknown', source: 'unresponsive' })
    // …until the page answers a probe again.
    probe.mockResolvedValue(true)
    expect(await controller.current(4)).toBeUndefined()
  })

  it('keeps waiting while a slow call leaves the page responsive', async () => {
    const probe = vi.fn(async () => true)
    const controller = new DialogController({ probe, timing: FAST })
    const slow = new Promise<string>((resolve) => { setTimeout(() => { resolve('late') }, 60) })
    expect(await controller.guard(2, undefined, slow)).toEqual({ kind: 'answer', value: 'late' })
    expect(probe.mock.calls.length).toBeGreaterThan(1)
  })

  it('surfaces a dialog that opened while the call still answered', async () => {
    const controller = new DialogController({ probe: async () => true, timing: FAST })
    controller.onCdpEvent(6, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Later' })
    const outcome = await controller.guard(6, undefined, Promise.resolve('ok'))
    expect(outcome).toMatchObject({ kind: 'answer', value: 'ok', dialog: { message: 'Later' } })
  })
})
