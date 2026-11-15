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

describe('pairing in the panel', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null, discovery: DiscoveryStatus, address?: string, failure?: BridgeFailure) => void) | undefined
  let pair: Mock<(code: string) => Promise<void>>
  let updateSettings: Mock<(settings: Partial<PanelSettings>) => Promise<void>>
  let storedSettings: Record<string, unknown>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    storedSettings = {}
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: storedSettings })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
      runtime: {
        getManifest: () => ({ version: '0.1.6' }),
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    pair = vi.fn(async () => {})
    updateSettings = vi.fn(async () => {})
    panelApi = fakePanelApi({
      rpc: vi.fn(async () => ({ items: [], events: [] })) as unknown as PanelApi['rpc'],
      onStatus: vi.fn((callback) => { onStatus = callback; return () => {} }),
      pair,
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

  async function typeCode(value: string): Promise<void> {
    const input = card()!.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function submit(): Promise<void> {
    await act(async () => {
      card()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('stays out of the way while connected, and offers pairing when the install has no token', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('connected', null, 'found', 'ws://127.0.0.1:3080/ext/bridge') })
    expect(card()).toBeNull()

    await act(async () => { onStatus?.('reconnecting', null, 'found', 'ws://127.0.0.1:3080/ext/bridge', 'no-token') })
    expect(document.querySelector('.connection-label')?.textContent).toBe('Not paired with DSH yet')
    expect(card()?.textContent).toContain('Pair with DSH')
    expect(card()?.textContent).toContain(copy.pairing.needed)
    expect(card()?.textContent).toContain('/browser-pair')
    // Nothing to send yet.
    expect(card()!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  })

  it.each(['origin-rejected', 'token-mismatch'] as const)('also offers pairing after the bridge refused this install (%s)', async (failure) => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('reconnecting', null, 'found', undefined, failure) })
    expect(card()).not.toBeNull()
    expect(document.querySelector('.connection-label')?.textContent).toBe(copy.bridgeFailure[failure])
  })

  it('sends the typed code to the background and reports success', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('reconnecting', null, 'found', undefined, 'no-token') })
    await typeCode('abcd-efgh')
    await submit()
    expect(pair).toHaveBeenCalledExactlyOnceWith('abcd-efgh')
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe(copy.pairing.paired)
    // The code is not kept on screen once used.
    expect(card()!.querySelector('input')!.value).toBe('')
  })

  it.each([
    ['wrong-code', copy.pairing.failure['wrong-code']],
    ['closed', copy.pairing.failure.closed],
    ['invalid-code', copy.pairing.failure['invalid-code']],
    ['untrusted', copy.pairing.failure.untrusted],
  ] as const)('explains a failed pairing (%s) and lets the user try again', async (code, text) => {
    pair.mockRejectedValueOnce(new PanelRpcError(code, 'pairing failed'))
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { onStatus?.('reconnecting', null, 'found', undefined, 'no-token') })
    await typeCode('ABCDEFGH')
    await submit()
    const status = card()!.querySelector('[role="status"]')!
    expect(status.textContent).toBe(text)
    expect(status.className).toContain('settings-error')
    expect(card()!.querySelector('input')!.value).toBe('ABCDEFGH')
    expect(card()!.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  })

  it('keeps the manual token field, and a later Save keeps the paired token', async () => {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => { document.querySelector<HTMLButtonElement>('.settings-trigger')!.click() })
    // Settings always carries the pairing card, next to the token field (the fallback).
    expect(card()).not.toBeNull()
    expect(document.querySelector<HTMLInputElement>('.settings-panel input[type="password"]')).not.toBeNull()

    // The background stores the token while pairing; the form adopts it.
    pair.mockImplementationOnce(async () => { storedSettings = { token: 'paired-token-from-the-bridge' } })
    await typeCode('ABCDEFGH')
    await submit()
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLInputElement>('.settings-panel input[type="password"]')!.value).toBe('paired-token-from-the-bridge')
    })
    const save = [...document.querySelectorAll<HTMLButtonElement>('button.primary')].find(button => button.textContent === copy.settings.save)!
    await act(async () => { save.click() })
    await vi.waitFor(() => { expect(updateSettings).toHaveBeenCalled() })
    expect(updateSettings.mock.calls[0]![0]).toMatchObject({ token: 'paired-token-from-the-bridge' })
  })

  it('has English and Chinese text for every pairing outcome', () => {
    for (const locale of ['en', 'zh'] as const) {
      const pairing = PANEL_COPY[locale].pairing
      expect(Object.keys(pairing.failure).sort()).toEqual(
        ['closed', 'invalid-code', 'timeout', 'unreachable', 'unsupported', 'untrusted', 'version-mismatch', 'wrong-code'])
      expect(pairingFailureText(new PanelRpcError('wrong-code', 'x'), pairing)).toBe(pairing.failure['wrong-code'])
      // Anything unexpected (a dropped port) reads as "not reachable", never as a blank line.
      expect(pairingFailureText(new Error('port closed'), pairing)).toBe(pairing.failure.unreachable)
      expect(pairingFailureText(new PanelRpcError('constructor', 'x'), pairing)).toBe(pairing.failure.unreachable)
      expect(PANEL_COPY[locale].bridgeFailure['no-token']).not.toBe('')
    }
    expect(PANEL_COPY.zh.pairing.title).toBe('与 DSH 配对')
    expect(PANEL_COPY.zh.pairing.help).toContain('/browser-pair')
    expect(PANEL_COPY.en.pairing.title).toBe('Pair with DSH')
  })
})
