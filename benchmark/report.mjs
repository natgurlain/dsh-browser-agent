import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapGeometricMeanCI, geometricMean, mean, summarize } from './lib/statistics.mjs'
import { TASK_CATALOG } from './lib/tasks.mjs'

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const taskNames = new Map(TASK_CATALOG.map((task) => [task.id, task.name]))

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '—'
}

function percent(numerator, denominator) {
  return denominator === 0 ? '—' : `${fixed(numerator / denominator * 100, 1)}%`
}

function groupBy(values, keyOf) {
  const groups = new Map()
  for (const value of values) {
    const key = keyOf(value)
    groups.set(key, [...groups.get(key) ?? [], value])
  }
  return groups
}

function token(record, key) {
  const value = record.tokens?.[key]
  return Number.isFinite(value) ? value : 0
}

function promptTokens(record) {
  return token(record, 'inputTokens') + token(record, 'cacheReadTokens') + token(record, 'cacheWriteTokens')
}

function summaryRow(label, records) {
  const successful = records.filter((record) => record.success === true)
  const durations = summarize(successful.map((record) => record.timings?.completionMs))
  return [
    label,
    records.length,
    successful.length,
    percent(successful.length, records.length),
    fixed(durations.p50),
    durations.n >= 10 ? fixed(durations.p90) : '—',
    fixed(durations.mean),
    fixed(mean(successful.map((record) => record.tools?.count))),
    fixed(mean(successful.map(promptTokens))),
    fixed(mean(successful.map((record) => token(record, 'outputTokens')))),
  ]
}

function phaseRow(label, records) {
  const successful = records.filter((record) => record.success === true)
  return [
    label,
    successful.length,
    fixed(mean(successful.map((record) => record.timings?.ttftMs))),
    fixed(mean(successful.map((record) => record.timings?.stateReachedMs))),
    fixed(mean(successful.map((record) => record.timings?.llmMs))),
    fixed(mean(successful.map((record) => record.timings?.toolWallMs))),
    fixed(mean(successful.map((record) => record.tools?.count))),
    fixed(mean(successful.map((record) => token(record, 'inputTokens')))),
    fixed(mean(successful.map((record) => token(record, 'cacheReadTokens')))),
    fixed(mean(successful.map((record) => token(record, 'cacheWriteTokens')))),
    fixed(mean(successful.map((record) => token(record, 'outputTokens')))),
  ]
}

function escapeCell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replace(/\r?\n/gu, ' ')
}

function table(headers, rows) {
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n')
}

function pairKey(record) {
  const logicalPair = record.pairId ?? `${record.taskId}:${record.seed}:${record.trial ?? 1}`
  return `${record.benchmarkId ?? '(missing benchmark ID)'}\u0000${logicalPair}`
}

function effectiveDuration(record) {
  const duration = record.timings?.completionMs
  if (record.success === true && Number.isFinite(duration) && duration > 0) return duration
  const timeout = Number.isFinite(record.timeoutMs) && record.timeoutMs > 0 ? record.timeoutMs : 120_000
  return timeout * 2
}

