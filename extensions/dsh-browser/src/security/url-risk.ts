/**
 * URL presentation and exfiltration heuristics for approval prompts.
 *
 * A destination URL is the cheapest channel a model has to move data off the
 * page: anything it read can be appended as a query or fragment value. The
 * approval card therefore shows the whole URL with every parameter decoded, and
 * values that look like smuggled data (long, or token-shaped high-entropy
 * strings) are flagged so they stand out and so trusted origins still prompt.
 *
 * @module
 */

/**
 * Why a value was flagged: `long` and `entropy` describe one value;
 * `aggregate` marks a parameter that only looks like data together with its
 * siblings (a token split across many short parameters).
 */
export type UrlValueFlag = 'long' | 'entropy' | 'aggregate'

/** One decoded query or fragment parameter. */
export interface UrlParam {
  source: 'query' | 'fragment'
  name: string
  value: string
  flag?: UrlValueFlag
}

/** The full, decoded view of a URL an approval card renders. */
export interface UrlAnalysis {
  href: string
  origin: string
  /** Percent-decoded path (falls back to the raw path when it is not valid UTF-8). */
  path: string
  params: UrlParam[]
  /** Decoded fragment when it is not `key=value` shaped; empty otherwise. */
  fragment: string
  /**
   * True when anything in the URL can carry smuggled data: a flagged
   * parameter name or value, path segment, or plain fragment; credentials in
   * the authority; token-shaped pieces that together reach a token's size; or
   * a total payload beyond {@link MAX_URL_PAYLOAD}.
   */
  risky: boolean
  /** Flag on a plain (non key=value) fragment. */
  fragmentFlag?: UrlValueFlag
  /** Flag on the most suspicious path segment. */
  pathFlag?: UrlValueFlag
  /** The URL names a username or password (`user:pass@host`). */
  userinfo?: true
  /** The path, query, and fragment together exceed {@link MAX_URL_PAYLOAD} characters. */
  oversized?: true
}

/** Values at least this long are flagged regardless of their content. */
export const LONG_VALUE_LENGTH = 48
/** The shortest separator-free run considered token-shaped. */
const TOKEN_RUN_LENGTH = 16
/**
 * A separator-free alphanumeric run this long is flagged even without digits
 * or mixed case: natural-language words and slugs are far shorter, while a
 * re-alphabetized hex or base32 payload is not.
 */
const BARE_RUN_LENGTH = 32
/** Token-shaped pieces shorter than this do not count toward the aggregate. */
const PIECE_RUN_LENGTH = 6
/** Combined token-shaped characters across the whole URL that flag it. */
const AGGREGATE_PAYLOAD = 24
/** Decoded path + query + fragment characters beyond which any URL prompts. */
export const MAX_URL_PAYLOAD = 512
/** Canonical UUID: common in REST paths and ids, so it is not judged on its own. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse and annotate a URL for display.
 * @param value - raw URL string, as the model supplied it.
 * @returns the analysis, or undefined when the URL does not parse.
 */
export function analyzeUrl(value: string): UrlAnalysis | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const params: UrlParam[] = []
  for (const [name, paramValue] of url.searchParams) params.push(annotate('query', name, paramValue))
  const rawFragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  let fragment = ''
  let fragmentFlag: UrlValueFlag | undefined
  if (rawFragment !== '' && rawFragment.includes('=')) {
    for (const [name, paramValue] of new URLSearchParams(rawFragment)) params.push(annotate('fragment', name, paramValue))
  } else if (rawFragment !== '') {
    fragment = safeDecode(rawFragment)
    fragmentFlag = flagValue(fragment)
  }
  const path = safeDecode(url.pathname)
  const segments = url.pathname.split('/').map(safeDecode).filter((segment) => segment !== '')
  const pathFlag = strongest(segments.map(flagSegment))
  // A token split into many short pieces: every piece is below the per-value
  // thresholds, so judge the token-shaped pieces of the whole URL together.
  const aggregate = aggregatePayload([
    ...params.flatMap((param) => [param.name, param.value]),
    ...segments,
    fragment,
  ]) >= AGGREGATE_PAYLOAD
  if (aggregate) {
    for (const [index, param] of params.entries()) {
      if (param.flag === undefined && tokenPieces(`${param.name} ${param.value}`) > 0) {
        params[index] = { ...param, flag: 'aggregate' }
      }
    }
  }
  const userinfo = url.username !== '' || url.password !== ''
  const oversized = path.length + url.search.length + url.hash.length > MAX_URL_PAYLOAD
  const risky = userinfo
    || oversized
    || aggregate
    || pathFlag !== undefined
    || fragmentFlag !== undefined
    || params.some((param) => param.flag !== undefined)
  return {
    href: url.href,
    origin: url.origin,
    path,
    params,
    fragment,
    risky,
    ...fragmentFlag === undefined ? {} : { fragmentFlag },
    ...pathFlag === undefined ? {} : { pathFlag },
    ...userinfo ? { userinfo: true as const } : {},
    ...oversized ? { oversized: true as const } : {},
  }
}

