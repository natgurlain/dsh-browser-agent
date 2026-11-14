import { describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeFrameChannel,
  bridgeDialUrl,
  bridgeEndpointMatches,
  bridgeEndpointOfUrl,
  bridgeProof,
  bridgeProofMessage,
  canonicalBridgeHost,
  hmacSha256,
  sha256,
  computeBridgeProof,
  constantTimeEqual,
  createBridgeNonce,
  helloProtocolVersion,
  isBridgeHex256,
  DEVTOOLS_CAPS_VERSION,
  DEVTOOLS_TOOL_NAMES,
  isDevToolsCaps,
  isServerFrame,
  parseBridgeFrame,
} from '../src/protocol.ts'

const NONCE = 'a'.repeat(64)
const MAC = 'b'.repeat(64)
const ENDPOINT = { host: '127.0.0.1', port: 3080 }
/** A well-formed v3 hello; `token` is gone from the wire. */
const hello = (caps: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: NONCE, mac: MAC, endpoint: ENDPOINT, caps, ...extra })

describe('bridge handshake primitives', () => {
  it('computes HMAC-SHA256 proofs identical to node crypto', async () => {
    const server = createBridgeNonce()
    const client = createBridgeNonce()
    expect(isBridgeHex256(server)).toBe(true)
    expect(server).not.toBe(client)
    const expected = createHmac('sha256', Buffer.from('a token', 'utf8'))
      .update(bridgeProofMessage('client', server, client, ENDPOINT)).digest('hex')
    expect(await computeBridgeProof('a token', 'client', server, client, ENDPOINT)).toBe(expected)
  })

  it('implements SHA-256 and HMAC-SHA256 byte-identically to node crypto', () => {
    const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = new Uint8Array(length).map((_, index) => (index * 31 + length) & 0xff)
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'))
      for (const keyLength of [0, 16, 64, 65, 200]) {
        const key = new Uint8Array(keyLength).map((_, index) => (index * 7) & 0xff)
        expect(hex(hmacSha256(key, data))).toBe(createHmac('sha256', key).update(data).digest('hex'))
      }
    }
  })

  it('binds the role and the dialed endpoint into every proof', async () => {
    const [a, b] = [createBridgeNonce(), createBridgeNonce()]
    expect(await computeBridgeProof('t', 'client', a, b, ENDPOINT)).not.toBe(await computeBridgeProof('t', 'server', a, b, ENDPOINT))
    expect(bridgeProof('t', 'client', a, b, ENDPOINT)).not.toBe(bridgeProof('t', 'client', a, b, { ...ENDPOINT, port: 3081 }))
    expect(bridgeProof('t', 'client', a, b, ENDPOINT)).not.toBe(bridgeProof('t', 'client', a, b, { ...ENDPOINT, host: '::1' }))
    expect(bridgeProofMessage('client', a, b, ENDPOINT))
      .toBe(`dsh-bridge/v${String(BRIDGE_PROTOCOL_VERSION)}|client|${a}|${b}|127.0.0.1|3080`)
  })

  it('refuses to compute a proof with an empty token', async () => {
    await expect(computeBridgeProof('', 'client', NONCE, NONCE, ENDPOINT)).rejects.toThrow(/empty/)
  })

  it('derives the endpoint a client dials and matches it against the accepted socket', () => {
    expect(bridgeDialUrl('ws://localhost:3080/ext/bridge')).toBe('ws://127.0.0.1:3080/ext/bridge')
    expect(bridgeDialUrl('ws://[::1]:3080/ext/bridge')).toBe('ws://[::1]:3080/ext/bridge')
    expect(bridgeEndpointOfUrl('ws://127.0.0.1:43189/ext/bridge')).toEqual({ host: '127.0.0.1', port: 43189 })
    expect(bridgeEndpointOfUrl('ws://[::1]:3080/ext/bridge')).toEqual({ host: '::1', port: 3080 })
    expect(bridgeEndpointOfUrl('ws://Box.LAN/ext/bridge')).toEqual({ host: 'box.lan', port: 80 })
    expect(bridgeEndpointOfUrl('http://127.0.0.1:1/')).toBeUndefined()
    expect(canonicalBridgeHost('::ffff:127.0.0.1')).toBe('127.0.0.1')
    // Exact address and port, IPv4-mapped server addresses included.
    expect(bridgeEndpointMatches(ENDPOINT, { host: '::ffff:127.0.0.1', port: 3080 })).toBe(true)
    expect(bridgeEndpointMatches(ENDPOINT, { host: '127.0.0.1', port: 3081 })).toBe(false)
    // A relay on [::1] cannot stand in for a bridge on 127.0.0.1 (or vice versa).
    expect(bridgeEndpointMatches({ host: '::1', port: 3080 }, { host: '127.0.0.1', port: 3080 })).toBe(false)
    expect(bridgeEndpointMatches(ENDPOINT, { host: '::1', port: 3080 })).toBe(false)
    // A hand-configured DNS name is accepted only on a non-loopback socket.
    expect(bridgeEndpointMatches({ host: 'box.lan', port: 3080 }, { host: '192.168.1.5', port: 3080 })).toBe(true)
    expect(bridgeEndpointMatches({ host: 'box.lan', port: 3080 }, { host: '127.0.0.1', port: 3080 })).toBe(false)
  })

  it('seals frames per direction and rejects tampering, replay, reordering, and reflection', () => {
    const [ns, nc] = [createBridgeNonce(), createBridgeNonce()]
    const client = BridgeFrameChannel.derive('tok', 'client', ns, nc, ENDPOINT)
    const server = BridgeFrameChannel.derive('tok', 'server', ns, nc, ENDPOINT)
    const first = client.seal({ t: 'pong' })
    const second = client.seal({ t: 'rpc', id: '1', method: 'session.list', payload: {} })
    // Reordered: the second frame cannot be accepted first.
    expect(server.open(second)).toBeUndefined()
    expect(server.open(first)).toEqual({ t: 'pong' })
    // Replayed.
    expect(server.open(first)).toBeUndefined()
    // Tampered body.
    const tampered = JSON.stringify({ ...JSON.parse(second) as object, body: JSON.stringify({ t: 'rpc', id: '1', method: 'session.prompt', payload: {} }) })
    expect(server.open(tampered)).toBeUndefined()
    expect(server.open(second)).toEqual({ t: 'rpc', id: '1', method: 'session.list', payload: {} })
    // Unsealed frames are never accepted.
    expect(server.open(JSON.stringify({ t: 'pong' }))).toBeUndefined()
    // A server frame reflected back to the server fails (separate direction keys).
    const fromServer = server.seal({ t: 'ping' })
    const otherServer = BridgeFrameChannel.derive('tok', 'server', ns, nc, ENDPOINT)
    expect(otherServer.open(fromServer)).toBeUndefined()
    expect(client.open(fromServer)).toEqual({ t: 'ping' })
    // A different endpoint or token derives different keys.
    const relayed = BridgeFrameChannel.derive('tok', 'server', ns, nc, { ...ENDPOINT, port: 1 })
    expect(relayed.open(BridgeFrameChannel.derive('tok', 'client', ns, nc, ENDPOINT).seal({ t: 'pong' }))).toBeUndefined()
  })

  it('compares proofs in constant time and rejects empty or unequal lengths', () => {
    expect(constantTimeEqual(MAC, MAC)).toBe(true)
    expect(constantTimeEqual(MAC, `${MAC.slice(0, 63)}c`)).toBe(false)
    expect(constantTimeEqual(MAC, MAC.slice(1))).toBe(false)
    expect(constantTimeEqual('', '')).toBe(false)
  })

  it('reads the claimed handshake version of a raw hello', () => {
    expect(helloProtocolVersion(hello({}))).toBe(BRIDGE_PROTOCOL_VERSION)
    // The v1 shape carried the raw token and no version.
    expect(helloProtocolVersion(JSON.stringify({ t: 'hello', token: 'x', caps: {} }))).toBe(1)
    expect(helloProtocolVersion(JSON.stringify({ t: 'rpc' }))).toBeUndefined()
    expect(helloProtocolVersion('nope')).toBeUndefined()
    expect(helloProtocolVersion('[]')).toBeUndefined()
  })
})

