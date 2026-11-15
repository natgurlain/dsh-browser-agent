// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaintBanner } from '../src/panel/TaintBanner.tsx'
import { WatchersCard } from '../src/panel/WatchersCard.tsx'
import { connectLearning } from '../src/panel/learning-api.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FakePort {
  name: string
  posted: Array<Record<string, unknown>>
  emit: (message: unknown) => void
  drop: () => void
  dead: boolean
  postMessage: (message: Record<string, unknown>) => void
  onMessage: { addListener: (listener: (message: unknown) => void) => void }
  onDisconnect: { addListener: (listener: () => void) => void }
  disconnect: () => void
}

let ports: FakePort[] = []

function fakePort(name: string): FakePort {
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  const port: FakePort = {
    name,
    posted: [],
    dead: false,
    emit: (message) => { for (const listener of messageListeners) listener(message) },
    drop: () => {
      port.dead = true
      for (const listener of disconnectListeners) listener()
    },
    postMessage: (message) => {
      // A real Port throws once the other end is gone.
      if (port.dead) throw new Error('Attempting to use a disconnected port object')
      port.posted.push(message)
    },
    onMessage: { addListener: (listener) => { messageListeners.push(listener) } },
    onDisconnect: { addListener: (listener) => { disconnectListeners.push(listener) } },
    disconnect: () => { port.dead = true },
  }
  return port
}

let root: Root | undefined

beforeEach(() => {
  vi.useFakeTimers()
  ports = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: vi.fn(({ name }: { name: string }) => {
        const port = fakePort(name)
        ports.push(port)
        return port
      }),
    },
  }
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(element) })
  return host
}

describe('panel side ports reconnect after the background restarts', () => {
  it('taint banner resubscribes on a new port and its Clear uses the live port', async () => {
    const host = await mount(createElement(TaintBanner, { sessionId: 's1', locale: 'en' }))
    expect(ports).toHaveLength(1)
    expect(ports[0]!.posted).toEqual([{ type: 'taint.subscribe' }])
    await act(async () => { ports[0]!.drop() })
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(ports).toHaveLength(2)
    expect(ports[1]!.name).toBe('dsh-policy')
    expect(ports[1]!.posted).toEqual([{ type: 'taint.subscribe' }])
    await act(async () => { ports[1]!.emit({ type: 'taint.state', records: { s1: { sources: ['https://evil.example'], since: 1 } } }) })
    const clear = host.querySelector('button') as HTMLButtonElement
    expect(() => { clear.click() }).not.toThrow()
    expect(ports[1]!.posted.at(-1)).toMatchObject({ type: 'taint.clear', sessionId: 's1' })
  })

  it('watchers card resubscribes on a new port', async () => {
    await mount(createElement(WatchersCard, { locale: 'en' }))
    await act(async () => { ports[0]!.drop() })
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(ports).toHaveLength(2)
    expect(ports[1]!.posted).toEqual([{ type: 'watchers.subscribe' }])
  })

  it('a dead port does not throw out of a click handler before the reconnect lands', async () => {
    const host = await mount(createElement(WatchersCard, { locale: 'en' }))
    await act(async () => {
      ports[0]!.emit({ type: 'watchers.state', watchers: [{ id: 'w1', sessionId: 's1', url: 'https://a.example', condition: 'text "x"', prompt: 'p', expiresAt: Date.now() + 60_000, fires: 0, maxFires: 3 }] })
    })
    ports[0]!.dead = true
    const cancel = host.querySelector('button') as HTMLButtonElement
    // React reports a throwing handler as an uncaught window error, not to the caller.
    const errors: unknown[] = []
    const onError = (event: ErrorEvent): void => { errors.push(event.error); event.preventDefault() }
    window.addEventListener('error', onError)
    cancel.click()
    window.removeEventListener('error', onError)
    expect(errors).toEqual([])
  })

  it('learning client resubscribes and serves requests after a reconnect', async () => {
    const states: unknown[] = []
    const client = connectLearning('s1', (state) => { states.push(state) })
    expect(ports[0]!.posted[0]).toMatchObject({ type: 'learning.subscribe', sessionId: 's1' })
    ports[0]!.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ports).toHaveLength(2)
    expect(ports[1]!.posted[0]).toMatchObject({ type: 'learning.subscribe', sessionId: 's1' })
    const pending = client.request<{ ok: boolean }>('learning.steps.clear')
    const sent = ports[1]!.posted.at(-1)!
    expect(sent.type).toBe('learning.steps.clear')
    ports[1]!.emit({ type: 'learning.result', id: sent.id, ok: true, result: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })
    client.dispose()
  })

  it('stops reconnecting once disposed', async () => {
    const client = connectLearning(undefined, () => {})
    client.dispose()
    ports[0]!.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ports).toHaveLength(1)
  })
})
