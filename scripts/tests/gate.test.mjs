import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildResult, formatSummary, gateSteps, parseArgs, parseCounts, runSteps, summarize } from '../gate.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** A fake runner: steps named in `failing` exit 1; every run is recorded. */
function fakeRun(failing = [], outputs = {}) {
  const ran = []
  const run = async (step) => {
    ran.push(step.id)
    return { code: failing.includes(step.id) ? 1 : 0, output: outputs[step.id] ?? '', durationMs: 1234 }
  }
  return { ran, run }
}

test('the gate runs its steps in dependency order, one at a time', async () => {
  const steps = gateSteps()
  const ids = steps.map((step) => step.id)
  assert.deepEqual(ids, [
    'install', 'check-runtime', 'typecheck', 'unit-bridge', 'unit-extension', 'unit-mcp',
    'build', 'build-firefox', 'test-scripts', 'test-benchmark',
    'smoke-runtime', 'smoke-browser', 'model-free', 'smoke-uninstall-ui',
  ])
  // Every prerequisite comes earlier in the list.
  for (const step of steps) {
    for (const needed of step.needs ?? []) assert.ok(ids.indexOf(needed) < ids.indexOf(step.id), `${step.id} needs ${needed}`)
  }
  assert.deepEqual(steps.filter((step) => step.browser === true).map((step) => step.id), ['smoke-browser', 'model-free', 'smoke-uninstall-ui'])
  let running = 0
  const { ran } = fakeRun()
  const results = await runSteps({
    steps,
    run: async (step) => {
      running += 1
      assert.equal(running, 1, 'steps must not overlap')
      await new Promise((resolve) => setImmediate(resolve))
      ran.push(step.id)
      running -= 1
      return { code: 0, output: '', durationMs: 5 }
    },
  })
  assert.deepEqual(ran, ids)
  assert.ok(results.every((result) => result.status === 'passed'))
  assert.equal(summarize(results).ok, true)
})

test('the gate commands are the documented ones, with a bounded worker count for vitest', () => {
  const command = (id, options) => gateSteps(options).find((step) => step.id === id).command.join(' ')
  assert.equal(command('install'), 'pnpm install --frozen-lockfile')
  assert.equal(command('typecheck'), 'pnpm -r typecheck')
  assert.equal(command('unit-bridge'), 'pnpm --filter @natgurlain/dsh-browser-agent exec vitest run --maxWorkers=4')
  assert.equal(command('unit-extension', { maxWorkers: 2 }), 'pnpm --filter dsh-browser-extension exec vitest run --maxWorkers=2')
  assert.equal(command('unit-mcp'), 'pnpm --filter @natgurlain/dsh-browser-mcp run test')
  assert.equal(command('build'), 'pnpm build')
  assert.equal(command('build-firefox'), 'pnpm --filter dsh-browser-extension run build:firefox')
  assert.equal(command('smoke-runtime'), 'pnpm test:smoke')
  assert.equal(command('smoke-browser'), 'pnpm test:browser')
  assert.match(command('model-free', { outputDir: '/out' }), /^node benchmark\/model-free-check\.mjs --output \/out[/\\]model-free-check\.json$/u)
  // Every `pnpm <script>` the gate names exists, and the gate is itself a root script.
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts
  assert.equal(scripts.gate, 'node scripts/gate.mjs')
  for (const step of gateSteps()) {
    if (step.command[0] !== 'pnpm' || step.command.includes('--filter')) continue
    const name = step.command[1] === 'run' ? step.command[2] : step.command[1]
    if (['install', '-r'].includes(name)) continue
    assert.ok(scripts[name] !== undefined, `root package.json has no "${name}" script (step ${step.id})`)
  }
})

test('a failing step fails the gate, later steps still run, and its dependants are skipped', async () => {
  const { ran, run } = fakeRun(['unit-extension'])
  const results = await runSteps({ steps: gateSteps(), run })
  assert.equal(ran.length, 14, 'a unit-test failure blocks nothing else')
  assert.deepEqual(results.filter((result) => result.status === 'failed').map((result) => result.id), ['unit-extension'])
  assert.deepEqual(summarize(results), { ok: false, passed: 13, failed: 1, skipped: 0, tests: { total: 0, passed: 0, failed: 0, skipped: 0 } })

  const broken = fakeRun(['build'])
  const afterBuild = await runSteps({ steps: gateSteps(), run: broken.run })
  const skipped = afterBuild.filter((result) => result.status === 'skipped')
  assert.deepEqual(skipped.map((result) => result.id), ['test-scripts', 'smoke-runtime', 'smoke-browser', 'model-free', 'smoke-uninstall-ui'])
  assert.ok(skipped.every((result) => result.reason === 'needs build, which failed'))
  assert.ok(!broken.ran.includes('smoke-runtime'))
  assert.ok(broken.ran.includes('build-firefox') && broken.ran.includes('test-benchmark'))
  assert.equal(summarize(afterBuild).ok, false)

  const noInstall = fakeRun(['install'])
  const afterInstall = await runSteps({ steps: gateSteps(), run: noInstall.run })
  assert.deepEqual(noInstall.ran, ['install'])
  assert.equal(afterInstall.find((result) => result.id === 'smoke-runtime').reason, 'needs build, which did not run')
  assert.equal(summarize(afterInstall).ok, false)
})

