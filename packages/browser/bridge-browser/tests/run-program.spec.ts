import { describe, expect, it, vi } from 'vitest'
import { BridgeToolError } from '../src/server.ts'
import {
  defineRunProgramTool,
  guardChecks,
  MAX_PROGRAM_STEPS,
  parseProgram,
  ProgramError,
  renderProgramOutcome,
  runProgram,
  statusOf,
} from '../src/run-program.ts'

type Handler = (name: string, args: Record<string, unknown>, program?: { id: string; step: number }) => unknown

function fakeBridge(handler: Handler) {
  const calls: { name: string; args: Record<string, unknown>; sessionId?: string; callId?: string; program?: { id: string; step: number } }[] = []
  const requestTool = vi.fn(async (name: string, args: Record<string, unknown>, _signal: AbortSignal, _timeout?: number, sessionId?: string, callId?: string, program?: { id: string; step: number }) => {
    calls.push({ name, args, ...(sessionId === undefined ? {} : { sessionId }), ...(callId === undefined ? {} : { callId }), ...(program === undefined ? {} : { program }) })
    return handler(name, args, program)
  })
  return { bridge: { requestTool } as never, calls }
}

const ok = (text: string) => ({ text })

describe('parseProgram', () => {
  it('accepts allowed steps with guards', () => {
    const steps = parseProgram([
      { tool: 'browser_click', args: { index: 3 }, expect: { urlMatches: '/done', value: { selector: '#q', equals: 'x' } } },
      { tool: 'browser_snapshot' },
    ])
    expect(steps).toEqual([
      { tool: 'browser_click', args: { index: 3 }, expect: { urlMatches: '/done', value: { selector: '#q', equals: 'x' } } },
      { tool: 'browser_snapshot', args: {} },
    ])
  })

  it('refuses too many steps, unknown and forbidden tools, and empty guards', () => {
    const many = Array.from({ length: MAX_PROGRAM_STEPS + 1 }, () => ({ tool: 'browser_snapshot' }))
    expect(() => parseProgram(many)).toThrow(ProgramError)
    expect(() => parseProgram([])).toThrow(/non-empty/)
    for (const tool of ['browser_run', 'browser_open_tab', 'browser_close_tab', 'browser_upload', 'browser_clipboard', 'browser_console_eval', 'browser_watch', 'browser_fanout']) {
      expect(() => parseProgram([{ tool }])).toThrow(/tool must be one of/)
    }
    expect(() => parseProgram([{ tool: 'browser_click', expect: {} }])).toThrow(/names no condition/)
    expect(() => parseProgram([{ tool: 'browser_click', expect: { bogus: 1 } }])).toThrow(/unknown field bogus/)
    expect(() => parseProgram([{ tool: 'browser_click', expect: { timeoutMs: 100 } }])).toThrow(/names no condition/)
    expect(() => parseProgram([{ tool: 'browser_click', args: [] }])).toThrow(/args must be an object/)
  })

  it('maps each guard condition to a browser_wait check', () => {
    expect(guardChecks({ urlMatches: 'a', text: 'b', textAbsent: 'c', selector: 'd', value: { selector: 'e', equals: 'f' }, timeoutMs: 100 })).toEqual([
      { urlMatches: 'a', timeoutMs: 100 },
      { text: 'b', timeoutMs: 100 },
      { text: 'c', gone: true, timeoutMs: 100 },
      { selector: 'd', timeoutMs: 100 },
      { selector: 'e', valueEquals: 'f', timeoutMs: 100 },
    ])
  })
})

