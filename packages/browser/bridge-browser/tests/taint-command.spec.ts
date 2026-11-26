import { describe, expect, it, vi } from 'vitest'
import { SessionTaintRegistry } from '../src/session-taint.ts'
import { mountTaintClearCommand, runTaintClear, TAINT_CLEAR_COMMAND_NAME } from '../src/taint-command.ts'

describe('/browser-clear', () => {
  it('clears the conversation it is typed in and tells the extension', () => {
    const registry = new SessionTaintRegistry()
    registry.mark('s1', 'browser_snapshot')
    const notify = vi.fn()
    expect(runTaintClear(registry, notify, 's1')).toMatchObject({ kind: 'success', text: expect.stringContaining('back on') })
    expect(registry.isTainted('s1')).toBe(false)
    expect(notify).toHaveBeenCalledWith('s1')
    expect(runTaintClear(registry, notify, 's1')).toMatchObject({ kind: 'success', text: 'This conversation was not restricted.' })
  })

  it('names the parent conversation when the taint is inherited', () => {
    const registry = new SessionTaintRegistry()
    registry.mark('parent', 'browser_snapshot')
    registry.link('child', 'parent')
    expect(runTaintClear(registry, () => {}, 'child')).toMatchObject({ kind: 'error', text: expect.stringContaining('parent') })
    expect(registry.isTainted('child')).toBe(true)
  })

  it('needs a conversation, and registers only where DSH has commands', async () => {
    expect(runTaintClear(new SessionTaintRegistry(), () => {}, undefined).kind).toBe('error')
    expect(mountTaintClearCommand(undefined, new SessionTaintRegistry(), () => {})).toBeUndefined()
    const registered: Array<{ name: string; handler: (i: { agent?: { id: unknown } }) => Promise<{ kind: string }> }> = []
    const registry = new SessionTaintRegistry()
    registry.mark('s2', 'browser_snapshot')
    mountTaintClearCommand({ register: (definition) => { registered.push(definition); return () => {} } }, registry, () => {})
    expect(registered[0]!.name).toBe(TAINT_CLEAR_COMMAND_NAME)
    expect(await registered[0]!.handler({ agent: { id: 's2' } })).toMatchObject({ kind: 'success' })
  })
})
