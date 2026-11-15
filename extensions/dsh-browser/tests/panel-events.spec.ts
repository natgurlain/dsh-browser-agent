// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  appendLiveRow,
  appendToolStep,
  applyStepAudit,
  auditByCall,
  completeToolStep,
  mergeHistoryRows,
  resultFromEvent,
  stepFromCall,
  pendingQuestionFromFrame,
  resolvedQuestionFromFrame,
  rowFromEvent,
  textFromBlocks,
  type SessionEventView,
} from '../src/panel/events.ts'

/** 构造符合真实 SessionEvent 形状（{ type, seq, time, data }）的事件。 */
function ev(type: string, data: Record<string, unknown>): SessionEventView {
  return { type, data }
}

describe('textFromBlocks', () => {
  it('extracts text blocks and ignores non-text', () => {
    expect(textFromBlocks([{ type: 'text', text: '你好' }, { type: 'reasoning', text: '思考' }])).toBe('你好')
    expect(textFromBlocks(undefined)).toBe('')
    expect(textFromBlocks([{ type: 'text' }])).toBe('')
  })
})

describe('rowFromEvent', () => {
  it('renders user messages from data.content (the real SessionEvent shape)', () => {
    const row = rowFromEvent(ev('user/message', { content: [{ type: 'text', text: '帮我看看页面' }], source: { kind: 'user' } }))
    expect(row).toEqual({ seq: 0, kind: 'user', text: '帮我看看页面' })
  })

  it('skips system-injected user/message events (source.kind = plugin)', () => {
    // dsh 每轮注入的运行时上下文（<system-reminder> 等）是 plugin 来源，
    // 绝不能渲染成用户消息。
    const injected = ev('user/message', {
      content: [{ type: 'text', text: '</system-reminder> 一段很长的系统注入…' }],
      source: { kind: 'plugin', plugin: 'workspace-context' },
    })
    expect(rowFromEvent(injected)).toBeNull()
  })

  it('renders assistant messages from data.message.content', () => {
    const row = rowFromEvent(ev('assistant/message', { message: { content: [{ type: 'text', text: '好的' }] } }))
    expect(row).toEqual({ seq: 0, kind: 'assistant', text: '好的' })
  })

  it('renders image-only and mixed multimodal messages from durable attachment refs', () => {
    const image = {
      type: 'image',
      attachment: {
        attachmentId: 'image-1', mediaType: 'image/png', bytes: 10, width: 20, height: 30, name: 'page.png',
      },
    }
    expect(rowFromEvent(ev('user/message', { content: [image], source: { kind: 'user' } }))).toEqual({
      seq: 0,
      kind: 'user',
      text: '',
      images: [image.attachment],
    })
    expect(rowFromEvent(ev('assistant/message', {
      message: { content: [{ type: 'text', text: 'I see it' }, image] },
    }))).toEqual({
      seq: 0,
      kind: 'assistant',
      text: 'I see it',
      images: [image.attachment],
    })
  })

  it('skips assistant events that contain only tool or blank blocks', () => {
    expect(rowFromEvent(ev('assistant/message', {
      message: { content: [{ type: 'tool_use', name: 'browser_snapshot' }] },
    }))).toBeNull()
    expect(rowFromEvent(ev('assistant/message', {
      message: { content: [{ type: 'text', text: '   \n' }] },
    }))).toBeNull()
  })

  it('returns null for non-message events', () => {
    expect(rowFromEvent(ev('turn/start', {}))).toBeNull()
    expect(rowFromEvent(ev('tool/call', { name: 'browser_click' }))).toBeNull()
  })
})

describe('appendLiveRow', () => {
  it('appends user and assistant rows in order', () => {
    let rows: ReturnType<typeof appendLiveRow> = []
    rows = appendLiveRow(rows, 'user', '帮我操作页面', 1)
    rows = appendLiveRow(rows, 'assistant', '完成', 2)
    expect(rows.map((r) => [r.kind, r.text])).toEqual([['user', '帮我操作页面'], ['assistant', '完成']])
  })
})

