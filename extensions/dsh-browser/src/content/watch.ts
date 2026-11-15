/**
 * In-page observer for standing page watchers (background/watchers.ts).
 *
 * Top frame only. The background pushes the tab's armed watchers
 * (`DSH_WATCH_ARM`, a full replacement) after every completed navigation and
 * when its worker restarts, so watchers survive both. A
 * MutationObserver (throttled), a resource PerformanceObserver, and a slow
 * interval re-evaluate every condition; when one holds the observer reports a
 * hit (`DSH_WATCH_HIT`) with a short matched excerpt. The background decides
 * whether that becomes a wake. After a delivered fire the condition must stop
 * holding before it can fire again; a refused report backs off.
 *
 * Only the matched excerpt leaves the page, and only through the background,
 * which drops it when page sharing is off.
 *
 * @module
 */

/** Mirrors background/watchers.ts WatchCondition. */
export type WatchCondition =
  | { kind: 'selector'; selector: string; gone: boolean }
  | { kind: 'text'; text: string; gone: boolean }
  | { kind: 'url'; pattern: string }
  | { kind: 'network'; pattern: string }

export interface ArmedWatch {
  id: string
  condition: WatchCondition
  /** Epoch ms the watcher was approved: network watchers only count requests started later. */
  createdAt?: number
}

const EXCERPT_CHARS = 300
const THROTTLE_MS = 400
const POLL_MS = 2_000
const BACKOFF_MS = 30_000
/** Background refusals after which this document stops reporting a watcher. */
const FINAL_REASONS = new Set(['unknown', 'wrong-tab', 'other-origin', 'disabled', 'bad-request'])

interface WatchState {
  watch: ArmedWatch
  /** Page-timeline time of the watcher's approval: network watchers only count later requests. */
  since: number
  inFlight: boolean
  fired: boolean
  holdUntil: number
}

/** Result of evaluating one condition. */
export interface Evaluation {
  met: boolean
  matched?: string
}

function excerpt(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  return compact.length > EXCERPT_CHARS ? `${compact.slice(0, EXCERPT_CHARS)}…` : compact
}

function patternTest(pattern: string): (value: string) => boolean {
  const regex = /^\/(.+)\/([dimsuv]*)$/u.exec(pattern)
  if (regex !== null) {
    try {
      const compiled = new RegExp(regex[1]!, regex[2]!.replace(/[gy]/gu, ''))
      return (value) => compiled.test(value)
    } catch {
      // Not a valid regex: match it as plain text.
    }
  }
  return (value) => value.includes(pattern)
}

/**
 * Evaluate one condition against the current document.
 * @param condition - what to look for.
 * @param since - network watchers ignore requests that started before this.
 */
export function evaluateCondition(condition: WatchCondition, since = 0, doc: Document = document): Evaluation {
  switch (condition.kind) {
    case 'selector': {
      let element: Element | null = null
      try {
        element = doc.querySelector(condition.selector)
      } catch {
        return { met: false }
      }
      if (condition.gone) return { met: element === null }
      return element === null ? { met: false } : { met: true, matched: excerpt(element.textContent ?? '') }
    }
    case 'text': {
      const body = doc.body
      const text = body === null ? '' : (body.innerText ?? body.textContent ?? '')
      const index = text.toLowerCase().indexOf(condition.text.toLowerCase())
      if (condition.gone) return { met: index === -1 }
      if (index === -1) return { met: false }
      return { met: true, matched: excerpt(text.slice(Math.max(0, index - 120), index + condition.text.length + 120)) }
    }
    case 'network': {
      const test = patternTest(condition.pattern)
      const entries = typeof performance === 'undefined' ? [] : performance.getEntriesByType('resource')
      const hit = entries.find((entry) => entry.startTime >= since && test(entry.name))
      return hit === undefined ? { met: false } : { met: true, matched: excerpt(hit.name) }
    }
    case 'url':
      // URL watchers are evaluated by the background (tabs.onUpdated).
      return { met: false }
  }
}

