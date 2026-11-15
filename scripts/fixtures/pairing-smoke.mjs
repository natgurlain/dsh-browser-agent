/**
 * Runtime smoke for one-step pairing (roadmap 3.10), run by smoke-runtime.mjs
 * against a real DSH host.
 *
 * A stand-in for a store-installed extension (a Chrome extension ID the
 * bridge was never told about, and no token) asks to pair and displays its
 * code. The request is answered the two ways a user can answer it: dsh's
 * authenticated `/api` route (what the prompt in the DSH app calls) and the
 * `/browser-pair` command. The smoke also checks what must not work: the
 * route without dsh's authentication, a request nobody approved, a denied
 * one, a wrong code, and an approval used twice.
 */

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A store build: a well-formed Chrome extension ID that is on no allowlist. */
const STORE_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const STORE_ORIGIN = `chrome-extension://${STORE_ID}`
const CODE_PATTERN = /\b([A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3})\b/u

/**
 * @param {object} deps
 * @param {Function} deps.WebSocket - the `ws` client class.
 * @param {object} deps.protocol - the bridge's built protocol module.
 * @param {object} deps.pairing - the bridge's built pairing module.
 * @param {string} deps.wsUrl - bridge WebSocket URL.
 * @param {string} deps.base - the host's HTTP base URL.
 * @param {string} deps.token - the bridge token the host was configured with.
 * @param {string} deps.home - DSH_HOME.
 * @param {string} deps.sessionId - a session the panel stand-in owns (for the command).
 * @param {Function} deps.rpc - the panel stand-in's fenced rpc.
 * @param {(body: object) => Promise<{ status: number, body: any }>} deps.ownerPairing - the control route, called as the authenticated owner.
 * @param {Function} deps.waitFor - polling helper.
 */
