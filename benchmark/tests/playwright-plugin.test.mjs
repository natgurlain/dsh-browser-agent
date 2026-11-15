import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium, findChromiumExecutable } from '../lib/chromium.mjs'
import { makeTaskInstance } from '../lib/tasks.mjs'
import { createToolRunner, defineTools } from '../plugin/playwright-browser.mjs'
import { startBenchmarkSite } from '../site/server.mjs'

test('Playwright baseline exposes the canonical model-facing browser contract', () => {
  const tools = defineTools(async () => ({ text: 'ok' }))
  assert.deepEqual(tools.map((tool) => tool.name), [
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_navigate',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_get_text',
    'browser_wait',
    'browser_select',
    'browser_dialog',
    'browser_hover',
    'browser_drag',
  ])
  assert.match(tools.find((tool) => tool.name === 'browser_snapshot').description, /untrusted data/u)
  assert.equal(tools.find((tool) => tool.name === 'browser_click').parameters.index.description, 'Element index from the browser_snapshot inventory.')
  assert.equal(tools.find((tool) => tool.name === 'browser_type').parameters.replace.description, 'When true, clear the existing value before entering text. Defaults to append.')
})

test('the Phase 1 tools carry the same parameters as the product tools', () => {
  const tools = new Map(defineTools(async () => ({ text: 'ok' })).map((tool) => [tool.name, tool]))
  const parameters = (name) => Object.keys(tools.get(name).parameters).filter((key) => key !== 'type' && key !== 'additionalProperties').sort()
  assert.deepEqual(parameters('browser_select'), ['frame', 'index', 'label', 'optionIndex', 'selector', 'value', 'values'])
  assert.deepEqual(parameters('browser_hover'), ['frame', 'index', 'selector'])
  assert.deepEqual(parameters('browser_drag'), ['frame', 'from', 'steps', 'to', 'toOffset'])
  assert.deepEqual(parameters('browser_dialog'), ['accept', 'promptText'])
  assert.deepEqual(parameters('browser_wait'), ['frame', 'gone', 'ms', 'networkIdle', 'selector', 'text', 'timeoutMs', 'urlMatches'])
  assert.deepEqual(parameters('browser_scroll'), ['amount', 'direction', 'frame', 'index', 'itemSelector', 'maxRounds', 'selector', 'untilItems'])
  assert.deepEqual(Object.keys(tools.get('browser_snapshot').parameters.query.properties), ['text', 'selector', 'role', 'includeHidden', 'limit'])
  assert.equal(tools.get('browser_drag').parameters.from.required, true)
  assert.equal(tools.get('browser_dialog').parameters.accept.required, true)
})

// ---- The same tool code against the benchmark pages in a real Chromium ----

const executablePath = await findChromiumExecutable()
const skip = executablePath === undefined ? 'no Chromium executable found (set PLAYWRIGHT_CHROMIUM_PATH)' : false

/** Index of the first `[n]` line of a snapshot or query result whose text matches. */
function indexOf(text, pattern) {
  const line = text.split('\n').find((candidate) => /^\[\d+\]/u.test(candidate) && pattern.test(candidate))
  assert.ok(line, `no element matching ${pattern} in:\n${text}`)
  return Number(/^\[(\d+)\]/u.exec(line)[1])
}

