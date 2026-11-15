// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { PanelRpcError, type DiscoveryStatus, type PanelApi, type PanelSettings } from '../src/panel/api.ts'
import { fakePanelApi } from './support/panel-api.ts'
import type { BridgeFailure, BridgeState } from '../src/background/bridge.ts'
import { PANEL_COPY } from '../src/panel/strings.ts'
import { pairingFailureText } from '../src/panel/PairingCard.tsx'

let panelApi: PanelApi

vi.mock('../src/panel/api.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/panel/api.ts')>()),
  connectPanel: (): PanelApi => panelApi,
}))

import { App } from '../src/panel/App.tsx'

// English is the default locale of the panel.
const copy = PANEL_COPY.en

/** A pairing request the spec answers by hand, like the user would in DSH. */
interface Asked {
  showCode: (code: string) => void
  approve: () => void
  fail: (reason: string) => void
}

describe('pairing in the panel', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null, discovery: DiscoveryStatus, address?: string, failure?: BridgeFailure) => void) | undefined
  let pair: Mock<(onCode: (code: string) => void) => Promise<void>>
  let cancelPairing: Mock<() => Promise<void>>
  let updateSettings: Mock<(settings: Partial<PanelSettings>) => Promise<void>>
  let storedSettings: Record<string, unknown>
  let asked: Asked[]

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    storedSettings = {}
    asked = []
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: storedSettings })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
      runtime: {
        getManifest: () => ({ version: '0.1.6' }),
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    pair = vi.fn((onCode: (code: string) => void) => new Promise<void>((resolve, reject) => {
      asked.push({ showCode: onCode, approve: resolve, fail: reason => { reject(new PanelRpcError(reason, 'pairing failed')) } })
    }))
    cancelPairing = vi.fn(async () => {})
    updateSettings = vi.fn(async () => {})
    panelApi = fakePanelApi({
      rpc: vi.fn(async () => ({ items: [], events: [] })) as unknown as PanelApi['rpc'],
      onStatus: vi.fn((callback) => { onStatus = callback; return () => {} }),
      pair,
      cancelPairing,
      updateSettings,
    })
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="pairing-card"]')
  const code = (): string | undefined => card()?.querySelector('[data-testid="pairing-code"]')?.textContent ?? undefined
  const button = (label: string): HTMLButtonElement | undefined =>
    [...(card()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(candidate => candidate.textContent === label)

  async function unpaired(failure: BridgeFailure = 'no-token'): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('reconnecting', null, 'found', 'ws://127.0.0.1:3080/ext/bridge', failure) })
  }

  it('stays out of the way while connected', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('connected', null, 'found', 'ws://127.0.0.1:3080/ext/bridge') })
    expect(card()).toBeNull()
    expect(pair).not.toHaveBeenCalled()
  })

  it.each(['no-token', 'origin-rejected'] as const)('asks DSH by itself when the install cannot connect (%s) and shows the code to compare', async (failure) => {
    await unpaired(failure)
    expect(document.querySelector('.connection-label')?.textContent).toBe(copy.bridgeFailure[failure])
    // No click was needed: opening the panel is the user's whole first step.
    expect(pair).toHaveBeenCalledOnce()
    expect(card()?.textContent).toContain(copy.pairing.needed)
    expect(card()?.textContent).toContain(copy.pairing.asking)
    expect(code()).toBeUndefined()

    await act(async () => { asked[0]!.showCode('4F7-K2Q') })
    expect(code()).toBe('4F7-K2Q')
    expect(card()?.textContent).toContain('Approve in DeepSeek Harness')
    expect(card()?.textContent).toContain('/browser-pair approve')
    // Nothing to type and nothing to press while it waits.
    expect(card()!.querySelector('input')).toBeNull()
    expect(card()!.querySelectorAll('button')).toHaveLength(0)

    await act(async () => { asked[0]!.approve() })
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe(copy.pairing.paired)
    expect(code()).toBeUndefined()
  })

  it('waits for a click when a token stopped working (something may be in the way)', async () => {
    await unpaired('token-mismatch')
    expect(card()).not.toBeNull()
    expect(pair).not.toHaveBeenCalled()
    await act(async () => { button(copy.pairing.start)!.click() })
    expect(pair).toHaveBeenCalledOnce()
  })

  it.each([
    ['denied', copy.pairing.failure.denied],
    ['expired', copy.pairing.failure.expired],
    ['busy', copy.pairing.failure.busy],
    ['unreachable', copy.pairing.failure.unreachable],
    ['untrusted', copy.pairing.failure.untrusted],
  ] as const)('explains a failed request (%s) and asks again only on a click', async (reason, text) => {
    await unpaired()
    await act(async () => { asked[0]!.showCode('4F7-K2Q') })
    await act(async () => { asked[0]!.fail(reason) })
    const status = card()!.querySelector('[role="status"]')!
    expect(status.textContent).toBe(text)
    expect(status.className).toContain('settings-error')
    expect(code()).toBeUndefined()
    // No automatic retry: a denied or failing request is not repeated behind the user's back.
    expect(pair).toHaveBeenCalledOnce()
    await act(async () => { button(copy.pairing.retry)!.click() })
    expect(pair).toHaveBeenCalledTimes(2)
    await act(async () => { asked[1]!.showCode('ABC-DEF') })
    expect(code()).toBe('ABC-DEF')
    // A late answer to the first request changes nothing.
    await act(async () => { asked[0]!.showCode('ZZZ-ZZZ') })
    expect(code()).toBe('ABC-DEF')
  })

  it('withdraws a waiting request when the card goes away', async () => {
    await unpaired()
    await act(async () => { asked[0]!.showCode('4F7-K2Q') })
    expect(cancelPairing).not.toHaveBeenCalled()
    await act(async () => { onStatus?.('connected', null, 'found', 'ws://127.0.0.1:3080/ext/bridge') })
    expect(card()).toBeNull()
    expect(cancelPairing).toHaveBeenCalled()
  })

  it('offers pairing in Settings next to the manual token field, and a later Save keeps the paired token', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { document.querySelector<HTMLButtonElement>('.settings-trigger')!.click() })
    expect(card()).not.toBeNull()
    expect(card()?.textContent).toContain(copy.pairing.help)
    expect(document.querySelector<HTMLInputElement>('.settings-panel input[type="password"]')).not.toBeNull()
    // In Settings nothing is asked until the user says so.
    expect(pair).not.toHaveBeenCalled()

    await act(async () => { button(copy.pairing.start)!.click() })
    await act(async () => { asked[0]!.showCode('4F7-K2Q') })
    expect(code()).toBe('4F7-K2Q')
    // The background stores the token on approval; the form adopts it.
    storedSettings = { token: 'paired-token-from-the-bridge' }
    await act(async () => { asked[0]!.approve() })
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLInputElement>('.settings-panel input[type="password"]')!.value).toBe('paired-token-from-the-bridge')
    })
    const save = [...document.querySelectorAll<HTMLButtonElement>('button.primary')].find(candidate => candidate.textContent === copy.settings.save)!
    await act(async () => { save.click() })
    await vi.waitFor(() => { expect(updateSettings).toHaveBeenCalled() })
    expect(updateSettings.mock.calls[0]![0]).toMatchObject({ token: 'paired-token-from-the-bridge' })
  })

  it('has English and Chinese text for every pairing outcome', () => {
    for (const locale of ['en', 'zh'] as const) {
      const pairing = PANEL_COPY[locale].pairing
      expect(Object.keys(pairing.failure).sort()).toEqual(
        ['busy', 'cancelled', 'denied', 'expired', 'unreachable', 'unsupported', 'untrusted', 'version-mismatch'])
      expect(pairingFailureText(new PanelRpcError('denied', 'x'), pairing)).toBe(pairing.failure.denied)
      // Anything unexpected (a dropped port) reads as "not reachable", never as a blank line.
      expect(pairingFailureText(new Error('port closed'), pairing)).toBe(pairing.failure.unreachable)
      expect(pairingFailureText(new PanelRpcError('constructor', 'x'), pairing)).toBe(pairing.failure.unreachable)
      expect(PANEL_COPY[locale].bridgeFailure['no-token']).not.toBe('')
    }
    expect(PANEL_COPY.zh.pairing.title).toBe('与 DSH 配对')
    expect(PANEL_COPY.zh.pairing.approve).toBe('请在 DeepSeek Harness 中批准')
    expect(PANEL_COPY.zh.pairing.approveHelp).toContain('/browser-pair approve')
    expect(PANEL_COPY.en.pairing.approve).toBe('Approve in DeepSeek Harness')
  })
})
