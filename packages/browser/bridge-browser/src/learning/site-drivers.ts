/**
 * Site drivers (experimental): a typed per-site tool learned from the
 * same-origin request behind an agent action, saved only after the user
 * approves the proposal. Shared by the extension (proposal, storage,
 * execution) and the bridge (tool registration); browser-safe, no Node APIs.
 *
 * Security shape:
 * - a driver is bound to one origin; its URL is a path template resolved
 *   against that origin and re-checked at propose, save, import and execute
 *   time, so an imported driver can never target another site;
 * - secrets are never stored: `Cookie` and `Authorization` headers are
 *   dropped, and any header or body value equal to a cookie or meta-tag value
 *   becomes a *source description* (`cookie csrftoken`, `meta csrf-token`)
 *   resolved from the page at execution time;
 * - only a small allowlist of plain headers is kept.
 *
 * @module @natgurlain/dsh-browser-agent/src/learning/site-drivers
 */

import { isRecord } from '../host-api.ts'

/** Format marker of a saved driver. */
export const SITE_DRIVER_FORMAT = 'dsh-site-driver/v1'

/** Methods a driver may use. */
export const SITE_DRIVER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type SiteDriverMethod = typeof SITE_DRIVER_METHODS[number]

/** How a driver's body is encoded, from its Content-Type header. */
function bodyTypeOf(headers: Record<string, string>): 'json' | 'form' | 'text' {
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  return /json/iu.test(contentType) ? 'json' : /x-www-form-urlencoded/iu.test(contentType) ? 'form' : 'text'
}

/** Plain headers a driver may carry verbatim. */
const KEPT_HEADERS = new Set(['content-type', 'accept', 'x-requested-with'])
/** Headers never stored and never sent from a token source. */
const FORBIDDEN_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'origin', 'referer', 'content-length'])
/** Header names that look like credentials when they cannot be sourced. */
const SECRET_HEADER = /csrf|xsrf|token|auth|key|secret|session|signature/iu

/** Where a token comes from at execution time. */
export interface TokenSource {
  kind: 'cookie' | 'meta'
  name: string
}

/** One driver parameter. */
export interface SiteDriverParam {
  name: string
  description?: string
}

/** A saved site driver. */
export interface SiteDriver {
  format: typeof SITE_DRIVER_FORMAT
  origin: string
  /** snake_case tool-name suffix. */
  name: string
  description: string
  method: SiteDriverMethod
  /** Path + query template, e.g. `/api/items?q={{query}}`. */
  path: string
  /** Body template; placeholders `{{param}}` and `{{@cookie:name}}` / `{{@meta:name}}`. */
  body?: { type: 'json' | 'form' | 'text'; template: string }
  /** Plain headers kept verbatim. */
  headers: Record<string, string>
  /** Headers filled from the page at execution time. */
  tokens: Array<{ header: string; source: TokenSource }>
  params: SiteDriverParam[]
  createdAt: string
}

/** What the bridge needs to register a driver as a tool. */
export interface SiteDriverSummary {
  origin: string
  name: string
  description: string
  method: SiteDriverMethod
  params: SiteDriverParam[]
}

/** A captured request (from developer-tools network capture). */
export interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string>
  postData?: string
}

/** Values the agent typed during the action, usable as parameters. */
export interface TypedValue {
  /** Field hint (name/label) used to name the parameter. */
  field?: string
  value: string
}

/** Page token candidates (values only used for matching, never stored). */
export interface PageTokens {
  cookies: Array<{ name: string; value: string }>
  metas: Array<{ name: string; value: string }>
}

/** A proposal shown to the user before anything is saved. */
export interface SiteDriverProposal {
  driver: SiteDriver
  /** Credential-looking headers dropped because no page source matched. */
  droppedHeaders: string[]
}

export class SiteDriverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiteDriverError'
  }
}

