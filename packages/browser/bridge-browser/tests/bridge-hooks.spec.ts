import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createKillSwitchHandler, createSessionForgetter, createSnapshotInjector } from '../src/bridge-hooks.ts'
import { DevLoop } from '../src/dev-loop.ts'
import { mountLearning, LEARNING_METHODS } from '../src/learning/index.ts'
import type { ScheduleServiceLike } from '../src/learning/schedules.ts'
import { SessionTaintRegistry } from '../src/session-taint.ts'
import { memoryWatchRecords, WakeLimiter } from '../src/watchers.ts'
import { fakeContext } from './support/fake-ctx.ts'
import { tempDirs } from './support/tmp.ts'

const tmp = tempDirs('dsh-bridge-hooks-')
const signal = new AbortController().signal

function scheduleService(ids: string[]) {
  const tasks = new Map(ids.map((id) => [id, { id, status: 'active' }]))
  const service: ScheduleServiceLike = {
    create: vi.fn(async () => ({ id: 'x', status: 'active' })),
    catalog: vi.fn(async () => [...tasks.values()]),
    edit: vi.fn(async (request) => { tasks.delete(request.id); return {} }),
  }
  return { service, tasks }
}

function learningWith(records: Array<{ id: string; sessionId: string }>) {
  const root = tmp()
  const file = join(root, 'schedules.json')
  writeFileSync(file, JSON.stringify(records.map((record) => ({ ...record, workflow: 'w', timing: { kind: 'every', every_seconds: 60 } }))))
  const { service, tasks } = scheduleService(records.map((record) => record.id))
  const { ctx, registered } = fakeContext({ get: (name) => name === 'schedule' ? service : undefined })
  const mount = mountLearning(ctx, { requestTool: vi.fn() } as never, { toolTimeoutMs: 1000, workspacePath: root, scheduleFile: file, ownsSession: async () => true })
  return { mount, tasks, registered }
}

describe('kill switch on the Host', () => {
  it('removes every dev-loop link and every workflow schedule', async () => {
    const devLoop = new DevLoop({
      enabled: true,
      unsafePreset: async () => undefined,
      listSessions: async () => ({ items: [{ sessionId: 'coding', origin: 'user' }] }),
      isBridgeSession: () => false,
      capture: vi.fn(),
      inject: vi.fn(() => 'injected' as const),
      taint: vi.fn(),
    })
    await devLoop.link('coding', 'http://localhost:3000/', signal)
    expect(devLoop.list()).toHaveLength(1)
    const { mount, tasks } = learningWith([{ id: 's1', sessionId: 'coding' }, { id: 's2', sessionId: 'other' }])
    await mount.rpc(LEARNING_METHODS.state, { workflows: true }, { connection: 'a', allowsSession: async () => true })
    const info = vi.fn()
    await createKillSwitchHandler({ devLoop, learning: () => mount, info })()
    expect(devLoop.list()).toEqual([])
    expect(tasks.size).toBe(0)
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/removed 1 dev loop link/u))
    // Nothing mounted (learning disposed): the dev loop is still cleared.
    await expect(createKillSwitchHandler({ devLoop, learning: () => undefined, info })()).resolves.toBeUndefined()
  })
})

describe('snapshot injection', () => {
  it('queues the snapshot and taints the session', () => {
    const taint = new SessionTaintRegistry()
    const inject = vi.fn()
    createSnapshotInjector(inject, taint)('s1', '[page]', 'resume')
    expect(inject).toHaveBeenCalledWith('s1', '[page]', 'resume')
    expect(taint.get('s1')).toMatchObject({ firstTool: 'snapshot-injection' })
  })
})

describe('forgetting a purged session', () => {
  it('drops taint, binding, wake history, listing cache, watchers and schedules', async () => {
    const taint = new SessionTaintRegistry()
    taint.mark('gone', 'browser_get_text')
    const limiter = new WakeLimiter(() => 1_000_000)
    limiter.admit('gone')
    const watchRecords = memoryWatchRecords()
    await watchRecords.add('w1', { sessionId: 'gone', expiresAt: Date.now() + 60_000 })
    const { mount, tasks } = learningWith([{ id: 's1', sessionId: 'gone' }, { id: 's2', sessionId: 'kept' }])
    const forgetAffinity = vi.fn()
    const policy = { forgetSession: vi.fn() }
    await createSessionForgetter({ taint, forgetAffinity, wakeLimiter: limiter, policy, watchRecords, learning: () => mount, warn: vi.fn() })('gone')
    expect(taint.isTainted('gone')).toBe(false)
    expect(forgetAffinity).toHaveBeenCalledWith('gone')
    expect(limiter.admit('gone')).toEqual({ ok: true })
    expect(policy.forgetSession).toHaveBeenCalledWith('gone')
    expect(watchRecords.get('w1')).toBeUndefined()
    expect([...tasks.keys()]).toEqual(['s2'])
  })

  it('keeps taint and the install binding while a child inherits them', async () => {
    const taint = new SessionTaintRegistry()
    taint.link('kid', 'gone')
    taint.mark('gone', 'browser_get_text')
    const forgetAffinity = vi.fn()
    const warn = vi.fn()
    const watchRecords = { removeSession: vi.fn(async () => { throw new Error('disk full') }) }
    await createSessionForgetter({ taint, forgetAffinity, wakeLimiter: new WakeLimiter(), policy: { forgetSession: vi.fn() }, watchRecords, learning: () => undefined, warn })('gone')
    expect(taint.isTainted('kid')).toBe(true)
    expect(forgetAffinity).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'))
  })
})
