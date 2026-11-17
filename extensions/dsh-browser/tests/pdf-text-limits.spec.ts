// @vitest-environment jsdom
/**
 * Hostile PDFs cannot exhaust memory or stall the service worker
 * (review PoC pdf-poc: bomb, kids, objstm, digits, objs, cmap, bigstr).
 */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractPdfText, PdfTextError } from '../src/background/pdf-text.ts'

const enc = (text: string): Buffer => Buffer.from(text, 'latin1')

function pdf(objects: (string | Buffer)[]): Uint8Array {
  return new Uint8Array(Buffer.concat([enc('%PDF-1.7\n'), ...objects.map((object) => typeof object === 'string' ? enc(object) : object), enc('%%EOF\n')]))
}

const base = (contents: Buffer | string): (string | Buffer)[] => [
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
  '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n',
  contents,
]

async function timed<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = performance.now()
  try {
    return { value: await run(), ms: performance.now() - started }
  } catch (error: unknown) {
    return { error, ms: performance.now() - started }
  }
}

describe('PDF extraction limits', () => {
  it('refuses a decompression bomb (chained FlateDecode) without inflating it all', async () => {
    const inner = deflateSync(Buffer.alloc(80_000_000, 0x20), { level: 9 })
    const outer = deflateSync(inner, { level: 9 })
    const stream = Buffer.concat([enc(`4 0 obj << /Length ${outer.length} /Filter [/FlateDecode /FlateDecode] >> stream\n`), outer, enc('\nendstream endobj\n')])
    const { error, ms } = await timed(() => extractPdfText(pdf(base(stream))))
    expect(error).toBeInstanceOf(PdfTextError)
    expect(String((error as Error).message)).toMatch(/too much data/)
    expect(ms).toBeLessThan(10_000)
  }, 30_000)

  it('refuses more than two chained filters', async () => {
    let data: Buffer = deflateSync(enc('BT (deep) Tj ET'))
    for (let round = 0; round < 3; round += 1) data = deflateSync(data)
    const stream = Buffer.concat([enc(`4 0 obj << /Length ${data.length} /Filter [/FlateDecode /FlateDecode /FlateDecode /FlateDecode] >> stream\n`), data, enc('\nendstream endobj\n')])
    const result = await extractPdfText(pdf(base(stream)))
    expect(result.pages).toEqual([''])
  })

  it('walks a self-referencing page tree once', async () => {
    const bytes = pdf([
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
      '2 0 obj << /Type /Pages /Kids [2 0 R 2 0 R] /Count 1 >> endobj\n',
    ])
    const { value, ms } = await timed(() => extractPdfText(bytes))
    expect(value?.pageCount).toBe(0)
    expect(ms).toBeLessThan(2_000)
  })

  it('clamps an object stream /N to the pairs it holds', async () => {
    const body = deflateSync(enc('10 0 << >>'))
    const stream = Buffer.concat([enc(`5 0 obj << /Type /ObjStm /N 99999999999 /First 5 /Length ${body.length} /Filter /FlateDecode >> stream\n`), body, enc('\nendstream endobj\n')])
    const { value, ms } = await timed(() => extractPdfText(pdf([...base('4 0 obj << >> endobj\n'), stream])))
    expect(value?.pageCount).toBe(1)
    expect(ms).toBeLessThan(2_000)
  })

  it('scans long digit runs and many objects in linear time', async () => {
    const digits = await timed(() => extractPdfText(pdf([...base('4 0 obj << >> endobj\n'), `${'1'.repeat(200_000)}\n`])))
    expect(digits.ms).toBeLessThan(2_000)
    const objects = await timed(() => extractPdfText(pdf([...base('4 0 obj << >> endobj\n'), '9 0 obj endobj\n'.repeat(100_000)])))
    expect(objects.value?.pageCount).toBe(1)
    expect(objects.ms).toBeLessThan(3_000)
  })

  it('bounds bfrange expansion', async () => {
    let ranges = ''
    for (let index = 0; index < 200; index += 1) {
      ranges += `<${(index * 65_536).toString(16).padStart(8, '0')}> <${(index * 65_536 + 65_535).toString(16).padStart(8, '0')}> <0041>\n`
      ranges += '<0000> <FFFF> <0041>\n'
    }
    const cmap = `begincodespacerange <0000> <FFFF> endcodespacerange\nbeginbfrange\n${ranges}endbfrange`
    const bytes = pdf([
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
      '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >> endobj\n',
      '4 0 obj << /Length 20 >> stream\nBT /F1 12 Tf <0041> Tj ET\nendstream endobj\n',
      '6 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 7 0 R >> endobj\n',
      `7 0 obj << /Length ${cmap.length} >> stream\n${cmap}\nendstream endobj\n`,
    ])
    const { value, ms } = await timed(() => extractPdfText(bytes))
    expect(value?.pageCount).toBe(1)
    expect(ms).toBeLessThan(2_000)
  })

  it('decodes a very long string without overflowing the call stack', async () => {
    const shown = `BT (${'A'.repeat(300_000)}) Tj ET`
    const result = await extractPdfText(pdf(base(`4 0 obj << /Length ${shown.length} >> stream\n${shown}\nendstream endobj\n`)))
    expect(result.pages[0]!.length).toBe(300_000)
  })

  // A wall-clock comparison: other jobs on the machine can stretch one slice, so a noisy run is
  // retried. A parser that really blocks the loop fails every attempt.
  it('keeps the event loop responsive while it parses (approvals, kill switch)', { retry: 2 }, async () => {
    const shown = 'BT (x) Tj 1 0 Td ET\n'.repeat(300_000)
    const bytes = pdf(base(`4 0 obj << /Length ${shown.length} >> stream\n${shown}\nendstream endobj\n`))
    // Worst gap between 5 ms timer ticks, and how many ticks ran.
    const watch = async (work: () => Promise<unknown>): Promise<{ worstGap: number; ticks: number }> => {
      let last = performance.now()
      let worstGap = 0
      let ticks = 0
      const ticker = setInterval(() => {
        const now = performance.now()
        worstGap = Math.max(worstGap, now - last)
        last = now
        ticks += 1
      }, 5)
      try {
        await work()
      } finally {
        clearInterval(ticker)
      }
      return { worstGap, ticks }
    }
    // What this machine does to an idle event loop right now: on a busy host
    // the scheduler alone can hold a tick back for longer than the parser may.
    const idle = await watch(() => new Promise((resolve) => setTimeout(resolve, 250)))
    const parsing = await watch(() => extractPdfText(bytes))
    // The parser yields: timers keep running throughout, and it adds at most
    // 200 ms to the worst pause the machine already shows when idle.
    expect(parsing.ticks).toBeGreaterThan(10)
    expect(parsing.worstGap).toBeLessThan(200 + 2 * idle.worstGap)
  }, 20_000)

  it('stops at the deadline and on abort', async () => {
    const shown = 'BT (x) Tj ET\n'.repeat(200_000)
    const bytes = pdf(base(`4 0 obj << /Length ${shown.length} >> stream\n${shown}\nendstream endobj\n`))
    await expect(extractPdfText(bytes, 50, { deadlineMs: 1 })).rejects.toThrow(/took too long/)
    const controller = new AbortController()
    controller.abort()
    await expect(extractPdfText(bytes, 50, { signal: controller.signal })).rejects.toThrow(/cancelled/)
  })
})