const IDENT = /^[a-z][a-z0-9_]{0,39}$/u
const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/u
const PLACEHOLDER = /\{\{\s*(@(?:cookie|meta):[^}\s]{1,100}|[A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

/** snake_case identifier from free text. */
export function driverIdent(raw: string, fallback = 'action'): string {
  const ident = raw.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').replace(/^(\d)/u, 'n$1').slice(0, 40)
  return IDENT.test(ident) ? ident : fallback
}

/**
 * The model-facing tool name of a driver (`browser_site_<host>_<name>`, ≤ 64
 * chars). The `browser_` prefix makes its result taint the session like any
 * other page read.
 */
export function siteDriverToolName(driver: Pick<SiteDriver, 'origin' | 'name'>): string {
  const host = new URL(driver.origin).host.replace(/[^a-z0-9]+/giu, '_').toLowerCase().replace(/^_+|_+$/gu, '').slice(0, 24)
  return `browser_site_${host}_${driver.name}`.slice(0, 64)
}

/** Resolve the path template against the driver origin; refuse anything off-origin. */
export function driverUrl(origin: string, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new SiteDriverError('a driver path must start with a single "/" (same-origin path).')
  }
  const url = new URL(path, origin)
  if (url.origin !== origin) throw new SiteDriverError('a driver can only call its own origin.')
  return url
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

/**
 * Validate an untrusted driver (storage, import, panel).
 * @param value - parsed JSON.
 */
export function validateSiteDriver(value: unknown): SiteDriver {
  if (!isRecord(value) || value.format !== SITE_DRIVER_FORMAT) throw new SiteDriverError('not a site driver (format dsh-site-driver/v1).')
  const origin = typeof value.origin === 'string' ? originOf(value.origin) : undefined
  if (origin === undefined || origin !== value.origin) throw new SiteDriverError('origin must be an http(s) origin such as https://example.com.')
  if (typeof value.name !== 'string' || !IDENT.test(value.name)) throw new SiteDriverError('name must be snake_case (a-z, 0-9, _).')
  const method = typeof value.method === 'string' ? value.method.toUpperCase() : ''
  if (!(SITE_DRIVER_METHODS as readonly string[]).includes(method)) throw new SiteDriverError(`method must be one of ${SITE_DRIVER_METHODS.join(', ')}.`)
  if (typeof value.path !== 'string' || value.path.length > 2_000) throw new SiteDriverError('path must be a string.')
  driverUrl(origin, value.path.replace(PLACEHOLDER, 'x'))
  if (!Array.isArray(value.params) || value.params.length > 20) throw new SiteDriverError('params must be a list of at most 20.')
  const params: SiteDriverParam[] = value.params.map((raw) => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !PARAM.test(raw.name)) throw new SiteDriverError('each parameter needs an identifier name.')
    return { name: raw.name, ...(typeof raw.description === 'string' && raw.description !== '' ? { description: raw.description.slice(0, 200) } : {}) }
  })
  const known = new Set(params.map((param) => param.name))
  let body: SiteDriver['body']
  if (value.body !== undefined) {
    if (!isRecord(value.body) || !['json', 'form', 'text'].includes(String(value.body.type)) || typeof value.body.template !== 'string' || value.body.template.length > 20_000) {
      throw new SiteDriverError('body must be { type: json|form|text, template }.')
    }
    body = { type: value.body.type as 'json' | 'form' | 'text', template: value.body.template }
  }
  if (body !== undefined && method === 'GET') throw new SiteDriverError('a GET driver cannot have a body.')
  for (const name of [...placeholders(value.path), ...placeholders(body?.template ?? '')]) {
    if (name.startsWith('@')) continue
    if (!known.has(name)) throw new SiteDriverError(`placeholder {{${name}}} names no parameter.`)
  }
  if (placeholders(value.path).some((name) => name.startsWith('@'))) throw new SiteDriverError('tokens cannot be placed in the URL.')
  const literal = sensitiveLiterals(value.path, body)
  if (literal.length > 0) throw new SiteDriverError(`sensitive fields (${literal.join(', ')}) cannot hold stored values in a driver.`)
  const headers: Record<string, string> = {}
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) throw new SiteDriverError('headers must be an object.')
    for (const [name, header] of Object.entries(value.headers)) {
      if (!KEPT_HEADERS.has(name.toLowerCase()) || typeof header !== 'string' || header.length > 200) throw new SiteDriverError(`header "${name}" cannot be stored in a driver.`)
      headers[name.toLowerCase()] = header
    }
  }
  const tokens: SiteDriver['tokens'] = []
  if (value.tokens !== undefined) {
    if (!Array.isArray(value.tokens) || value.tokens.length > 5) throw new SiteDriverError('tokens must be a short list.')
    for (const raw of value.tokens) {
      if (!isRecord(raw) || typeof raw.header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(raw.header) || FORBIDDEN_HEADERS.has(raw.header.toLowerCase())) {
        throw new SiteDriverError('a token needs an allowed header name.')
      }
      const source = raw.source
      if (!isRecord(source) || (source.kind !== 'cookie' && source.kind !== 'meta') || typeof source.name !== 'string' || !/^[^\s;=]{1,100}$/u.test(source.name)) {
        throw new SiteDriverError('a token source must be { kind: cookie|meta, name }.')
      }
      tokens.push({ header: raw.header.toLowerCase(), source: { kind: source.kind, name: source.name } })
    }
  }
  return {
    format: SITE_DRIVER_FORMAT,
    origin,
    name: value.name,
    description: typeof value.description === 'string' ? value.description.slice(0, 300) : '',
    method: method as SiteDriverMethod,
    path: value.path,
    ...(body === undefined ? {} : { body }),
    headers,
    tokens,
    params,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  }
}

