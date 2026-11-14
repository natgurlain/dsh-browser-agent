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

/** Why a parameter value was flagged. */
export type UrlValueFlag = 'long' | 'entropy'

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
  /** True when any parameter (or a plain fragment) is flagged. */
  risky: boolean
  /** Flag on a plain (non key=value) fragment. */
  fragmentFlag?: UrlValueFlag
}

/** Values at least this long are flagged regardless of their content. */
export const LONG_VALUE_LENGTH = 48
/** The shortest separator-free run considered token-shaped. */
const TOKEN_RUN_LENGTH = 16

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
  const risky = fragmentFlag !== undefined || params.some((param) => param.flag !== undefined)
  return {
    href: url.href,
    origin: url.origin,
    path: safeDecode(url.pathname),
    params,
    fragment,
    risky,
    ...fragmentFlag === undefined ? {} : { fragmentFlag },
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
  // Judge the longest separator-free run so word lists such as
  // `newsletter_2024_fall` or ISO dates do not read as tokens.
  const run = (value.match(/[A-Za-z0-9+/]+/g) ?? []).reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest, '')
  if (run.length < TOKEN_RUN_LENGTH) return undefined
  const hasDigit = /\d/.test(run)
  const hasLetter = /[A-Za-z]/.test(run)
  const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run)
  const entropy = shannonEntropy(run)
  if (hasDigit && hasLetter && entropy >= 3.3) return 'entropy'
  if (mixedCase && entropy >= 3.6) return 'entropy'
  return undefined
}

function annotate(source: UrlParam['source'], name: string, value: string): UrlParam {
  const flag = flagValue(value)
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
