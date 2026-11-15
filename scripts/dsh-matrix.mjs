#!/usr/bin/env node
/**
 * Run the DSH compatibility checks against one or more DSH releases.
 *
 *   node scripts/dsh-matrix.mjs pin                  # the lockfile default in package.json, in place
 *   node scripts/dsh-matrix.mjs latest               # a dist-tag (latest, next, alpha, ...)
 *   node scripts/dsh-matrix.mjs 0.2.2-rc.3           # an exact version
 *   node scripts/dsh-matrix.mjs tested               # the pin and every other release listed as tested
 *   node scripts/dsh-matrix.mjs tested latest next --record   # several rows, written to docs/dsh-matrix.md
 *
 * Non-pin targets run in a temporary copy of the repository (tracked and
 * untracked-but-not-ignored files) where every `@deepseek-ai/dsh*` entry in the
 * root dependencies and the bridge devDependencies is rewritten to the target
 * version, then installed without a frozen lockfile (needs the npm registry).
 * DSH packages that are not published at the target version are removed from
 * the copy and named in the row.
 * The bridge's peerDependencies and `engines.dsh` are left alone: they are the
 * declared contract the matrix is probing. A target outside `engines.dsh` is
 * therefore refused by the DSH host and its smoke fails; pass
 * `--probe-outside-range` to rewrite `engines.dsh` in the copy to the target
 * and measure whether the code itself works there (the row says so).
 *
 * Steps: install, check:runtime (with DSH_EXPECTED_VERSION), typecheck, bridge
 * unit tests, extension unit tests, MCP shim tests, bridge build,
 * smoke-runtime. A Markdown summary is printed and appended to
 * $GITHUB_STEP_SUMMARY when set. Exit code is 1 when any step of any row
 * failed.
 *
 * Options:
 *   --record [file]         write/refresh one row per DSH version in the record
 *                           (default docs/dsh-matrix.md); other rows are kept
 *   --probe-outside-range   see above
 *   --max-workers <n>       vitest workers for the unit suites (default 4)
 *   --keep                  keep the temp copy
 *   --workdir <dir>         parent directory for the copy
 *   --logs <dir>            per-step logs (default .artifacts/dsh-matrix)
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = 'packages/browser/bridge-browser'
const BRIDGE_PACKAGE = '@natgurlain/dsh-bridge-browser'
const EXTENSION_PACKAGE = 'dsh-browser-extension'
const MCP_PACKAGE = '@natgurlain/dsh-browser-mcp'
const DSH_PACKAGE = /^@deepseek-ai\/dsh(?:-|$)/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
export const DEFAULT_RECORD = 'docs/dsh-matrix.md'
export const RECORD_BEGIN = '<!-- dsh-matrix:begin -->'
export const RECORD_END = '<!-- dsh-matrix:end -->'
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu

/** Matrix steps in order; `column` is the record's column heading. */
export const STEP_COLUMNS = [
  ['install', 'Install'],
  ['check:runtime', 'check:runtime'],
  ['typecheck', 'Typecheck'],
  ['bridge unit tests', 'Bridge unit tests'],
  ['extension unit tests', 'Extension unit tests'],
  ['mcp shim tests', 'MCP shim tests'],
  ['bridge build', 'Bridge build'],
  ['smoke-runtime', 'Runtime smoke'],
]
const RECORD_HEADER = ['DSH version', 'Target', 'Run (UTC)', 'Bridge commit', 'In `engines.dsh`', ...STEP_COLUMNS.map(([, column]) => column), 'Notes']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Rewrite DSH entries of one dependency map; returns the names changed. */
export function rewriteDshVersions(dependencies = {}, version) {
  const changed = []
  for (const name of Object.keys(dependencies)) {
    if (DSH_PACKAGE.test(name) && dependencies[name] !== version) {
      dependencies[name] = version
      changed.push(name)
    }
  }
  return changed
}

