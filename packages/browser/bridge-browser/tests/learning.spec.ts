import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  describeStep,
  resolveParams,
  substitute,
  validateWorkflow,
  workflowSkillContent,
  workflowSlug,
  WORKFLOW_FORMAT,
} from '../src/learning/workflow.ts'
import {
  candidateMatches,
  createSequentialExecutor,
  locateElement,
  parseFoundCandidates,
  renderReplayReport,
  type StepCall,
} from '../src/learning/replay.ts'
import { listWorkflows, loadWorkflow, registerWorkflowSkills, saveWorkflow } from '../src/learning/store.ts'
import { parseScheduleTiming, schedulePrompt, WorkflowSchedules, type ScheduleServiceLike } from '../src/learning/schedules.ts'
import { parseFixtureInput, saveFixture } from '../src/learning/fixtures.ts'
import {
  buildDriverRequest,
  describeDriverRequest,
  parseSiteDriverImport,
  proposeSiteDriver,
  resolveDriverTokens,
  siteDriverToolName,
  validateSiteDriver,
} from '../src/learning/site-drivers.ts'
import { mountLearning, parseProgram, LEARNING_METHODS } from '../src/learning/index.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-learning-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const baseWorkflow = (): Record<string, unknown> => ({
  format: WORKFLOW_FORMAT,
  name: 'add-contact',
  description: 'Add a contact',
  origin: 'https://crm.example',
  createdAt: '2026-11-15T00:00:00.000Z',
  params: [{ name: 'contact', default: 'Ada' }, { name: 'pin', sensitive: true }],
  steps: [
    { tool: 'browser_navigate', args: { url: 'https://crm.example/new' } },
    { tool: 'browser_type', locator: { role: 'textbox', name: 'Name', css: '#name' }, args: { text: '{{contact}}', replace: true } },
    { tool: 'browser_type', locator: { role: 'textbox', name: 'PIN', css: '#pin' }, args: { text: '{{pin}}' }, sensitive: true },
    { tool: 'browser_click', locator: { role: 'button', name: 'Save', text: 'Save', css: '#save' }, args: {} },
  ],
})

