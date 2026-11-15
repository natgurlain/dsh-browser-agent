/**
 * Pure conversation-rendering logic: maps session events (live and history)
 * to display rows. Kept framework-free so the wire shapes are unit-tested
 * against the REAL SessionEvent contract: `{ type, seq, time, data }` — the
 * payload always lives in `data`, never on the event root.
 *
 * @module
 */

import { getUiLocale, type UiLocale } from '../i18n.ts'
import { imageRefsFromBlocks, type ImageAttachmentRef } from './attachments.ts'
import { PANEL_COPY } from './strings.ts'

/**
 * One step of the agent's browser timeline: a tool call and, once it
 * finished, its outcome. Decision and duration come from the bridge's audit
 * log when it is available; the session's own timestamps fill in otherwise.
 */
export interface ToolStep {
  /** The model's tool-call id (joins the call, its result, and audit entries). */
  callId: string
  name: string
  /** Localized action label, e.g. "Click element". */
  label: string
  /** What the step acted on: "#7", a selector, a host and path, a key. */
  target?: string
  /** Pretty-printed arguments with typed text masked. */
  args?: string
  /** Result text preview (truncated). */
  result?: string
  status: 'running' | 'ok' | 'error'
  startedAt?: number
  durationMs?: number
  /** Approval decision recorded in the audit log. */
  decision?: string
  /** Policy layer outcome (`blocked`, `tainted`, `site-ask`, `site-trusted`). */
  policy?: string
  /** Strict mode (`armed`, `refused`). */
  strict?: string
  /** Screenshot (or other image) the step returned. */
  images?: ImageAttachmentRef[]
}

/** One rendered conversation row. */
export interface Row {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'info'
  text: string
  images?: ImageAttachmentRef[]
  status?: 'running' | 'complete'
  /** Tool rows: one entry per step, in call order. */
  steps?: ToolStep[]
}

/** Minimal view of a SessionEvent (payload in `data`). */
export interface SessionEventView {
  type: string
  seq?: number
  /** Unix epoch milliseconds. */
  time?: number
  surfaceOp?: unknown
  data?: {
    content?: unknown
    source?: { kind?: string }
    message?: { content?: unknown; source?: { kind?: string }; callId?: string; isError?: boolean }
    turn?: number
    step?: number
    callId?: string
    name?: string
    arguments?: string
    title?: unknown
  }
}

/** One user-selectable answer exposed by ask_user_question. */
export interface QuestionOption {
  label: string
  description?: string
}

/** One item in a question batch. */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** Pending interaction belonging to one dsh session. */
export interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: QuestionItem[]
}

/** Identity carried by question/resolved; both fields must match before clearing UI. */
export interface ResolvedQuestion {
  rpcId: string
  sessionId: string
}

/** The gateway mux envelope shape carried inside a bridge event frame. */
export interface EventFrameView {
  rpcId: string
  method: string
  payload: unknown
}