describe('parseBridgeFrame', () => {
  it('parses a valid hello frame', () => {
    const frame = parseBridgeFrame(hello({ textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }))
    expect(frame).toEqual({
      t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: NONCE, mac: MAC, endpoint: ENDPOINT,
      caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 },
    })
  })

  it('rejects a hello that carries no proof, a v1 token, or a malformed nonce', () => {
    const caps = { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc123', caps }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { v: 1 }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { nonce: 'short' }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { mac: MAC.toUpperCase() }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { mac: undefined }))).toBeUndefined()
    // v3 requires the dialed endpoint, in canonical form.
    expect(parseBridgeFrame(hello(caps, { endpoint: undefined }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { endpoint: { host: 'LOCALHOST', port: 3080 } }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { endpoint: { host: '127.0.0.1', port: 0 } }))).toBeUndefined()
    expect(parseBridgeFrame(hello(caps, { endpoint: { host: 'a|b', port: 1 } }))).toBeUndefined()
  })

  it('parses the server challenge and requires a proof on hello.ok', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'challenge', v: 2, nonce: NONCE }))).toEqual({ t: 'challenge', v: 2, nonce: NONCE })
    // A different version still parses so the client can report the mismatch.
    expect(parseBridgeFrame(JSON.stringify({ t: 'challenge', v: 3, nonce: NONCE }))).toEqual({ t: 'challenge', v: 3, nonce: NONCE })
    expect(parseBridgeFrame(JSON.stringify({ t: 'challenge', v: 2, nonce: 'x' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'challenge', nonce: NONCE }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 } })))
      .toBeUndefined()
  })

  it('accepts the optional developer-tools capability', () => {
    const withDevTools = { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60, devTools: { version: DEVTOOLS_CAPS_VERSION } }
    expect(parseBridgeFrame(hello(withDevTools)))
      .toEqual({ t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: NONCE, mac: MAC, endpoint: ENDPOINT, caps: withDevTools })
    // An older extension omits the field and still authenticates.
    const legacy = { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }
    expect(parseBridgeFrame(hello(legacy))).toBeDefined()
    // An unknown version is not usable, so the frame is rejected outright.
    expect(parseBridgeFrame(hello({ ...legacy, devTools: { version: 99 } }))).toBeUndefined()
    expect(isDevToolsCaps({ version: DEVTOOLS_CAPS_VERSION })).toBe(true)
    expect(isDevToolsCaps({})).toBe(false)
    expect(isDevToolsCaps(undefined)).toBe(false)
  })

  it('exposes the nine documented developer-tools names', () => {
    expect(DEVTOOLS_TOOL_NAMES).toHaveLength(9)
    expect(new Set(DEVTOOLS_TOOL_NAMES).size).toBe(9)
    expect([...DEVTOOLS_TOOL_NAMES]).toContain('browser_console_eval')
  })

  it('rejects hello with wrong caps shape', () => {
    expect(parseBridgeFrame(hello({ textOnly: false, snapshotMaxChars: 500, maxInteractiveItems: 10 }))).toBeUndefined()
    expect(parseBridgeFrame(hello({ textOnly: true }))).toBeUndefined()
    expect(parseBridgeFrame(hello({ textOnly: true, snapshotMaxChars: 0, maxInteractiveItems: 10 }))).toBeUndefined()
    expect(parseBridgeFrame(hello({ textOnly: true, snapshotMaxChars: 499, maxInteractiveItems: 10 }))).toBeUndefined()
    expect(parseBridgeFrame(hello(undefined))).toBeUndefined()
  })

  it('parses rpc and tool frames', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc', id: '1', method: 'session.list', payload: {} })))
      .toEqual({ t: 'rpc', id: '1', method: 'session.list', payload: {} })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '2', ok: true, result: { text: 'ok' } })))
      .toEqual({ t: 'tool.result', id: '2', ok: true, result: { text: 'ok' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '3', ok: false, error: { code: 'timeout', message: 'm' } })))
      .toEqual({ t: 'tool.result', id: '3', ok: false, error: { code: 'timeout', message: 'm' } })
  })

  it('parses server-side frames the extension receives', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }, mac: MAC })))
      .toEqual({ t: 'hello.ok', caps: { textOnly: true, snapshotMaxChars: 12000, maxInteractiveItems: 60 }, mac: MAC })
    expect(parseBridgeFrame(JSON.stringify({ t: 'event', frame: { rpcId: 'r', method: 'turn/start', payload: {} } })))
      .toEqual({ t: 'event', frame: { rpcId: 'r', method: 'turn/start', payload: {} } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 }, expiresAt: 123, sessionId: 'session-1' })))
      .toEqual({ t: 'tool.call', id: '4', name: 'browser_click', args: { index: 1 }, expiresAt: 123, sessionId: 'session-1' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.cancel', id: '4' })))
      .toEqual({ t: 'tool.cancel', id: '4' })
  })

  it('parses rpc.result success and error forms', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: true, result: { x: 1 } })))
      .toEqual({ t: 'rpc.result', id: '1', ok: true, result: { x: 1 } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: false, error: { code: 'http', message: 'boom' } })))
      .toEqual({ t: 'rpc.result', id: '1', ok: false, error: { code: 'http', message: 'boom' } })
    // ok:true without result, and ok:false without error, are malformed.
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: '1', ok: false }))).toBeUndefined()
  })

  it('parses interaction responses and rejects malformed result unions', () => {
    expect(parseBridgeFrame(JSON.stringify({
      t: 'respond', id: 'response-1', rpcId: 'question-1',
      result: { ok: true, value: { answer: { answers: [] } } },
    }))).toEqual({
      t: 'respond', id: 'response-1', rpcId: 'question-1',
      result: { ok: true, value: { answer: { answers: [] } } },
    })
    expect(parseBridgeFrame(JSON.stringify({
      t: 'respond', id: 'response-2', rpcId: 'question-2',
      result: { ok: false, error: { code: 'cancelled', message: 'closed', details: {} } },
    }))).toEqual({
      t: 'respond', id: 'response-2', rpcId: 'question-2',
      result: { ok: false, error: { code: 'cancelled', message: 'closed', details: {} } },
    })
    expect(parseBridgeFrame(JSON.stringify({
      t: 'respond', id: 'x', rpcId: 'q',
      result: { ok: false, error: { code: 'cancelled', message: 'missing details' } },
    }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'x', rpcId: 'q', result: { ok: false } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'x', rpcId: 'q', result: { ok: true, error: {} } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond', id: 'x', result: { ok: true } }))).toBeUndefined()
  })

  it('parses interaction response receipts', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'response-1', ok: true, result: { accepted: true } })))
      .toEqual({ t: 'respond.result', id: 'response-1', ok: true, result: { accepted: true } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'response-2', ok: false, error: { code: 'http', message: 'failed' } })))
      .toEqual({ t: 'respond.result', id: 'response-2', ok: false, error: { code: 'http', message: 'failed' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'x', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'respond.result', id: 'x', ok: false, error: {} }))).toBeUndefined()
  })

  it('parses ping and error frames', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'error', code: 'stream-failed', message: 'x' })))
      .toEqual({ t: 'error', code: 'stream-failed', message: 'x' })
    expect(parseBridgeFrame(JSON.stringify({ t: 'error', code: 1, message: 'x' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' })
  })

  it('rejects event frames with a non-object payload', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'event', frame: null }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'event' }))).toBeUndefined()
  })

  it('classifies frames by sender side', () => {
    const server = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 123 }))!
    const client = parseBridgeFrame(hello({ textOnly: true, snapshotMaxChars: 500, maxInteractiveItems: 10 }))!
    expect(isServerFrame(server)).toBe(true)
    expect(isServerFrame(client)).toBe(false)
    for (const t of ['challenge', 'hello.ok', 'rpc.result', 'respond.result', 'event', 'tool.call', 'tool.cancel', 'ping', 'error'] as const) {
      const frame = parseBridgeFrame(JSON.stringify(serverShape(t)))!
      expect(isServerFrame(frame)).toBe(true)
    }
  })

  it('rejects malformed payloads', () => {
    expect(parseBridgeFrame('not json')).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify(null))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify([1, 2]))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({}))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'nope' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc', id: 5, method: 'x' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '1', ok: true }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: 5, ok: true, result: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'rpc.result', id: 5, ok: true, result: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'hello.ok', caps: { textOnly: true } }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: [] }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {} }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {}, expiresAt: Number.POSITIVE_INFINITY }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: {}, expiresAt: 123, sessionId: '' }))).toBeUndefined()
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.cancel', id: 1 }))).toBeUndefined()
  })
})

/** Minimal valid shape per server-side frame type (for classification tests). */
function serverShape(t: 'challenge' | 'hello.ok' | 'rpc.result' | 'respond.result' | 'event' | 'tool.call' | 'tool.cancel' | 'ping' | 'error'): Record<string, unknown> {
  switch (t) {
    case 'challenge': return { t, v: BRIDGE_PROTOCOL_VERSION, nonce: NONCE }
    case 'hello.ok': return { t, caps: { textOnly: true, snapshotMaxChars: 500, maxInteractiveItems: 10 }, mac: MAC }
    case 'rpc.result': return { t, id: '1', ok: true, result: {} }
    case 'respond.result': return { t, id: '1', ok: true, result: { accepted: true } }
    case 'event': return { t, frame: { rpcId: 'r', method: 'x', payload: {} } }
    case 'tool.call': return { t, id: '1', name: 'x', args: {}, expiresAt: 123 }
    case 'tool.cancel': return { t, id: '1' }
    case 'ping': return { t }
    case 'error': return { t, code: 'x', message: 'm' }
  }
}