test('a step killed by its timeout or a spawn error is a failure', async () => {
  const results = await runSteps({
    steps: gateSteps().slice(0, 2),
    run: async (step) => step.id === 'install'
      ? { code: null, output: '', durationMs: 10, timedOut: true }
      : { code: 0, output: '', durationMs: 1 },
  })
  assert.deepEqual(results.map((result) => [result.status, result.reason]), [['failed', 'timed out'], ['skipped', 'needs install, which failed']])
})

test('--skip-browser skips exactly the Chromium steps and still passes', async () => {
  const { ran, run } = fakeRun()
  const results = await runSteps({ steps: gateSteps(), run, skipBrowser: true })
  assert.deepEqual(results.filter((result) => result.status === 'skipped').map((result) => [result.id, result.reason]), [
    ['smoke-browser', 'needs Chromium (--skip-browser)'],
    ['model-free', 'needs Chromium (--skip-browser)'],
    ['smoke-uninstall-ui', 'needs Chromium (--skip-browser)'],
  ])
  assert.equal(ran.length, 11)
  assert.deepEqual(summarize(results), { ok: true, passed: 11, failed: 0, skipped: 3, tests: { total: 0, passed: 0, failed: 0, skipped: 0 } })
})

test('--only runs the named steps without their prerequisites; a run of nothing does not pass', async () => {
  const { ran, run } = fakeRun()
  const results = await runSteps({ steps: gateSteps(), run, only: ['smoke-runtime', 'typecheck'] })
  assert.deepEqual(ran, ['typecheck', 'smoke-runtime'])
  assert.equal(results.find((result) => result.id === 'build').reason, 'not selected (--only)')
  assert.equal(summarize(results).ok, true)
  await assert.rejects(runSteps({ steps: gateSteps(), run, only: ['nope'] }), /unknown step\(s\): nope/u)
  // Only browser steps selected, and no browser: nothing ran, so nothing was proven.
  const nothing = await runSteps({ steps: gateSteps(), run, only: ['model-free'], skipBrowser: true })
  assert.equal(summarize(nothing).ok, false)
  assert.equal(summarize([]).ok, false)
})

test('test counts are read from vitest, node:test (spec and TAP), and the smokes', () => {
  assert.deepEqual(parseCounts('vitest', ' Test Files  141 passed (141)\n      Tests  1574 passed (1574)\n   Start at  10:00:00\n'), { total: 1574, passed: 1574, failed: 0, skipped: 0 })
  assert.deepEqual(
    parseCounts('vitest', '\u001B[2m Test Files \u001B[22m 1 failed | 140 passed (141)\n\u001B[2m      Tests \u001B[22m \u001B[31m2 failed\u001B[39m | 1570 passed | 3 skipped (1575)\n'),
    { total: 1575, passed: 1570, failed: 2, skipped: 3 },
  )
  assert.equal(parseCounts('vitest', 'Error: no test files found'), undefined)
  assert.deepEqual(parseCounts('node-test', 'ℹ tests 57\nℹ suites 0\nℹ pass 56\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n'), { total: 57, passed: 56, failed: 0, skipped: 1 })
  assert.deepEqual(parseCounts('node-test', '# tests 9\n# suites 0\n# pass 7\n# fail 1\n# cancelled 1\n# skipped 0\n# todo 0\n'), { total: 9, passed: 7, failed: 2, skipped: 0 })
  // pnpm prints several node --test runs in one step only if a script chains them; the last totals win.
  assert.equal(parseCounts('node-test', '# tests 3\n# pass 3\n# fail 0\nℹ tests 5\nℹ pass 5\nℹ fail 0\n').total, 5)
  assert.equal(parseCounts('node-test', 'SyntaxError: Unexpected token'), undefined)
  assert.deepEqual(parseCounts('smoke-browser', 'x\nBrowser smoke passed: sharing off blocks reads; approvals ask; taint forces a card\nScreenshots: a.png\n'), { total: 3, passed: 3, failed: 0, skipped: 0 })
  assert.equal(parseCounts('smoke-browser', 'AssertionError: nope'), undefined)
  assert.deepEqual(parseCounts('model-free', 'PASS a\nFAIL b\nmodel-free check: 9 passed, 1 failed (/x/model-free-check.json)\n'), { total: 10, passed: 9, failed: 1, skipped: 0 })
  assert.deepEqual(parseCounts('smoke-uninstall-ui', 'Uninstall UI passed: 6 cases. Evidence: /x\n'), { total: 6, passed: 6, failed: 0, skipped: 0 })
  assert.equal(parseCounts('unknown-kind', 'Tests 1 passed (1)'), undefined)
})

