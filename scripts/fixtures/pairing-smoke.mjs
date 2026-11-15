/**
 * Runtime smoke for one-step pairing (roadmap 3.10), run by smoke-runtime.mjs
 * against a real DSH host.
 *
 * A stand-in for a store-installed extension (a Chrome extension ID the
 * bridge was never told about, and no token) asks to pair with a code of its
 * own. The code is entered the two ways a user can enter it: dsh's
 * authenticated `/api` route (what the card in the DSH app calls) and the
 * `/browser-pair` command of an owner client. The smoke also checks what must
 * not work: the route without dsh's authentication, a requester that does not
 * hold the entered code (a forged Origin included), a used code, the command
 * through the browser bridge itself, and pairing while paused.
 */

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A store build: a well-formed Chrome extension ID that is on no allowlist. */
const STORE_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const STORE_ORIGIN = `chrome-extension://${STORE_ID}`
const FIREFOX_ORIGIN = 'moz-extension://0f8fad5b-d9cb-469f-a165-70867728950e'

/**
 * @param {object} deps
 * @param {Function} deps.WebSocket - the `ws` client class.
 * @param {object} deps.protocol - the bridge's built protocol module.
 * @param {object} deps.pairing - the bridge's built pairing module.
 * @param {string} deps.wsUrl - bridge WebSocket URL.
 * @param {string} deps.base - the host's HTTP base URL.
 * @param {string} deps.token - the bridge token the host was configured with.
 * @param {string} deps.home - DSH_HOME.
 * @param {string} deps.sessionId - a session the panel stand-in owns.
 * @param {Function} deps.rpc - the panel stand-in's fenced rpc (through the browser bridge).
 * @param {(body: object) => Promise<{ status: number, body: any }>} deps.ownerPairing - the control route, called as the authenticated owner.
 * @param {(line: string) => Promise<{ kind: string, text?: string }>} deps.ownerCommand - run a slash command as the authenticated owner (not through the bridge).
 * @param {Function} deps.waitFor - polling helper.
 */
