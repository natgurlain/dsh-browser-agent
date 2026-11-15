/**
 * Browser subagent and skills (Phase 3.10).
 *
 * - **Skills**: the package ships short `skills/<name>/SKILL.md` playbooks
 *   (fill a form safely, extract a table to CSV, research across tabs, debug
 *   a localhost page). They are registered on `ctx.skills` when the Host has
 *   the skill registry, so the model's `skill` tool can load them.
 * - **Agent preset `browser`**: a composition whose only row is
 *   `browser-preset.ts`, which restricts the agent's tools to `browser_*`
 *   (plus `skill` when it is global). A main agent delegates page work to it
 *   with `delegate_browser_task` (registered here on the in-process `spawn`
 *   subagent backend), so large snapshots stay in the child's context and
 *   only its summary returns.
 *
 * Both are optional Host services, read through `ctx.get`.
 *
 * @module
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { errorMessage } from './host-api.ts'
import { startActivationCompat } from './subagent-compat.ts'

/** Id of the agent preset this plugin registers. */
export const BROWSER_AGENT_PRESET_ID = 'browser'

/** One parsed bundled skill. */
export interface BundledSkill {
  name: string
  description: string
  content: string
  path: string
  directory: string
}

/** Kebab-case skill names (the registry's rule). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Parse one SKILL.md (YAML-ish frontmatter with `name` and `description`).
 * @returns the skill, or undefined when the frontmatter is missing or invalid.
 */
export function parseSkillFile(text: string, path: string, directory: string): BundledSkill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text)
  if (match === null) return undefined
  const fields = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^([a-z-]+):\s*(.*)$/u.exec(line)
    if (field !== null) fields.set(field[1]!, field[2]!.trim().replace(/^(['"])(.*)\1$/u, '$2'))
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined || !SKILL_NAME.test(name) || description === undefined || description === '') return undefined
  return { name, description, content: match[2]!.trim(), path, directory }
}

/** Load every `<dir>/<name>/SKILL.md` bundled with the package. */
export async function loadBundledSkills(skillsDir: string): Promise<BundledSkill[]> {
  let entries: string[]
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch {
    return []
  }
  const skills: BundledSkill[] = []
  for (const entry of entries) {
    const directory = join(skillsDir, entry)
    const path = join(directory, 'SKILL.md')
    try {
      const parsed = parseSkillFile(await readFile(path, 'utf8'), path, directory)
      if (parsed !== undefined && parsed.name === entry) skills.push(parsed)
    } catch {
      // A missing or unreadable bundle contributes nothing.
    }
  }
  return skills
}

/** The slice of `ctx.skills` used here. */
interface SkillRegistryLike {
  register(skill: {
    name: string
    description: string
    content: string
    source: string
    path?: string
    resourceBase?: { kind: 'directory'; path: string }
  }): () => void
}

/** The slice of `ctx.agentPresets` used here. */
interface AgentPresetRegistryLike {
  register(definition: {
    id: string
    name?: string
    description?: string
    order?: number
    plugins: ReadonlyArray<{ id?: string; name: string; config?: unknown }>
  }): Promise<() => Promise<void>>
}

/**
 * Register the bundled skills (when the Host has a skill registry).
 * @returns how many were registered.
 */
export async function registerBrowserSkills(ctx: Context, skillsDir: string): Promise<number> {
  const registry = (ctx.get as (name: string) => unknown)('skills') as SkillRegistryLike | undefined
  if (registry === undefined || typeof registry.register !== 'function') return 0
  const skills = await loadBundledSkills(skillsDir)
  let count = 0
  for (const skill of skills) {
    ctx.effect(() => registry.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'bundled',
      path: skill.path,
      resourceBase: { kind: 'directory', path: skill.directory },
    }), `bridge-browser: skill ${skill.name}`)
    count += 1
  }
  return count
}

/** The preset definition: one row, the tool-restricting child plugin. */
export function browserPresetDefinition(presetModuleUrl: string): Parameters<AgentPresetRegistryLike['register']>[0] {
  return {
    id: BROWSER_AGENT_PRESET_ID,
    name: 'Browser',
    description: 'Operates the user\'s browser with the browser_* tools only. Delegate page work here (reading, '
      + 'navigating, filling forms, extracting tables) so large page snapshots stay out of the main conversation; '
      + 'it returns a summary.',
    order: 900,
    plugins: [{ id: 'browser-agent-tools', name: presetModuleUrl }],
  }
}

