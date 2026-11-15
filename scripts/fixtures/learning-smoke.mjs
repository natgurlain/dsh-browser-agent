// Real-browser coverage for the Phase 3 learning features: record → save as
// workflow → self-healing replay (ids changed between record and replay) →
// schedule list/cancel; failure fixtures + benchmark import; a learned site
// driver behind its forced approval card; and "Watch me" turning two real
// user repetitions into a one-card program.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Requests the fixture server saw. */
export const learningSubmissions = []
const csrf = `csrf-${randomUUID()}`
const PEOPLE = ['Ada', 'Grace', 'Linus']
const invited = []

/**
 * Fixture routes for the learning smoke (`/learn`, `/api/learn`, `/api/invite`).
 * @returns true when the request was handled.
 */
export function handleLearningRequest(request, response) {
  const url = new URL(request.url, 'http://fixture')
  if (url.pathname === '/api/learn' || url.pathname === '/api/invite') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const entry = { path: url.pathname, method: request.method, csrfOk: request.headers['x-csrf-token'] === csrf, body }
      if (url.pathname === '/api/invite') invited.push(JSON.parse(body).email)
      else learningSubmissions.push(entry)
      response.setHeader('content-type', 'application/json')
      response.statusCode = entry.csrfOk || url.pathname === '/api/invite' ? 200 : 403
      response.end(JSON.stringify({ ok: entry.csrfOk }))
    })
    return true
  }
  if (url.pathname !== '/learn') return false
  // v=1 records, v=2 renames every id (self-healing), v=3 makes "Save" ambiguous.
  const v = url.searchParams.get('v') ?? '1'
  const suffix = v === '1' ? '' : v
  response.setHeader('set-cookie', `csrftoken=${csrf}; Path=/`)
  response.end(`<!doctype html><title>Learn ${v}</title><meta name="csrf-token" content="${csrf}">
<body><h1>Contacts</h1>
<form onsubmit="return false">
  <input id="name${suffix}" aria-label="Name">
  <input id="pw${suffix}" type="password" aria-label="Password">
  <button id="save${suffix}" type="button">Save</button>
  ${v === '3' ? '<button id="save-copy" type="button">Save</button>' : ''}
</form>
<p id="status"></p>
<table id="people"><tbody>
${PEOPLE.map((person, index) => `<tr><td>${person}</td><td><input aria-label="Email ${String(index + 1)}"></td><td><button type="button" class="invite">Invite</button></td></tr>`).join('\n')}
</tbody></table>
<script>
  const cookie = () => document.cookie.split('; ').find(part => part.startsWith('csrftoken='))?.slice(10) ?? ''
  for (const button of document.querySelectorAll('form button')) button.addEventListener('click', async () => {
    const response = await fetch('/api/learn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': cookie() },
      body: JSON.stringify({ name: document.querySelector('form input[aria-label=Name]').value }) })
    document.querySelector('#status').textContent = response.ok ? 'saved' : 'refused'
  })
  for (const button of document.querySelectorAll('.invite')) button.addEventListener('click', async () => {
    const email = button.closest('tr').querySelector('input').value
    await fetch('/api/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
    button.textContent = 'Invited'
  })
</script></body>`)
  return true
}

/**
 * @param {object} ctx - handles from smoke-browser.mjs.
 */
