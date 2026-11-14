/**
 * Risk classes for attribute writes through the developer-tools group.
 *
 * `script` covers everything that changes what the page executes, where it
 * sends data, or how the extension's privacy layer recognizes a field:
 * inline handlers, resource and navigation URLs, form targets, field identity
 * (`type`, `name`, `autocomplete` decide whether a value is masked), and
 * `http-equiv`, plus attributes that load resources (`poster`, `background`),
 * relax a frame's sandbox, re-associate a control with another form, or
 * redirect (`content`). A `style` value that can load a URL (`url(`,
 * `image-set(`, `@import`, any CSS escape) is script, and so is any value
 * that is a `javascript:` or `data:` URL. Script-class writes are refused; removals and reads of them always
 * need their own per-call approval and are never covered by a grant.
 *
 * Pure module: shared by the approval builder and the debugger controller.
 *
 * @module
 */

/** Attribute names the model must never write through the debugger. */
const FORBIDDEN_ATTRIBUTES = new Set(['srcdoc'])

/** Attribute names whose value is code, a URL the page loads or submits to, or field identity. */
const SCRIPT_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'href',
  'xlink:href',
  'action',
  'formaction',
  'formtarget',
  'data',
  'ping',
  'type',
  'name',
  'autocomplete',
  'http-equiv',
  'poster',
  'background',
  'lowsrc',
  'dynsrc',
  'longdesc',
  'imagesrcset',
  'sandbox',
  'allow',
  'content',
  'form',
  'formmethod',
  'formenctype',
  'method',
  'enctype',
  'target',
  'codebase',
  'archive',
  'manifest',
  'integrity',
  'nonce',
  'is',
])

/**
 * Attributes privacy.ts reads to decide whether a field is masked. Writing
 * them on a form field could un-mask it before the content script latched it,
 * so they are refused on form fields and editable hosts (see the controller).
 */
export const FIELD_LABEL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'aria-label',
  'aria-labelledby',
  'placeholder',
  'aria-placeholder',
  'data-placeholder',
  'label',
])

/**
 * Whether CSS text can make the page fetch something (an exfiltration or
 * tracking channel): `url(`, image functions, `@import`, or any backslash,
 * since CSS escapes (`\75 rl(`) spell those functions without matching.
 * @param css - a style attribute value or one declaration value.
 * @returns true when the text must not be written.
 */
export function styleCanLoad(css: string): boolean {
  if (css.includes('\\')) return true
  return /(?:url|image|image-set|-webkit-image-set|cross-fade|element|src|paint|expression)\s*\(|@import|behavior\s*:|-moz-binding/i.test(css)
}

/** URL schemes that execute or embed content when an attribute is followed. */
const SCRIPT_URL = /^\s*(?:javascript|data|vbscript):/i

/**
 * Classify one attribute write.
 * @param name - attribute name as the model supplied it.
 * @param value - value to write, when known.
 * @returns `forbidden` (never written), `script` (refused for writes, per-call
 *   approval otherwise), or `normal`.
 */
export function attributeRisk(name: string, value?: string): 'forbidden' | 'script' | 'normal' {
  const normalized = name.trim().toLowerCase()
  if (normalized === '' || /[\s<>]/.test(normalized)) return 'forbidden'
  if (FORBIDDEN_ATTRIBUTES.has(normalized)) return 'forbidden'
  if (/^on/.test(normalized) || SCRIPT_ATTRIBUTES.has(normalized)) return 'script'
  if (normalized === 'style' && value !== undefined && styleCanLoad(value)) return 'script'
  if (value !== undefined && SCRIPT_URL.test(value.replace(/[\u0000-\u001f]/g, ''))) return 'script'
  return 'normal'
}
