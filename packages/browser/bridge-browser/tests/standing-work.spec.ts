/**
 * Standing work: the bridge tells each connected extension whether the Host
 * holds unattended work for it (workflow schedules, the MCP endpoint), in the
 * MAC-bound `hello.ok` caps and in a sealed event when that changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_STANDING_EVENT_METHOD,
  MAX_STANDING_SCHEDULES,
  STANDING_WORK_CAPS_VERSION,
  BridgeFrameChannel,
  bridgeClientKey,
  computeBridgeProof,
  isStandingWork,
  parseBridgeFrame,
  type BridgeFrame,
  type StandingWork,
} from '../src/protocol.ts'
import { LEARNING_METHODS, mountLearning } from '../src/learning/index.ts'
import { WorkflowSchedules, type ScheduleServiceLike } from '../src/learning/schedules.ts'
import {
  closeTestBridges,
  connectClient,
  endpointOf,
  openSocket,
  sendHello,
  startTestBridge,
  testHostApi,
  TEST_CAPS,
  TEST_TOKEN,
  waitFor,
} from './support/bridge-client.ts'
import { fakeContext } from './support/fake-ctx.ts'
import { tempDirs } from './support/tmp.ts'

const tempDir = tempDirs('dsh-standing-')

afterEach(closeTestBridges)

const identity = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...TEST_CAPS, client: { id, browser: 'chrome' }, ...extra })
const helloOk = (frames: readonly BridgeFrame[]): Extract<BridgeFrame, { t: 'hello.ok' }> =>
  frames.find((frame) => frame.t === 'hello.ok') as Extract<BridgeFrame, { t: 'hello.ok' }>
const standingEvents = (frames: readonly BridgeFrame[]): unknown[] => frames
  .filter((frame): frame is Extract<BridgeFrame, { t: 'event' }> => frame.t === 'event' && frame.frame.method === BRIDGE_STANDING_EVENT_METHOD)
  .map((frame) => frame.frame.payload)

describe('standing-work validation', () => {
  it('requires well-typed known keys and ignores keys it does not know', () => {
    expect(isStandingWork({ schedules: 0, mcp: false })).toBe(true)
    expect(isStandingWork({ schedules: 3, mcp: true })).toBe(true)
    expect(isStandingWork({ schedules: MAX_STANDING_SCHEDULES, mcp: false })).toBe(true)
    for (const bad of [
      undefined, null, 1, 'x', [], { schedules: 1 }, { mcp: true }, { schedules: -1, mcp: false }, { schedules: 1.5, mcp: false },
      { schedules: '1', mcp: false }, { schedules: 1, mcp: 1 }, { schedules: MAX_STANDING_SCHEDULES + 1, mcp: false },
      { schedules: Number.NaN, mcp: false },
    ]) expect(isStandingWork(bad), JSON.stringify(bad)).toBe(false)
    // A later bridge may add reasons: the extra key is not a reason to refuse.
    expect(isStandingWork({ schedules: 1, mcp: true, watchers: 9 })).toBe(true)
  })

  it('drops a hello.ok or hello whose standing caps are malformed, and parses well-formed ones', () => {
    const mac = 'a'.repeat(64)
    const ok = (caps: Record<string, unknown>): string => JSON.stringify({ t: 'hello.ok', caps: { ...TEST_CAPS, ...caps }, mac })
    expect(parseBridgeFrame(ok({}))).toBeDefined()
    expect(parseBridgeFrame(ok({ standing: { schedules: 2, mcp: true } }))).toMatchObject({ caps: { standing: { schedules: 2, mcp: true } } })
    expect(parseBridgeFrame(ok({ standing: { schedules: 'many', mcp: true } }))).toBeUndefined()
    expect(parseBridgeFrame(ok({ standing: true }))).toBeUndefined()
    expect(parseBridgeFrame(ok({ standingUpdates: STANDING_WORK_CAPS_VERSION }))).toBeDefined()
    // Forward compatibility: a newer version or an extra key never drops the handshake frame.
    expect(parseBridgeFrame(ok({ standingUpdates: 2 }))).toBeDefined()
    expect(parseBridgeFrame(ok({ standing: { schedules: 2, mcp: true, jobs: 4 } }))).toBeDefined()
    // Wrong types for known keys are still refused.
    expect(parseBridgeFrame(ok({ standingUpdates: 'yes' }))).toBeUndefined()
    expect(parseBridgeFrame(ok({ standingUpdates: 0 }))).toBeUndefined()
  })
})

describe('standing work in hello.ok', () => {
  it('sends each install its own hint, bound into the server proof', async () => {
    const work: Record<string, StandingWork> = {
      [bridgeClientKey({ id: 'client-aaaa', browser: 'chrome' })]: { schedules: 2, mcp: true },
    }
    const h = await startTestBridge({ standingWork: (connection) => work[connection] ?? { schedules: 0, mcp: true } })
    const caps = identity('client-aaaa', { standingUpdates: STANDING_WORK_CAPS_VERSION })
    const socket = await openSocket(h.url)
    const clientNonce = await sendHello(socket.ws, TEST_TOKEN, caps)
    await waitFor(() => socket.frames.some((frame) => frame.t === 'hello.ok'))
    const ok = helloOk(socket.frames)
    expect(ok.caps.standing).toEqual({ schedules: 2, mcp: true })
    const challenge = socket.frames.find((frame) => frame.t === 'challenge') as Extract<BridgeFrame, { t: 'challenge' }>
    // The proof covers the caps exactly as sent: a relay cannot add or strip the hint.
    expect(ok.mac).toBe(await computeBridgeProof(TEST_TOKEN, 'server', clientNonce, challenge.nonce, endpointOf(socket.ws), { client: caps, server: ok.caps }))
    const { standing: _standing, ...stripped } = ok.caps
    expect(ok.mac).not.toBe(await computeBridgeProof(TEST_TOKEN, 'server', clientNonce, challenge.nonce, endpointOf(socket.ws), { client: caps, server: stripped }))

    const other = await connectClient(h.url, identity('client-bbbb'))
    expect(helloOk(other.frames).caps.standing).toEqual({ schedules: 0, mcp: true })
  })

  it('sends no hint when the plugin supplies none, or a malformed one', async () => {
    const plain = await startTestBridge()
    expect(helloOk((await connectClient(plain.url, identity('client-aaaa'))).frames).caps.standing).toBeUndefined()
    const broken = await startTestBridge({ standingWork: () => ({ schedules: -4, mcp: true }) })
    expect(helloOk((await connectClient(broken.url, identity('client-aaaa'))).frames).caps.standing).toBeUndefined()
  })

  it('never echoes standing caps a client or the plugin config put in the shared caps', async () => {
    const h = await startTestBridge({ caps: { ...TEST_CAPS, standing: { schedules: 9, mcp: true }, standingUpdates: 1 } })
    const client = await connectClient(h.url, identity('client-aaaa', { standingUpdates: STANDING_WORK_CAPS_VERSION }))
    expect(helloOk(client.frames).caps.standing).toBeUndefined()
    expect(helloOk(client.frames).caps.standingUpdates).toBeUndefined()
  })
})

describe('standing-work change events', () => {
  it('a client announcing a standingUpdates version this bridge does not know connects and is sent no events', async () => {
    let work: StandingWork = { schedules: 0, mcp: false }
    const h = await startTestBridge({ standingWork: () => work })
    const future = await connectClient(h.url, identity('client-aaaa', { standingUpdates: 2 }))
    expect(helloOk(future.frames).caps.standing).toEqual({ schedules: 0, mcp: false })
    work = { schedules: 2, mcp: false }
    h.bridge.notifyStandingWork()
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    expect(standingEvents(future.frames)).toEqual([])
  })

  it('a plugin hint with an extra key is sent as the two known fields only', async () => {
    const h = await startTestBridge({ standingWork: () => ({ schedules: 1, mcp: false, jobs: 3 }) as StandingWork })
    const client = await connectClient(h.url, identity('client-aaaa'))
    expect(helloOk(client.frames).caps.standing).toEqual({ schedules: 1, mcp: false })
  })

  it('sends the change event as a sealed frame whose MAC verifies with the connection keys, and a tampered copy does not', async () => {
    let work: StandingWork = { schedules: 0, mcp: false }
    const h = await startTestBridge({ standingWork: () => work })
    const caps = identity('client-aaaa', { standingUpdates: STANDING_WORK_CAPS_VERSION })
    const socket = await openSocket(h.url)
    const raw: string[] = []
    socket.ws.on('message', (data) => { raw.push(data.toString()) })
    const clientNonce = await sendHello(socket.ws, TEST_TOKEN, caps)
    await waitFor(() => socket.frames.some((frame) => frame.t === 'hello.ok'))
    work = { schedules: 5, mcp: true }
    h.bridge.notifyStandingWork()
    await waitFor(() => standingEvents(socket.frames).length === 1)
    const challenge = socket.frames.find((frame) => frame.t === 'challenge') as Extract<BridgeFrame, { t: 'challenge' }>
    const sealed = raw.filter((text) => (JSON.parse(text) as { t?: string }).t === 'sealed')
    // On the wire the event exists only inside a sealed envelope.
    expect(raw.filter((text) => text.includes(BRIDGE_STANDING_EVENT_METHOD)).every((text) => sealed.includes(text))).toBe(true)
    const carrier = sealed.findIndex((text) => text.includes(BRIDGE_STANDING_EVENT_METHOD))
    expect(carrier).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(sealed[carrier]!)).toMatchObject({ t: 'sealed', seq: expect.any(Number), mac: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    // An independent channel derived from the handshake values accepts every frame in order...
    const verifier = BridgeFrameChannel.derive(TEST_TOKEN, 'client', challenge.nonce, clientNonce, endpointOf(socket.ws))
    const opened = sealed.slice(0, carrier + 1).map((text) => verifier.open(text))
    expect(opened.at(-1)).toEqual({ t: 'event', frame: { rpcId: '', method: BRIDGE_STANDING_EVENT_METHOD, payload: { schedules: 5, mcp: true } } })
    // ...and refuses the same frame with its payload altered.
    const tamperer = BridgeFrameChannel.derive(TEST_TOKEN, 'client', challenge.nonce, clientNonce, endpointOf(socket.ws))
    for (const text of sealed.slice(0, carrier)) expect(tamperer.open(text)).toBeDefined()
    expect(tamperer.open(sealed[carrier]!.replace('\\"schedules\\":5', '\\"schedules\\":6'))).toBeUndefined()
    expect(sealed[carrier]).toContain('\\"schedules\\":5')
  })

  it('tells a connected extension when its hint changes, and only then', async () => {
    let work: StandingWork = { schedules: 0, mcp: false }
    const h = await startTestBridge({ standingWork: () => work })
    const client = await connectClient(h.url, identity('client-aaaa', { standingUpdates: STANDING_WORK_CAPS_VERSION }))
    h.bridge.notifyStandingWork()
    work = { schedules: 1, mcp: false }
    h.bridge.notifyStandingWork()
    h.bridge.notifyStandingWork()
    await waitFor(() => standingEvents(client.frames).length === 1)
    work = { schedules: 0, mcp: false }
    h.bridge.notifyStandingWork()
    await waitFor(() => standingEvents(client.frames).length === 2)
    expect(standingEvents(client.frames)).toEqual([{ schedules: 1, mcp: false }, { schedules: 0, mcp: false }])
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(standingEvents(client.frames)).toHaveLength(2)
  })

  it('an older extension (no standingUpdates) still connects and is never sent the event', async () => {
    let work: StandingWork = { schedules: 0, mcp: false }
    const h = await startTestBridge({ standingWork: () => work })
    const old = await connectClient(h.url, identity('client-aaaa'))
    const current = await connectClient(h.url, identity('client-bbbb', { standingUpdates: STANDING_WORK_CAPS_VERSION }))
    work = { schedules: 4, mcp: true }
    h.bridge.notifyStandingWork()
    await waitFor(() => standingEvents(current.frames).length === 1)
    expect(old.frames.filter((frame) => frame.t === 'event')).toHaveLength(0)
    expect((await old.rpc('session.list', {})).ok).toBe(true)
  })

  it('never forwards a Host stream event that uses the reserved method', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const h = await startTestBridge({
      standingWork: () => ({ schedules: 0, mcp: false }),
      api: testHostApi({
        async *events() {
          await held
          yield { rpcId: 'x', method: BRIDGE_STANDING_EVENT_METHOD, payload: { schedules: 7, mcp: true } }
          yield { rpcId: 'y', method: 'session/state', payload: { sessionId: 's' } }
        },
      }),
    })
    const client = await connectClient(h.url, identity('client-aaaa', { standingUpdates: STANDING_WORK_CAPS_VERSION }))
    release()
    await waitFor(() => client.frames.some((frame) => frame.t === 'event' && frame.frame.method === 'session/state'))
    expect(standingEvents(client.frames)).toEqual([])
  })
})

describe('standing schedules per install', () => {
  function setup(records: Array<{ id: string; install?: string }>) {
    const root = tempDir()
    mkdirSync(root, { recursive: true })
    const file = join(root, 's.json')
    const tasks = new Map<string, { id: string; status: string }>()
    for (const record of records) tasks.set(record.id, { id: record.id, status: 'active' })
    writeFileSync(file, JSON.stringify(records.map((record) => ({ ...record, sessionId: 'owned', workflow: 'w', timing: { kind: 'every', every_seconds: 60 } }))))
    const service: ScheduleServiceLike = {
      create: vi.fn(async () => ({ id: 'x', status: 'active' })),
      catalog: vi.fn(async () => [...tasks.values()]),
      edit: vi.fn(async (request) => { tasks.delete(request.id); return {} }),
    }
    const { ctx } = fakeContext({
      get: (name) => name === 'schedule' ? service : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined,
    })
    const onSchedulesChanged = vi.fn()
    const mount = mountLearning(ctx, { requestTool: vi.fn() } as never, {
      toolTimeoutMs: 1000, workspacePath: root, scheduleFile: file, ownsSession: async () => true, onSchedulesChanged,
    })
    const as = (connection: string) => ({ connection, allowsSession: async () => true })
    return { mount, as, onSchedulesChanged, file, service }
  }

  it('counts an install\'s own schedules plus older records that name none', async () => {
    const { mount, onSchedulesChanged } = setup([{ id: 's1', install: 'a' }, { id: 's2', install: 'a' }, { id: 's3', install: 'b' }, { id: 's4' }])
    // Nothing is claimed before the records are read.
    expect(mount.standingSchedules('a')).toBe(0)
    await vi.waitFor(() => { expect(onSchedulesChanged).toHaveBeenCalled() })
    expect(mount.standingSchedules('a')).toBe(3)
    expect(mount.standingSchedules('b')).toBe(2)
    expect(mount.standingSchedules('c')).toBe(1)
  })

  it('recounts and reports after a cancel and after the kill switch', async () => {
    const { mount, as, onSchedulesChanged } = setup([{ id: 's1', install: 'a' }, { id: 's2', install: 'a' }])
    await vi.waitFor(() => { expect(mount.standingSchedules('a')).toBe(2) })
    onSchedulesChanged.mockClear()
    expect(await mount.rpc(LEARNING_METHODS.scheduleCancel, { id: 's1' }, as('a'))).toMatchObject({ ok: true })
    expect(mount.standingSchedules('a')).toBe(1)
    expect(onSchedulesChanged).toHaveBeenCalledTimes(1)
    await mount.revokeStandingGrants()
    expect(mount.standingSchedules('a')).toBe(0)
    expect(onSchedulesChanged).toHaveBeenCalledTimes(2)
    mount.dispose()
    expect(mount.standingSchedules('a')).toBe(0)
  })

  it('countByInstall groups the recorded schedules', async () => {
    const { file, service } = setup([{ id: 's1', install: 'a' }, { id: 's2' }, { id: 's3', install: 'a' }])
    const schedules = new WorkflowSchedules(file, () => service, async () => true)
    expect([...await schedules.countByInstall()]).toEqual([['a', 2], [undefined, 1]])
  })
})