describe('step timeline', () => {
  const call = (callId: string, name: string, args: unknown, time: number): SessionEventView => ({
    type: 'tool/call', time, data: { callId, name, arguments: JSON.stringify(args) },
  })
  const result = (callId: string, text: string, time: number, extra: Record<string, unknown> = {}): SessionEventView => ({
    type: 'tool/result', time, data: { message: { callId, content: [{ type: 'text', text }], ...extra } },
  })

  it('builds steps with targets, masked arguments, results, and durations, matched by call id', () => {
    let rows = appendToolStep([], stepFromCall(call('c1', 'browser_type', { index: 4, text: 'hunter2' }, 1_000), 'x', 'en'), 1)
    rows = appendToolStep(rows, stepFromCall(call('c2', 'browser_navigate', { url: 'https://shop.test/cart?x=1' }, 1_100), 'y', 'en'), 2)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('running')
    // Parallel calls can finish out of order.
    rows = completeToolStep(rows, resultFromEvent(result('c2', 'navigated', 1_400)), 3)
    rows = completeToolStep(rows, resultFromEvent(result('c1', 'denied', 1_900, { isError: true })), 4)
    const [typed, navigated] = rows[0]!.steps!
    expect(typed).toMatchObject({ label: 'Enter text', target: '#4', status: 'error', result: 'denied', durationMs: 900 })
    expect(typed!.args).toContain('•••• (7)')
    expect(typed!.args).not.toContain('hunter2')
    expect(navigated).toMatchObject({ label: 'Open page', target: 'shop.test/cart', status: 'ok', durationMs: 300 })
    expect(rows[0]!.status).toBe('complete')
  })

  it('attaches screenshot thumbnails from result image blocks', () => {
    let rows = appendToolStep([], stepFromCall(call('s', 'browser_screenshot', {}, 0), 'x', 'en'), 1)
    const attachment = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 4, height: 3 }
    rows = completeToolStep(rows, resultFromEvent({
      type: 'tool/result', time: 5, data: { message: { callId: 's', content: [{ type: 'text', text: 'captured' }, { type: 'image', attachment }] } },
    }), 2)
    expect(rows[0]!.steps![0]).toMatchObject({ result: 'captured', images: [attachment] })
  })

  it('decorates steps with audit decisions and bridge durations', () => {
    let rows = appendToolStep([], stepFromCall(call('c1', 'browser_click', { index: 1 }, 0), 'x', 'en'), 1)
    rows = appendToolStep(rows, stepFromCall(call('c2', 'browser_click', { index: 2 }, 0), 'y', 'en'), 2)
    const audit = auditByCall([
      { kind: 'tool-call', toolCallId: 'c1' },
      { kind: 'approval', toolCallId: 'c1', decision: 'allowed' },
      { kind: 'result', toolCallId: 'c1', decision: 'allowed', durationMs: 42 },
      { kind: 'result', toolCallId: 'c2', decision: 'not-required', durationMs: 7, policy: 'tainted', strictMode: 'armed' },
      { kind: 'kill-switch' },
      'garbage',
    ])
    const decorated = applyStepAudit(rows, audit)
    expect(decorated[0]!.steps!.map((step) => [step.decision, step.durationMs])).toEqual([['allowed', 42], ['not-required', 7]])
    expect(decorated[0]!.steps![1]).toMatchObject({ policy: 'tainted', strict: 'armed' })
    expect(applyStepAudit(decorated, audit)).toBe(decorated)
    expect(applyStepAudit(rows, new Map())).toBe(rows)
    expect(auditByCall(undefined).size).toBe(0)
  })
})

