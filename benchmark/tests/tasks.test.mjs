import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTaskInstance, stateReached, TASK_IDS, validateTask } from '../lib/tasks.mjs'

test('all catalog tasks build deterministic seeded instances', () => {
  for (const taskId of TASK_IDS) {
    const first = makeTaskInstance(taskId, 3, 'run-a', 'http://127.0.0.1:4173')
    const again = makeTaskInstance(taskId, 3, 'run-a', 'http://127.0.0.1:4173')
    assert.deepEqual(first, again)
    assert.match(first.prompt, /browser_\*/u)
    assert.equal(first.seed, 3)
  }
})

test('state and answer validators reject incorrect results and forbidden tools', () => {
  const instance = makeTaskInstance('notification_toggle', 1, 'state-run', 'http://127.0.0.1:4173')
  const correct = { notificationSaved: true, emailNotifications: true, extra: 'allowed' }
  assert.equal(stateReached(instance, correct), true)
  assert.equal(validateTask(instance, correct, '', ['browser_snapshot', 'browser_click']).success, true)
  assert.equal(validateTask(instance, correct, '', ['exec_command']).success, false)
  assert.equal(validateTask(instance, { notificationSaved: true, emailNotifications: false }, '', []).success, false)
})

test('answer validators normalize lightweight markdown and whitespace', () => {
  const instance = makeTaskInstance('order_lookup', 2, 'answer-run', 'http://127.0.0.1:4173')
  assert.equal(validateTask(instance, {}, `**${instance.expected.value}**`, ['browser_snapshot']).success, true)
  assert.equal(validateTask(instance, {}, '¥0.00', ['browser_snapshot']).success, false)
})

test('inventory validation measures the unique filtered product, not a seed suffix', () => {
  const instance = makeTaskInstance('inventory_filter', 1, 'inventory-run', 'http://127.0.0.1:4173')
  const state = { filterApplied: true, filter: instance.page.filter }
  const target = instance.page.products.find((product) => product.sku === `SKU-${instance.page.filter.sku}`)

  assert.equal(instance.expected.value, target.name)
  assert.doesNotMatch(instance.expected.value, /\s1$/u)
  assert.equal(validateTask(instance, state, `${target.name} (${target.sku}, ¥${(target.cents / 100).toFixed(2)})`, ['browser_snapshot']).success, true)
  assert.equal(validateTask(instance, state, 'Some other product', ['browser_snapshot']).success, false)
})

test('content-tool tasks validate their target state and answers', () => {
  const plan = makeTaskInstance('plan_select', 2, 'plan-run', 'http://127.0.0.1:4173')
  const { plan: wantedPlan, region } = plan.expected.value
  assert.ok(plan.page.plans.some((option) => option.value === wantedPlan))
  assert.ok(plan.page.regions.includes(region))
  assert.equal(validateTask(plan, { subscriptionSaved: true, plan: wantedPlan, region }, '', ['browser_select']).success, true)
  assert.equal(validateTask(plan, { subscriptionSaved: true, plan: wantedPlan, region: 'elsewhere' }, '', ['browser_select']).success, false)

  const toggle = makeTaskInstance('shadow_toggle', 1, 'toggle-run', 'http://127.0.0.1:4173')
  assert.equal(validateTask(toggle, { securitySaved: true, twoFactor: true }, '', []).success, true)
  assert.equal(validateTask(toggle, { securitySaved: true, twoFactor: false }, '', []).success, false)

  const report = makeTaskInstance('delayed_report', 3, 'report-run', 'http://127.0.0.1:4173')
  assert.ok(report.page.delayMs >= 1_500)
  assert.equal(validateTask(report, { reportRequested: true }, report.page.code, ['browser_wait']).success, true)
  assert.equal(validateTask(report, { reportRequested: true }, 'RPT-0000', ['browser_wait']).success, false)

  const feed = makeTaskInstance('feed_scroll', 4, 'feed-run', 'http://127.0.0.1:4173')
  assert.ok(feed.page.target > feed.page.batch * 3, 'the target needs several loads')
  assert.equal(validateTask(feed, { feedTargetLoaded: true }, feed.page.code, []).success, true)
  assert.equal(validateTask(feed, {}, feed.page.code, []).success, false)

  const signup = makeTaskInstance('signup_fix', 5, 'signup-run', 'http://127.0.0.1:4173')
  const account = { username: signup.page.suggestion, email: signup.expected.value.account.email }
  assert.equal(validateTask(signup, { signedUp: true, account }, '', []).success, true)
  assert.equal(validateTask(signup, { signedUp: true, account: { ...account, username: signup.page.username } }, '', []).success, false)
})

test('ledger totals accept plain and thousands-separated amounts across every page', () => {
  const ledger = makeTaskInstance('ledger_total', 6, 'ledger-run', 'http://127.0.0.1:4173')
  const total = ledger.page.entries.reduce((sum, entry) => sum + entry.cents, 0)
  assert.equal(ledger.page.entries.length, 20)
  assert.equal(ledger.expected.value, `¥${(total / 100).toFixed(2)}`)
  assert.equal(validateTask(ledger, {}, `Total amount ${ledger.expected.value}`, ['browser_extract']).success, true)
  assert.equal(validateTask(ledger, {}, ledger.expected.alternatives[0], ['browser_extract']).success, true)
  assert.match(ledger.expected.alternatives[0], /^¥\d{1,3}(,\d{3})+\.\d{2}$/u)
  const firstPageOnly = ledger.page.entries.slice(0, 5).reduce((sum, entry) => sum + entry.cents, 0)
  assert.equal(validateTask(ledger, {}, `¥${(firstPageOnly / 100).toFixed(2)}`, ['browser_extract']).success, false)
})
