/**
 * Handshake relay: a local process without the token binds a probed port,
 * forwards the handshake to the real bridge, and tries to ride the
 * authenticated socket. Protocol v3 binds the dialed endpoint into both
 * proofs and seals every later frame, so neither step works.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { BridgeServer } from '../src/server.ts'
import {
  BRIDGE_CLOSE_CODES,
  BRIDGE_PROTOCOL_VERSION,
  BridgeFrameChannel,
  bridgeEndpointOfUrl,
  bridgeProof,
  constantTimeEqual,
  createBridgeNonce,
  parseBridgeFrame,
  type BridgeEndpoint,
} from '../src/protocol.ts'
import type { BrowserHostApi } from '../src/host-api.ts'

const TOKEN = '6f1d0c7a9b3e48f2a5c4d7e1b8f09a3c'
const CAPS = { textOnly: true as const, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function realBridge(
  forwardedPorts: number[] = [],
  localEndpointOverride?: { host: string; port: number },
): Promise<{ bridge: BridgeServer; port: number; calls: string[] }> {
  const calls: string[] = []
  const api: BrowserHostApi = {
    call: vi.fn(async (call) => {
      calls.push(call.method)
      return { ok: true as const, value: { accepted: true } }
    }),
    async *events(signal: AbortSignal) { await new Promise((resolve) => { signal.addEventListener('abort', resolve) }) },
    respond: async () => ({ accepted: false }),
  }
  const bridge = new BridgeServer({
    token: TOKEN, api, toolTimeoutMs: 1_000, caps: CAPS, injectBrowserSnapshot() {}, async purgeSession() {}, forwardedPorts,
    ...(localEndpointOverride === undefined ? {} : { localEndpointOverride }),
  })
  const http: Server = createServer()
  http.on('upgrade', (req, socket, head) => { bridge.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    await bridge.close()
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  return { bridge, port: (http.address() as AddressInfo).port, calls }
}

/** Honest v3 client: binds the URL it dials and verifies the server proof. */
function honestClient(url: string): { ws: WebSocket; outcome: Promise<{ verified: boolean; code?: number }> } {
  const ws = new WebSocket(url)
  const endpoint = bridgeEndpointOfUrl(url) as BridgeEndpoint
  const outcome = new Promise<{ verified: boolean; code?: number }>((resolve) => {
    let serverNonce = ''
    let clientNonce = ''
    ws.on('message', (data: Buffer) => {
      const frame = parseBridgeFrame(data.toString())
      if (frame?.t === 'challenge') {
        serverNonce = frame.nonce
        clientNonce = createBridgeNonce()
        ws.send(JSON.stringify({
          t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: clientNonce, endpoint, caps: CAPS,
          mac: bridgeProof(TOKEN, 'client', serverNonce, clientNonce, endpoint),
        }))
      } else if (frame?.t === 'hello.ok') {
        resolve({ verified: constantTimeEqual(bridgeProof(TOKEN, 'server', clientNonce, serverNonce, endpoint), frame.mac) })
      }
    })
    ws.on('close', (code) => { resolve({ verified: false, code }) })
    ws.on('error', () => { resolve({ verified: false }) })
  })
  cleanups.push(() => { ws.terminate() })
  return { ws, outcome }
}

