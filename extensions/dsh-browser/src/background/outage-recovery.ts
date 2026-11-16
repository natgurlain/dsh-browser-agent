/**
 * Outage recovery: what happens when a bridge that was connected goes away
 * while a panel is open.
 *
 * A panel open means the user is there and waiting, and the usual cause is
 * ordinary: DSH was restarted (the desktop app picks a new port on every
 * launch). So for a bounded period the background keeps looking by itself,
 * with growing pauses, and the panel stays `reconnecting` on its conversation.
 * Only when the period ends without an answer does the connection stop with
 * "not found", as a single failed discovery pass used to do at once.
 *
 * This module is the schedule only (when to look, when to give up). What one
 * attempt does, and what counts as an outage rather than a refusal, is the
 * caller's (index.ts): a refusal is an answer and ends the recovery; an
 * unreachable address is not.
 *
 * @module
 */

/** Pause before the first attempt; doubled after every attempt that found nothing. */
export const OUTAGE_RETRY_BASE_MS = 1_000
/** Longest pause between two attempts. */
export const OUTAGE_RETRY_MAX_MS = 15_000
/** How long an outage is retried before the connection stops with "not found". */
export const OUTAGE_RETRY_PERIOD_MS = 10 * 60_000

/** Side effects of the schedule; injectable so it is testable with a fake clock. */
export interface OutageRecoveryEnv {
  now(): number
  setTimer(run: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
  /** Look for the bridge once. */
  attempt(): Promise<void>
  /** The period ended with the bridge still away. */
  giveUp(): void
}

/** The retry schedule of one outage. */
export class OutageRecovery {
  private startedAt: number | undefined
  private timer: unknown
  private dueAt = 0
  private delay = OUTAGE_RETRY_BASE_MS
  private attempting = false
  /** Invalidates the attempt in flight when the outage ends or another begins. */
  private epoch = 0

  constructor(private readonly env: OutageRecoveryEnv) {}

  /** Whether an outage is being retried. */
  get active(): boolean {
    return this.startedAt !== undefined
  }

  /** Start retrying; a recovery already under way keeps its clock. */
  begin(): void {
    if (this.startedAt !== undefined) return
    this.startedAt = this.env.now()
    this.epoch += 1
    this.delay = OUTAGE_RETRY_BASE_MS
    this.schedule()
  }

  /** The outage is over (connected, refused, stopped by the user, no panel left). */
  end(): void {
    if (this.startedAt === undefined) return
    this.startedAt = undefined
    this.epoch += 1
    this.attempting = false
    if (this.timer !== undefined) this.env.clearTimer(this.timer)
    this.timer = undefined
  }

  /**
   * A wake-up from outside the schedule (the keepalive alarm). Timers do not
   * survive everything a service worker goes through, so an attempt that is
   * overdue runs now; one that is not yet due is left alone.
   */
  tick(): void {
    if (this.startedAt === undefined || this.attempting) return
    if (this.env.now() < this.dueAt) return
    this.run()
  }

  /**
   * Something was just learned (a candidate was ruled out): look again after
   * the base pause instead of the grown one.
   */
  soon(): void {
    if (this.startedAt === undefined) return
    this.delay = OUTAGE_RETRY_BASE_MS
    if (!this.attempting) this.schedule()
  }

  private schedule(): void {
    if (this.timer !== undefined) this.env.clearTimer(this.timer)
    this.dueAt = this.env.now() + this.delay
    this.timer = this.env.setTimer(() => { this.run() }, this.delay)
  }

  private run(): void {
    const startedAt = this.startedAt
    if (startedAt === undefined || this.attempting) return
    if (this.timer !== undefined) this.env.clearTimer(this.timer)
    this.timer = undefined
    if (this.env.now() - startedAt >= OUTAGE_RETRY_PERIOD_MS) {
      this.end()
      this.env.giveUp()
      return
    }
    const epoch = this.epoch
    this.attempting = true
    const delay = this.delay
    void this.env.attempt().catch(() => {}).then(() => {
      if (epoch !== this.epoch) return
      this.attempting = false
      // `soon()` during the attempt already put the pause back to the base.
      this.delay = this.delay < delay ? this.delay : Math.min(OUTAGE_RETRY_MAX_MS, delay * 2)
      // The last wait never runs past the end of the period.
      const left = startedAt + OUTAGE_RETRY_PERIOD_MS - this.env.now()
      this.delay = Math.max(0, Math.min(this.delay, left))
      this.schedule()
    })
  }
}
