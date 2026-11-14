/**
 * Structured row extraction for `browser_extract`: turn repeated page
 * structure (a table, or rows described by CSS selectors) into records.
 *
 * Extraction is read-only and app-agnostic; the caller describes the rows,
 * this module never guesses page semantics beyond table headers.
 *
 * @module
 */

import { resolveSelector, resolveSelectorAll } from './dom.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

/** One extracted cell value. */
export type CellValue = string | number | null

/** One field of a row schema. */
export interface FieldSpec {
  /** Selector relative to the row; empty or "." means the row itself. */
  selector: string
  /** Attribute to read instead of the text (href/src resolve to absolute URLs). */
  attr?: string
  /** Parse the value as a number (currency symbols and thousands separators ignored). */
  type?: 'string' | 'number'
}

/** A row schema: the row selector plus named fields. */
export interface RowSchema {
  rows: string
  fields: Record<string, FieldSpec>
}

/** Extraction request after validation. */
export type ExtractRequest =
  | { kind: 'schema'; schema: RowSchema; limit: number }
  | { kind: 'table'; table: string; limit: number }

/** Extracted records with a stable column order. */
export interface ExtractedRows {
  columns: string[]
  rows: Record<string, CellValue>[]
  /** Rows that matched but were cut by the limit. */
  dropped: number
}

/** Malformed extraction arguments. */
export class ExtractError extends Error {
  constructor(readonly code: 'bad-args' | 'action-failed', message: string) {
    super(message)
    this.name = 'ExtractError'
  }
}

/** Default and maximum rows read from one page. */
export const DEFAULT_ROW_LIMIT = 500
export const MAX_ROW_LIMIT = 5_000

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function textOf(el: Element): string {
  return clean(el instanceof HTMLElement && typeof el.innerText === 'string' ? el.innerText : el.textContent ?? '')
}

/** Parse one field spec: a bare selector string or an object. */
function parseField(name: string, value: unknown): FieldSpec {
  if (typeof value === 'string') return { selector: value }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExtractError('bad-args', `schema.fields.${name} must be a selector string or { selector, attr, type }.`)
  }
  const record = value as Record<string, unknown>
  const selector = record.selector === undefined ? '' : record.selector
  if (typeof selector !== 'string') throw new ExtractError('bad-args', `schema.fields.${name}.selector must be a string.`)
  if (record.attr !== undefined && typeof record.attr !== 'string') {
    throw new ExtractError('bad-args', `schema.fields.${name}.attr must be a string.`)
  }
  if (record.type !== undefined && record.type !== 'string' && record.type !== 'number') {
    throw new ExtractError('bad-args', `schema.fields.${name}.type must be string or number.`)
  }
  return {
    selector,
    ...typeof record.attr === 'string' && record.attr !== '' ? { attr: record.attr } : {},
    ...record.type === 'number' ? { type: 'number' as const } : {},
  }
}

/**
 * Validate the raw tool arguments.
 * @param args - browser_extract arguments (schema or table, limit).
 * @returns the normalized request.
 */
export function parseExtractRequest(args: Record<string, unknown>): ExtractRequest {
  const limitRaw = args.limit ?? DEFAULT_ROW_LIMIT
  if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1) {
    throw new ExtractError('bad-args', 'limit must be a positive integer.')
  }
  const limit = Math.min(limitRaw, MAX_ROW_LIMIT)
  const hasSchema = args.schema !== undefined
  const hasTable = typeof args.table === 'string' && args.table !== ''
  if (hasSchema === hasTable) throw new ExtractError('bad-args', 'Provide exactly one of schema or table.')
  if (hasTable) return { kind: 'table', table: args.table as string, limit }
  const schema = args.schema
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new ExtractError('bad-args', 'schema must be an object { rows, fields }.')
  }
  const raw = schema as Record<string, unknown>
  if (typeof raw.rows !== 'string' || raw.rows === '') throw new ExtractError('bad-args', 'schema.rows must be a CSS selector for one row.')
  if (typeof raw.fields !== 'object' || raw.fields === null || Array.isArray(raw.fields)) {
    throw new ExtractError('bad-args', 'schema.fields must map column names to selectors.')
  }
  const fields: Record<string, FieldSpec> = {}
  for (const [name, value] of Object.entries(raw.fields as Record<string, unknown>)) fields[name] = parseField(name, value)
  if (Object.keys(fields).length === 0) throw new ExtractError('bad-args', 'schema.fields must name at least one column.')
  return { kind: 'schema', schema: { rows: raw.rows, fields }, limit }
}

