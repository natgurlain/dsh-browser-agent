// Real-browser coverage for Phase 3 agent execution: browser_run programs
// (one card for the whole program, forced cards still per step, guards, kill
// switch between steps, per-step audit entries).
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUN_FIXTURE = () => {
  document.body.insertAdjacentHTML('beforeend', `<section id="runFixture" style="position:absolute;left:600px;top:60px;width:400px">
    <input id="runQ" aria-label="Search terms" style="width:200px"><button id="runGo">Search</button>
    <button id="runCount">Count</button><p id="runOut"></p></section>`)
  window.runClicks = 0
  document.querySelector('#runGo').addEventListener('click', () => {
    document.querySelector('#runOut').textContent = `Results for ${document.querySelector('#runQ').value}`
  })
  document.querySelector('#runCount').addEventListener('click', () => { window.runClicks += 1 })
}

/**
 * @param {object} ctx - handles from smoke-browser.mjs.
 * @returns {Promise<string[]>} screenshot paths.
 */
export async function runPhase3Smoke(ctx) {
  const { browser, page, panel, extensionId, directory, origin, bridge, env, tool, succeed, settings, waitFor, results, delay } = ctx
  const { verifyAuditChain, parseAuditLines } = await import(pathToFileURL(join(bridge, 'src/audit-log.ts')).href)
  const shots = join(directory, 'screenshots')
  await mkdir(shots, { recursive: true })
  const taken = []
  const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const clearApprovals = () => panel.evaluate(() => { messages = messages.filter(message => message.type !== 'approval.request' && message.type !== 'approval.resolved') })
  const approvalCount = () => panel.evaluate(() => messages.filter(message => message.type === 'approval.request').length)
  /** Answer the next not-yet-answered card; returns its request. */
  const answerNext = async (decision, seen) => {
    const request = await waitFor(() => panel.evaluate(seen => messages
      .filter(message => message.type === 'approval.request')
      .map(message => message.request)
      .find(request => !seen.includes(request.id)), seen), 'next approval card')
    seen.push(request.id)
    await panel.evaluate(({ id, decision }) => { panelPort.postMessage({ type: 'approval.response', id, decision }) }, { id: request.id, decision })
    return request
  }

  await settings({ unrestrictedBrowserAccess: false, trustedActionOrigins: [], sharePageContent: 'auto', siteRules: [], strictSites: [] })
  await page.goto(`${origin}/reliability`)
  await page.evaluate(RUN_FIXTURE)
  await page.bringToFront()
  succeed(await tool('browser_snapshot', {}))

  // ---- 3.1: one card for the whole program; ordinary steps run without more cards ----
  const chat = await browser.newPage()
  await chat.setViewportSize({ width: 420, height: 860 })
  await chat.goto(`chrome-extension://${extensionId}/panel/index.html`)
  await page.bringToFront()
  await clearApprovals()
  const program = [
    { tool: 'browser_type', args: { selector: '#runQ', text: 'wool socks', replace: true }, expect: { value: { selector: '#runQ', equals: 'wool socks' } } },
    { tool: 'browser_click', args: { selector: '#runGo' }, expect: { text: 'Results for wool socks' } },
    { tool: 'browser_click', args: { selector: '#runCount' } },
  ]
  const pending = tool('browser_run', { steps: program })
  const card = await waitFor(() => panel.evaluate(() => messages.find(message => message.type === 'approval.request')?.request), 'program card')
  assert.equal(card.action, 'browser_run')
  assert.equal(card.details.length, 3)
  assert.deepEqual(card.details.map(detail => detail.label), ['Step 1: browser_type', 'Step 2: browser_click', 'Step 3: browser_click'])
  assert.match(card.details[0].value, /"text": "wool socks"/)
  assert.match(card.details[0].value, /"equals": "wool socks"/)
  assert.ok(typeof card.binding === 'string' && card.binding.length === 64)
  await chat.bringToFront()
  await chat.locator('.approval-dialog').waitFor({ timeout: 15_000 }).catch(() => {})
  const cardShot = join(shots, 'phase3-run-program-card.png')
  await chat.screenshot({ path: cardShot })
  taken.push(cardShot)
  await page.bringToFront()
  await panel.evaluate(id => { panelPort.postMessage({ type: 'approval.response', id, decision: 'allow-once' }) }, card.id)
  const ran = succeed(await pending)
  assert.match(ran, /Program completed: 3 of 3 steps ran/)
  assert.match(ran, /expect met/)
  assert.match(ran, /Page changes at the stop point/)
  assert.equal(await approvalCount(), 1, 'ordinary steps ran under the program card without cards of their own')
  assert.equal(await page.evaluate(() => document.querySelector('#runOut').textContent), 'Results for wool socks')
  assert.equal(await page.evaluate(() => window.runClicks), 1)
  results.push('browser_run: one card shows every step\'s full payload; approved ordinary steps run back to back with guards met')

  // ---- A failed guard stops the program before the next step ----
  await clearApprovals()
  const guarded = tool('browser_run', { steps: [
    { tool: 'browser_click', args: { selector: '#runCount' }, expect: { text: 'text that never appears', timeoutMs: 600 } },
    { tool: 'browser_click', args: { selector: '#runCount' } },
  ] })
  const guardCard = await waitFor(() => panel.evaluate(() => messages.find(message => message.type === 'approval.request')?.request), 'guarded program card')
  await panel.evaluate(id => { panelPort.postMessage({ type: 'approval.response', id, decision: 'allow-once' }) }, guardCard.id)
  const stopped = succeed(await guarded)
  assert.match(stopped, /guard after step 1 of 2 failed/)
  assert.match(stopped, /expect NOT met: .*text that never appears/)
  assert.equal(await page.evaluate(() => window.runClicks), 2, 'step 2 never ran')
  results.push('browser_run stops at the first failed expect and reports the page delta at the stop point')

  // ---- Site policy "ask": every protected step still gets its own forced card ----
  await settings({ siteRules: [{ pattern: '127.0.0.1', rule: 'ask' }] })
  await clearApprovals()
  const seen = []
  const asked = tool('browser_run', { steps: [
    { tool: 'browser_click', args: { selector: '#runCount' } },
    { tool: 'browser_click', args: { selector: '#runCount' } },
  ] })
  const programCard = await answerNext('allow-once', seen)
  assert.equal(programCard.action, 'browser_run')
  const firstStep = await answerNext('allow-once', seen)
  assert.equal(firstStep.forced, true, 'a site "ask" rule is never pre-approved by the program card')
  assert.equal(firstStep.action, 'browser_click')
  const secondStep = await answerNext('deny', seen)
  assert.equal(secondStep.forced, true)
  // The stop-point snapshot is a read, which the "ask" rule also protects.
  const deltaRead = await answerNext('deny', seen)
  assert.equal(deltaRead.kind, 'read')
  const askedText = succeed(await asked)
  assert.match(askedText, /stopped by an error after 2 of 2 steps/)
  assert.equal(await page.evaluate(() => window.runClicks), 3, 'the approved step ran, the denied one did not')
  await settings({ siteRules: [] })
  results.push('browser_run never pre-approves policy-forced steps: a site "ask" rule still shows each step\'s own card')

  // ---- Kill switch between steps ----
  await clearApprovals()
  const clicksBefore = await page.evaluate(() => window.runClicks)
  await panel.evaluate(() => { messages = messages.filter(message => message.type !== 'status') })
  const killed = tool('browser_run', { steps: [
    { tool: 'browser_wait', args: { ms: 2_500 } },
    { tool: 'browser_click', args: { selector: '#runCount' } },
  ] })
  const killCard = await waitFor(() => panel.evaluate(() => messages.find(message => message.type === 'approval.request')?.request), 'program card before kill')
  await panel.evaluate(id => { panelPort.postMessage({ type: 'approval.response', id, decision: 'allow-once' }) }, killCard.id)
  await delay(800)
  await panel.evaluate(() => { panelPort.postMessage({ type: 'kill-switch.engage' }) })
  const killedText = text(await killed)
  assert.match(killedText, /stopped|cancelled|FAILED/i, killedText)
  assert.equal(await page.evaluate(() => window.runClicks), clicksBefore, 'nothing ran after the kill switch')
  await panel.evaluate(() => { panelPort.postMessage({ type: 'kill-switch.release' }) })
  await waitFor(() => panel.evaluate(() => messages.some(message => message.type === 'status' && message.state === 'connected')), 'reconnect after the kill switch')
  await waitFor(async () => !(await tool('browser_snapshot', {})).isError, 'tools after reconnect', 30_000)
  results.push('the kill switch stops a running program between steps')

  // ---- Audit: each step is its own entry, tagged with the program ----
  const unscoped = parseAuditLines(await readFile(join(env.DSH_HOME, 'browser-audit', 'unscoped.jsonl'), 'utf8'))
  assert.equal(verifyAuditChain(unscoped).ok, true)
  const stepCalls = unscoped.filter(entry => entry.kind === 'tool-call' && entry.program !== undefined)
  assert.ok(stepCalls.length >= 7, `program steps in the audit log: ${stepCalls.length}`)
  const programId = stepCalls[0].program.id
  assert.deepEqual(stepCalls.filter(entry => entry.program.id === programId).map(entry => [entry.program.step, entry.tool]),
    [[0, 'browser_type'], [1, 'browser_click'], [2, 'browser_click']])
  assert.equal(unscoped.find(entry => entry.kind === 'tool-call' && entry.callId === programId)?.tool, 'browser_run')
  const covered = unscoped.filter(entry => entry.kind === 'approval' && entry.decision === 'program-approved')
  assert.ok(covered.length >= 3, 'steps covered by the program card are audited as program-approved')
  results.push('the audit log records the program call and every step (tool, program id, step number, decision) in the hash chain')
  await chat.close()
  return taken
}
