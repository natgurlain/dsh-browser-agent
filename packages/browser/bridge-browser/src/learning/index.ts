/**
 * Phase 3 learning features, bridge side: saved workflows (record → save →
 * replay → schedule), site-driver tools, program runs from "Watch me", and
 * failure fixtures.
 *
 * Everything is default OFF. The extension owns the switches; it reports
 * them with `bridge.learning.state`, and the model-facing tools (workflow
 * run/list, one tool per saved site driver) and the workflow skill provider
 * exist only while a connected extension has the matching feature on. A
 * dropped connection withdraws its state.
 *
 * Every browser step these features take is an ordinary `requestTool` call,
 * so it keeps the extension's full path (pause gate, site policy, taint, kill
 * switch, payload-bound approval card, audit log). Files are written only
 * through `writeWorkspaceFile`.
 *
 * @module @natgurlain/dsh-bridge-browser/src/learning
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BridgeServer } from '../server.ts'
import { BridgeToolError, toolCallIdArg } from '../server.ts'
import { auditResultDigest, redactAuditUrl } from '../audit-log.ts'
import { workspaceWriteTarget } from '../workspace-write.ts'
import { parseFixtureInput, saveFixture } from './fixtures.ts'
import { createSequentialExecutor, renderReplayReport, type BrowserProgramRunner, type ProgramStep, type ReplayReport, type StepCall, type WorkflowExecutor } from './replay.ts'
import { MAX_PROGRAM_STEPS as BROWSER_RUN_MAX_STEPS, parseProgram as parseBrowserRunProgram, renderProgramOutcome, runProgram as runBrowserRun } from '../run-program.ts'
import { parseScheduleTiming, WorkflowSchedules, type ScheduleServiceLike } from './schedules.ts'
import { parseSiteDrivers, siteDriverToolName, type SiteDriverSummary } from './site-drivers.ts'
import { listWorkflows, loadWorkflow, registerWorkflowSkills, saveWorkflow, workspaceRootOf, type SkillsServiceLike } from './store.ts'
import { WorkflowError } from './workflow.ts'

/** Extension → bridge learning RPC methods. */
export const LEARNING_METHODS = {
  state: 'bridge.learning.state',
  saveWorkflow: 'bridge.learning.workflow.save',
  listWorkflows: 'bridge.learning.workflow.list',
  scheduleCreate: 'bridge.learning.schedule.create',
  scheduleList: 'bridge.learning.schedule.list',
  scheduleCancel: 'bridge.learning.schedule.cancel',
  programRun: 'bridge.learning.program.run',
  saveFixture: 'bridge.learning.fixture.save',
} as const

/** Most steps a "Watch me" program may hold (one `browser_run`). */
const MAX_PROGRAM_STEPS = BROWSER_RUN_MAX_STEPS

/** Tools a program step may call. */
const PROGRAM_TOOLS = new Set(['browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_wait'])

/** Budget for one whole replay (each step keeps its own budget). */
const REPLAY_TIMEOUT_MS = 30 * 60_000

/** What the RPC handler needs from the server per call. */
export interface LearningRpcContext {
  connection: string
  allowsSession: (sessionId: string, access: 'read' | 'own' | 'write') => Promise<boolean>
}

/** One RPC answer (same shape as the audit RPCs). */
export type LearningRpcAnswer = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }

/** Features one extension connection has switched on. */
interface ConnectionState {
  workflows: boolean
  fixtures: boolean
  watchMe: boolean
  drivers: SiteDriverSummary[]
}

/** Options from the plugin config. */
export interface LearningOptions {
  toolTimeoutMs: number
  workspacePath: string
  scheduleFile: string
  /** Session ownership check (the bridge's ledger, `own` access). */
  ownsSession: (sessionId: string) => Promise<boolean>
  /** Mark a session tainted: a fixture puts page content where its file tools can read it. */
  markTainted?: (sessionId: string) => void
  /** Record a saved fixture in the session's keyed audit chain. */
  audit?: (sessionId: string | undefined, entry: { tool: string; url: string; decision: string; resultDigest?: string }) => void
}

