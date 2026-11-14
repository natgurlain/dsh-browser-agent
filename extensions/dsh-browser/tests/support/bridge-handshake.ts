/**
 * Test-side bridge for FakeWebSocket suites: plays the server half of the v2
 * handshake (challenge → verify the client proof → hello.ok with a server
 * proof) so background tests exercise the real client authentication.
 */

import { expect, vi } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  computeBridgeProof,
  createBridgeNonce,
  type BridgeCaps,
} from '@natgurlain/dsh-bridge-browser/src/protocol.ts'

/** Token the background suites store in settings. */
export const TEST_BRIDGE_TOKEN = 'test-bridge-token'

const DEFAULT_CAPS: BridgeCaps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

interface HandshakeSocket {
  readonly sent: unknown[]
  receive(frame: unknown): void
}

interface HelloFrame {
  t: 'hello'
  v: number
  nonce: string
  mac: string
}

/**
 * Answer the client's handshake on an open fake socket.
 * @param socket - fake socket the client opened.
 * @param options.token - token the bridge holds (defaults to {@link TEST_BRIDGE_TOKEN}).
 * @param options.caps - capabilities the bridge acknowledges.
 * @param options.until - condition marking the end of the client's async verification.
 */
export async function completeHandshake(
  socket: HandshakeSocket,
  options: { token?: string; caps?: BridgeCaps; until?: () => void } = {},
): Promise<void> {
  const token = options.token ?? TEST_BRIDGE_TOKEN
  const serverNonce = createBridgeNonce()
  let hello: HelloFrame | undefined
  await vi.waitFor(() => {
    hello = socket.sent.find((frame): frame is HelloFrame => (frame as { t?: unknown }).t === 'hello')
    // The client attaches its listener a few ticks after `open`; repeating the
    // same challenge until it answers is harmless (later copies are ignored).
    if (hello === undefined) socket.receive({ t: 'challenge', v: BRIDGE_PROTOCOL_VERSION, nonce: serverNonce })
    expect(hello).toBeDefined()
  }, { interval: 5 })
  expect(hello!.mac).toBe(await computeBridgeProof(token, 'client', serverNonce, hello!.nonce))
  socket.receive({
    t: 'hello.ok',
    caps: options.caps ?? DEFAULT_CAPS,
    mac: await computeBridgeProof(token, 'server', hello!.nonce, serverNonce),
  })
  if (options.until !== undefined) await vi.waitFor(options.until)
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
