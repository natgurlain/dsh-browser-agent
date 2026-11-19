/**
 * Document-level page tools: `browser_save_pdf` (render the controlled tab
 * with `Page.printToPDF`; the bridge writes the file into the session
 * workspace) and `browser_pdf_text` (fetch the PDF the tab shows and extract
 * its text layer, since the browser's PDF viewer has no readable DOM).
 *
 * @module
 */

import type { ToolError } from '@natgurlain/dsh-browser-agent/src/protocol.ts'
import { extractPdfText, looksLikePdf, PdfTextError } from './pdf-text.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import type { ToolAnswer } from './answers.ts'
import type { InputRuntime } from './input-actions.ts'

type DocumentAnswer = ToolAnswer
type DocumentInput = InputRuntime

/** Largest PDF handed to the bridge (base64 grows it by a third). */
const MAX_PDF_BYTES = 40_000_000
/** Largest PDF downloaded for text extraction. */
const MAX_FETCH_BYTES = 30_000_000
const FETCH_TIMEOUT_MS = 20_000

function failure(code: ToolError['code'], message: string): DocumentAnswer {
  return { ok: false, error: { code, message } }
}

/**
 * Render the tab as a PDF. The wire result carries base64 bytes plus the
 * page's title and URL; the bridge stores the file and answers the model with
 * its path.
 */
export async function savePagePdf(
  tab: { id: number; url?: string; title?: string },
  args: Record<string, unknown>,
  input: DocumentInput | undefined,
): Promise<DocumentAnswer> {
  if (input === undefined || !input.supported) {
    return failure('input-unavailable', 'browser_save_pdf needs the Chrome debugger (Page.printToPDF); this browser cannot render a page to PDF from the extension.')
  }
  const landscape = args.landscape === true
  const printBackground = args.background !== false
  const result = await input.run(tab.id, async (client) => client.send('Page.printToPDF', {
    landscape,
    printBackground,
    preferCSSPageSize: true,
    transferMode: 'ReturnAsBase64',
  })) as { data?: unknown }
  if (typeof result.data !== 'string' || result.data === '') {
    return failure('action-failed', 'The browser returned no PDF data.')
  }
  const bytes = Math.floor(result.data.length * 3 / 4)
  if (bytes > MAX_PDF_BYTES) {
    return failure('action-failed', `The rendered PDF is too large to transfer (${bytes} bytes; limit ${MAX_PDF_BYTES}).`)
  }
  return {
    ok: true,
    result: {
      text: `Rendered the page as a PDF (${bytes} bytes).`,
      pdf: {
        data: result.data,
        bytes,
        ...(tab.title === undefined ? {} : { title: tab.title }),
        ...(tab.url === undefined ? {} : { url: tab.url }),
      },
    },
  }
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/** Read the response body with a hard size cap. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) throw new PdfTextError(`The PDF is too large to read (${declared} bytes; limit ${cap}).`)
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new PdfTextError(`The PDF is too large to read (over ${cap} bytes).`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/**
 * Extract the text of the PDF the controlled tab shows. The extension fetches
 * the tab's own URL (with the user's cookies, as the viewer did); nothing
 * else can be named, so the call cannot be pointed at another document.
 */
export async function readTabPdfText(
  tab: { id: number; url?: string },
  args: Record<string, unknown>,
  maxChars: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<DocumentAnswer> {
  const maxPages = args.maxPages === undefined ? 50 : args.maxPages
  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    return failure('bad-args', 'maxPages must be an integer between 1 and 500.')
  }
  let url: URL
  try {
    url = new URL(tab.url ?? '')
  } catch {
    return failure('content-unavailable', 'The controlled tab has no URL to read a PDF from.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failure('content-unavailable', 'browser_pdf_text reads http(s) PDF documents only.')
  }
  try {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    // The approval names the tab's origin only: never follow a redirect (no
    // request may reach another URL with the user's cookies), and refuse a
    // response that did not come from the tab's own origin.
    const response = await fetchImpl(url.href, {
      credentials: 'include',
      redirect: 'manual',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return failure('action-failed', 'The tab URL redirects elsewhere; browser_pdf_text reads only the document at the tab\'s own URL. Open the final PDF URL in the tab, then retry.')
    }
    if (response.url !== '' && originOf(response.url) !== url.origin) {
      return failure('action-failed', 'The PDF response did not come from the tab\'s own origin, so it was not read.')
    }
    if (!response.ok) return failure('action-failed', `Fetching the PDF failed with HTTP ${response.status}.`)
    const bytes = await readCapped(response, MAX_FETCH_BYTES)
    if (!looksLikePdf(bytes)) {
      // Server headers (content-type included) are page-controlled: not echoed.
      return failure('action-failed', 'The controlled tab is not showing a PDF document. Use browser_snapshot or browser_get_text for web pages.')
    }
    const { pages, pageCount } = await extractPdfText(bytes, maxPages, signal === undefined ? {} : { signal })
    const body = pages.map((text, index) => `--- page ${index + 1} ---\n${text}`).join('\n\n')
    const empty = pages.every((text) => text === '')
    const status = empty
      ? `The PDF has ${pageCount} page(s) but no extractable text layer (it may be scanned images).`
      : `Extracted text from ${pages.length} of ${pageCount} PDF page(s).`
    return { ok: true, result: { text: empty ? status : `${status}\n${wrapUntrustedContent(body, Math.max(500, maxChars - status.length - 1))}` } }
  } catch (error: unknown) {
    if (error instanceof PdfTextError) return failure('action-failed', error.message)
    const detail = error instanceof Error ? error.message : String(error)
    return failure('action-failed', `The PDF could not be read: ${detail}`)
  }
}
