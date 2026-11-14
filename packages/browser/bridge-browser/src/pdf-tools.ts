/**
 * `browser_save_pdf`: the extension renders the controlled tab with
 * `Page.printToPDF` and returns the bytes; this side writes them into the
 * browser-session workspace (the same directory extension-created sessions
 * use, see `session-workspace.ts`) and answers the model with the path.
 *
 * File names are derived from the model's `filename` (base name only) or the
 * page title, sanitized, and never overwrite an existing file.
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BridgeServer } from './server.ts'

/** Options for the PDF tool. */
export interface PdfToolOptions {
  toolTimeoutMs: number
  /** Directory the PDFs go into (`<session workspace>/pdf`). */
  directory: string
}

interface PdfWireResult {
  text?: string
  pdf?: { data?: unknown; title?: unknown; url?: unknown }
}

const MAX_NAME_CHARS = 80

/**
 * Turn a model- or page-supplied name into a safe file name ending in `.pdf`.
 * @param value - requested name or page title.
 * @param fallback - used when nothing usable remains.
 */
export function safePdfName(value: string | undefined, fallback: string): string {
  const base = (value ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/\.pdf$/i, '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_NAME_CHARS)
    .trim()
  return `${cleaned === '' ? fallback : cleaned}.pdf`
}

/** Write without overwriting: `name.pdf`, `name-2.pdf`, … */
async function writeUnique(directory: string, name: string, data: Buffer): Promise<string> {
  await mkdir(directory, { recursive: true })
  const stem = name.slice(0, -'.pdf'.length)
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const path = join(directory, attempt === 1 ? name : `${stem}-${attempt}.pdf`)
    try {
      await writeFile(path, data, { flag: 'wx', mode: 0o600 })
      return path
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Could not find a free file name for ${name} in ${directory}.`)
}

/**
 * Register `browser_save_pdf` on `ctx.tools`.
 * @returns a disposer for the caller's effect.
 */
export function registerPdfTool(ctx: Context, bridge: BridgeServer, options: PdfToolOptions): () => void {
  const tool = defineTool({
    name: 'browser_save_pdf',
    description: 'Save the controlled tab as a PDF file in the agent workspace and return its local path. Chrome only; requires approval.',
    parameters: {
      filename: { type: 'string', description: 'File name (no directories); defaults to the page title.' },
      landscape: { type: 'boolean', description: 'Landscape orientation. Defaults to false.' },
      background: { type: 'boolean', description: 'Print background graphics. Defaults to true.' },
    },
    timeoutMs: options.toolTimeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          path: { type: 'string' },
          bytes: { type: 'number' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
    },
    execute: async (args, exec) => {
      const a = args as { filename?: string; landscape?: boolean; background?: boolean }
      const wireArgs = {
        ...a.landscape !== undefined ? { landscape: a.landscape } : {},
        ...a.background !== undefined ? { background: a.background } : {},
      }
      const sessionId = exec.agent === undefined ? undefined : String((exec.agent as { id: unknown }).id)
      const result = await (sessionId === undefined
        ? bridge.requestTool('browser_save_pdf', wireArgs, exec.signal, options.toolTimeoutMs)
        : bridge.requestTool('browser_save_pdf', wireArgs, exec.signal, options.toolTimeoutMs, sessionId)) as PdfWireResult
      const data = result.pdf?.data
      if (typeof data !== 'string' || data === '') {
        throw new Error('The browser returned no PDF data.')
      }
      const bytes = Buffer.from(data, 'base64')
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('The browser returned data that is not a PDF.')
      }
      const title = typeof result.pdf?.title === 'string' ? result.pdf.title : undefined
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const name = safePdfName(a.filename ?? title, `page-${stamp}`)
      const path = await writeUnique(options.directory, name, bytes)
      const source = typeof result.pdf?.url === 'string' ? ` from ${result.pdf.url}` : ''
      return {
        text: `Saved the page${source} as a PDF: ${path} (${bytes.length} bytes).`,
        path,
        bytes: bytes.length,
      }
    },
  })
  return ctx.tools.register(tool)
}
