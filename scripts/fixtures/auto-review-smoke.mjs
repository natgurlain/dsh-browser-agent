// Real-browser coverage for Auto approve (docs/auto-approve-design.md): the
// composer toggle and its one confirmation; a multi-step task (navigate,
// click, type, submit a form) that completes with ZERO approval cards, where
// only the submit is reviewed (silently, "Checking…" in the timeline); the
// measured added latency of an ordinary step (against a trusted-site baseline
// that also shows no card) and of a reviewed one; a reviewer "deny" that shows
// the ordinary card with the reviewer's line; a reviewer timeout that falls
// back to the card; Auto turned off mid-turn; and the Settings option.
// Screenshots (light and dark) land in <evidence>/screenshots.
//
// The agent and the reviewer are one scripted model ("auto-check"): the
// reviewer is the conversation's own model, so review requests reach the same
// server and are told apart by the bridge's policy marker.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { readJson, streamReply } from '../lib/dsh-harness.mjs'
import { honestReviewer, isReviewRequest, reviewInput } from './scripted-model.mjs'

export const AUTO_PROVIDER = 'auto-check'

/** The fixture page the section drives (served for every /auto-review… path). */
export const AUTO_REVIEW_PAGE = `<!doctype html><title>Trip notes</title><body style="font:14px sans-serif;padding:16px">
  <h1>Trip notes</h1>
  <button id="more" type="button" aria-expanded="false">Show more</button><p id="moreOut"></p>
  <h2>Contact the organiser</h2>
  <form id="contact" method="post" action="/auto-review/contact"><label>Your name <input id="name" name="name"></label> <button id="submit">Submit</button></form><p id="submitted"></p>
  <h2>Note to the group</h2>
  <form id="noteForm" method="post" action="/auto-review/notes"><input id="note" aria-label="Note" value="See you at 8"> <button id="send">Send message</button></form><p id="sent"></p>
  <script>
    window.counts = { more: 0, submitted: 0, sent: 0, name: '' };
    document.querySelector('#more').addEventListener('click', () => { window.counts.more++; document.querySelector('#moreOut').textContent = 'More shown ' + window.counts.more });
    document.querySelector('#contact').addEventListener('submit', (event) => { event.preventDefault(); window.counts.submitted++; window.counts.name = document.querySelector('#name').value; document.querySelector('#submitted').textContent = 'Thanks, ' + window.counts.name });
    document.querySelector('#noteForm').addEventListener('submit', (event) => { event.preventDefault(); window.counts.sent++; document.querySelector('#sent').textContent = 'Sent' });
  </script></body>`

const text = message => typeof message?.content === 'string'
  ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : ''

/** The scripted agent-and-reviewer model. Turns (by an AR<n> marker in the user's message) and the reviewer are set by the section. */
export async function startAutoReviewModel() {
  const state = { reviews: [], agentRequests: 0 }
  const turns = new Map()
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
      streamReply(response, { text: 'Auto approve smoke' }, { model: AUTO_PROVIDER })
      return
    }
    const markerIndex = messages.findLastIndex(message => message.role === 'user' && /\bAR\d\b/u.test(text(message)))
    const marker = markerIndex === -1 ? undefined : /\b(AR\d)\b/u.exec(text(messages[markerIndex]))[1]
    const done = messages.slice(markerIndex + 1).filter(message => message.role === 'tool').length
    const step = marker === undefined ? undefined : turns.get(marker)?.[done]
    if (step?.gate !== undefined && !released.has(step.gate)) {
      await new Promise(resolve => { gates.set(step.gate, [...gates.get(step.gate) ?? [], resolve]) })
    }
    streamReply(response, step === undefined ? { text: `${marker ?? 'Auto approve smoke'} done.` } : { tool: { name: step.name, args: step.args } }, { model: AUTO_PROVIDER })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    state,
    /** The browser steps of one turn (by marker). */
    setTurn: (marker, steps) => { turns.set(marker, steps) },
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

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)]
}

/**
 * @param {object} ctx - handles from smoke-browser.mjs plus `autoModel` and `autoPage` (the fixture URL).
 * @returns {Promise<string[]>} screenshot paths.
 */
