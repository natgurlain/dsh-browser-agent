/**
 * Privacy boundary for page snapshots: sensitive form fields are never echoed.
 *
 * The browser page channel uses text snapshots, so the
 * snapshot is the ONLY representation of a form field's value that reaches the
 * model. Password/credit-card fields are masked to a constant placeholder; the
 * real value never leaves the page. The same test decides whether text the
 * model wants to type is masked on the approval card.
 *
 * @module
 */

/** Name/id/aria-label substrings that mark a field as sensitive. */
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit/i,
  /card/i,
  /cvv/i,
  /cvc/i,
  /secret/i,
  /pwd/i,
]

/**
 * Whole words (after splitting camelCase, snake_case, kebab-case and spaces)
 * that mark a field as sensitive. Word matching keeps `spinner`, `shipping`,
 * `keyword`, `monkey` or `tokenizer` from reading as PIN, key, or token fields.
 */
const SENSITIVE_WORDS = new Set([
  'otp',
  'totp',
  'hotp',
  'passcode',
  'pin',
  'ssn',
  'iban',
  'token',
  'apikey',
  'mfa',
  '2fa',
])

/** Adjacent word pairs that mark a field as sensitive. */
const SENSITIVE_WORD_PAIRS = [
  ['api', 'key'],
  ['one', 'time'],
  ['onetime', 'code'],
  ['social', 'security'],
  ['security', 'code'],
  ['verification', 'code'],
] as const

/** Autocomplete tokens that always mark a field as sensitive. */
const SENSITIVE_AUTOCOMPLETE = new Set(['one-time-code', 'current-password', 'new-password'])

/**
 * Whether a form field must never be echoed back to the model.
 * @param el - the form element (input/select/textarea), a contenteditable
 *   host, or a node inside one.
 * @returns true for password inputs, credit-card and one-time-code
 *   autocomplete fields, and fields whose id/name/aria-label/placeholder
 *   matches a sensitive fragment. Content inside a contenteditable host is
 *   judged by the host as well.
 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return true
    if (autocompleteIsSensitive(String(el.autocomplete))) return true
  }
  if (describesSensitive(el)) return true
  const host = editingHost(el)
  return host !== undefined && host !== el && describesSensitive(host)
}

function describesSensitive(el: Element): boolean {
  if (autocompleteIsSensitive(el.getAttribute('autocomplete') ?? '')) return true
  const name = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? el.name
    : el.getAttribute('name') ?? ''
  const haystack = [
    el.id,
    name,
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-placeholder'),
    el.getAttribute('data-placeholder'),
  ].filter(Boolean).join(' ')
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))) return true
  const words = splitWords(haystack)
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true
  return words.some((word, index) =>
    SENSITIVE_WORD_PAIRS.some(([first, second]) => word === first && words[index + 1] === second))
}

function autocompleteIsSensitive(value: string): boolean {
  return value.split(/\s+/).some((token) => {
    const lowered = token.toLowerCase()
    return lowered === 'credit-card' || lowered.startsWith('cc-') || SENSITIVE_AUTOCOMPLETE.has(lowered)
  })
}

/** The nearest contenteditable ancestor (or the element itself). */
function editingHost(el: Element): Element | undefined {
  const host = el.closest('[contenteditable]:not([contenteditable="false"])')
  return host ?? undefined
}

/** Lower-cased words from camelCase / snake_case / kebab-case / free text. */
function splitWords(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

/**
 * Mask a sensitive value for snapshots. Non-empty values become a fixed
 * placeholder so the model knows a value is present without learning it.
 * @param value - the field's current value.
 * @returns the masked representation.
 */
export function maskValue(value: string): string {
  return value.length === 0 ? '' : '••••'
}