test('the baseline completes the Phase 1 tasks with its own tools', { skip, timeout: 120_000 }, async (context) => {
  const site = await startBenchmarkSite({ port: 0 })
  const browser = await chromium.launch({ executablePath, headless: true })
  context.after(async () => {
    await browser.close()
    await site.close()
  })
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  const runner = createToolRunner(page)
  const tool = async (name, args) => (await runner.run(name, args)).text
  const open = async (taskId, seed) => {
    const instance = makeTaskInstance(taskId, seed, `plugin-${taskId}`, site.origin)
    const reset = await fetch(`${site.origin}/api/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: instance.runId, taskId }),
    })
    assert.equal(reset.status, 200)
    await runner.reset(instance.url)
    return instance
  }
  const state = async (instance) => (await fetch(`${site.origin}/api/state?run=${instance.runId}`)).json()
  const find = async (text, pattern = /./u) => indexOf(await tool('browser_snapshot', { query: { text } }), pattern)

  await context.test('browser_select: a native select and an ARIA combobox', async () => {
    const instance = await open('plan_select', 2)
    const { plan, region } = instance.expected.value
    const label = instance.page.plans.find((candidate) => candidate.value === plan).label
    const snapshot = await tool('browser_snapshot', {})
    assert.match(snapshot, /<select> "套餐".*options=\[/u)
    assert.match(await tool('browser_select', { index: indexOf(snapshot, /<select>/u), label }), new RegExp(`Selected "${label}"`, 'u'))
    await tool('browser_select', { index: indexOf(snapshot, /role=combobox/u), value: region })
    await tool('browser_click', { index: indexOf(snapshot, /保存订阅/u) })
    assert.deepEqual({ ...await state(instance), createdAt: 0, updatedAt: 0 }, { taskId: 'plan_select', subscriptionSaved: true, plan, region, createdAt: 0, updatedAt: 0 })
    await assert.rejects(tool('browser_select', { index: indexOf(snapshot, /<select>/u), label: 'no such plan' }), /No option matched/u)
  })

  await context.test('browser_hover opens a menu that exists only under the pointer', async () => {
    const instance = await open('hover_menu', 1)
    assert.doesNotMatch(await tool('browser_snapshot', {}), /导出/u)
    await tool('browser_hover', { index: await find('更多操作') })
    await tool('browser_click', { index: indexOf(await tool('browser_snapshot', {}), new RegExp(`导出 ${instance.expected.value.exported}`, 'u')) })
    assert.equal((await state(instance)).exported, instance.expected.value.exported)
    await assert.rejects(tool('browser_hover', {}), /needs index or selector/u)
  })

  await context.test('browser_drag moves an HTML5 draggable card onto a lane', async () => {
    const instance = await open('drag_assign', 3)
    const { cardId, lane } = instance.expected.value.moved
    const card = instance.page.cards.find((candidate) => candidate.id === cardId)
    const snapshot = await tool('browser_snapshot', {})
    const from = indexOf(snapshot, new RegExp(`draggable=true.*${card.title}`, 'u'))
    await tool('browser_drag', { from: { index: from }, to: { selector: `[data-lane="${lane}"]` } })
    assert.deepEqual((await state(instance)).moved, { cardId, lane })
    await assert.rejects(tool('browser_drag', { from: { index: from } }), /needs to or toOffset/u)
  })

  await context.test('a confirm dialog fails the click fast, blocks later calls, and browser_dialog answers it', async () => {
    const instance = await open('confirm_delete', 1)
    const target = instance.page.drafts.find((draft) => draft.id === instance.expected.value.deletedDraft)
    const button = `[data-draft-id="${target.id}"]`
    // Cancel first: nothing is deleted.
    await assert.rejects(tool('browser_click', { selector: button }), /dialog open: confirm dialog .*The action was delivered/u)
    await assert.rejects(tool('browser_snapshot', {}), /dialog open: confirm dialog/u)
    assert.equal(await tool('browser_dialog', { accept: false }), 'Answered the confirm dialog with Cancel.')
    assert.equal((await state(instance)).deletedCount, undefined)
    await assert.rejects(tool('browser_dialog', { accept: true }), /No JavaScript dialog is open/u)
    // Then confirm.
    await assert.rejects(tool('browser_click', { selector: button }), /dialog open: confirm dialog/u)
    assert.equal(await tool('browser_dialog', { accept: true }), 'Answered the confirm dialog with OK.')
    await tool('browser_wait', { text: '草稿已删除' })
    assert.deepEqual({ deletedDraft: (await state(instance)).deletedDraft, deletedCount: (await state(instance)).deletedCount }, instance.expected.value)
    // A dialog left open by one run does not poison the next.
    await assert.rejects(tool('browser_click', { selector: '[data-draft-id]' }), /dialog open/u)
    await open('order_lookup', 1)
    assert.match(await tool('browser_snapshot', {}), /订单中心/u)
  })

  await context.test('browser_wait waits for a condition and fails on timeout', async () => {
    const instance = await open('delayed_report', 2)
    await tool('browser_click', { index: indexOf(await tool('browser_snapshot', {}), /生成报表/u) })
    await assert.rejects(tool('browser_wait', { text: 'never shown', timeoutMs: 200 }), /Timed out after 200ms waiting for text "never shown" to appear/u)
    assert.match(await tool('browser_wait', { text: '报表已生成' }), /Waited for text/u)
    assert.match(await tool('browser_get_text', { selector: '#code' }), new RegExp(instance.expected.value, 'u'))
    await tool('browser_wait', { selector: '#result' })
    await tool('browser_wait', { selector: '#nothing-here', gone: true, timeoutMs: 500 })
    await tool('browser_wait', { urlMatches: '/delayed_report\\?seed=2/' })
    await assert.rejects(tool('browser_wait', { urlMatches: 'elsewhere', timeoutMs: 200 }), /Timed out/u)
  })

  await context.test('browser_scroll scrolls an inner container, once or until enough items load', async () => {
    const instance = await open('feed_scroll', 4)
    await tool('browser_scroll', { direction: 'bottom', selector: '#feed' })
    await tool('browser_wait', { text: '第 16 条消息' })
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'the page itself must not scroll')
    const result = await tool('browser_scroll', { direction: 'bottom', selector: '#feed article', untilItems: instance.page.target, maxRounds: 12 })
    assert.match(result, /items are loaded\.$/u)
    assert.match(await tool('browser_get_text', { selector: '#feed' }), new RegExp(instance.expected.value, 'u'))
    assert.equal((await state(instance)).feedTargetLoaded, true)
  })
})
