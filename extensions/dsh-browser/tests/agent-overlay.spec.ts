// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentOverlay, OVERLAY_COPY_EN } from '../src/content/overlay.ts'
import { AgentOverlayController, type OverlayMessage } from '../src/background/agent-overlay.ts'
import { OVERLAY_COPY } from '../src/shared/overlay-copy.ts'
import type { TabFrame } from '../src/background/frames.ts'

function shadowOf(overlay: AgentOverlay): ShadowRoot {
  return (overlay as unknown as { parts: { root: ShadowRoot } }).parts.root
}

describe('AgentOverlay (content)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<input id="field"><button id="go">Go</button>'
  })
  afterEach(() => {
    document.documentElement.querySelectorAll(':scope > div').forEach((el) => { el.remove() })
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('lives in one closed shadow host that the page sees inserted once', async () => {
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => { records.push(...list) })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
    const overlay = new AgentOverlay({ killSwitch: vi.fn(), resume: vi.fn() })
    overlay.setControl(true)
    await overlay.point('click', [document.querySelector('#go')!], '#2')
    overlay.setTakeover(true)
    overlay.setHidden(true)
    overlay.setHidden(false)
    overlay.setTakeover(false)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    observer.disconnect()
    const host = overlay.hostElement()!
    expect(host.parentElement).toBe(document.documentElement)
    expect(host.shadowRoot).toBeNull()
    expect(host.getAttribute('style')).toContain('pointer-events: none !important')
    expect(records).toHaveLength(1)
    expect(records[0]!.addedNodes[0]).toBe(host)
    expect(document.body.contains(host)).toBe(false)
  })

  it('shows the control pill, a labelled outline, and a typing flash without the typed text', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
    const overlay = new AgentOverlay({ killSwitch: vi.fn(), resume: vi.fn() })
    overlay.setControl(true, OVERLAY_COPY.zh)
    const root = shadowOf(overlay)
    expect(root.querySelector('.pill.on')?.textContent).toContain('AI 正在操作')
    await overlay.point('type', [document.querySelector('#field')!], '#1', OVERLAY_COPY.en)
    expect(root.querySelector('.outline.on .label')?.textContent).toBe('#1')
    expect(root.querySelector('.typing.on')?.textContent).toBe(OVERLAY_COPY_EN.typing)
    expect(root.querySelector('.cursor.on')).toBeNull()
    expect(root.querySelector('.layer')?.classList.contains('acting')).toBe(true)
    await overlay.point('click', [document.querySelector('#go')!], undefined)
    expect(root.querySelector('.cursor.on')).not.toBeNull()
    expect(root.querySelector('.typing.on')).toBeNull()
    overlay.dispose()
    expect(overlay.hostElement()).toBeUndefined()
  })

  it('animates toward the target unless reduced motion is requested', async () => {
    vi.useFakeTimers()
    try {
      const overlay = new AgentOverlay({ killSwitch: vi.fn(), resume: vi.fn() })
      let done = false
      void overlay.point('hover', [document.querySelector('#go')!], '#2').then(() => { done = true })
      await vi.advanceTimersByTimeAsync(100)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(400)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores synthetic clicks on the Stop and Resume buttons', () => {
    const killSwitch = vi.fn()
    const resume = vi.fn()
    const overlay = new AgentOverlay({ killSwitch, resume })
    overlay.setControl(true)
    overlay.setTakeover(true)
    const root = shadowOf(overlay)
    ;(root.querySelector('.stop') as HTMLButtonElement).click()
    ;(root.querySelector('.resume') as HTMLButtonElement).click()
    expect(killSwitch).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(root.querySelector('.banner.on')?.textContent).toContain('You\'re in control')
    expect(root.querySelector('.pill.on')).toBeNull()
  })

  it('creates nothing for an "off" command on a page that never showed the overlay', () => {
    const overlay = new AgentOverlay({ killSwitch: vi.fn(), resume: vi.fn() })
    overlay.setControl(false)
    overlay.setTakeover(false)
    overlay.setHidden(true)
    expect(overlay.hostElement()).toBeUndefined()
  })
})