describe('workflow format', () => {
  it('accepts robust locators, parameters, and a sensitive step that stores no value', () => {
    const workflow = validateWorkflow(baseWorkflow())
    expect(workflow.steps).toHaveLength(4)
    expect(workflow.params.find((param) => param.name === 'pin')).toEqual({ name: 'pin', sensitive: true })
    expect(describeStep(workflow.steps[3]!)).toBe('click button "Save"')
    expect(workflowSkillContent(workflow, 'browser-workflows/add-contact.workflow.json')).toMatch(/browser_workflow_run \{ "name": "add-contact"/)
  })

  it('never stores an index, a CSS-only locator, or a sensitive value', () => {
    const indexed = baseWorkflow()
    ;(indexed.steps as Array<Record<string, unknown>>)[3] = { tool: 'browser_click', args: { index: 4 } }
    expect(() => validateWorkflow(indexed)).toThrow(/not stored in a workflow/)
    const cssOnly = baseWorkflow()
    ;(cssOnly.steps as Array<Record<string, unknown>>)[3] = { tool: 'browser_click', locator: { css: '#save' }, args: {} }
    expect(() => validateWorkflow(cssOnly)).toThrow(/role, name, or text/)
    const literalSecret = baseWorkflow()
    ;(literalSecret.steps as Array<Record<string, unknown>>)[2] = { tool: 'browser_type', locator: { role: 'textbox', name: 'PIN' }, args: { text: '1234' }, sensitive: true }
    expect(() => validateWorkflow(literalSecret)).toThrow(/never stored/)
    const defaulted = baseWorkflow()
    ;(defaulted.params as Array<Record<string, unknown>>)[1] = { name: 'pin', default: '1234', sensitive: true }
    expect(() => validateWorkflow(defaulted)).toThrow(/cannot store a default/)
    const unknown = baseWorkflow()
    ;(unknown.steps as Array<Record<string, unknown>>)[1] = { tool: 'browser_type', locator: { role: 'textbox', name: 'Name' }, args: { text: '{{nope}}' } }
    expect(() => validateWorkflow(unknown)).toThrow(/names no parameter/)
    expect(() => validateWorkflow({ ...baseWorkflow(), steps: [{ tool: 'browser_console_eval', args: {} }] })).toThrow(/tool must be one of/)
  })

  it('resolves parameters and substitutes placeholders', () => {
    const workflow = validateWorkflow(baseWorkflow())
    expect(() => resolveParams(workflow, {})).toThrow(/"pin" is required.*never stored/)
    const params = resolveParams(workflow, { pin: '0000' })
    expect(params).toEqual({ contact: 'Ada', pin: '0000' })
    expect(substitute({ text: 'Hi {{contact}}', list: ['{{ pin }}'] }, params)).toEqual({ text: 'Hi Ada', list: ['0000'] })
    expect(() => resolveParams(workflow, { pin: '1', extra: 'x' })).toThrow(/unknown parameter/)
    expect(workflowSlug('My CRM: add contact!')).toBe('my-crm-add-contact')
  })
})

/** A fake page: snapshot queries answer from a list of elements. */
function fakePage(elements: Array<{ role: string; label: string; selector: string; hidden?: boolean }>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const call: StepCall = async (tool, args) => {
    calls.push({ tool, args })
    if (tool !== 'browser_snapshot') return { ok: true, text: `${tool} done` }
    const query = args.query as { selector?: string; text?: string; role?: string }
    const found = elements.filter((element) => {
      if (query.selector !== undefined) return element.selector === query.selector
      if (query.role !== undefined && element.role !== query.role) return false
      return query.text === undefined || element.label.toLowerCase().includes(query.text.toLowerCase())
    })
    if (found.length === 0) return { ok: true, text: 'No elements matched.' }
    return {
      ok: true,
      text: [`Found ${String(found.length)} element(s):`, ...found.map((element, index) => `  [${String(index + 1)}] ${element.role} "${element.label}" · selector=${element.selector}${element.hidden === true ? ' · hidden' : ' · focusable'}`)].join('\n'),
    }
  }
  return { call, calls }
}

describe('replay executor', () => {
  it('parses candidates without letting a page label spoof the selector', () => {
    const text = '  [3] button "x" · selector=#delete" · selector=#save · focusable\n  - link "Help" · selector=a:nth-child(2) · hidden'
    expect(parseFoundCandidates(text)).toEqual([
      { index: 3, role: 'button', label: 'x" · selector=#delete', selector: '#save', hidden: false },
      { role: 'link', label: 'Help', selector: 'a:nth-child(2)', hidden: true },
    ])
    expect(candidateMatches({ role: 'button', label: 'Save', selector: '#s', hidden: false }, { role: 'button', name: 'save' })).toBe(true)
    expect(candidateMatches({ role: 'link', label: 'Save', selector: '#s', hidden: false }, { role: 'button', name: 'Save' })).toBe(false)
  })

  it('uses the cached CSS selector when it still names the recorded element', async () => {
    const page = fakePage([{ role: 'button', label: 'Save', selector: '#save' }])
    const located = await locateElement({ role: 'button', name: 'Save', css: '#save' }, page.call, new AbortController().signal)
    expect(located).toEqual({ kind: 'found', selector: '#save', via: 'css' })
  })

  it('heals a stale selector through role and name', async () => {
    const page = fakePage([{ role: 'button', label: 'Save', selector: '#save-v2' }, { role: 'button', label: 'Save draft', selector: '#draft' }])
    const located = await locateElement({ role: 'button', name: 'Save', css: '#save' }, page.call, new AbortController().signal)
    expect(located).toEqual({ kind: 'found', selector: '#save-v2', via: 'role-name' })
  })

  it('stops for the model when the lookup is ambiguous', async () => {
    const page = fakePage([{ role: 'button', label: 'Save', selector: '#a' }, { role: 'button', label: 'Save', selector: '#b' }])
    const located = await locateElement({ role: 'button', name: 'Save', css: '#gone' }, page.call, new AbortController().signal)
    expect(located.kind).toBe('ambiguous')
  })

  it('replays a workflow, re-finding every element, and reports a broken step', async () => {
    const workflow = validateWorkflow(baseWorkflow())
    const page = fakePage([
      { role: 'textbox', label: 'Name', selector: '#name' },
      { role: 'textbox', label: 'PIN', selector: '#pin-new' },
    ])
    const report = await createSequentialExecutor(page.call).runWorkflow(workflow, { pin: '9999' }, { signal: new AbortController().signal })
    expect(report.status).toBe('needs-model')
    expect(report.stoppedAt).toBe(3)
    const actions = page.calls.filter((entry) => entry.tool !== 'browser_snapshot')
    expect(actions).toEqual([
      { tool: 'browser_navigate', args: { url: 'https://crm.example/new' } },
      { tool: 'browser_type', args: { text: 'Ada', replace: true, selector: '#name' } },
      { tool: 'browser_type', args: { text: '9999', selector: '#pin-new' } },
    ])
    const text = renderReplayReport(workflow.name, report, workflow.steps.length)
    expect(text).toMatch(/stopped at step 4 of 4/)
    expect(text).toMatch(/fromStep: 4/)
    // Continue after the model did step 4 itself.
    const rest = await createSequentialExecutor(page.call).runWorkflow(workflow, { pin: '9999' }, { signal: new AbortController().signal, fromStep: 4 })
    expect(rest.status).toBe('completed')
  })

  it('stops on a refused step instead of continuing', async () => {
    const call: StepCall = async (tool) => tool === 'browser_navigate'
      ? { ok: false, code: 'approval-denied', message: 'The user denied this action' }
      : { ok: true, text: '' }
    const report = await createSequentialExecutor(call).runProgram([
      { tool: 'browser_navigate', args: { url: 'https://x.example' } },
      { tool: 'browser_click', args: { selector: '#a' } },
    ], { signal: new AbortController().signal })
    expect(report).toMatchObject({ status: 'failed', stoppedAt: 0 })
    expect(report.steps).toHaveLength(1)
  })
})

describe('workflow files and skills', () => {
  it('saves only through the sandbox-aware writer, never overwriting', async () => {
    const root = tempDir()
    const saved = await saveWorkflow({ mode: 'workspace-write', root }, baseWorkflow())
    expect(saved.relativePath).toBe('browser-workflows/add-contact.workflow.json')
    expect(statSync(saved.path).mode & 0o777).toBe(0o600)
    await expect(saveWorkflow({ mode: 'workspace-write', root }, baseWorkflow())).rejects.toThrow(/already exists/)
    expect((await loadWorkflow(root, 'add-contact')).steps).toHaveLength(4)
    writeFileSync(join(root, 'browser-workflows', 'broken.workflow.json'), '{')
    expect((await listWorkflows(root)).map((workflow) => workflow.name)).toEqual(['add-contact'])
    expect(JSON.parse(readFileSync(saved.path, 'utf8')).steps[2].args.text).toBe('{{pin}}')
  })

  it('exposes saved workflows as skills through a provider', async () => {
    const root = tempDir()
    await saveWorkflow({ mode: 'workspace-write', root }, baseWorkflow())
    let provider: { list: (o: { cwd?: string }) => Promise<readonly unknown[]>; get: (c: { locator: unknown }, o: object) => Promise<unknown> } | undefined
    const dispose = vi.fn()
    const handle = registerWorkflowSkills({
      registerProvider: (create) => {
        provider = create({ signal: new AbortController().signal, invalidate: () => {} })
        return dispose
      },
    }, '')
    const candidates = await provider!.list({ cwd: root }) as Array<{ name: string; locator: unknown }>
    expect(candidates.map((candidate) => candidate.name)).toEqual(['browser-workflow-add-contact'])
    const skill = await provider!.get(candidates[0]!, {}) as { content: string; locator?: unknown }
    expect(skill.content).toMatch(/Replay it with/)
    expect(skill.locator).toBeUndefined()
    handle.dispose()
    expect(dispose).toHaveBeenCalled()
  })
})

describe('workflow schedules', () => {
  const fakeSchedule = () => {
    const tasks = new Map<string, Record<string, unknown>>()
    const service: ScheduleServiceLike = {
      create: vi.fn(async (request) => {
        const id = `schedule-${String(tasks.size + 1)}`
        tasks.set(id, { id, ...request, status: 'active' })
        return { id, status: 'active' }
      }),
      catalog: vi.fn(async () => [...tasks.values()] as Array<{ id: string }>),
      edit: vi.fn(async (request) => { tasks.delete(request.id); return { deleted: true } }),
    }
    return { service, tasks }
  }

  it('enforces the DSH floor and a sane daily time', () => {
    expect(() => parseScheduleTiming({ kind: 'every', every_seconds: 30 })).toThrow(/at least 60/)
    expect(parseScheduleTiming({ kind: 'every', every_seconds: 3600 })).toEqual({ kind: 'every', every_seconds: 3600 })
    expect(parseScheduleTiming({ kind: 'daily', daily: { time: '09:30', time_zone: 'UTC' } })).toEqual({ kind: 'daily', daily: { time: '09:30:00', time_zone: 'UTC' } })
    expect(() => parseScheduleTiming({ kind: 'cron' })).toThrow()
    expect(schedulePrompt({ name: 'x' }, {})).toMatch(/browser_workflow_run \{"name":"x"\}/)
  })

  it('creates only for owned sessions, lists and cancels only its own schedules', async () => {
    const { service, tasks } = fakeSchedule()
    const file = join(tempDir(), 'schedules.json')
    const schedules = new WorkflowSchedules(file, () => service, async (id) => id === 'owned')
    const workflow = validateWorkflow({ ...baseWorkflow(), params: [{ name: 'contact', default: 'Ada' }], steps: (baseWorkflow().steps as unknown[]).filter((_s, i) => i !== 2) })
    await expect(schedules.create('foreign', workflow, { kind: 'every', every_seconds: 60 })).rejects.toThrow(/only sessions created/)
    const created = await schedules.create('owned', workflow, { kind: 'every', every_seconds: 60 })
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'session', sessionId: 'owned' } }))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // A schedule the model made itself is not ours to list or cancel.
    tasks.set('schedule-foreign', { id: 'schedule-foreign', title: 'Browser workflow: add-contact', status: 'active' })
    expect((await schedules.list()).map((entry) => entry.id)).toEqual([created.id])
    await expect(schedules.cancel('schedule-foreign')).rejects.toThrow(/not created by the browser bridge/)
    expect(await new WorkflowSchedules(file, () => service, async () => true).cancel(created.id)).toBe(true)
    expect(tasks.has(created.id)).toBe(false)
  })

  it('refuses unattended runs of workflows with sensitive inputs', async () => {
    const { service } = fakeSchedule()
    const schedules = new WorkflowSchedules(join(tempDir(), 's.json'), () => service, async () => true)
    await expect(schedules.create('owned', validateWorkflow(baseWorkflow()), { kind: 'every', every_seconds: 60 })).rejects.toThrow(/sensitive field/)
  })
})

