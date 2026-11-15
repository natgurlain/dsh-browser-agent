// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_TURN_GRACE_MS,
  AGENT_TURN_MAX_IDLE_MS,
  CommitGate,
  commitApprovalPrompt,
  isMutatingMethod,
  summarizeRequestBody,
  type PausedRequest,
} from '../src/background/commit-gate.ts'
import type { DebuggerBroker } from '../src/background/debugger-broker.ts'
import type { DevToolsSessionListeners } from '../src/background/debugger-session.ts'
import type { ApprovalAuthorization } from '../src/security/approval.ts'
import { resolveApprovalGate } from '../src/background/authorization.ts'

const form = (body: string, extra: Partial<PausedRequest['request']> = {}): PausedRequest['request'] => ({
  url: 'https://shop.example/checkout?step=2',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  postData: body,
  ...extra,
})

describe('request body summaries', () => {
  it('lists form fields and masks sensitive ones', () => {
    const summary = summarizeRequestBody(form('name=Ada&password=hunter2&card_number=4111111111111111&note=hi+there'))
    expect(summary.fields).toBe(4)
    expect(summary.sensitive).toBe(true)
    expect(summary.text).toContain('name = "Ada"')
    expect(summary.text).toContain('note = "hi there"')
    expect(summary.text).not.toContain('hunter2')
    expect(summary.text).not.toContain('4111')
    expect(summary.text).toContain('2 sensitive field(s) shown masked below')
    // Sensitive values stay available to reveal on the card, never dropped.
    expect(summary.sensitiveText).toContain('password = "hunter2"')
    expect(summary.sensitiveText).toContain('card_number = "4111111111111111"')
  })

  it('flattens JSON, reads multipart field names and files, and describes unseen bodies', () => {
    const json = summarizeRequestBody({ url: 'https://x/', method: 'PUT', headers: { 'content-type': 'application/json' }, postData: JSON.stringify({ user: { email: 'a@b.c', apiKey: 'sk-1' }, qty: 2 }) })
    expect(json.text).toContain('user.email = "a@b.c"')
    expect(json.text).toContain('qty = "2"')
    expect(json.text).not.toContain('sk-1')
    const multipart = summarizeRequestBody({
      url: 'https://x/', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b' },
      postData: '--b\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n--b\r\nContent-Disposition: form-data; name="doc"; filename="a.txt"\r\n\r\nabc\r\n--b--',
    })
    expect(multipart.text).toContain('title = "Hello"')
    expect(multipart.text).toContain('doc = file "a.txt"')
    expect(summarizeRequestBody({ url: 'https://x/', method: 'POST', hasPostData: true }).text).toMatch(/not available/)
    expect(summarizeRequestBody({ url: 'https://x/', method: 'DELETE' }).text).toBe('(no body)')
  })

  it('builds a forced, untrustable card naming the destination', () => {
    const prompt = commitApprovalPrompt({ requestId: '1', request: form('email=a%40b.c') })
    expect(prompt).toMatchObject({ action: 'network_commit', forced: true, canTrust: false, origins: ['https://shop.example'] })
    expect(prompt.summary).toBe('This will send 1 field(s) to https://shop.example/checkout (POST)')
    expect(prompt.details?.[0]).toMatchObject({ kind: 'text', label: 'POST https://shop.example/checkout?step=2' })
    expect(resolveApprovalGate({ prompt, devToolsAllowed: true, devToolsSessionGrant: true, unrestrictedAccess: true, coveredByTrustedOrigins: true })).toBe('prompt')
    expect(isMutatingMethod('get')).toBe(false)
    expect(isMutatingMethod('PATCH')).toBe(true)
  })
})

function fakeBroker() {
  const sent: Array<[string, Record<string, unknown> | undefined]> = []
  let listeners: DevToolsSessionListeners = {}
  const session = { isAttached: true, send: vi.fn(async (method: string, params?: Record<string, unknown>) => { sent.push([method, params]); return {} }) }
  const release = vi.fn(async () => {})
  const broker = {
    acquire: vi.fn(async (_tabId: number, _owner: string, options?: { listeners?: DevToolsSessionListeners }) => {
      listeners = options?.listeners ?? {}
      return { session, release }
    }),
    attachedSession: () => session,
  } as unknown as DebuggerBroker
  return { broker, sent, session, release, event: (method: string, params: unknown) => listeners.onCdpEvent?.(method, params), detach: () => listeners.onDetached?.('target_closed') }
}