export async function smokePairing({ WebSocket, protocol, pairing, wsUrl, base, token, home, sessionId, rpc, ownerPairing, ownerCommand, waitFor }) {
  const { BRIDGE_CLOSE_CODES, BRIDGE_PROTOCOL_VERSION, PAIRING_PROTOCOL_VERSION, PINNED_CHROME_EXTENSION_ID, bridgeEndpointOfUrl, createBridgeNonce } = protocol
  const endpoint = bridgeEndpointOfUrl(wsUrl)

  /**
   * Run the extension half of one exchange: ask with a code of its own, then
   * answer the bridge's share and acknowledge a `pair.ok` that verifies.
   * @returns `{ code, outcome }`; `outcome` resolves to `{ token, frames }` or `{ closed, frames }`.
   */
  const ask = async (origin, { name = 'Brave', code = pairing.generatePairingCode() } = {}) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000, ...origin === undefined ? {} : { origin } })
    const frames = []
    const closed = once(ws, 'close')
    let token
    let exchange
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      frames.push(frame)
      if (frame.t === 'pair.share' && exchange !== undefined) {
        exchange.keys = pairing.derivePairingKeys(exchange.context, exchange.own.secret, exchange.own.share, frame.share, 'client')
        ws.send(JSON.stringify({ t: 'pair.confirm', mac: pairing.pairingClientConfirmation(exchange.keys) }))
      } else if (frame.t === 'pair.ok' && exchange?.keys !== undefined) {
        token = pairing.openPairingToken(exchange.keys, frame.box, frame.mac)
        if (token !== undefined) ws.send(JSON.stringify({ t: 'pair.done', mac: pairing.pairingDoneMac(exchange.keys) }))
      }
    })
    await once(ws, 'open')
    const outcome = closed.then(([closeCode]) => token === undefined ? { closed: closeCode, frames } : { token, frames })
    await waitFor(() => frames.some(value => value.t === 'challenge') || ws.readyState === WebSocket.CLOSED, 'challenge or close', 10_000)
    const challenge = frames.find(value => value.t === 'challenge')
    if (challenge === undefined) return { code, ws, outcome }
    const context = { code, serverNonce: challenge.nonce, clientNonce: createBridgeNonce(), endpoint, origin: origin ?? '', name }
    const own = pairing.createPairingShare(context)
    exchange = { context, own }
    ws.send(JSON.stringify({ t: 'pair.request', v: PAIRING_PROTOCOL_VERSION, nonce: context.clientNonce, endpoint, origin: context.origin, name, share: own.share }))
    return { code, ws, outcome }
  }
  const pairedFile = async () => {
    try { return JSON.parse(await readFile(join(home, 'browser-paired-extensions.json'), 'utf8')) } catch { return undefined }
  }
  const status = async () => {
    const answer = await ownerPairing({ action: 'status' })
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    return answer.body
  }
  const waiting = count => waitFor(async () => (await status()).waiting === count, `${count} waiting pairing request(s)`, 10_000)
  const enter = async (code) => {
    const answer = await ownerPairing({ action: 'enter', code })
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    return answer.body.result
  }
  /** Frames that carry anything keyed. */
  const keyed = frames => frames.filter(frame => 'mac' in frame || 'box' in frame)

  // The control route is dsh's: without its authentication nobody reads the desk or enters a code.
  for (const init of [
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }) },
    { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ action: 'enter', code: 'ABC-DEF' }) },
  ]) {
    const response = await fetch(`${base}/api/bridge-browser.pairing`, { ...init, signal: AbortSignal.timeout(10_000) })
    assert.ok(response.status === 401 || response.status === 403, `an unauthenticated pairing request must be refused, got ${response.status}`)
  }
  // The public discovery answer says nothing about pairing.
  assert.doesNotMatch(await (await fetch(`${base}/ext/bridge-config`)).text(), /pair/iu)
  // (The smoke host pins its token in the plugin config, so it cannot be reset from the app.)
  assert.deepEqual(await status(), { ok: true, paused: false, waiting: 0, requests: [], failures: 0, pairedOrigins: [], canResetToken: false })
  const pinnedReset = await ownerPairing({ action: 'reset-token' })
  assert.equal(pinnedReset.status, 409, JSON.stringify(pinnedReset.body))

  // A web page can never ask, and neither can a client without an extension Origin.
  assert.equal((await (await ask('https://evil.example')).outcome).closed, BRIDGE_CLOSE_CODES.originRejected)
  assert.equal((await (await ask(undefined)).outcome).closed, 1008)

  // The pairing command is the host owner's: through the browser bridge it is refused, in every form.
  const offered = (await rpc('commands.list', { sessionId })).commands.map(command => command.name)
  assert.equal(offered.includes('browser-pair'), false, 'the panel is not offered a command it may not run')
  for (const line of ['/browser-pair', '/browser-pair ABC-DEF', '/browser-pair resume', '/browser-pair reset-token']) {
    const refused = await rpc.raw('commands.execute', { sessionId, line })
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'forbidden')
  }

  // The store build asks and shows its code. The host learns only that a browser waits and what it says it is.
  const first = await ask(STORE_ORIGIN, { name: 'Brave' })
  await waiting(1)
  // Who is asking is shown by Origin: this ID is not one the bridge is configured for.
  assert.deepEqual((await status()).requests, [{ origin: STORE_ORIGIN, name: 'Brave', official: false }])
  assert.equal(JSON.stringify(await status()).includes(first.code), false)
  assert.deepEqual(first.ws.readyState, WebSocket.OPEN)
  assert.equal(await pairedFile(), undefined, 'nothing is allowed before the code is entered')
  // A wrong code: the request is consumed, nothing is released, the failure is counted.
  const wrongCode = first.code.startsWith('A') ? `B${first.code.slice(1)}` : `A${first.code.slice(1)}`
  assert.equal(await enter(wrongCode), 'no-match')
  const missed = await first.outcome
  assert.equal(missed.closed, BRIDGE_CLOSE_CODES.pairingFailed)
  assert.deepEqual(keyed(missed.frames), [], 'a request that failed must have been sent nothing keyed')
  assert.equal(await enter(first.code), 'none-waiting', 'a consumed request never sees a second code')
  assert.equal((await status()).failures, 1)
  assert.equal(await pairedFile(), undefined)

  // A local process forging the pinned extension's Origin waits beside the genuine request.
  // The user types the genuine code: only the genuine request is paired.
  const forger = await ask(`chrome-extension://${PINNED_CHROME_EXTENSION_ID}`, { name: 'Chrome', code: 'QQQQQQ' })
  const second = await ask(STORE_ORIGIN, { name: 'Brave' })
  await waiting(2)
  // The card can only go by the Origin header, which a local process may forge: the forger is labelled
  // "official". That label cannot protect by itself; the code can, and the forger does not hold it.
  assert.deepEqual((await status()).requests.map(request => request.official), [true, false])
  assert.equal(await enter(pairing.formatPairingCode(second.code).toLowerCase()), 'paired')
  const paired = await second.outcome
  assert.equal(paired.token, token, `pairing must deliver the bridge token: ${JSON.stringify(paired.frames).slice(0, 400)}`)
  assert.equal(JSON.stringify(paired.frames).includes(token), false, 'the token must not cross the wire in the clear')
  assert.equal(JSON.stringify(paired.frames).includes(second.code), false, 'the code must not cross the wire')
  const forged = await forger.outcome
  assert.equal(forged.closed, BRIDGE_CLOSE_CODES.pairingFailed, 'a forged-Origin requester without the code gets no token')
  assert.deepEqual(forged.frames.map(frame => frame.t), ['challenge', 'pair.share'])
  assert.deepEqual(keyed(forged.frames), [])
  const after = await status()
  assert.equal(after.paired.origin, STORE_ORIGIN)
  assert.deepEqual(after.pairedOrigins, [STORE_ORIGIN])
  // Its ID is remembered across restarts, in a private file.
  const record = await waitFor(pairedFile, 'the paired-extension record', 10_000)
  assert.deepEqual(record.chromeExtensionIds, [STORE_ID])
  // The used code pairs nobody again.
  const replay = await ask(FIREFOX_ORIGIN, { name: 'Firefox', code: 'QQQQQQ' })
  await waiting(1)
  assert.equal(await enter(second.code), 'no-match')
  assert.ok((await replay.outcome).closed)

  // The command path, as the host's owner: status, then the code.
  const third = await ask(FIREFOX_ORIGIN, { name: 'Firefox' })
  await waiting(1)
  const listed = await ownerCommand('/browser-pair')
  assert.equal(listed.kind, 'success', JSON.stringify(listed))
  assert.match(listed.text, /1 browser is waiting/u)
  assert.ok(listed.text.includes(`Unknown extension, not the published DSH extension: ${FIREFOX_ORIGIN} (says it is Firefox)`), listed.text)
  assert.equal(listed.text.includes(third.code), false)
  const byCommand = await ownerCommand(`/browser-pair ${pairing.formatPairingCode(third.code)}`)
  assert.equal(byCommand.kind, 'success', JSON.stringify(byCommand))
  assert.equal((await third.outcome).token, token)

  // Paused: no request is taken until the owner resumes.
  assert.equal((await ownerPairing({ action: 'pause' })).body.paused, true)
  assert.equal((await (await ask(STORE_ORIGIN)).outcome).closed, BRIDGE_CLOSE_CODES.pairingPaused)
  assert.equal(await enter('ABC-DEF'), 'paused')
  assert.equal((await ownerPairing({ action: 'resume' })).body.paused, false)

  // A request whose browser goes away leaves the desk.
  const abandoned = await ask(STORE_ORIGIN)
  await waiting(1)
  abandoned.ws.terminate()
  await waiting(0)

  // The paired build is now let in to the ordinary handshake: a hello that
  // cannot prove the token fails on the proof (4002), no longer on the Origin
  // (4004). (A full second connection is left to the unit specs: on this
  // host it would take over the event stream the rest of the smoke reads.)
  const hello = async () => {
    const admitted = new WebSocket(wsUrl, { handshakeTimeout: 10_000, origin: STORE_ORIGIN })
    const seen = []
    admitted.on('message', data => { seen.push(JSON.parse(data.toString())) })
    const closed = once(admitted, 'close')
    await once(admitted, 'open')
    await waitFor(() => seen.some(value => value.t === 'challenge'), 'bridge challenge', 10_000)
    admitted.send(JSON.stringify({
      t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce(), mac: createBridgeNonce(), endpoint,
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    }))
    return (await closed)[0]
  }
  assert.equal(await hello(), BRIDGE_CLOSE_CODES.authFailed, 'a paired extension still has to prove the token')
  // Unpaired: refused at the Origin check again, and gone from the record.
  assert.equal((await ownerPairing({ action: 'unpair', origin: STORE_ORIGIN })).status, 200)
  assert.equal(await hello(), BRIDGE_CLOSE_CODES.originRejected, 'an unpaired extension is refused at the Origin check')
  await waitFor(async () => (await pairedFile())?.chromeExtensionIds.length === 0, 'the unpaired record', 10_000)
  assert.equal((await ownerPairing({ action: 'unpair', origin: STORE_ORIGIN })).status, 404)
  // The paired Firefox extension is listed and can be unpaired too: its origin is refused from then on,
  // although Firefox origins that never paired are still accepted with the token.
  assert.deepEqual((await status()).pairedOrigins, [FIREFOX_ORIGIN])
  assert.equal((await ownerPairing({ action: 'unpair', origin: FIREFOX_ORIGIN })).status, 200)
  const refusedFirefox = new WebSocket(wsUrl, { handshakeTimeout: 10_000, origin: FIREFOX_ORIGIN })
  const firefoxFrames = []
  refusedFirefox.on('message', data => { firefoxFrames.push(JSON.parse(data.toString())) })
  const firefoxClosed = once(refusedFirefox, 'close')
  await once(refusedFirefox, 'open')
  await waitFor(() => firefoxFrames.some(value => value.t === 'challenge'), 'bridge challenge', 10_000)
  refusedFirefox.send(JSON.stringify({
    t: 'hello', v: BRIDGE_PROTOCOL_VERSION, nonce: createBridgeNonce(), mac: createBridgeNonce(), endpoint,
    caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
  }))
  assert.equal((await firefoxClosed)[0], BRIDGE_CLOSE_CODES.originRejected, 'an unpaired Firefox extension is refused at the Origin check')
  assert.deepEqual((await pairedFile()).revokedFirefoxOrigins, [FIREFOX_ORIGIN])
}
