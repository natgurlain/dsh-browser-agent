// @vitest-environment jsdom
/**
 * browser_pdf_text re-GETs only the tab's own URL: a redirect elsewhere is
 * refused before any request reaches the target, and server headers never
 * reach the model (review PoC redirect-poc).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { readTabPdfText } from '../src/background/page-documents.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve) })))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const content = 'BT /F1 12 Tf (INTERNAL-ONLY payroll figures) Tj ET'
const secretPdf = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj\n%%EOF\n`

it('refuses a redirect away from the tab URL without requesting the target', async () => {
  const seen: string[] = []
  const intranet = await listen(createServer((request, response) => {
    seen.push(String(request.url))
    response.setHeader('content-type', 'application/pdf')
    response.end(secretPdf)
  }))
  const intranetPort = new URL(intranet).port
  const attacker = await listen(createServer((request, response) => {
    if (request.url === '/report.pdf') {
      response.statusCode = 302
      response.setHeader('location', `http://localhost:${intranetPort}/hr/payroll.pdf`)
      response.end()
      return
    }
    response.setHeader('content-type', 'text/html; note=PAGE-CONTROLLED-HEADER-TEXT')
    response.end('<html>hi</html>')
  }))
  const redirected = await readTabPdfText({ id: 1, url: `${attacker}/report.pdf` }, {}, 4000)
  expect(seen).toEqual([])
  expect(redirected.ok).toBe(false)
  expect(JSON.stringify(redirected)).not.toContain('payroll')
  expect(redirected.error?.message).toMatch(/redirect/i)
  const page = await readTabPdfText({ id: 1, url: `${attacker}/page` }, {}, 4000)
  expect(page.ok).toBe(false)
  expect(page.error?.message).not.toContain('PAGE-CONTROLLED-HEADER-TEXT')
  expect(page.error?.message).not.toContain('text/html')
})

it('refuses a response whose final URL left the tab origin even when the fetch followed it', async () => {
  const answer = await readTabPdfText({ id: 1, url: 'https://tab.example/a.pdf' }, {}, 4000, undefined, (async () => {
    const response = new Response(secretPdf, { status: 200, headers: { 'content-type': 'application/pdf' } })
    Object.defineProperty(response, 'url', { value: 'https://elsewhere.example/b.pdf' })
    return response
  }) as typeof fetch)
  expect(answer.ok).toBe(false)
  expect(JSON.stringify(answer)).not.toContain('payroll')
})