describe('failure fixtures', () => {
  it('validates and writes a page capture plus masked metadata', async () => {
    const root = tempDir()
    const input = parseFixtureInput({
      tool: 'browser_type',
      args: { selector: '#name', text: 'secret words' },
      error: { code: 'action-failed', message: 'No element matched selector: #name' },
      failure: 'not-found',
      url: 'https://shop.example/cart?token=abcdefabcdefabcdefabcdef',
      page: { kind: 'dom', content: '<html><body><input id="x" value="••••"></body></html>' },
    })
    const saved = await saveFixture({ mode: 'workspace-write', root }, input, new Date('2026-11-15T10:00:00Z'))
    const meta = JSON.parse(readFileSync(join(root, saved.meta), 'utf8'))
    expect(meta.intended.args.text).not.toContain('secret')
    expect(meta.url).not.toContain('abcdef')
    expect(meta.page.file.endsWith('.html')).toBe(true)
    expect(readdirSync(join(root, 'browser-fixtures'))).toHaveLength(2)
    expect(() => parseFixtureInput({ ...input, failure: 'bogus' })).toThrow(/failure class/)
    expect(() => parseFixtureInput({ ...input, url: 'file:///etc/passwd' })).toThrow(/http/)
    await expect(saveFixture({ mode: 'workspace-write', root }, input)).resolves.toBeDefined()
  })
})

