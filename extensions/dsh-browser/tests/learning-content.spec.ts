// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeElement, handleLearningMessage, probeRows, rowCells, sanitizedDom, sensitiveFieldCount, setWatching, pageTokens, siteDriverFetch } from '../src/content/learning.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildDriverRequest, validateSiteDriver } from 'dsh-browser-agent/src/learning/site-drivers.ts'

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

describe('handleLearningMessage', () => {
  const ids = new ElementIds()
  const handle = (message: Record<string, unknown>): { sync: boolean | undefined; responses: unknown[] } => {
    const responses: unknown[] = []
    const sync = handleLearningMessage(message as { type?: string } & Record<string, unknown>, ids, (response) => { responses.push(response) })
    return { sync, responses }
  }

  it('describes the focused element, or the selector target, and reports a missing target as a failure', () => {
    ;(document.querySelector('#name') as HTMLInputElement).focus()
    expect(handle({ type: 'DSH_LEARN_DESCRIBE' })).toEqual({ sync: false, responses: [{ ok: true, result: expect.objectContaining({ css: '#name', role: 'textbox' }) }] })
    expect(handle({ type: 'DSH_LEARN_DESCRIBE', args: { selector: '#pw' } }).responses[0]).toMatchObject({ ok: true, result: { sensitive: true, password: true } })
    expect(handle({ type: 'DSH_LEARN_DESCRIBE', args: { selector: '#gone' } }).responses[0]).toMatchObject({ ok: false, error: { code: 'action-failed' } })
  })

  it('answers token and fixture requests; a probe carries no HTML', () => {
    ;(document.querySelector('#pw') as HTMLInputElement).value = 'hunter2'
    expect(handle({ type: 'DSH_LEARN_TOKENS' }).responses[0]).toMatchObject({ ok: true, result: { metas: [{ name: 'csrf-token', value: 'meta-token-1234' }], filledSensitive: 1 } })
    expect(handle({ type: 'DSH_LEARN_FIXTURE', probe: true }).responses[0]).toEqual({ ok: true, result: { sensitiveCount: 1 } })
    const full = handle({ type: 'DSH_LEARN_FIXTURE' }).responses[0] as { ok: boolean; result: { html: string; sensitiveCount: number } }
    expect(full.ok).toBe(true)
    expect(full.result.html).toContain('dsh-browser fixture')
    expect(full.result.html).not.toContain('hunter2')
  })

  it('arms and disarms Watch me, and probes only well-formed selector sets', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    expect(handle({ type: 'DSH_WATCH', enabled: true })).toEqual({ sync: false, responses: [{ ok: true }] })
    expect(add).toHaveBeenCalledWith('click', expect.any(Function), true)
    handle({ type: 'DSH_WATCH', enabled: false })
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function), true)
    add.mockRestore()
    remove.mockRestore()
    const probe = handle({ type: 'DSH_WATCH_PROBE', selectors: [['#people > tbody > tr:nth-child(2) > td:nth-child(4) > button'], 'junk', [1]] })
    // Each row comes with what its step's element looks like and which row it sits in (learning-row-identity.spec.ts).
    expect(probe.responses[0]).toEqual({ ok: true, result: { rows: [['2', 'Grace', '', 'Invite']], targets: [[{ tag: 'button', role: 'button', name: 'Invite', row: '2 · Grace', rowKey: expect.stringMatching(/^[0-9a-f]{32}$/u) }]] } })
  })

  it('does not count a hidden row: the probe stops at the first element the user cannot see', () => {
    const button = (row: number) => `#people > tbody > tr:nth-child(${String(row)}) > td:nth-child(4) > button`
    expect(probeRows([[button(1)], [button(2)], [button(3)]])).toHaveLength(3)
    document.querySelector('#people tr:nth-child(2)')!.setAttribute('hidden', '')
    expect(probeRows([[button(1)], [button(2)], [button(3)]])).toHaveLength(1)
    document.querySelector('#people tr:nth-child(2)')!.removeAttribute('hidden')
    ;(document.querySelector(button(3)) as HTMLElement).style.display = 'none'
    expect(probeRows([[button(1)], [button(2)], [button(3)]])).toHaveLength(2)
    ;(document.querySelector(button(3)) as HTMLElement).style.display = ''
    ;(document.querySelector('#people') as HTMLElement).style.visibility = 'hidden'
    expect(probeRows([[button(1)]])).toHaveLength(0)
  })

  it('runs a site-driver fetch asynchronously and refuses another origin', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const responses: unknown[] = []
    const sync = handleLearningMessage({ type: 'DSH_SITE_DRIVER_FETCH', request: { method: 'GET', url: 'https://elsewhere.example/api', headers: {}, tokenHeaders: [] } }, ids, (response) => { responses.push(response) })
    expect(sync).toBe(true)
    await vi.waitFor(() => { expect(responses).toHaveLength(1) })
    expect(responses[0]).toMatchObject({ ok: false, error: { message: expect.stringMatching(/own origin/u) } })
    expect(fetchMock).not.toHaveBeenCalled()
    // A response that ended up on another origin is refused too.
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://elsewhere.example/landing', status: 200, ok: true, headers: new Headers(), text: async () => 'secret' })))
    const redirected: unknown[] = []
    handleLearningMessage({ type: 'DSH_SITE_DRIVER_FETCH', request: { method: 'GET', url: `${location.origin}/api`, headers: {}, tokenHeaders: [] } }, ids, (response) => { redirected.push(response) })
    await vi.waitFor(() => { expect(redirected).toHaveLength(1) })
    expect(redirected[0]).toMatchObject({ ok: false, error: { message: expect.stringMatching(/redirected to another origin/u) } })
    vi.unstubAllGlobals()
  })

  it('leaves other messages alone', () => {
    expect(handle({ type: 'DSH_ACTION' })).toEqual({ sync: undefined, responses: [] })
  })
})
