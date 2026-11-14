/**
 * Failure flywheel: a failed browser step (denied approval, element not
 * found, guard failure, retry) saved as a local fixture in the session
 * workspace, through the shared sandbox-aware writer (no overwrite, fixed
 * extensions). `benchmark/import-fixtures.mjs` turns these into benchmark
 * tasks.
 *
 * The extension captures the page: MHTML only when the page has no sensitive
 * field (MHTML serializes form values), otherwise a sanitized DOM snapshot
 * with sensitive values masked and scripts removed. Nothing here re-reads
 * the page; the bridge only validates and writes.
 *
 * @module @natgurlain/dsh-bridge-browser/src/learning/fixtures
 */

import { maskAuditArgs, redactAuditUrl } from '../audit-log.ts'
import { writeWorkspaceFile, type WorkspaceWriteTarget } from '../workspace-write.ts'

/** Workspace directory fixtures land in. */
export const FIXTURE_DIRECTORY = 'browser-fixtures'

/** Format marker of a fixture's metadata file. */
export const FIXTURE_FORMAT = 'dsh-browser-fixture/v1'

/** Largest page capture accepted (bytes of text). */
export const MAX_FIXTURE_PAGE_BYTES = 8 * 1024 * 1024

/** Failure classes the flywheel records. */
export const FIXTURE_FAILURES = ['denied', 'not-found', 'guard', 'retried', 'error'] as const
export type FixtureFailure = typeof FIXTURE_FAILURES[number]

/** What the extension sends. */
export interface FixtureInput {
  tool: string
  args: Record<string, unknown>
  error: { code: string; message: string }
  failure: FixtureFailure
  url: string
  title?: string
  page: { kind: 'mhtml' | 'dom'; content: string }
}

/** The metadata file written next to the page capture. */
export interface FixtureMeta {
  format: typeof FIXTURE_FORMAT
  capturedAt: string
  failure: FixtureFailure
  url: string
  title?: string
  page: { kind: 'mhtml' | 'dom'; file: string }
  /** The action that failed, with secrets masked like the audit log. */
  intended: { tool: string; args: Record<string, unknown> }
  error: { code: string; message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate an untrusted fixture payload from the extension. */
export function parseFixtureInput(value: unknown): FixtureInput {
  if (!isRecord(value)) throw new Error('fixture must be an object')
  const { tool, args, error, failure, url, title, page } = value
  if (typeof tool !== 'string' || !/^browser_[a-z_]{1,40}$/u.test(tool)) throw new Error('fixture.tool must be a browser tool name')
  if (!isRecord(args)) throw new Error('fixture.args must be an object')
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') throw new Error('fixture.error must have code and message')
  if (typeof failure !== 'string' || !(FIXTURE_FAILURES as readonly string[]).includes(failure)) throw new Error('fixture.failure is not a known failure class')
  if (typeof url !== 'string' || !/^https?:\/\//u.test(url)) throw new Error('fixture.url must be an http(s) URL')
  if (!isRecord(page) || (page.kind !== 'mhtml' && page.kind !== 'dom') || typeof page.content !== 'string') throw new Error('fixture.page must be { kind, content }')
  if (Buffer.byteLength(page.content) > MAX_FIXTURE_PAGE_BYTES) throw new Error('the page capture is too large to save as a fixture')
  return {
    tool, args, failure: failure as FixtureFailure, url,
    error: { code: error.code.slice(0, 64), message: error.message.slice(0, 2_000) },
    ...(typeof title === 'string' ? { title: title.slice(0, 300) } : {}),
    page: { kind: page.kind, content: page.content },
  }
}

/**
 * Write one fixture (page capture + metadata) into the workspace.
 * @param target - from `workspaceWriteTarget`.
 * @param input - validated fixture.
 * @param now - clock seam.
 */
export async function saveFixture(target: WorkspaceWriteTarget, input: FixtureInput, now: Date = new Date()): Promise<{ meta: string; page: string }> {
  const stamp = now.toISOString().replace(/[:.]/gu, '-')
  const base = `${FIXTURE_DIRECTORY}/${stamp}-${input.tool.replace(/^browser_/u, '')}-${Math.random().toString(36).slice(2, 8)}`
  const pageExt = input.page.kind === 'mhtml' ? '.mhtml' : '.html'
  const page = await writeWorkspaceFile(target, `${base}${pageExt}`, input.page.content, { allowedExt: ['.mhtml', '.html'], mode: 0o600 })
  const meta: FixtureMeta = {
    format: FIXTURE_FORMAT,
    capturedAt: now.toISOString(),
    failure: input.failure,
    url: redactAuditUrl(input.url),
    ...(input.title === undefined ? {} : { title: input.title }),
    page: { kind: input.page.kind, file: page.relativePath.split('/').at(-1)! },
    intended: { tool: input.tool, args: maskAuditArgs(input.args) },
    error: input.error,
  }
  const written = await writeWorkspaceFile(target, `${base}.json`, `${JSON.stringify(meta, null, 2)}\n`, { allowedExt: ['.json'], mode: 0o600 })
  return { meta: written.relativePath, page: page.relativePath }
}
