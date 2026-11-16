// Real-browser coverage for Auto review (docs/auto-review-design.md): the
// composer control and its one-time explanation, a low-risk click that runs
// with no card and shows the Auto badge and the reviewer's reason, a reviewer
// "ask" that shows the ordinary card with its line, a forced card that still
// appears with Auto on, a reviewer timeout that falls back to the card, and
// Auto turned off in the middle of a turn. Screenshots land in
// <evidence>/screenshots.
//
// The agent and the reviewer are one scripted model ("auto-check"): Auto
// review uses the conversation's own model, so review requests reach the same
// server and are told apart by the bridge's policy marker.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { readJson, streamReply } from '../lib/dsh-harness.mjs'
import { honestReviewer, isReviewRequest, reviewInput } from './scripted-model.mjs'

export const AUTO_PROVIDER = 'auto-check'

/** The fixture page the section drives. */
export const AUTO_REVIEW_PAGE = `<!doctype html><title>Trip notes</title><body style="font:14px sans-serif;padding:16px">
  <h1>Trip notes</h1>
  <button id="more" type="button">Show more</button><p id="moreOut"></p>
  <button id="expand" type="button">Expand details</button><p id="expandOut"></p>
  <form id="noteForm"><input id="note" aria-label="Note" value="See you at 8"><button id="send">Send message</button></form><p id="sent"></p>
  <script>
    window.counts = { more: 0, expand: 0, sent: 0 };
    document.querySelector('#more').addEventListener('click', () => { window.counts.more++; document.querySelector('#moreOut').textContent = 'More shown ' + window.counts.more });
    document.querySelector('#expand').addEventListener('click', () => { window.counts.expand++; document.querySelector('#expandOut').textContent = 'Details ' + window.counts.expand });
    document.querySelector('#noteForm').addEventListener('submit', (event) => { event.preventDefault(); window.counts.sent++; document.querySelector('#sent').textContent = 'Sent' });
  </script></body>`

/** Per turn (marked AR1…AR5 in the user's message): the browser steps, then a closing text. */
const TURNS = {
  AR1: [{ name: 'browser_click', args: { selector: '#more' } }],
  AR2: [{ name: 'browser_click', args: { selector: '#send' } }],
  AR3: [{ name: 'browser_click', args: { selector: '#more' } }],
  AR4: [{ name: 'browser_click', args: { selector: '#expand' } }],
  AR5: [{ name: 'browser_click', args: { selector: '#expand' }, gate: 'ar5' }],
}

const text = message => typeof message?.content === 'string'
  ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : ''

/** The scripted agent-and-reviewer model. `reviewer` and gates are set by the section. */
export async function startAutoReviewModel() {
  const state = { reviews: [], agentRequests: 0 }
  const gates = new Map()
  const released = new Set()
  let reviewer = honestReviewer
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    if (!String(request.url).endsWith('/chat/completions')) { response.writeHead(404).end(); return }
    if (isReviewRequest(body)) {
      const entry = { input: reviewInput(body) }
      state.reviews.push(entry)
      const answer = await reviewer(body)
      entry.answer = answer
      if (answer?.hang === true) { await new Promise(resolve => { response.on('close', resolve) }); return }
      streamReply(response, { text: JSON.stringify(answer) }, { model: AUTO_PROVIDER })
      return
    }
    state.agentRequests += 1
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.some(message => message.role === 'user' && text(message).includes('Generate the session title'))) {
      streamReply(response, { text: 'Auto review smoke' }, { model: AUTO_PROVIDER })
      return
    }
    const markerIndex = messages.findLastIndex(message => message.role === 'user' && /\bAR\d\b/u.test(text(message)))
    const marker = markerIndex === -1 ? undefined : /\b(AR\d)\b/u.exec(text(messages[markerIndex]))[1]
    const done = messages.slice(markerIndex + 1).filter(message => message.role === 'tool').length
    const step = marker === undefined ? undefined : TURNS[marker]?.[done]
    if (step?.gate !== undefined && !released.has(step.gate)) {
      await new Promise(resolve => { gates.set(step.gate, [...gates.get(step.gate) ?? [], resolve]) })
    }
    streamReply(response, step === undefined ? { text: `${marker ?? 'Auto review smoke'} done.` } : { tool: { name: step.name, args: step.args } }, { model: AUTO_PROVIDER })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    state,
    setReviewer: (next) => { reviewer = next },
    /** Whether the agent's next step is held on gate `name`. */
    waiting: (name) => (gates.get(name)?.length ?? 0) > 0,
    release: (name) => {
      released.add(name)
      for (const resolve of gates.get(name) ?? []) resolve()
      gates.delete(name)
    },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/**
 * @param {object} ctx - handles from smoke-browser.mjs plus `autoModel` and `autoPage` (the fixture URL).
 * @returns {Promise<string[]>} screenshot paths.
 */