describe('site drivers', () => {
  const tokens = { cookies: [{ name: 'csrftoken', value: 'tok-123456789' }, { name: 'sessionid', value: 'sess-abcdefgh' }], metas: [] }

  it('proposes a typed driver with tokens described, never stored', () => {
    const proposal = proposeSiteDriver('https://shop.example', {
      method: 'POST',
      url: 'https://shop.example/api/cart/items',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'tok-123456789', Cookie: 'sessionid=sess-abcdefgh', 'X-Api-Key': 'zzz', Accept: 'application/json' },
      postData: '{"sku":"A-42","qty":"2","csrf":"tok-123456789"}',
    }, [{ field: 'sku', value: 'A-42' }, { field: 'qty', value: '2' }], tokens, new Date('2026-11-15T00:00:00Z'))
    const { driver } = proposal
    expect(driver.name).toBe('post_items')
    expect(driver.params.map((param) => param.name)).toEqual(['sku', 'qty'])
    expect(driver.body?.template).toBe('{"sku":"{{sku}}","qty":"{{qty}}","csrf":"{{@cookie:csrftoken}}"}')
    expect(driver.tokens).toEqual([{ header: 'x-csrftoken', source: { kind: 'cookie', name: 'csrftoken' } }])
    expect(JSON.stringify(driver)).not.toMatch(/tok-123456789|sess-abcdefgh|zzz/)
    expect(proposal.droppedHeaders).toEqual(['x-api-key'])
    expect(siteDriverToolName(driver)).toBe('site_shop_example_post_items')
    const request = buildDriverRequest(driver, { sku: 'B"1', qty: 3 })
    expect(request.body).toBe('{"sku":"B\\"1","qty":"3","csrf":"{{@cookie:csrftoken}}"}')
    expect(describeDriverRequest(request)).toMatch(/x-csrftoken: <from page cookie "csrftoken">/)
    const resolved = resolveDriverTokens(request, (source) => source.name === 'csrftoken' ? 'fresh' : undefined)
    expect(resolved.headers['x-csrftoken']).toBe('fresh')
    expect(resolved.body).toContain('"csrf":"fresh"')
    expect(() => resolveDriverTokens(request, () => undefined)).toThrow(/stale/)
  })

  it('refuses to learn or store a driver whose request carries a sensitive literal', () => {
    const login = { method: 'POST', url: 'https://shop.example/api/login', headers: { 'content-type': 'application/json' }, postData: '{"user":"ada","password":"hunter2"}' }
    expect(() => proposeSiteDriver('https://shop.example', login, [{ field: 'user', value: 'ada' }], tokens)).toThrow(/sensitive fields \(password\)/)
    const form = { method: 'POST', url: 'https://shop.example/api/x?otp=123456', headers: { 'content-type': 'application/x-www-form-urlencoded' }, postData: 'a=b' }
    expect(() => proposeSiteDriver('https://shop.example', form, [], tokens)).toThrow(/otp/)
    // A token sourced from the page is a placeholder, not a stored value.
    expect(proposeSiteDriver('https://shop.example', { ...login, postData: '{"user":"ada","csrf_token":"tok-123456789"}' }, [{ field: 'user', value: 'ada' }], tokens).driver.body?.template).toBe('{"user":"{{user}}","csrf_token":"{{@cookie:csrftoken}}"}')
    const stored = { format: 'dsh-site-driver/v1', origin: 'https://shop.example', name: 'login', description: '', method: 'POST', path: '/api/login', body: { type: 'json', template: '{"password":"hunter2"}' }, headers: {}, tokens: [], params: [] }
    expect(() => validateSiteDriver(stored)).toThrow(/sensitive fields/)
  })

  it('binds drivers to their origin at proposal, import, and execution', () => {
    expect(() => proposeSiteDriver('https://shop.example', { method: 'POST', url: 'https://evil.example/x', headers: {} }, [], tokens)).toThrow(/same-origin/)
    const good = { format: 'dsh-site-driver/v1', origin: 'https://shop.example', name: 'search', description: '', method: 'GET', path: '/s?q={{q}}', headers: {}, tokens: [], params: [{ name: 'q' }] }
    expect(validateSiteDriver(good).path).toBe('/s?q={{q}}')
    expect(() => validateSiteDriver({ ...good, path: '//evil.example/s' })).toThrow(/single "\/"/)
    expect(() => validateSiteDriver({ ...good, path: 'https://evil.example/' })).toThrow()
    expect(() => validateSiteDriver({ ...good, headers: { Authorization: 'Bearer x' } })).toThrow(/cannot be stored/)
    expect(() => validateSiteDriver({ ...good, tokens: [{ header: 'cookie', source: { kind: 'cookie', name: 'a' } }] })).toThrow(/allowed header/)
    expect(() => parseSiteDriverImport({ format: 'dsh-site-drivers/v1', drivers: [{ ...good, origin: 'javascript:alert(1)' }] })).toThrow(/origin/)
    expect(buildDriverRequest(validateSiteDriver(good), { q: 'a/b?c' }).url).toBe('https://shop.example/s?q=a%2Fb%3Fc')
    expect(() => proposeSiteDriver('https://shop.example', { method: 'GET', url: 'https://shop.example/x?t=tok-123456789', headers: {} }, [], tokens)).toThrow(/credential in its URL/)
  })
})

