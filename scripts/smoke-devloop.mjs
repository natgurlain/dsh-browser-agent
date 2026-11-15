/**
 * Runtime smoke for the closed dev loop (Phase 3.5), run by smoke-runtime.mjs
 * against a real DSH host.
 *
 * A coding session (created as the owner, NOT by the bridge) is linked to a
 * localhost tab by the panel stand-in. A real Agent turn in that session
 * edits a file through DSH's `write` tool; when the turn ends the bridge asks
 * the stand-in extension for a capture, and the answer is injected into the
 * session as read-only context: the next model request carries it, while the
 * session was never prompted from the browser and was not woken.
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * @param {object} deps
 * @param {(sessionId: string, cwd: string) => Promise<void>} deps.place - create a session as the owner.
 * @param {(namespace: string, method: string, args: unknown) => Promise<unknown>} deps.owner - invoke the gateway as the owner.
 * @param {Function} deps.rpc - the panel stand-in's fenced rpc (legacy socket).
 * @param {string} deps.wsUrl - bridge WebSocket URL.
 * @param {Function} deps.connectClient - authenticated bridge client factory.
 * @param {Function} deps.waitFor - polling helper.
 * @param {string} deps.temp - smoke temp directory (the coding session's cwd).
 * @param {string} deps.home - DSH_HOME.
 * @param {{ checkMessages?: string }} deps.probe - what the scripted model saw on DEVLOOP-CHECK.
 * @param {object} deps.methods - protocol constants.
 */
export async function smokeDevLoop({ place, owner, rpc, wsUrl, connectClient, waitFor, temp, home, probe, methods }) {
  const coding = `session-${randomUUID()}`
  await place(coding, temp)
  const caps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60, client: { id: 'smoke-devloop-panel', browser: 'chrome' } }
  const panel = await connectClient(wsUrl, caps)
  const call = async (method, payload) => {
    const answer = await panel.request(method, payload)
    assert.equal(answer.ok, true, JSON.stringify(answer))
    return answer.result.result
  }
  try {
    // The picker lists the user's coding sessions, never the bridge's own.
    const candidates = await call(methods.BRIDGE_DEVLOOP_CANDIDATES_METHOD, {})
    assert.ok(candidates.ok && candidates.value.items.some(item => item.sessionId === coding), 'the coding session is offered')
    const owned = (await rpc('session.list', {})).items.map(item => item.sessionId)
    assert.ok(owned.length > 0 && !candidates.value.items.some(item => owned.includes(item.sessionId)), 'bridge sessions are not offered')

    // Only localhost may be linked; the link is an explicit act of the panel.
    const remote = await call(methods.BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: coding, url: 'https://shop.example/' })
    assert.equal(remote.ok, false)
    assert.equal(remote.error.code, 'bad-request')
    const linked = await call(methods.BRIDGE_DEVLOOP_LINK_METHOD, { sessionId: coding, url: 'http://localhost:5173/app' })
    assert.equal(linked.ok, true, JSON.stringify(linked))
    assert.equal(linked.value.link.origin, 'http://localhost:5173')

    // Linking grants no prompting, steering or injection through the generic paths.
    for (const [method, payload] of [
      ['session.prompt', { sessionId: coding, mode: 'queue', content: [{ type: 'text', text: 'hi' }] }],
      ['commands.execute', { sessionId: coding, line: '/plan' }],
      [methods.BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId: coding, snapshot: 'Page: x' }],
    ]) {
      const refused = await panel.request(method, payload)
      const error = refused.ok ? refused.result?.result?.error : refused.error
      assert.equal(error?.code, 'forbidden', `${method}: ${JSON.stringify(refused)}`)
    }

    // A real turn in the coding session edits a file through DSH's write tool.
    await owner('session', 'selectModel', { request: { sessionId: coding, provider: 'scripted', model: 'scripted' } })
    const captures = () => panel.frames.filter(frame => frame.t === 'tool.call' && frame.name === 'browser_devloop_capture')
    await panel.request('session.list', {})
    await owner('session', 'prompt', { request: { requestId: randomUUID(), sessionId: coding, mode: 'queue', content: [{ type: 'text', text: 'DEVLOOP-EDIT' }] } })
    const capture = await waitFor(() => captures()[0], 'dev loop capture after the editing turn', 60_000)
    assert.equal(capture.sessionId, coding)
    assert.deepEqual(capture.args, { origin: 'http://localhost:5173' })
    assert.equal(await readFile(join(temp, 'devloop-edit.txt'), 'utf8'), 'edited by the coding agent\n')
    panel.send({ t: 'tool.result', id: capture.id, ok: true, result: { text: 'Linked tab: http://localhost:5173\nConsole errors since the last turn (1):\n- [exception] DEVLOOP-MARKER TypeError: user is undefined' } })

    // Injected, not prompted: the session stays idle until the user's next message.
    await new Promise(resolve => setTimeout(resolve, 1_000))
    assert.equal((await owner('session', 'state', { request: { sessionId: coding } })).running, false, 'the injection does not wake the session')
    await owner('session', 'prompt', { request: { requestId: randomUUID(), sessionId: coding, mode: 'queue', content: [{ type: 'text', text: 'DEVLOOP-CHECK' }] } })
    const seen = await waitFor(() => probe.checkMessages, 'the next model request', 60_000)
    assert.match(seen, /Browser dev loop/u)
    assert.match(seen, /DEVLOOP-MARKER/u)
    await waitFor(async () => (await owner('session', 'state', { request: { sessionId: coding } })).running === false, 'check turn end', 60_000)
    // A turn without edits asks for nothing.
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(captures().length, 1, 'only turns that edited files trigger a capture')

    // The capture went through the audited browser path under the coding session.
    const auditDir = join(home, 'browser-audit')
    const auditFile = (await readdir(auditDir)).find(name => name.includes(coding))
    assert.ok(auditFile, 'the dev loop capture is in the coding session\'s audit log')
    assert.match(await readFile(join(auditDir, auditFile), 'utf8'), /browser_devloop_capture/u)

    const unlinked = await call(methods.BRIDGE_DEVLOOP_UNLINK_METHOD, { sessionId: coding })
    assert.deepEqual(unlinked, { ok: true, value: { unlinked: true } })
  } finally {
    panel.ws.close()
  }
}
