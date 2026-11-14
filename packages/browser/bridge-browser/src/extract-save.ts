/**
 * Host-side persistence for `browser_extract { saveTo }`: the extension
 * returns the rows, and the bridge writes them as CSV or JSON inside the
 * calling session's workspace.
 *
 * Paths are always workspace-relative `.csv`/`.json` files; the write itself
 * (sandbox check, containment, no overwrite) is workspace-write.ts.
 *
 * @module
 */

import { WorkspaceWriteError, workspacePathComponents, writeWorkspaceFile, type WorkspaceWriteTarget } from './workspace-write.ts'

/** Output formats the bridge writes. */
export type ExtractFormat = 'csv' | 'json'

/** Rows the extension extracted. */
export interface ExtractData {
  columns: string[]
  rows: Record<string, unknown>[]
  pages?: number
  url?: string
}

/** Where a save landed. */
export interface SavedExtract {
  /** Absolute path of the written file. */
  path: string
  /** Path relative to the workspace, as the model asked for it. */
  relativePath: string
  format: ExtractFormat
  rowCount: number
}

/** Failure the model can correct (bad path, missing workspace). */
export class ExtractSaveError extends WorkspaceWriteError {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractSaveError'
  }
}

/** Extensions `saveTo` may name. */
export const EXTRACT_EXTENSIONS: readonly string[] = ['.csv', '.json']

/**
 * Validate a workspace-relative save path and settle its format.
 * @param saveTo - the model-supplied relative path.
 * @param format - explicit format, else inferred from the extension (default csv).
 * @returns the normalized relative path and format.
 */
export function normalizeSavePath(saveTo: string, format?: string): { relativePath: string; format: ExtractFormat } {
  if (format !== undefined && format !== 'csv' && format !== 'json') {
    throw new ExtractSaveError('format must be csv or json.')
  }
  let parts: string[]
  try {
    parts = workspacePathComponents(saveTo, { allowedExt: EXTRACT_EXTENSIONS, defaultExt: `.${format ?? 'csv'}` })
  } catch (error: unknown) {
    throw new ExtractSaveError(`saveTo: ${error instanceof Error ? error.message : String(error)}`)
  }
  const relativePath = parts.join('/')
  const inferred: ExtractFormat = relativePath.toLowerCase().endsWith('.json') ? 'json' : 'csv'
  if (format !== undefined && format !== inferred) {
    throw new ExtractSaveError(`format ${format} does not match the extension of "${saveTo}".`)
  }
  return { relativePath, format: inferred }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  // Leading formula characters are neutralized so a spreadsheet never executes page-authored text.
  // Only a whole-cell plain number (e.g. -5, -5.25) is exempt.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * Serialize rows.
 * @param data - columns and rows.
 * @param format - csv or json.
 * @returns file contents.
 */
export function serializeRows(data: ExtractData, format: ExtractFormat): string {
  if (format === 'json') return `${JSON.stringify(data.rows, null, 2)}\n`
  const lines = [data.columns.map(csvCell).join(',')]
  for (const row of data.rows) lines.push(data.columns.map((column) => csvCell(row[column])).join(','))
  return `${lines.join('\r\n')}\r\n`
}

/**
 * Write extracted rows into the session workspace as a NEW file (see
 * workspace-write.ts for the sandbox, path, and no-overwrite rules).
 * @param target - from `workspaceWriteTarget`.
 * @param saveTo - workspace-relative path.
 * @param data - rows to write.
 * @param format - explicit format, if any.
 * @param portable - tests only: force the portable write strategy.
 * @returns where the file landed.
 */
export async function saveExtract(target: WorkspaceWriteTarget, saveTo: string, data: ExtractData, format?: string, portable?: boolean): Promise<SavedExtract> {
  const normalized = normalizeSavePath(saveTo, format)
  const written = await writeWorkspaceFile(target, normalized.relativePath, serializeRows(data, normalized.format), {
    allowedExt: EXTRACT_EXTENSIONS,
    ...portable === true ? { portable } : {},
  })
  return { path: written.path, relativePath: written.relativePath, format: normalized.format, rowCount: data.rows.length }
}

/**
 * Read the rows out of an extension result.
 * @param result - raw tool result from the extension.
 * @returns the rows, or undefined when the result carries none.
 */
export function extractDataOf(result: unknown): ExtractData | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const data = (result as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return undefined
  const { columns, rows, pages, url } = data as Record<string, unknown>
  if (!Array.isArray(columns) || !Array.isArray(rows)) return undefined
  return {
    columns: columns.map(String),
    rows: rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row)),
    ...typeof pages === 'number' ? { pages } : {},
    ...typeof url === 'string' ? { url } : {},
  }
}