describe('CommitGate', () => {
  it('passes reads and user writes, and holds agent writes behind an approval', async () => {
    let now = 1_000
    const { broker, sent, event } = fakeBroker()
    const answers: ApprovalAuthorization[] = ['approved', 'denied']
    const ask = vi.fn(async () => answers.shift() ?? 'unavailable')
    const gate = new CommitGate({ broker, ask, now: () => now })
    await gate.arm(7)
    expect(gate.isArmed(7)).toBe(true)
    expect(sent[0]).toEqual(['Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }])
    const settled = async () => { await vi.waitFor(() => { expect(sent.length).toBeGreaterThan(count) }); count = sent.length; return sent.at(-1)! }
    let count = sent.length

    event('Fetch.requestPaused', { requestId: 'r1', request: form('a=1') })
    expect(await settled()).toEqual(['Fetch.continueRequest', { requestId: 'r1' }])
    expect(ask).not.toHaveBeenCalled()

    gate.callStarted(7)
    event('Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://shop.example/', method: 'GET' } })
    expect(await settled()).toEqual(['Fetch.continueRequest', { requestId: 'r2' }])
    event('Fetch.requestPaused', { requestId: 'r3', request: form('a=1') })
    expect(await settled()).toEqual(['Fetch.continueRequest', { requestId: 'r3' }])
    event('Fetch.requestPaused', { requestId: 'r4', request: form('a=2') })
    expect(await settled()).toEqual(['Fetch.failRequest', { requestId: 'r4', errorReason: 'BlockedByClient' }])
    expect(ask).toHaveBeenCalledTimes(2)
    gate.callEnded(7)
    // An unended turn outlasts the short grace (a page timer cannot wait it out)…
    now += AGENT_TURN_GRACE_MS + 1
    expect(gate.agentTurnActive(7)).toBe(true)
    now += AGENT_TURN_MAX_IDLE_MS
    expect(gate.agentTurnActive(7)).toBe(false)
    // …and once the turn is seen to end, only the grace remains.
    gate.callStarted(7)
    gate.callEnded(7)
    gate.turnEnded(7)
    now += AGENT_TURN_GRACE_MS - 1
    expect(gate.agentTurnActive(7)).toBe(true)
    now += 2
    expect(gate.agentTurnActive(7)).toBe(false)
  })

  it('adopts tabs the strict tab opens during an agent turn', async () => {
    let now = 1_000
    const { broker } = fakeBroker()
    const gate = new CommitGate({ broker, ask: async () => 'approved', now: () => now })
    expect(gate.adoptOpened(8, 7)).toBe(false)
    await gate.arm(7)
    expect(gate.adoptOpened(8, 7)).toBe(false)
    gate.callStarted(7)
    expect(gate.adoptOpened(8, 7)).toBe(true)
    expect(gate.agentTurnActive(8)).toBe(true)
    gate.callEnded(7)
    gate.turnEnded(7)
    now += AGENT_TURN_GRACE_MS + 1
    expect(gate.agentTurnActive(8)).toBe(false)
  })

  it('fails a held write when asking throws, and drops the armed state when detached', async () => {
    const { broker, sent, event, detach } = fakeBroker()
    const gate = new CommitGate({ broker, ask: async () => { throw new Error('panel gone') } })
    await gate.arm(3)
    gate.callStarted(3)
    event('Fetch.requestPaused', { requestId: 'x', request: form('a=1') })
    await vi.waitFor(() => { expect(sent.at(-1)).toEqual(['Fetch.failRequest', { requestId: 'x', errorReason: 'BlockedByClient' }]) })
    detach()
    expect(gate.isArmed(3)).toBe(false)
    await gate.arm(3)
    expect(gate.isArmed(3)).toBe(true)
    await gate.disarm(3)
    expect(sent.at(-1)).toEqual(['Fetch.disable', {}])
    expect(gate.isArmed(3)).toBe(false)
  })

  it('refuses to arm when Fetch cannot be enabled', async () => {
    const { broker, session, release } = fakeBroker()
    session.send.mockRejectedValueOnce(new Error('Another debugger is attached'))
    const gate = new CommitGate({ broker, ask: async () => 'approved' })
    await expect(gate.arm(1)).rejects.toThrow(/Another debugger/)
    expect(gate.isArmed(1)).toBe(false)
    expect(release).toHaveBeenCalled()
  })

  it('arms once for overlapping arm calls, so one disarm releases the only lease (M2)', async () => {
    const { broker, release } = fakeBroker()
    const gate = new CommitGate({ broker, ask: async () => 'approved' })
    await Promise.all([gate.arm(4), gate.arm(4)])
    expect(broker.acquire).toHaveBeenCalledTimes(1)
    expect(gate.isArmed(4)).toBe(true)
    await gate.disarm(4)
    expect(release).toHaveBeenCalledTimes(1)
    expect(gate.isArmed(4)).toBe(false)
    // Arming again afterwards takes a fresh lease.
    await gate.arm(4)
    expect(broker.acquire).toHaveBeenCalledTimes(2)
  })

  it('a failed arm is shared by the overlapping caller and leaves nothing held', async () => {
    const { broker, session, release } = fakeBroker()
    session.send.mockRejectedValueOnce(new Error('Another debugger is attached'))
    const gate = new CommitGate({ broker, ask: async () => 'approved' })
    const results = await Promise.allSettled([gate.arm(2), gate.arm(2)])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(broker.acquire).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    await gate.arm(2)
    expect(gate.isArmed(2)).toBe(true)
  })

  it('forget releases the lease of a closed tab', async () => {
    const { broker, release } = fakeBroker()
    const gate = new CommitGate({ broker, ask: async () => 'approved' })
    await gate.arm(6)
    await gate.forget(6)
    expect(release).toHaveBeenCalledTimes(1)
    expect(gate.isArmed(6)).toBe(false)
  })
})

describe('request body summaries: raw and broken bodies (G24)', () => {
  it('masks a sensitive raw-text body', () => {
    const summary = summarizeRequestBody({ url: 'https://x/', method: 'POST', headers: { 'content-type': 'text/plain' }, postData: 'user=ada password=hunter2' })
    expect(summary.sensitive).toBe(true)
    expect(summary.text).not.toContain('hunter2')
    expect(summary.sensitiveText).toContain('hunter2')
  })

  it('marks an invalid-JSON body with a secret name as sensitive', () => {
    const summary = summarizeRequestBody({ url: 'https://x/', method: 'POST', headers: { 'content-type': 'application/json' }, postData: '{"password": "hunter2"' })
    expect(summary.sensitive).toBe(true)
    expect(summary.text).not.toContain('hunter2')
  })
})
