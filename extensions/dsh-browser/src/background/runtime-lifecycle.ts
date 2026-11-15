/**
 * Panel-free runtime: when the bridge connection (and with it the MV3 service
 * worker or Firefox event page) must stay up, and when it may go to sleep.
 *
 * The browser keeps a worker alive only while it is doing extension work:
 * Chrome (116+) counts WebSocket traffic and extension API calls, and kills an
 * idle worker after about 30 s; Firefox unloads an idle event page on a
 * similar timer. So while the runtime is active the background sends a sealed
 * heartbeat on the bridge and makes one cheap extension API call every
 * {@link RUNTIME_HEARTBEAT_MS}, and a half-minute alarm (the MV3 minimum)
 * restarts the worker and the connection if the browser killed it anyway.
 * The lease end is mirrored to `chrome.storage.session` so a restarted worker
 * knows whether to reconnect; that area is cleared when the browser exits.
 *
 * Active means one of:
 * - a side panel is open, or a tool call or approval is in flight;
 * - one of those happened within {@link RUNTIME_IDLE_MS};
 * - there is standing work: something the user opted into that is meant to
 *   run unattended. That is a live page watcher in this browser (while the
 *   page-watchers setting is on), or a hint from the bridge that the Host
 *   holds workflow schedules for this install or serves the MCP endpoint.
 *   The hint is mirrored to `chrome.storage.local` with the address it came
 *   from, so it also survives a browser restart. The kill switch zeroes
 *   standing work and clears the stored hint.
 *
 * Once none of that holds the keeper reports idle, the bridge is closed, the
 * alarm is cleared, and the worker is allowed to sleep until a panel opens
 * again or standing work appears.
 *
 * When only standing work holds the lease and dsh cannot be reached, the
 * worker is not kept awake: the heartbeat stops, the half-minute alarm is
 * replaced by a one-shot alarm, and each failed attempt doubles the wait
 * ({@link StandingBackoff}) up to {@link STANDING_RETRY_MAX_MS}. A headless
 * attempt only ever dials an address already in use, never a discovery scan.
 * A connection or an opened panel restores the normal cadence.
 *
 * @module
 */

/** How long after the last activity the runtime stays connected without a panel. */
export const RUNTIME_IDLE_MS = 5 * 60_000

/** Heartbeat cadence; below the ~30 s idle cutoff of MV3 workers. */
export const RUNTIME_HEARTBEAT_MS = 20_000

/** `chrome.storage.session` key holding `{ activeUntil }` while the runtime is active. */
export const RUNTIME_LEASE_STORAGE_KEY = 'dshRuntimeLease'

/** First wait after a failed standing-work reconnect (the MV3 alarm minimum). */
export const STANDING_RETRY_BASE_MS = 30_000

/** Longest wait between standing-work reconnect attempts. */
export const STANDING_RETRY_MAX_MS = 5 * 60_000

/** `chrome.storage.session` key holding the {@link StandingBackoffState} of a parked reconnect. */
export const STANDING_RETRY_STORAGE_KEY = 'dshStandingRetry'

/** Live counters the lease reads on every evaluation. */
export interface RuntimeActivity {
  panels(): number
  toolCalls(): number
  approvals(): number
  /** Units of standing work (watchers, schedules, the MCP endpoint); absent means none. */
  standing?(): number
}

/** Decides whether the panel-free runtime should be up. */
export class RuntimeLease {
  private lastActivityAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly activity: RuntimeActivity,
    private readonly idleMs = RUNTIME_IDLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record activity (a tool call, an approval, a session event). */
  touch(): void {
    this.lastActivityAt = this.now()
  }

  /** Restore a lease persisted by a previous worker instance. */
  restore(activeUntil: number): void {
    if (!Number.isFinite(activeUntil)) return
    this.lastActivityAt = Math.max(this.lastActivityAt, Math.min(activeUntil, this.now() + this.idleMs) - this.idleMs)
  }

  /** Something is in flight right now. */
  busy(): boolean {
    return this.activity.panels() > 0 || this.activity.toolCalls() > 0 || this.activity.approvals() > 0
  }

  /** Activity happened within the idle window. */
  private recent(): boolean {
    return this.now() - this.lastActivityAt < this.idleMs
  }

  /** Whether unattended work the user opted into wants the connection. */
  private standing(): boolean {
    const count = this.activity.standing?.() ?? 0
    return Number.isFinite(count) && count > 0
  }

  /** Whether the runtime should stay connected and awake. */
  active(): boolean {
    return this.busy() || this.recent() || this.standing()
  }

  /** Active, but only because of standing work: nobody is waiting on the connection right now. */
  standingOnly(): boolean {
    return !this.busy() && !this.recent() && this.standing()
  }

