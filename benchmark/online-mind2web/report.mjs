#!/usr/bin/env node
/**
 * Static HTML leaderboard for Online-Mind2Web runs.
 *
 *   node benchmark/online-mind2web/report.mjs results.jsonl [more.jsonl …] --out leaderboard.html
 *
 * Input: JSON array or JSONL of run records
 * `{ agent, model?, taskId, level?, success, steps?, durationMs?, judge? }`
 * (`success` is the judge's verdict, e.g. WebJudge). Output: one
 * self-contained page (no scripts, no external assets) ranking agents by
 * success rate overall and per difficulty, with a per-task table. Running the
 * tasks needs a model key and a hosted browser; this only renders results.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { levelOf, LEVELS } from './loader.mjs'

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/** Parse a JSON array or JSONL text into run records. */
export function parseResults(text) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const rows = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  return rows.map((row, index) => {
    if (typeof row?.agent !== 'string' || typeof row?.taskId !== 'string' || typeof row?.success !== 'boolean') {
      throw new Error(`result ${String(index + 1)} needs agent, taskId and a boolean success`)
    }
    return {
      agent: row.agent,
      model: typeof row.model === 'string' ? row.model : undefined,
      taskId: row.taskId,
      level: LEVELS.includes(row.level) ? row.level : levelOf(Number(row.referenceLength)),
      success: row.success,
      steps: Number.isFinite(row.steps) ? row.steps : undefined,
      durationMs: Number.isFinite(row.durationMs) ? row.durationMs : undefined,
    }
  })
}

/** Rank agents (agent + model) by overall success rate. */
export function buildLeaderboard(results) {
  const groups = new Map()
  for (const result of results) {
    const key = `${result.agent}\u0000${result.model ?? ''}`
    groups.set(key, [...groups.get(key) ?? [], result])
  }
  const rate = (rows) => rows.length === 0 ? undefined : rows.filter((row) => row.success).length / rows.length
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (sorted.length === 0) return undefined
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  const entries = [...groups.values()].map((rows) => ({
    agent: rows[0].agent,
    model: rows[0].model,
    tasks: rows.length,
    successRate: rate(rows),
    byLevel: Object.fromEntries(LEVELS.map((level) => [level, { tasks: rows.filter((row) => row.level === level).length, successRate: rate(rows.filter((row) => row.level === level)) }])),
    medianSteps: median(rows.map((row) => row.steps)),
    medianSeconds: median(rows.map((row) => row.durationMs === undefined ? undefined : row.durationMs / 1000)),
  }))
  entries.sort((a, b) => (b.successRate ?? -1) - (a.successRate ?? -1) || b.tasks - a.tasks || a.agent.localeCompare(b.agent))
  return entries.map((entry, index) => ({ rank: index + 1, ...entry }))
}

function pct(value) {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function num(value, digits = 1) {
  return value === undefined ? '—' : Number(value).toFixed(digits)
}

/** Render the leaderboard page. */
export function renderLeaderboardHtml(results, { title = 'Online-Mind2Web results', generatedAt = new Date().toISOString() } = {}) {
  const board = buildLeaderboard(results)
  const tasks = [...new Set(results.map((row) => row.taskId))].sort()
  const agents = board.map((entry) => ({ key: `${entry.agent}\u0000${entry.model ?? ''}`, label: entry.model === undefined ? entry.agent : `${entry.agent} (${entry.model})` }))
  const cell = (taskId, key) => {
    const rows = results.filter((row) => row.taskId === taskId && `${row.agent}\u0000${row.model ?? ''}` === key)
    if (rows.length === 0) return '<td class="na">·</td>'
    const passed = rows.filter((row) => row.success).length
    return `<td class="${passed === rows.length ? 'pass' : passed === 0 ? 'fail' : 'mixed'}">${passed}/${rows.length}</td>`
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e3e8; --pass: #1f7a3a; --fail: #b3261e; --mixed: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #121214; --fg: #ededf0; --muted: #a0a0a8; --line: #2c2c31; --pass: #5bc27a; --fail: #ff6b60; --mixed: #e0a83a; } }
body { margin: 0 auto; max-width: 1100px; padding: 24px 16px; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
h1 { font-size: 22px; margin: 0 0 4px; } p.meta { color: var(--muted); margin: 0 0 20px; }
.scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; margin-bottom: 28px; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
td.pass { color: var(--pass); } td.fail { color: var(--fail); } td.mixed { color: var(--mixed); } td.na { color: var(--muted); text-align: center; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(`${String(results.length)} runs · ${String(tasks.length)} tasks · ${String(board.length)} agents · generated ${generatedAt}`)}. Success is the judge's verdict; difficulty by human reference length (easy ≤ 5, medium 6–10, hard ≥ 11 steps).</p>
<div class="scroll"><table>
<thead><tr><th>#</th><th>Agent</th><th>Tasks</th><th>Success</th>${LEVELS.map((level) => `<th>${level}</th>`).join('')}<th>Median steps</th><th>Median s</th></tr></thead>
<tbody>
${board.map((entry) => `<tr><td>${String(entry.rank)}</td><td>${escapeHtml(entry.model === undefined ? entry.agent : `${entry.agent} (${entry.model})`)}</td><td>${String(entry.tasks)}</td><td>${pct(entry.successRate)}</td>${LEVELS.map((level) => `<td>${pct(entry.byLevel[level].successRate)} <small>(${String(entry.byLevel[level].tasks)})</small></td>`).join('')}<td>${num(entry.medianSteps, 0)}</td><td>${num(entry.medianSeconds)}</td></tr>`).join('\n')}
</tbody></table></div>
<h2>Per task</h2>
<div class="scroll"><table>
<thead><tr><th>Task</th><th>Level</th>${agents.map((agent) => `<th>${escapeHtml(agent.label)}</th>`).join('')}</tr></thead>
<tbody>
${tasks.map((taskId) => `<tr><td>${escapeHtml(taskId)}</td><td>${escapeHtml(results.find((row) => row.taskId === taskId)?.level ?? 'unknown')}</td>${agents.map((agent) => cell(taskId, agent.key)).join('')}</tr>`).join('\n')}
</tbody></table></div>
</body>
</html>
`
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const out = outIndex === -1 ? 'online-mind2web-leaderboard.html' : args[outIndex + 1]
  const inputs = args.filter((_arg, index) => index !== outIndex && index !== outIndex + 1)
  if (inputs.length === 0 || out === undefined) {
    console.error('usage: node benchmark/online-mind2web/report.mjs <results.json|jsonl>… [--out leaderboard.html]')
    process.exit(2)
  }
  const results = []
  for (const input of inputs) results.push(...parseResults(await readFile(input, 'utf8')))
  await writeFile(out, renderLeaderboardHtml(results))
  console.log(`wrote ${out} (${String(results.length)} runs)`)
}
