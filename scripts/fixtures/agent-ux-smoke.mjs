// Real-browser coverage for "show the agent on the page", the step timeline
// with its audit log, and pause / take over / resume. Screenshots of every new
// surface land in <evidence>/screenshots for visual review.
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {object} ctx - handles from smoke-browser.mjs.
 * @returns {Promise<string[]>} screenshot paths.
 */
export async function runAgentUxSmoke(ctx) {
  const {
    browser, page, panel, extensionId, directory, origin, bridge, env, downloadDirectory,
    tool, succeed, settings, waitFor, hostRpc, bridgeRpc, scripted, knownSessions, results, delay,
  } = ctx
  const { verifyAuditChain, verifyAuditHead, parseAuditLines } = await import(pathToFileURL(join(bridge, 'src/audit-log.ts')).href)
  const shots = join(directory, 'screenshots')
  await mkdir(shots, { recursive: true })
  const taken = []
  const shot = async (target, name, options = {}) => {
    const path = join(shots, name)
    await target.screenshot({ path, ...options })
    taken.push(path)
    return path
  }

  await settings({ unrestrictedBrowserAccess: false, trustedActionOrigins: [origin], sharePageContent: 'auto', showAgentOverlay: true })
  await page.bringToFront()

  // ---- 2.5: the agent is visible on the page, from a closed shadow root ----
  succeed(await tool('browser_snapshot', {}))
  succeed(await tool('browser_hover', { selector: '#hoverTarget' }))
  // Clip to the viewport: an attached debugger's info bar can make full-page captures repeat.
  const viewport = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }))
  await shot(page, 'overlay-ghost-cursor-and-pill.png', { clip: viewport })
  const hosts = await page.evaluate(() => [...document.documentElement.children]
    .filter(element => element.tagName === 'DIV')
    .map(element => ({ closed: element.shadowRoot === null, pointerEvents: getComputedStyle(element).pointerEvents, text: element.textContent })))
  assert.deepEqual(hosts, [{ closed: true, pointerEvents: 'none', text: '' }])
  assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('AI controlling')), false)
  // Turning the setting off removes the frame and pill.
  await settings({ showAgentOverlay: false })
  succeed(await tool('browser_hover', { selector: '#dragSource' }))
  await shot(page, 'overlay-disabled.png', { clip: viewport })
  await settings({ showAgentOverlay: true })
  results.push('the on-page agent overlay lives in one closed, pointer-transparent shadow host and follows its setting')

  // ---- A real Agent session driven by a scripted model ----
  const chat = await browser.newPage()
  await chat.setViewportSize({ width: 420, height: 860 })
  await chat.goto(`chrome-extension://${extensionId}/panel/index.html`)
  await page.bringToFront()
  const composer = chat.locator('textarea')
  await waitFor(() => composer.isEnabled(), 'timeline panel readiness')
  // The default model cannot connect; that first turn just materializes the session.
  await composer.fill('Warm up this conversation.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  await chat.getByRole('button', { name: 'Continue generating', exact: true }).waitFor({ timeout: 30_000 })
  const session = (await bridgeRpc('session.list', {})).items.find(item => !item.blank && !knownSessions.includes(item.sessionId))
  assert.ok(session, 'timeline session')
  await hostRpc('session', 'selectModel', { sessionId: session.sessionId, provider: 'scripted-check', model: 'scripted-check' })
  await waitFor(async () => (await chat.locator('.composer-model > button').textContent()).includes('scripted-check'), 'scripted model selected')

  // ---- 2.7: pause after this step, take over, resume from the page banner ----
  await panel.evaluate(() => { messages = messages.filter(message => message.type !== 'agent.pause-state') })
  await composer.fill('Hover the target, then take a screenshot.')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  // What a failure of the pause steps needs: every model request (a second one
  // that carries a tool result means the first step ran; one that carries none
  // is a retry), and the pause states the extension reported, in order.
  const pauseEvidence = async () => JSON.stringify({
    modelRequests: scripted.state.log,
    pauseStates: await panel.evaluate(() => messages.filter(message => message.type === 'agent.pause-state')
      .map(message => `${message.state.mode}:held=${message.state.held.map(call => call.name).join(',')}`)).catch(cause => `unavailable: ${cause.message}`),
  }, null, 2)
  // The scripted model does not answer its first request until it is released
  // below: the turn is running, and no browser step has been asked for yet.
  const pauseButton = chat.getByRole('button', { name: 'Pause after this step', exact: true })
  await pauseButton.waitFor()
  await shot(chat, 'panel-running-controls.png')
  await pauseButton.click()
  await chat.getByText('Paused', { exact: true }).waitFor()
  // Paused for certain (the extension said so) before the model asks for its
  // first step. A fixed "thinking" time used to stand in for this, and a slow
  // machine let the first step run before the click: the second step was then
  // the one held, after two model requests.
  await waitFor(() => panel.evaluate(() => messages.some(message => message.type === 'agent.pause-state' && message.state.mode === 'paused')),
    'the extension acknowledged the pause')
  scripted.release('paused')
  await waitFor(() => panel.evaluate(() => messages.some(message => message.type === 'agent.pause-state' && message.state.held.length === 1)), 'held agent step', 20_000)
  await chat.getByText('1 browser action is waiting for you.', { exact: true }).waitFor()
  await shot(chat, 'panel-paused-after-step.png')
  await delay(400)
  assert.deepEqual(
    await panel.evaluate(() => messages.findLast(message => message.type === 'agent.pause-state').state.held.map(call => call.name)),
    ['browser_click'], `the first step is the one held\n${await pauseEvidence()}`)
  assert.equal(scripted.state.requests, 1, `the model is waiting on its held step, not retrying\n${await pauseEvidence()}`)
  await chat.getByRole('button', { name: 'Take over', exact: true }).click()
  await chat.getByText("You're in control", { exact: true }).waitFor()
  const resumeButton = await waitFor(() => shadowButtonCenter(page, 'resume'), 'takeover banner on the page')
  await shot(page, 'overlay-takeover-banner.png', { clip: viewport })
  await shot(chat, 'panel-takeover-controls.png')
  // The user changes the page while in control; the agent hears about it on resume.
  await page.evaluate(() => { document.title = 'Edited while the user was in control' })
  // A real (trusted) click on the page banner's Resume, inside the closed shadow
  // root. It is not authoritative (the page could fake a lookalike): it only
  // brings up the panel, whose own Resume confirms.
  // Record the panel opening instead of opening a real side panel (one would
  // stay connected and take later panel-free approvals).
  const worker = browser.serviceWorkers()[0]
  await worker.evaluate(() => {
    globalThis.smokePanelOpens = 0
    chrome.sidePanel.open = async () => { globalThis.smokePanelOpens += 1 }
  })
  await page.mouse.click(resumeButton.x, resumeButton.y)
  await waitFor(() => worker.evaluate(() => globalThis.smokePanelOpens > 0 || undefined), 'the page banner opens the panel')
  assert.equal(await panel.evaluate(() => messages.filter(message => message.type === 'agent.pause-state').at(-1)?.state.mode), 'taken-over', 'the page banner alone does not resume')
  await chat.getByRole('button', { name: 'Resume', exact: true }).click()
  try {
    // The screenshot is a read the user approves on the panel's own card.
    await chat.getByRole('button', { name: 'Allow once', exact: true }).click({ timeout: 30_000 })
    await chat.getByText('Timeline smoke done.', { exact: true }).waitFor({ timeout: 30_000 })
  } catch (error) {
    await shot(chat, 'debug-timeline-failure.png').catch(() => {})
    const pauseLog = await panel.evaluate(() => messages.filter(message => message.type === 'agent.pause-state').map(message => message.state.mode))
    const history = await bridgeRpc('session.history', { sessionId: session.sessionId }).catch(cause => ({ events: [], cause: String(cause) }))
    const toolEvents = history.events.map(({ event }) => event).filter(event => event.type.startsWith('tool/'))
      .map(event => ({ type: event.type, callId: event.data.callId ?? event.data.message?.callId, isError: event.data.message?.isError }))
    throw new Error(`timeline run did not finish: ${JSON.stringify({ model: scripted.state.requests, pauseLog, toolEvents, types: history.events.map(({ event }) => event.type), rows: await chat.locator('.messages').innerText() })}`, { cause: error })
  }
  assert.equal(scripted.state.sawResumeContext, true, 'the resume delta reached the model')
  results.push('pause after this step and take over hold the agent\'s next step as pending; the page banner\'s Resume opens the panel, whose Resume injects what changed, then runs it')

  // ---- 2.6: the step timeline, with audit decisions and a screenshot thumbnail ----
  await waitFor(async () => await chat.locator('.timeline-step.ok').count() === 2, 'two completed timeline steps')
  await waitFor(async () => await chat.locator('.decision-badge').count() === 2, 'audit decision badges')
  await chat.locator('.timeline-step-thumb img').first().waitFor({ timeout: 15_000 })
  // The click passed the trusted-site rule without a card; the screenshot was approved on one.
  // Read once the list has settled: the timeline is drawn again when the screenshot's
  // thumbnail arrives, and a single read in that moment can see no rows at all.
  const badges = await waitFor(async () => {
    const texts = await chat.locator('.decision-badge').allTextContents()
    return texts.length === 2 ? texts : undefined
  }, 'both audit decision badges after the thumbnail loaded')
  assert.deepEqual(badges, ['Trusted', 'Approved'])
  await shot(chat, 'panel-step-timeline.png')
  await chat.locator('.timeline-step-head').first().click()
  await chat.locator('.timeline-step-details').first().waitFor()
  await shot(chat, 'panel-step-expanded.png')
  results.push('the panel shows one timeline row per step with target, duration, decision badge, details, and a screenshot thumbnail')

  // ---- Audit log: export from Settings, verify the chain, private files ----
  await chat.getByRole('button', { name: 'Open settings', exact: true }).click()
  const exportButton = chat.getByRole('button', { name: 'Export audit log', exact: true })
  await exportButton.scrollIntoViewIfNeeded()
  const before = new Set(await readdir(downloadDirectory))
  await exportButton.click()
  const exportedName = await waitFor(async () => (await readdir(downloadDirectory))
    .find(name => !before.has(name) && /^dsh-browser-audit-.*\.json$/u.test(name)), 'audit export download')
  const exported = JSON.parse(await readFile(join(downloadDirectory, exportedName), 'utf8'))
  await chat.locator('.audit-export-status').waitFor()
  await chat.locator('.audit-export').scrollIntoViewIfNeeded()
  await shot(chat, 'panel-settings-audit-export.png')
  assert.equal(exported.format, 'dsh-browser-audit/v1')
  assert.equal(exported.sessionId, session.sessionId)
  assert.deepEqual(exported.verification, { ok: true, count: exported.entries.length })
  const kinds = exported.entries.map(entry => entry.kind)
  for (const kind of ['tool-call', 'approval', 'result']) assert.ok(kinds.includes(kind), `${kind} in ${kinds}`)
  assert.ok(exported.entries.filter(entry => entry.kind !== 'kill-switch').every(entry => typeof entry.toolCallId === 'string'))
  assert.deepEqual(exported.entries.filter(entry => entry.kind === 'approval').map(entry => entry.tool), ['browser_click', 'browser_screenshot'])
  assert.ok(exported.entries.some(entry => entry.kind === 'approval' && entry.durationMs >= 400), 'hold time recorded')
  const home = env.DSH_HOME
  const file = join(home, 'browser-audit', `s-${session.sessionId}.jsonl`)
  // The chain is keyed (HMAC) with the bridge's private key file, and its head is anchored.
  const key = Buffer.from((await readFile(join(home, 'browser-audit', '.chain-key'), 'utf8')).trim(), 'hex')
  assert.equal((await stat(join(home, 'browser-audit', '.chain-key'))).mode & 0o777, 0o600)
  const lines = parseAuditLines(await readFile(file, 'utf8'))
  assert.equal(verifyAuditChain(lines).ok, false, 'a keyed chain does not verify without its key')
  const chain = verifyAuditChain(lines, key)
  assert.equal(chain.ok, true)
  assert.equal(verifyAuditHead(file, lines, chain, await readFile(`${file}.head`, 'utf8'), key).ok, true)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(join(home, 'browser-audit'))).mode & 0o777, 0o700)
  const unscoped = parseAuditLines(await readFile(join(home, 'browser-audit', 'unscoped.jsonl'), 'utf8'))
  assert.equal(verifyAuditChain(unscoped, key).ok, true)
  assert.ok(unscoped.length > 50, 'the probe\'s agentless calls are audited too')
  await chat.getByRole('button', { name: 'Cancel', exact: true }).click().catch(() => {})
  results.push('every call is in a 0600 hash-chained audit log the panel exports and the chain verifies')
  await chat.close()
  return taken
}

