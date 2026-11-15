/**
 * Workflow files in a session workspace: saving (only through the shared,
 * sandbox-aware {@link writeWorkspaceFile}: no overwrite, `.json` only),
 * loading, listing, and the DSH skill provider that exposes each saved
 * workflow as a skill for sessions working in that workspace.
 *
 * @module @natgurlain/dsh-bridge-browser/src/learning/store
 */

import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeWorkspaceFile, type WorkspaceWriteTarget } from '../workspace-write.ts'
import {
  validateWorkflow,
  WORKFLOW_DIRECTORY,
  WORKFLOW_SUFFIX,
  workflowSkillContent,
  workflowSkillName,
  type Workflow,
} from './workflow.ts'

/** Largest workflow file read back. */
const MAX_WORKFLOW_BYTES = 512 * 1024

/** Workspace-relative path of a workflow file. */
export function workflowRelativePath(name: string): string {
  return `${WORKFLOW_DIRECTORY}/${name}${WORKFLOW_SUFFIX}`
}

/**
 * Save a validated workflow. Never replaces an existing file.
 * @param target - from `workspaceWriteTarget`.
 * @param workflow - untrusted workflow object (validated here).
 */
export async function saveWorkflow(target: WorkspaceWriteTarget, workflow: unknown): Promise<{ workflow: Workflow; path: string; relativePath: string }> {
  const valid = validateWorkflow(workflow)
  const saved = await writeWorkspaceFile(target, workflowRelativePath(valid.name), `${JSON.stringify(valid, null, 2)}\n`, {
    allowedExt: ['.json'],
    mode: 0o600,
  })
  return { workflow: valid, ...saved }
}

/** The workspace directory a session reads workflows from. */
export function workspaceRootOf(agent: unknown, fallback: string): string | undefined {
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
  return fallback !== '' && isAbsolute(fallback) ? fallback : undefined
}

/**
 * Load one workflow by name.
 * @param root - workspace root.
 * @param name - kebab-case workflow name.
 */
export async function loadWorkflow(root: string, name: string): Promise<Workflow> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error(`invalid workflow name ${JSON.stringify(name)}`)
  const text = await readFile(join(root, WORKFLOW_DIRECTORY, `${name}${WORKFLOW_SUFFIX}`), 'utf8')
  if (text.length > MAX_WORKFLOW_BYTES) throw new Error('the workflow file is too large')
  return validateWorkflow(JSON.parse(text))
}

/**
 * List the valid workflows in a workspace; unreadable or invalid files are skipped.
 * @param root - workspace root.
 */
export async function listWorkflows(root: string): Promise<Workflow[]> {
  let names: string[]
  try {
    names = await readdir(join(root, WORKFLOW_DIRECTORY))
  } catch {
    return []
  }
  const workflows: Workflow[] = []
  for (const file of names.sort()) {
    if (!file.endsWith(WORKFLOW_SUFFIX)) continue
    try {
      workflows.push(await loadWorkflow(root, file.slice(0, -WORKFLOW_SUFFIX.length)))
    } catch {
      // Skip a malformed or hand-edited file.
    }
  }
  return workflows
}

/** The subset of `ctx.skills` this module uses. */
export interface SkillsServiceLike {
  registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => {
    name: string
    list: (options: { cwd?: string | undefined }) => Promise<readonly unknown[]>
    get: (candidate: { locator: unknown }, options: { cwd?: string | undefined }) => Promise<unknown>
  }): () => void
}

/** Skill rank: after project skills, before user skills. */
const WORKFLOW_SKILL_RANK = 350

/**
 * Register a skill provider that lists the saved workflows of the looked-up
 * workspace only (the session's own `cwd`). There is no global fallback: a
 * workflow saved in one workspace never shows up as a skill in another
 * session's lookup, and a lookup without a workspace lists nothing.
 * @param skills - `ctx.skills`.
 * @returns the provider's disposer and an invalidation hook (call after a save).
 */
export function registerWorkflowSkills(skills: SkillsServiceLike): { dispose: () => void; invalidate: () => void } {
  let invalidate = (): void => {}
  const roots = (cwd: string | undefined): string[] => cwd !== undefined && isAbsolute(cwd) ? [cwd] : []
  const dispose = skills.registerProvider((control) => {
    invalidate = control.invalidate
    return {
      name: 'bridge-browser-workflows',
      list: async ({ cwd }) => {
        const candidates = []
        const seen = new Set<string>()
        for (const root of roots(cwd)) {
          for (const workflow of await listWorkflows(root)) {
            const name = workflowSkillName(workflow.name)
            if (seen.has(name)) continue
            seen.add(name)
            candidates.push({
              name,
              description: `Replay the saved browser workflow "${workflow.name}"${workflow.description === '' ? '' : `: ${workflow.description}`}`.slice(0, 300),
              whenToUse: 'When the user asks to repeat this saved browser task.',
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'runtime',
              provider: 'bridge-browser-workflows',
              rank: WORKFLOW_SKILL_RANK,
              locator: { root, name: workflow.name },
            })
          }
        }
        return candidates
      },
      get: async (candidate, { cwd }) => {
        const locator = candidate.locator as { root?: unknown; name?: unknown }
        if (typeof locator.root !== 'string' || typeof locator.name !== 'string' || !isAbsolute(locator.root)) return undefined
        // A lookup from another workspace never reads this one's workflow.
        if (cwd !== undefined && cwd !== locator.root) return undefined
        try {
          const workflow = await loadWorkflow(locator.root, locator.name)
          const { rank: _rank, locator: _locator, ...summary } = candidate as Record<string, unknown>
          return { ...summary, content: workflowSkillContent(workflow, workflowRelativePath(workflow.name)) }
        } catch {
          return undefined
        }
      },
    }
  })
  return { dispose, invalidate: () => { invalidate() } }
}
