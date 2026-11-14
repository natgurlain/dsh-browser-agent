#!/usr/bin/env node
/**
 * Run the DSH compatibility checks against one DSH release.
 *
 *   node scripts/dsh-matrix.mjs pin        # the exact pin in package.json, in place
 *   node scripts/dsh-matrix.mjs latest     # a dist-tag (latest, next, alpha, ...)
 *   node scripts/dsh-matrix.mjs 0.2.2-rc.3 # an exact version
 *
 * Non-pin targets run in a temporary copy of the repository (tracked and
 * untracked-but-not-ignored files) where every `@deepseek-ai/dsh*` entry in the
 * root dependencies and the bridge devDependencies is rewritten to the target
 * version, then installed without a frozen lockfile. The bridge's
 * peerDependencies/engines are left alone: they are the declared contract the
 * matrix is probing, and the pin itself is not widened here.
 *
 * Steps: install, check:runtime (with DSH_EXPECTED_VERSION), typecheck, unit
 * tests, bridge build, smoke-runtime. A Markdown summary is printed and
 * appended to $GITHUB_STEP_SUMMARY when set. Exit code is 1 when any step
 * failed; CI marks non-pin rows continue-on-error so they report, not block.
 *
 * Options: --keep (keep the temp copy), --workdir <dir> (parent for the copy).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const BRIDGE = 'packages/browser/bridge-browser'
const DSH_PACKAGE = /^@deepseek-ai\/dsh(?:-|$)/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

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

async function resolveTarget(target, pinned) {
  if (target === 'pin') return pinned
  if (EXACT_VERSION.test(target)) return target
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw new Error(`registry lookup failed: HTTP ${response.status}`)
  const { 'dist-tags': tags = {} } = await response.json()
  if (!tags[target]) throw new Error(`@deepseek-ai/dsh has no dist-tag "${target}" (have: ${Object.keys(tags).join(', ')})`)
  return tags[target]
}

function copyRepository(destination) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
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

function parseArgs(argv) {
  const options = { target: '', keep: false, workdir: process.env.RUNNER_TEMP || tmpdir() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep') options.keep = true
    else if (arg === '--workdir') options.workdir = resolve(argv[++i])
    else if (!arg.startsWith('-') && !options.target) options.target = arg
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.target) throw new Error('usage: node scripts/dsh-matrix.mjs <pin|dist-tag|version> [--keep] [--workdir dir]')
  return options
}

function summarize(lines) {
  const text = `${lines.join('\n')}\n`
  console.log(`\n${text}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pinned = readJson(join(root, 'package.json')).dependencies['@deepseek-ai/dsh']
  const version = await resolveTarget(options.target, pinned)
  const heading = `### DSH ${options.target} → ${version}${options.target === 'pin' ? '' : ` (pin: ${pinned})`}`

  if (options.target !== 'pin' && version === pinned) {
    summarize([heading, '', `\`${options.target}\` resolves to the pin; covered by the pin row, skipped.`])
    return 0
  }

  let cwd = root
  let temp
  if (options.target !== 'pin') {
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
    writeJson(join(cwd, 'package.json'), rootManifest)
    writeJson(join(cwd, BRIDGE, 'package.json'), bridgeManifest)
    console.log(`Rewrote ${changed.length} DSH dependency entries to ${version} in ${cwd}`)
  }

  const env = { ...process.env, DSH_EXPECTED_VERSION: version }
  const steps = [
    ...(temp ? [['install', 'pnpm', ['install', '--no-frozen-lockfile']]] : []),
    ['check:runtime', 'node', ['scripts/check-runtime.mjs']],
    ['typecheck', 'pnpm', ['run', 'typecheck']],
    ['unit tests', 'pnpm', ['run', 'test']],
    ['bridge build', 'pnpm', ['--filter', '@natgurlain/dsh-bridge-browser', 'run', 'build']],
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
    else console.log(`\n=== ${name}: ${command} ${args.join(' ')}`)
    const started = Date.now()
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
    if (ci) console.log('::endgroup::')
    const ok = result.status === 0
    results.push({ name, ok, note: ok ? '' : `exit ${result.status ?? result.signal}`, seconds: Math.round((Date.now() - started) / 1000) })
    if (!ok && ci) console.log(`::warning title=DSH ${version}::${name} failed`)
  }

  if (temp && !options.keep) rmSync(temp, { recursive: true, force: true })
  else if (temp) console.log(`Kept ${temp}`)

  summarize([
    heading, '',
    '| step | result | time |', '| --- | --- | --- |',
    ...results.map(r => `| ${r.name} | ${r.ok ? 'pass' : r.skipped ? r.note : `**FAIL** ${r.note}`} | ${r.seconds}s |`),
  ])
  return results.every(r => r.ok) ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), (error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
