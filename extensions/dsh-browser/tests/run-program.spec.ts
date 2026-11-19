// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { PROGRAM_STEP_TOOLS as BRIDGE_STEP_TOOLS } from '@natgurlain/dsh-browser-agent/src/run-program.ts'
import {
  approveProgram,
  coverByProgram,
  ordinaryActionCard,
  parseProgramSteps,
  PROGRAM_GRANT_TTL_MS,
  PROGRAM_STEP_TOOLS,
  programApprovalPrompt,
  ProgramGrants,
} from '../src/background/run-program.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'
import type { TabFrame } from '../src/background/frames.ts'

const frames: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'doc-1', url: 'https://shop.example/cart' }]
const steps = [
  { tool: 'browser_type', args: { selector: '#q', text: 'socks' } },
  { tool: 'browser_click', args: { index: 4 }, expect: { text: 'Results' } },
  { tool: 'browser_navigate', args: { url: 'https://pay.example/checkout' } },
]
const action = (origins: string[], extra: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  kind: 'action', action: 'browser_click', summary: 'Click', origins, canTrust: true, ...extra,
})

describe('program card', () => {
  it('matches the bridge step allowlist', () => {
    expect([...PROGRAM_STEP_TOOLS].sort()).toEqual([...BRIDGE_STEP_TOOLS].sort())
  })

  it('shows every step with its full payload and binds the program, origins, and document', () => {
    const prompt = programApprovalPrompt(steps, frames)
    expect(prompt.kind).toBe('action')
    expect(prompt.canTrust).toBe(false)
    expect(prompt.origins).toEqual(['https://shop.example', 'https://pay.example'])
    expect(prompt.details).toHaveLength(3)
    expect(prompt.details![0]).toMatchObject({ kind: 'text', label: 'Step 1: browser_type', masked: false })
    expect((prompt.details![0] as { value: string }).value).toContain('"text": "socks"')
    expect((prompt.details![1] as { value: string }).value).toContain('"expect"')
    const changedStep = programApprovalPrompt([{ ...steps[0]!, args: { selector: '#q', text: 'shoes' } }, ...steps.slice(1)], frames)
    expect(changedStep.binding).not.toBe(prompt.binding)
    const otherDocument = programApprovalPrompt(steps, [{ ...frames[0]!, documentId: 'doc-2' }])
    expect(otherDocument.binding).not.toBe(prompt.binding)
  })

  it('refuses steps a program cannot run', () => {
    expect(parseProgramSteps([{ tool: 'browser_open_tab', args: {} }])).toMatch(/cannot run/)
    expect(parseProgramSteps([{ tool: 'browser_run', args: {} }])).toMatch(/cannot run/)
    expect(parseProgramSteps([])).toMatch(/non-empty/)
    expect(parseProgramSteps(Array.from({ length: 26 }, () => ({ tool: 'browser_snapshot' })))).toMatch(/at most 25/)
  })
})

describe('ProgramGrants', () => {
  it('covers ordinary action cards of the next approved step on a named origin only', () => {
    const grants = new ProgramGrants()
    grants.approve('p1', 's1', steps, ['https://shop.example', 'https://pay.example'])
    const cover = grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'socks' }, sessionId: 's1', program: { id: 'p1', step: 0 } })
    expect(cover).toBeDefined()
    expect(cover!.covers(action(['https://shop.example']))).toBe(true)
    expect(cover!.covers(action(['https://evil.example']))).toBe(false)
    expect(cover!.covers(action([]))).toBe(false)
    // Never pre-approved implicitly: forced (site rule, taint, strict), per-call-only, devtools, risky URL, permission, reads.
    for (const extra of [{ forced: true as const }, { perCallOnly: true as const }, { devTools: true as const }, { urlRisk: true as const }, { permission: 'downloads' as const }, { kind: 'read' as const }]) {
      expect(cover!.covers(action(['https://shop.example'], extra))).toBe(false)
      expect(ordinaryActionCard(action(['https://shop.example'], extra))).toBe(false)
    }
  })

  it('refuses out-of-order, altered, foreign-session, and expired steps, and revokes the program', () => {
    let now = 0
    const grants = new ProgramGrants(() => now)
    grants.approve('p1', 's1', steps, ['https://shop.example'])
    expect(grants.claim({ name: 'browser_click', args: { index: 4 }, sessionId: 's1', program: { id: 'p1', step: 1 } })).toBeUndefined()
    // The out-of-order claim revoked the grant: even the right step 0 is no longer covered.
    expect(grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'socks' }, sessionId: 's1', program: { id: 'p1', step: 0 } })).toBeUndefined()

    grants.approve('p2', 's1', steps, ['https://shop.example'])
    expect(grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'other' }, sessionId: 's1', program: { id: 'p2', step: 0 } })).toBeUndefined()
    grants.approve('p3', 's1', steps, ['https://shop.example'])
    expect(grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'socks' }, sessionId: 's2', program: { id: 'p3', step: 0 } })).toBeUndefined()
    grants.approve('p4', 's1', steps, ['https://shop.example'])
    now = PROGRAM_GRANT_TTL_MS + 1
    expect(grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'socks' }, sessionId: 's1', program: { id: 'p4', step: 0 } })).toBeUndefined()
    expect(grants.claim({ name: 'browser_type', args: {}, sessionId: 's1' })).toBeUndefined()
  })

  it('runs out after the last step and clears on the kill switch', () => {
    const grants = new ProgramGrants()
    grants.approve('p1', undefined, steps.slice(0, 1), ['https://shop.example'])
    expect(grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'socks' }, program: { id: 'p1', step: 0 } })).toBeDefined()
    expect(grants.size).toBe(0)
    grants.approve('p2', undefined, steps, ['https://shop.example'])
    grants.clear()
    expect(grants.size).toBe(0)
  })

  it('lets a covered card through without showing it and shows every other card', async () => {
    const authorize = vi.fn(async () => 'denied' as const)
    const onCovered = vi.fn()
    const grants = new ProgramGrants()
    grants.approve('p1', 's1', steps, ['https://shop.example'])
    const cover = grants.claim({ name: 'browser_type', args: { selector: '#q', text: 'socks' }, sessionId: 's1', program: { id: 'p1', step: 0 } })
    const wrapped = coverByProgram(cover, authorize, onCovered)
    await expect(wrapped(action(['https://shop.example']))).resolves.toBe('approved')
    expect(authorize).not.toHaveBeenCalled()
    expect(onCovered).toHaveBeenCalledTimes(1)
    await expect(wrapped(action(['https://shop.example'], { forced: true }))).resolves.toBe('denied')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(coverByProgram(undefined, authorize, onCovered)).toBe(authorize)
  })
})

