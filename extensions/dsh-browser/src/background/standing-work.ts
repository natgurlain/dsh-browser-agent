/**
 * Standing work: why the panel-free runtime stays connected with nobody
 * watching (runtime-lifecycle.ts explains the lease).
 *
 * Two sources, both opt-in:
 * - live page watchers in this browser, counted only while the page-watchers
 *   setting is on;
 * - a hint from the bridge: how many workflow schedules the Host holds for
 *   this install, and whether its MCP endpoint is enabled. The hint arrives in
 *   the MAC-bound `hello.ok` caps and in sealed `bridge/standing` events, so
 *   only a peer that holds the token can set it. It is not a grant: it keeps
 *   the connection up, and every tool call still passes the usual gates.
 *
 * The hint is mirrored to `chrome.storage.local` together with the address it
 * came from, so a restarted browser reconnects headlessly while the Host
 * still had standing work. A stored hint that no connection has confirmed for
 * {@link STANDING_HOST_MAX_AGE_MS} is ignored (and removed), so an uninstalled
 * or moved dsh does not leave the browser probing for it forever.
 *
 * The stored copy is not trusted to name an address: it is honoured only for
 * the address the user configured, or, with none configured, for the loopback
 * address the extension itself remembered after a proven handshake
 * ({@link hintAddressAllowed}). An address that appears only in the hint is
 * never dialled. Only an authenticated `hello.ok` (or a sealed event on a
 * connection whose `hello.ok` carried the cap) writes or renews it, and a
 * change of the connection settings drops it.
 *
 * @module
 */

import { isStandingWork, type StandingWork } from '@natgurlain/dsh-browser-agent/src/protocol.ts'

/** `chrome.storage.local` key holding the {@link StoredStandingHost}. */
export const STANDING_HOST_STORAGE_KEY = 'dshStandingHost'

/** How long an unconfirmed stored hint keeps the browser reconnecting. */
export const STANDING_HOST_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/** No standing work on the Host. */
export const NO_HOST_STANDING: StandingWork = Object.freeze({ schedules: 0, mcp: false })

/** The persisted host hint. */
export interface StoredStandingHost extends StandingWork {
  /** The bridge address the hint came from: the only one a headless reconnect dials for it. */
  url: string
  /** When a connection last confirmed it (epoch ms). */
  seenAt: number
}

/** What the status payload reports. */
export interface StandingSummary {
  watchers: number
  schedules: number
  mcp: boolean
  /** Agent turns running on the connected Host (counted only while connected; never stored). */
  turns?: number
}

/** Whether the Host reported any standing work. */
export function hostHasStanding(work: StandingWork): boolean {
  return work.schedules > 0 || work.mcp
}

/** Units of standing work in a summary (what the lease counts). */
export function standingCount(summary: StandingSummary): number {
  return summary.watchers + summary.schedules + (summary.mcp ? 1 : 0) + (summary.turns ?? 0)
}

/**
 * Validate a stored hint. Anything malformed, empty, without a WebSocket
 * address, from the future, or older than {@link STANDING_HOST_MAX_AGE_MS} is
 * no hint.
 */
export function parseStoredStandingHost(value: unknown, now: number = Date.now()): StoredStandingHost | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { url, seenAt, ...work } = value as Record<string, unknown>
  // The record is written by this module only: exactly its own keys.
  if (Object.keys(work).length !== 2 || !isStandingWork(work) || !hostHasStanding(work)) return undefined
  if (typeof url !== 'string' || !/^wss?:\/\//u.test(url)) return undefined
  if (typeof seenAt !== 'number' || !Number.isFinite(seenAt) || seenAt > now || now - seenAt > STANDING_HOST_MAX_AGE_MS) return undefined
  return { schedules: work.schedules, mcp: work.mcp, url, seenAt }
}

/** The record to store for a hint, or undefined when there is nothing worth keeping. */
export function storedStandingHost(work: StandingWork, url: string | undefined, now: number = Date.now()): StoredStandingHost | undefined {
  if (url === undefined || !hostHasStanding(work)) return undefined
  return parseStoredStandingHost({ schedules: work.schedules, mcp: work.mcp, url, seenAt: now }, now)
}

/** The bridge URL as it is dialled: a bare host gets the bridge path. Unparseable input is returned as is. */
export function normalizeBridgeUrl(url: string, bridgePath: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = bridgePath
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * Whether a stored hint may hold the lease and be reconnected to.
 * @param hintUrl - the address stored with the hint.
 * @param configuredUrl - the user's bridge address setting ('' when automatic).
 * @param rememberedUrl - the address remembered after a proven handshake, if any.
 * @param isLoopback - loopback test for a bridge URL.
 * @param bridgePath - the protocol's bridge path (for comparing bare hosts).
 */
export function hintAddressAllowed(
  hintUrl: string,
  configuredUrl: string,
  rememberedUrl: string | undefined,
  isLoopback: (url: string) => boolean,
  bridgePath: string,
): boolean {
  const hint = normalizeBridgeUrl(hintUrl, bridgePath)
  if (configuredUrl !== '') return hint === normalizeBridgeUrl(configuredUrl, bridgePath)
  return rememberedUrl !== undefined && hint === normalizeBridgeUrl(rememberedUrl, bridgePath) && isLoopback(hintUrl)
}
