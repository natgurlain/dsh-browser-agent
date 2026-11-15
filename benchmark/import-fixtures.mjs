#!/usr/bin/env node
/**
 * Turn failure-flywheel fixtures into benchmark tasks.
 *
 *   node benchmark/import-fixtures.mjs <workspace>/browser-fixtures [--out benchmark/fixture-tasks]
 *
 * Each fixture becomes `<out>/<id>/task.json` plus its page capture; existing
 * tasks are never overwritten. `startBenchmarkSite({ fixtureDir })` serves DOM
 * captures at `/fixture/<id>` and `validateFixtureTask` (lib/fixture-tasks.mjs)
 * checks a run's tool calls, but no runner uses them yet: `run.mjs` has no
 * fixture option, so these tasks are not part of the paired benchmark.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importFixtures } from './lib/fixture-tasks.mjs'

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))

export function parseImportArgs(argv) {
  const options = { source: undefined, out: join(benchmarkRoot, 'fixture-tasks') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = resolve(argv[++index] ?? '')
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (options.source === undefined) options.source = resolve(arg)
    else throw new Error(`unexpected argument: ${arg}`)
  }
  return options
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseImportArgs(process.argv.slice(2))
  if (options.help === true || options.source === undefined) {
    console.log('usage: node benchmark/import-fixtures.mjs <browser-fixtures dir> [--out <dir>]')
    process.exit(options.help === true ? 0 : 2)
  }
  const result = await importFixtures(options.source, options.out)
  console.log(`imported ${String(result.imported.length)}, skipped ${String(result.skipped.length)} existing, ${String(result.errors.length)} error(s) → ${options.out}`)
  for (const error of result.errors) console.error(`  ${error.file}: ${error.message}`)
  process.exitCode = result.errors.length > 0 ? 1 : 0
}
