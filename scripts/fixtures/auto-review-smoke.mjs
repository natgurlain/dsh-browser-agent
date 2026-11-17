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

/** Leads the plain POST form saved (the form navigates: 303 to the saved page, like a server-rendered app). */
export const leadSaves = []

/**
 * The navigating POST form: `/auto-review/lead` (the form), POST
 * `/auto-review/lead/save` (saves, 303), `/auto-review/lead/saved`.
 * @returns {boolean} whether the request was answered here.
 */
export function handleAutoReviewRequest(request, response) {
  const path = new URL(request.url, 'http://fixture').pathname
  if (path === '/auto-review/lead/save' && request.method === 'POST') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      leadSaves.push(body)
      // At once: the new page replaces the form before the click's own answer is due.
      response.writeHead(303, { location: '/auto-review/lead/saved' }).end()
    })
    return true
  }
  if (path === '/auto-review/lead/saved') {
    response.end('<!doctype html><title>Lead saved</title><body style="font:14px sans-serif;padding:16px"><h1>Lead saved</h1><p id="saved">Marta Okafor is in your leads.</p></body>')
    return true
  }
  if (path === '/auto-review/lead') {
    response.end(`<!doctype html><title>New lead</title><body style="font:14px sans-serif;padding:16px"><h1>New lead</h1>
      <form method="post" action="/auto-review/lead/save"><label>Name <input id="lead" name="name"></label> <button id="save">Save lead</button></form></body>`)
    return true
  }
  return false
}

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
    // What the agent was told about its last step (the tool result it reads next).
    const lastTool = messages.findLast(message => message.role === 'tool')
    if (lastTool !== undefined) state.lastToolResult = text(lastTool)
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
  // A short panel, so the thread scrolls: it must keep following the newest content when the taint line appears above it.
  await chat.setViewportSize({ width: 400, height: 600 })
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
  // The page read taints the conversation. With Auto approve on that is one slim, neutral
  // line (not the yellow banner); the full sentence is one click away.
  const taintLine = chat.getByTestId('taint-banner')
  await taintLine.waitFor({ timeout: 15_000 })
  // The line appeared above the thread during the turn: the thread still shows the newest message.
  const threadGap = () => chat.locator('.messages').evaluate(element => ({ gap: element.scrollHeight - element.scrollTop - element.clientHeight, overflow: element.scrollHeight - element.clientHeight }))
  await chat.getByText('AR1 done.', { exact: true }).waitFor()
  await chat.waitForTimeout(300)
  const afterLine = await threadGap()
  assert.ok(afterLine.overflow > 100, `the thread scrolls in the short panel (${afterLine.overflow} px)`)
  assert.ok(afterLine.gap <= 2, `the thread follows the newest message after the taint line appeared (${afterLine.gap} px from the bottom)`)
  assert.equal(await chat.locator('.scroll-to-bottom').count(), 0, 'no "Scroll to latest" after the taint line appeared')
  // Scrolling inside a nested scroll area (a step's details) does not stop the thread following.
  const lastStep = chat.locator('.step-timeline').last().locator('.timeline-step').first()
  await lastStep.locator('.timeline-step-head').click()
  const nested = lastStep.locator('.timeline-step-details pre').last()
  await nested.waitFor()
  const nestedRange = await nested.evaluate(element => element.scrollHeight - element.clientHeight)
  assert.ok(nestedRange > 40, `the step details scroll on their own (${nestedRange} px)`)
  await nested.hover()
  await chat.mouse.wheel(0, Math.min(nestedRange, 120))
  await chat.waitForTimeout(250)
  await chat.mouse.wheel(0, -Math.floor(Math.min(nestedRange, 120) / 2))
  await chat.waitForTimeout(400)
  await lastStep.locator('.timeline-step-head').click()
  results.push('the thread keeps following the newest message when the taint line appears above it mid-turn and after scrolling inside a step\'s details')
  const taintSummary = taintLine.locator('.taint-quiet-summary')
  assert.equal(await taintSummary.textContent(), 'Web pages read · shell and file tools paused')
  assert.match(await taintSummary.getAttribute('title'), new RegExp(`could contain instructions \\(${origin.replace(/^https?:\/\//u, '').replaceAll('.', '\\.')}\\)\\. Auto approve checks risky actions before they run; shell and file tools are off\\.`))
  assert.equal(await taintLine.getByRole('button', { name: 'Clear', exact: true }).count(), 1)
  // One line, at the panel's default width too.
  for (const width of [400, 360]) {
    await chat.setViewportSize({ width, height: 860 })
    const box = await taintLine.boundingBox()
    assert.ok(box !== null && box.height <= 32, `the taint line is one line at ${width} px (${box?.height} px tall)`)
  }
  // The header's connection status fits a narrow panel: its dot alone (the label for screen
  // readers and as its tooltip), never clipped, never over the title.
  for (const width of [360, 460]) {
    await chat.setViewportSize({ width, height: 860 })
    const header = await chat.evaluate(() => {
      const pill = document.querySelector('.connection')
      const label = pill.querySelector('.connection-label')
      return {
        pillRight: pill.getBoundingClientRect().right,
        titleLeft: document.querySelector('.session-menu-trigger').getBoundingClientRect().left,
        titleRight: document.querySelector('.session-menu-trigger').getBoundingClientRect().right,
        actionsLeft: document.querySelector('.topbar-actions').getBoundingClientRect().left,
        labelShown: label.getBoundingClientRect().width > 1,
        clipped: label.getBoundingClientRect().width > 1 && label.scrollWidth > label.clientWidth + 1,
        title: pill.getAttribute('title'),
        text: label.textContent,
      }
    })
    assert.ok(header.pillRight <= header.titleLeft, `the status pill stays clear of the title at ${width} px (${JSON.stringify(header)})`)
    assert.ok(header.titleRight <= header.actionsLeft, `the header buttons stay clear of the title at ${width} px (${JSON.stringify(header)})`)
    assert.equal(header.clipped, false, `the status label is not cut off at ${width} px`)
    assert.equal(header.labelShown, width >= 420, `the status shows its label only when it fits (${width} px)`)
    assert.equal(header.title, 'Connected')
    assert.equal(header.text, 'Connected')
    if (width === 360) await themedShots(chat, 'panel-header-narrow')
  }
  await chat.setViewportSize({ width: 400, height: 860 })
  await themedShots(chat, 'auto-approve-taint-line')
  await taintSummary.click()
  const taintDetails = chat.getByTestId('taint-details')
  await taintDetails.waitFor()
  assert.match(await taintDetails.textContent(), /could contain instructions/u)
  await themedShots(chat, 'auto-approve-taint-details')
  await taintSummary.click()
  await taintDetails.waitFor({ state: 'detached' })
  assert.equal(await taintSummary.getAttribute('aria-expanded'), 'false')
  // A special state still asks, in the same neutral style: with local pages exempt, the
  // unlisted local address gets its one question. Nothing is answered; the setting goes back.
  await settings({ taintExemptLocalPages: true, taintLocalOrigins: [] })
  const localQuestion = chat.getByTestId('taint-local-question')
  await localQuestion.waitFor({ timeout: 15_000 })
  assert.match(await localQuestion.textContent(), /Treat pages from 127\.0\.0\.1:\d+ as yours\?Yes, they are mine/u)
  await themedShots(chat, 'auto-approve-taint-local')
  await settings({ taintExemptLocalPages: false })
  await localQuestion.waitFor({ state: 'detached', timeout: 15_000 })
  results.push('with Auto approve on, the page read shows as one slim neutral line ("Web pages read · shell and file tools paused", Clear) with the full sentence one click away; the local-address question still shows')
  results.push('Auto approve on: navigate, click, type and a form submit ran with zero approval cards; only the submit was reviewed (silently, "Checking…" in the timeline), and the timeline marks every step Auto')

  // ---- 1b. A plain POST form whose submit navigates (303 to the saved page): the step is done, not "Failed" ----
  const saveLead = { name: 'browser_click', args: { selector: '#save' } }
  autoModel.setTurn('AR6', [
    { name: 'browser_navigate', args: { url: `${origin}/auto-review/lead` } },
    { name: 'browser_type', args: { selector: '#lead', text: 'Marta Okafor' } },
    saveLead,
  ])
  const cardsBeforeLead = await cardsSoFar()
  const savesBefore = leadSaves.length
  await chat.setViewportSize({ width: 400, height: 600 })
  // The timeline is updated in place: nothing in it is taken out of the page while the turn
  // runs or when the history is read again at its end (no blink, details and badges stay).
  await chat.evaluate(() => {
    globalThis.smokeTimelineRemovals = []
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof Element && (node.matches('.timeline-step, .decision-badge') || node.querySelector('.timeline-step, .decision-badge') !== null)) {
          globalThis.smokeTimelineRemovals.push(`${node.className}: ${String(node.textContent).slice(0, 60)}`)
        }
      }
    }).observe(document.querySelector('.messages'), { childList: true, subtree: true })
  })
  await send('AR6 Open the new lead form, type Marta Okafor as the name and save the lead.')
  await turnDone('AR6')
  await chat.waitForTimeout(1_500)
  assert.deepEqual(await chat.evaluate(() => globalThis.smokeTimelineRemovals), [], 'no timeline row or badge was taken out of the page (the history reload at the turn\'s end updates rows in place)')
  const afterLead = await threadGap()
  assert.ok(afterLead.gap <= 2, `the next turn is followed to its newest message (${afterLead.gap} px from the bottom)`)
  assert.equal(await chat.locator('.scroll-to-bottom').count(), 0)
  assert.equal(await cardsSoFar(), cardsBeforeLead, 'the navigating save showed no card')
  assert.deepEqual(leadSaves.slice(savesBefore), ['name=Marta+Okafor'], 'the lead was saved once')
  assert.equal(new URL(page.url()).pathname, '/auto-review/lead/saved')
  const leadSteps = chat.locator('.step-timeline').last().locator('.timeline-step')
  assert.equal(await leadSteps.count(), 3)
  const saveStep = leadSteps.nth(2)
  assert.equal(await saveStep.locator('.timeline-step-failed').count(), 0, 'the save step is not shown as Failed')
  assert.match(await saveStep.getAttribute('class'), /\bok\b/u, 'the save step is done')
  assert.match(autoModel.state.lastToolResult ?? '', /The page navigated to a new document/u, 'the agent is told the page navigated')
  await saveStep.scrollIntoViewIfNeeded()
  await themedShots(chat, 'auto-approve-post-submit-step')
  // Back to the trip notes page the next sections act on.
  await page.goto(`${autoPage}/contact`)
  await chat.setViewportSize({ width: 400, height: 860 })
  results.push('a click that submits a navigating POST form (303) is a done step, not "Failed", and the agent is told the page navigated')

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

  // ---- 6. Watch me under Auto approve: the user's click on "Do the remaining N" is their request ----
  // The series is one browser_run program (consequential: the reviewer sees it). The bridge tells
  // the reviewer, from its own record, that the user's real click in the panel started it.
  await toggle.click()
  await waitFor(async () => (await toggle.getAttribute('aria-pressed')) === 'true', 'Auto approve on again')
  const learningSetting = (watchMe) => chat.evaluate((value) => new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'dsh-learning' })
    port.onMessage.addListener((message) => { if (message.type === 'learning.result') { port.disconnect(); resolve(message.ok) } })
    port.postMessage({ type: 'learning.settings', id: 'watch-me-setting', settings: { watchMe: value } })
  }), watchMe)
  assert.equal(await learningSetting(true), true)
  // A clean start: what the earlier steps read is cleared by the user (the line's Clear).
  if (await taintLine.count() > 0) await taintLine.getByRole('button', { name: 'Clear', exact: true }).click()
  // The learning smoke's table, 16 rows: the user fills in and invites two, and the remaining
  // 14 rows (28 steps: type the email, click Invite) are longer than one browser_run (25 steps),
  // so they run as a series under one review. The series types into fields: the program's
  // approval answer is fixed text and does not taint (taint.ts CONTENT_FREE_TOOLS), so typing
  // on the page the user demonstrated on raises no taint card.
  const GUESTS = 16
  // Its own names: the learning smoke later checks which "Guest" rows were invited.
  const guestName = (index) => `Member ${String(index + 1).padStart(2, '0')}`
  await page.goto(`${origin}/learn?v=1&rows=${String(GUESTS)}&who=Member`)
  await page.bringToFront()
  await chat.waitForTimeout(1_700)
  await chat.getByRole('button', { name: 'Watch me', exact: true }).click()
  await chat.getByRole('button', { name: 'Stop watching', exact: true }).waitFor()
  // The user does two rows by hand.
  for (const index of [0, 1]) {
    await page.locator('#people input').nth(index).fill(guestName(index))
    await page.locator('.invite').nth(index).click()
  }
  const offer = chat.getByRole('button', { name: `Do the remaining ${String(GUESTS - 2)} like this (${String((GUESTS - 2) * 2)} steps)`, exact: true })
  await offer.waitFor({ timeout: 30_000 }).catch(async (error) => {
    throw new Error(`the Watch me offer did not appear; the panel shows: ${JSON.stringify(await chat.locator('.learning-panel').innerText().catch(() => 'no learning panel'))}`, { cause: error })
  })
  const cardsBeforeWatch = await cardsSoFar()
  const reviewsBeforeWatch = autoModel.state.reviews.length
  const dialogs = await chat.evaluate(() => {
    globalThis.smokeCardsSeen = 0
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('.approval-dialog') || node.querySelector('.approval-dialog') !== null)) globalThis.smokeCardsSeen += 1
      }
    }).observe(document.body, { childList: true, subtree: true })
    return document.querySelectorAll('.approval-dialog').length
  })
  assert.equal(dialogs, 0)
  // A real click on the panel's own button (not a message posted to the port).
  await offer.click()
  const invitedRows = () => page.locator('.invite').evaluateAll((buttons) => buttons.filter((button) => button.textContent === 'Invited').length)
  try {
    await waitFor(async () => await invitedRows() === GUESTS, 'every remaining row invited', 180_000)
  } catch (error) {
    const card = await panel.evaluate(() => messages.filter(message => message.type === 'approval.request').at(-1)?.request).catch(() => undefined)
    const evidence = {
      invited: await invitedRows().catch(() => 'unknown'),
      cardsSeen: await chat.evaluate(() => globalThis.smokeCardsSeen).catch(() => 'unknown'),
      card: card === undefined ? null : { action: card.action, summary: card.summary, note: card.autoReviewNote },
      reviews: autoModel.state.reviews.slice(reviewsBeforeWatch).map(review => ({ answer: review.answer, trusted: review.input.split('<untrusted_page_data')[0].slice(-900) })),
      learning: await chat.locator('.learning-panel').innerText().catch(() => 'none'),
      error: await chat.locator('.error, [role=alert]').allInnerTexts().catch(() => []),
    }
    throw new Error(`the Watch me run did not finish: ${JSON.stringify(evidence, null, 1)}`, { cause: error })
  }
  assert.equal(await chat.evaluate(() => globalThis.smokeCardsSeen), 0, 'no approval card appeared during the Watch me run')
  assert.deepEqual(await page.locator('#people input').evaluateAll((inputs) => inputs.map((input) => input.value)), Array.from({ length: GUESTS }, (_unused, index) => guestName(index)), 'every row got its own email typed')
  assert.equal(await cardsSoFar(), cardsBeforeWatch, 'the extension raised no card for the series')
  const watchReviews = autoModel.state.reviews.slice(reviewsBeforeWatch)
  assert.equal(watchReviews.length, 1, `the series was reviewed once (${watchReviews.length})`)
  const watchTrusted = watchReviews[0].input.split('<untrusted_page_data')[0]
  assert.match(watchTrusted, new RegExp(`USER_PANEL_ACTION \\(recorded by the browser bridge for this very action\\):\\nTRUSTED: The user clicked the offer to do the remaining rows like this in the browser panel for this program: ${String(GUESTS - 2)} rows, ${String((GUESTS - 2) * 2)} steps`, 'u'))
  assert.match(watchTrusted, /"tool": "browser_run"/u)
  assert.equal(watchReviews[0].answer.decision, 'allow')
  await learningSetting(false)
  results.push(`Watch me under Auto approve: a real click on "Do the remaining ${String(GUESTS - 2)} like this" ran the ${String((GUESTS - 2) * 2)}-step series of typing and clicks (more than one browser_run) with zero cards; the honest reviewer saw the bridge's TRUSTED line for that click and allowed it`)

  // The audit log records each review: decision, reason, model and binding.
  const reviews = (await audit()).filter(entry => entry.kind === 'auto-review')
  assert.ok(reviews.length >= 3, `auto-review audit entries (${reviews.length})`)
  assert.ok(reviews.every(entry => /^[0-9a-f]{64}$/u.test(entry.binding) && entry.model === `${AUTO_PROVIDER}/${AUTO_PROVIDER}`), 'each review records its binding and model')
  await chat.close()
  return taken
}
