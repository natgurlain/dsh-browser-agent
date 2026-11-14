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
 * Active means: a side panel is open, a tool call or approval is in flight,
 * or one happened within {@link RUNTIME_IDLE_MS}. Once none of that holds the
 * keeper reports idle, the bridge is closed, the alarm is cleared, and the
 * worker is allowed to sleep until a panel opens again.
 *
 * @module
 */

/** How long after the last activity the runtime stays connected without a panel. */
export const RUNTIME_IDLE_MS = 5 * 60_000

/** Heartbeat cadence; below the ~30 s idle cutoff of MV3 workers. */
export const RUNTIME_HEARTBEAT_MS = 20_000

/** `chrome.storage.session` key holding `{ activeUntil }` while the runtime is active. */
export const RUNTIME_LEASE_STORAGE_KEY = 'dshRuntimeLease'

/** Live counters the lease reads on every evaluation. */
export interface RuntimeActivity {
  panels(): number
  toolCalls(): number
  approvals(): number
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

  /** Whether the runtime should stay connected and awake. */
  active(): boolean {
    return this.busy() || this.now() - this.lastActivityAt < this.idleMs
  }

  /** When the lease ends if nothing else happens (epoch ms). */
  activeUntil(): number {
    return this.busy() ? this.now() + this.idleMs : this.lastActivityAt + this.idleMs
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