function pairedAnalysis(records) {
  const pairs = groupBy(records, pairKey)
  const taskRatios = new Map()
  const taskPenalized = new Map()
  const taskCounts = new Map()
  const orderRatios = new Map()
  const warnings = []

  for (const [identifier, pair] of pairs) {
    const playwrightRecords = pair.filter((record) => record.backend === 'playwright')
    const extensionRecords = pair.filter((record) => record.backend === 'extension')
    if (playwrightRecords.length > 1 || extensionRecords.length > 1) {
      warnings.push(`Pair ${identifier.replace('\u0000', ' / ')} has duplicate backend records; skipped.`)
      continue
    }
    const playwright = playwrightRecords[0]
    const extension = extensionRecords[0]
    if (playwright === undefined || extension === undefined) continue
    if (playwright.taskId !== extension.taskId) {
      warnings.push(`Pair ${identifier.replace('\u0000', ' / ')} has mismatched taskId values; skipped.`)
      continue
    }

    const taskId = playwright.taskId
    const counts = taskCounts.get(taskId) ?? {
      pairs: 0,
      bothSuccess: 0,
      playwrightOnly: 0,
      extensionOnly: 0,
      bothFailed: 0,
    }
    counts.pairs += 1
    if (playwright.success && extension.success) counts.bothSuccess += 1
    else if (playwright.success) counts.playwrightOnly += 1
    else if (extension.success) counts.extensionOnly += 1
    else counts.bothFailed += 1

    const playwrightDuration = playwright.timings?.completionMs
    const extensionDuration = extension.timings?.completionMs
    if (playwright.success && extension.success && playwrightDuration > 0 && extensionDuration > 0) {
      const ratio = playwrightDuration / extensionDuration
      taskRatios.set(taskId, [...taskRatios.get(taskId) ?? [], ratio])
      if (extension.pairOrder === 1 || extension.pairOrder === 2) {
        orderRatios.set(extension.pairOrder, [...orderRatios.get(extension.pairOrder) ?? [], ratio])
      }
    }
    taskPenalized.set(taskId, [
      ...taskPenalized.get(taskId) ?? [],
      effectiveDuration(playwright) / effectiveDuration(extension),
    ])
    taskCounts.set(taskId, counts)
  }

  const rows = [...taskCounts.keys()].sort().map((taskId) => {
    const ratios = taskRatios.get(taskId) ?? []
    const counts = taskCounts.get(taskId)
    return [
      taskNames.get(taskId) ?? taskId,
      counts.pairs,
      counts.bothSuccess,
      counts.playwrightOnly,
      counts.extensionOnly,
      counts.bothFailed,
      fixed(geometricMean(ratios), 2),
      fixed(geometricMean(taskPenalized.get(taskId) ?? []), 2),
    ]
  })
  const allRatios = [...taskRatios.values()].flat()
  const allPenalized = [...taskPenalized.values()].flat()
  const ci = bootstrapGeometricMeanCI(allRatios)
  const totalCounts = [...taskCounts.values()].reduce((sum, value) => ({
    pairs: sum.pairs + value.pairs,
    bothSuccess: sum.bothSuccess + value.bothSuccess,
    playwrightOnly: sum.playwrightOnly + value.playwrightOnly,
    extensionOnly: sum.extensionOnly + value.extensionOnly,
    bothFailed: sum.bothFailed + value.bothFailed,
  }), { pairs: 0, bothSuccess: 0, playwrightOnly: 0, extensionOnly: 0, bothFailed: 0 })
  rows.push([
    'Total',
    totalCounts.pairs,
    totalCounts.bothSuccess,
    totalCounts.playwrightOnly,
    totalCounts.extensionOnly,
    totalCounts.bothFailed,
    ci === undefined
      ? fixed(geometricMean(allRatios), 2)
      : `${fixed(geometricMean(allRatios), 2)} (95% CI ${fixed(ci.low, 2)}–${fixed(ci.high, 2)})`,
    fixed(geometricMean(allPenalized), 2),
  ])

  const orderRows = [...orderRatios.entries()]
    .sort(([left], [right]) => left - right)
    .map(([order, ratios]) => [
      order === 1 ? 'Extension ran first' : 'Extension ran second',
      ratios.length,
      fixed(geometricMean(ratios), 2),
    ])
  return { rows, orderRows, warnings }
}

function failureCategory(record) {
  const reason = String(record.validationReason ?? record.infrastructureError ?? 'unknown')
  if (record.infrastructureError !== undefined || reason.startsWith('runner error:')) return 'Infrastructure error'
  if (record.timedOut === true || /timed out|timeout/iu.test(reason)) return 'Timeout'
  if (/forbidden tool|used forbidden tools/iu.test(reason)) return 'Forbidden tool used'
  if (reason.startsWith('answer did not contain')) return 'Answer mismatch'
  if (reason.startsWith('final page state did not match')) return 'Page state mismatch'
  if (/approval/iu.test(reason)) return 'Unexpected approval request'
  if (record.turnReason?.kind !== undefined && record.turnReason.kind !== 'completed') return 'Turn did not complete normally'
  return 'Other'
}