export async function smokePairing({ WebSocket, protocol, pairing, wsUrl, base, token, home, sessionId, rpc, ownerPairing, waitFor }) {
  const { BRIDGE_CLOSE_CODES, BRIDGE_PROTOCOL_VERSION, PAIRING_PROTOCOL_VERSION, bridgeEndpointOfUrl, createBridgeNonce } = protocol
  const endpoint = bridgeEndpointOfUrl(wsUrl)

  /**
   * Run the extension half of one exchange up to the displayed code.
   * @returns `{ code, outcome }`: `code` is undefined when the bridge refused first;
   *   `outcome` resolves to `{ token }` or `{ closed }` (the close code).
   */
  const ask = async (origin, name = 'Brave') => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000, ...origin === undefined ? {} : { origin } })
    const frames = []
    ws.on('message', data => { frames.push(JSON.parse(data.toString())) })
    const closed = once(ws, 'close')
    await once(ws, 'open')
    const refused = () => ({ code: undefined, ws, outcome: closed.then(([code]) => ({ closed: code, frames })) })
    const frame = async (type) => {
      await waitFor(() => frames.some(value => value.t === type) || ws.readyState === WebSocket.CLOSED, `${type} or close`, 10_000)
      return frames.find(value => value.t === type)
    }
    const challenge = await frame('challenge')
    if (challenge === undefined) return refused()
    const context = { serverNonce: challenge.nonce, clientNonce: createBridgeNonce(), endpoint, origin: origin ?? '', name }
    const own = pairing.createPairingShare()
    const opening = pairing.createPairingOpening()
    ws.send(JSON.stringify({
      t: 'pair.request', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint, origin: context.origin, name,
      commit: pairing.pairingCommitment(own.share, opening),
    }))
    const share = await frame('pair.share')
    if (share === undefined) return refused()
    const session = pairing.derivePairingSession(context, own.secret, own.share, share.share, 'client')
    ws.send(JSON.stringify({ t: 'pair.reveal', share: own.share, opening }))
    return {
      code: pairing.formatPairingCode(session.code),
      ws,
      outcome: closed.then(([code]) => {
        const ok = frames.find(value => value.t === 'pair.ok')
        return ok === undefined ? { closed: code, frames } : { token: pairing.openPairingToken(session, ok.box, ok.mac), frames }
      }),
    }
  }
  const pairedFile = async () => {
    try { return JSON.parse(await readFile(join(home, 'browser-paired-extensions.json'), 'utf8')) } catch { return undefined }
  }
  const waiting = async (count) => waitFor(async () => {
    const listed = await ownerPairing({ action: 'list' })
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    return listed.body.requests.length === count ? listed.body.requests : undefined
  }, `${count} waiting pairing request(s)`, 10_000)

  // The control route is dsh's: without its authentication nobody sees or answers a request.
  for (const init of [
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list' }) },
    { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ action: 'approve', id: 'p1' }) },
  ]) {
    const response = await fetch(`${base}/api/bridge-browser.pairing`, { ...init, signal: AbortSignal.timeout(10_000) })
    assert.ok(response.status === 401 || response.status === 403, `an unauthenticated pairing request must be refused, got ${response.status}`)
  }
  // The public discovery answer says nothing about pairing.
  assert.doesNotMatch(await (await fetch(`${base}/ext/bridge-config`)).text(), /pair/iu)
  assert.deepEqual((await ownerPairing({ action: 'list' })).body, { ok: true, requests: [] })

  // A web page can never ask; an unknown extension that sends `hello` is refused, token or not.
  assert.equal((await (await ask('https://evil.example')).outcome).closed, BRIDGE_CLOSE_CODES.originRejected)

  // The store build asks. The host shows the same code, its origin and browser name; nothing is released yet.
  const first = await ask(STORE_ORIGIN, 'Brave')
  assert.match(first.code, CODE_PATTERN)
  const [prompt] = await waiting(1)
  assert.equal(prompt.code, first.code, 'the host must show the code the extension shows')
  assert.equal(prompt.origin, STORE_ORIGIN)
  assert.equal(prompt.name, 'Brave')
  assert.equal(await pairedFile(), undefined, 'nothing is allowed before the user approves')
  // The user denies it in the app: no token, no allowlist entry.
  assert.equal((await ownerPairing({ action: 'deny', id: prompt.id })).status, 200)
  const denied = await first.outcome
  assert.equal(denied.closed, BRIDGE_CLOSE_CODES.pairingDenied)
  assert.equal(denied.frames.some(value => value.t === 'pair.ok'), false)
  assert.equal(await pairedFile(), undefined)

  // Asked again, approved in the app with one call: the token arrives, sealed.
  const second = await ask(STORE_ORIGIN, 'Brave')
  const [again] = await waiting(1)
  assert.equal(again.code, second.code)
  assert.notEqual(second.code, first.code)
  const approved = await ownerPairing({ action: 'approve', id: again.id })
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(approved.body.paired.origin, STORE_ORIGIN)
  const paired = await second.outcome
  assert.equal(paired.token, token, `pairing must deliver the bridge token: ${JSON.stringify(paired.frames).slice(0, 400)}`)
  assert.equal(JSON.stringify(paired.frames).includes(token), false, 'the token must not cross the wire in the clear')
  // An approval works once.
  assert.equal((await ownerPairing({ action: 'approve', id: again.id })).status, 409)
  // Its ID is remembered across restarts, in a private file.
  const record = await waitFor(pairedFile, 'the paired-extension record', 10_000)
  assert.deepEqual(record.chromeExtensionIds, [STORE_ID])

  // The command path: list, a wrong code, then the code the browser shows.
  const commandNames = (await rpc('commands.list', { sessionId })).commands.map(command => command.name)
  assert.ok(commandNames.includes('browser-pair'), `the command directory must expose /browser-pair: ${JSON.stringify(commandNames)}`)
  const third = await ask(undefined, 'Firefox')
  await waiting(1)
  const listed = await rpc('commands.execute', { sessionId, line: '/browser-pair' })
  assert.equal(listed.result.kind, 'success', JSON.stringify(listed))
  assert.ok(listed.result.text.includes(`Firefox wants to connect, code ${third.code}`), listed.result.text)
  const wrongCode = third.code.startsWith('A') ? `B${third.code.slice(1)}` : `A${third.code.slice(1)}`
  const wrong = await rpc('commands.execute', { sessionId, line: `/browser-pair approve ${wrongCode}` })
  assert.equal(wrong.result.kind, 'error', JSON.stringify(wrong))
  // The code of the request approved earlier approves nothing now.
  assert.equal((await rpc('commands.execute', { sessionId, line: `/browser-pair approve ${second.code}` })).result.kind, 'error')
  await waiting(1)
  const byCode = await rpc('commands.execute', { sessionId, line: `/browser-pair approve ${third.code.toLowerCase()}` })
  assert.equal(byCode.result.kind, 'success', JSON.stringify(byCode))
  assert.equal((await third.outcome).token, token)
  await waiting(0)

  // A request whose browser goes away leaves the prompt.
  const abandoned = await ask(STORE_ORIGIN)
  await waiting(1)
  abandoned.ws.terminate()
  await waiting(0)

  // The paired build is now let in to the ordinary handshake: a hello that
  // cannot prove the token fails on the proof (4002), no longer on the Origin
  // (4004). (A full second connection is left to the unit specs: on this
  // host it would take over the event stream the rest of the smoke reads.)
  const admitted = new WebSocket(wsUrl, { handshakeTimeout: 10_000, origin: STORE_ORIGIN })
  const seen = []
  admitted.on('message', data => { seen.push(JSON.parse(data.toString())) })
  const closed = once(admitted, 'close')
  await once(admitted, 'open')
  await waitFor(() => seen.some(value => value.t === 'challenge'), 'bridge challenge for the paired extension', 10_000)
  admitted.send(JSON.stringify({
    t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce(), mac: createBridgeNonce(), endpoint,
    caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
  }))
  assert.equal((await closed)[0], BRIDGE_CLOSE_CODES.authFailed, 'a paired extension still has to prove the token')
}
