/**
 * Scheduled workflow replays through DSH's Host-wide schedule (`ctx.schedule`).
 *
 * A schedule targets the session that owns the workflow (`target: session`)
 * and, at each occurrence, delivers a prompt asking that session's agent to
 * call `browser_workflow_run`. The replay itself then runs step by step
 * through the bridge, so every step that needs an approval card still asks;
 * with no side panel open that card goes to the notification / Host approval
 * path and fails closed when nobody answers.
 *
 * Only sessions the bridge owns may be scheduled, and the panel can list and
 * cancel only schedules this bridge created: their ids are recorded in a 0600
 * file under the dsh home (a title prefix would be spoofable by the model's
 * own schedule tool).
 *
 * @module @natgurlain/dsh-browser-agent/src/learning/schedules
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { serialQueue, writePrivateFile } from '../private-file.ts'
import type { Workflow } from './workflow.ts'

/** DSH's per-task delivery floor (seconds). */
export const SCHEDULE_MIN_INTERVAL_SECONDS = 60

/** The subset of `ctx.schedule` used here. */
export interface ScheduleServiceLike {
  create(request: {
    title: string
    prompt: string
    timing: ScheduleTimingInput
    target: { kind: 'session'; sessionId: string }
  }, actorSessionId?: string, signal?: AbortSignal): Promise<{ id: string } & Record<string, unknown>>
  catalog(): Promise<Array<{ id: string; status?: string; target?: unknown; scheduledAt?: unknown } & Record<string, unknown>>>
  edit(request: { id: string; action: 'delete' }, actorSessionId?: string, signal?: AbortSignal): Promise<unknown>
}

/** Timing the panel may request. */
export type ScheduleTimingInput =
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }

/** One schedule as the panel shows it. */
export interface WorkflowSchedule {
  id: string
  sessionId: string
  workflow: string
  timing: ScheduleTimingInput
  status: string
  nextAt?: string
}

interface ScheduleRecordEntry {
  id: string
  sessionId: string
  workflow: string
  timing: ScheduleTimingInput
  /** The extension install (bridge client key) whose user created it; absent on older records. */
  install?: string
}

/** Validate panel-supplied timing (every ≥ 60 s, or a daily wall-clock time). */
export function parseScheduleTiming(value: unknown): ScheduleTimingInput {
  const record = value as Record<string, unknown> | undefined
  if (record?.kind === 'every') {
    const seconds = record.every_seconds
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < SCHEDULE_MIN_INTERVAL_SECONDS || seconds > 366 * 86_400) {
      throw new Error(`the interval must be a whole number of seconds, at least ${String(SCHEDULE_MIN_INTERVAL_SECONDS)}.`)
    }
    return { kind: 'every', every_seconds: seconds }
  }
  if (record?.kind === 'daily') {
    const daily = record.daily as Record<string, unknown> | undefined
    const time = daily?.time
    const zone = daily?.time_zone
    if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(time)) throw new Error('daily time must be HH:mm.')
    if (typeof zone !== 'string' || zone === '' || zone.length > 64) throw new Error('daily time_zone must be an IANA zone name.')
    return { kind: 'daily', daily: { time: time.length === 5 ? `${time}:00` : time, time_zone: zone } }
  }
  throw new Error('timing must be { kind: "every", every_seconds } or { kind: "daily", daily: { time, time_zone } }.')
}

/** The prompt delivered to the owning session at each occurrence. */
export function schedulePrompt(workflow: Pick<Workflow, 'name'>, params: Record<string, string>): string {
  const args = Object.keys(params).length === 0 ? { name: workflow.name } : { name: workflow.name, params }
  return `Scheduled run of the saved browser workflow "${workflow.name}". Call browser_workflow_run ${JSON.stringify(args)} now `
    + 'and report the outcome in one or two sentences. If a step needs a decision, stop and explain instead of guessing.'
}

/** Schedules created by this bridge, persisted so ownership survives restarts. */
export class WorkflowSchedules {
  private cache: ScheduleRecordEntry[] | undefined
  private readonly serialized = serialQueue()

  constructor(
    private readonly file: string,
    private readonly schedule: () => ScheduleServiceLike | undefined,
    private readonly ownsSession: (sessionId: string) => Promise<boolean>,
  ) {}