function failureRows(records) {
  const groups = groupBy(
    records.filter((record) => !record.success),
    (record) => `${record.backend}\u0000${failureCategory(record)}`,
  )
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, rows]) => {
      const [backend, category] = key.split('\u0000')
      const example = String(rows[0].validationReason ?? rows[0].infrastructureError ?? 'unknown')
      return [backend, category, rows.length, example.length > 180 ? `${example.slice(0, 177)}…` : example]
    })
}

export function renderReport(records, { sourceName = 'benchmark.jsonl' } = {}) {
  const valid = records.filter((record) => record?.schemaVersion === 1 && typeof record.backend === 'string')
  const suiteVersions = [...new Set(valid.map((record) => record.benchmarkSuiteVersion ?? 'legacy/unknown'))]
  if (suiteVersions.length > 1) {
    throw new Error(`Cannot aggregate several benchmark suite versions: ${suiteVersions.join(', ')}. Generate a separate report per benchmarkSuiteVersion.`)
  }
  const benchmarkIds = [...new Set(valid.map((record) => record.benchmarkId).filter(Boolean))]
  const backendGroups = groupBy(valid, (record) => record.backend)
  const overview = [...backendGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([backend, rows]) => summaryRow(backend, rows))
  const taskRows = []
  for (const [backend, rows] of [...backendGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (const [taskId, taskRecords] of [...groupBy(rows, (record) => record.taskId).entries()].sort(([left], [right]) => left.localeCompare(right))) {
      taskRows.push(summaryRow(`${backend} / ${taskNames.get(taskId) ?? taskId}`, taskRecords))
    }
  }
  const failures = valid.filter((record) => !record.success)
  const paired = pairedAnalysis(valid)
  const phaseRows = [...backendGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([backend, rows]) => phaseRow(backend, rows))
  const controlledRecords = valid.filter((record) => record.environment !== undefined && record.model !== undefined)
  const configurationCount = new Set(controlledRecords.map((record) => JSON.stringify({
    environment: record.environment,
    model: record.model,
    timeoutMs: record.timeoutMs,
  }))).size
  const consistencyNotes = [
    `Valid records: ${valid.length}; Benchmark IDs: ${benchmarkIds.length}. The pair key includes the Benchmark ID, so several runs appended to the same JSONL are never paired across each other.`,
    `Benchmark suite version: ${suiteVersions.join(', ')}.`,
    ...(suiteVersions.includes('legacy/unknown') ? ['Some records have no benchmark suite version; they are old results and should not be compared directly with results produced after the success criteria were corrected.'] : []),
    ...(configurationCount > 1 ? [`Found ${configurationCount} distinct environment, model or timeout configurations; do not aggregate them as if they were one controlled experiment.`] : []),
    ...paired.warnings,
  ]

  const lines = [
    '# DSH Browser benchmark report',
    '',
    `Data file: \`${sourceName}\`  `,
    `Benchmark ID: ${benchmarkIds.length === 0 ? '—' : benchmarkIds.map((id) => `\`${id}\``).join(', ')}  `,
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Overview',
    '',
    table(['Backend', 'Runs', 'Successes', 'Success rate', 'P50 completion (ms)', 'P90* (ms)', 'Mean (ms)', 'Mean tool calls', 'Mean prompt tokens (incl. cache)', 'Mean output tokens'], overview),
    '',
    'Completion time is measured from just before `session.prompt` is submitted until the runner receives the matching `turn/end`. Timing statistics cover successful runs only; read the success rate together with the timings. P90 is shown only with at least 10 successful samples, to avoid false precision on small samples.',
    '',
    '## By task',
    '',
    table(['Backend / task', 'Runs', 'Successes', 'Success rate', 'P50 completion (ms)', 'P90* (ms)', 'Mean (ms)', 'Mean tool calls', 'Mean prompt tokens (incl. cache)', 'Mean output tokens'], taskRows),
    '',
    '## Phases and tokens of successful runs',
    '',
    table(['Backend', 'Successes', 'Mean TTFT (ms)', 'Mean state reached (ms)', 'Mean LLM (ms)', 'Mean tool wall clock (ms)', 'Mean tool calls', 'Mean new input tokens', 'Mean cache-read tokens', 'Mean cache-write tokens', 'Mean output tokens'], phaseRows),
    '',
    '`State reached` has a value only for tasks with an externally verifiable page state; the column is the mean over samples that have one. `LLM` comes from the DSH session projection and `tool wall clock` from the tool call/result intervals the runner observed; the two may overlap and cannot simply be added up to the completion time.',
    '',
    '## Paired comparison',
    '',
    table(['Task', 'Pairs', 'Both succeeded', 'Only Playwright succeeded', 'Only extension succeeded', 'Both failed', 'Playwright / extension time ratio', 'Failure-penalized time ratio'], paired.rows),
    '',
    'A ratio above 1 means the extension backend is faster; below 1 means the Playwright backend is faster. The "Playwright / extension time ratio" column uses pairs with the same Benchmark ID, task, seed and trial in which both succeeded, and takes the geometric mean; with at least two such pairs, the Total row gives a bootstrap 95% confidence interval with a fixed random seed. "Failure-penalized" counts a failed run as `2 × timeout`, to reduce the survivorship bias of looking at successful samples only.',
    '',
    ...(paired.orderRows.length === 0 ? [] : [
      '### Run-order sensitivity',
      '',
      table(['Order within pair', 'Pairs where both succeeded', 'Playwright / extension time ratio'], paired.orderRows),
      '',
      'If the two rows differ noticeably, the results may still be affected by warm-up, caching or drift over time; add trials and randomize larger blocks of runs.',
      '',
    ]),
    '## Failure summary',
    '',
    failures.length === 0
      ? 'No failed runs.'
      : table(['Backend', 'Category', 'Count', 'Example'], failureRows(valid)),
    '',
    '## Data consistency',
    '',
    ...consistencyNotes.map((note) => `- ${note}`),
    '',
    '## Limits of interpretation',
    '',
    '- Both sides use the same DSH profile, model selection, task prompts, seeds, machine and local web pages; the tool names, descriptions, parameters and the general system prompt the model sees are kept aligned.',
    '- This is an end-to-end comparison of complete browser backends, not an experiment on transport overhead alone. The structured page representation, the index implementation and the execution of browser actions still differ between the two sides; those differences are part of the backends under test.',
    '- The run order alternates per pair so that neither backend always runs first; for official results use at least 5 seeds and repeat on an idle machine.',
    '- These are end-to-end timings: they include model inference, tool orchestration, browser execution and local communication. `stateReachedMs` can be used to see separately when a write actually took effect in the page state.',
    '- The regular latency and phase tables cover successful samples only; always read the paired success results and the failure-penalized metric alongside them. This report cannot isolate jitter on the model server side either. If the confidence interval is wide, add seeds/trials.',
    '',
  ]
  return lines.join('\n')
}

export async function readJsonl(path) {
  const text = await readFile(path, 'utf8')
  return text.split(/\r?\n/u).filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line) } catch (error) { throw new Error(`${path}:${index + 1}: invalid JSON: ${error.message}`) }
  })
}

export async function writeReportForFile(inputPath, outputPath) {
  const records = await readJsonl(inputPath)
  const target = outputPath ?? inputPath.slice(0, -extname(inputPath).length) + '.report.md'
  await writeFile(target, renderReport(records, { sourceName: basename(inputPath) }))
  return target
}

async function latestResult() {
  const resultsRoot = join(benchmarkRoot, 'results')
  const candidates = (await readdir(resultsRoot)).filter((name) => name.endsWith('.jsonl')).sort().reverse()
  if (candidates.length === 0) throw new Error('benchmark/results has no JSONL results; run node benchmark/run.mjs first')
  return join(resultsRoot, candidates[0])
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] === undefined ? await latestResult() : resolve(process.argv[2])
  const output = await writeReportForFile(input)
  console.log(`report: ${output}`)
}