describe('program grant pinning (review finding 9)', () => {
  const program = [
    { tool: 'browser_click', args: { index: 3 } },
    { tool: 'browser_navigate', args: { url: 'https://shop.example/cart' } },
    { tool: 'browser_click', args: { index: 4 } },
    { tool: 'browser_click', args: { selector: '#pay' } },
  ]
  const claim = (grants: ProgramGrants, step: number, tabId: number | undefined) =>
    grants.claim({ name: program[step]!.tool, args: program[step]!.args, sessionId: 's1', program: { id: 'p', step } }, tabId)

  it('a step on another tab revokes the grant', () => {
    const grants = new ProgramGrants()
    grants.approve('p', 's1', program, ['https://shop.example'], 7)
    expect(claim(grants, 0, 8)).toBeUndefined()
    expect(claim(grants, 0, 7)).toBeUndefined()
    expect(grants.size).toBe(0)
  })

  it('after a navigation, index-targeted steps ask; selector steps ride the card', () => {
    const grants = new ProgramGrants()
    grants.approve('p', 's1', program, ['https://shop.example'], 7)
    expect(claim(grants, 0, 7)!.covers(action(['https://shop.example']))).toBe(true)
    expect(claim(grants, 1, 7)!.covers(action(['https://shop.example']))).toBe(true)
    expect(claim(grants, 2, 7)!.covers(action(['https://shop.example']))).toBe(false)
    expect(claim(grants, 3, 7)!.covers(action(['https://shop.example']))).toBe(true)
  })

  it('treats drag from/to indexes as snapshot indexes', async () => {
    const { usesSnapshotIndex } = await import('../src/background/run-program.ts')
    expect(usesSnapshotIndex({ from: { index: 2 }, to: { selector: '#bin' } })).toBe(true)
    expect(usesSnapshotIndex({ from: { selector: '#a' }, to: { index: 5 } })).toBe(true)
    expect(usesSnapshotIndex({ from: { selector: '#a' }, toOffset: { x: 1, y: 1 } })).toBe(false)
    expect(usesSnapshotIndex({ selector: '#a' })).toBe(false)
  })

  it('approveProgram pins the grant to the approved tab', async () => {
    const grants = new ProgramGrants()
    await approveProgram({ id: 'p', name: 'browser_run', args: { steps: program }, sessionId: 's1' }, {
      grants, resolveTab: async () => ({ id: 7, url: frames[0]!.url, windowId: 1 }), listFrames: async () => frames,
      authorize: async () => 'approved' as const, signal: new AbortController().signal,
    })
    expect(claim(grants, 0, 9)).toBeUndefined()
  })
})

describe('approveProgram', () => {
  const deps = (overrides: Partial<Parameters<typeof approveProgram>[1]> = {}) => ({
    grants: new ProgramGrants(),
    resolveTab: async () => ({ id: 7, url: frames[0]!.url, windowId: 1 }),
    listFrames: async () => frames,
    authorize: vi.fn(async () => 'approved' as const),
    signal: new AbortController().signal,
    ...overrides,
  })

  it('records a grant under the call id after the card is approved', async () => {
    const d = deps()
    const answer = await approveProgram({ id: 'call-1', name: 'browser_run', args: { steps }, sessionId: 's1' }, d)
    expect(answer).toEqual({ ok: true, result: { text: 'Program of 3 steps approved.', programId: 'call-1' } })
    expect(d.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'browser_run' }), 1)
    expect(d.grants.size).toBe(1)
  })

  it('records nothing when the card is denied or the page changed under it', async () => {
    const denied = deps({ authorize: vi.fn(async () => 'denied' as const) })
    expect(await approveProgram({ id: 'c', name: 'browser_run', args: { steps } }, denied)).toMatchObject({ ok: false, error: { message: 'The user denied the browser program.' } })
    expect(denied.grants.size).toBe(0)
    let calls = 0
    const moved = deps({ listFrames: async () => (calls++ === 0 ? frames : [{ ...frames[0]!, documentId: 'doc-2' }]) })
    expect(await approveProgram({ id: 'c', name: 'browser_run', args: { steps } }, moved)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/page changed/) } })
    expect(moved.grants.size).toBe(0)
    const bad = deps()
    expect(await approveProgram({ id: 'c', name: 'browser_run', args: { steps: [{ tool: 'browser_upload' }] } }, bad)).toMatchObject({ ok: false, error: { code: 'bad-args' } })
    expect(bad.authorize).not.toHaveBeenCalled()
  })
})
