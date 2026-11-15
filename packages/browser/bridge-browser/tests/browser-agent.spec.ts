import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  BROWSER_AGENT_PRESET_ID,
  browserPresetDefinition,
  loadBundledSkills,
  parseSkillFile,
  registerBrowserPreset,
  registerBrowserSkills,
} from '../src/browser-agent.ts'
import { apply as applyPreset, browserAgentAllows } from '../src/browser-preset.ts'

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

function fakeCtx(services: Record<string, unknown>) {
  const disposers: Array<() => unknown> = []
  const listeners = new Map<string, Array<() => void>>()
  const ctx = {
    get: (name: string) => services[name],
    effect: (fn: () => unknown) => { const d = fn(); if (typeof d === 'function') disposers.push(d as () => unknown) },
    on: (event: string, listener: () => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]) },
    logger: { warn: vi.fn(), info: vi.fn() },
    ...services,
  } as unknown as Context
  return { ctx, disposers, emit: (event: string) => { for (const l of listeners.get(event) ?? []) l() } }
}

describe('bundled browser skills', () => {
  it('ships four well-formed skills whose names match their directories', async () => {
    const skills = await loadBundledSkills(SKILLS_DIR)
    expect(skills.map(skill => skill.name)).toEqual(['debug-localhost-page', 'extract-table-to-csv', 'fill-form-safely', 'research-across-tabs'])
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(30)
      expect(skill.content).toMatch(/^# /u)
      expect(skill.content).toMatch(/untrusted/iu)
    }
  })

  it('rejects missing frontmatter and non-kebab names', () => {
    expect(parseSkillFile('# no frontmatter', '/x', '/')).toBeUndefined()
    expect(parseSkillFile('---\nname: Bad_Name\ndescription: d\n---\nbody', '/x', '/')).toBeUndefined()
    expect(parseSkillFile('---\nname: ok-name\ndescription: "quoted"\n---\nbody', '/x', '/')).toMatchObject({ name: 'ok-name', description: 'quoted', content: 'body' })
  })

  it('registers them on ctx.skills as bundled skills with their directory as resource base', async () => {
    const register = vi.fn(() => () => {})
    const { ctx, disposers } = fakeCtx({ skills: { register } })
    expect(await registerBrowserSkills(ctx, SKILLS_DIR)).toBe(4)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'fill-form-safely', source: 'bundled', resourceBase: { kind: 'directory', path: expect.stringContaining('fill-form-safely') },
    }))
    expect(disposers).toHaveLength(4)
    expect(await registerBrowserSkills(fakeCtx({}).ctx, SKILLS_DIR)).toBe(0)
  })
})

describe('browser agent preset', () => {
  it('registers a one-row preset that loads the restricting module', async () => {
    const dispose = vi.fn(async () => {})
    const register = vi.fn(async () => dispose)
    const { ctx, disposers } = fakeCtx({ agentPresets: { register } })
    expect(registerBrowserPreset(ctx, 'file:///pkg/lib/browser-preset.js')).toBe(true)
    expect(register).toHaveBeenCalledWith(browserPresetDefinition('file:///pkg/lib/browser-preset.js'))
    expect(browserPresetDefinition('u')).toMatchObject({ id: BROWSER_AGENT_PRESET_ID, plugins: [{ name: 'u' }] })
    await disposers[0]!()
    expect(dispose).toHaveBeenCalledOnce()
    expect(registerBrowserPreset(fakeCtx({}).ctx, 'u')).toBe(false)
  })

  it('restricts the agent to browser_* tools and skill, following the global tool set', () => {
    let global = ['bash', 'edit', 'browser_snapshot', 'browser_click', 'skill', 'subagent']
    const restrictions: Array<{ allow: string[]; lifted: boolean }> = []
    const tools = {
      definitions: vi.fn(() => global.map(name => ({ name }))),
      restrict: vi.fn((filter: { allow: string[] }) => {
        const entry = { allow: filter.allow, lifted: false }
        restrictions.push(entry)
        return () => { entry.lifted = true }
      }),
    }
    const section = vi.fn(() => () => {})
    const { ctx, emit, disposers } = fakeCtx({ tools, systemPrompt: { section } })
    applyPreset(ctx)
    expect(restrictions).toEqual([{ allow: ['browser_click', 'browser_snapshot', 'skill'], lifted: false }])
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'bridge-browser:browser-agent' }))
    // An unrelated change keeps the same restriction.
    emit('tools/change')
    expect(restrictions).toHaveLength(1)
    // The developer-tools group arrives: the allow-list grows, the old one is lifted.
    global = [...global, 'browser_console_logs', 'workflow']
    emit('tools/change')
    expect(restrictions.at(-1)).toEqual({ allow: ['browser_click', 'browser_console_logs', 'browser_snapshot', 'skill'], lifted: false })
    expect(restrictions[0]!.lifted).toBe(true)
    for (const dispose of disposers) dispose()
    expect(restrictions.at(-1)!.lifted).toBe(true)
    expect(browserAgentAllows('bash')).toBe(false)
  })
})
