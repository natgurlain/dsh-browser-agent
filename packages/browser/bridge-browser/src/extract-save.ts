/**
 * Host-side persistence for `browser_extract { saveTo }`: the extension
 * returns the rows, and the bridge writes them as CSV or JSON inside the
 * calling session's workspace.
 *
 * Paths are always workspace-relative. A path that leaves the workspace,
 * lexically or through a symlinked directory, is refused before anything is
 * written.
 *
 * @module
 */

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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
export class ExtractSaveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractSaveError'
  }
}

/**
 * The workspace directory of the calling session: its recorded working
 * directory, else the configured browser-session workspace.
 * @param agent - the calling Agent, when known.
 * @param fallback - configured workspace path ('' when disabled).
 * @returns an absolute directory, or undefined when none is known.
 */
export function sessionWorkspaceDir(agent: unknown, fallback: string): string | undefined {
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
  return fallback !== '' && isAbsolute(fallback) ? fallback : undefined
}

/**
 * Validate a workspace-relative save path and settle its format.
 * @param saveTo - the model-supplied relative path.
 * @param format - explicit format, else inferred from the extension (default csv).
 * @returns the normalized relative path and format.
 */
export function normalizeSavePath(saveTo: string, format?: string): { relativePath: string; format: ExtractFormat } {
  const trimmed = saveTo.trim()
  if (trimmed === '') throw new ExtractSaveError('saveTo must be a non-empty relative path.')
  if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    throw new ExtractSaveError(`saveTo must be relative to the session workspace; "${saveTo}" is absolute.`)
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    throw new ExtractSaveError(`saveTo must stay inside the session workspace; "${saveTo}" contains "..".`)
  }
  if (format !== undefined && format !== 'csv' && format !== 'json') {
    throw new ExtractSaveError('format must be csv or json.')
  }
  const ext = extname(trimmed).toLowerCase()
  const inferred: ExtractFormat = format ?? (ext === '.json' ? 'json' : 'csv')
  const relativePath = ext === '' ? `${trimmed}.${inferred}` : trimmed
  return { relativePath, format: inferred }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  // Leading formula characters are neutralized so a spreadsheet never executes page-authored text.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text
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

/** Whether `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Write extracted rows into the workspace.
 * @param workspace - absolute workspace directory.
 * @param saveTo - workspace-relative path.
 * @param data - rows to write.
 * @param format - explicit format, if any.
 * @returns where the file landed.
 */
export async function saveExtract(workspace: string, saveTo: string, data: ExtractData, format?: string): Promise<SavedExtract> {
  const normalized = normalizeSavePath(saveTo, format)
  const target = resolve(workspace, normalized.relativePath)
  if (!within(resolve(workspace), target)) {
    throw new ExtractSaveError(`saveTo must stay inside the session workspace; "${saveTo}" leaves it.`)
  }
  await mkdir(dirname(target), { recursive: true })
  // A symlinked directory inside the workspace must not redirect the write.
  const [realWorkspace, realParent] = await Promise.all([realpath(workspace), realpath(dirname(target))])
  if (!within(realWorkspace, realParent)) {
    throw new ExtractSaveError(`saveTo resolves outside the session workspace through a symbolic link: "${saveTo}".`)
  }
  const finalPath = join(realParent, target.slice(dirname(target).length + 1))
  await writeFile(finalPath, serializeRows(data, normalized.format), 'utf8')
  return { path: finalPath, relativePath: normalized.relativePath, format: normalized.format, rowCount: data.rows.length }
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
