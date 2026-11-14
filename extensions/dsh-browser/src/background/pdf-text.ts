/**
 * Small PDF text extractor for `browser_pdf_text`.
 *
 * Chrome renders a PDF tab in its built-in viewer, which has no DOM a content
 * script can read. This module reads the document bytes instead and recovers
 * the text layer: it parses indirect objects (including compressed object
 * streams), inflates FlateDecode streams with `DecompressionStream`, walks the
 * page tree, maps glyph codes through each font's ToUnicode CMap (simple
 * fonts without one fall back to Latin-1), and interprets the text operators
 * (Tj, TJ, ', ", Td, TD, T*, Tm) with line-break heuristics.
 *
 * Out of scope: encrypted PDFs, scanned images (no text layer), text inside
 * form XObjects, and filters other than FlateDecode. Those return less text
 * or a clear error rather than garbage.
 *
 * The bytes come from a page, so every stage is bounded: total and
 * per-stream inflated bytes, chained filters, page-tree visits, object-stream
 * entries, CMap ranges, and an overall deadline (plus the caller's abort
 * signal). Scans are linear (bounded digit runs, no re-scan to end-of-file per
 * object), and the parse yields to the event loop regularly so the service
 * worker keeps answering approvals and the kill switch while it runs.
 *
 * @module
 */

/** Extracted text, page by page. */
export interface PdfText {
  pages: string[]
  /** Total page count found in the document (may exceed `pages.length` when capped). */
  pageCount: number
}

/** Failure with a model-facing explanation. */
export class PdfTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfTextError'
  }
}

/** A resource limit was hit: always fatal, never swallowed as "one bad stream". */
class PdfLimitError extends PdfTextError {}

/** Options for {@link extractPdfText}. */
export interface PdfTextOptions {
  /** Cancels the parse (kill switch, tool cancellation). */
  signal?: AbortSignal
  /** Overall time budget in milliseconds. */
  deadlineMs?: number
}

/** Total bytes all inflated streams may produce. */
const MAX_INFLATED_TOTAL = 50_000_000
/** Bytes one stream may inflate to. */
const MAX_INFLATED_STREAM = 20_000_000
/** Filters one stream may chain. */
const MAX_FILTERS = 2
/** Pages the page tree may yield. */
const MAX_PAGE_TREE_PAGES = 10_000
/** Page-tree nodes visited at most. */
const MAX_PAGE_TREE_NODES = 50_000
/** Objects indexed at most (file plus object streams). */
const MAX_OBJECTS = 1_000_000
/** Codes one ToUnicode CMap may map (ranges included). */
const MAX_CMAP_ENTRIES = 131_072
/** Default overall deadline. */
const DEFAULT_DEADLINE_MS = 10_000
/** Longest stretch of synchronous work before yielding to the event loop. */
const YIELD_EVERY_MS = 25

/** Shared budget for one extraction. */
class Budget {
  private inflated = 0
  private readonly deadline: number
  private lastYield = performance.now()

  constructor(private readonly signal: AbortSignal | undefined, deadlineMs: number) {
    this.deadline = performance.now() + deadlineMs
  }

  /** Throw when cancelled or past the deadline (synchronous checkpoints). */
  check(): void {
    if (this.signal?.aborted === true) throw new PdfLimitError('Reading the PDF was cancelled.')
    if (performance.now() > this.deadline) throw new PdfLimitError('Reading the PDF took too long; it may be too large or malformed.')
  }

  /** Check, and give the event loop a turn when work ran long. */
  async pause(): Promise<void> {
    this.check()
    if (performance.now() - this.lastYield < YIELD_EVERY_MS) return
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    this.lastYield = performance.now()
    this.check()
  }

  /** Account for inflated bytes. */
  inflate(bytes: number): void {
    this.inflated += bytes
    if (this.inflated > MAX_INFLATED_TOTAL) {
      throw new PdfLimitError(`The PDF expands to too much data (over ${MAX_INFLATED_TOTAL} bytes of decompressed streams).`)
    }
  }
}