describe('mergeHistoryRows', () => {
  it('aggregates tool calls and renders user/assistant text from data', () => {
    let seq = 0
    const nextSeq = (): number => { seq += 1; return seq }
    const events = [
      ev('user/message', { content: [{ type: 'text', text: '操作页面' }], source: { kind: 'user' } }),
      ev('turn/start', {}),
      ev('tool/call', { name: 'browser_snapshot', arguments: '{}' }),
      ev('tool/result', {}),
      ev('tool/call', { name: 'browser_click', arguments: '{"index":7}' }),
      ev('tool/result', {}),
      ev('tool/call', { name: 'browser_click', arguments: '{"index":8}' }),
      ev('tool/result', {}),
      ev('assistant/message', { message: { content: [{ type: 'text', text: '已点击' }] } }),
      ev('turn/end', {}),
    ]
    const rows = mergeHistoryRows(events, nextSeq, 'zh')
    expect(rows.map((r) => r.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(rows[0]!.text).toBe('操作页面')
    expect(rows[2]!.text).toBe('已点击')
    // 连续工具调用归并为一条时间线（每步一条）
    expect(rows[1]).toMatchObject({ text: '读取页面 → 点击元素 #7 → 点击元素 #8', status: 'complete' })
    expect(rows[1]!.steps!.map((step) => step.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('does not restore empty assistant rows from history', () => {
    let seq = 0
    const rows = mergeHistoryRows([
      ev('assistant/message', { message: { content: [{ type: 'tool_use', name: 'browser_snapshot' }] } }),
      ev('tool/call', { name: 'browser_snapshot', arguments: '{}' }),
      ev('tool/result', {}),
    ], () => { seq += 1; return seq }, 'zh')
    expect(rows).toMatchObject([{ kind: 'tool', text: '读取页面', status: 'complete' }])
  })

  it('keeps a step open across invisible events and fails steps a finished turn never answered', () => {
    let seq = 0
    const rows = mergeHistoryRows([
      { type: 'tool/call', data: { callId: 'a', name: 'browser_click', arguments: '{"index":1}' } },
      // Context injected while the call ran (e.g. the resume delta) renders nothing.
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'ctx' }], source: { kind: 'browser-context' } } } },
      { type: 'tool/result', data: { message: { callId: 'a', content: [{ type: 'text', text: 'clicked' }] } } },
      { type: 'tool/call', data: { callId: 'b', name: 'browser_snapshot', arguments: '{}' } },
      { type: 'turn/end', data: {} },
    ], () => { seq += 1; return seq }, 'en')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.steps!.map((step) => [step.callId, step.status])).toEqual([['a', 'ok'], ['b', 'error']])
    expect(rows[0]!.status).toBe('complete')
  })

  it('handles empty history', () => {
    expect(mergeHistoryRows([], () => 0)).toEqual([])
  })
})

describe('question mux frames', () => {
  it('parses the full question, compact header, options, and session identity', () => {
    expect(pendingQuestionFromFrame({
      rpcId: 'question-rpc',
      method: 'question/requested',
      payload: {
        sessionId: 'session-1',
        questions: [{
          id: 'database',
          header: 'Database',
          question: 'Which database should we use?',
          detail: 'Choose the default for local development.',
          options: [{ label: 'SQLite', description: 'No setup required' }, { label: 'Postgres' }],
          multiSelect: false,
        }],
      },
    })).toEqual({
      rpcId: 'question-rpc',
      sessionId: 'session-1',
      questions: [{
        id: 'database',
        header: 'Database',
        question: 'Which database should we use?',
        detail: 'Choose the default for local development.',
        options: [{ label: 'SQLite', description: 'No setup required' }, { label: 'Postgres' }],
        multiSelect: false,
      }],
    })
  })

  it('rejects malformed question payloads instead of trusting mux data', () => {
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'session/event', payload: {} })).toBeNull()
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'question/requested', payload: null })).toBeNull()
    expect(pendingQuestionFromFrame({ rpcId: 'r', method: 'question/requested', payload: { sessionId: 5, questions: [] } })).toBeNull()
    expect(pendingQuestionFromFrame({
      rpcId: 'r', method: 'question/requested',
      payload: { sessionId: 's', questions: [{ id: 'q', question: 'Question?', options: [{ label: 4 }] }] },
    })).toBeNull()
  })

  it('accepts wire-valid empty strings and repeated question ids', () => {
    expect(pendingQuestionFromFrame({
      rpcId: '', method: 'question/requested',
      payload: {
        sessionId: 's',
        questions: [
          { id: '', question: '', options: [{ label: '' }] },
          { id: '', question: 'Repeated id' },
        ],
      },
    })).toEqual({
      rpcId: '',
      sessionId: 's',
      questions: [
        { id: '', question: '', options: [{ label: '' }] },
        { id: '', question: 'Repeated id' },
      ],
    })
  })

  it('extracts both identifiers required to match question/resolved', () => {
    expect(resolvedQuestionFromFrame({
      rpcId: 'event-rpc',
      method: 'question/resolved',
      payload: { sessionId: 'session-1', questionRpcId: 'question-rpc' },
    })).toEqual({ sessionId: 'session-1', rpcId: 'question-rpc' })
    expect(resolvedQuestionFromFrame({
      rpcId: 'event-rpc', method: 'question/resolved', payload: { sessionId: 'session-1' },
    })).toBeNull()
  })
})