export async function runAutoReviewSmoke(ctx) {
  const { browser, page, panel, extensionId, directory, settings, waitFor, hostRpc, bridgeRpc, knownSessions, results, autoModel, autoPage } = ctx
  const shots = join(directory, 'screenshots')
  await mkdir(shots, { recursive: true })
  const taken = []
  const shot = async (target, name) => {
    const path = join(shots, name)
    await target.screenshot({ path })
    taken.push(path)
    return path
  }
  /** The same view in the light and the dark palette. */
  const themedShots = async (target, name) => {
    for (const theme of ['light', 'dark']) {
      await target.evaluate((value) => { document.documentElement.setAttribute('data-theme', value) }, theme)
      await target.waitForTimeout(150)
      await shot(target, `${name}-${theme}.png`)
    }
    await target.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light') })
  }

  const origin = new URL(autoPage).origin
  // Nothing trusted and every page read automatic: without Auto approve, every action asks.
  await settings({ unrestrictedBrowserAccess: false, trustedActionOrigins: [], sharePageContent: 'auto', siteRules: [], autoApproveDefault: false })
  await page.goto(autoPage)
  await page.bringToFront()
  const chat = await browser.newPage()
  await chat.setViewportSize({ width: 400, height: 860 })
  await chat.goto(`chrome-extension://${extensionId}/panel/index.html`)
  await page.bringToFront()
  const composer = chat.locator('textarea')
  await waitFor(() => composer.isEnabled(), 'Auto approve panel readiness')
  await composer.fill('Warm up this conversation.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  await chat.getByRole('button', { name: 'Continue generating', exact: true }).waitFor({ timeout: 30_000 })
  const session = (await bridgeRpc('session.list', {})).items.find(item => !item.blank && !knownSessions.includes(item.sessionId))
  assert.ok(session, 'Auto approve session')
  await hostRpc('session', 'selectModel', { sessionId: session.sessionId, provider: AUTO_PROVIDER, model: AUTO_PROVIDER })
  await waitFor(async () => (await chat.locator('.composer-model > button').textContent()).includes(AUTO_PROVIDER), 'scripted model selected')

  // The user's own prompt is what the reviewer trusts: DSH records it as user-sourced with an RPC id.
  const history = await bridgeRpc('session.history', { sessionId: session.sessionId })
  const warmUp = history.events.map(({ event }) => event).find(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('Warm up this conversation.'))
  assert.equal(warmUp?.data.source.kind, 'user', 'a panel prompt is user-sourced')
  assert.equal(typeof warmUp?.data.source.rpcId, 'string', 'a panel prompt carries its RPC id')

  const cardsSoFar = () => panel.evaluate(() => messages.filter(message => message.type === 'approval.request').length)
  const send = async (prompt) => {
    await composer.fill(prompt)
    await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const turnDone = async (marker) => {
    try {
      await chat.getByText(`${marker} done.`, { exact: true }).waitFor({ timeout: 60_000 })
    } catch (error) {
      const card = await panel.evaluate(() => messages.filter(message => message.type === 'approval.request').at(-1)?.request).catch(() => undefined)
      throw new Error(`${marker} did not finish; last card: ${JSON.stringify({ summary: card?.summary, note: card?.autoReviewNote })}; reviews: ${JSON.stringify(autoModel.state.reviews.slice(-2).map(review => review.answer))}`, { cause: error })
    }
  }
  const audit = async () => (await bridgeRpc('bridge.audit.export', { sessionId: session.sessionId })).entries ?? []
  const askCard = chat.locator('.approval-dialog')
  const more = { name: 'browser_click', args: { selector: '#more' } }

  // ---- 0. Baseline: the site trusted, Auto off. Three clicks pass with no card (standing rule) ----
  await settings({ trustedActionOrigins: [origin] })
  autoModel.setTurn('AR0', [more, more, more])
  const baselineCards = await cardsSoFar()
  await send('AR0 Show more three times.')
  await turnDone('AR0')
  assert.equal(await cardsSoFar(), baselineCards, 'the trusted-site baseline shows no card')
  await settings({ trustedActionOrigins: [] })

  // ---- The toggle: off by default, one confirmation the first time, then on ----
  const toggle = chat.locator('.auto-approve-toggle')
  await waitFor(async () => !(await toggle.isDisabled()) && (await toggle.getAttribute('aria-pressed')) === 'false', 'the Auto approve toggle is offered and off')
  await toggle.click()
  await chat.locator('.auto-review-dialog').waitFor()
  await themedShots(chat, 'auto-approve-confirm')
  await chat.locator('.auto-review-dialog').getByRole('button', { name: 'Turn on', exact: true }).click()
  await chat.locator('.auto-review-indicator').waitFor()
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true')

  // ---- 1. A multi-step task: navigate, click, type, submit a form. Zero cards; only the submit is reviewed ----
  // The reviewer takes 4 s here (under the bridge's 8 s limit), long enough to photograph "Checking…".
  autoModel.setReviewer(async (body) => { await new Promise(resolve => { setTimeout(resolve, 4_000) }); return honestReviewer(body) })
  autoModel.setTurn('AR1', [
    { name: 'browser_navigate', args: { url: `${autoPage}/contact` } },
    more,
    { name: 'browser_type', args: { selector: '#name', text: 'Ada' } },
    { name: 'browser_click', args: { selector: '#submit' } },
  ])
  const cardsBefore = await cardsSoFar()
  const reviewsBefore = autoModel.state.reviews.length
  await send('AR1 Open the contact page, show more, put my name Ada in the contact form and submit it.')
  // The submit is consequential: the timeline says "Checking…" while the reviewer decides; no card.
  await chat.locator('.timeline-step-reviewing').waitFor({ timeout: 30_000 })
  assert.equal(await cardsSoFar(), cardsBefore, 'no card while the reviewer checks')
  await themedShots(chat, 'auto-approve-checking')
  await turnDone('AR1')
  autoModel.setReviewer(honestReviewer)
  assert.equal(await cardsSoFar(), cardsBefore, 'the whole task ran with zero approval cards')
  assert.equal(new URL(page.url()).pathname, '/auto-review/contact', 'the navigation ran')
  assert.deepEqual(await page.evaluate(() => window.counts), { more: 1, submitted: 1, sent: 0, name: 'Ada' }, 'click, typing and submit ran')
  const task = autoModel.state.reviews.slice(reviewsBefore)
  assert.equal(task.length, 1, `only the submit was reviewed (${task.length} reviews)`)
  assert.match(task[0].input, /"control_name": "Submit"/u)
  assert.match(task[0].input, /"consequential_because": \[[^\]]*"submits-form"/u)
  // Page text only inside the fence; the user's words in the trusted part.
  assert.match(task[0].input.split('<untrusted_page_data')[0], /put my name Ada in the contact form and submit it/u)
  // The timeline: four Auto rows, the submit marked as checked.
  await waitFor(async () => await chat.locator('.auto-review-badge').count() >= 4, 'Auto badges on the timeline rows')
  assert.ok(await chat.getByText('Auto-approved after a check', { exact: true }).count() >= 1)
  await themedShots(chat, 'auto-approve-on')
  results.push('Auto approve on: navigate, click, type and a form submit ran with zero approval cards; only the submit was reviewed (silently, "Checking…" in the timeline), and the timeline marks every step Auto')

  // ---- 2. Latency: ordinary steps under Auto against the trusted-site baseline; the reviewed step ----
  autoModel.setTurn('AR2', [more, more, more, { name: 'browser_click', args: { selector: '#submit' } }])
  const cardsBeforeTimed = await cardsSoFar()
  await send('AR2 Show more three times, then submit the contact form.')
  await turnDone('AR2')
  assert.equal(await cardsSoFar(), cardsBeforeTimed, 'the timed turn showed no card')
  const entries = await audit()
  const byCall = new Map()
  for (const entry of entries) {
    if (typeof entry.callId !== 'string') continue
    const record = byCall.get(entry.callId) ?? {}
    if (entry.kind === 'tool-call') record.tool = entry.tool
    if (entry.kind === 'approval') record.decision = entry.decision
    if (entry.kind === 'result' && typeof entry.durationMs === 'number') record.durationMs = entry.durationMs
    if (entry.kind === 'auto-review') record.review = entry
    byCall.set(entry.callId, record)
  }
  const calls = [...byCall.values()]
  const clicks = (decision) => calls.filter(call => call.tool === 'browser_click' && call.decision === decision && call.review === undefined && typeof call.durationMs === 'number').map(call => call.durationMs)
  const trusted = clicks('auto-allowed')
  const auto = clicks('auto-approved')
  assert.ok(trusted.length >= 3 && auto.length >= 3, `enough timed clicks (trusted ${trusted.length}, auto ${auto.length})`)
  // The last reviewed submit (AR2): its review was not held open.
  const reviewed = calls.filter(call => call.review !== undefined && call.decision === 'auto-reviewed').at(-1)
  assert.ok(reviewed, 'the reviewed submit is audited as auto-reviewed, with its review')
  assert.equal(reviewed.review.decision, 'allow')
  const latency = {
    trustedClickMs: median(trusted),
    autoClickMs: median(auto),
    reviewMs: reviewed.review.durationMs,
    reviewedSubmitMs: reviewed.durationMs,
  }
  results.push(`latency (scripted reviewer model): ordinary click median ${latency.autoClickMs} ms under Auto approve vs ${latency.trustedClickMs} ms on a trusted site (no card either way); a reviewed submit took ${latency.reviewedSubmitMs} ms end to end, of which the review ${latency.reviewMs} ms`)

  // ---- 3. The reviewer denies: the ordinary card, with the reviewer's one line ----
  autoModel.setTurn('AR3', [{ name: 'browser_click', args: { selector: '#send' } }])
  await send('AR3 Read the notes for me.')
  await askCard.waitFor({ timeout: 30_000 })
  await chat.locator('.approval-auto-review').waitFor()
  assert.equal(await chat.locator('.approval-auto-review').textContent(), 'Auto approve\'s reviewer asked you: You did not ask for this step.')
  await themedShots(chat, 'auto-approve-denied-card')
  await chat.getByRole('button', { name: 'Deny', exact: true }).click()
  await turnDone('AR3')
  assert.equal(await page.evaluate(() => window.counts.sent), 0, 'the send the user never asked for did not run')
  results.push('a consequential step the user did not ask for: the reviewer denied it, the ordinary card showed the reviewer\'s one-line reason, and the user decided')

  // ---- 4. The reviewer does not answer: after its time limit the card shows ----
  autoModel.setReviewer(() => ({ hang: true }))
  autoModel.setTurn('AR4', [{ name: 'browser_click', args: { selector: '#submit' } }])
  const timedFrom = Date.now()
  await send('AR4 Submit the contact form again.')
  await askCard.waitFor({ timeout: 30_000 })
  const waited = Date.now() - timedFrom
  assert.match(await chat.locator('.approval-auto-review').textContent(), /did not answer in time/u)
  assert.ok(waited >= 7_000, `the card waited for the reviewer's time limit (${waited} ms)`)
  await chat.getByRole('button', { name: 'Allow once', exact: true }).click()
  await turnDone('AR4')
  autoModel.setReviewer(honestReviewer)
  results.push(`a reviewer that never answers falls back to the card after its time limit (${Math.round(waited / 1000)} s)`)

  // ---- 5. Auto turned off in the middle of a turn: the next step asks ----
  autoModel.setTurn('AR5', [{ ...more, gate: 'ar5' }])
  await send('AR5 Show more again.')
  await waitFor(() => autoModel.waiting('ar5'), 'the AR5 step is waiting')
  await chat.locator('.auto-review-indicator button').click()
  await waitFor(async () => (await toggle.getAttribute('aria-pressed')) === 'false', 'Auto approve off')
  const reviewsBeforeOff = autoModel.state.reviews.length
  autoModel.release('ar5')
  await askCard.waitFor({ timeout: 30_000 })
  assert.equal(autoModel.state.reviews.length, reviewsBeforeOff, 'no review after Auto was turned off')
  await chat.getByRole('button', { name: 'Allow once', exact: true }).click()
  await turnDone('AR5')
  results.push('turning Auto approve off in the middle of a turn makes the next step ask')

  // ---- The Settings option ----
  await chat.getByRole('button', { name: 'Open settings', exact: true }).click()
  const option = chat.getByText('Start conversations in Auto approve', { exact: true })
  await option.scrollIntoViewIfNeeded()
  await chat.getByText('With Auto approve on, the agent acts without asking; a web page that tricks the model can make it do things you did not ask for.', { exact: true }).waitFor()
  await themedShots(chat, 'auto-approve-setting')
  await chat.getByRole('button', { name: 'Back to chat', exact: true }).click()
  results.push('Settings offers "Start conversations in Auto approve" (off by default) with its one-sentence trade-off')

  // The audit log records each review: decision, reason, model and binding.
  const reviews = (await audit()).filter(entry => entry.kind === 'auto-review')
  assert.ok(reviews.length >= 3, `auto-review audit entries (${reviews.length})`)
  assert.ok(reviews.every(entry => /^[0-9a-f]{64}$/u.test(entry.binding) && entry.model === `${AUTO_PROVIDER}/${AUTO_PROVIDER}`), 'each review records its binding and model')
  await chat.close()
  return taken
}
