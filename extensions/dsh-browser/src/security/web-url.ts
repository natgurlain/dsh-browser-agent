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

/**
 * The URL when `value` is a string holding an absolute http(s) URL, else
 * undefined. Strings only: model arguments are JSON, and an object that
 * merely looks like a URL must never pass as one.
 */
export function parseHttpUrl(value: unknown): URL | undefined {
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
