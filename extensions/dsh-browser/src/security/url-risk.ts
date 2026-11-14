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
/**
 * Opaque characters (see {@link opaqueRuns}) across the whole URL that flag
 * it, when spread over at least {@link AGGREGATE_OPAQUE_RUNS} runs: catches a
 * payload re-encoded as letters only or digits only and split into many short
 * parameters or path segments, each below every per-value threshold.
 */
const AGGREGATE_OPAQUE_CHARS = 32
const AGGREGATE_OPAQUE_RUNS = 3
/** Letters in word-length runs whose combined shape is judged (see {@link opaquePayload}). */
const LETTER_POOL_MIN = 32
/** Natural-language text keeps ~38% vowels (y included); re-alphabetized payloads far fewer. */
const LETTER_POOL_MIN_VOWELS = 0.3
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
  const pieces = [
    ...params.flatMap((param) => [param.name, param.value]),
    ...segments,
    fragment,
  ]
  const opaque = opaquePayload(pieces.filter((piece) => !UUID.test(piece)))
  const aggregate = aggregatePayload(pieces) >= AGGREGATE_PAYLOAD
    || (opaque.chars >= AGGREGATE_OPAQUE_CHARS && opaque.runs >= AGGREGATE_OPAQUE_RUNS)
  if (aggregate) {
    for (const [index, param] of params.entries()) {
      if (param.flag === undefined && (tokenPieces(`${param.name} ${param.value}`) > 0 || opaquePayload([param.name, param.value]).runs > 0)) {
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

/**
 * Runs that do not read as words or ordinary numbers: mixed letter/digit runs
 * of 4+ (beyond `utf8`/`page2`/`17z` shapes) and digit runs of 5+.
 */
function opaqueRuns(value: string): { chars: number; runs: number } {
  let chars = 0
  let runs = 0
  for (const run of value.match(/[A-Za-z0-9]+/g) ?? []) {
    const hasDigit = /\d/.test(run)
    const hasLetter = /[A-Za-z]/.test(run)
    const opaque = hasDigit && hasLetter
      ? run.length >= 4 && !/^[A-Za-z]{1,8}\d{1,2}$/.test(run) && !/^\d{1,4}(?:st|nd|rd|th|px|em|k|m|s|p|x|z)$/i.test(run)
      : hasDigit && run.length >= 5
    if (opaque) {
      chars += run.length
      runs += 1
    }
  }
  return { chars, runs }
}

/**
 * Opaque characters across every piece of a URL: {@link opaqueRuns}, plus
 * letter-only runs of 5+ that are judged together. A payload re-alphabetized
 * to letters (hex as `a-p`, base32) and split into many short words keeps far
 * fewer vowels and far more consonant clusters than natural-language slugs and
 * queries; a single run with no vowel balance at all counts on its own.
 */
function opaquePayload(pieces: string[]): { chars: number; runs: number } {
  let chars = 0
  let runs = 0
  const pool: string[] = []
  let single = { chars: 0, runs: 0 }
  for (const piece of pieces) {
    const counted = opaqueRuns(piece)
    chars += counted.chars
    runs += counted.runs
    for (const run of piece.match(/[A-Za-z]+/g) ?? []) {
      if (run.length < 5) continue
      const lower = run.toLowerCase()
      pool.push(lower)
      if (run.length >= 8 && !pronounceable(lower)) single = { chars: single.chars + run.length, runs: single.runs + 1 }
    }
  }
  const letters = pool.join('')
  // Longer pools vary less, so the bar rises with them.
  const pooled = letters.length >= LETTER_POOL_MIN
    && vowelShare(letters) < (letters.length >= 64 ? LETTER_POOL_MIN_VOWELS + 0.04 : LETTER_POOL_MIN_VOWELS)
  return pooled
    ? { chars: chars + letters.length, runs: runs + pool.length }
    : { chars: chars + single.chars, runs: runs + single.runs }
}

function vowelShare(lower: string): number {
  return (lower.match(/[aeiouy]/g) ?? []).length / lower.length
}

/** Whether one lowercase letters-only run reads like a natural-language word. */
function pronounceable(lower: string): boolean {
  if (vowelShare(lower) < 0.2) return false
  return Math.max(0, ...(lower.match(/[^aeiouy]+/g) ?? []).map((cluster) => cluster.length)) < 5
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