/** Parse the summaries the extension reports (bridge side). */
export function parseSiteDrivers(value: unknown): SiteDriverSummary[] {
  if (!Array.isArray(value) || value.length > 100) throw new SiteDriverError('siteDrivers must be a list of at most 100.')
  return value.map((raw) => {
    const driver = validateSiteDriver(raw)
    return { origin: driver.origin, name: driver.name, description: driver.description, method: driver.method, params: driver.params }
  })
}

/** Field names whose literal value must never be stored in a driver. */
const SENSITIVE_FIELD = /pass(?:word|wd|code|phrase)?|pwd|secret|token|otp|totp|\bpin\b|cvv|cvc|card|ssn|iban|api[_-]?key|private|mnemonic|seed|recovery|auth|credential|session|csrf|xsrf|nonce|signature|jwt|(?:^|[^a-z])sig(?:$|[^a-z])/iu
/** A field is sensitive when its name looks like a credential to either list (body fields and headers alike). */
function sensitiveField(key: string): boolean {
  return SENSITIVE_FIELD.test(key) || SECRET_HEADER.test(key)
}

const ONLY_PLACEHOLDER = /^\s*\{\{[^}]+\}\}\s*$/u

/**
 * Names of fields that still carry a literal value under a sensitive name
 * (query, JSON or form body). A driver with any of them is refused: the value
 * would be stored in extension storage and in exports.
 */
