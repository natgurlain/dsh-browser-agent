import { mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateWorkflow, WORKFLOW_FORMAT } from '../src/learning/workflow.ts'
import { WorkflowSchedules, type ScheduleServiceLike } from '../src/learning/schedules.ts'
import { tempDirs } from './support/tmp.ts'

const tempDir = tempDirs('dsh-proof-')

describe('a schedule whose record cannot be written (refactor-security F1)', () => {
  it('is deleted from DSH again, so no unlisted standing schedule survives', async () => {
    const tasks = new Map<string, Record<string, unknown>>()
    const service: ScheduleServiceLike = {
      create: vi.fn(async (request) => { const id = `schedule-${String(tasks.size + 1)}`; tasks.set(id, { id, ...request, status: 'active' }); return { id, status: 'active' } }),
      catalog: vi.fn(async () => [...tasks.values()] as Array<{ id: string }>),
      edit: vi.fn(async (request) => { tasks.delete(request.id); return { deleted: true } }),
    }
    const dir = tempDir()
    const file = join(dir, 'schedules.json')
    const schedules = new WorkflowSchedules(file, () => service, async () => true)
    const workflow = validateWorkflow({
      format: WORKFLOW_FORMAT, name: 'add-contact', description: 'x', origin: 'https://crm.example', createdAt: '2026-11-15T00:00:00.000Z',
      params: [], steps: [{ tool: 'browser_navigate', args: { url: 'https://crm.example/new' } }],
    })
    mkdirSync(file) // any write failure: ENOSPC, EACCES, a symlink at the target (new refusal), ...
    await expect(schedules.create('owned', workflow, { kind: 'every', every_seconds: 60 })).rejects.toThrow()
    rmdirSync(file)
    expect([...tasks.keys()]).toEqual([])
    expect(service.edit).toHaveBeenCalledWith({ id: 'schedule-1', action: 'delete' })
    expect(await schedules.count()).toBe(0)
  })

  it('stays revocable by the kill switch when the undo also fails', async () => {
    const tasks = new Map<string, Record<string, unknown>>()
    let undoFails = true
    const service: ScheduleServiceLike = {
      create: vi.fn(async (request) => { const id = `schedule-${String(tasks.size + 1)}`; tasks.set(id, { id, ...request, status: 'active' }); return { id, status: 'active' } }),
      catalog: vi.fn(async () => [...tasks.values()] as Array<{ id: string }>),
      edit: vi.fn(async (request) => { if (undoFails) throw new Error('host busy'); tasks.delete(request.id); return { deleted: true } }),
    }
    const dir = tempDir()
    const file = join(dir, 'schedules.json')
    const schedules = new WorkflowSchedules(file, () => service, async () => true)
    const workflow = validateWorkflow({
      format: WORKFLOW_FORMAT, name: 'add-contact', description: 'x', origin: 'https://crm.example', createdAt: '2026-11-15T00:00:00.000Z',
      params: [], steps: [{ tool: 'browser_navigate', args: { url: 'https://crm.example/new' } }],
    })
    mkdirSync(file)
    await expect(schedules.create('owned', workflow, { kind: 'every', every_seconds: 60 })).rejects.toThrow()
    rmdirSync(file)
    expect([...tasks.keys()]).toEqual(['schedule-1'])
    undoFails = false
    expect((await schedules.revokeAll()).revoked).toBe(1)
    expect([...tasks.keys()]).toEqual([])
  })
})
