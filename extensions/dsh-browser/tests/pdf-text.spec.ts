// @vitest-environment jsdom
/**
 * PDF text extraction for browser_pdf_text.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdfText, looksLikePdf, parseToUnicode, PdfTextError } from '../src/background/pdf-text.ts'

const encoder = new TextEncoder()

async function deflate(text: string): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close() } })
  const reader = source.pipeThrough(new CompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
  const chunks: number[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(...value)
  }
  return new Uint8Array(chunks)
}

/** Assemble a PDF from object bodies; streams may be binary. */
function pdf(objects: Array<{ dict: string; stream?: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode('%PDF-1.7\n')]
  objects.forEach((object, index) => {
    const num = index + 1
    if (object.stream === undefined) {
      parts.push(encoder.encode(`${num} 0 obj\n${object.dict}\nendobj\n`))
    } else {
      parts.push(encoder.encode(`${num} 0 obj\n${object.dict.replace('>>', ` /Length ${object.stream.length} >>`)}\nstream\n`))
      parts.push(object.stream)
      parts.push(encoder.encode('\nendstream\nendobj\n'))
    }
  })
  parts.push(encoder.encode('trailer\n<< /Root 1 0 R >>\n%%EOF\n'))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

describe('PDF text extraction', () => {
  it('reads Chrome print-to-PDF output (CID fonts with ToUnicode, kerning splits, two pages)', async () => {
    const bytes = new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/support/chrome-print.pdf')))
    const text = await extractPdfText(bytes)
    expect(text.pageCount).toBe(2)
    expect(text.pages[0]).toBe('Quarterly report\nRevenue grew 12% to €4.2M — naïve café test.\nAlpha 42')
    expect(text.pages[1]).toBe('Second page text 中文')
  })

  it('reads simple fonts, literal strings with escapes, TJ word gaps, and compressed content', async () => {
    const content = await deflate([
      'BT /F1 12 Tf 72 700 Td (Hello \\(world\\)) Tj ET',
      'BT /F1 12 Tf 72 680 Td [(Spaced) -300 (words)] TJ T* (Next line) Tj ET',
    ].join('\n'))
    const bytes = pdf([
      { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      { dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { dict: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
      { dict: '<< /Filter /FlateDecode >>', stream: content },
      { dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ])
    const text = await extractPdfText(bytes)
    expect(text.pages).toEqual(['Hello (world)\nSpaced words\nNext line'])
  })

  it('honours the page cap and page-tree order', async () => {
    const page = (label: string): Promise<Uint8Array> => deflate(`BT /F1 10 Tf 10 10 Td (${label}) Tj ET`)
    const bytes = pdf([
      { dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      { dict: '<< /Type /Pages /Kids [5 0 R 3 0 R] /Count 2 /Resources << /Font << /F1 7 0 R >> >> >>' },
      { dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
      { dict: '<< /Filter /FlateDecode >>', stream: await page('second') },
      { dict: '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>' },
      { dict: '<< /Filter /FlateDecode >>', stream: await page('first') },
      { dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ])
    expect((await extractPdfText(bytes)).pages).toEqual(['first', 'second'])
    expect(await extractPdfText(bytes, 1)).toEqual({ pages: ['first'], pageCount: 2 })
  })

  it('parses bfchar and bfrange ToUnicode entries', () => {
    const { map, width } = parseToUnicode(`
      begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0003> <0020> <0024> <0041> endbfchar
      1 beginbfrange <0044> <0046> <0061> endbfrange
      1 beginbfrange <0050> <0051> [<00660069> <006C>] endbfrange`)
    expect(width).toBe(2)
    expect([0x03, 0x24, 0x44, 0x45, 0x46, 0x50, 0x51].map((code) => map.get(code))).toEqual([' ', 'A', 'a', 'b', 'c', 'fi', 'l'])
  })

  it('rejects documents that are not PDFs', async () => {
    expect(looksLikePdf(encoder.encode('<html>'))).toBe(false)
    await expect(extractPdfText(encoder.encode('<html></html>'))).rejects.toBeInstanceOf(PdfTextError)
  })
})