export function sensitiveLiterals(path: string, body: SiteDriver['body'] | undefined): string[] {
  const found = new Set<string>()
  const check = (key: string, value: unknown): void => {
    if (!sensitiveField(key)) return
    if (typeof value === 'string' && (value === '' || ONLY_PLACEHOLDER.test(value))) return
    if (value === null || value === undefined || typeof value === 'boolean') return
    found.add(key)
  }
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''
  for (const [key, value] of new URLSearchParams(query)) check(key, value)
  if (body !== undefined) {
    if (body.type === 'form') {
      for (const [key, value] of new URLSearchParams(body.template)) check(key, value)
    } else if (body.type === 'json') {
      const walk = (value: unknown, depth: number): void => {
        if (depth > 6 || typeof value !== 'object' || value === null) return
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === 'object' && child !== null) walk(child, depth + 1)
          else check(key, child)
        }
      }
      try {
        walk(JSON.parse(body.template), 0)
      } catch {
        if (sensitiveField(body.template)) found.add('body')
      }
    } else {
      for (const match of body.template.matchAll(/([A-Za-z_][\w-]*)\s*[=:]\s*("?)([^"&\s,}]*)\2/gu)) check(match[1]!, match[3]!)
    }
  }
  return [...found]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Turn a captured same-origin request into a driver proposal.
 * @param pageOrigin - origin of the tab the action ran on.
 * @param request - the captured request.
 * @param typed - values the agent typed during the action (non-sensitive only).
 * @param tokens - cookie and meta values on the page, used only for matching.
 * @param now - clock seam.
 */
export function proposeSiteDriver(
  pageOrigin: string,
  request: CapturedRequest,
  typed: readonly TypedValue[],
  tokens: PageTokens,
  now: Date = new Date(),
): SiteDriverProposal {
  const url = new URL(request.url)
  if (url.origin !== pageOrigin) throw new SiteDriverError('only same-origin requests can become a site driver.')
  const method = request.method.toUpperCase()
  if (!(SITE_DRIVER_METHODS as readonly string[]).includes(method)) throw new SiteDriverError(`unsupported method ${method}.`)
  const params: SiteDriverParam[] = []
  const taken = new Set<string>()
  const paramFor = (field: string | undefined): string => {
    let base = driverIdent(field ?? 'value', 'value')
    if (!PARAM.test(base)) base = 'value'
    let name = base
    for (let index = 2; taken.has(name); index += 1) name = `${base}${String(index)}`
    taken.add(name)
    params.push({ name, description: field === undefined ? 'Value the user typed.' : `Value for "${field}".` })
    return name
  }
  let path = `${url.pathname}${url.search}`
  let body = request.postData
  // Tokens first: a typed value never hides a credential.
  const tokenSources: Array<{ value: string; source: TokenSource }> = [
    ...tokens.cookies.filter((cookie) => cookie.value.length >= 8).map((cookie) => ({ value: cookie.value, source: { kind: 'cookie' as const, name: cookie.name } })),
    ...tokens.metas.filter((meta) => meta.value.length >= 8).map((meta) => ({ value: meta.value, source: { kind: 'meta' as const, name: meta.name } })),
  ]
  for (const token of tokenSources) {
    if (body?.includes(token.value) === true) body = body.split(token.value).join(`{{@${token.source.kind}:${token.source.name}}}`)
    for (const encoded of [token.value, encodeURIComponent(token.value)]) {
      if (path.includes(encoded)) throw new SiteDriverError('the request carries a credential in its URL; it cannot become a driver.')
    }
  }
  for (const value of typed) {
    if (value.value.trim() === '' || value.value.length > 500) continue
    const candidates = [value.value, encodeURIComponent(value.value), JSON.stringify(value.value).slice(1, -1), new URLSearchParams({ v: value.value }).toString().slice(2)]
    let name: string | undefined
    for (const candidate of new Set(candidates)) {
      const pattern = new RegExp(escapeRegExp(candidate), 'gu')
      if (pattern.test(path)) {
        name ??= paramFor(value.field)
        path = path.replace(pattern, `{{${name}}}`)
      }
      if (body !== undefined && new RegExp(escapeRegExp(candidate), 'u').test(body)) {
        name ??= paramFor(value.field)
        body = body.replace(new RegExp(escapeRegExp(candidate), 'gu'), `{{${name}}}`)
      }
    }
  }
  const headers: Record<string, string> = {}
  const driverTokens: SiteDriver['tokens'] = []
  const droppedHeaders: string[] = []
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase()
    if (FORBIDDEN_HEADERS.has(name) || name.startsWith(':') || name.startsWith('sec-')) continue
    const source = tokenSources.find((token) => token.value === value || value.endsWith(` ${token.value}`))
    if (source !== undefined) {
      driverTokens.push({ header: name, source: source.source })
      continue
    }
    if (KEPT_HEADERS.has(name) && value.length <= 200) {
      headers[name] = value
      continue
    }
    if (SECRET_HEADER.test(name)) droppedHeaders.push(name)
  }
  const contentType = headers['content-type'] ?? ''
  const bodyType: 'json' | 'form' | 'text' = /json/iu.test(contentType) ? 'json' : /x-www-form-urlencoded/iu.test(contentType) ? 'form' : 'text'
  const segment = url.pathname.split('/').filter((part) => part !== '' && !/^\d+$/u.test(part)).at(-1)
  const name = driverIdent(`${method.toLowerCase()}_${segment ?? 'root'}`)
  const literal = sensitiveLiterals(path, body === undefined || body === '' || method === 'GET' ? undefined : { type: bodyTypeOf(request.headers), template: body })
  if (literal.length > 0) {
    throw new SiteDriverError(`the request carries sensitive fields (${literal.join(', ')}); it cannot become a driver because their values would be stored.`)
  }
  const driver = validateSiteDriver({
    format: SITE_DRIVER_FORMAT,
    origin: pageOrigin,
    name,
    description: `${method} ${url.pathname}`,
    method,
    path,
    ...(body === undefined || body === '' || method === 'GET' ? {} : { body: { type: bodyType, template: body } }),
    headers,
    tokens: driverTokens,
    params,
    createdAt: now.toISOString(),
  })
  return { driver, droppedHeaders }
}

