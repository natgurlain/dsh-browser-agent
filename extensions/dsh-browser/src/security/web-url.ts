/**
 * The one place that decides "is this an http(s) page, and what is its
 * origin". Policy, taint, watchers, programs and learning all judge web
 * pages only; every other scheme (chrome:, file:, data:, blob:, about:) is
 * "not a web page" here.
 *
 * Deliberate variants live next to their callers and say why:
 * `originFromUrl` (authorization.ts) also accepts `blob:` URLs of a web
 * origin for approval cards; `frameContentOrigin` (dev-loop.ts) names
 * non-web frames by scheme; page-documents.ts compares any-scheme origins.
 *
 * @module
 */

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The URL when `value` is an absolute http(s) URL, else undefined. */
export function parseHttpUrl(value: unknown): URL | undefined {
  if (value instanceof URL) return value.protocol === 'http:' || value.protocol === 'https:' ? value : undefined
  // A URL object from another realm (tests, frames) fails instanceof: re-parse its href.
  if (typeof value === 'object' && value !== null && typeof (value as { href?: unknown }).href === 'string') {
    return parseHttpUrl((value as { href: string }).href)
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The origin of an absolute http(s) URL, else undefined. */
export function httpOrigin(value: unknown): string | undefined {
  return parseHttpUrl(value)?.origin
}