/** Whether `name@version` is published; a release can predate a package the default version needs. */
async function isPublished(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry lookup for ${name} failed: HTTP ${response.status}`)
  const { versions = {} } = await response.json()
  return Object.hasOwn(versions, version)
}

/**
 * Remove DSH entries that do not exist at `version` (the provider set changes
 * between releases); returns the names removed. The row's notes list them.
 */
export async function dropUnpublished(dependencies = {}, version, published = isPublished) {
  const names = Object.keys(dependencies).filter(name => DSH_PACKAGE.test(name))
  const exists = await Promise.all(names.map(name => published(name, version)))
  const dropped = names.filter((_, index) => !exists[index])
  for (const name of dropped) delete dependencies[name]
  return dropped
}

/** semver from the installed DSH host's dependency tree (the root has no direct dependency on it). */
function loadSemver() {
  const anchor = createRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh/package.json')
  return createRequire(anchor)('semver')
}

/** Whether DSH itself would admit `version` for `range` (it includes prereleases). */
export function inDeclaredRange(version, range, semver = loadSemver()) {
  return typeof range === 'string' && range.trim() !== '' && semver.satisfies(version, range, { includePrerelease: true })
}

async function distTags() {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw new Error(`registry lookup failed: HTTP ${response.status}`)
  const { 'dist-tags': tags = {} } = await response.json()
  return tags
}

/** The releases the bridge declares as tested (TESTED_DSH_VERSIONS in its src/dsh-support.ts). */
export function testedVersions(source = readFileSync(join(root, BRIDGE, 'src', 'dsh-support.ts'), 'utf8')) {
  const list = /export const TESTED_DSH_VERSIONS[^=]*= \[([^\]]*)\]/u.exec(source)
  if (list === null) throw new Error('TESTED_DSH_VERSIONS not found in the bridge src/dsh-support.ts')
  return [...list[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
}

/**
 * Resolve targets to versions, one row per version; `tested` stands for the
 * pin plus every other release the bridge lists as tested; a version named by several
 * targets (the pin and `latest`, say) runs once and carries every label.
 */
export async function resolveTargets(targets, pinned, loadTags = distTags, tested = testedVersions) {
  let tags
  const rows = new Map()
  const expanded = targets.flatMap(target => target === 'tested' ? ['pin', ...tested().filter(version => version !== pinned)] : [target])
  for (const target of expanded) {
    let version
    if (target === 'pin') version = pinned
    else if (EXACT_VERSION.test(target)) version = target
    else {
      tags ??= await loadTags()
      if (!tags[target]) throw new Error(`@deepseek-ai/dsh has no dist-tag "${target}" (have: ${Object.keys(tags).join(', ')})`)
      version = tags[target]
    }
    const row = rows.get(version) ?? { version, labels: [], inPlace: false }
    if (target !== version && !row.labels.includes(target)) row.labels.push(target)
    if (version === pinned) {
      row.inPlace = true
      if (!row.labels.includes('pin')) row.labels.unshift('pin')
    }
    rows.set(version, row)
  }
  return [...rows.values()]
}

function copyRepository(destination) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean)
  for (const file of files) {
    const target = join(destination, file)
    mkdirSync(dirname(target), { recursive: true })
    try {
      cpSync(join(root, file), target)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error // deleted but still tracked
    }
  }
}

export function parseArgs(argv, env = process.env) {
  const options = {
    targets: [], keep: false, workdir: env.RUNNER_TEMP || tmpdir(), record: undefined,
    probeOutsideRange: false, maxWorkers: 4, logs: join(root, '.artifacts', 'dsh-matrix'),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      i += 1
      return next
    }
    if (arg === '--keep') options.keep = true
    else if (arg === '--probe-outside-range') options.probeOutsideRange = true
    else if (arg === '--workdir') options.workdir = resolve(value())
    else if (arg === '--logs') options.logs = resolve(value())
    else if (arg === '--max-workers') {
      options.maxWorkers = Number(value())
      if (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1) throw new Error('--max-workers must be a positive integer')
    } else if (arg === '--record') {
      const next = argv[i + 1]
      // `--record` takes an optional file; a following target is not one.
      if (next !== undefined && /\.(?:md|markdown)$/u.test(next)) { options.record = resolve(next); i += 1 }
      else options.record = join(root, DEFAULT_RECORD)
    } else if (!arg.startsWith('-')) options.targets.push(arg)
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.targets.length === 0) {
    throw new Error('usage: node scripts/dsh-matrix.mjs <pin|tested|dist-tag|version>... [--record [file]] [--probe-outside-range] [--max-workers n] [--keep] [--workdir dir] [--logs dir]')
  }
  return options
}

function summarize(lines) {
  const text = `${lines.join('\n')}\n`
  console.log(`\n${text}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

/** Test totals summed over every vitest / node:test summary in a step's output. */
export function parseTestCounts(output) {
  const text = String(output).replace(ANSI, '')
  const counts = { passed: 0, failed: 0, skipped: 0 }
  let found = false
  for (const line of text.matchAll(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/gmu)) {
    found = true
    const part = name => Number(new RegExp(`(\\d+) ${name}`, 'u').exec(line[1])?.[1] ?? 0)
    counts.passed += part('passed')
    counts.failed += part('failed')
    counts.skipped += part('skipped') + part('todo')
  }
  const sum = pattern => [...text.matchAll(pattern)].reduce((total, match) => total + Number(match[1]), 0)
  if (/^[ℹ#] tests \d+$/mu.test(text)) {
    found = true
    counts.passed += sum(/^[ℹ#] pass (\d+)$/gmu)
    counts.failed += sum(/^[ℹ#] fail (\d+)$/gmu) + sum(/^[ℹ#] cancelled (\d+)$/gmu)
    counts.skipped += sum(/^[ℹ#] skipped (\d+)$/gmu) + sum(/^[ℹ#] todo (\d+)$/gmu)
  }
  return found ? counts : undefined
}

/** The most telling line of a failed step's output, for the record's notes. */
export function firstErrorLine(output) {
  const lines = String(output).replace(ANSI, '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const patterns = [
    /error TS\d+/u,
    /is incompatible with dsh/u,
    /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b/u,
    /ERR_PNPM_(?!RECURSIVE_)\w+/u, // the recursive-run wrapper only repeats the command
    /\bError: /u,
    /\berror\b/iu,
  ]
  for (const pattern of patterns) {
    const hit = lines.find(line => pattern.test(line))
    if (hit !== undefined) return hit.length > 240 ? `${hit.slice(0, 237)}...` : hit
  }
  return lines.at(-1) ?? ''
}

function cell(text) {
  return String(text).replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim()
}

function stepCell(result) {
  if (result === undefined) return 'not run'
  if (result.skipped) return 'skipped'
  const tests = result.tests
  if (result.ok) return tests === undefined ? 'pass' : `pass (${tests.passed} passed${tests.skipped > 0 ? `, ${tests.skipped} skipped` : ''})`
  return tests === undefined ? `FAIL (${result.note})` : `FAIL (${tests.failed} failed, ${tests.passed} passed)`
}

/** One record row (an array of cells, in RECORD_HEADER order) for a finished matrix row. */
export function recordRow({ version, labels, date, commit, inRange, declaredRange, probed, dropped = [], results }) {
  const notes = []
  if (dropped.length > 0) notes.push(`not published at ${version}, removed from the copy: ${dropped.map(name => `\`${name}\``).join(', ')}`)
  if (probed) notes.push(`outside the declared \`engines.dsh\` (\`${declaredRange}\`): probed with it rewritten to \`${version}\` in the copy`)
  for (const result of results) {
    if (!result.ok && !result.skipped && result.error) notes.push(`${result.name}: ${result.error}`)
  }
  return [
    version,
    labels.length > 0 ? labels.join(', ') : 'version',
    date,
    commit,
    inRange ? 'yes' : 'no',
    ...STEP_COLUMNS.map(([name]) => stepCell(results.find(result => result.name === name))),
    notes.join('; '),
  ].map(cell)
}

function splitRow(line) {
  return line.replace(/^\|/u, '').replace(/\|\s*$/u, '').split(/(?<!\\)\|/u).map(part => part.trim())
}

/**
 * Put `rows` into the record's table, replacing rows for the same DSH version
 * and keeping every other row and everything outside the markers. Rows are
 * ordered newest DSH version first.
 */
export function updateRecord(existing, rows, semver = loadSemver()) {
  const begin = existing.indexOf(RECORD_BEGIN)
  const end = existing.indexOf(RECORD_END)
  if (begin === -1 || end === -1 || end < begin) throw new Error(`record has no ${RECORD_BEGIN} ... ${RECORD_END} block`)
  const kept = existing.slice(begin + RECORD_BEGIN.length, end).split('\n')
    .filter(line => line.startsWith('|')).slice(2).map(splitRow)
    .filter(row => !rows.some(next => next[0] === row[0]))
  const all = [...kept, ...rows].sort((a, b) => semver.rcompare(a[0], b[0]))
  const table = [
    `| ${RECORD_HEADER.join(' | ')} |`,
    `| ${RECORD_HEADER.map(() => '---').join(' | ')} |`,
    ...all.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
  return `${existing.slice(0, begin)}${RECORD_BEGIN}\n${table}\n${existing.slice(end)}`
}

/** Versions whose recorded row passed every step, read from a record's text. */
export function passedVersions(record) {
  const begin = record.indexOf(RECORD_BEGIN)
  const end = record.indexOf(RECORD_END)
  if (begin === -1 || end === -1) return []
  const first = RECORD_HEADER.indexOf(STEP_COLUMNS[0][1])
  return record.slice(begin, end).split('\n').filter(line => line.startsWith('|')).slice(2).map(splitRow)
    .filter(row => row.slice(first, first + STEP_COLUMNS.length).every((value, index) => value.startsWith('pass') || (index === 0 && value === 'not run')))
    .map(row => row[0])
}

const RECORD_TEMPLATE = `# DSH compatibility matrix

One row per DSH release the bridge was run against. The table is written by
\`node scripts/dsh-matrix.mjs <targets> --record\`; edit the text around it, not
the rows.

${RECORD_BEGIN}
${RECORD_END}
`

function run(command, args, { cwd, env, log }) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    const chunks = []
    const take = stream => (chunk) => { chunks.push(chunk); stream.write(chunk) }
    child.stdout.on('data', take(process.stdout))
    child.stderr.on('data', take(process.stderr))
    const finish = (code, note) => {
      const output = Buffer.concat(chunks).toString('utf8')
      mkdirSync(dirname(log), { recursive: true })
      writeFileSync(log, output)
      done({ code, note, output, seconds: Math.round((Date.now() - started) / 1000) })
    }
    child.on('error', error => finish(null, error.message))
    child.on('close', (code, signal) => finish(code, code === 0 ? '' : `exit ${code ?? signal}`))
  })
}

async function runRow(row, options, pinned) {
  const { version, labels, inPlace } = row
  const heading = `### DSH ${version}${labels.length > 0 ? ` (${labels.join(', ')})` : ''}${inPlace ? '' : ` — default: ${pinned}`}`
  const declaredRange = readJson(join(root, BRIDGE, 'package.json')).engines?.dsh
  const inRange = inDeclaredRange(version, declaredRange)
  const probed = !inPlace && !inRange && options.probeOutsideRange

  let cwd = root
  let temp
  let dropped = []
  if (!inPlace) {
    mkdirSync(options.workdir, { recursive: true })
    temp = mkdtempSync(join(options.workdir, `dsh-matrix-${version}-`))
    copyRepository(temp)
    cwd = temp
    const rootManifest = readJson(join(cwd, 'package.json'))
    const bridgeManifest = readJson(join(cwd, BRIDGE, 'package.json'))
    const changed = [
      ...rewriteDshVersions(rootManifest.dependencies, version),
      ...rewriteDshVersions(bridgeManifest.devDependencies, version),
    ]
    dropped = [
      ...await dropUnpublished(rootManifest.dependencies, version),
      ...await dropUnpublished(bridgeManifest.devDependencies, version),
    ]
    if (dropped.length > 0) console.log(`Not published at ${version}, removed from the copy: ${dropped.join(', ')}`)
    if (probed) bridgeManifest.engines.dsh = version
    writeJson(join(cwd, 'package.json'), rootManifest)
    writeJson(join(cwd, BRIDGE, 'package.json'), bridgeManifest)
    console.log(`Rewrote ${changed.length} DSH dependency entries to ${version} in ${cwd}`)
    if (probed) console.log(`engines.dsh "${declaredRange}" excludes ${version}; rewritten to "${version}" in the copy (--probe-outside-range)`)
  }

  const env = {
    ...process.env,
    DSH_EXPECTED_VERSION: version,
    // manifest.spec.ts compares engines.dsh with the declared range; the probe changed it on purpose.
    ...probed ? { DSH_MATRIX_ENGINES_OVERRIDE: version } : {},
  }
  const workers = `--maxWorkers=${options.maxWorkers}`
  const steps = [
    ...(temp ? [['install', 'pnpm', ['install', '--no-frozen-lockfile']]] : []),
    ['check:runtime', 'node', ['scripts/check-runtime.mjs']],
    ['typecheck', 'pnpm', ['run', 'typecheck']],
    ['bridge unit tests', 'pnpm', ['--filter', BRIDGE_PACKAGE, 'exec', 'vitest', 'run', workers]],
    ['extension unit tests', 'pnpm', ['--filter', EXTENSION_PACKAGE, 'exec', 'vitest', 'run', workers]],
    ['mcp shim tests', 'pnpm', ['--filter', MCP_PACKAGE, 'run', 'test']],
    ['bridge build', 'pnpm', ['--filter', BRIDGE_PACKAGE, 'run', 'build']],
    ['smoke-runtime', 'node', ['scripts/smoke-runtime.mjs']],
  ]
  const results = []
  const ci = process.env.GITHUB_ACTIONS === 'true'
  for (const [name, command, args] of steps) {
    const blocker = results.find(r => !r.ok && (r.name === 'install' || (name === 'smoke-runtime' && r.name === 'bridge build')))
    if (blocker) {
      results.push({ name, ok: false, skipped: true, note: `skipped (${blocker.name} failed)`, seconds: 0 })
      continue
    }
    if (ci) console.log(`::group::${name}`)
    else console.log(`\n=== DSH ${version} · ${name}: ${command} ${args.join(' ')}`)
    const log = join(options.logs, version, `${name.replace(/[^a-z0-9]+/giu, '-')}.log`)
    const outcome = await run(command, args, { cwd, env, log })
    if (ci) console.log('::endgroup::')
    const ok = outcome.code === 0
    results.push({
      name, ok, note: outcome.note, seconds: outcome.seconds,
      tests: /tests$/u.test(name) ? parseTestCounts(outcome.output) : undefined,
      error: ok ? '' : firstErrorLine(outcome.output),
    })
    if (!ok && ci) console.log(`::warning title=DSH ${version}::${name} failed`)
  }

  if (temp && !options.keep) rmSync(temp, { recursive: true, force: true })
  else if (temp) console.log(`Kept ${temp}`)

  summarize([
    heading, '',
    `Declared \`engines.dsh\`: \`${declaredRange}\` — ${inRange ? 'admits' : 'excludes'} ${version}${probed ? ' (probed with it rewritten in the copy)' : ''}`, '',
    '| step | result | time |', '| --- | --- | --- |',
    ...results.map(r => `| ${r.name} | ${r.ok ? stepCell(r) : r.skipped ? r.note : `**FAIL** ${r.note}${r.error ? ` — ${cell(r.error)}` : ''}`} | ${r.seconds}s |`),
  ])
  return { version, labels, inRange, declaredRange, probed, dropped, results }
}

function commitLabel() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString('utf8').trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString('utf8').trim() !== ''
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return 'unknown'
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pinned = readJson(join(root, 'package.json')).dependencies['@deepseek-ai/dsh']
  const rows = await resolveTargets(options.targets, pinned)
  const commit = commitLabel()
  let failed = false
  for (const row of rows) {
    const outcome = await runRow(row, options, pinned)
    if (!outcome.results.every(r => r.ok)) failed = true
    if (options.record !== undefined) {
      const existing = existsSync(options.record) ? readFileSync(options.record, 'utf8') : RECORD_TEMPLATE
      const date = new Date().toISOString().slice(0, 16).replace('T', ' ')
      mkdirSync(dirname(options.record), { recursive: true })
      // Written after every row, so an interrupted run keeps what it finished.
      writeFileSync(options.record, updateRecord(existing, [recordRow({ ...outcome, date, commit })]))
      console.log(`Recorded DSH ${row.version} in ${options.record}`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), (error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