/**
 * One piece of a built request body: literal text (template text and
 * already-encoded parameter values) or a page token at a position the saved
 * template declared. Parameter values are never parsed for placeholders, so a
 * `{{@cookie:...}}` typed by the model stays literal text.
 */
export type DriverBodySegment = { text: string } | { token: TokenSource }

/** A concrete request, ready for the approval card and the page fetch. */
export interface DriverRequest {
  method: SiteDriverMethod
  url: string
  headers: Record<string, string>
  /** Body for display (token positions shown as `{{@kind:name}}`); never re-parsed. */
  body?: string
  /** The body as built: the only input token resolution reads. */
  bodySegments?: DriverBodySegment[]
  /** Token headers, described (never their values). */
  tokenHeaders: Array<{ header: string; source: TokenSource }>
  /** Token positions in the body, in order, resolved in the page. */
  bodyTokens: TokenSource[]
}

function tokenSourceOf(name: string): TokenSource {
  const [kind, ...rest] = name.slice(1).split(':')
  return { kind: kind as 'cookie' | 'meta', name: rest.join(':') }
}

/** Split a saved template into text, parameter and token segments (before any substitution). */
function templateSegments(template: string): Array<{ text: string } | { param: string } | { token: TokenSource }> {
  const out: Array<{ text: string } | { param: string } | { token: TokenSource }> = []
  let last = 0
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = match.index
    if (index > last) out.push({ text: template.slice(last, index) })
    const name = match[1]!
    out.push(name.startsWith('@') ? { token: tokenSourceOf(name) } : { param: name })
    last = index + match[0].length
  }
  if (last < template.length) out.push({ text: template.slice(last) })
  return out
}

/**
 * Substitute parameters (not tokens) into a driver.
 * @param driver - validated driver.
 * @param values - parameter values.
 */
