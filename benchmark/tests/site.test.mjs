import test from 'node:test'
import assert from 'node:assert/strict'
import { simplePdf, startBenchmarkSite } from '../site/server.mjs'
import { makeTaskInstance, validateTask } from '../lib/tasks.mjs'

test('benchmark site serves tasks and records externally verifiable state', async (context) => {
  const site = await startBenchmarkSite({ port: 0 })
  context.after(() => site.close())
  const runId = 'site-test-run'
  const page = await fetch(`${site.origin}/task/contact_form?seed=1&run=${runId}`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /联系信息/u)

  const action = await fetch(`${site.origin}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      taskId: 'contact_form',
      action: 'submit-contact',
      payload: { name: '陈然', email: 'benchmark+1@example.com', city: '杭州' },
    }),
  })
  assert.equal(action.status, 200)
  const state = await (await fetch(`${site.origin}/api/state?run=${runId}`)).json()
  assert.deepEqual(state.form, { name: '陈然', email: 'benchmark+1@example.com', city: '杭州' })
  assert.equal(state.formSubmitted, true)
})

test('benchmark site renders and records the content-tool tasks', async (context) => {
  const site = await startBenchmarkSite({ port: 0 })
  context.after(() => site.close())
  const actions = {
    plan_select: ['save-subscription', { plan: 'pro', region: '华东' }, { subscriptionSaved: true, plan: 'pro', region: '华东' }],
    shadow_toggle: ['save-security', { twoFactor: true }, { securitySaved: true, twoFactor: true }],
    delayed_report: ['request-report', {}, { reportRequested: true }],
    feed_scroll: ['load-feed', { count: 60, targetLoaded: true }, { feedLoaded: 60, feedTargetLoaded: true }],
    signup_fix: ['signup', { username: 'u_1', email: 'e@example.com' }, { signedUp: true, account: { username: 'u_1', email: 'e@example.com' } }],
  }
  for (const taskId of ['plan_select', 'shadow_toggle', 'delayed_report', 'feed_scroll', 'ledger_total', 'signup_fix']) {
    const runId = `site-${taskId}`
    const page = await fetch(`${site.origin}/task/${taskId}?seed=2&run=${runId}`)
    assert.equal(page.status, 200, taskId)
    assert.match(await page.text(), /window\.__BENCHMARK__/u)
    const action = actions[taskId]
    if (action === undefined) continue
    const [name, payload, expected] = action
    const response = await fetch(`${site.origin}/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, taskId, action: name, payload }),
    })
    assert.equal(response.status, 200, taskId)
    const state = await (await fetch(`${site.origin}/api/state?run=${runId}`)).json()
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, state[key]])), expected, taskId)
  }
})

test('reliability tasks serve their fixtures and record dialog, pointer, and drag outcomes', async (context) => {
  const site = await startBenchmarkSite({ port: 0 })
  context.after(() => site.close())
  const post = (runId, taskId, action, payload) => fetch(`${site.origin}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, taskId, action, payload }),
  })
  const stateOf = async (runId) => (await fetch(`${site.origin}/api/state?run=${runId}`)).json()

  const confirmPage = await (await fetch(`${site.origin}/task/confirm_delete?seed=2&run=r1`)).text()
  assert.match(confirmPage, /confirm\('确定删除/u)
  const confirmTask = makeTaskInstance('confirm_delete', 2, 'r1', site.origin)
  await post('r1', 'confirm_delete', 'delete-draft', { draftId: confirmTask.page.targetId })
  assert.equal(validateTask(confirmTask, await stateOf('r1'), '', ['browser_click', 'browser_dialog']).success, true)

  assert.match(await (await fetch(`${site.origin}/task/hover_menu?seed=1&run=r2`)).text(), /mouseenter/u)
  const hoverTask = makeTaskInstance('hover_menu', 1, 'r2', site.origin)
  await post('r2', 'hover_menu', 'export', { format: hoverTask.expected.value.exported })
  assert.equal(validateTask(hoverTask, await stateOf('r2'), '', ['browser_hover', 'browser_click']).success, true)

  assert.match(await (await fetch(`${site.origin}/task/drag_assign?seed=3&run=r3`)).text(), /draggable="true"/u)
  const dragTask = makeTaskInstance('drag_assign', 3, 'r3', site.origin)
  await post('r3', 'drag_assign', 'move-card', dragTask.expected.value.moved)
  assert.equal(validateTask(dragTask, await stateOf('r3'), '', ['browser_drag']).success, true)

  assert.match(await (await fetch(`${site.origin}/task/covered_subscribe?seed=4&run=r4`)).text(), /id="banner"/u)
  const coveredTask = makeTaskInstance('covered_subscribe', 4, 'r4', site.origin)
  await post('r4', 'covered_subscribe', 'subscribe', { email: coveredTask.page.email })
  assert.equal(validateTask(coveredTask, await stateOf('r4'), '', ['browser_click', 'browser_type']).success, true)
})

test('the PDF task serves a real PDF carrying the expected invoice number', async (context) => {
  const site = await startBenchmarkSite({ port: 0 })
  context.after(() => site.close())
  const task = makeTaskInstance('pdf_lookup', 5, 'r5', site.origin)
  assert.match(await (await fetch(task.url)).text(), /发票 PDF/u)
  const response = await fetch(task.page.pdfUrl)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  const body = Buffer.from(await response.arrayBuffer()).toString('latin1')
  assert.match(body, /^%PDF-1\.4/u)
  assert.ok(body.includes(`(Invoice No: ${task.page.invoice}) Tj`))
  // The cross-reference table points at each object.
  const offset = Number(/startxref\n(\d+)/u.exec(body)[1])
  assert.ok(body.slice(offset).startsWith('xref'))
  assert.ok(simplePdf(['a (b) \\ c']).toString('latin1').includes('(a \\(b\\) \\\\ c) Tj'))
  assert.equal(validateTask(task, {}, task.page.invoice, ['browser_click', 'browser_pdf_text']).success, true)
})