/**
 * Center of a button inside the overlay's closed shadow root. Page scripts
 * cannot see it; the DevTools protocol can (pierce), which is how a real
 * user click is aimed at it.
 */
async function shadowButtonCenter(page, className) {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const find = node => {
      const attributes = node.attributes ?? []
      for (let index = 0; index < attributes.length; index += 2) {
        if (node.nodeName === 'BUTTON' && attributes[index] === 'class' && attributes[index + 1].split(' ').includes(className)) return node
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    const node = find(root)
    if (node === undefined) return undefined
    const box = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => undefined)
    const quad = box?.model?.content
    if (quad === undefined || box.model.width === 0) return undefined
    return { x: (quad[0] + quad[4]) / 2, y: (quad[1] + quad[5]) / 2 }
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/**
 * After the kill-switch section reconnected: a real click on the page pill's
 * Stop engages the kill switch, every engagement is in the audit log, and no
 * typed dialog answer ever reached it.
 */
export async function assertKillSwitchAudited({ env, bridge, page, panel, waitFor, delay }) {
  const { verifyAuditChain, parseAuditLines } = await import(pathToFileURL(join(bridge, 'src/audit-log.ts')).href)
  const key = Buffer.from((await readFile(join(env.DSH_HOME, 'browser-audit', '.chain-key'), 'utf8')).trim(), 'hex')
  // Let the pill's buttons leave the window in which agent actions make them inert.
  await delay(4_500)
  const stop = await waitFor(() => shadowButtonCenter(page, 'stop'), 'controlled-tab pill')
  await panel.evaluate(() => { messages = messages.filter(message => message.type !== 'status') })
  await page.mouse.click(stop.x, stop.y)
  await waitFor(() => panel.evaluate(() => messages.some(message => message.type === 'status' && message.killSwitch === true)), 'kill switch from the page pill')
  await panel.evaluate(() => { panelPort.postMessage({ type: 'kill-switch.release' }) })
  await waitFor(() => panel.evaluate(() => messages.some(message => message.type === 'status' && message.state === 'connected')), 'reconnect after the pill kill switch')
  const raw = await readFile(join(env.DSH_HOME, 'browser-audit', 'unscoped.jsonl'), 'utf8')
  const entries = parseAuditLines(raw)
  assert.equal(verifyAuditChain(entries, key).ok, true)
  assert.ok(entries.filter(entry => entry.kind === 'kill-switch').length >= 2, 'both kill switches recorded')
  // The smoke answered a prompt() dialog with "Ada"; only its length may be kept.
  assert.doesNotMatch(raw, /Ada/u)
}