describe('AgentOverlayController (background)', () => {
  const frame = { frameId: 0, documentId: 'doc-1' } as TabFrame
  const setup = (enabled = true) => {
    const sent: Array<{ tabId: number; message: OverlayMessage; target?: unknown }> = []
    const send = vi.fn(async (tabId: number, message: OverlayMessage, target?: unknown) => { sent.push({ tabId, message, target }) })
    const controller = new AgentOverlayController({ send, enabled: () => enabled, locale: () => 'en', timeoutMs: 50 })
    return { controller, sent, send }
  }

  it('points at targets with addressing fields only', async () => {
    const { controller, sent } = setup()
    await controller.beforeAction(7, frame, { id: '1', name: 'browser_type', args: { index: 4, text: 'secret', frame: 0 } })
    await controller.beforeAction(7, frame, { id: '2', name: 'browser_drag', args: { from: { index: 1 }, to: { selector: '#b' }, offset: 3 } })
    await controller.beforeAction(7, frame, { id: '3', name: 'browser_snapshot', args: {} })
    await controller.beforeAction(7, frame, { id: '4', name: 'browser_press', args: { key: 'Enter' } })
    expect(sent).toEqual([
      { tabId: 7, target: { documentId: 'doc-1' }, message: { type: 'DSH_OVERLAY', op: 'point', kind: 'type', args: { index: 4 }, label: '#4', copy: OVERLAY_COPY.en } },
      { tabId: 7, target: { documentId: 'doc-1' }, message: { type: 'DSH_OVERLAY', op: 'point', kind: 'drag', args: { from: { index: 1 }, to: { selector: '#b' } }, label: '#1', copy: OVERLAY_COPY.en } },
    ])
    expect(JSON.stringify(sent)).not.toContain('secret')
  })

  it('makes the top page inert while an iframe action runs', async () => {
    const { controller, sent } = setup()
    await controller.beforeAction(7, { frameId: 3, documentId: 'child' } as TabFrame, { id: '1', name: 'browser_click', args: { index: 2, frame: 3 } })
    expect(sent.map(({ message, target }) => [message.op, target])).toEqual([
      ['acting', { frameId: 0 }],
      ['point', { documentId: 'child' }],
    ])
  })

  it('never waits longer than its bound and never throws', async () => {
    const controller = new AgentOverlayController({
      send: () => new Promise(() => {}), enabled: () => true, locale: () => 'zh', timeoutMs: 20,
    })
    await expect(controller.beforeAction(1, frame, { id: '1', name: 'browser_click', args: { index: 1 } })).resolves.toBeUndefined()
    const failing = new AgentOverlayController({ send: async () => { throw new Error('no receiver') }, enabled: () => true, locale: () => 'en' })
    await expect(failing.beforeAction(1, frame, { id: '1', name: 'browser_click', args: { index: 1 } })).resolves.toBeUndefined()
  })

  it('does nothing when the setting is off', async () => {
    const { controller, send } = setup(false)
    await controller.beforeAction(7, frame, { id: '1', name: 'browser_click', args: { index: 1 } })
    controller.syncControl(new Set([7]))
    expect(await controller.hiddenDuring(7, async () => 'shot')).toBe('shot')
    expect(send).not.toHaveBeenCalled()
  })

  it('syncs the control pill and takeover banner per tab and restores them on reload', () => {
    const { controller, sent } = setup()
    controller.syncControl(new Set([1, 2]))
    controller.syncControl(new Set([2]))
    controller.setTakeover(new Set([2]))
    controller.setTakeover(new Set())
    const ops = sent.map(({ tabId, message }) => `${tabId}:${message.op}:${'on' in message ? String(message.on) : ''}`)
    expect(ops).toEqual(['1:control:true', '2:control:true', '1:control:false', '2:takeover:true', '2:takeover:false'])
    expect(controller.readyState(2, 0)).toEqual({ control: true, takeover: false, copy: OVERLAY_COPY.en })
    expect(controller.readyState(2, 3)).toBeUndefined()
    expect(controller.readyState(1, 0)).toBeUndefined()
    controller.forget(2)
    expect(controller.readyState(2, 0)).toBeUndefined()
  })

  it('hides every frame during a screenshot and shows it again', async () => {
    const { controller, sent } = setup()
    expect(await controller.hiddenDuring(7, async () => 'shot')).toBe('shot')
    await Promise.resolve()
    expect(sent.map(({ message, target }) => [message, target])).toEqual([
      [{ type: 'DSH_OVERLAY', op: 'hide', hidden: true }, undefined],
      [{ type: 'DSH_OVERLAY', op: 'hide', hidden: false }, undefined],
    ])
  })
})