test('the result records commit, date, and every step with its status and counts; the table says pass or fail', async () => {
  const { run } = fakeRun(['unit-bridge'], {
    'unit-bridge': '      Tests  1 failed | 9 passed (10)\n',
    'unit-mcp': '# tests 4\n# pass 4\n# fail 0\n',
  })
  const results = await runSteps({ steps: gateSteps(), run, skipBrowser: true })
  const result = buildResult({
    results,
    commit: { commit: 'abc123', branch: 'main', dirty: false },
    startedAt: new Date('2026-11-15T10:00:00Z'),
    finishedAt: new Date('2026-11-15T10:05:00Z'),
    options: { skipBrowser: true, maxWorkers: 4 },
  })
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.commit, 'abc123')
  assert.equal(result.dirty, false)
  assert.equal(result.date, '2026-11-15T10:00:00.000Z')
  assert.equal(result.durationMs, 300_000)
  assert.equal(result.skipBrowser, true)
  assert.equal(result.ok, false)
  assert.deepEqual([result.passed, result.failed, result.skipped], [10, 1, 3])
  assert.deepEqual(result.tests, { total: 14, passed: 13, failed: 1, skipped: 0 })
  assert.equal(result.steps.length, 14)
  assert.deepEqual(result.steps[3], {
    id: 'unit-bridge',
    title: 'Bridge unit tests',
    command: 'pnpm --filter @natgurlain/dsh-browser-agent exec vitest run --maxWorkers=4',
    status: 'failed',
    exitCode: 1,
    durationMs: 1234,
    tests: { total: 10, passed: 9, failed: 1, skipped: 0 },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'the result is plain JSON')

  const table = formatSummary(results).split('\n')
  assert.match(table[0], /^\s+step\s+time\s+tests\s+note$/u)
  assert.ok(table.some((line) => /^FAIL {2}unit-bridge\s+1s\s+9\/10, 1 failed\s+exit 1$/u.test(line)), table.join('\n'))
  assert.ok(table.some((line) => /^PASS {2}unit-mcp\s+1s\s+4\/4$/u.test(line)))
  assert.ok(table.some((line) => /^SKIP {2}model-free\s+needs Chromium \(--skip-browser\)$/u.test(line)))
  assert.equal(table.at(-1), 'GATE FAILED: 10 passed, 1 failed, 3 skipped; tests 13/14 passed, 1 failed')
  const passing = await runSteps({ steps: gateSteps(), run: fakeRun().run })
  assert.equal(formatSummary(passing).split('\n').at(-1), 'GATE PASSED: 14 passed, 0 failed, 0 skipped; tests 0/0 passed')
})

test('options are parsed and bad ones rejected', () => {
  assert.deepEqual(parseArgs([]), { skipBrowser: false, maxWorkers: 4, list: false, help: false })
  const options = parseArgs(['--skip-browser', '--output', 'out/gate.json', '--only', 'build,typecheck', '--max-workers', '2'])
  assert.equal(options.skipBrowser, true)
  assert.match(options.output, /out[/\\]gate\.json$/u)
  assert.deepEqual(options.only, ['build', 'typecheck'])
  assert.equal(options.maxWorkers, 2)
  assert.throws(() => parseArgs(['--output']), /--output requires a value/u)
  assert.throws(() => parseArgs(['--max-workers', '0']), /positive integer/u)
  assert.throws(() => parseArgs(['--fast']), /unknown option: --fast/u)
})

test('the command line lists the steps and exits non-zero on a bad option', () => {
  const gate = (...args) => spawnSync(process.execPath, ['scripts/gate.mjs', ...args], { cwd: root, encoding: 'utf8' })
  const list = gate('--list')
  assert.equal(list.status, 0)
  assert.match(list.stdout, /\* model-free\s+Injection canaries/u)
  const bad = gate('--only', 'nope')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown step\(s\): nope/u)
})

test('ci.yml runs the gate script, so the workflow and the local command cannot drift', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^\s+run: pnpm gate --output /mu)
  // No second copy of the steps to keep in sync.
  assert.doesNotMatch(workflow, /run: pnpm (?:run )?(?:test|typecheck|build)\b/u)
})
