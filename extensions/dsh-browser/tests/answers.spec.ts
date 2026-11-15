// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { approvalFailure, cancelledAnswer, fail, notApprovedAnswer } from '../src/background/answers.ts'
import { classifyFailure } from '../src/background/learning.ts'

const OUTCOMES = ['denied', 'unavailable', 'timed-out', 'cancelled'] as const

describe('shared tool answers', () => {
  it('builds ordinary approval failures with the wire codes the bridge expects', () => {
    expect(approvalFailure({ action: 'browser_click' }, 'denied')).toEqual({ ok: false, error: { code: 'action-failed', message: 'The user denied the browser approval request for "browser_click".' } })
    expect(approvalFailure({ action: 'browser_click' }, 'timed-out').error?.code).toBe('timeout')
    expect(approvalFailure({ action: 'browser_click' }, 'cancelled').error?.code).toBe('bridge-closed')
    expect(approvalFailure({ action: 'browser_click' }, 'unavailable').error?.code).toBe('action-failed')
  })

  it('builds lane approval failures', () => {
    expect(notApprovedAnswer('The user declined the tab fleet.', 'The tab fleet', 'denied')).toEqual({ ok: false, error: { code: 'action-failed', message: 'The user declined the tab fleet.' } })
    expect(notApprovedAnswer('The user declined the tab fleet.', 'The tab fleet', 'timed-out')).toEqual({ ok: false, error: { code: 'timeout', message: 'The tab fleet was not approved (timed-out).' } })
    expect(fail('nope', 'bad-args')).toEqual({ ok: false, error: { code: 'bad-args', message: 'nope' } })
  })

  it('never lets an approval or cancel answer become a failure fixture, even without the decision', () => {
    const answers = [
      cancelledAnswer(),
      ...OUTCOMES.map((outcome) => approvalFailure({ action: 'browser_click' }, outcome)),
      ...OUTCOMES.flatMap((outcome) => [
        notApprovedAnswer('The user declined the page watcher.', 'The page watcher', outcome),
        notApprovedAnswer('The user declined the tab fleet.', 'The tab fleet', outcome),
        notApprovedAnswer('The user denied the browser program.', 'The browser program', outcome),
      ]),
    ]
    for (const answer of answers) expect({ answer, failure: classifyFailure(answer, undefined, undefined, false) }).toEqual({ answer, failure: undefined })
  })
})