export function pendingQuestionFromFrame(frame: EventFrameView): PendingQuestion | null {
  if (typeof frame.rpcId !== 'string' || frame.method !== 'question/requested' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rawQuestions = frame.payload.questions
  if (typeof sessionId !== 'string' || !Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: QuestionItem[] = []
  for (const value of rawQuestions) {
    const question = parseQuestionItem(value)
    if (question === null) return null
    questions.push(question)
  }
  return { rpcId: frame.rpcId, sessionId, questions }
}

export function resolvedQuestionFromFrame(frame: EventFrameView): ResolvedQuestion | null {
  if (frame.method !== 'question/resolved' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rpcId = frame.payload.questionRpcId
  return typeof sessionId === 'string' && typeof rpcId === 'string' ? { sessionId, rpcId } : null
}

function parseQuestionItem(value: unknown): QuestionItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') return null
  if (value.header !== undefined && typeof value.header !== 'string') return null
  if (value.detail !== undefined && typeof value.detail !== 'string') return null
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') return null
  let options: QuestionOption[] | undefined
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) return null
    options = []
    for (const rawOption of value.options) {
      if (!isRecord(rawOption) || typeof rawOption.label !== 'string') return null
      if (rawOption.description !== undefined && typeof rawOption.description !== 'string') return null
      options.push({
        label: rawOption.label,
        ...(rawOption.description === undefined ? {} : { description: rawOption.description }),
      })
    }
  }
  return {
    id: value.id,
    question: value.question,
    ...(value.header === undefined ? {} : { header: value.header }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(options === undefined ? {} : { options }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract model-visible text from content blocks (defensive: unknown block shapes degrade to markers). */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Map one session event to a row (user/assistant only; tools handled separately). */
export function rowFromEvent(event: SessionEventView): Row | null {
  switch (event.type) {
    case 'user/message': {
      // Every turn, dsh logs the runtime's constant context as a user/message with
      // source.kind='plugin' (e.g. injected <system-reminder> content). These are not user
      // messages; rendering them would pollute the conversation, so they must be skipped.
      const message = event.data?.message ?? event.data
      const source = message?.source
      if (source?.kind !== 'user') return null
      const blocks = message?.content
      const text = textFromBlocks(blocks)
      const images = imageRefsFromBlocks(blocks)
      return text.trim() === '' && images.length === 0
        ? null
        : { seq: 0, kind: 'user', text, ...(images.length === 0 ? {} : { images }) }
    }
    case 'assistant/message': {
      // A tool call also produces an assistant/message, but its content may hold only
      // non-text blocks such as tool_use. Do not render an empty AI bubble for such an intermediate event.
      const blocks = event.data?.message?.content
      const text = textFromBlocks(blocks)
      const images = imageRefsFromBlocks(blocks)
      return text.trim() === '' && images.length === 0
        ? null
        : { seq: 0, kind: 'assistant', text, ...(images.length === 0 ? {} : { images }) }
    }
    default:
      return null
  }
}

/** Argument names whose values the timeline never shows (only their length). */
const MASKED_ARGS = new Set(['text', 'promptText', 'password', 'secret', 'token', 'value', 'values'])
const MAX_PREVIEW = 600

function parseArgs(argsJson: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(String(argsJson ?? '{}')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function hostAndPath(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return raw
  }
}

/** The thing a step acted on, as a short label. */
export function stepTarget(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  const end = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const { index, selector } = value as Record<string, unknown>
    return typeof index === 'number' ? `#${index}` : typeof selector === 'string' ? selector : undefined
  }
  if (typeof args.index === 'number') return `#${args.index}`
  if (typeof args.selector === 'string' && args.selector !== '') return args.selector
  const from = end(args.from)
  if (from !== undefined) return `${from} → ${end(args.to) ?? '…'}`
  if (typeof args.url === 'string' && args.url !== '') return hostAndPath(args.url)
  if (typeof args.key === 'string' && args.key !== '') return args.key
  if (typeof args.tabId === 'number') return `tab ${args.tabId}`
  return undefined
}

/** Arguments for the expandable preview, with typed text replaced by its length. */
export function maskedArgsPreview(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined || Object.keys(args).length === 0) return undefined
  const masked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    masked[key] = MASKED_ARGS.has(key) && typeof value === 'string' ? `•••• (${value.length})` : value
  }
  const text = JSON.stringify(masked, null, 2)
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text
}

/** A running step from a `tool/call` event. */
export function stepFromCall(event: SessionEventView, fallbackId: string, locale: UiLocale = getUiLocale()): ToolStep {
  const name = event.data?.name ?? 'tool'
  const args = parseArgs(event.data?.arguments)
  const target = stepTarget(args)
  const preview = maskedArgsPreview(args)
  return {
    callId: event.data?.callId ?? fallbackId,
    name,
    label: PANEL_COPY[locale].tool.labels[name] ?? name,
    ...(target === undefined ? {} : { target }),
    ...(preview === undefined ? {} : { args: preview }),
    status: 'running',
    ...(event.time === undefined ? {} : { startedAt: event.time }),
  }
}

/** The outcome carried by a `tool/result` event. */
export interface StepResult {
  callId?: string
  isError: boolean
  text: string
  images: ImageAttachmentRef[]
  time?: number
}

export function resultFromEvent(event: SessionEventView): StepResult {
  const message = event.data?.message
  const text = textFromBlocks(message?.content ?? [])
  return {
    ...(message?.callId === undefined ? {} : { callId: message.callId }),
    isError: message?.isError === true,
    text: text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text,
    images: imageRefsFromBlocks(message?.content),
    ...(event.time === undefined ? {} : { time: event.time }),
  }
}

function stepsText(steps: ToolStep[]): string {
  return steps.map((step) => step.target === undefined ? step.label : `${step.label} ${step.target}`).join(' → ')
}

function toolRow(seq: number, steps: ToolStep[]): Row {
  return {
    seq,
    kind: 'tool',
    text: stepsText(steps),
    status: steps.some((step) => step.status === 'running') ? 'running' : 'complete',
    steps,
  }
}

/** Add one running step: consecutive tool calls share one timeline row. */
export function appendToolStep(rows: Row[], step: ToolStep, seq: number): Row[] {
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    const steps = [...(last.steps ?? []).filter((existing) => existing.callId !== step.callId), step]
    return [...rows.slice(0, -1), toolRow(seq, steps)]
  }
  return [...rows, toolRow(seq, [step])]
}

/** Finish the step a `tool/result` answers (by call id; else the oldest running step). */
export function completeToolStep(rows: Row[], result: StepResult, seq: number): Row[] {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind !== 'tool' || row.steps === undefined) continue
    const position = result.callId === undefined
      ? row.steps.findIndex((step) => step.status === 'running')
      : row.steps.findIndex((step) => step.callId === result.callId)
    if (position < 0) continue
    const steps = row.steps.map((step, at) => at !== position ? step : {
      ...step,
      status: result.isError ? 'error' as const : 'ok' as const,
      ...(result.text === '' ? {} : { result: result.text }),
      ...(result.images.length === 0 ? {} : { images: result.images }),
      ...(step.durationMs === undefined && step.startedAt !== undefined && result.time !== undefined
        ? { durationMs: Math.max(0, result.time - step.startedAt) }
        : {}),
    })
    const next = [...rows]
    next[index] = { ...toolRow(index === rows.length - 1 ? seq : row.seq, steps) }
    return next
  }
  return rows
}