/** Whether a URL carries a long or high-entropy query/fragment value. */
export function urlCarriesRiskyValue(value: string): boolean {
  return analyzeUrl(value)?.risky === true
}

/**
 * Classify one decoded value.
 * @param value - the decoded parameter value.
 * @returns the flag, or undefined for an ordinary value.
 */
export function flagValue(value: string): UrlValueFlag | undefined {
  if (value.length >= LONG_VALUE_LENGTH) return 'long'
  if (/^eyJ[\w-]+\.[\w-]+/.test(value)) return 'entropy'
  if (runIsToken(longestRun(value))) return 'entropy'
  // Separators (`-`, `_`, `.`, spaces) do not hide a token: `9f86d081-884c7d65-…`
  // is judged by its joined characters. Word lists stay ordinary because the
  // joined run has no digits and only natural-language entropy.
  const joined = value.replace(/[-_.~:,; ]+/g, '')
  if (joined !== value && !UUID.test(value) && tokenPieces(value) >= TOKEN_RUN_LENGTH
    && runIsToken(longestRun(joined))) return 'entropy'
  return undefined
}

/**
 * Classify one path segment. Long readable slugs (`how-to-bake-bread-…`) are
 * ordinary in paths, so length alone flags a segment only when it is not made
 * of short words.
 */
function flagSegment(segment: string): UrlValueFlag | undefined {
  if (UUID.test(segment)) return undefined
  const flag = flagValue(segment)
  if (flag !== 'long') return flag
  const wordlike = (segment.match(/[A-Za-z0-9]+/g) ?? []).every((run) => run.length <= 20 && !(/\d/.test(run) && /[A-Za-z]/.test(run)))
  return wordlike ? undefined : 'long'
}

/** Longest alphanumeric (plus base64 `+`/`/`) run of a value. */
function longestRun(value: string): string {
  return (value.match(/[A-Za-z0-9+/]+/g) ?? []).reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest, '')
}

/** Whether one separator-free run reads as a token rather than a word or number. */
function runIsToken(run: string): boolean {
  if (run.length >= BARE_RUN_LENGTH) return true
  if (run.length < TOKEN_RUN_LENGTH) return false
  const hasDigit = /\d/.test(run)
  const hasLetter = /[A-Za-z]/.test(run)
  const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run)
  const entropy = shannonEntropy(run)
  if (hasDigit && hasLetter && entropy >= 3.3) return true
  if (mixedCase && entropy >= 3.6) return true
  return false
}

/**
 * Characters in token-shaped pieces (runs mixing letters and digits) of one
 * string. Pure words, plain numbers, and short codes such as `p1` count zero.
 */
function tokenPieces(value: string): number {
  let total = 0
  for (const run of value.match(/[A-Za-z0-9]+/g) ?? []) {
    if (run.length < PIECE_RUN_LENGTH) continue
    if (/\d/.test(run) && /[A-Za-z]/.test(run) && shannonEntropy(run) >= 2.5) total += run.length
  }
  return total
}

/** Token-shaped characters across all pieces, ignoring canonical UUIDs. */
function aggregatePayload(pieces: string[]): number {
  return pieces.reduce((sum, piece) => sum + (UUID.test(piece) ? 0 : tokenPieces(piece)), 0)
}

function strongest(flags: Array<UrlValueFlag | undefined>): UrlValueFlag | undefined {
  if (flags.includes('long')) return 'long'
  if (flags.includes('entropy')) return 'entropy'
  return undefined
}

function annotate(source: UrlParam['source'], name: string, value: string): UrlParam {
  const flag = strongest([flagValue(value), flagValue(name)])
  return flag === undefined ? { source, name, value } : { source, name, value, flag }
}

/** Shannon entropy in bits per character. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