/** `String.fromCharCode` over a large array without exceeding the argument limit. */
function charCodes(codes: ArrayLike<number>): string {
  let output = ''
  for (let index = 0; index < codes.length; index += 8_192) {
    output += String.fromCharCode(...Array.prototype.slice.call(codes, index, index + 8_192) as number[])
  }
  return output
}

/** A parsed indirect object: its dictionary source and raw stream bytes. */
interface PdfObject {
  /** Object body before `stream` (dictionary or value source, Latin-1). */
  body: string
  stream?: Uint8Array
}

type Ref = { num: number }

const LATIN1 = new TextDecoder('latin1')

function latin1(bytes: Uint8Array): string {
  return LATIN1.decode(bytes)
}

/** Inflate one zlib (FlateDecode) stream. Truncated trailing data is tolerated. */
async function inflate(bytes: Uint8Array, budget: Budget): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const stream = source.pipeThrough(new DecompressionStream('deflate') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_INFLATED_STREAM) {
        throw new PdfLimitError(`The PDF expands to too much data (a stream inflates past ${MAX_INFLATED_STREAM} bytes).`)
      }
      budget.inflate(value.length)
      budget.check()
      chunks.push(value)
    }
  } catch (error: unknown) {
    if (error instanceof PdfLimitError) {
      await reader.cancel().catch(() => undefined)
      throw error
    }
    // Missing checksum or trailing garbage: keep what inflated.
    if (total === 0) throw new PdfTextError('A compressed PDF stream could not be decoded.')
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

/** `/Key value` lookups on a dictionary source (shallow, good enough for PDF structure keys). */
function dictValue(body: string, key: string): string | undefined {
  const match = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`).exec(body)
  if (match === null) return undefined
  const start = match.index + match[0].length
  if (body.startsWith('<<', start)) return balanced(body, '<<', '>>', start)
  if (body.startsWith('[', start)) return balanced(body, '[', ']', start)
  const rest = body.slice(start, start + 256)
  const ref = /^(\d{1,10})\s+\d{1,5}\s+R/.exec(rest)
  if (ref !== null) return ref[0]
  const token = /^(\/[^\s/<>[\]()]{1,127}|[^\s/<>[\]()]{1,127}|\([^)]{0,200}\))/.exec(rest)
  return token?.[0]
}

/** The balanced `open … close` group starting at `start` (the rest of the source if unbalanced). */
function balanced(source: string, open: string, close: string, start = 0): string {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source.startsWith(open, index)) {
      depth += 1
      index += open.length - 1
    } else if (source.startsWith(close, index)) {
      depth -= 1
      index += close.length - 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return source.slice(start)
}

function asRef(value: string | undefined): Ref | undefined {
  const match = value === undefined ? null : /^(\d{1,10})\s+\d{1,5}\s+R$/.exec(value.trim())
  return match === null ? undefined : { num: Number(match[1]) }
}

function refsIn(value: string | undefined): Ref[] {
  if (value === undefined) return []
  return [...value.matchAll(/(?<!\d)(\d{1,10})\s+\d{1,5}\s+R\b/g)].map((match) => ({ num: Number(match[1]) }))
}

/**
 * First index of `needle` at or after `from`, with a cache so a sequence of
 * increasing `from` values scans the text once in total (a missing needle
 * must not cost a scan to end-of-file per object).
 */
function forwardFinder(text: string, needle: string): (from: number) => number {
  let found = -2
  return (from: number): number => {
    if (found === -1) return -1
    if (found < from) found = text.indexOf(needle, from)
    return found
  }
}

/** Index every indirect object in the file, then expand object streams. */
async function readObjects(bytes: Uint8Array, budget: Budget): Promise<Map<number, PdfObject>> {
  const text = latin1(bytes)
  const objects = new Map<number, PdfObject>()
  // Bounded digit runs keep the scan linear on long runs of digits.
  const header = /(?<!\d)(\d{1,10})\s+(\d{1,5})\s+obj\b/g
  const nextStream = forwardFinder(text, 'stream')
  const nextEndobj = forwardFinder(text, 'endobj')
  let match: RegExpExecArray | null
  let scanned = 0
  while ((match = header.exec(text)) !== null) {
    if ((scanned += 1) % 1_024 === 0) await budget.pause()
    if (objects.size >= MAX_OBJECTS) throw new PdfLimitError('The PDF has too many objects to read.')
    const num = Number(match[1])
    const start = match.index + match[0].length
    const endAt = nextEndobj(start)
    if (endAt === -1) break
    const candidate = nextStream(start)
    const streamAt = candidate !== -1 && candidate < endAt ? candidate : -1
    if (streamAt !== -1 && streamAt < endAt && /^\s*(?:<<[\s\S]*>>)\s*$/.test(text.slice(start, streamAt))) {
      let dataStart = streamAt + 'stream'.length
      if (text[dataStart] === '\r') dataStart += 1
      if (text[dataStart] === '\n') dataStart += 1
      const body = text.slice(start, streamAt)
      const declared = Number(dictValue(body, 'Length'))
      let dataEnd = Number.isInteger(declared) && declared > 0 && dataStart + declared <= text.length
        && text.startsWith('endstream', skipWhitespace(text, dataStart + declared))
        ? dataStart + declared
        : text.indexOf('endstream', dataStart)
      if (dataEnd === -1) dataEnd = endAt
      objects.set(num, { body, stream: bytes.subarray(dataStart, dataEnd) })
      const objectEnd = nextEndobj(dataEnd)
      if (objectEnd === -1) break
      header.lastIndex = objectEnd + 'endobj'.length
    } else {
      objects.set(num, { body: text.slice(start, endAt) })
      header.lastIndex = endAt + 'endobj'.length
    }
  }
  if (/\/Encrypt\b/.test(text.slice(Math.max(0, text.length - 4_096))) || /\/Encrypt\s+\d{1,10}\s+\d{1,5}\s+R/.test(text)) {
    throw new PdfTextError('This PDF is encrypted; its text cannot be extracted without the password.')
  }
  for (const object of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(object.body) || object.stream === undefined) continue
    let data: Uint8Array
    try {
      data = await decodeStream(object, budget)
    } catch (error: unknown) {
      if (error instanceof PdfLimitError) throw error
      continue
    }
    await budget.pause()
    const source = latin1(data)
    const declaredCount = Number(dictValue(object.body, 'N'))
    const first = Number(dictValue(object.body, 'First'))
    if (!Number.isInteger(declaredCount) || !Number.isInteger(first) || first < 0 || first > source.length) continue
    const pairs = source.slice(0, first).trim().split(/\s+/).map(Number)
    // /N is page-controlled: never iterate past the pairs actually present.
    const count = Math.min(declaredCount, Math.floor(pairs.length / 2))
    for (let index = 0; index < count; index += 1) {
      if (index % 4_096 === 4_095) await budget.pause()
      const num = pairs[index * 2]!
      const offset = first + pairs[index * 2 + 1]!
      const next = index + 1 < count ? first + pairs[(index + 1) * 2 + 1]! : source.length
      if (!Number.isInteger(num) || !Number.isInteger(offset) || !Number.isInteger(next) || offset > next) continue
      if (objects.size >= MAX_OBJECTS) throw new PdfLimitError('The PDF has too many objects to read.')
      if (!objects.has(num)) objects.set(num, { body: source.slice(offset, next) })
    }
  }
  return objects
}

function skipWhitespace(text: string, index: number): number {
  let at = index
  while (at < text.length && /\s/.test(text[at]!)) at += 1
  return at
}

async function decodeStream(object: PdfObject, budget: Budget): Promise<Uint8Array> {
  const data = object.stream ?? new Uint8Array()
  const filter = dictValue(object.body, 'Filter')
  if (filter === undefined) return data
  const filters = [...filter.matchAll(/\/(\w{1,64})/g)].map((match) => match[1])
  if (filters.length > MAX_FILTERS) throw new PdfTextError(`A PDF stream chains ${filters.length} filters (at most ${MAX_FILTERS} are read).`)
  let output = data
  for (const name of filters) {
    if (name === 'FlateDecode' || name === 'Fl') output = await inflate(output, budget)
    else throw new PdfTextError(`Unsupported PDF stream filter ${name}.`)
  }
  return output
}

// ---- Fonts: ToUnicode CMaps ----

interface FontDecoder {
  /** Bytes per glyph code (2 for Identity-H CID fonts). */
  width: 1 | 2
  map: Map<number, string>
  /** Whether codes without a mapping fall back to Latin-1. */
  latinFallback: boolean
}

function hexToString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const units: number[] = []
  for (let index = 0; index + 3 < clean.length; index += 4) units.push(Number.parseInt(clean.slice(index, index + 4), 16))
  if (clean.length % 4 === 2) units.push(Number.parseInt(clean.slice(-2), 16))
  return charCodes(units)
}

/** Parse bfchar/bfrange sections of a ToUnicode CMap. */
export function parseToUnicode(cmap: string): { map: Map<number, string>; width: 1 | 2 } {
  const map = new Map<number, string>()
  let expanded = 0
  let width: 1 | 2 = 2
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(cmap)
  if (space !== null && space[1]!.length <= 2) width = 1
  for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of section[1]!.matchAll(/<([0-9a-fA-F]{1,8})>\s*<([0-9a-fA-F]*)>/g)) {
      if ((expanded += 1) > MAX_CMAP_ENTRIES) break
      map.set(Number.parseInt(entry[1]!, 16), hexToString(entry[2]!))
    }
  }
  for (const section of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = section[1]!
    for (const entry of body.matchAll(/<([0-9a-fA-F]{1,8})>\s*<([0-9a-fA-F]{1,8})>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const low = Number.parseInt(entry[1]!, 16)
      // Codes are at most two bytes; every range is clamped to that space,
      // and the CMap as a whole may map a bounded number of codes.
      const high = Math.min(Number.parseInt(entry[2]!, 16), 0xFFFF)
      const target = entry[3]!
      if (low > high) continue
      expanded += high - low + 1
      if (expanded > MAX_CMAP_ENTRIES) break
      if (target.startsWith('[')) {
        const values = [...target.matchAll(/<([0-9a-fA-F]*)>/g)].map((value) => hexToString(value[1]!))
        for (let code = low; code <= high && code - low < values.length; code += 1) map.set(code, values[code - low]!)
      } else {
        const base = hexToString(target.slice(1, -1))
        const last = base.charCodeAt(base.length - 1)
        for (let code = low; code <= high; code += 1) {
          map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - low)))
        }
      }
    }
  }
  return { map, width }
}

// ---- Content streams ----

type Token =
  | { kind: 'string'; bytes: number[] }
  | { kind: 'array'; items: Token[] }
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }

/** Tokenize a content stream (strings, hex strings, arrays, names, numbers, operators). */
function* tokens(source: string): Generator<Token> {
  let index = 0
  const length = source.length
  const stack: Token[][] = []
  const emit = function* (token: Token): Generator<Token> {
    if (stack.length > 0) stack[stack.length - 1]!.push(token)
    else yield token
  }
  while (index < length) {
    const char = source[index]!
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '%') {
      while (index < length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (char === '(') {
      const bytes: number[] = []
      let depth = 1
      index += 1
      while (index < length && depth > 0) {
        const c = source[index]!
        if (c === '\\') {
          const next = source[index + 1] ?? ''
          const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
          if (next in escapes) { bytes.push(escapes[next]!); index += 2; continue }
          if (/[0-7]/.test(next)) {
            const octal = /^[0-7]{1,3}/.exec(source.slice(index + 1, index + 4))![0]
            bytes.push(Number.parseInt(octal, 8) & 0xff)
            index += 1 + octal.length
            continue
          }
          if (next === '\r' || next === '\n') {
            index += next === '\r' && source[index + 2] === '\n' ? 3 : 2
            continue
          }
          index += 1
          continue
        }
        if (c === '(') depth += 1
        if (c === ')') { depth -= 1; if (depth === 0) { index += 1; break } }
        bytes.push(c.charCodeAt(0) & 0xff)
        index += 1
      }
      yield* emit({ kind: 'string', bytes })
      continue
    }
    if (char === '<' && source[index + 1] === '<') {
      // Inline dictionaries (BDC properties, inline images): skip balanced.
      const skipped = balanced(source, '<<', '>>', index)
      index += skipped.length
      continue
    }
    if (char === '<') {
      const end = source.indexOf('>', index)
      const hex = source.slice(index + 1, end === -1 ? length : end).replace(/[^0-9a-fA-F]/g, '')
      const padded = hex.length % 2 === 1 ? `${hex}0` : hex
      const bytes: number[] = []
      for (let at = 0; at < padded.length; at += 2) bytes.push(Number.parseInt(padded.slice(at, at + 2), 16))
      yield* emit({ kind: 'string', bytes })
      index = end === -1 ? length : end + 1
      continue
    }
    if (char === '[') { stack.push([]); index += 1; continue }
    if (char === ']') {
      const items = stack.pop() ?? []
      index += 1
      yield* emit({ kind: 'array', items })
      continue
    }
    if (char === '/') {
      const match = /^\/[^\s/<>[\]()%{}]*/.exec(source.slice(index, index + 128))!
      index += match[0].length
      yield* emit({ kind: 'name', value: match[0].slice(1) })
      continue
    }
    const match = /^[^\s/<>[\]()%{}]+/.exec(source.slice(index, index + 64))
    if (match === null) { index += 1; continue }
    index += match[0].length
    const word = match[0]
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) yield* emit({ kind: 'number', value: Number(word) })
    else if (word === 'BI') {
      // Inline image data is binary: skip to EI.
      const end = source.indexOf('EI', index)
      index = end === -1 ? length : end + 2
    } else yield* emit({ kind: 'op', value: word })
  }
}

function decodeBytes(bytes: number[], font: FontDecoder | undefined): string {
  if (font === undefined) return charCodes(bytes)
  let output = ''
  if (font.width === 2) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = (bytes[index]! << 8) | bytes[index + 1]!
      output += font.map.get(code) ?? ''
    }
    return output
  }
  for (const byte of bytes) {
    const mapped = font.map.get(byte)
    output += mapped ?? (font.latinFallback ? String.fromCharCode(byte) : '')
  }
  return output
}

/** Interpret one page's content stream into text with line breaks. */
async function pageText(source: string, fonts: Map<string, FontDecoder>, budget: Budget): Promise<string> {
  // Pieces plus the last character: inspecting the end of a string built by
  // repeated += flattens it every time (quadratic on large pages).
  const parts: string[] = []
  let last = ''
  const write = (text: string): void => {
    if (text === '') return
    parts.push(text)
    last = text[text.length - 1]!
  }
  let font: FontDecoder | undefined
  let fontSize = 12
  const operands: Token[] = []
  let lastX: number | undefined
  let lastY: number | undefined
  /** Characters shown since the current line start: a crude advance estimate. */
  let lineChars = 0
  const newline = (): void => {
    if (last !== '' && last !== '\n') write('\n')
    lineChars = 0
  }
  const space = (): void => {
    if (last !== '' && !/\s/.test(last)) write(' ')
  }
  /**
   * A horizontal move is a word gap only when it lands clearly past where the
   * shown text (≈ half an em per character) ended; kerning splits land inside.
   */
  const horizontalGap = (advance: number): boolean => advance - lineChars * fontSize * 0.5 > fontSize * 0.3
  const append = (text: string): void => {
    write(text)
    lineChars += [...text].length
  }
  const show = (token: Token | undefined): void => {
    if (token?.kind === 'string') append(decodeBytes(token.bytes, font))
    else if (token?.kind === 'array') {
      for (const item of token.items) {
        if (item.kind === 'string') append(decodeBytes(item.bytes, font))
        // A large negative adjustment is a word gap in justified text.
        else if (item.kind === 'number' && item.value < -200 && last !== ' ') write(' ')
      }
    }
  }
  let seen = 0
  for (const token of tokens(source)) {
    if ((seen += 1) % 8_192 === 0) await budget.pause()
    if (token.kind !== 'op') {
      operands.push(token)
      continue
    }
    switch (token.value) {
      case 'Tf': {
        const name = operands.find((operand) => operand.kind === 'name')
        font = name?.kind === 'name' ? fonts.get(name.value) : undefined
        const size = operands.at(-1)
        if (size?.kind === 'number' && size.value > 0) fontSize = size.value
        break
      }
      case 'Tj':
        show(operands.at(-1))
        break
      case 'TJ':
        show(operands.at(-1))
        break
      case "'":
      case '"':
        newline()
        show(operands.at(-1))
        break
      case 'Td':
      case 'TD': {
        const tx = operands.at(-2)
        const ty = operands.at(-1)
        if (ty?.kind === 'number' && Math.abs(ty.value) > 0.01) newline()
        else {
          if (tx?.kind === 'number' && horizontalGap(tx.value)) space()
          lineChars = 0
          if (tx?.kind === 'number' && lastX !== undefined) lastX += tx.value
        }
        break
      }
      case 'T*':
        newline()
        break
      case 'Tm': {
        const x = operands.at(-2)
        const y = operands.at(-1)
        if (x?.kind === 'number' && y?.kind === 'number') {
          if (lastY !== undefined && Math.abs(y.value - lastY) > 0.5) newline()
          else if (lastX !== undefined && horizontalGap(x.value - lastX)) space()
          lastX = x.value
          lastY = y.value
          lineChars = 0
        }
        break
      }
      case 'ET':
        space()
        break
      default:
        break
    }
    operands.length = 0
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---- Document ----

async function resolveDict(objects: Map<number, PdfObject>, value: string | undefined): Promise<string | undefined> {
  const ref = asRef(value)
  if (ref !== undefined) return objects.get(ref.num)?.body
  return value
}

async function fontDecoders(objects: Map<number, PdfObject>, resources: string | undefined, cache: Map<number, FontDecoder>, budget: Budget): Promise<Map<string, FontDecoder>> {
  const fonts = new Map<string, FontDecoder>()
  const fontDict = await resolveDict(objects, dictValue(resources ?? '', 'Font'))
  if (fontDict === undefined) return fonts
  for (const entry of fontDict.matchAll(/\/([^\s/<>[\]()]{1,127})\s+(\d{1,10})\s+\d{1,5}\s+R/g)) {
    await budget.pause()
    const name = entry[1]!
    const num = Number(entry[2])
    const cached = cache.get(num)
    if (cached !== undefined) {
      fonts.set(name, cached)
      continue
    }
    const body = objects.get(num)?.body ?? ''
    const composite = /\/Subtype\s*\/Type0\b/.test(body)
    let decoder: FontDecoder = { width: composite ? 2 : 1, map: new Map(), latinFallback: !composite }
    const toUnicode = asRef(dictValue(body, 'ToUnicode'))
    const cmapObject = toUnicode === undefined ? undefined : objects.get(toUnicode.num)
    if (cmapObject !== undefined) {
      try {
        const parsed = parseToUnicode(latin1(await decodeStream(cmapObject, budget)))
        decoder = { width: composite ? 2 : parsed.width, map: parsed.map, latinFallback: !composite && parsed.map.size === 0 }
      } catch (error: unknown) {
        if (error instanceof PdfLimitError) throw error
        // Keep the fallback decoder.
      }
    }
    cache.set(num, decoder)
    fonts.set(name, decoder)
  }
  return fonts
}

/**
 * Page objects in document order, following the page tree from the catalog.
 * Each node is visited once (a /Kids cycle or a shared subtree cannot fan
 * out), and the walk stops at a fixed number of nodes and pages.
 */
function pageOrder(objects: Map<number, PdfObject>, budget: Budget): number[] {
  const catalog = [...objects.entries()].find(([, object]) => /\/Type\s*\/Catalog\b/.test(object.body))
  const order: number[] = []
  const visited = new Set<number>()
  const visit = (num: number, depth: number): void => {
    if (depth > 64 || visited.has(num) || visited.size >= MAX_PAGE_TREE_NODES || order.length >= MAX_PAGE_TREE_PAGES) return
    visited.add(num)
    if (visited.size % 1_024 === 0) budget.check()
    const body = objects.get(num)?.body ?? ''
    if (/\/Type\s*\/Pages\b/.test(body)) {
      for (const kid of refsIn(dictValue(body, 'Kids'))) visit(kid.num, depth + 1)
    } else if (/\/Type\s*\/Page\b/.test(body)) order.push(num)
  }
  const root = catalog === undefined ? undefined : asRef(dictValue(catalog[1].body, 'Pages'))
  if (root !== undefined) visit(root.num, 0)
  if (order.length > 0) return order
  return [...objects.entries()]
    .filter(([, object]) => /\/Type\s*\/Page\b/.test(object.body) && !/\/Type\s*\/Pages\b/.test(object.body))
    .map(([num]) => num)
    .sort((left, right) => left - right)
    .slice(0, MAX_PAGE_TREE_PAGES)
}

/** Inherited page attribute (Resources) from the page or its ancestors. */
function inherited(objects: Map<number, PdfObject>, pageBody: string, key: string): string | undefined {
  let body: string | undefined = pageBody
  for (let depth = 0; depth < 32 && body !== undefined; depth += 1) {
    const value = dictValue(body, key)
    if (value !== undefined) return value
    const parent = asRef(dictValue(body, 'Parent'))
    body = parent === undefined ? undefined : objects.get(parent.num)?.body
  }
  return undefined
}

/** Whether bytes look like a PDF file. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = latin1(bytes.subarray(0, 1_024))
  return head.includes('%PDF-')
}

/**
 * Extract the text layer of a PDF.
 * @param bytes - the whole file.
 * @param maxPages - stop after this many pages.
 * @param options - cancellation and the overall deadline.
 * @throws {PdfTextError} for unreadable documents and when a limit is hit.
 */
export async function extractPdfText(bytes: Uint8Array, maxPages = 50, options: PdfTextOptions = {}): Promise<PdfText> {
  if (!looksLikePdf(bytes)) throw new PdfTextError('The document is not a PDF file.')
  const budget = new Budget(options.signal, options.deadlineMs ?? DEFAULT_DEADLINE_MS)
  budget.check()
  const objects = await readObjects(bytes, budget)
  await budget.pause()
  const order = pageOrder(objects, budget)
  const pages: string[] = []
  const cache = new Map<number, FontDecoder>()
  for (const num of order.slice(0, maxPages)) {
    await budget.pause()
    const body = objects.get(num)?.body ?? ''
    const resources = await resolveDict(objects, inherited(objects, body, 'Resources'))
    const fonts = await fontDecoders(objects, resources, cache, budget)
    let content = ''
    for (const ref of refsIn(dictValue(body, 'Contents'))) {
      const object = objects.get(ref.num)
      if (object?.stream === undefined) continue
      try {
        content += `${latin1(await decodeStream(object, budget))}\n`
      } catch (error: unknown) {
        if (error instanceof PdfLimitError) throw error
        // An undecodable stream contributes no text.
      }
    }
    pages.push(await pageText(content, fonts, budget))
  }
  return { pages, pageCount: order.length }
}
