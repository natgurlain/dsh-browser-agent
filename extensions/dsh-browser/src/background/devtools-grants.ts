/**
 * Ephemeral developer-tools grants, scoped to (kind, agent session, origin).
 *
 * A grant replaces the former single global boolean: it covers only the agent
 * session and the origin it was made for, lasts at most `DEVTOOLS_GRANT_TTL_MS`,
 * and ends as soon as the tab it was granted in commits a top-level document on
 * another origin. Console evaluation has its own grant kind, so trusting the
 * read-only developer tools never lets the model run code unseen. Nothing here
 * is persisted; the background clears every grant when the last side panel
 * closes or the developer-tools setting is revoked.
 *
 * @module
 */

import { originFromUrl } from './authorization.ts'

/** Default lifetime of one grant. */
export const DEVTOOLS_GRANT_TTL_MS = 30 * 60 * 1000

/** `devtools`: the inspection/network group; `eval`: browser_console_eval. */
export type DevToolsGrantKind = 'devtools' | 'eval'

interface Grant {
  kind: DevToolsGrantKind
  origin: string
  tabId?: number
  expiresAt: number
}

export class DevToolsGrants {
  private readonly grants = new Map<string, Grant>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEVTOOLS_GRANT_TTL_MS,
  ) {}

  /** Record (or renew) a grant. */
  grant(kind: DevToolsGrantKind, session: string | undefined, origin: string, tabId?: number): void {
    this.grants.set(key(kind, session, origin), {
      kind,
      origin,
      ...tabId === undefined ? {} : { tabId },
      expiresAt: this.now() + this.ttlMs,
    })
  }

  /** Whether an unexpired grant of this kind covers the session and origin. */
  covers(kind: DevToolsGrantKind, session: string | undefined, origin: string): boolean {
    const id = key(kind, session, origin)
    const grant = this.grants.get(id)
    if (grant === undefined) return false
    if (this.now() >= grant.expiresAt) {
      this.grants.delete(id)
      return false
    }
    return true
  }

  /** A tab committed a new top-level document: drop its grants for other origins. */
  onTopFrameCommit(tabId: number, url: string): void {
    const origin = originFromUrl(url)
    for (const [id, grant] of this.grants) {
      if (grant.tabId === tabId && grant.origin !== origin) this.grants.delete(id)
    }
  }

  clear(): void {
    this.grants.clear()
  }

  hasAny(): boolean {
    const now = this.now()
    for (const [id, grant] of this.grants) {
      if (now >= grant.expiresAt) this.grants.delete(id)
    }
    return this.grants.size > 0
  }
}

function key(kind: DevToolsGrantKind, session: string | undefined, origin: string): string {
  return JSON.stringify([kind, session ?? null, origin])
}
