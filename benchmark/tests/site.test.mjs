import test from 'node:test'
import assert from 'node:assert/strict'
import { startBenchmarkSite } from '../site/server.mjs'

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