/** The handle `index.ts` wires into the server. */
export interface LearningMount {
  rpc: (method: string, payload: unknown, context: LearningRpcContext) => Promise<LearningRpcAnswer> | undefined
  disconnected: (connection: string) => void
  /** The user's kill switch: revoke every standing grant (workflow schedules). */
  revokeStandingGrants: () => Promise<void>
  dispose: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorAnswer(code: string, error: unknown): LearningRpcAnswer {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
}

/** Build a step caller bound to one session (undefined: agentless). */
export function bridgeStepCall(bridge: Pick<BridgeServer, 'requestTool'>, toolTimeoutMs: number, sessionId: string | undefined, callId?: string): StepCall {
  return async (tool, args, signal) => {
    try {
      const result = sessionId === undefined
        ? await bridge.requestTool(tool, args, signal, toolTimeoutMs)
        : callId === undefined
          ? await bridge.requestTool(tool, args, signal, toolTimeoutMs, sessionId)
          : await bridge.requestTool(tool, args, signal, toolTimeoutMs, sessionId, callId)
      const text = isRecord(result) && typeof result.text === 'string' ? result.text : ''
      return { ok: true, text }
    } catch (error: unknown) {
      return {
        ok: false,
        code: error instanceof BridgeToolError ? error.code : 'internal',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/**
 * A `browser_run`-backed program runner: one program card in the extension,
 * then each step claims it (run-program.ts), every step through the full path.
 */
export function browserRunRunner(bridge: Pick<BridgeServer, 'requestTool'>, toolTimeoutMs: number, sessionId: string | undefined, toolCallId?: string): BrowserProgramRunner {
  return async (steps, signal) => {
    const parsed = parseBrowserRunProgram(steps.map((step) => ({ tool: step.tool, args: step.args })))
    const outcome = await runBrowserRun(bridge, parsed, {
      signal, ...(sessionId === undefined ? {} : { sessionId }), ...(toolCallId === undefined ? {} : { toolCallId }),
    }, { toolTimeoutMs })
    const status: ReplayReport['status'] = outcome.stop === 'completed' ? 'completed' : outcome.stop === 'cancelled' ? 'cancelled' : 'failed'
    return {
      status,
      steps: outcome.steps.map((step) => ({ step: step.step - 1, tool: step.tool, status: step.ok && step.guard?.ok !== false ? 'done' as const : 'failed' as const, message: step.text })),
      ...(status === 'completed' ? {} : { stoppedAt: Math.max(0, outcome.steps.length - 1) }),
      text: renderProgramOutcome(outcome, parsed.length),
    } as ReplayReport
  }
}

/** Validate a "Watch me" program sent by the panel. */
export function parseProgram(value: unknown): ProgramStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROGRAM_STEPS) {
    throw new Error(`a program needs 1–${String(MAX_PROGRAM_STEPS)} steps`)
  }
  return value.map((step, index) => {
    if (!isRecord(step) || typeof step.tool !== 'string' || !PROGRAM_TOOLS.has(step.tool) || !isRecord(step.args)) {
      throw new Error(`program step ${String(index + 1)} is not a supported browser action`)
    }
    if (step.args.index !== undefined) throw new Error(`program step ${String(index + 1)} must use a selector, not a snapshot index`)
    return { tool: step.tool, args: { ...step.args } }
  })
}

/**
 * Mount the learning features.
 * @param ctx - plugin context.
 * @param bridge - the bridge server (tool dispatch).
 * @param options - resolved options.
 * @param executorFor - executor factory seam (tests; a later `browser_run` executor).
 */
export function mountLearning(
  ctx: Context,
  bridge: Pick<BridgeServer, 'requestTool'>,
  options: LearningOptions,
  executorFor: (call: StepCall, runBrowserProgram?: BrowserProgramRunner) => WorkflowExecutor = createSequentialExecutor,
): LearningMount {
  const states = new Map<string, ConnectionState>()
  const schedules = new WorkflowSchedules(
    options.scheduleFile,
    () => (ctx.get as (name: string) => unknown)('schedule') as ScheduleServiceLike | undefined,
    options.ownsSession,
  )
  let workflowDisposers: Array<() => void> | undefined
  let skills: { dispose: () => void; invalidate: () => void } | undefined
  const driverDisposers = new Map<string, () => void>()

  const sessionOf = (exec: Pick<ToolRunContext, 'agent'>): string | undefined => exec.agent === undefined ? undefined : String(exec.agent.id)
  const rootOf = (exec: Pick<ToolRunContext, 'agent'>): string => {
    const root = workspaceRootOf(exec.agent, options.workspacePath)
    if (root === undefined) throw new WorkflowError('this session has no workspace directory, so it has no saved workflows.')
    return root
  }
  const execCall = (exec: Pick<ToolRunContext, 'agent' | 'signal'> & object): StepCall =>
    bridgeStepCall(bridge, options.toolTimeoutMs, sessionOf(exec), toolCallIdArg(exec)[0])

  const workflowTools = (): ToolDefinition[] => [
    defineTool({
      name: 'browser_workflow_list',
      description: 'List the browser workflows saved in this session\'s workspace (name, parameters, steps).',
      parameters: {},
      timeoutMs: 10_000,
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: (v as { text: string }).text }] },
      execute: async (_args, exec) => {
        const workflows = await listWorkflows(rootOf(exec))
        if (workflows.length === 0) return { text: 'No saved browser workflows in this workspace.' }
        return {
          text: workflows.map((workflow) => `${workflow.name} (${String(workflow.steps.length)} steps; params: ${workflow.params.map((param) => `${param.name}${param.default === undefined ? '*' : ''}`).join(', ') || 'none'})${workflow.description === '' ? '' : ` — ${workflow.description}`}`).join('\n'),
        }
      },
    }),
    defineTool({
      name: 'browser_workflow_run',
      description: 'Replay a saved browser workflow step by step without further model calls. Each step re-finds its element (recorded selector, then role/name, then text) and passes the usual approval cards. Returns only when the workflow finishes or a step breaks; then do that step yourself and continue with fromStep.',
      parameters: {
        name: { type: 'string', required: true, description: 'Workflow name from browser_workflow_list.' },
        params: { type: 'object', additionalProperties: true, description: 'Parameter values by name.' },
        fromStep: { type: 'number', description: '0-based step to start from (to continue after a broken step).' },
      },
      timeoutMs: REPLAY_TIMEOUT_MS,
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: (v as { text: string }).text }] },
      execute: async (args, exec) => {
        const a = args as { name: string; params?: Record<string, unknown>; fromStep?: number }
        const workflow = await loadWorkflow(rootOf(exec), a.name).catch((error: unknown) => {
          throw new WorkflowError(`workflow "${a.name}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
        })
        const report = await executorFor(execCall(exec)).runWorkflow(workflow, a.params ?? {}, {
          signal: exec.signal,
          ...(typeof a.fromStep === 'number' ? { fromStep: Math.floor(a.fromStep) } : {}),
        })
        return { text: renderReplayReport(workflow.name, report, workflow.steps.length) }
      },
    }),
  ]

  const siteDriverTool = (driver: SiteDriverSummary): ToolDefinition => defineTool({
    name: siteDriverToolName(driver),
    description: `Site driver for ${driver.origin} (experimental, user-approved): ${driver.description} Sends one ${driver.method} request from the page; the user sees the exact request on an approval card. Works only while the controlled tab is on ${driver.origin}; if it fails, do the task through the page UI instead.`.slice(0, 1_000),
    parameters: Object.fromEntries(driver.params.map((param) => [param.name, {
      type: 'string' as const, required: true, description: param.description ?? `Value for ${param.name}.`,
    }])),
    timeoutMs: options.toolTimeoutMs,
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: (v as { text: string }).text }] },
    execute: async (args, exec) => {
      const result = await execCall(exec)('browser_site_driver', { origin: driver.origin, driver: driver.name, params: args as Record<string, unknown> }, exec.signal)
      if (!result.ok) throw new Error(`${result.message} Fall back to the page UI for this task.`)
      return { text: result.text }
    },
  })

  const sync = (): void => {
    const all = [...states.values()]
    const workflowsOn = all.some((state) => state.workflows)
    if (workflowsOn && workflowDisposers === undefined) {
      workflowDisposers = workflowTools().map((tool) => ctx.tools.register(tool))
      const service = (ctx.get as (name: string) => unknown)('skills') as SkillsServiceLike | undefined
      if (service !== undefined && typeof service.registerProvider === 'function') {
        try {
          skills = registerWorkflowSkills(service)
        } catch (error: unknown) {
          ctx.logger.warn(`browser bridge: workflow skills unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else if (!workflowsOn && workflowDisposers !== undefined) {
      for (const dispose of workflowDisposers) dispose()
      workflowDisposers = undefined
      skills?.dispose()
      skills = undefined
    }
    const wanted = new Map<string, SiteDriverSummary>()
    for (const state of all) for (const driver of state.drivers) wanted.set(siteDriverToolName(driver), driver)
    for (const [name, dispose] of driverDisposers) {
      if (!wanted.has(name)) {
        dispose()
        driverDisposers.delete(name)
      }
    }
    for (const [name, driver] of wanted) {
      if (!driverDisposers.has(name)) driverDisposers.set(name, ctx.tools.register(siteDriverTool(driver)))
    }
  }

  const sessionWriteTarget = (sessionId: string | undefined) => workspaceWriteTarget(
    ctx,
    sessionId === undefined ? undefined : (ctx.agents as unknown as { get?: (id: string) => unknown }).get?.(sessionId),
    options.workspacePath,
  )
  const featureOn = (connection: string, feature: 'workflows' | 'fixtures' | 'watchMe'): boolean => states.get(connection)?.[feature] === true
  const ownedSession = async (payload: Record<string, unknown>, context: LearningRpcContext): Promise<string | undefined> => {
    const sessionId = payload.sessionId
    if (sessionId === undefined) return undefined
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId must be a non-empty string')
    if (!await context.allowsSession(sessionId, 'own').catch(() => false)) throw new Error(`session ${JSON.stringify(sessionId)} is not available to the browser bridge`)
    return sessionId
  }

  const revokeSchedules = async (why: string): Promise<void> => {
    try {
      const { revoked, failed } = await schedules.revokeAll()
      if (revoked > 0 || failed > 0) ctx.logger.info(`browser bridge: ${why}; revoked ${String(revoked)} workflow schedule(s)${failed > 0 ? `, ${String(failed)} could not be deleted` : ''}`)
    } catch (error: unknown) {
      ctx.logger.warn(`browser bridge: could not revoke workflow schedules: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const rpc = (method: string, payload: unknown, context: LearningRpcContext): Promise<LearningRpcAnswer> | undefined => {
    if (!(Object.values(LEARNING_METHODS) as string[]).includes(method)) return undefined
    return (async (): Promise<LearningRpcAnswer> => {
      const body = isRecord(payload) ? payload : {}
      try {
        if (method === LEARNING_METHODS.state) {
          const before = states.get(context.connection)
          states.set(context.connection, {
            workflows: body.workflows === true,
            fixtures: body.fixtures === true,
            watchMe: body.watchMe === true,
            drivers: body.siteDrivers === undefined ? [] : parseSiteDrivers(body.siteDrivers),
          })
          sync()
          // The user turned saved workflows off: their schedules end with them.
          if (before?.workflows === true && body.workflows !== true) await revokeSchedules('saved workflows were turned off')
          return { ok: true, result: { tools: [...driverDisposers.keys(), ...(workflowDisposers === undefined ? [] : ['browser_workflow_run', 'browser_workflow_list'])] } }
        }
        if (method === LEARNING_METHODS.saveFixture) {
          if (!featureOn(context.connection, 'fixtures')) return { ok: false, error: { code: 'disabled', message: 'failure fixtures are turned off' } }
          const sessionId = await ownedSession(body, context)
          const fixture = parseFixtureInput(body.fixture)
          const saved = await saveFixture(sessionWriteTarget(sessionId), fixture)
          if (sessionId !== undefined) options.markTainted?.(sessionId)
          options.audit?.(sessionId, { tool: 'browser_failure_fixture', url: redactAuditUrl(fixture.url), decision: fixture.failure, resultDigest: auditResultDigest(fixture.page.content) })
          return { ok: true, result: saved }
        }
        // Listing and cancelling schedules always work, so a feature turned
        // off (or a stale state) never strands a standing grant.
        if (method === LEARNING_METHODS.scheduleList || method === LEARNING_METHODS.scheduleCancel) {
          const sessionId = await ownedSession(body, context)
          if (method === LEARNING_METHODS.scheduleList) return { ok: true, result: { schedules: await schedules.list(sessionId) } }
          if (typeof body.id !== 'string') throw new Error('id must name a schedule')
          return { ok: true, result: { cancelled: await schedules.cancel(body.id) } }
        }
        if (method === LEARNING_METHODS.programRun) {
          if (!featureOn(context.connection, 'watchMe')) return { ok: false, error: { code: 'disabled', message: 'Watch me is turned off in the extension settings' } }
        } else if (!featureOn(context.connection, 'workflows')) {
          return { ok: false, error: { code: 'disabled', message: 'saved workflows are turned off in the extension settings' } }
        }
        const sessionId = await ownedSession(body, context)
        switch (method) {
          case LEARNING_METHODS.saveWorkflow: {
            const saved = await saveWorkflow(sessionWriteTarget(sessionId), body.workflow)
            skills?.invalidate()
            return { ok: true, result: { name: saved.workflow.name, relativePath: saved.relativePath, path: saved.path, steps: saved.workflow.steps.length } }
          }
          case LEARNING_METHODS.listWorkflows: {
            const agent = sessionId === undefined ? undefined : (ctx.agents as unknown as { get?: (id: string) => unknown }).get?.(sessionId)
            const root = workspaceRootOf(agent, options.workspacePath)
            const workflows = root === undefined ? [] : await listWorkflows(root)
            return { ok: true, result: { workflows: workflows.map((workflow) => ({ name: workflow.name, description: workflow.description, steps: workflow.steps.length, params: workflow.params })) } }
          }
          case LEARNING_METHODS.scheduleCreate: {
            if (sessionId === undefined) throw new Error('a schedule needs the session that owns the workflow')
            const agent = (ctx.agents as unknown as { get?: (id: string) => unknown }).get?.(sessionId)
            const root = workspaceRootOf(agent, options.workspacePath)
            if (root === undefined || typeof body.workflow !== 'string') throw new Error('workflow must name a saved workflow')
            const workflow = await loadWorkflow(root, body.workflow)
            const params = isRecord(body.params) ? Object.fromEntries(Object.entries(body.params).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {}
            return { ok: true, result: await schedules.create(sessionId, workflow, parseScheduleTiming(body.timing), params) }
          }
          case LEARNING_METHODS.programRun: {
            const program = parseProgram(body.steps)
            const controller = new AbortController()
            const timer = setTimeout(() => { controller.abort() }, REPLAY_TIMEOUT_MS)
            try {
              const report = await executorFor(
                bridgeStepCall(bridge, options.toolTimeoutMs, sessionId),
                browserRunRunner(bridge, options.toolTimeoutMs, sessionId),
              ).runProgram(program, { signal: controller.signal })
              return { ok: true, result: { report, text: report.text ?? renderReplayReport('watch-me program', report, program.length) } }
            } finally {
              clearTimeout(timer)
            }
          }
        }
        return { ok: false, error: { code: 'bad-request', message: `unknown method ${method}` } }
      } catch (error: unknown) {
        return errorAnswer(error instanceof WorkflowError ? 'bad-request' : 'failed', error)
      }
    })()
  }

  return {
    rpc,
    disconnected: (connection) => {
      if (states.delete(connection)) sync()
    },
    revokeStandingGrants: () => revokeSchedules('kill switch engaged'),
    dispose: () => {
      states.clear()
      sync()
    },
  }
}
