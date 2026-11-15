import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureTaskFromMeta, importFixtures, loadFixtureTasks, validateFixtureTask } from '../lib/fixture-tasks.mjs'
import { parseImportArgs } from '../import-fixtures.mjs'
import { startBenchmarkSite } from '../site/server.mjs'
import { levelOf, loadOnlineMind2Web, normalizeTask, parseLoaderArgs, selectSubset, DEFAULT_SOURCE } from '../online-mind2web/loader.mjs'
import { buildLeaderboard, escapeHtml, parseResults, renderLeaderboardHtml } from '../online-mind2web/report.mjs'

const meta = (overrides = {}) => ({
  format: 'dsh-browser-fixture/v1',
  capturedAt: '2026-11-15T10:00:00.000Z',
  failure: 'not-found',
  url: 'https://shop.example/cart',
  page: { kind: 'dom', file: '2026-11-15T10-00-00-000Z-type-abc123.html' },
  intended: { tool: 'browser_type', args: { selector: '#qty', text: { masked: true, length: 2 } } },
  error: { code: 'action-failed', message: 'No element matched selector: #qty' },
  ...overrides,
})

test('a fixture becomes a task whose validator checks tool, target, and value length', () => {
  const task = fixtureTaskFromMeta(meta(), 'fixture_x')
  assert.equal(task.category, 'fixture')
  assert.match(task.prompt, /type a 2-character value on the element matching "#qty"/u)
  assert.match(task.prompt, /browser_\*/u)
  assert.deepEqual(task.expected, { kind: 'tool-call', tool: 'browser_type', selector: '#qty', textLength: 2 })
  assert.equal(validateFixtureTask(task, [{ name: 'browser_snapshot', args: {} }, { name: 'browser_type', args: { selector: '#qty', text: '12' } }]).success, true)
  assert.equal(validateFixtureTask(task, [{ name: 'browser_type', args: { selector: '#other', text: '12' } }]).success, false)
  assert.equal(validateFixtureTask(task, [{ name: 'browser_type', args: { selector: '#qty', text: '123' } }]).success, false)
  assert.equal(validateFixtureTask(task, [{ name: 'browser_type', args: { selector: '#qty', text: '12' }, ok: false }]).success, false)
  assert.match(validateFixtureTask(task, [{ name: 'exec_command', args: {} }]).reason, /forbidden/u)
  assert.throws(() => fixtureTaskFromMeta({ ...meta(), format: 'x' }, 'id'), /not a dsh-browser fixture/u)
})

test('import-fixtures copies pages, never overwrites, and the site serves DOM captures without scripts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fixtures-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'browser-fixtures')
  const out = join(root, 'tasks')
  await mkdir(source)
  await writeFile(join(source, '2026-11-15T10-00-00-000Z-type-abc123.json'), JSON.stringify(meta()))
  await writeFile(join(source, '2026-11-15T10-00-00-000Z-type-abc123.html'), '<html><body><input id="qty" data-dsh-masked="true" value="••••"></body></html>')
  await writeFile(join(source, 'broken.json'), '{')
  const first = await importFixtures(source, out)
  assert.equal(first.imported.length, 1)
  assert.equal(first.errors.length, 1)
  const again = await importFixtures(source, out)
  assert.deepEqual(again.imported, [])
  assert.equal(again.skipped.length, 1)
  const tasks = await loadFixtureTasks(out)
  assert.equal(tasks.length, 1)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'tasks.json'), 'utf8')).map((task) => task.id), [tasks[0].id])
  const site = await startBenchmarkSite({ port: 0, fixtureDir: out })
  context.after(() => site.close())
  const page = await fetch(`${site.origin}/fixture/${tasks[0].id}`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-security-policy'), "script-src 'none'")
  assert.match(await page.text(), /id="qty"/u)
  assert.equal((await fetch(`${site.origin}/fixture/..%2Fetc`)).status, 400)
  assert.deepEqual(parseImportArgs(['a', '--out', 'b']).source.endsWith('a'), true)
})