export async function runAutoReviewSmoke(ctx) {
  const { browser, page, panel, extensionId, directory, settings, waitFor, hostRpc, bridgeRpc, knownSessions, results, delay, autoModel, autoPage } = ctx
  const shots = join(directory, 'screenshots')
  await mkdir(shots, { recursive: true })
  const taken = []
  const shot = async (target, name) => {
    const path = join(shots, name)
    await target.screenshot({ path })
    taken.push(path)
    return path
  }

  // Every ordinary card asks: nothing is trusted, page reads are automatic.
  await settings({ unrestrictedBrowserAccess: false, trustedActionOrigins: [], sharePageContent: 'auto', siteRules: [], offerAutoReview: true })
  await page.goto(autoPage)
  await page.bringToFront()
  const chat = await browser.newPage()
  await chat.setViewportSize({ width: 400, height: 860 })
  await chat.goto(`chrome-extension://${extensionId}/panel/index.html`)
  await page.bringToFront()
  const composer = chat.locator('textarea')
  await waitFor(() => composer.isEnabled(), 'Auto review panel readiness')
  await composer.fill('Warm up this conversation.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  await chat.getByRole('button', { name: 'Continue generating', exact: true }).waitFor({ timeout: 30_000 })
  const session = (await bridgeRpc('session.list', {})).items.find(item => !item.blank && !knownSessions.includes(item.sessionId))
  assert.ok(session, 'Auto review session')
  await hostRpc('session', 'selectModel', { sessionId: session.sessionId, provider: AUTO_PROVIDER, model: AUTO_PROVIDER })
  await waitFor(async () => (await chat.locator('.composer-model > button').textContent()).includes(AUTO_PROVIDER), 'scripted model selected')

  // The user's own prompt is what the reviewer trusts: check DSH records it as user-sourced with an RPC id.
  const history = await bridgeRpc('session.history', { sessionId: session.sessionId })
  const warmUp = history.events.map(({ event }) => event).find(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('Warm up this conversation.'))
  assert.equal(warmUp?.data.source.kind, 'user', 'a panel prompt is user-sourced')
  assert.equal(typeof warmUp?.data.source.rpcId, 'string', 'a panel prompt carries its RPC id')

  // ---- The control: Ask by default, a one-time explanation, then Auto ----
  const chip = chat.locator('.composer-approvals .composer-chip-trigger')
  try {
    await waitFor(async () => !(await chip.isDisabled()) && (await chip.textContent()) === 'Approvals: Ask', 'the Approvals control is offered and starts on Ask', 20_000)
  } catch (error) {
    await shot(chat, 'debug-auto-review-control.png').catch(() => {})
    const seen = await panel.evaluate(() => messages.filter(message => String(message.type).startsWith('auto-review')).slice(-3)).catch(cause => String(cause))
    throw new Error(`Approvals control not usable: ${JSON.stringify({ title: await chip.getAttribute('title').catch(() => null), text: await chip.textContent().catch(() => null), seen })}`, { cause: error })
  }
  await chip.click()
  await chat.locator('.auto-review-menu').waitFor()
  await shot(chat, 'auto-review-menu.png')
  await chat.locator('.auto-review-menu button', { hasText: 'Auto review' }).click()
  await chat.locator('.auto-review-dialog').waitFor()
  await shot(chat, 'auto-review-explanation.png')
  await chat.getByRole('button', { name: 'Turn on Auto review', exact: true }).click()
  await chat.locator('.auto-review-indicator').waitFor()
  assert.equal(await chip.textContent(), 'Approvals: Auto')
  await shot(chat, 'auto-review-on.png')

  const cardsSoFar = () => panel.evaluate(() => messages.filter(message => message.type === 'approval.request').length)
  const send = async (prompt) => {
    await composer.fill(prompt)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const turnDone = (marker) => chat.getByText(`${marker} done.`, { exact: true }).waitFor({ timeout: 60_000 })

  // ---- 1. A low-risk click runs with no card: "Reviewing…", then the Auto badge and reason ----
  let releaseReview
  const reviewHeld = new Promise(resolve => { releaseReview = resolve })
  autoModel.setReviewer(async (body) => { await reviewHeld; return honestReviewer(body) })
  const cardsBefore = await cardsSoFar()
  await send('AR1 Show me more of these notes.')
  await chat.locator('.timeline-step-reviewing').waitFor({ timeout: 30_000 })
  await shot(chat, 'auto-review-reviewing.png')
  releaseReview()
  await turnDone('AR1')
  assert.equal(await page.evaluate(() => window.counts.more), 1, 'the reviewed click ran')
  assert.equal(await cardsSoFar(), cardsBefore, 'no card for a low-risk click Auto review approved')
  await waitFor(async () => await chat.locator('.auto-review-badge').count() === 1, 'the Auto badge on the timeline row')
  await chat.locator('.timeline-step-auto-reason').first().waitFor()
  // A fixed line on the row; the reviewer's own words only in the step's details.
  assert.equal(await chat.locator('.timeline-step-auto-reason').first().textContent(), 'Approved by Auto review')
  await shot(chat, 'auto-review-approved-row.png')
  autoModel.setReviewer(honestReviewer)
  results.push('Auto review on: a low-risk click ran with no card, showed "Reviewing…" while the conversation\'s model decided, then the Auto badge and the fixed "Approved by Auto review" line')

  // ---- 2. The reviewer asks: the ordinary card, with its line ----
  await send('AR2 Have a look at the note form.')
  const askCard = chat.locator('.approval-dialog')
  await askCard.waitFor({ timeout: 30_000 })
  await chat.locator('.approval-auto-review').waitFor()
  // A fixed sentence chosen by code, never the reviewer's words.
  assert.equal(await chat.locator('.approval-auto-review').textContent(), 'Auto review asked: the reviewer was not sure this fits your request.')
  await shot(chat, 'auto-review-ask-card.png')
  await chat.getByRole('button', { name: 'Deny', exact: true }).click()
  await turnDone('AR2')
  assert.equal(await page.evaluate(() => window.counts.sent), 0, 'the submit the user never asked for did not run')
  results.push('a reviewer "ask" shows the ordinary card with a fixed "Auto review asked: …" sentence (never model text), and the user decides')

  // ---- 3. A forced card still appears with Auto on, and is never reviewed ----
  const host = new URL(autoPage).host
  await settings({ siteRules: [{ pattern: host, rule: 'ask' }] })
  const reviewsBeforeForced = autoModel.state.reviews.length
  await send('AR3 Show more once again.')
  await askCard.waitFor({ timeout: 30_000 })
  assert.equal(await chat.locator('.approval-auto-review').count(), 0, 'a forced card carries no Auto review line')
  assert.equal(autoModel.state.reviews.length, reviewsBeforeForced, 'a forced card is never sent to the reviewer')
  const forced = await panel.evaluate(() => messages.filter(message => message.type === 'approval.request').at(-1).request)
  assert.equal(forced.forced, true)
  await chat.getByRole('button', { name: 'Allow once', exact: true }).click()
  await turnDone('AR3')
  await settings({ siteRules: [] })
  results.push('with Auto review on, a site "ask" rule still forces its card and the reviewer is never asked')

  // ---- 4. The reviewer does not answer: after its time limit the card shows ----
  autoModel.setReviewer(() => ({ hang: true }))
  const timedFrom = Date.now()
  await send('AR4 Expand the details.')
  await askCard.waitFor({ timeout: 30_000 })
  const waited = Date.now() - timedFrom
  assert.match(await chat.locator('.approval-auto-review').textContent(), /did not answer in time/u)
  assert.ok(waited >= 8_000, `the card waited for the reviewer's time limit (${waited} ms)`)
  await chat.getByRole('button', { name: 'Allow once', exact: true }).click()
  await turnDone('AR4')
  autoModel.setReviewer(honestReviewer)
  results.push(`a reviewer that never answers falls back to the card after its time limit (${Math.round(waited / 1000)} s)`)

  // ---- 5. Auto turned off in the middle of a turn: the next step asks ----
  await send('AR5 Expand the details again.')
  // The model holds its step: the turn is running when the user turns Auto off.
  await waitFor(() => autoModel.waiting('ar5'), 'the AR5 step is waiting')
  await chat.locator('.auto-review-indicator button').click()
  await waitFor(async () => (await chip.textContent()) === 'Approvals: Ask', 'Auto review off')
  const reviewsBeforeOff = autoModel.state.reviews.length
  autoModel.release('ar5')
  await askCard.waitFor({ timeout: 30_000 })
  assert.equal(autoModel.state.reviews.length, reviewsBeforeOff, 'no review after Auto was turned off')
  await chat.getByRole('button', { name: 'Allow once', exact: true }).click()
  await turnDone('AR5')
  results.push('turning Auto review off in the middle of a turn makes the next step ask')

  // The audit log records each review: decision, risk, reason, model and binding.
  const exported = await bridgeRpc('bridge.audit.export', { sessionId: session.sessionId }).catch(() => undefined)
  const reviews = (exported?.entries ?? []).filter(entry => entry.kind === 'auto-review')
  assert.ok(reviews.length >= 3, `auto-review audit entries (${reviews.length})`)
  assert.ok(reviews.every(entry => /^[0-9a-f]{64}$/u.test(entry.binding) && entry.model === `${AUTO_PROVIDER}/${AUTO_PROVIDER}`), 'each review records its binding and model')
  await chat.close()
  return taken
}
