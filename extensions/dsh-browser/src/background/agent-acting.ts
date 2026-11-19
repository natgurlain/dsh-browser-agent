/**
 * When the on-page frame and pill ("AI controlling · Stop") show: only while
 * a turn is acting on a tab, from its first tool call until the turn ends or
 * the user takes over. A connected panel with nothing asked shows nothing on
 * the page.
 *
 * The turn end comes from DSH (`turn/end` of the session). A caller without
 * one (a call without a session, another app's `mcp-` session) has no turn
 * the extension sees end, so its pill goes once its calls have been idle for
 * {@link IDLE_WITHOUT_TURN_MS}; a panel session whose turn end does not
 * arrive (a lost event) loses it after {@link TURN_FALLBACK_MS} idle.
 *
 * @module
 */

import { EXTERNAL_SESSION_PREFIX } from '@natgurlain/dsh-browser-agent/src/protocol.ts'

/** Idle time after which a caller without a visible turn stops showing as acting. */
export const IDLE_WITHOUT_TURN_MS = 12_000
/** Idle time after which a session whose turn end never arrived stops showing as acting. */
export const TURN_FALLBACK_MS = 120_000

/** The key of a call's caller: its session, or '' for a call without one. */
function keyOf(sessionId: string | undefined): string {
  return sessionId ?? ''
}

interface Timers {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** Which callers are acting right now. */
export class ActingTurns {
  private readonly acting = new Map<string, { inFlight: number; idle?: unknown }>()

  constructor(private readonly onChange: () => void, private readonly timers: Timers = REAL_TIMERS) {}

  /** A tool call of `sessionId` is being dispatched. */
  begin(sessionId: string | undefined): void {
    const key = keyOf(sessionId)
    const entry = this.acting.get(key)
    if (entry !== undefined) {
      if (entry.idle !== undefined) this.timers.clear(entry.idle)
      entry.idle = undefined
      entry.inFlight += 1
      return
    }
    this.acting.set(key, { inFlight: 1 })
    this.onChange()
  }

  /** A call that {@link begin} counted has settled. */
  settled(sessionId: string | undefined): void {
    const key = keyOf(sessionId)
    const entry = this.acting.get(key)
    if (entry === undefined) return
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    if (entry.inFlight > 0) return
    if (entry.idle !== undefined) this.timers.clear(entry.idle)
    const ownTurn = sessionId !== undefined && !sessionId.startsWith(EXTERNAL_SESSION_PREFIX)
    entry.idle = this.timers.set(() => { this.end(key) }, ownTurn ? TURN_FALLBACK_MS : IDLE_WITHOUT_TURN_MS)
  }

  /** DSH reported the end of the session's turn. */
  turnEnded(sessionId: string): void {
    this.end(keyOf(sessionId))
  }

  /** The user took over, or the kill switch stopped everything. */
  clear(): void {
    if (this.acting.size === 0) return
    for (const entry of this.acting.values()) if (entry.idle !== undefined) this.timers.clear(entry.idle)
    this.acting.clear()
    this.onChange()
  }

  /** The acting callers: session ids, `undefined` for calls without a session. */
  sessions(): Array<string | undefined> {
    return [...this.acting.keys()].map((key) => key === '' ? undefined : key)
  }

  private end(key: string): void {
    const entry = this.acting.get(key)
    if (entry === undefined) return
    if (entry.idle !== undefined) this.timers.clear(entry.idle)
    this.acting.delete(key)
    this.onChange()
  }
}