/** Parse a displayed number: "¥1,234.50" → 1234.5; unparseable → null. */
export function parseNumber(text: string): number | null {
  const stripped = text.replace(/[^\d.,\-]/g, '')
  if (stripped === '' || stripped === '-') return null
  // A comma followed by exactly three digits is a thousands separator;
  // otherwise a lone comma is a decimal mark.
  const normalized = /,\d{3}(?!\d)/.test(stripped) || stripped.includes('.')
    ? stripped.replace(/,/g, '')
    : stripped.replace(',', '.')
  const value = Number.parseFloat(normalized)
  return Number.isFinite(value) ? value : null
}

function readField(row: Element, spec: FieldSpec): CellValue {
  const selector = spec.selector.trim()
  let target: Element | null
  try {
    target = selector === '' || selector === '.' || selector === ':scope' ? row : resolveSelector(selector, row)
  } catch {
    throw new ExtractError('bad-args', `Field selector is not valid CSS: ${spec.selector}`)
  }
  if (target === null) return null
  let raw: string | null
  if (spec.attr === undefined) {
    raw = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
      ? target.value
      : textOf(target)
  } else if ((spec.attr === 'href' || spec.attr === 'src') && spec.attr in target) {
    raw = String((target as unknown as Record<string, unknown>)[spec.attr])
  } else {
    raw = target.getAttribute(spec.attr)
  }
  if (raw === null) return null
  // A sensitive field (password, card, one-time code; latched once judged)
  // is masked exactly as the snapshot masks it: its value never leaves the page.
  if ((spec.attr === undefined || spec.attr === 'value') && isSensitiveField(target)) return maskValue(raw)
  return spec.type === 'number' ? parseNumber(raw) : clean(raw)
}

function extractSchema(schema: RowSchema, limit: number): ExtractedRows {
  let rowElements: Element[]
  try {
    rowElements = resolveSelectorAll(schema.rows)
  } catch {
    throw new ExtractError('bad-args', `schema.rows is not a valid CSS selector: ${schema.rows}`)
  }
  const columns = Object.keys(schema.fields)
  const rows = rowElements.slice(0, limit).map((row) => {
    const record: Record<string, CellValue> = {}
    for (const column of columns) record[column] = readField(row, schema.fields[column]!)
    return record
  })
  return { columns, rows, dropped: Math.max(0, rowElements.length - limit) }
}

function uniqueColumns(names: string[]): string[] {
  const used = new Map<string, number>()
  return names.map((name, index) => {
    const base = name === '' ? `column${index + 1}` : name
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function extractTable(selector: string, limit: number): ExtractedRows {
  let table: Element | null
  try {
    table = resolveSelector(selector)
  } catch {
    throw new ExtractError('bad-args', `table is not a valid CSS selector: ${selector}`)
  }
  if (table === null) throw new ExtractError('action-failed', `No element matched table selector: ${selector}`)
  if (!(table instanceof HTMLTableElement)) {
    const inner = table.querySelector('table')
    if (inner === null) throw new ExtractError('action-failed', `${selector} is not a table and contains none.`)
    table = inner
  }
  const allRows = [...(table as HTMLTableElement).rows].filter((row) => row.closest('table') === table)
  const headerRow = (table as HTMLTableElement).tHead?.rows[0]
    ?? allRows.find((row) => row.cells.length > 0 && [...row.cells].every((cell) => cell.tagName === 'TH'))
  const width = Math.max(0, ...allRows.map((row) => row.cells.length))
  const columns = uniqueColumns(Array.from({ length: width }, (_, index) => {
    const cell = headerRow?.cells[index]
    return cell === undefined ? '' : textOf(cell)
  }))
  const bodyRows = allRows.filter((row) => row !== headerRow && row.parentElement?.tagName !== 'THEAD'
    && [...row.cells].some((cell) => cell.tagName === 'TD'))
  const rows = bodyRows.slice(0, limit).map((row) => {
    const record: Record<string, CellValue> = {}
    columns.forEach((column, index) => {
      const cell = row.cells[index]
      record[column] = cell === undefined ? null : textOf(cell)
    })
    return record
  })
  return { columns, rows, dropped: Math.max(0, bodyRows.length - limit) }
}

/**
 * Extract rows from the current document.
 * @param request - validated request.
 * @returns columns and records.
 */
export function extractRows(request: ExtractRequest): ExtractedRows {
  return request.kind === 'table' ? extractTable(request.table, request.limit) : extractSchema(request.schema, request.limit)
}