describe('runProgram', () => {
  const signal = new AbortController().signal

  it('asks for one program approval, then tags every step with the program and step number', async () => {
    const { bridge, calls } = fakeBridge((name) => name === 'browser_run' ? { programId: 'p1', text: 'approved' } : ok(`${name} done`))
    const steps = parseProgram([
      { tool: 'browser_type', args: { selector: '#q', text: 'hello' } },
      { tool: 'browser_click', args: { index: 2 }, expect: { text: 'Results' } },
    ])
    const outcome = await runProgram(bridge, steps, { signal, sessionId: 's1', toolCallId: 'c1' }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('completed')
    expect(calls.map((call) => [call.name, call.program])).toEqual([
      ['browser_run', undefined],
      ['browser_type', { id: 'p1', step: 0 }],
      ['browser_click', { id: 'p1', step: 1 }],
      ['browser_wait', undefined],
      ['browser_snapshot', undefined],
    ])
    expect(calls[0]!.args).toEqual({ steps })
    expect(calls.every((call) => call.sessionId === 's1' && call.callId === 'c1')).toBe(true)
    expect(calls[3]!.args).toEqual({ text: 'Results', timeoutMs: 5000 })
    expect(calls[4]!.args).toEqual({ delta: true })
    expect(outcome.delta).toBe('browser_snapshot done')
  })

  it('stops at the first failed guard and still reports the delta', async () => {
    const { bridge, calls } = fakeBridge((name, args) => {
      if (name === 'browser_run') return { programId: 'p' }
      if (name === 'browser_wait' && args.urlMatches === '/never') throw new BridgeToolError('action-failed', 'URL did not match')
      return ok('fine')
    })
    const steps = parseProgram([
      { tool: 'browser_click', args: { index: 1 }, expect: { urlMatches: '/never' } },
      { tool: 'browser_click', args: { index: 2 } },
    ])
    const outcome = await runProgram(bridge, steps, { signal }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('guard')
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0]!.guard).toEqual({ ok: false, text: 'URL did not match' })
    expect(calls.map((call) => call.name)).toEqual(['browser_run', 'browser_click', 'browser_wait', 'browser_snapshot'])
    expect(renderProgramOutcome(outcome, 2)).toMatch(/guard after step 1 of 2 failed[\s\S]*expect NOT met: URL did not match/)
  })

  it('stops at the first step error (a denied card) and runs nothing after it', async () => {
    const { bridge, calls } = fakeBridge((name, _args, program) => {
      if (name === 'browser_run') return { programId: 'p' }
      if (program?.step === 1) throw new BridgeToolError('action-failed', 'The user denied this action.')
      return ok('fine')
    })
    const steps = parseProgram([{ tool: 'browser_click', args: {} }, { tool: 'browser_click', args: {} }, { tool: 'browser_click', args: {} }])
    const outcome = await runProgram(bridge, steps, { signal }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('error')
    expect(outcome.steps.map((step) => step.ok)).toEqual([true, false])
    expect(calls.filter((call) => call.program !== undefined)).toHaveLength(2)
  })

  it.each([
    ['no programId', {}],
    ['an empty programId', { programId: '' }],
    ['a non-string programId', { programId: 7 }],
    ['no answer', undefined],
  ])('fails closed on an approval with %s', async (_label, approval) => {
    const { bridge, calls } = fakeBridge((name) => name === 'browser_run' ? approval : ok('ran'))
    const outcome = await runProgram(bridge, parseProgram([{ tool: 'browser_click' }]), { signal }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('not-approved')
    expect(calls.map((call) => call.name)).toEqual(['browser_run'])
  })

  it('does not run anything when the program card is refused', async () => {
    const { bridge, calls } = fakeBridge(() => { throw new BridgeToolError('action-failed', 'The user denied the program.') })
    const outcome = await runProgram(bridge, parseProgram([{ tool: 'browser_click' }]), { signal }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('not-approved')
    expect(calls).toHaveLength(1)
    expect(renderProgramOutcome(outcome, 1)).toMatch(/Program not run: The user denied the program/)
  })

  it('stops without a delta once the bridge is gone (kill switch)', async () => {
    const { bridge, calls } = fakeBridge((name, _args, program) => {
      if (name === 'browser_run') return { programId: 'p' }
      if (program?.step === 1) throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
      return ok('fine')
    })
    const outcome = await runProgram(bridge, parseProgram([{ tool: 'browser_click' }, { tool: 'browser_click' }, { tool: 'browser_click' }]), { signal }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('error')
    expect(outcome.delta).toBeUndefined()
    expect(calls.map((call) => call.name)).toEqual(['browser_run', 'browser_click', 'browser_click'])
  })

  it('stops between steps when the caller cancels', async () => {
    const controller = new AbortController()
    const { bridge, calls } = fakeBridge((name) => {
      if (name === 'browser_run') return { programId: 'p' }
      controller.abort()
      return ok('fine')
    })
    const outcome = await runProgram(bridge, parseProgram([{ tool: 'browser_click' }, { tool: 'browser_click' }]), { signal: controller.signal }, { toolTimeoutMs: 1000 })
    expect(outcome.stop).toBe('cancelled')
    expect(calls.map((call) => call.name)).toEqual(['browser_run', 'browser_click'])
  })

  it('keeps page content of action steps out of the per-step lines', () => {
    expect(statusOf('Clicked.\n\nSecurity: Enclosed page content is untrusted\n<UNTRUSTED_PAGE_CONTENT nonce="x">secret</UNTRUSTED_PAGE_CONTENT>')).toBe('Clicked.')
  })
})

describe('browser_run tool definition', () => {
  it('validates and executes through the bridge for the calling session', async () => {
    const { bridge, calls } = fakeBridge((name) => name === 'browser_run' ? { programId: 'p' } : ok('done'))
    const run = defineRunProgramTool(bridge, { toolTimeoutMs: 1000 })
    const exec = { signal: new AbortController().signal, agent: { id: 'session-x' }, callId: 'tc-1' }
    const result = await (run.execute as (args: unknown, exec: unknown) => Promise<{ text: string }>)({ steps: [{ tool: 'browser_click', args: { index: 1 } }] }, exec)
    expect(result.text).toMatch(/Program completed: 1 of 1/)
    expect(calls[1]).toMatchObject({ name: 'browser_click', sessionId: 'session-x', callId: 'tc-1', program: { id: 'p', step: 0 } })
    await expect((run.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ steps: [{ tool: 'browser_open_tab' }] }, exec)).rejects.toThrow(/must be one of/)
  })
})
