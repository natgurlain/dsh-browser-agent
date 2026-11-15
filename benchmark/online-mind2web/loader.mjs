#!/usr/bin/env node
/**
 * Online-Mind2Web task loader. The data is never vendored: it is downloaded
 * at runtime from the official Hugging Face dataset (gated: accept its terms
 * and pass a token via `HF_TOKEN` or `--token`), or any URL/file you point it
 * at, and a deterministic subset is selected.
 *
 *   node benchmark/online-mind2web/loader.mjs --count 30 --levels easy,medium --seed 7 --out subset.json
 *
 * Difficulty follows the benchmark's convention on `reference_length` (the
 * human step count): easy ≤ 5, medium 6–10, hard ≥ 11.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Official dataset file (Hugging Face, gated). */
export const DEFAULT_SOURCE = 'https://huggingface.co/datasets/osunlp/Online-Mind2Web/resolve/main/Online_Mind2Web.json'

export const LEVELS = ['easy', 'medium', 'hard']

/** Difficulty of a task from its human reference length. */
export function levelOf(referenceLength) {
  if (!Number.isFinite(referenceLength)) return 'unknown'
  if (referenceLength <= 5) return 'easy'
  if (referenceLength <= 10) return 'medium'
  return 'hard'
}

/** Normalize one dataset row (field names vary between releases). */
export function normalizeTask(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('task row must be an object')
  const taskId = raw.task_id ?? raw.taskId ?? raw.id
  const task = raw.task_description ?? raw.confirmed_task ?? raw.task
  const website = raw.website ?? raw.web ?? raw.url
  const referenceLength = Number(raw.reference_length ?? raw.referenceLength)
  if (typeof taskId !== 'string' || taskId === '') throw new Error('task row has no task_id')
  if (typeof task !== 'string' || task.trim() === '') throw new Error(`task ${taskId} has no description`)
  if (typeof website !== 'string' || !/^https?:\/\//u.test(website)) throw new Error(`task ${taskId} has no website URL`)
  // Prefer the dataset's own difficulty label when a release carries one.
  const level = LEVELS.includes(String(raw.level ?? '').toLowerCase()) ? String(raw.level).toLowerCase() : levelOf(referenceLength)
  return { taskId, task: task.trim(), website, referenceLength: Number.isFinite(referenceLength) ? referenceLength : undefined, level }
}

/** Whether a URL is on a Hugging Face host (the only place `HF_TOKEN` may be sent). */
export function isHuggingFaceUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co'))
  } catch {
    return false
  }
}

/**
 * Download (or read) and parse the task list.
 * @param options - `{ source, token, fetch }`; `source` may be a URL or a local path.
 */
export async function loadOnlineMind2Web({ source = DEFAULT_SOURCE, token = process.env.HF_TOKEN, fetch: fetcher = globalThis.fetch } = {}) {
  let text
  if (/^https?:\/\//u.test(source)) {
    // The Hugging Face token never goes to another host (a --source someone else chose).
    const sendToken = token !== undefined && token !== '' && isHuggingFaceUrl(source)
    const response = await fetcher(source, { headers: sendToken ? { authorization: `Bearer ${token}` } : {} })
    if (response.status === 401 || response.status === 403) {
      throw new Error(`the dataset is gated (HTTP ${String(response.status)}): accept its terms on Hugging Face and pass a token (HF_TOKEN or --token)`)
    }
    if (!response.ok) throw new Error(`could not download the task list: HTTP ${String(response.status)}`)
    text = await response.text()
  } else {
    text = await readFile(source, 'utf8')
  }
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : undefined
  if (rows === undefined) throw new Error('the task list is not a JSON array')
  return rows.map(normalizeTask)
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

/**
 * Deterministic subset: filter by level/website, shuffle by seed, take `count`
 * (balanced across the requested levels when possible).
 */
export function selectSubset(tasks, { count = 30, levels = LEVELS, seed = 1, websites } = {}) {
  const random = mulberry32(seed)
  const pool = tasks.filter((task) => levels.includes(task.level) && (websites === undefined || websites.some((site) => task.website.includes(site))))
  const shuffled = [...pool].sort((a, b) => a.taskId.localeCompare(b.taskId))
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
  }
  const byLevel = new Map(levels.map((level) => [level, shuffled.filter((task) => task.level === level)]))
  const picked = []
  while (picked.length < count && [...byLevel.values()].some((list) => list.length > 0)) {
    for (const level of levels) {
      const next = byLevel.get(level)?.shift()
      if (next !== undefined && picked.length < count) picked.push(next)
    }
  }
  return picked
}

export function parseLoaderArgs(argv) {
  const options = { source: DEFAULT_SOURCE, count: 30, levels: LEVELS, seed: 1, out: undefined, token: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => argv[++index] ?? ''
    if (arg === '--source') options.source = value()
    else if (arg === '--count') options.count = Number(value())
    else if (arg === '--levels') options.levels = value().split(',').filter((level) => LEVELS.includes(level))
    else if (arg === '--seed') options.seed = Number(value())
    else if (arg === '--out') options.out = resolve(value())
    else if (arg === '--token') options.token = value()
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count must be a positive integer')
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer')
  return options
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseLoaderArgs(process.argv.slice(2))
  const tasks = await loadOnlineMind2Web({ source: options.source, ...(options.token === undefined ? {} : { token: options.token }) })
  const subset = selectSubset(tasks, options)
  const text = `${JSON.stringify({ source: options.source, seed: options.seed, levels: options.levels, tasks: subset }, null, 2)}\n`
  if (options.out === undefined) process.stdout.write(text)
  else await writeFile(options.out, text)
  console.error(`selected ${String(subset.length)} of ${String(tasks.length)} tasks`)
}