describe('handshake relay', () => {
  it('refuses a handshake relayed through another port, so the relay never gets an authenticated socket', async () => {
    const { bridge, port: realPort, calls } = await realBridge()
    const evil = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => { evil.on('listening', resolve) })
    cleanups.push(() => new Promise<void>((resolve) => { evil.close(() => { resolve() }) }))
    const evilPort = (evil.address() as AddressInfo).port
    let upstream: WebSocket | undefined
    let upstreamClose: number | undefined
    evil.on('connection', (victim: WebSocket) => {
      upstream = new WebSocket(`ws://127.0.0.1:${String(realPort)}/ext/bridge`)
      upstream.on('close', (code) => { upstreamClose = code; victim.close() })
      upstream.on('message', (data: Buffer) => { victim.send(data.toString()) })
      victim.on('message', (data: Buffer) => { upstream?.send(data.toString()) })
      cleanups.push(() => { upstream?.terminate() })
    })

    const victim = honestClient(`ws://127.0.0.1:${String(evilPort)}/ext/bridge`)
    const outcome = await victim.outcome
    expect(outcome.verified).toBe(false)
    expect(bridge.hasConnection()).toBe(false)
    await vi.waitFor(() => { expect(upstreamClose).toBe(BRIDGE_CLOSE_CODES.authFailed) })
    expect(calls).toEqual([])
  })

  it('accepts a forward only on a loopback port the operator configured', async () => {
    const forward = 45_999
    const { bridge, port } = await realBridge([forward])
    for (const [endpoint, accepted] of [
      [{ host: '127.0.0.1', port: forward }, true],
      [{ host: '127.0.0.1', port: forward + 1 }, false],
      [{ host: 'box.lan', port: forward }, false],
    ] as const) {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`)
      cleanups.push(() => { ws.terminate() })
      const outcome = new Promise<string>((resolve) => {
        ws.on('close', (code) => { resolve(`closed ${String(code)}`) })
        ws.on('message', (data: Buffer) => {
          const frame = parseBridgeFrame(data.toString())
          if (frame?.t === 'hello.ok') resolve('accepted')
          if (frame?.t !== 'challenge') return
          const nonce = createBridgeNonce()
          ws.send(JSON.stringify({
            t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, endpoint, caps: CAPS,
            mac: bridgeProof(TOKEN, 'client', frame.nonce, nonce, endpoint),
          }))
        })
      })
      expect(await outcome, JSON.stringify(endpoint)).toBe(accepted ? 'accepted' : `closed ${String(BRIDGE_CLOSE_CODES.authFailed)}`)
      ws.terminate()
    }
    expect(bridge).toBeDefined()
  })

  it('accepts a configured forward inside a container, where the socket address is not loopback', async () => {
    const forward = 3080
    const { port } = await realBridge([forward], { host: '172.17.0.2', port: 3080 })
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`)
    cleanups.push(() => { ws.terminate() })
    const accepted = new Promise<boolean>((resolve) => {
      ws.on('close', () => { resolve(false) })
      ws.on('message', (data: Buffer) => {
        const frame = parseBridgeFrame(data.toString())
        if (frame?.t === 'hello.ok') resolve(true)
        if (frame?.t !== 'challenge') return
        const nonce = createBridgeNonce()
        const endpoint = { host: '127.0.0.1', port: forward }
        ws.send(JSON.stringify({
          t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, endpoint, caps: CAPS,
          mac: bridgeProof(TOKEN, 'client', frame.nonce, nonce, endpoint),
        }))
      })
    })
    expect(await accepted).toBe(true)
  })

  it('refuses a client that names a different endpoint than the socket it reached', async () => {
    const { bridge, port } = await realBridge()
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ext/bridge`)
    cleanups.push(() => { ws.terminate() })
    const closed = new Promise<number>((resolve) => { ws.on('close', (code) => { resolve(code) }) })
    ws.on('message', (data: Buffer) => {
      const frame = parseBridgeFrame(data.toString())
      if (frame?.t !== 'challenge') return
      const nonce = createBridgeNonce()
      // A correct proof, but over the endpoint the relay would have answered on.
      const endpoint = { host: '127.0.0.1', port: port + 1 }
      ws.send(JSON.stringify({
        t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce, endpoint, caps: CAPS,
        mac: bridgeProof(TOKEN, 'client', frame.nonce, nonce, endpoint),
      }))
    })
    expect(await closed).toBe(BRIDGE_CLOSE_CODES.authFailed)
    expect(bridge.hasConnection()).toBe(false)
  })

  it('closes an authenticated connection on an unsealed, replayed, or forged frame', async () => {
    for (const attack of ['unsealed', 'replayed', 'forged'] as const) {
      const { bridge, port, calls } = await realBridge()
      const url = `ws://127.0.0.1:${String(port)}/ext/bridge`
      const endpoint = bridgeEndpointOfUrl(url)!
      const ws = new WebSocket(url)
      cleanups.push(() => { ws.terminate() })
      const closed = new Promise<number>((resolve) => { ws.on('close', (code) => { resolve(code) }) })
      let serverNonce = ''
      const clientNonce = createBridgeNonce()
      ws.on('message', (data: Buffer) => {
        const frame = parseBridgeFrame(data.toString())
        if (frame?.t === 'challenge') {
          serverNonce = frame.nonce
          ws.send(JSON.stringify({
            t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: clientNonce, endpoint, caps: CAPS,
            mac: bridgeProof(TOKEN, 'client', serverNonce, clientNonce, endpoint),
          }))
        } else if (frame?.t === 'hello.ok') {
          const channel = BridgeFrameChannel.derive(TOKEN, 'client', serverNonce, clientNonce, endpoint)
          const first = channel.seal({ t: 'rpc', id: 'ok', method: 'session.list', payload: {} })
          ws.send(first)
          if (attack === 'unsealed') ws.send(JSON.stringify({ t: 'rpc', id: 'x', method: 'session.prompt', payload: {} }))
          if (attack === 'replayed') ws.send(first)
          if (attack === 'forged') {
            const sealed = JSON.parse(channel.seal({ t: 'rpc', id: 'x', method: 'session.list', payload: {} })) as Record<string, unknown>
            ws.send(JSON.stringify({ ...sealed, body: JSON.stringify({ t: 'rpc', id: 'x', method: 'session.prompt', payload: {} }) }))
          }
        }
      })
      expect(await closed).toBe(BRIDGE_CLOSE_CODES.authFailed)
      await vi.waitFor(() => { expect(bridge.hasConnection()).toBe(false) })
      expect(calls.filter((method) => method === 'session.prompt')).toEqual([])
    }
  })
})