/** Observes armed watchers in this document. */
export class PageWatchObserver {
  private readonly states = new Map<string, WatchState>()
  private mutation: MutationObserver | undefined
  private performanceObserver: PerformanceObserver | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private throttle: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly report: (watchId: string, matched: string | undefined) => Promise<{ accepted?: unknown; reason?: unknown } | undefined>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Replace the armed set. */
  arm(watches: ArmedWatch[]): void {
    const next = new Map<string, WatchState>()
    for (const watch of watches) {
      const existing = this.states.get(watch.id)
      next.set(watch.id, existing ?? {
        watch,
        since: watch.createdAt === undefined ? 0 : Math.max(0, watch.createdAt - performance.timeOrigin),
        inFlight: false,
        fired: false,
        holdUntil: 0,
      })
    }
    this.states.clear()
    for (const [id, state] of next) this.states.set(id, state)
    if (this.states.size === 0) this.stop()
    else this.start()
    this.check()
  }

  get size(): number {
    return this.states.size
  }

  /** Evaluate every armed watcher now. */
  check(): void {
    for (const state of this.states.values()) {
      if (state.inFlight) continue
      const result = evaluateCondition(state.watch.condition, state.since)
      if (!result.met) {
        state.fired = false
        continue
      }
      if (state.fired || this.now() < state.holdUntil) continue
      state.inFlight = true
      void this.report(state.watch.id, result.matched).then((answer) => {
        state.inFlight = false
        if (answer?.accepted === true) {
          state.fired = true
          return
        }
        if (typeof answer?.reason === 'string' && FINAL_REASONS.has(answer.reason)) {
          this.states.delete(state.watch.id)
          if (this.states.size === 0) this.stop()
          return
        }
        state.holdUntil = this.now() + BACKOFF_MS
      }, () => {
        state.inFlight = false
        state.holdUntil = this.now() + BACKOFF_MS
      })
    }
  }

  private schedule(): void {
    if (this.throttle !== undefined) return
    this.throttle = setTimeout(() => {
      this.throttle = undefined
      this.check()
    }, THROTTLE_MS)
  }

  private start(): void {
    if (this.poll !== undefined) return
    this.mutation = new MutationObserver(() => { this.schedule() })
    this.mutation.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.performanceObserver = new PerformanceObserver(() => { this.schedule() })
        this.performanceObserver.observe({ type: 'resource', buffered: false })
      } catch {
        this.performanceObserver = undefined
      }
    }
    this.poll = setInterval(() => { this.check() }, POLL_MS)
  }

  stop(): void {
    this.mutation?.disconnect()
    this.mutation = undefined
    this.performanceObserver?.disconnect()
    this.performanceObserver = undefined
    if (this.poll !== undefined) clearInterval(this.poll)
    this.poll = undefined
    if (this.throttle !== undefined) clearTimeout(this.throttle)
    this.throttle = undefined
  }
}

function isArmedList(value: unknown): value is ArmedWatch[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null
    && typeof (entry as { id?: unknown }).id === 'string'
    && typeof (entry as { condition?: unknown }).condition === 'object')
}

const WATCH_GLOBAL = '__dshBrowserPageWatch__'

/**
 * Apply the background's armed set (`DSH_WATCH_ARM`) in the top frame. The
 * observer is created on first use; a re-injected content script replaces
 * the previous instance's observer. The background re-sends the set after
 * every completed navigation and when its worker restarts.
 */
export function armPageWatch(watches: unknown): void {
  if (window.top !== window || !isArmedList(watches)) return
  const contentGlobal = globalThis as typeof globalThis & { [WATCH_GLOBAL]?: { observer: PageWatchObserver; owner: unknown } }
  let current = contentGlobal[WATCH_GLOBAL]
  if (current === undefined || current.owner !== armPageWatch) {
    current?.observer.stop()
    const observer = new PageWatchObserver(async (watchId, matched) => {
      const answer = await chrome.runtime.sendMessage({ type: 'DSH_WATCH_HIT', watchId, ...(matched === undefined ? {} : { matched }) }) as unknown
      return typeof answer === 'object' && answer !== null ? answer as { accepted?: unknown; reason?: unknown } : undefined
    })
    current = { observer, owner: armPageWatch }
    contentGlobal[WATCH_GLOBAL] = current
  }
  current.observer.arm(watches)
}