export async function runLearningSmoke(ctx) {
  const { page, panel, origin, workspace, tool, succeed, settings, waitFor, delay, results, tabId, toolNames, root, knownSessions } = ctx
  const { importFixtures } = await import(pathToFileURL(join(root, 'benchmark/lib/fixture-tasks.mjs')).href)

  await settings({ unrestrictedBrowserAccess: true })
  await page.goto(`${origin}/learn?v=1`)
  await page.bringToFront()
  succeed(await tool('browser_follow_tab', { tabId }))
  await settings({ unrestrictedBrowserAccess: false, trustedActionOrigins: [origin], sharePageContent: 'auto' })

  // Learning port, as the side panel uses it.
  await panel.evaluate(() => {
    globalThis.learnMessages = []
    globalThis.learnPort = chrome.runtime.connect({ name: 'dsh-learning' })
    learnPort.onMessage.addListener(message => learnMessages.push(message))
  })
  const learn = async (type, body = {}) => {
    const id = await panel.evaluate(({ type, body }) => {
      const id = crypto.randomUUID()
      learnPort.postMessage({ type, id, ...body })
      return id
    }, { type, body })
    const answer = await waitFor(() => panel.evaluate(id => learnMessages.find(message => message.type === 'learning.result' && message.id === id), id), type)
    assert.equal(answer.ok, true, `${type}: ${JSON.stringify(answer.error)}`)
    return answer.result
  }
  const state = () => panel.evaluate(() => learnMessages.filter(message => message.type === 'learning.state').at(-1)?.state)
  await learn('learning.subscribe')

  // ---- Default off: nothing is offered or recorded ----
  const initial = await waitFor(state, 'learning state')
  assert.deepEqual(initial.settings, { workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false })
  assert.equal((await toolNames()).includes('browser_workflow_run'), false)
  succeed(await tool('browser_type', { selector: '#name', text: 'Nobody', replace: true }))
  await delay(300)
  assert.deepEqual((await state()).steps, [])
  results.push('learning features are all off by default: no workflow tools, nothing recorded')

  // ---- 3.8 record → save → self-healing replay ----
  await learn('learning.settings', { settings: { workflows: true, fixtures: true } })
  await waitFor(async () => (await toolNames()).includes('browser_workflow_run'), 'workflow tools registered')
  succeed(await tool('browser_type', { selector: '#name', text: 'Ada', replace: true }))
  succeed(await tool('browser_type', { selector: '#pw', text: 'hunter2-secret', replace: true }))
  succeed(await tool('browser_click', { selector: '#save' }))
  await waitFor(() => learningSubmissions.some(entry => entry.body.includes('Ada')), 'recorded run submission')
  const recorded = await waitFor(async () => { const current = await state(); return current.steps.length === 3 ? current : undefined }, 'three recorded steps')
  assert.equal(JSON.stringify(recorded).includes('hunter2'), false, 'a sensitive value never leaves the page into the recorder')
  assert.deepEqual(recorded.steps.map(step => [step.tool, step.locator?.role, step.locator?.name, step.sensitive === true]), [
    ['browser_type', 'textbox', 'Name', false], ['browser_type', 'textbox', 'Password', true], ['browser_click', 'button', 'Save', false],
  ])
  const saved = await learn('learning.workflow.save', { choices: { name: 'Smoke login', variables: { [recorded.steps[0].id]: 'person' } } })
  assert.equal(saved.relativePath, 'browser-workflows/smoke-login.workflow.json')
  const file = await readFile(join(workspace, saved.relativePath), 'utf8')
  assert.equal(file.includes('hunter2'), false)
  assert.equal(/"index"|"selector"/u.test(file), false)
  assert.match(file, /"text": "\{\{password\}\}"/u)
  results.push('Save as workflow writes robust locators and variables to the session workspace and never the sensitive value')

  await page.goto(`${origin}/learn?v=2`)
  const before = learningSubmissions.length
  const replay = succeed(await tool('browser_workflow_run', { name: 'smoke-login', params: { person: 'Grace', password: 's3cret-two' } }))
  assert.match(replay, /completed: 3 step\(s\) replayed/u, replay)
  assert.match(replay, /found by role-name/u)
  await waitFor(() => learningSubmissions.length > before && learningSubmissions.at(-1).body.includes('Grace'), 'replayed submission')
  assert.equal(await page.inputValue('#pw2'), 's3cret-two')
  await page.goto(`${origin}/learn?v=3`)
  const ambiguous = succeed(await tool('browser_workflow_run', { name: 'smoke-login', params: { person: 'Linus', password: 'x' } }))
  assert.match(ambiguous, /stopped at step 3 of 3/u, ambiguous)
  assert.match(ambiguous, /fromStep: 3/u)
  results.push('workflow replay re-finds renamed elements by role and name, and stops for the model when a step is ambiguous')

  // Scheduling targets an owned session (the panel conversation shares this workspace).
  const sessionId = knownSessions[0]
  const created = await learn('learning.schedule.create', { sessionId, workflow: 'smoke-login', timing: { kind: 'every', every_seconds: 3600 }, params: { person: 'Ada' } }).catch(error => error)
  if (created instanceof Error) {
    // A workflow with a sensitive input cannot run unattended; that refusal is the contract.
    assert.match(created.message, /sensitive field/u)
  } else {
    assert.fail('a workflow with a sensitive input must not be schedulable')
  }
  await page.goto(`${origin}/learn?v=1`)
  await learn('learning.steps.clear')
  succeed(await tool('browser_type', { selector: '#name', text: 'Scheduled', replace: true }))
  await waitFor(async () => (await state()).steps.length === 1, 'one recorded step')
  await learn('learning.workflow.save', { choices: { name: 'smoke-fill' } })
  const schedule = await learn('learning.schedule.create', { sessionId, workflow: 'smoke-fill', timing: { kind: 'every', every_seconds: 3600 } })
  assert.equal(schedule.sessionId, sessionId)
  assert.deepEqual((await learn('learning.schedule.list', { sessionId })).schedules.map(entry => entry.id), [schedule.id])
  await learn('learning.schedule.cancel', { scheduleId: schedule.id })
  assert.deepEqual((await learn('learning.schedule.list', { sessionId })).schedules, [])
  results.push('workflows are scheduled into their owning session through ctx.schedule, listed, and cancelled; sensitive workflows refuse unattended runs')

  // ---- 3.9 failure flywheel ----
  await page.fill('#pw', 'typed-by-user-secret')
  const missing = await tool('browser_click', { selector: '#does-not-exist' })
  assert.equal(missing.isError, true)
  const fixtureDir = join(workspace, 'browser-fixtures')
  const metaFile = await waitFor(async () => (await readdir(fixtureDir).catch(() => [])).find(name => name.endsWith('.json')), 'failure fixture')
  const meta = JSON.parse(await readFile(join(fixtureDir, metaFile), 'utf8'))
  assert.equal(meta.failure, 'not-found')
  assert.equal(meta.page.kind, 'dom')
  const captured = await readFile(join(fixtureDir, meta.page.file), 'utf8')
  assert.equal(captured.includes('typed-by-user-secret'), false)
  assert.match(captured, /data-dsh-masked="true"/u)
  assert.equal(captured.includes('<script'), false)
  const imported = await importFixtures(fixtureDir, join(workspace, 'fixture-tasks'))
  assert.equal(imported.imported.length, 1)
  results.push('a failed step leaves a sanitized fixture in the workspace that import-fixtures turns into a benchmark task')

  // ---- 3.6 site drivers ----
  await settings({ allowDevTools: true })
  await learn('learning.settings', { settings: { siteDrivers: true, siteDriverOrigins: [origin] } })
  await page.goto(`${origin}/learn?v=1`)
  await delay(500)
  succeed(await tool('browser_type', { selector: '#name', text: 'Driver Ada', replace: true }))
  succeed(await tool('browser_click', { selector: '#save' }))
  const proposed = await waitFor(async () => (await state()).proposals[0], 'site driver proposal', 30_000)
  assert.equal(proposed.driver.method, 'POST')
  assert.equal(proposed.driver.path, '/api/learn')
  assert.deepEqual(proposed.driver.tokens, [{ header: 'x-csrf-token', source: { kind: 'cookie', name: 'csrftoken' } }])
  assert.equal(JSON.stringify(proposed).includes(csrf), false, 'the token value is never stored')
  await learn('learning.driver.save', { index: 0 })
  const driverTool = (await waitFor(async () => (await toolNames()).find(name => name.startsWith('site_') && name.endsWith('_post_learn')), 'driver tool'))
  await panel.evaluate(() => { messages = messages.filter(message => message.type !== 'approval.request') })
  const driverCall = tool(driverTool, { name: 'Via Driver' })
  const card = await waitFor(() => panel.evaluate(() => messages.find(message => message.type === 'approval.request')?.request), 'site driver card')
  assert.equal(card.action, 'browser_site_driver')
  assert.equal(card.forced, true)
  assert.ok(JSON.stringify(card.details).includes(`POST ${origin}/api/learn`))
  assert.equal(JSON.stringify(card).includes(csrf), false)
  await panel.evaluate(id => { messages = messages.filter(message => message.type !== 'approval.request'); panelPort.postMessage({ type: 'approval.response', id, decision: 'allow-once' }) }, card.id)
  const driverText = succeed(await driverCall)
  assert.match(driverText, /HTTP 200/u)
  const viaDriver = learningSubmissions.find(entry => entry.body.includes('Via Driver'))
  assert.equal(viaDriver?.csrfOk, true, 'the CSRF token was read from the page at execution time')
  const exported = await learn('learning.driver.export')
  assert.equal(JSON.parse(exported).drivers.length, 1)
  results.push('a site driver is proposed from captured traffic, saved only on approval, registered as a tool, and runs behind a forced card with the exact request')

  // ---- 3.7 Watch me ----
  await learn('learning.settings', { settings: { siteDrivers: false, watchMe: true } })
  await settings({ trustedActionOrigins: [] })
  await page.goto(`${origin}/learn?v=1`)
  await page.bringToFront()
  await delay(1_700)
  await learn('learning.watch.start')
  for (const [index, person] of PEOPLE.slice(0, 2).entries()) {
    await page.locator('#people input').nth(index).fill(person)
    await page.locator('.invite').nth(index).click()
  }
  const suggestion = await waitFor(async () => (await state()).suggestion ?? undefined, 'watch-me suggestion')
  assert.equal(suggestion.remaining, 1)
  assert.equal(suggestion.program.length, 2)
  await panel.evaluate(() => { messages = messages.filter(message => message.type !== 'approval.request') })
  const run = learn('learning.watch.run')
  const programCard = await waitFor(() => panel.evaluate(() => messages.find(message => message.type === 'approval.request')?.request), 'program card')
  assert.equal(programCard.action, 'browser_program')
  await panel.evaluate(id => { messages = messages.filter(message => message.type !== 'approval.request'); panelPort.postMessage({ type: 'approval.response', id, decision: 'allow-once' }) }, programCard.id)
  const outcome = await run
  assert.equal(outcome.report.status, 'completed', JSON.stringify(outcome))
  await waitFor(() => invited.includes('Linus'), 'remaining row done by the program')
  assert.equal(await panel.evaluate(() => messages.some(message => message.type === 'approval.request')), false, 'one card covered the program')
  results.push('Watch me learns two real repetitions over table rows and does the remaining row after a single program card')

  // ---- Off again: tools withdrawn ----
  await learn('learning.settings', { settings: { workflows: false, fixtures: false, watchMe: false, siteDrivers: false } })
  await waitFor(async () => !(await toolNames()).some(name => name === 'browser_workflow_run' || name.startsWith('site_')), 'learning tools withdrawn')
  await settings({ trustedActionOrigins: [origin] })
  await panel.evaluate(() => learnPort.disconnect())
}
