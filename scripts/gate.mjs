#!/usr/bin/env node
/**
 * The local gate: every check the phase gates rest on, in one command.
 *
 *   pnpm gate                         # everything; needs a Playwright Chromium
 *   pnpm gate --skip-browser          # machines without Chromium
 *   pnpm gate --output out/gate.json  # where the machine-readable result goes
 *   pnpm gate --only typecheck,unit-bridge
 *   pnpm gate --list
 *
 * Steps run one after another (never in parallel: the extension's background
 * specs time out on an oversubscribed machine), every step runs even after a
 * failure so one run reports everything, and a step whose prerequisite failed
 * is skipped rather than reported as its own failure. The exit code is 1 when
 * any step failed or nothing ran. `.github/workflows/ci.yml` runs this same
 * script; GitHub Actions has never run for this repository, so this command is
 * the gate.
 *
 * Result file (default `.artifacts/gate/result.json`): commit, date, and per
 * step its status, exit code, duration and test counts. Each step's output is
 * kept next to it as `<step>.log`.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = '@natgurlain/dsh-bridge-browser'
const EXTENSION = 'dsh-browser-extension'
const MCP = '@natgurlain/dsh-browser-mcp'
export const DEFAULT_MAX_WORKERS = 4
const DEFAULT_STEP_TIMEOUT_MS = 30 * 60_000

/**
 * The gate, in order. `needs` lists steps that must have passed; `browser`
 * marks steps that launch Chromium; `counts` names the parser for the step's
 * test totals.
 */