/** What the audit log knows about one step. */
export interface StepAudit {
  decision?: string
  durationMs?: number
  policy?: string
  strict?: string
}

/** Index audit-log entries by the model's tool-call id. */
export function auditByCall(entries: unknown): Map<string, StepAudit> {
  const byCall = new Map<string, StepAudit>()
  if (!Array.isArray(entries)) return byCall
  for (const raw of entries) {
    if (!isRecord(raw) || typeof raw.toolCallId !== 'string') continue
    const current = byCall.get(raw.toolCallId) ?? {}
    if (raw.kind === 'approval' && typeof raw.decision === 'string') current.decision = raw.decision
    if (typeof raw.policy === 'string') current.policy = raw.policy
    if (typeof raw.strictMode === 'string') current.strict = raw.strictMode
    if (raw.kind === 'result') {
      if (typeof raw.decision === 'string' && current.decision === undefined) current.decision = raw.decision
      if (typeof raw.durationMs === 'number') current.durationMs = raw.durationMs
    }
    byCall.set(raw.toolCallId, current)
  }
  return byCall
}

/** Decorate timeline steps with decisions and bridge-measured durations. */
export function applyStepAudit(rows: Row[], audit: Map<string, StepAudit>): Row[] {
  if (audit.size === 0) return rows
  let changed = false
  const next = rows.map((row) => {
    if (row.kind !== 'tool' || row.steps === undefined) return row
    let rowChanged = false
    const steps = row.steps.map((step) => {
      const found = audit.get(step.callId)
      if (found === undefined) return step
      const decision = found.decision ?? step.decision
      const durationMs = found.durationMs ?? step.durationMs
      const policy = found.policy ?? step.policy
      const strict = found.strict ?? step.strict
      if (decision === step.decision && durationMs === step.durationMs && policy === step.policy && strict === step.strict) return step
      rowChanged = true
      return {
        ...step,
        ...(decision === undefined ? {} : { decision }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(policy === undefined ? {} : { policy }),
        ...(strict === undefined ? {} : { strict }),
      }
    })
    if (!rowChanged) return row
    changed = true
    return { ...row, steps }
  })
  return changed ? next : rows
}

/** Live append: user and assistant message rows (tool calls go through appendToolStep and merge into the timeline). */
export function appendLiveRow(
  rows: Row[],
  kind: Row['kind'],
  text: string,
  seq: number,
  images?: ImageAttachmentRef[],
): Row[] {
  return [...rows, { seq, kind, text, ...(images === undefined || images.length === 0 ? {} : { images }) }]
}

/**
 * History rendering: the same merge rules as the live path. Consecutive tool calls merge into
 * one timeline and results are filled in by callId. Events that produce no visible row (injected
 * browser context, request headers, etc.) do not break the timeline; a step that still has no
 * result at `turn/end` is treated as interrupted.
 */
export function mergeHistoryRows(
  events: SessionEventView[],
  nextSeq: () => number,
  locale: UiLocale = getUiLocale(),
): Row[] {
  let rows: Row[] = []
  let fallback = 0
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      fallback += 1
      rows = appendToolStep(rows, stepFromCall(ev, `history-${fallback}-${ev.seq ?? 0}`, locale), nextSeq())
      continue
    }
    if (ev.type === 'tool/result') {
      rows = completeToolStep(rows, resultFromEvent(ev), nextSeq())
      continue
    }
    if (ev.type === 'turn/end') {
      rows = settleInterruptedSteps(rows)
      continue
    }
    const row = rowFromEvent(ev)
    if (row !== null) rows.push({ ...row, seq: nextSeq() })
  }
  return rows
}

/** Steps still running when their turn ended never got a result: show them as failed. */
function settleInterruptedSteps(rows: Row[]): Row[] {
  if (!rows.some((row) => row.steps?.some((step) => step.status === 'running') === true)) return rows
  return rows.map((row) => row.steps === undefined || !row.steps.some((step) => step.status === 'running')
    ? row
    : { ...row, status: 'complete', steps: row.steps.map((step) => step.status === 'running' ? { ...step, status: 'error' as const } : step) })
}
