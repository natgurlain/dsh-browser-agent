// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeElement, probeRows, rowCells, sanitizedDom, sensitiveFieldCount, setWatching, pageTokens, siteDriverFetch } from '../src/content/learning.ts'
import { buildDriverRequest, validateSiteDriver } from '@natgurlain/dsh-bridge-browser/src/learning/site-drivers.ts'

beforeEach(() => {
  document.body.innerHTML = `
    <meta name="csrf-token" content="meta-token-1234">
    <table id="people"><tbody>
      <tr><td>1</td><td>Ada</td><td><input aria-label="Email"></td><td><button>Invite</button></td></tr>
      <tr><td>2</td><td>Grace</td><td><input aria-label="Email"></td><td><button>Invite</button></td></tr>
      <tr><td>3</td><td>Linus</td><td><input aria-label="Email"></td><td><button>Invite</button></td></tr>
    </tbody></table>
    <form><input id="pw" type="password"><input id="name" aria-label="Name"><button id="save" onclick="void 0" type="button">Save</button></form>
    <script>window.x = 1</script>`
})

describe('learning content helpers', () => {
  it('describes an element as a robust locator and flags sensitive fields', () => {
    expect(describeElement(document.querySelector('#save')!)).toEqual({ role: 'button', name: 'Save', text: 'Save', css: '#save', sensitive: false, password: false })
    const pw = describeElement(document.querySelector('#pw')!)
    expect(pw).toMatchObject({ sensitive: true, password: true })
    expect(pw.text).toBeUndefined()
  })

  it('reads the row cells an element sits in', () => {
    expect(rowCells(document.querySelectorAll('#people button')[1]!)).toEqual(['2', 'Grace', '', 'Invite'])
    expect(rowCells(document.querySelector('#save')!)).toBeUndefined()
  })

  it('probes further rows until a selector stops resolving', () => {
    const rows = probeRows([
      ['#people > tbody > tr:nth-child(3) > td:nth-child(4) > button'],
      ['#people > tbody > tr:nth-child(4) > td:nth-child(4) > button'],
    ])
    expect(rows).toEqual([['3', 'Linus', '', 'Invite']])
  })

  it('sanitizes the DOM for a fixture: masked secrets, no scripts or handlers', () => {
    ;(document.querySelector('#pw') as HTMLInputElement).value = 'hunter2'
    ;(document.querySelector('#name') as HTMLInputElement).value = 'Ada'
    expect(sensitiveFieldCount()).toBe(1)
    const html = sanitizedDom()
    expect(html).not.toContain('hunter2')
    expect(html).toContain('data-dsh-masked="true"')
    expect(html).toContain('value="Ada"')
    expect(html).not.toContain('<script')
    expect(html).not.toContain("onclick")
  })

  it('masks a sensitive contenteditable even after a removed script sibling', () => {
    document.body.innerHTML = '<script>1</script><div><div contenteditable aria-label="password">hunter2-secret</div></div><div contenteditable aria-label="Notes">plain-notes</div>'
    const html = sanitizedDom()
    expect(html).not.toContain('hunter2-secret')
    expect(html).toContain('plain-notes')
  })

  it('finds CSRF meta tags and cookies only for matching', () => {
    document.cookie = 'csrftoken=cookie-token-1234'
    const tokens = pageTokens()
    expect(tokens.metas).toEqual([{ name: 'csrf-token', value: 'meta-token-1234' }])
    expect(tokens.cookies).toContainEqual({ name: 'csrftoken', value: 'cookie-token-1234' })
  })

  it('ignores untrusted (scripted) events while watching', () => {
    const send = vi.fn(async () => undefined)
    ;(globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage: send } }
    setWatching(true)
    ;(document.querySelector('#save') as HTMLButtonElement).click()
    setWatching(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('site-driver fetch refuses redirects and never fills tokens typed into a parameter', async () => {
    document.cookie = 'sessionid=SECRET-SESSION-COOKIE'
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))
    vi.stubGlobal('fetch', fetchMock)
    const driver = validateSiteDriver({ format: 'dsh-site-driver/v1', origin: location.origin, name: 'post', description: '', method: 'POST', path: '/api/comments',
      body: { type: 'json', template: '{"text":"{{text}}"}' }, headers: { 'content-type': 'application/json' }, tokens: [], params: [{ name: 'text' }] })
    await siteDriverFetch(buildDriverRequest(driver, { text: 'hi {{@cookie:sessionid}} {{@meta:csrf-token}}' }))
    const init = fetchMock.mock.calls[0]![1]
    expect(init.redirect).toBe('error')
    expect(String(init.body)).not.toMatch(/SECRET|meta-token/)
    vi.unstubAllGlobals()
  })
})
