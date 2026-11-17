// @vitest-environment jsdom
/**
 * The taint banner: one short sentence with host names (at most three, then
 * "+N more"), Clear, and one-click choices that only a real click can use and
 * that the background offers per source; and the Settings rows of the taint
 * exemptions.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { siteNameParts, TaintBanner, taintBannerView } from '../src/panel/TaintBanner.tsx'
import { TaintExemptionSettings, type TaintExemptionValue } from '../src/panel/TaintExemptionSettings.tsx'
import { SettingsKitCopyContext } from '../src/panel/SettingsKit.tsx'
import { PANEL_COPY } from '../src/panel/strings.ts'
import { UNKNOWN_SOURCE, type TaintRecord } from '../src/security/taint.ts'
import type { TrustOffer } from '../src/security/taint-exempt.ts'

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
const site = (entry: string): TrustOffer => ({ kind: 'site', entry })
const local = (entry: string): TrustOffer => ({ kind: 'local', entry })
const sites = (origins: string[]): Record<string, TrustOffer> => Object.fromEntries(origins.map((origin) => [origin, site(new URL(origin).hostname)]))

async function banner(sources: string[], trustable: Record<string, TrustOffer> = {}, props: Record<string, unknown> = {}): Promise<HTMLElement> {
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
const trustMessages = (): Array<Record<string, unknown>> => ports[0]!.posted.filter((message) => message.type === 'taint.trust')

describe('taint banner layout', () => {
  const en = PANEL_COPY.en.taint

  it('names only the pages that were read: a destination that was only attempted is not listed and gets no Trust button', async () => {
    const denied: TaintRecord = { ...record(['http://helpdesk.example.test', 'http://shop.localhost:4180']), attempted: ['https://verify.example'] }
    const view = taintBannerView(denied, sites(['https://verify.example']), en.unknownSource)
    expect(view.hosts).toEqual(['helpdesk.example.test', 'shop.localhost:4180'])
    expect(view.trust).toEqual([])
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(TaintBanner, { sessionId: 's1', locale: 'en', acceptSyntheticClicks: true })) })
    // Even if a (buggy or forged) state offered it, the banner renders no choice for it.
    await act(async () => { ports[0]!.emit({ type: 'taint.state', records: { s1: denied }, trustable: { s1: sites(['https://verify.example']) } }) })
    expect(host.textContent).toContain('(helpdesk.example.test, shop.localhost:4180)')
    expect(host.textContent).not.toContain('verify.example')
    expect(buttons(host)).toEqual([en.clear])
  })

  it('does not name the user\'s own exempt pages, which tainted nothing', async () => {
    const sources = ['http://crm.localhost:4180', 'http://hours.localhost:4180', 'https://shop-a.example', 'https://shop-b.example']
    const exempt = ['http://crm.localhost:4180', 'http://hours.localhost:4180']
    const view = taintBannerView(record(sources), sites(['https://shop-a.example', 'https://shop-b.example']), en.unknownSource, exempt)
    expect(view.hosts).toEqual(['shop-a.example', 'shop-b.example'])
    expect(view.trust.map((choice) => choice.site)).toEqual(['shop-a.example', 'shop-b.example'])
    // Only exempt sources (it should have been lifted): name them rather than nothing.
    expect(taintBannerView(record(exempt), undefined, en.unknownSource, exempt).hosts).toEqual(['crm.localhost:4180', 'hours.localhost:4180'])
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(TaintBanner, { sessionId: 's1', locale: 'en', acceptSyntheticClicks: true })) })
    await act(async () => { ports[0]!.emit({ type: 'taint.state', records: { s1: record(sources) }, trustable: {}, exemptSources: { s1: exempt } }) })
    expect(host.textContent).toContain('(shop-a.example, shop-b.example)')
    expect(host.textContent).not.toContain('localhost')
  })

  it('names host names, not origins, in one short sentence that says why', () => {
    const view = taintBannerView(record(['https://seraph.quest', 'https://x.com']), undefined, en.unknownSource)
    expect(view).toMatchObject({ hosts: ['seraph.quest', 'x.com'], shown: ['seraph.quest', 'x.com'], more: 0, unknown: false, trust: [], local: [] })
    expect(en.body(view.shown.join(', '))).toBe('This conversation read web pages that could contain instructions (seraph.quest, x.com), so risky actions ask first and shell and file tools are off.')
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

  it('keeps the unknown-source wording and never offers a choice beside it', () => {
    const offered = { 'https://a.example': site('a.example'), 'http://localhost:3000': local('http://localhost:3000') }
    expect(taintBannerView(record([UNKNOWN_SOURCE]), offered, en.unknownSource)).toMatchObject({ hosts: ['an unknown origin'], unknown: true, trust: [], local: [] })
    expect(taintBannerView(record([]), offered, en.unknownSource)).toMatchObject({ hosts: ['an unknown origin'], unknown: true, trust: [] })
    expect(taintBannerView(record([UNKNOWN_SOURCE, 'https://a.example', 'http://localhost:3000']), offered, en.unknownSource)).toMatchObject({ unknown: true, trust: [], local: [] })
    // A source that is no web origin is unknown too.
    expect(taintBannerView(record(['null']), offered, en.unknownSource).unknown).toBe(true)
  })

  it('offers one trust choice per site, and one question per local address', () => {
    const view = taintBannerView(
      record(['https://a.example', 'https://www.a.example', 'https://b.example', 'http://localhost:3000', 'http://localhost:8080']),
      { 'https://a.example': site('a.example'), 'https://b.example': site('b.example'), 'http://localhost:8080': local('http://localhost:8080') },
      en.unknownSource,
    )
    expect(view.trust).toEqual([{ site: 'a.example', origins: ['https://a.example'] }, { site: 'b.example', origins: ['https://b.example'] }])
    expect(view.local).toEqual([{ site: 'localhost:8080', origins: ['http://localhost:8080'] }])
  })

  it('F6: shows the registrable domain in bold and cuts a long subdomain prefix in the middle', () => {
    expect(siteNameParts('seraph.quest')).toEqual({ prefix: '', domain: 'seraph.quest' })
    expect(siteNameParts('mail.google.com')).toEqual({ prefix: 'mail.', domain: 'google.com' })
    expect(siteNameParts('user.github.io')).toEqual({ prefix: '', domain: 'user.github.io' })
    // A look-alike prefix cannot push the real domain out of sight.
    const long = siteNameParts(`paypal.com.${'a'.repeat(40)}.secure-login.evil.example`)
    expect(long.domain).toBe('evil.example')
    expect(long.prefix.length).toBeLessThanOrEqual(20)
    expect(long.prefix).toBe('paypal.co…re-login.')
  })

  it('has Chinese strings for every part', () => {
    const zh = PANEL_COPY.zh.taint
    expect(zh.body('seraph.quest, x.com')).toBe('本对话读取了可能包含指令的网页（seraph.quest, x.com），因此高风险操作会先询问，命令行与文件工具已停用。')
    expect(zh.more(2)).toBe('另有 2 个')
    expect(zh.trust('x.com')).toBe('信任 x.com')
    expect(zh.trustMany).toBe('信任这些站点…')
    expect(zh.localQuestion('localhost:3000')).toBe('把 localhost:3000 的页面当作你自己的页面？')
    for (const key of ['trustEffects', 'localYes', 'confirmTrust', 'cancel', 'clear'] as const) expect(zh[key]).not.toBe(PANEL_COPY.en.taint[key])
    for (const key of ['trustedNote', 'exemptLocal', 'exemptLocalHelp', 'exemptLocalMore', 'exemptTrusted', 'exemptTrustedHelp', 'exemptTrustedMore', 'localOriginsLabel', 'taintTrustedLabel', 'keepAll', 'keepOne'] as const) {
      expect(PANEL_COPY.zh.sitePolicy[key], key).not.toBe(PANEL_COPY.en.sitePolicy[key])
    }
    expect(PANEL_COPY.zh.sitePolicy.keepQuestion(3)).toContain('3')
  })

  it('F6: the button never says "untrusted", and the sentence says what the pages could do', () => {
    for (const locale of ['en', 'zh'] as const) {
      const copy = PANEL_COPY[locale].taint
      expect(copy.trust('x.com').toLowerCase()).not.toContain('untrusted')
      expect(copy.trustMany.toLowerCase()).not.toContain('untrusted')
    }
    expect(en.body('x.com')).toContain('could contain instructions')
    // Both effects that remain, stated plainly.
    expect(en.trustEffects).toContain('will no longer restrict conversations')
    expect(en.trustEffects).toContain('shell and file tools back')
    expect(en.trustEffects).toContain('Approval cards for actions on the site do not change')
  })
})

describe('taint banner buttons', () => {
  it('one source: "Trust <site>" and Clear', async () => {
    const host = await banner(['https://seraph.quest'], sites(['https://seraph.quest']))
    expect(sentence(host)).toBe('This conversation read web pages that could contain instructions (seraph.quest), so risky actions ask first and shell and file tools are off.')
    expect(buttons(host)).toEqual(['Trust seraph.quest', 'Clear'])
  })

  it('two sources: one button each', async () => {
    const host = await banner(['https://seraph.quest', 'https://x.com'], sites(['https://seraph.quest', 'https://x.com']))
    expect(buttons(host)).toEqual(['Trust seraph.quest', 'Trust x.com', 'Clear'])
  })

  it('more than two: a single "Trust these sites…" that opens the list', async () => {
    const sources = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']
    const host = await banner(sources, sites(sources))
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
    const host = await banner([UNKNOWN_SOURCE, 'https://seraph.quest'], sites(['https://seraph.quest']))
    expect(sentence(host)).toBe('This conversation read web pages that could contain instructions (seraph.quest, an unknown origin), so risky actions ask first and shell and file tools are off.')
    expect(buttons(host)).toEqual(['Clear'])
  })

  it('sources the background does not offer get no button (exempt pages, restricted sites)', async () => {
    const host = await banner(['http://localhost:3000', 'https://x.com'], sites(['https://x.com']))
    expect(sentence(host)).toContain('(localhost:3000, x.com)')
    expect(buttons(host)).toEqual(['Trust x.com', 'Clear'])
  })

  it('no source on offer: only Clear', async () => {
    const host = await banner(['https://www.paypal.com'])
    expect(buttons(host)).toEqual(['Clear'])
  })

  it('"Trust" asks first, says what it does, then sends exactly that site\'s sources', async () => {
    const offered = { 'https://x.com': site('x.com'), 'https://mail.x.com': site('x.com'), 'https://seraph.quest': site('seraph.quest') }
    const host = await banner(Object.keys(offered), offered)
    await click(button(host, 'Trust x.com'))
    // Nothing is sent before the confirmation.
    expect(trustMessages()).toEqual([])
    const confirm = host.querySelector('[data-testid="taint-trust-confirm"]') as HTMLElement
    expect(confirm.querySelector('span')?.textContent).toBe(`Trust x.com? ${PANEL_COPY.en.taint.trustEffects}`)
    expect(confirm.querySelector('strong')?.textContent).toBe('x.com')
    await click(button(confirm, 'Cancel'))
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
    expect(trustMessages()).toEqual([])
    await click(button(host, 'Trust x.com'))
    await click(button(host.querySelector('[data-testid="taint-trust-confirm"]') as HTMLElement, 'Trust'))
    expect(trustMessages()).toEqual([expect.objectContaining({ type: 'taint.trust', sessionId: 's1', origins: ['https://x.com', 'https://mail.x.com'] })])
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
  })

  it('a local address: one question, one click', async () => {
    const host = await banner(['http://localhost:3000'], { 'http://localhost:3000': local('http://localhost:3000') })
    expect(host.querySelector('[data-testid="taint-local-question"] span')?.textContent).toBe('Treat pages from localhost:3000 as yours?')
    expect(buttons(host)).toEqual(['Clear', 'Yes, they are mine'])
    await click(button(host, 'Yes, they are mine'))
    expect(trustMessages()).toEqual([expect.objectContaining({ type: 'taint.trust', sessionId: 's1', origins: ['http://localhost:3000'] })])
  })

  it('tells the panel to reload its settings once a choice went through', async () => {
    const onTrusted = vi.fn()
    await banner(['https://x.com'], sites(['https://x.com']), { onTrusted })
    await act(async () => { ports[0]!.emit({ type: 'taint.trust.result', id: 'x', ok: false, cleared: false }) })
    expect(onTrusted).not.toHaveBeenCalled()
    await act(async () => { ports[0]!.emit({ type: 'taint.trust.result', id: 'y', ok: true, cleared: true }) })
    expect(onTrusted).toHaveBeenCalledTimes(1)
  })

  it('only a real user click can trust: a scripted click does nothing', async () => {
    // As mounted in the panel (no test seam): jsdom clicks are synthetic, like a script's.
    const host = await banner(['https://x.com', 'http://localhost:3000'], { 'https://x.com': site('x.com'), 'http://localhost:3000': local('http://localhost:3000') }, { acceptSyntheticClicks: false })
    await click(button(host, 'Trust x.com'))
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
    await click(button(host, 'Yes, they are mine'))
    expect(trustMessages()).toEqual([])
    // Clear works as before.
    await click(button(host, 'Clear'))
    expect(ports[0]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })

  it('Clear clears exactly the shown session, as before', async () => {
    const host = await banner(['https://seraph.quest'], sites(['https://seraph.quest']))
    await click(button(host, 'Clear'))
    expect(ports[0]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })
})

describe('taint banner with Auto approve', () => {
  const en = PANEL_COPY.en.taint
  const auto = { autoApprove: true }
  const summary = (host: HTMLElement): HTMLButtonElement => host.querySelector('.taint-quiet-summary') as HTMLButtonElement

  it('Auto off: the full yellow banner, wording and buttons exactly as before', async () => {
    const host = await banner(['https://seraph.quest'], sites(['https://seraph.quest']), { autoApprove: false })
    const element = host.querySelector('[data-testid="taint-banner"]') as HTMLElement
    expect(element.className).toBe('taint-banner')
    expect(host.querySelector('.taint-quiet-summary')).toBeNull()
    expect(sentence(host)).toBe('This conversation read web pages that could contain instructions (seraph.quest), so risky actions ask first and shell and file tools are off.')
    expect(buttons(host)).toEqual(['Trust seraph.quest', 'Clear'])
  })

  it('Auto on: one slim neutral line with a details toggle and Clear; the full sentence is in the title and read to screen readers', async () => {
    const sources = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']
    const host = await banner(sources, sites(['https://a.example']), auto)
    const element = host.querySelector('[data-testid="taint-banner"]') as HTMLElement
    expect(element.classList.contains('taint-quiet')).toBe(true)
    expect(element.getAttribute('role')).toBe('status')
    // Only two controls on the line: no Trust button, no "+N more", no long sentence in view.
    expect(buttons(host)).toEqual([en.quiet, en.clear])
    expect(summary(host).textContent).toBe('Web pages read · shell and file tools paused')
    const full = 'This conversation read web pages that could contain instructions (a.example, b.example, c.example, d.example). Auto approve checks risky actions before they run; shell and file tools are off.'
    expect(summary(host).getAttribute('title')).toBe(full)
    const described = document.getElementById(summary(host).getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toBe(full)
    expect(described?.className).toBe('sr-only')
    expect(host.querySelector('[data-testid="taint-details"]')).toBeNull()
    expect(summary(host).getAttribute('aria-expanded')).toBe('false')
  })

  it('Auto on: the toggle opens the full sentence with every site, and the Trust choice', async () => {
    const host = await banner(['https://seraph.quest', 'https://x.com'], sites(['https://seraph.quest', 'https://x.com']), auto)
    await click(summary(host))
    expect(summary(host).getAttribute('aria-expanded')).toBe('true')
    const details = host.querySelector('[data-testid="taint-details"]') as HTMLElement
    expect(summary(host).getAttribute('aria-controls')).toBe(details.id)
    expect(details.querySelector('p')?.textContent).toBe(en.bodyAuto('seraph.quest, x.com'))
    expect(buttons(details)).toEqual(['Trust seraph.quest', 'Trust x.com'])
    await click(summary(host))
    expect(host.querySelector('[data-testid="taint-details"]')).toBeNull()
  })

  it('switching Auto approve off with the details open shows the old banner closed, as before', async () => {
    const sources = ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']
    const host = await banner(sources, {}, auto)
    await click(summary(host))
    await act(async () => { root!.render(createElement(TaintBanner, { sessionId: 's1', locale: 'en', acceptSyntheticClicks: true, autoApprove: false })) })
    expect(host.querySelector('[data-testid="taint-sources"]')).toBeNull()
    expect(buttons(host)).toEqual(['+1 more', 'Clear'])
    await act(async () => { root!.render(createElement(TaintBanner, { sessionId: 's1', locale: 'en', acceptSyntheticClicks: true, autoApprove: true })) })
    expect(summary(host).getAttribute('aria-expanded')).toBe('true')
  })

  it('Auto on: Clear clears exactly the shown session, as before', async () => {
    const host = await banner(['https://seraph.quest'], sites(['https://seraph.quest']), auto)
    await click(button(host, 'Clear'))
    expect(ports[0]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })

  it('Auto on: "Trust" still asks first and sends exactly that site\'s sources; the confirmation stays if the details close', async () => {
    const offered = { 'https://x.com': site('x.com'), 'https://mail.x.com': site('x.com') }
    const host = await banner(Object.keys(offered), offered, auto)
    await click(summary(host))
    await click(button(host, 'Trust x.com'))
    expect(trustMessages()).toEqual([])
    await click(summary(host))
    const confirm = host.querySelector('[data-testid="taint-trust-confirm"]') as HTMLElement
    expect(confirm.querySelector('span')?.textContent).toBe(`Trust x.com? ${en.trustEffects}`)
    await click(button(confirm, 'Trust'))
    expect(trustMessages()).toEqual([expect.objectContaining({ type: 'taint.trust', sessionId: 's1', origins: ['https://x.com', 'https://mail.x.com'] })])
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
  })

  it('Auto on: more than two sites still open the list of Trust choices', async () => {
    const sources = ['https://a.example', 'https://b.example', 'https://c.example']
    const host = await banner(sources, sites(sources), auto)
    await click(summary(host))
    await click(button(host, 'Trust these sites…'))
    const list = host.querySelector('[data-testid="taint-trust-list"]') as HTMLElement
    expect([...list.querySelectorAll('li span')].map((item) => item.textContent)).toEqual(['a.example', 'b.example', 'c.example'])
  })

  it('Auto on: a local address still asks its question on its own row, one click', async () => {
    const host = await banner(['http://localhost:3000'], { 'http://localhost:3000': local('http://localhost:3000') }, auto)
    expect(host.querySelector('[data-testid="taint-local-question"] span')?.textContent).toBe('Treat pages from localhost:3000 as yours?')
    expect(buttons(host)).toEqual([en.quiet, 'Clear', 'Yes, they are mine'])
    await click(button(host, 'Yes, they are mine'))
    expect(trustMessages()).toEqual([expect.objectContaining({ type: 'taint.trust', sessionId: 's1', origins: ['http://localhost:3000'] })])
  })

  it('Auto on: an unknown source offers no choice, only Clear', async () => {
    const host = await banner([UNKNOWN_SOURCE, 'https://seraph.quest'], sites(['https://seraph.quest']), auto)
    await click(summary(host))
    expect(buttons(host)).toEqual([en.quiet, 'Clear'])
    expect(host.querySelector('[data-testid="taint-details"] p')?.textContent).toContain('(seraph.quest, an unknown origin)')
  })

  it('Auto on: only a real user click can trust; a scripted click does nothing, and Clear works', async () => {
    const host = await banner(['https://x.com', 'http://localhost:3000'], { 'https://x.com': site('x.com'), 'http://localhost:3000': local('http://localhost:3000') }, { ...auto, acceptSyntheticClicks: false })
    await click(summary(host))
    await click(button(host, 'Trust x.com'))
    expect(host.querySelector('[data-testid="taint-trust-confirm"]')).toBeNull()
    await click(button(host, 'Yes, they are mine'))
    expect(trustMessages()).toEqual([])
    await click(button(host, 'Clear'))
    expect(ports[0]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })

  it('Auto on: Chinese strings', async () => {
    expect(PANEL_COPY.zh.taint.quiet).toBe('已读取网页 · 命令行与文件工具已暂停')
    expect(PANEL_COPY.zh.taint.quiet).not.toBe(en.quiet)
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(TaintBanner, { sessionId: 's1', locale: 'zh', autoApprove: true })) })
    await act(async () => { ports[0]!.emit({ type: 'taint.state', records: { s1: record(['https://x.com']) }, trustable: {} }) })
    expect(buttons(host)).toEqual(['已读取网页 · 命令行与文件工具已暂停', '清除'])
  })
})

describe('taint exemption settings', () => {
  const value: TaintExemptionValue = {
    taintExemptLocalPages: true,
    taintExemptTrustedSites: true,
    taintLocalOrigins: ['http://localhost:3000'],
    taintTrustedSites: ['wiki.example'],
    taintTrustConfirmed: ['rule:new.example'],
    siteRules: [{ pattern: 'new.example', rule: 'trusted' }, { pattern: 'old.example', rule: 'trusted' }, { pattern: 'ask.example', rule: 'ask' }],
    trustedActionOrigins: ['https://old-allowed.example'],
  }

  async function settings(onChange = vi.fn()): Promise<{ host: HTMLElement; onChange: ReturnType<typeof vi.fn> }> {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(SettingsKitCopyContext.Provider, { value: { learnMore: 'Learn more' } },
        createElement(TaintExemptionSettings, { value, onChange, locale: 'en' })))
    })
    return { host, onChange }
  }

  it('two simple switches: label, one short help line, toggle', async () => {
    const { host, onChange } = await settings()
    const rows = [...host.querySelectorAll('label.setting-toggle')]
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Don\'t restrict sessions that only read local pages',
      'Don\'t restrict sessions that only read sites I trust',
    ])
    for (const row of rows) expect((row.querySelector('small')?.textContent ?? '').length).toBeLessThan(110)
    const toggles = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(toggles.map((toggle) => toggle.checked)).toEqual([true, true])
    await click(toggles[0]!)
    expect(onChange).toHaveBeenCalledWith({ taintExemptLocalPages: false })
    await click(toggles[1]!)
    expect(onChange).toHaveBeenCalledWith({ taintExemptTrustedSites: false })
  })

  it('lists the local pages and the taint-only sites, each removable', async () => {
    const { host, onChange } = await settings()
    expect(host.querySelector('.taint-local-origins code')?.textContent).toBe('http://localhost:3000')
    await click(host.querySelector('.taint-local-origins .entry-remove') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith({ taintLocalOrigins: [] })
    const trusted = host.querySelector('.taint-trusted-sites > .entry-list') as HTMLElement
    expect(trusted.querySelector('code')?.textContent).toBe('wiki.example')
    expect(trusted.querySelector('.entry-tag')?.textContent).toBe('Sites not treated as untrusted content')
    await click(trusted.querySelector('.entry-remove') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith({ taintTrustedSites: [] })
  })

  it('asks once about trusted sites that predate the exemption: keep all, or pick', async () => {
    const { host, onChange } = await settings()
    const callout = host.querySelector('.callout') as HTMLElement
    expect(callout.querySelector('p')?.textContent).toBe('2 sites you trusted earlier will no longer restrict conversations. Keep?')
    expect([...callout.querySelectorAll('code')].map((entry) => entry.textContent)).toEqual(['old.example', 'https://old-allowed.example'])
    await click(callout.querySelector('[data-testid="taint-keep-all"]') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith({ taintTrustConfirmed: ['origin:https://old-allowed.example', 'rule:new.example', 'rule:old.example'] })
    await click(button(callout.querySelector('.entry-list') as HTMLElement, 'Keep'))
    expect(onChange).toHaveBeenLastCalledWith({ taintTrustConfirmed: ['rule:new.example', 'rule:old.example'] })
  })
})