  /** When the lease ends if nothing else happens (epoch ms). */
  activeUntil(): number {
    return this.busy() ? this.now() + this.idleMs : this.lastActivityAt + this.idleMs
  }
}

/** A parked standing-work reconnect: how often it failed and when it may try again (epoch ms). */
export interface StandingBackoffState {
  failures: number
  nextAt: number
}

/** Shape check for a persisted {@link StandingBackoffState}. */
export function isStandingBackoffState(value: unknown): value is StandingBackoffState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return typeof state.failures === 'number' && Number.isSafeInteger(state.failures) && state.failures > 0
    && typeof state.nextAt === 'number' && Number.isFinite(state.nextAt)
}

/**
 * Retry spacing while only standing work wants an unreachable bridge:
 * {@link STANDING_RETRY_BASE_MS}, doubling per failure, capped at
 * {@link STANDING_RETRY_MAX_MS}.
 */
export class StandingBackoff {
  private failures = 0
  private nextAt = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly baseMs = STANDING_RETRY_BASE_MS,
    private readonly maxMs = STANDING_RETRY_MAX_MS,
  ) {}

  /** A reconnect attempt failed. @returns how long to wait before the next one. */
  fail(): number {
    this.failures += 1
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.failures - 1, 30))
    this.nextAt = this.now() + delay
    return delay
  }

  /** Connected, or a panel opened: back to the normal cadence. */
  reset(): void {
    this.failures = 0
    this.nextAt = 0
  }

  /** Whether an attempt has failed since the last reset. */
  get parked(): boolean {
    return this.failures > 0
  }

  /** Whether the next attempt may run now. */
  due(): boolean {
    return this.now() >= this.nextAt
  }

  /** When the next attempt may run (epoch ms); only meaningful while parked. */
  get retryAt(): number {
    return this.nextAt
  }

  /** The state to persist, or undefined when not parked. */
  snapshot(): StandingBackoffState | undefined {
    return this.parked ? { failures: this.failures, nextAt: this.nextAt } : undefined
  }

  /**
   * Adopt the state a previous worker instance persisted. A wait longer than
   * the cap (a clock change) is clamped, so a restore can never park forever.
   */
  restore(state: unknown): void {
    if (!isStandingBackoffState(state)) return
    this.failures = state.failures
    this.nextAt = Math.min(state.nextAt, this.now() + this.maxMs)
  }
}

/** Side effects the keeper drives. */
export interface RuntimeKeeperHooks {
  /** Keep the worker and the bridge connection warm. */
  heartbeat(): void
  /** The runtime became active (arm the restart alarm). */
  onActive(): void
  /** The runtime became idle: close the bridge and let the worker sleep. */
  onIdle(): void
  /** Mirror the lease end (undefined clears it). */
  persist(activeUntil: number | undefined): void
}

interface Timers {
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** Runs the heartbeat while the lease is active and reports transitions. */
export class RuntimeKeeper {
  private timer: unknown
  private awake = false
  private persisted: number | undefined

  constructor(
    private readonly lease: RuntimeLease,
    private readonly hooks: RuntimeKeeperHooks,
    private readonly intervalMs = RUNTIME_HEARTBEAT_MS,
    private readonly timers: Timers = {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>) },
    },
  ) {}

  /** Whether the keeper currently holds the runtime awake. */
  get isAwake(): boolean {
    return this.awake
  }

  /** Re-evaluate after any change in panels, calls, approvals, or activity. */
  update(): void {
    if (this.lease.active()) {
      if (!this.awake) {
        this.awake = true
        this.timer = this.timers.setInterval(() => { this.tick() }, this.intervalMs)
        this.hooks.onActive()
      }
      this.persist(this.lease.activeUntil())
      return
    }
    if (!this.awake) return
    this.awake = false
    this.timers.clearInterval(this.timer)
    this.timer = undefined
    this.persist(undefined)
    this.hooks.onIdle()
  }

  /** Write the current lease state now (its other inputs, like the address, changed). */
  persistNow(): void {
    if (!this.awake) return
    this.persisted = undefined
    this.persist(this.lease.activeUntil())
  }

  private tick(): void {
    if (!this.lease.active()) {
      this.update()
      return
    }
    this.hooks.heartbeat()
    this.persist(this.lease.activeUntil())
  }

  /** Write the lease end only when it moved noticeably (storage writes are not free). */
  private persist(activeUntil: number | undefined): void {
    if (activeUntil === undefined) {
      if (this.persisted === undefined) return
      this.persisted = undefined
      this.hooks.persist(undefined)
      return
    }
    if (this.persisted !== undefined && Math.abs(activeUntil - this.persisted) < this.intervalMs) return
    this.persisted = activeUntil
    this.hooks.persist(activeUntil)
  }
}