export function gateSteps({ maxWorkers = DEFAULT_MAX_WORKERS, outputDir = join(root, '.artifacts', 'gate') } = {}) {
  const workers = `--maxWorkers=${maxWorkers}`
  return [
    { id: 'install', title: 'Frozen lockfile install', command: ['pnpm', 'install', '--frozen-lockfile'] },
    { id: 'check-runtime', title: 'DSH pin and lockfile check', command: ['pnpm', 'run', 'check:runtime'], needs: ['install'] },
    { id: 'typecheck', title: 'Typecheck (all packages)', command: ['pnpm', '-r', 'typecheck'], needs: ['install'] },
    { id: 'unit-bridge', title: 'Bridge unit tests', command: ['pnpm', '--filter', BRIDGE, 'exec', 'vitest', 'run', workers], needs: ['install'], counts: 'vitest' },
    { id: 'unit-extension', title: 'Extension unit tests', command: ['pnpm', '--filter', EXTENSION, 'exec', 'vitest', 'run', workers], needs: ['install'], counts: 'vitest' },
    { id: 'unit-mcp', title: 'MCP shim tests', command: ['pnpm', '--filter', MCP, 'run', 'test'], needs: ['install'], counts: 'node-test' },
    // Built before the script tests and smokes: they load the bridge lib/ and the extension dist/.
    { id: 'build', title: 'Build bridge and Chrome extension', command: ['pnpm', 'build'], needs: ['install'] },
    { id: 'build-firefox', title: 'Build Firefox extension', command: ['pnpm', '--filter', EXTENSION, 'run', 'build:firefox'], needs: ['install'] },
    { id: 'test-scripts', title: 'Script tests (installer, uninstall, release, gate)', command: ['pnpm', 'test:scripts'], needs: ['build'], counts: 'node-test' },
    { id: 'test-benchmark', title: 'Benchmark harness tests', command: ['pnpm', 'test:benchmark'], needs: ['install'], counts: 'node-test' },
    // Real DSH host, no browser. Includes the MCP (fixtures/mcp-smoke.mjs) and dev-loop (fixtures/devloop-smoke.mjs) smokes.
    { id: 'smoke-runtime', title: 'Runtime smoke (real DSH host, MCP, dev loop)', command: ['pnpm', 'test:smoke'], needs: ['build'] },
    { id: 'smoke-browser', title: 'Browser smoke (real DSH + Chromium)', command: ['pnpm', 'test:browser'], needs: ['build'], browser: true, counts: 'smoke-browser' },
    {
      id: 'model-free',
      title: 'Injection canaries and dialog task (scripted agent, real extension)',
      command: ['node', 'benchmark/model-free-check.mjs', '--output', join(outputDir, 'model-free-check.json')],
      needs: ['build'],
      browser: true,
      counts: 'model-free',
    },
    { id: 'smoke-uninstall-ui', title: 'Uninstall settings UI smoke (Chromium)', command: ['pnpm', 'test:uninstall:ui'], needs: ['build'], browser: true, counts: 'smoke-uninstall-ui' },
  ]
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu

/**
 * Test totals from a step's output, or undefined when the output has none.
 * @param {'vitest' | 'node-test' | 'smoke-browser' | 'model-free' | 'smoke-uninstall-ui'} kind
 */
export function parseCounts(kind, output) {
  const text = String(output).replace(ANSI, '')
  const number = (pattern) => {
    const matches = [...text.matchAll(pattern)]
    return matches.length === 0 ? undefined : Number(matches.at(-1)[1])
  }
  if (kind === 'vitest') {
    // "      Tests  2 failed | 1570 passed | 3 skipped (1575)"
    const line = [...text.matchAll(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/gmu)].at(-1)
    if (line === undefined) return undefined
    const part = (name) => Number(new RegExp(`(\\d+) ${name}`, 'u').exec(line[1])?.[1] ?? 0)
    return { total: Number(line[2]), passed: part('passed'), failed: part('failed'), skipped: part('skipped') + part('todo') }
  }
  if (kind === 'node-test') {
    // The spec reporter prints "ℹ tests 12", TAP prints "# tests 12".
    const total = number(/^[ℹ#] tests (\d+)$/gmu)
    if (total === undefined) return undefined
    return {
      total,
      passed: number(/^[ℹ#] pass (\d+)$/gmu) ?? 0,
      failed: (number(/^[ℹ#] fail (\d+)$/gmu) ?? 0) + (number(/^[ℹ#] cancelled (\d+)$/gmu) ?? 0),
      skipped: (number(/^[ℹ#] skipped (\d+)$/gmu) ?? 0) + (number(/^[ℹ#] todo (\d+)$/gmu) ?? 0),
    }
  }
  if (kind === 'smoke-browser') {
    // One line listing every verified behaviour, separated by "; ".
    const line = /^Browser smoke passed: (.+)$/mu.exec(text)
    if (line === null) return undefined
    const total = line[1].split('; ').length
    return { total, passed: total, failed: 0, skipped: 0 }
  }
  if (kind === 'model-free') {
    const line = /^model-free check: (\d+) passed, (\d+) failed/mu.exec(text)
    if (line === null) return undefined
    return { total: Number(line[1]) + Number(line[2]), passed: Number(line[1]), failed: Number(line[2]), skipped: 0 }
  }
  if (kind === 'smoke-uninstall-ui') {
    const total = number(/^Uninstall UI passed: (\d+) cases/gmu)
    return total === undefined ? undefined : { total, passed: total, failed: 0, skipped: 0 }
  }
  return undefined
}

export function parseArgs(args) {
  const options = { skipBrowser: false, maxWorkers: DEFAULT_MAX_WORKERS, list: false, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = () => {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`)
      index += 1
      return next
    }
    if (flag === '--skip-browser') options.skipBrowser = true
    else if (flag === '--list') options.list = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--output') options.output = resolve(value())
    else if (flag === '--only') options.only = value().split(',').filter(Boolean)
    else if (flag === '--max-workers') {
      options.maxWorkers = Number(value())
      if (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1) throw new Error('--max-workers must be a positive integer')
    } else throw new Error(`unknown option: ${flag}`)
  }
  return options
}

/**
 * Run the steps in order.
 * @param {object} input
 * @param {ReturnType<typeof gateSteps>} input.steps
 * @param {(step: object) => Promise<{ code: number | null, output: string, durationMs: number, timedOut?: boolean }>} input.run
 * @param {boolean} [input.skipBrowser]
 * @param {string[]} [input.only] - step ids to run; the others are reported as skipped.
 * @returns the per-step results, in order.
 */
export async function runSteps({ steps, run, skipBrowser = false, only }) {
  if (only !== undefined) {
    const unknown = only.filter((id) => !steps.some((step) => step.id === id))
    if (unknown.length > 0) throw new Error(`unknown step(s): ${unknown.join(', ')}; known: ${steps.map((step) => step.id).join(', ')}`)
  }
  const results = []
  const status = new Map()
  for (const step of steps) {
    const base = { id: step.id, title: step.title, command: step.command.join(' ') }
    let skipped
    if (only !== undefined && !only.includes(step.id)) skipped = 'not selected (--only)'
    else if (skipBrowser && step.browser === true) skipped = 'needs Chromium (--skip-browser)'
    else {
      // A prerequisite left out by --only is the caller's choice; one that failed or was skipped for cause is not.
      const blocker = (step.needs ?? []).find((id) => status.get(id) !== 'passed' && !(only !== undefined && !only.includes(id)))
      if (blocker !== undefined) skipped = `needs ${blocker}, which ${status.get(blocker) === 'failed' ? 'failed' : 'did not run'}`
    }
    if (skipped !== undefined) {
      status.set(step.id, 'skipped')
      results.push({ ...base, status: 'skipped', reason: skipped })
      continue
    }
    const outcome = await run(step)
    const tests = step.counts === undefined ? undefined : parseCounts(step.counts, outcome.output)
    const passed = outcome.code === 0
    status.set(step.id, passed ? 'passed' : 'failed')
    results.push({
      ...base,
      status: passed ? 'passed' : 'failed',
      exitCode: outcome.code,
      durationMs: Math.round(outcome.durationMs),
      ...outcome.timedOut === true ? { reason: 'timed out' } : {},
      ...tests === undefined ? {} : { tests },
    })
  }
  return results
}

/** The gate passes only when something ran and nothing that ran failed. */
export function summarize(results) {
  const count = (status) => results.filter((result) => result.status === status).length
  const tests = { total: 0, passed: 0, failed: 0, skipped: 0 }
  for (const result of results) {
    for (const key of Object.keys(tests)) tests[key] += result.tests?.[key] ?? 0
  }
  return { ok: count('failed') === 0 && count('passed') > 0, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), tests }
}

function duration(ms) {
  if (ms === undefined) return ''
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

/** The pass/fail table printed at the end of a run. */
export function formatSummary(results) {
  const rows = results.map((result) => [
    result.status === 'passed' ? 'PASS' : result.status === 'failed' ? 'FAIL' : 'SKIP',
    result.id,
    duration(result.durationMs),
    result.tests === undefined
      ? ''
      : `${result.tests.passed}/${result.tests.total}${result.tests.failed > 0 ? `, ${result.tests.failed} failed` : ''}${result.tests.skipped > 0 ? `, ${result.tests.skipped} skipped` : ''}`,
    result.reason ?? (result.status === 'failed' ? `exit ${result.exitCode}` : ''),
  ])
  const header = ['', 'step', 'time', 'tests', 'note']
  const widths = header.map((_, column) => Math.max(header[column].length, ...rows.map((row) => row[column].length)))
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()
  const totals = summarize(results)
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
    `${totals.ok ? 'GATE PASSED' : 'GATE FAILED'}: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped; tests ${totals.tests.passed}/${totals.tests.total} passed${totals.tests.failed > 0 ? `, ${totals.tests.failed} failed` : ''}`,
  ].join('\n')
}

/** The machine-readable result. */
export function buildResult({ results, commit, startedAt, finishedAt, options }) {
  return {
    schemaVersion: 1,
    ...commit,
    date: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    skipBrowser: options.skipBrowser === true,
    ...options.only === undefined ? {} : { only: options.only },
    maxWorkers: options.maxWorkers,
    ...summarize(results),
    steps: results,
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function commitInfo() {
  const status = git(['status', '--porcelain'])
  return {
    commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
    // Uncommitted changes mean the result does not describe the commit alone.
    dirty: status === undefined ? undefined : status !== '',
  }
}

/** Run one step's command, echoing its output and keeping it in `<logDir>/<id>.log`. */
function spawnStep(step, { logDir, env, timeoutMs = DEFAULT_STEP_TIMEOUT_MS }) {
  return new Promise((resolveStep) => {
    const started = Date.now()
    const log = createWriteStream(join(logDir, `${step.id}.log`))
    const [command, ...args] = step.command
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    let timedOut = false
    const onData = (stream) => (chunk) => {
      output += chunk
      log.write(chunk)
      stream.write(chunk)
    }
    child.stdout.on('data', onData(process.stdout))
    child.stderr.on('data', onData(process.stderr))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (code) => {
      clearTimeout(timer)
      log.end(() => resolveStep({ code, output, durationMs: Date.now() - started, timedOut }))
    }
    child.on('error', (error) => {
      output += `\n${error.message}\n`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

function usage(steps) {
  return [
    'Usage: pnpm gate [--skip-browser] [--output <file>] [--only <id,id>] [--max-workers <n>] [--list]',
    '',
    'Steps, in order (* needs Chromium):',
    ...steps.map((step) => `  ${step.browser === true ? '*' : ' '} ${step.id.padEnd(20)} ${step.title}`),
  ].join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const output = options.output ?? join(root, '.artifacts', 'gate', 'result.json')
  const outputDir = dirname(output)
  const steps = gateSteps({ maxWorkers: options.maxWorkers, outputDir })
  if (options.help || options.list) {
    console.log(usage(steps))
    return
  }
  await mkdir(outputDir, { recursive: true })
  const env = {
    ...process.env,
    // Plain output keeps the logs and the test-count parsers stable.
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    // Chromium aborts when its profile socket path is too long; default to a short root.
    DSH_SMOKE_ARTIFACTS: process.env.DSH_SMOKE_ARTIFACTS ?? join(tmpdir(), 'dshgate'),
  }
  const startedAt = new Date()
  const results = await runSteps({
    steps,
    skipBrowser: options.skipBrowser,
    only: options.only,
    run: (step) => {
      console.log(`\n=== gate: ${step.id} — ${step.command.join(' ')} ===`)
      return spawnStep(step, { logDir: outputDir, env })
    },
  })
  const result = buildResult({ results, commit: commitInfo(), startedAt, finishedAt: new Date(), options })
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`\n${formatSummary(results)}`)
  console.log(`commit ${result.commit}${result.dirty === true ? ' (with uncommitted changes)' : ''}; result: ${output}`)
  if (!result.ok) process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
