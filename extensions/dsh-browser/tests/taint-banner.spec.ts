// @vitest-environment jsdom
/**
 * The taint banner: one short sentence with host names (at most three, then
 * "+N more"), Clear, and one-click "Trust <site>" choices that only a real
 * click can use and that the background offers per source.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaintBanner, taintBannerView } from '../src/panel/TaintBanner.tsx'
import { SitePolicySettings } from '../src/panel/SitePolicySettings.tsx'
import { PANEL_COPY } from '../src/panel/strings.ts'
import { UNKNOWN_SOURCE, type TaintRecord } from '../src/security/taint.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FakePort {
  posted: Array<Record<string, unknown>>
  emit: (message: unknown) => void
}

let ports: FakePort[] = []
let root: Root | undefined

beforeEach(() => {
  ports = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: vi.fn(() => {
        const listeners: Array<(message: unknown) => void> = []
        const port = {
          posted: [] as Array<Record<string, unknown>>,
          emit: (message: unknown) => { for (const listener of listeners) listener(message) },
          postMessage: (message: Record<string, unknown>) => { port.posted.push(message) },
          onMessage: { addListener: (listener: (message: unknown) => void) => { listeners.push(listener) } },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
        }
        ports.push(port)
        return port
      }),
    },
    storage: {},
  }
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  document.body.innerHTML = ''
})

const record = (sources: string[]): TaintRecord => ({ sources, firstTool: 'browser_snapshot', since: 1 })

async function banner(sources: string[], trustable: Record<string, string> = {}, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(TaintBanner, { sessionId: 's1', locale: 'en', acceptSyntheticClicks: true, ...props })) })
  await act(async () => { ports[0]!.emit({ type: 'taint.state', records: { s1: record(sources) }, trustable: { s1: trustable } }) })
  return host
}

const buttons = (host: HTMLElement): string[] => [...host.querySelectorAll('button')].map((button) => button.textContent ?? '')
const button = (host: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  if (found === undefined) throw new Error(`no button "${label}" among ${JSON.stringify(buttons(host))}`)
  return found
}
const click = async (element: HTMLElement): Promise<void> => { await act(async () => { element.click() }) }
const sentence = (host: HTMLElement): string => host.querySelector('.taint-banner-row span')?.textContent ?? ''

describe('taint banner layout', () => {
  const en = PANEL_COPY.en.taint

  it('names host names, not origins, in one short sentence', () => {
    const view = taintBannerView(record(['https://seraph.quest', 'https://x.com']), undefined, en.unknownSource)
    expect(view).toMatchObject({ hosts: ['seraph.quest', 'x.com'], shown: ['seraph.quest', 'x.com'], more: 0, unknown: false, trust: [] })
    expect(en.body(view.shown.join(', '))).toBe('This conversation read web pages (seraph.quest, x.com), so risky actions ask first and shell and file tools are off.')
    // A port is part of the name a local page goes by; the same host over http and https is one site.
    expect(taintBannerView(record(['http://localhost:3000', 'http://a.example', 'https://a.example']), undefined, en.unknownSource).hosts).toEqual(['localhost:3000', 'a.example'])
  })

  it('names at most three hosts, then "+N more"', () => {
    const sources = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example']
    const view = taintBannerView(record(sources), undefined, en.unknownSource)
    expect(view.shown).toEqual(['a.example', 'b.example', 'c.example'])
    expect(view.more).toBe(2)
    expect(en.more(view.more)).toBe('+2 more')
    expect(taintBannerView(record(sources.slice(0, 3)), undefined, en.unknownSource).more).toBe(0)
  })

  it('keeps the unknown-source wording and never offers to trust beside it', () => {
    const offered = { 'https://a.example': 'a.example' }
    expect(taintBannerView(record([UNKNOWN_SOURCE]), offered, en.unknownSource)).toMatchObject({ hosts: ['an unknown origin'], unknown: true, trust: [] })
    expect(taintBannerView(record([]), offered, en.unknownSource)).toMatchObject({ hosts: ['an unknown origin'], unknown: true, trust: [] })
    expect(taintBannerView(record([UNKNOWN_SOURCE, 'https://a.example']), offered, en.unknownSource)).toMatchObject({ hosts: ['a.example', 'an unknown origin'], unknown: true, trust: [] })
    // A source that is no web origin is unknown too.
    expect(taintBannerView(record(['null']), offered, en.unknownSource).unknown).toBe(true)
  })

  it('offers one trust choice per site, covering every source of that site', () => {
    const view = taintBannerView(
      record(['http://a.example', 'https://a.example', 'https://b.example', 'http://localhost:3000']),
      { 'http://a.example': 'a.example', 'https://a.example': 'a.example', 'https://b.example': 'b.example' },
      en.unknownSource,
    )
    expect(view.trust).toEqual([{ site: 'a.example', origins: ['http://a.example', 'https://a.example'] }, { site: 'b.example', origins: ['https://b.example'] }])
  })

  it('has Chinese strings for every part', () => {
    const zh = PANEL_COPY.zh.taint
    expect(zh.body('seraph.quest, x.com')).toBe('本对话读取了网页（seraph.quest, x.com），因此高风险操作会先询问，命令行与文件工具已停用。')
    expect(zh.more(2)).toBe('另有 2 个')
    expect(zh.trust('x.com')).toBe('信任 x.com')
    expect(zh.trustMany).toBe('信任这些站点…')
    expect(PANEL_COPY.zh.sitePolicy.trustedNote).toBe('受信任站点的页面不会被当作不受信任的内容。')
    expect(PANEL_COPY.zh.sitePolicy.exemptLocal).not.toBe(PANEL_COPY.en.sitePolicy.exemptLocal)
    expect(PANEL_COPY.zh.sitePolicy.exemptTrusted).not.toBe(PANEL_COPY.en.sitePolicy.exemptTrusted)
  })
})

describe('taint banner buttons', () => {
  it('one source: "Trust <site>" and Clear', async () => {
    const host = await banner(['https://seraph.quest'], { 'https://seraph.quest': 'seraph.quest' })
    expect(sentence(host)).toBe('This conversation read web pages (seraph.quest), so risky actions ask first and shell and file tools are off.')
    expect(buttons(host)).toEqual(['Trust seraph.quest', 'Clear'])
  })

  it('two sources: one button each', async () => {
    const host = await banner(['https://seraph.quest', 'https://x.com'], { 'https://seraph.quest': 'seraph.quest', 'https://x.com': 'x.com' })
    expect(buttons(host)).toEqual(['Trust seraph.quest', 'Trust x.com', 'Clear'])
  })

  it('more than two: a single "Trust these sites…" that opens the list', async () => {
    const sources = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']
    const host = await banner(sources, Object.fromEntries(sources.map((source) => [source, new URL(source).hostname])))
    expect(sentence(host)).toContain('(a.example, b.example, c.example)')
    expect(buttons(host)).toEqual(['+1 more', 'Trust these sites…', 'Clear'])
    expect(host.querySelector('[data-testid="taint-trust-list"]')).toBeNull()
    await click(button(host, 'Trust these sites…'))
    const list = host.querySelector('[data-testid="taint-trust-list"]') as HTMLElement
    expect([...list.querySelectorAll('li')].map((item) => item.textContent)).toEqual(sources.map((source) => `${new URL(source).hostname}Trust ${new URL(source).hostname}`))
    // The full list of sources is one click (or a hover) away.
    expect(host.querySelector('.taint-banner-row span')?.getAttribute('title')).toBe('a.example, b.example, c.example, d.example')
    await click(button(host, '+1 more'))
    expect([...host.querySelectorAll('[data-testid="taint-sources"] li')].map((item) => item.textContent)).toEqual(['a.example', 'b.example', 'c.example', 'd.example'])
  })

  it('an unknown source: only Clear, with the unknown-source wording', async () => {
    const host = await banner([UNKNOWN_SOURCE, 'https://seraph.quest'], { 'https://seraph.quest': 'seraph.quest' })
    expect(sentence(host)).toBe('This conversation read web pages (seraph.quest, an unknown origin), so risky actions ask first and shell and file tools are off.')
    expect(buttons(host)).toEqual(['Clear'])
  })

  it('sources the background does not offer get no button (local pages, restricted sites)', async () => {
    const host = await banner(['http://localhost:3000', 'https://x.com'], { 'https://x.com': 'x.com' })
    expect(sentence(host)).toContain('(localhost:3000, x.com)')
    expect(buttons(host)).toEqual(['Trust x.com', 'Clear'])
  })

  it('no source on offer: only Clear', async () => {
    const host = await banner(['https://www.paypal.com'])
    expect(buttons(host)).toEqual(['Clear'])
  })

  it('"Trust" asks first with the same sentence Settings shows, then sends exactly that site\'s sources', async () => {
    const host = await banner(['http://x.com', 'https://x.com', 'https://seraph.quest'], { 'http://x.com': 'x.com', 'https://x.com': 'x.com', 'https://seraph.quest': 'seraph.quest' })
    await click(button(host, 'Trust x.com'))
    // Nothing is sent before the confirmation.
    expect(ports[0]!.posted.filter((message) => message.type === 'taint.trust')).toEqual([])
    const confirm = host.querySelector('[data-testid="taint-trust-confirm"]') as HTMLElement
    expect(confirm.querySelector('span')?.textContent).toBe(`Trust x.com? ${PANEL_COPY.en.sitePolicy.trustedNote}`)
    expect(PANEL_COPY.en.sitePolicy.trustedNote).toBe('Pages from trusted sites are not treated as untrusted content.')
    await click(button(confirm, 'Cancel'))
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
    expect(ports[0]!.posted.filter((message) => message.type === 'taint.trust')).toEqual([])
    await click(button(host, 'Trust x.com'))
    await click(button(host.querySelector('[data-testid="taint-trust-confirm"]') as HTMLElement, 'Trust'))
    expect(ports[0]!.posted.filter((message) => message.type === 'taint.trust')).toEqual([
      expect.objectContaining({ type: 'taint.trust', sessionId: 's1', origins: ['http://x.com', 'https://x.com'] }),
    ])
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
  })

  it('tells the panel to reload its settings once a trust went through', async () => {
    const onTrusted = vi.fn()
    await banner(['https://x.com'], { 'https://x.com': 'x.com' }, { onTrusted })
    await act(async () => { ports[0]!.emit({ type: 'taint.trust.result', id: 'x', ok: false, cleared: false }) })
    expect(onTrusted).not.toHaveBeenCalled()
    await act(async () => { ports[0]!.emit({ type: 'taint.trust.result', id: 'y', ok: true, cleared: true }) })
    expect(onTrusted).toHaveBeenCalledTimes(1)
  })

  it('only a real user click can trust: a scripted click does nothing', async () => {
    // As mounted in the panel (no test seam): jsdom clicks are synthetic, like a script's.
    const host = await banner(['https://x.com'], { 'https://x.com': 'x.com' }, { acceptSyntheticClicks: false })
    await click(button(host, 'Trust x.com'))
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
    expect(ports[0]!.posted.filter((message) => message.type === 'taint.trust')).toEqual([])
    // Clear works as before.
    await click(button(host, 'Clear'))
    expect(ports[0]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })

  it('Clear clears exactly the shown session, as before', async () => {
    const host = await banner(['https://seraph.quest'], { 'https://seraph.quest': 'seraph.quest' })
    await click(button(host, 'Clear'))
    expect(ports[0]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })
})

describe('where a site is marked trusted', () => {
  it('Settings says what trusting means, and has the two exemption switches', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const onChange = vi.fn()
    const value = { siteRules: [], siteDefaultsEnabled: true, strictSites: [], taintExemptLocalPages: true, taintExemptTrustedSites: true }
    await act(async () => { root!.render(createElement(SitePolicySettings, { value, onChange, locale: 'en' })) })
    expect(host.querySelector('.trusted-note')?.textContent).toBe('Pages from trusted sites are not treated as untrusted content.')
    expect(host.textContent).toContain('Don\'t restrict sessions that only read local pages')
    expect(host.textContent).toContain('Don\'t restrict sessions that only read sites I trust')
    const toggles = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    const local = toggles.find((toggle) => toggle.closest('label')?.textContent?.includes('local pages') === true)
    expect(local?.checked).toBe(true)
    await click(local!)
    expect(onChange).toHaveBeenCalledWith({ ...value, taintExemptLocalPages: false })
  })
})
