import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_RECORD,
  dropUnpublished,
  firstErrorLine,
  inDeclaredRange,
  parseArgs,
  parseTestCounts,
  passedVersions,
  RECORD_BEGIN,
  RECORD_END,
  recordRow,
  resolveTargets,
  rewriteDshVersions,
  STEP_COLUMNS,
  testedVersions,
  updateRecord,
} from '../dsh-matrix.mjs'

const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('rewriteDshVersions only touches @deepseek-ai/dsh* packages', () => {
  const deps = {
    '@deepseek-ai/dsh': '0.2.2-rc.2',
    '@deepseek-ai/dsh-fs': '0.2.2-rc.2',
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/dshx': '1.0.0',
    ws: '^8.21.0',
  }
  assert.deepEqual(rewriteDshVersions(deps, '0.2.2-rc.3'), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-fs'])
  assert.deepEqual(deps, {
    '@deepseek-ai/dsh': '0.2.2-rc.3',
    '@deepseek-ai/dsh-fs': '0.2.2-rc.3',
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/dshx': '1.0.0',
    ws: '^8.21.0',
  })
  assert.deepEqual(rewriteDshVersions(undefined, '1.0.0'), [])
})

test('dropUnpublished removes DSH packages the target release does not have', async () => {
  const deps = { '@deepseek-ai/dsh': '1.0.0', '@deepseek-ai/dsh-error': '1.0.0', ws: '^8.21.0' }
  const asked = []
  const dropped = await dropUnpublished(deps, '1.0.0', async (name, version) => {
    asked.push(`${name}@${version}`)
    return name !== '@deepseek-ai/dsh-error'
  })
  assert.deepEqual(dropped, ['@deepseek-ai/dsh-error'])
  assert.deepEqual(deps, { '@deepseek-ai/dsh': '1.0.0', ws: '^8.21.0' })
  assert.deepEqual(asked, ['@deepseek-ai/dsh@1.0.0', '@deepseek-ai/dsh-error@1.0.0'])
})

test('resolveTargets runs each version once and keeps every label', async () => {
  const tags = async () => ({ latest: '0.2.2-rc.1', next: '0.2.2-rc.3', stable: '0.2.2-rc.2' })
  assert.deepEqual(await resolveTargets(['pin', 'latest', 'next', 'stable', '0.2.2-rc.3', '0.2.1-rc.5'], '0.2.2-rc.2', tags), [
    { version: '0.2.2-rc.2', labels: ['pin', 'stable'], inPlace: true },
    { version: '0.2.2-rc.1', labels: ['latest'], inPlace: false },
    { version: '0.2.2-rc.3', labels: ['next'], inPlace: false },
    { version: '0.2.1-rc.5', labels: [], inPlace: false },
  ])
  // The default version given by number is still the in-place pin row.
  assert.deepEqual(await resolveTargets(['0.2.2-rc.2'], '0.2.2-rc.2', tags), [{ version: '0.2.2-rc.2', labels: ['pin'], inPlace: true }])
  await assert.rejects(resolveTargets(['nightly'], '0.2.2-rc.2', tags), /no dist-tag "nightly" \(have: latest, next, stable\)/)
  // `tested` is the pin plus the other releases the bridge lists; no registry lookup.
  const offline = async () => { throw new Error('no network') }
  assert.deepEqual(await resolveTargets(['tested', '0.2.2-rc.3'], '0.2.2-rc.2', offline, () => ['0.2.2-rc.2', '0.2.2-rc.3']), [
    { version: '0.2.2-rc.2', labels: ['pin'], inPlace: true },
    { version: '0.2.2-rc.3', labels: [], inPlace: false },
  ])
  assert.deepEqual(testedVersions("export const TESTED_DSH_VERSIONS: readonly string[] = ['1.0.0', '1.0.1']\n"), ['1.0.0', '1.0.1'])
  assert.ok(testedVersions().length > 0)
  // Exact versions need no registry lookup.
  await resolveTargets(['pin', '1.2.3'], '0.2.2-rc.2', async () => { throw new Error('no network') })
})

test('parseArgs: targets, --record with and without a file, and errors', () => {
  const options = parseArgs(['pin', '--record', 'latest', '--probe-outside-range', '--max-workers', '2'], {})
  assert.deepEqual(options.targets, ['pin', 'latest'])
  assert.ok(options.record.endsWith(DEFAULT_RECORD))
  assert.equal(options.probeOutsideRange, true)
  assert.equal(options.maxWorkers, 2)
  assert.ok(parseArgs(['pin', '--record', 'out/matrix.md'], {}).record.endsWith('out/matrix.md'))
  assert.equal(parseArgs(['pin'], {}).record, undefined)
  assert.throws(() => parseArgs([], {}), /usage:/)
  assert.throws(() => parseArgs(['pin', '--bogus'], {}), /unknown argument: --bogus/)
  assert.throws(() => parseArgs(['pin', '--max-workers', '0'], {}), /positive integer/)
})

test('inDeclaredRange matches the way DSH evaluates engines.dsh (prereleases included)', () => {
  assert.equal(inDeclaredRange('0.2.2-rc.3', '^0.2.2-rc.2'), true)
  assert.equal(inDeclaredRange('0.2.2', '^0.2.2-rc.2'), true)
  assert.equal(inDeclaredRange('0.2.2-rc.1', '^0.2.2-rc.2'), false)
  assert.equal(inDeclaredRange('0.2.3-rc.1', '^0.2.2-rc.2'), true)
  assert.equal(inDeclaredRange('0.3.0-rc.1', '^0.2.2-rc.2'), false)
  assert.equal(inDeclaredRange('0.2.2-rc.2', undefined), false)
})

test('parseTestCounts sums vitest and node:test summaries', () => {
  assert.deepEqual(parseTestCounts('      Tests  2 failed | 600 passed | 3 skipped (605)\n'), { passed: 600, failed: 2, skipped: 3 })
  assert.deepEqual(parseTestCounts('ℹ tests 17\nℹ pass 16\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n'), { passed: 16, failed: 1, skipped: 0 })
  assert.equal(parseTestCounts('no summary here'), undefined)
})

test('firstErrorLine prefers the specific failure over the pnpm wrapper', () => {
  assert.equal(
    firstErrorLine('$ tsc -b\nsrc/a.ts(1,2): error TS2339: Property \'x\' does not exist on type \'Y\'.\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] typecheck failed\n'),
    'src/a.ts(1,2): error TS2339: Property \'x\' does not exist on type \'Y\'.',
  )
  assert.match(firstErrorLine('progress\n[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for a@1\n'), /^\[ERR_PNPM_NO_MATCHING_VERSION\]/)
  assert.equal(firstErrorLine('one\ntwo\n'), 'two')
  assert.equal(firstErrorLine(`Error: ${'x'.repeat(400)}`).length, 240)
})

const passing = STEP_COLUMNS.map(([name]) => ({ name, ok: true, note: '', seconds: 1 }))
const row = (version, overrides = {}) => recordRow({
  version, labels: [], date: '2026-11-15 20:00', commit: 'abc1234', inRange: true, declaredRange: '^0.2.2-rc.2', probed: false, results: passing, ...overrides,
})

test('recordRow: cells for passed, failed, skipped and not-run steps, and the notes', () => {
  const results = [
    { name: 'install', ok: true, note: '', seconds: 30 },
    { name: 'typecheck', ok: false, note: 'exit 1', seconds: 5, error: 'src/a.ts(1,2): error TS2339: no | pipe' },
    { name: 'bridge unit tests', ok: true, note: '', seconds: 8, tests: { passed: 604, failed: 0, skipped: 2 } },
    { name: 'extension unit tests', ok: false, note: 'exit 1', seconds: 8, tests: { passed: 10, failed: 3, skipped: 0 }, error: 'AssertionError: nope' },
    { name: 'mcp shim tests', ok: false, note: 'exit 1', seconds: 1, tests: { passed: 16, failed: 0, skipped: 0 }, error: 'Error: Cannot find package x' },
    { name: 'smoke-runtime', ok: false, skipped: true, note: 'skipped (bridge build failed)', seconds: 0 },
  ]
  const cells = row('0.2.2-rc.1', { labels: ['latest'], inRange: false, probed: true, dropped: ['@deepseek-ai/dsh-error'], results })
  assert.deepEqual(cells.slice(0, 5), ['0.2.2-rc.1', 'latest', '2026-11-15 20:00', 'abc1234', 'no'])
  assert.deepEqual(cells.slice(5, 13), [
    'pass', 'not run', 'FAIL (exit 1)', 'pass (604 passed, 2 skipped)', 'FAIL (3 failed, 10 passed)', 'FAIL (exit 1; 16 passed)', 'not run', 'skipped',
  ])
  assert.equal(cells[13], 'not published at 0.2.2-rc.1, removed from the copy: `@deepseek-ai/dsh-error`; '
    + 'outside the declared `engines.dsh` (`^0.2.2-rc.2`): probed with it rewritten to `0.2.2-rc.1` in the copy; '
    + 'typecheck: src/a.ts(1,2): error TS2339: no \\| pipe; extension unit tests: AssertionError: nope; mcp shim tests: Error: Cannot find package x')
})

test('recordRow notes what a passing step said it did not exercise', () => {
  const results = passing.map(result => result.name === 'smoke-runtime' ? { ...result, caveat: 'DSH 0.2.2-rc.1 has no archive-cleanup report: the wait was NOT exercised' } : result)
  const cells = row('0.2.2-rc.1', { results })
  assert.equal(cells[12], 'pass')
  assert.equal(cells[13], 'smoke-runtime passed with a gap: DSH 0.2.2-rc.1 has no archive-cleanup report: the wait was NOT exercised')
})

test('updateRecord replaces the row for a version, keeps the others and the surrounding text', () => {
  const empty = `# Title\n\nintro\n\n${RECORD_BEGIN}\n${RECORD_END}\n\ntrailer\n`
  const first = updateRecord(empty, [row('0.2.2-rc.2'), row('0.2.2-rc.1')])
  const failing = passing.map(result => result.name === 'typecheck' ? { ...result, ok: false, note: 'exit 1', error: 'error TS1: a | b' } : result)
  const second = updateRecord(first, [row('0.2.2-rc.3'), row('0.2.2-rc.1', { date: '2026-11-16 09:00', results: failing })])
  const versions = second.split('\n').filter(line => line.startsWith('| 0.')).map(line => line.split(' | ')[0].slice(2))
  assert.deepEqual(versions, ['0.2.2-rc.3', '0.2.2-rc.2', '0.2.2-rc.1'], 'newest first, one row per version')
  assert.match(second, /\| 0\.2\.2-rc\.1 \| version \| 2026-11-16 09:00 \|/)
  assert.ok(second.startsWith('# Title\n\nintro\n\n') && second.endsWith(`${RECORD_END}\n\ntrailer\n`))
  assert.deepEqual(passedVersions(second), ['0.2.2-rc.3', '0.2.2-rc.2'])
  // A second pass over the same text is stable (escaped pipes survive the round trip).
  assert.equal(updateRecord(second, []), second)
  assert.throws(() => updateRecord('no markers', [row('1.0.0')]), /record has no/)
})

test('the pin row (no install step) counts as passed; a skipped step does not', () => {
  const pin = passing.filter(result => result.name !== 'install')
  const skipped = passing.map(result => result.name === 'smoke-runtime' ? { ...result, ok: false, skipped: true } : result)
  const text = updateRecord(`${RECORD_BEGIN}\n${RECORD_END}\n`, [row('0.2.2-rc.2', { results: pin }), row('0.2.2-rc.3', { results: skipped })])
  assert.deepEqual(passedVersions(text), ['0.2.2-rc.2'])
})

// The declared support, the recorded evidence and the printed hints must agree.
test('supported DSH releases match the recorded matrix, the manifests and the printed hints', () => {
  const support = read('packages/browser/bridge-browser/src/dsh-support.ts')
  const constant = name => new RegExp(`export const ${name}(?:: [^=]+)? = (.+)`, 'u').exec(support)?.[1]
  const defaultVersion = /'([^']+)'/u.exec(constant('DSH_DEFAULT_VERSION'))[1]
  const tested = [...constant('TESTED_DSH_VERSIONS').matchAll(/'([^']+)'/gu)].map(match => match[1])
  const range = /'([^']+)'/u.exec(constant('SUPPORTED_DSH_RANGE'))[1]
  const peerRange = /'([^']+)'/u.exec(constant('DSH_PEER_RANGE'))?.[1] ?? range // declared as the engines range itself

  const rootManifest = JSON.parse(read('package.json'))
  const bridge = JSON.parse(read('packages/browser/bridge-browser/package.json'))
  const dshOnly = map => Object.entries(map).filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/u.test(name))
  for (const [name, version] of [...dshOnly(rootManifest.dependencies), ...dshOnly(bridge.devDependencies)]) {
    assert.equal(version, defaultVersion, `${name}: the lockfile default is one exact release`)
  }
  assert.equal(bridge.engines.dsh, range)
  for (const [name, declared] of dshOnly(bridge.peerDependencies)) assert.equal(declared, peerRange, name)

  const passed = passedVersions(read(DEFAULT_RECORD))
  assert.ok(tested.includes(defaultVersion), 'the default release is a tested one')
  for (const version of tested) {
    assert.ok(passed.includes(version), `${version} is listed as tested but ${DEFAULT_RECORD} has no all-pass row for it`)
    assert.ok(inDeclaredRange(version, range), `engines.dsh ${range} excludes tested ${version}`)
    assert.ok(inDeclaredRange(version, peerRange), `the peer range ${peerRange} excludes tested ${version}`)
  }

  const hint = `npx @deepseek-ai/dsh@${defaultVersion} web`
  for (const path of ['scripts/install.sh', 'scripts/install.ps1', 'README.md', 'README.zh.md', 'packages/browser/bridge-browser/cordis.patch.yml']) {
    const text = read(path)
    const versions = [...text.matchAll(/npx @deepseek-ai\/dsh@(\d\S*) web/gu)].map(match => match[1])
    assert.ok(versions.length > 0, `${path}: no "${hint}" hint`)
    assert.deepEqual([...new Set(versions)], [defaultVersion], `${path}: every start hint names the default release`)
  }
})