describe('learning mount', () => {
  function fakeCtx(root: string) {
    const registered = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    const ctx = {
      tools: {
        register: (tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
          registered.set(tool.name, tool)
          return () => { registered.delete(tool.name) }
        },
      },
      agents: { get: () => undefined },
      logger: { warn: vi.fn(), info: vi.fn() },
      get: (name: string) => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined,
    } as unknown as Context
    return { ctx, registered, root }
  }

  it('registers tools only while the extension reports the feature on, and drops them on disconnect', async () => {
    const root = tempDir()
    const { ctx, registered } = fakeCtx(root)
    const requestTool = vi.fn(async (name: string) => ({ text: `${name} ok` }))
    const mount = mountLearning(ctx, { requestTool } as never, { toolTimeoutMs: 1000, workspacePath: root, scheduleFile: join(root, 's.json'), ownsSession: async () => true })
    const rpc = (method: string, payload: unknown, connection = 'c1') => mount.rpc(method, payload, { connection, allowsSession: async (id) => id !== 'foreign' })!
    expect(registered.size).toBe(0)
    expect(await rpc(LEARNING_METHODS.saveWorkflow, { workflow: baseWorkflow() })).toMatchObject({ ok: false, error: { code: 'disabled' } })
    const driver = { format: 'dsh-site-driver/v1', origin: 'https://shop.example', name: 'search', description: 'Search', method: 'GET', path: '/s?q={{q}}', headers: {}, tokens: [], params: [{ name: 'q' }] }
    expect(await rpc(LEARNING_METHODS.state, { workflows: true, siteDrivers: [driver] })).toMatchObject({ ok: true })
    expect([...registered.keys()].sort()).toEqual(['browser_workflow_list', 'browser_workflow_run', 'site_shop_example_search'])
    const saved = await rpc(LEARNING_METHODS.saveWorkflow, { workflow: baseWorkflow() })
    expect(saved).toMatchObject({ ok: true, result: { relativePath: 'browser-workflows/add-contact.workflow.json' } })
    expect(await rpc(LEARNING_METHODS.saveWorkflow, { sessionId: 'foreign', workflow: baseWorkflow() })).toMatchObject({ ok: false })
    const listed = await registered.get('browser_workflow_list')!.execute({}, { signal: new AbortController().signal })
    expect((listed as { text: string }).text).toMatch(/add-contact \(4 steps/)
    await registered.get('site_shop_example_search')!.execute({ q: 'x' }, { signal: new AbortController().signal })
    expect(requestTool).toHaveBeenCalledWith('browser_site_driver', { origin: 'https://shop.example', driver: 'search', params: { q: 'x' } }, expect.anything(), 1000)
    const steps = [{ tool: 'browser_click', args: { selector: '#a' } }]
    expect(await rpc(LEARNING_METHODS.programRun, { steps })).toMatchObject({ ok: false, error: { code: 'disabled' } })
    await rpc(LEARNING_METHODS.state, { watchMe: true }, 'c2')
    const program = await rpc(LEARNING_METHODS.programRun, { steps }, 'c2')
    expect(program).toMatchObject({ ok: true, result: { report: { status: 'completed' } } })
    // Watch me alone does not open the workflow methods.
    expect(await rpc(LEARNING_METHODS.listWorkflows, {}, 'c2')).toMatchObject({ ok: false, error: { code: 'disabled' } })
    mount.disconnected('c2')
    mount.disconnected('c1')
    expect(registered.size).toBe(0)
  })

  it('refuses index-targeted or unsupported program steps', () => {
    expect(() => parseProgram([{ tool: 'browser_click', args: { index: 3 } }])).toThrow(/selector/)
    expect(() => parseProgram([{ tool: 'browser_console_eval', args: {} }])).toThrow(/supported/)
    expect(() => parseProgram([])).toThrow()
  })

  it('writes fixtures only while the flywheel is on', async () => {
    const root = tempDir()
    mkdirSync(root, { recursive: true })
    const { ctx } = fakeCtx(root)
    const mount = mountLearning(ctx, { requestTool: vi.fn() } as never, { toolTimeoutMs: 1000, workspacePath: root, scheduleFile: join(root, 's.json'), ownsSession: async () => true })
    const fixture = { tool: 'browser_click', args: { selector: '#x' }, error: { code: 'action-failed', message: 'nope' }, failure: 'not-found', url: 'https://a.example/', page: { kind: 'dom', content: '<p>x</p>' } }
    const context = { connection: 'c', allowsSession: async () => true }
    expect(await mount.rpc(LEARNING_METHODS.saveFixture, { fixture }, context)).toMatchObject({ ok: false, error: { code: 'disabled' } })
    await mount.rpc(LEARNING_METHODS.state, { fixtures: true }, context)
    expect(await mount.rpc(LEARNING_METHODS.saveFixture, { fixture }, context)).toMatchObject({ ok: true })
  })
})
