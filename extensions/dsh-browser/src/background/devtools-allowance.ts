/**
 * Time limit on the global "Allow developer tools" setting.
 *
 * The setting approves every non-eval devtools call on every site without a
 * card, so it must not stay on forever: turning it on opens a window of
 * {@link DEVTOOLS_ALLOWANCE_MS}, after which it reads as off again. Only an
 * off → on change opens a window; re-saving a setting that is already on (a
 * panel whose form still shows it ticked) never extends or reopens one.
 */

/** How long the global developer-tools allowance lasts once turned on. */
export const DEVTOOLS_ALLOWANCE_MS = 8 * 60 * 60_000

/** The two persisted fields that make up the allowance. */
export interface DevToolsAllowance {
  allowDevTools: boolean
  /** Epoch milliseconds at which the allowance ends; 0 while it is off. */
  allowDevToolsUntil: number
}

const OFF: DevToolsAllowance = { allowDevTools: false, allowDevToolsUntil: 0 }

/**
 * Read an allowance back as it stands at `now`.
 *
 * Fails closed: an allowance with no end time (stored before the limit
 * existed), a malformed one, or an expired one is off. An end time further
 * away than one full window is clamped, so a tampered record cannot outlast
 * what the user could have granted.
 *
 * @param allow - the stored `allowDevTools` value.
 * @param until - the stored `allowDevToolsUntil` value.
 * @param now - current time, epoch milliseconds.
 */
export function readDevToolsAllowance(allow: unknown, until: unknown, now: number): DevToolsAllowance {
  if (allow !== true || typeof until !== 'number' || !Number.isFinite(until) || until <= now) return OFF
  return { allowDevTools: true, allowDevToolsUntil: Math.min(until, now + DEVTOOLS_ALLOWANCE_MS) }
}

/**
 * Apply a settings save to the allowance.
 *
 * @param current - the fields as currently held (possibly already expired).
 * @param requested - the `allowDevTools` value in the save, or `undefined`
 *   when the save does not touch it.
 * @param now - current time, epoch milliseconds.
 */
export function nextDevToolsAllowance(
  current: { allowDevTools: unknown; allowDevToolsUntil?: unknown },
  requested: boolean | undefined,
  now: number,
): DevToolsAllowance {
  if (requested === false) return OFF
  const live = readDevToolsAllowance(current.allowDevTools, current.allowDevToolsUntil, now)
  // Untouched, or "on" while the stored flag is still on: keep what is left of
  // the window, which may be nothing. Only off → on is fresh consent.
  if (requested === undefined || current.allowDevTools === true) return live
  return { allowDevTools: true, allowDevToolsUntil: now + DEVTOOLS_ALLOWANCE_MS }
}