test('Online-Mind2Web rows are normalized and leveled by reference length', () => {
  assert.equal(levelOf(3), 'easy')
  assert.equal(levelOf(6), 'medium')
  assert.equal(levelOf(11), 'hard')
  assert.deepEqual(normalizeTask({ task_id: 't1', task_description: 'Find a red bike', website: 'https://bikes.example/', reference_length: 4 }),
    { taskId: 't1', task: 'Find a red bike', website: 'https://bikes.example/', referenceLength: 4, level: 'easy' })
  assert.equal(normalizeTask({ task_id: 't2', confirmed_task: 'Book', website: 'https://x.example', reference_length: 12 }).level, 'hard')
  assert.throws(() => normalizeTask({ task_id: 't3', task_description: 'x', website: 'ftp://x' }), /website/u)
})

test('the loader downloads with a token, explains gating, and selects a balanced deterministic subset', async () => {
  // Synthetic rows only: the real data is downloaded at runtime, never vendored.
  const rows = Array.from({ length: 30 }, (_unused, index) => ({ task_id: `t${String(index)}`, task_description: `Task ${String(index)}`, website: `https://site${String(index % 3)}.example/`, reference_length: 2 + index % 12 }))
  const seen = []
  const fetcher = async (url, init) => {
    seen.push({ url, init })
    return init.headers.authorization === 'Bearer hf_x' ? new Response(JSON.stringify(rows)) : new Response('gated', { status: 401 })
  }
  await assert.rejects(loadOnlineMind2Web({ fetch: fetcher, token: '' }), /gated/u)
  const tasks = await loadOnlineMind2Web({ fetch: fetcher, token: 'hf_x' })
  assert.equal(seen[1].url, DEFAULT_SOURCE)
  assert.equal(tasks.length, 30)
  const subset = selectSubset(tasks, { count: 9, seed: 7 })
  assert.equal(subset.length, 9)
  assert.deepEqual(['easy', 'medium', 'hard'].map((level) => subset.filter((task) => task.level === level).length), [3, 3, 3])
  assert.deepEqual(selectSubset(tasks, { count: 9, seed: 7 }), subset)
  assert.notDeepEqual(selectSubset(tasks, { count: 9, seed: 8 }), subset)
  assert.ok(selectSubset(tasks, { count: 50, levels: ['hard'] }).every((task) => task.level === 'hard'))
  assert.deepEqual(parseLoaderArgs(['--count', '5', '--levels', 'easy,bogus']).levels, ['easy'])
  assert.throws(() => parseLoaderArgs(['--count', '0']), /positive/u)
})

test('the leaderboard ranks agents, splits by level, and escapes everything', () => {
  const results = parseResults([
    { agent: 'dsh-browser', model: 'm1', taskId: 't1', level: 'easy', success: true, steps: 4, durationMs: 30_000 },
    { agent: 'dsh-browser', model: 'm1', taskId: 't2', level: 'hard', success: false, steps: 20, durationMs: 90_000 },
    { agent: '<script>alert(1)</script>', taskId: 't1', referenceLength: 3, success: false },
  ].map((row) => JSON.stringify(row)).join('\n'))
  const board = buildLeaderboard(results)
  assert.equal(board[0].agent, 'dsh-browser')
  assert.equal(board[0].successRate, 0.5)
  assert.equal(board[0].byLevel.easy.successRate, 1)
  assert.equal(board[0].medianSteps, 12)
  assert.equal(board[1].byLevel.easy.tasks, 1)
  const html = renderLeaderboardHtml(results, { generatedAt: '2026-11-15T00:00:00Z' })
  assert.match(html, /<title>Online-Mind2Web results<\/title>/u)
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;script&gt;/u)
  assert.match(html, /50\.0%/u)
  assert.equal(escapeHtml('"&\''), '&quot;&amp;&#39;')
  assert.throws(() => parseResults('[{"agent":"a","taskId":"t"}]'), /boolean success/u)
})