/**
 * Register the `browser` agent preset (when the Host has the preset registry).
 * @param presetModuleUrl - file URL of the built `browser-preset.js` row.
 * @returns whether a registry was present.
 */
export function registerBrowserPreset(ctx: Context, presetModuleUrl: string): boolean {
  const registry = (ctx.get as (name: string) => unknown)('agentPresets') as AgentPresetRegistryLike | undefined
  if (registry === undefined || typeof registry.register !== 'function') return false
  ctx.effect(() => {
    let dispose: (() => Promise<void>) | undefined
    const registered = registry.register(browserPresetDefinition(presetModuleUrl)).then((disposer) => {
      dispose = disposer
    }, (error: unknown) => {
      ctx.logger.warn(`browser bridge: could not register the "${BROWSER_AGENT_PRESET_ID}" agent preset: ${errorMessage(error)}`)
    })
    return async () => {
      await registered
      await dispose?.()
    }
  }, 'bridge-browser: browser agent preset')
  return true
}

/** Name of the delegation tool (not `browser_*`: the browser agent itself never sees it). */
export const BROWSER_DELEGATE_TOOL = 'delegate_browser_task'

/** The slice of `ctx.subagents` used here. */
interface SubagentsLike {
  getProvider(name: string): unknown
  startActivation(spec: {
    provider: string
    label: string
    prompt: Array<{ type: 'text'; text: string }>
    parent: unknown
    agentPreset: string
    signal: AbortSignal
    delivery: 'caller'
  }): Promise<{ result: Promise<{ output: ReadonlyArray<{ type: string; text?: string }>; stopReason: string; diagnostic?: string }>; dispose(): Promise<void> }>
}

/** Subagent backend that can run an independent preset in-process. */
const SPAWN_PROVIDER = 'spawn'

/**
 * Register `delegate_browser_task`: run a page task in a child agent on the
 * `browser` preset (browser_* tools only) and return only its summary, so
 * large snapshots stay out of the caller's context. Needs the Host's
 * subagent manager with the in-process `spawn` backend; a tainted session
 * cannot call it (session-taint.ts denies delegation).
 * @returns whether the tool was registered.
 */
export function registerBrowserDelegateTool(ctx: Context, defineTool: (options: never) => unknown): boolean {
  const subagents = (ctx.get as (name: string) => unknown)('subagents') as SubagentsLike | undefined
  const tools = (ctx.get as (name: string) => unknown)('tools') as { register(definition: unknown): () => void } | undefined
  if (subagents === undefined || typeof subagents.startActivation !== 'function' || tools === undefined) return false
  const definition = defineTool({
    name: BROWSER_DELEGATE_TOOL,
    description: 'Delegate a task in the user\'s browser (read pages, navigate, fill forms, extract tables, research across tabs) '
      + 'to a browser subagent that only has the browser_* tools. It works in its own context and returns a short summary, '
      + 'so page snapshots do not fill this conversation. Describe the goal, the starting URL or tab, and what to report back.',
    parameters: {
      task: { type: 'string', required: true, description: 'What the browser subagent should do and report.' },
      label: { type: 'string', description: 'Short label for the task (a few words).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true }, stopReason: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
    },
    execute: async (args: { task: string; label?: string }, exec: { agent?: unknown; signal: AbortSignal }) => {
      if (exec.agent === undefined) throw new Error('delegate_browser_task needs a calling agent session.')
      if (subagents.getProvider(SPAWN_PROVIDER) === undefined) {
        throw new Error('The Host has no in-process "spawn" subagent backend, so the browser subagent cannot start.')
      }
      const started = await startActivationCompat(subagents, {
        provider: SPAWN_PROVIDER,
        label: (args.label ?? 'browser task').slice(0, 80),
        prompt: [{ type: 'text', text: args.task }],
        parent: exec.agent,
        agentPreset: BROWSER_AGENT_PRESET_ID,
        signal: exec.signal,
        delivery: 'caller',
      })
      const onAbort = (): void => { void started.dispose().catch(() => {}) }
      // The caller may have aborted while the child was starting.
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await started.result
        const text = result.output.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
        return {
          text: text !== '' ? text : `The browser subagent ended (${result.stopReason}) without a summary.${result.diagnostic === undefined ? '' : ` ${result.diagnostic}`}`,
          stopReason: result.stopReason,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  } as never)
  ctx.effect(() => tools.register(definition), `bridge-browser: ${BROWSER_DELEGATE_TOOL} tool`)
  return true
}