  /**
   * The recorded schedules. Unlike the ledger and watcher records this read
   * has no ownership or mode check, on purpose: these records only let the
   * bridge list and delete schedules (they grant no access), and an ignored
   * file would make the kill switch revoke nothing while the schedules keep
   * firing in DSH.
   */
  private async records(): Promise<ScheduleRecordEntry[]> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.cache = Array.isArray(parsed)
        ? parsed.filter((entry): entry is ScheduleRecordEntry => typeof entry === 'object' && entry !== null
          && typeof (entry as ScheduleRecordEntry).id === 'string' && typeof (entry as ScheduleRecordEntry).sessionId === 'string')
        : []
    } catch {
      this.cache = []
    }
    return this.cache
  }

  private async persist(records: ScheduleRecordEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    await writePrivateFile(this.file, `${JSON.stringify(records, null, 2)}\n`, 'the workflow schedule records')
    // Only a durable write updates what this process believes.
    this.cache = records
  }

  private service(): ScheduleServiceLike {
    const service = this.schedule()
    if (service === undefined) throw new Error('this dsh host has no schedule service, so workflows cannot be scheduled.')
    return service
  }

  /** Create a schedule that replays `workflow` in its owning session. */
  create(sessionId: string, workflow: Workflow, timing: ScheduleTimingInput, params: Record<string, string> = {}, install?: string): Promise<WorkflowSchedule> {
    return this.serialized(async () => {
      if (!await this.ownsSession(sessionId)) throw new Error('only sessions created by the browser bridge can be scheduled.')
      for (const param of workflow.params) {
        if (param.sensitive === true) throw new Error(`workflow "${workflow.name}" fills a sensitive field ("${param.name}"); it cannot run unattended because that value is never stored.`)
        if (param.default === undefined && params[param.name] === undefined) throw new Error(`parameter "${param.name}" needs a value for scheduled runs.`)
      }
      const created = await this.service().create({
        title: `Browser workflow: ${workflow.name}`.slice(0, 120),
        prompt: schedulePrompt(workflow, params),
        timing,
        target: { kind: 'session', sessionId },
      })
      const records = await this.records()
      const next = [...records, { id: created.id, sessionId, workflow: workflow.name, timing, ...(install === undefined ? {} : { install }) }]
      try {
        await this.persist(next)
      } catch (error: unknown) {
        // Never leave a live DSH schedule this bridge cannot list, cancel or revoke:
        // undo it, and if even that fails keep it in memory for the kill switch.
        await this.service().edit({ id: created.id, action: 'delete' }).catch(() => { this.cache = next })
        throw error
      }
      return { id: created.id, sessionId, workflow: workflow.name, timing, status: String(created.status ?? 'active') }
    })
  }

  /** Schedules this bridge created that still exist, optionally for one session. */
  list(sessionId?: string): Promise<WorkflowSchedule[]> {
    return this.serialized(async () => {
      const records = await this.records()
      const service = this.schedule()
      if (service === undefined) return []
      const catalog = new Map((await service.catalog()).map((entry) => [entry.id, entry]))
      const alive = records.filter((record) => catalog.has(record.id))
      if (alive.length !== records.length) await this.persist(alive)
      const visible: WorkflowSchedule[] = []
      for (const record of alive) {
        if (sessionId !== undefined && record.sessionId !== sessionId) continue
        if (!await this.ownsSession(record.sessionId)) continue
        const entry = catalog.get(record.id)!
        visible.push({
          ...record,
          status: typeof entry.status === 'string' ? entry.status : 'active',
          ...(typeof entry.scheduledAt === 'string' ? { nextAt: entry.scheduledAt } : {}),
        })
      }
      return visible
    })
  }

  /** Number of schedules this bridge recorded (live or not yet swept). */
  count(): Promise<number> {
    return this.serialized(async () => (await this.records()).length)
  }

  /**
   * How many recorded schedules each install created. The key is the bridge
   * client key; `undefined` collects older records that name no install
   * (any connected browser may be the one they need).
   */
  countByInstall(): Promise<Map<string | undefined, number>> {
    return this.serialized(async () => {
      const counts = new Map<string | undefined, number>()
      for (const record of await this.records()) counts.set(record.install, (counts.get(record.install) ?? 0) + 1)
      return counts
    })
  }

  /**
   * Delete the schedules this bridge created (all of them for the kill
   * switch; one install's when its user turns workflows off): a schedule is
   * a standing grant to run the browser unattended. Deletion failures are
   * reported and their records kept, so the panel can still list and cancel
   * a schedule that keeps firing (`list` sweeps records whose schedule is gone).
   * @param install - only schedules created from this install (plus older records that name none).
   */
  revokeAll(install?: string): Promise<{ revoked: number; failed: number }> {
    return this.serialized(async () => this.revokeWhere(
      (record) => install === undefined || record.install === undefined || record.install === install,
    ))
  }

  /**
   * Delete the schedules targeting one (purged) session. Like
   * {@link revokeAll}, a record whose delete failed is kept.
   */
  revokeSession(sessionId: string): Promise<{ revoked: number; failed: number }> {
    return this.serialized(async () => this.revokeWhere((record) => record.sessionId === sessionId))
  }

  /** Delete the matching schedules; keep the records of those whose delete failed. Call inside {@link serialized}. */
  private async revokeWhere(matches: (record: ScheduleRecordEntry) => boolean): Promise<{ revoked: number; failed: number }> {
    const all = await this.records()
    const records = all.filter(matches)
    if (records.length === 0) return { revoked: 0, failed: 0 }
    const service = this.schedule()
    const deleted: ScheduleRecordEntry[] = []
    for (const record of records) {
      try {
        if (service === undefined) throw new Error('no schedule service')
        await service.edit({ id: record.id, action: 'delete' })
        deleted.push(record)
      } catch { /* counted below; the record stays so the panel can retry */ }
    }
    if (deleted.length > 0) await this.persist(all.filter((record) => !deleted.includes(record)))
    return { revoked: deleted.length, failed: records.length - deleted.length }
  }

  /** Cancel (delete) one schedule this bridge created. */
  cancel(id: string): Promise<boolean> {
    return this.serialized(async () => {
      const records = await this.records()
      const record = records.find((candidate) => candidate.id === id)
      if (record === undefined) throw new Error('that schedule was not created by the browser bridge.')
      if (!await this.ownsSession(record.sessionId)) throw new Error('that schedule targets a session the browser bridge does not own.')
      await this.service().edit({ id, action: 'delete' })
      await this.persist(records.filter((candidate) => candidate.id !== id))
      return true
    })
  }
}