export function buildDriverRequest(driver: SiteDriver, values: Record<string, unknown>): DriverRequest {
  const params: Record<string, string> = {}
  for (const param of driver.params) {
    const value = values[param.name]
    if (typeof value !== 'string' && typeof value !== 'number') throw new SiteDriverError(`parameter "${param.name}" is required.`)
    params[param.name] = String(value)
  }
  for (const key of Object.keys(values)) {
    if (!(key in params)) throw new SiteDriverError(`unknown parameter "${key}".`)
  }
  const path = templateSegments(driver.path).map((segment) => 'text' in segment
    ? segment.text
    : 'param' in segment ? encodeURIComponent(params[segment.param] ?? '') : '').join('')
  const url = driverUrl(driver.origin, path)
  const bodyTokens: TokenSource[] = []
  let bodySegments: DriverBodySegment[] | undefined
  if (driver.body !== undefined) {
    const encode = driver.body.type === 'json'
      ? (text: string) => JSON.stringify(text).slice(1, -1)
      : driver.body.type === 'form' ? (text: string) => encodeURIComponent(text) : (text: string) => text
    bodySegments = templateSegments(driver.body.template).map((segment): DriverBodySegment => {
      if ('token' in segment) {
        bodyTokens.push({ ...segment.token })
        return { token: { ...segment.token } }
      }
      return { text: 'text' in segment ? segment.text : encode(params[segment.param] ?? '') }
    })
  }
  const body = bodySegments?.map((segment) => 'text' in segment ? segment.text : `{{@${segment.token.kind}:${segment.token.name}}}`).join('')
  return {
    method: driver.method,
    url: url.href,
    headers: { ...driver.headers },
    ...(body === undefined ? {} : { body }),
    ...(bodySegments === undefined ? {} : { bodySegments }),
    tokenHeaders: driver.tokens.map((token) => ({ ...token })),
    bodyTokens,
  }
}

/**
 * Fill token headers and body token positions from page values (runs in the
 * page). Only the segments built from the saved template are filled; a body
 * without segments is sent verbatim, never searched for placeholders.
 */
export function resolveDriverTokens(request: DriverRequest, read: (source: TokenSource) => string | undefined): { headers: Record<string, string>; body?: string } {
  const headers = { ...request.headers }
  for (const token of request.tokenHeaders) {
    const value = read(token.source)
    if (value === undefined) throw new SiteDriverError(`the page has no ${token.source.kind} "${token.source.name}" for ${token.header}; the token may be stale.`)
    headers[token.header] = value
  }
  let body = request.body
  if (Array.isArray(request.bodySegments)) {
    body = request.bodySegments.map((segment) => {
      if ('text' in segment) return typeof segment.text === 'string' ? segment.text : ''
      const value = read(segment.token)
      if (value === undefined) throw new SiteDriverError(`the page has no ${segment.token.kind} "${segment.token.name}"; the token may be stale.`)
      return value
    }).join('')
  }
  return { headers, ...(body === undefined ? {} : { body }) }
}

/** Human description of a request for the approval card (no token values). */
export function describeDriverRequest(request: DriverRequest): string {
  const filled = [
    ...request.tokenHeaders.map((token) => `header ${token.header} ← page ${token.source.kind} "${token.source.name}"`),
    ...request.bodyTokens.map((token, index) => `body field ${String(index + 1)} ← page ${token.kind} "${token.name}"`),
  ]
  return [
    `${request.method} ${request.url}`,
    ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
    ...request.tokenHeaders.map((token) => `${token.header}: <from page ${token.source.kind} "${token.source.name}">`),
    ...(request.body === undefined ? [] : ['', request.body]),
    '',
    filled.length === 0
      ? 'Filled from the page: nothing (any {{@…}} text above is sent literally).'
      : `Filled from the page (${String(filled.length)}):\n${filled.map((line) => `  ${line}`).join('\n')}\nAny other {{@…}} text above is sent literally.`,
  ].join('\n')
}

/** Parse an import file: every driver re-validated (origin binding included). */
export function parseSiteDriverImport(value: unknown): SiteDriver[] {
  if (!isRecord(value) || value.format !== 'dsh-site-drivers/v1' || !Array.isArray(value.drivers)) {
    throw new SiteDriverError('not a site-driver export (format dsh-site-drivers/v1).')
  }
  if (value.drivers.length > 100) throw new SiteDriverError('too many drivers in one import.')
  return value.drivers.map(validateSiteDriver)
}
