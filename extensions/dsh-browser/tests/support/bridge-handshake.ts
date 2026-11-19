/**
 * Test-side bridge for FakeWebSocket suites: plays the server half of the v4
 * handshake (challenge → verify the client proof → hello.ok with a server
 * proof) so background tests exercise the real client authentication. After
 * the handshake the socket is switched to the sealed channel: `receive(frame)`
 * seals server frames, and `sent` records the client's frames unsealed.
 */

import { expect, vi } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeFrameChannel,
  bridgeEndpointOfUrl,
  computeBridgeProof,
  createBridgeNonce,
  type BridgeCaps,
  type BridgeEndpoint,
  type BridgeFrame,
} from '@natgurlain/dsh-browser-agent/src/protocol.ts'

/** Token the background suites store in settings. */
export const TEST_BRIDGE_TOKEN = 'test-bridge-token'

const DEFAULT_CAPS: BridgeCaps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

interface HandshakeSocket {
  readonly url: string
  readonly sent: unknown[]
  receive(frame: unknown): void
  dispatchEvent(event: Event): boolean
}

export interface HelloFrame {
  t: 'hello'
  v: number
  nonce: string
  mac: string
  endpoint: BridgeEndpoint
  caps: unknown
}

/**
 * Send the server challenge until the client answers it; returns the client's
 * hello. The client attaches its listener a few ticks after `open`; repeating
 * the same challenge until it answers is harmless (later copies are ignored).
 * @param socket - fake socket the client opened.
 * @param nonce - server nonce to challenge with.
 */
export async function challengeUntilHello(socket: HandshakeSocket, nonce: string): Promise<HelloFrame> {
  let hello: HelloFrame | undefined
  await vi.waitFor(() => {
    hello = socket.sent.find((frame): frame is HelloFrame => (frame as { t?: unknown }).t === 'hello')
    if (hello === undefined) socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce })
    expect(hello).toBeDefined()
  }, { interval: 5 })
  return hello!
}

/**
 * Answer the client's handshake on an open fake socket, then seal the
 * socket's traffic with the derived server channel.
 * @param socket - fake socket the client opened.
 * @param options.token - token the bridge holds (defaults to {@link TEST_BRIDGE_TOKEN}).
 * @param options.caps - capabilities the bridge acknowledges.
 * @param options.until - condition marking the end of the client's async verification.
 * @returns the server-side channel (for tests that craft raw sealed frames).
 */
export async function completeHandshake(
  socket: HandshakeSocket,
  options: { token?: string; caps?: BridgeCaps; until?: () => void } = {},
): Promise<BridgeFrameChannel> {
  const token = options.token ?? TEST_BRIDGE_TOKEN
  const serverNonce = createBridgeNonce()
  const hello = await challengeUntilHello(socket, serverNonce)
  expect(hello.endpoint).toEqual(bridgeEndpointOfUrl(socket.url))
  expect(hello.mac).toBe(await computeBridgeProof(token, 'client', serverNonce, hello.nonce, hello.endpoint, { client: hello.caps }))
  const channel = BridgeFrameChannel.derive(token, 'server', serverNonce, hello.nonce, hello.endpoint)
  sealSocket(socket, channel)
  socket.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({
      t: 'hello.ok',
      caps: options.caps ?? DEFAULT_CAPS,
      mac: await computeBridgeProof(token, 'server', hello.nonce, serverNonce, hello.endpoint, { client: hello.caps, server: options.caps ?? DEFAULT_CAPS }),
    }),
  }))
  if (options.until !== undefined) await vi.waitFor(options.until)
  return channel
}

/**
 * Route a fake socket's traffic through a server channel: frames handed to
 * `receive` arrive sealed, and sealed client frames land in `sent` opened.
 */
function sealSocket(socket: HandshakeSocket, channel: BridgeFrameChannel): void {
  const mutable = socket as unknown as { receive: (frame: unknown) => void; sent: unknown[] }
  mutable.receive = (frame: unknown) => {
    socket.dispatchEvent(new MessageEvent('message', { data: channel.seal(frame as BridgeFrame) }))
  }
  const push = mutable.sent.push.bind(mutable.sent)
  mutable.sent.push = (...items: unknown[]): number => push(...items.map((item) => {
    if ((item as { t?: unknown }).t !== 'sealed') return item
    const opened = channel.open(JSON.stringify(item))
    if (opened === undefined) throw new Error('client sent a frame that does not verify')
    return opened
  }))
}

/**
 * Condition for {@link completeHandshake}: the panel saw one more connected
 * status than it had when this condition was created.
 * @param postMessage - the panel port's postMessage mock.
 */
export function panelSawConnected(postMessage: { mock: { calls: unknown[][] } }): () => void {
  const connected = (): number => postMessage.mock.calls.filter(([message]) => (
    (message as { type?: unknown; state?: unknown } | undefined)?.type === 'status'
    && (message as { state?: unknown }).state === 'connected'
  )).length
  const before = connected()
  return () => { expect(connected()).toBeGreaterThan(before) }
}
