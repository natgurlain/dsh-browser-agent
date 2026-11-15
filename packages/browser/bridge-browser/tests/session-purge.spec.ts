import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
// DSH 0.2.1 publishes the JSONL backend as a function-style plugin
// (`name`/`Config`/`apply`) and no longer default-exports its class, so the
// namespace itself is the plugin.
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionPurgeError, assertPurgeableSessionId, createSessionPurger, purgeSessionFiles } from '../src/session-purge.ts'

const resolveModule = (name: string): string => pathToFileURL(createRequire(import.meta.url).resolve(name)).href

const SESSION_A = 'session-82222a77-aab5-4c0b-b33e-6376973ec93d'
const SESSION_B = 'session-92bad0de-136e-4d1f-a308-d1f5388d608f'

const tempRoots: string[] = []
const acquireOwnership = async (): Promise<{ close(): Promise<void> }> => ({ close: async () => {} })
const archiveSession = async (): Promise<void> => {}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function makeSessionsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-session-purge-'))
  tempRoots.push(root)
  return root
}

async function makeSession(root: string, workspace: string, sessionId: string): Promise<string> {
  const dir = path.join(root, workspace, sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.jsonl.zstd'), 'x')
  return dir
}

/** Try materializing the same id from a different process during purge teardown. */
async function contendForSession(root: string): Promise<unknown> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Context } from ${JSON.stringify(resolveModule('@deepseek-ai/cordis'))}
    import * as JsonlSessionPersistence from ${JSON.stringify(resolveModule('@deepseek-ai/dsh-session-persistence-jsonl'))}
    import { SESSION_FORMAT_VERSION, SessionId } from ${JSON.stringify(resolveModule('@deepseek-ai/dsh-session'))}
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root: process.argv[1], compression: 'none' })
      const handle = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION, id: SessionId(${JSON.stringify(SESSION_A)}),
        createdAt: 2000, cwd: process.argv[1], isSeeded: false,
      })
      try { await handle.flush(); process.send('acquired') }
      catch (error) { process.send(error.name) }
      finally { await handle.close() }
    } finally { await ctx.fiber.dispose(); process.disconnect() }
  `, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostic = ''
  child.stderr?.on('data', (chunk: Buffer) => { diagnostic += chunk.toString() })
  const exited = once(child, 'exit')
  try {
    const result = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code]) => { throw new Error(`contender exited ${String(code)}: ${diagnostic}`) }),
    ])
    await exited
    return result
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await exited
    }
  }
}

describe('assertPurgeableSessionId', () => {
  it('accepts the persisted session-id shape', () => {
    expect(assertPurgeableSessionId(SESSION_A)).toBe(SESSION_A)
  })

  it.each([
    ['../escape'],
    ['workspace/../../escape'],
    ['not-a-uuid'],
    ['session-82222a77'],
    [''],
  ])('rejects %j', (sessionId) => {
    expect(() => assertPurgeableSessionId(sessionId)).toThrow(SessionPurgeError)
    try {
      assertPurgeableSessionId(sessionId)
    } catch (error) {
      expect((error as SessionPurgeError).code).toBe('invalid-id')
    }
  })
})

describe('purgeSessionFiles', () => {
  it('removes session data while preserving lock files and sibling sessions', async () => {
    const root = await makeSessionsRoot()
    const targetA = await makeSession(root, '--Users-apple-browser-sessions--', SESSION_A)
    const targetB = await makeSession(root, '--other-workspace--', SESSION_A)
    const sibling = await makeSession(root, '--Users-apple-browser-sessions--', SESSION_B)
    await writeFile(path.join(targetA, 'session.lock'), '')
    const lockBefore = await stat(path.join(targetA, 'session.lock'))

    await purgeSessionFiles({ archiveSession, acquireOwnership, sessionsRoot: root, runningSessionIds: new Set() }, SESSION_A)

    expect(await readdir(targetA)).toEqual(['session.lock'])
    expect((await stat(path.join(targetA, 'session.lock'))).ino).toBe(lockBefore.ino)
    expect(await readdir(targetB)).toEqual([])
    await expect(stat(sibling)).resolves.toBeTruthy()
  })

  it('refuses running sessions before touching the disk', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)

    await expect(purgeSessionFiles(
      { archiveSession, acquireOwnership, sessionsRoot: root, runningSessionIds: new Set([SESSION_A]) },
      SESSION_A,
    )).rejects.toMatchObject({ code: 'running' })
    await expect(stat(target)).resolves.toBeTruthy()
  })

  it('reports not-found when no durable directory matches', async () => {
    const root = await makeSessionsRoot()
    await expect(purgeSessionFiles({ archiveSession, acquireOwnership, sessionsRoot: root, runningSessionIds: new Set() }, SESSION_A))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('rejects ids that do not match the persisted shape', async () => {
    const root = await makeSessionsRoot()
    await expect(purgeSessionFiles({ archiveSession, acquireOwnership, sessionsRoot: root, runningSessionIds: new Set() }, '../escape'))
      .rejects.toMatchObject({ code: 'invalid-id' })
  })

  it('never follows a session-directory symlink when removing child files', async () => {
    const root = await makeSessionsRoot()
    const external = await makeSessionsRoot()
    await writeFile(path.join(external, 'session.jsonl.zstd'), 'keep')
    await mkdir(path.join(root, 'ws'))
    await symlink(external, path.join(root, 'ws', SESSION_A), 'dir')

    await expect(purgeSessionFiles({
      archiveSession, acquireOwnership, sessionsRoot: root, runningSessionIds: new Set(),
    }, SESSION_A)).rejects.toMatchObject({ code: 'not-found' })
    expect(await readdir(external)).toEqual(['session.jsonl.zstd'])
  })

  it('keeps every generation intact when exclusive ownership is refused', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)
    await writeFile(path.join(target, 'session.v3.jsonl.zstd'), 'current')
    const busy = Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
    const archiveSession = vi.fn()
    await expect(purgeSessionFiles({
      archiveSession,
      sessionsRoot: root,
      runningSessionIds: new Set(),
      acquireOwnership: vi.fn().mockRejectedValue(busy),
    }, SESSION_A)).rejects.toMatchObject({ code: 'running', message: expect.stringContaining('restart') })
    expect(await readdir(target)).toEqual(['session.jsonl.zstd', 'session.v3.jsonl.zstd'])
    expect(archiveSession).not.toHaveBeenCalled()
  })

  it('archives under ownership before removing data and releasing the handle', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)
    const close = vi.fn(async () => { expect(await readdir(target)).toEqual([]) })
    const archiveSession = vi.fn(async () => {
      expect(claim).toHaveBeenCalledOnce()
      expect(await readdir(target)).toContain('session.jsonl.zstd')
    })
    const claim = vi.fn(async () => {
      await expect(stat(target)).resolves.toBeTruthy()
      return { close }
    })
    await purgeSessionFiles({
      archiveSession,
      sessionsRoot: root, runningSessionIds: new Set(), acquireOwnership: claim,
    }, SESSION_A)
    expect(claim).toHaveBeenCalledWith(SESSION_A)
    expect(close).toHaveBeenCalledTimes(1)
    expect(archiveSession).toHaveBeenCalledWith(SESSION_A)
  })

  it('fails closed when the runtime cannot establish ownership', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)
    await expect(purgeSessionFiles({
      archiveSession,
      sessionsRoot: root,
      runningSessionIds: new Set(),
      acquireOwnership: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    }, SESSION_A)).rejects.toMatchObject({ code: 'internal' })
    await expect(stat(target)).resolves.toBeTruthy()
  })

  it('preserves data on archive failure and preserves that error if close also fails', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)
    const close = vi.fn().mockRejectedValue(new Error('close failed'))
    await expect(purgeSessionFiles({
      sessionsRoot: root,
      runningSessionIds: new Set(),
      acquireOwnership: async () => ({ close }),
      archiveSession: vi.fn().mockRejectedValue(new Error('archive refused')),
    }, SESSION_A)).rejects.toMatchObject({
      code: 'internal', message: expect.stringContaining('archive refused'),
      cause: expect.any(AggregateError),
    })
    expect(await readdir(target)).toEqual(['session.jsonl.zstd'])
    expect(close).toHaveBeenCalledOnce()
  })

  it('archives a cold persisted session before deleting the data required by the real archive API', async () => {
    const root = await makeSessionsRoot()
    const sessionsRoot = path.join(root, 'sessions')
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' })
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: path.join(root, 'registry') })
      const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      await ctx.plugin(WorkspaceRegistry)

      // Create after WorkspaceRegistry startup, so its header cache is cold.
      const created = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION, id: SessionId(SESSION_A),
        createdAt: 1000, cwd: root, isSeeded: false,
      })
      await created.flush()
      await created.close()
      await purgeSessionFiles({
        sessionsRoot,
        runningSessionIds: new Set(),
        acquireOwnership: id => ctx.sessionPersistence.open(SessionId(id), 'write'),
        archiveSession: id => ctx.workspaceRegistry.archiveSession(SessionId(id)),
      }, SESSION_A)

      expect(ctx.workspaceRegistry.archivedSessionIds).toContain(SESSION_A)
      expect(await ctx.sessionPersistence.stat(SessionId(SESSION_A))).toBeUndefined()
      const [workspace] = (await readdir(sessionsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory())
      const remaining = await readdir(path.join(sessionsRoot, workspace!.name, SESSION_A))
      expect(remaining).toEqual(process.platform === 'win32' ? [] : ['session.lock'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('respects another process’s V3 write lock and permits deletion after release', async () => {
    const root = await makeSessionsRoot()
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Context } from ${JSON.stringify(resolveModule('@deepseek-ai/cordis'))}
      import * as JsonlSessionPersistence from ${JSON.stringify(resolveModule('@deepseek-ai/dsh-session-persistence-jsonl'))}
      import { SESSION_FORMAT_VERSION, SessionId } from ${JSON.stringify(resolveModule('@deepseek-ai/dsh-session'))}
      const ctx = new Context()
      await ctx.plugin(JsonlSessionPersistence, { root: process.argv[1], compression: 'none' })
      const handle = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION, id: SessionId(${JSON.stringify(SESSION_A)}),
        createdAt: 1000, cwd: process.argv[1], isSeeded: false,
      })
      await handle.flush()
      process.send('ready')
      process.once('message', async () => {
        await handle.close()
        await ctx.fiber.dispose()
        process.disconnect()
      })
    `, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let diagnostic = ''
    holder.stderr?.on('data', (data: Buffer) => { diagnostic += data.toString() })
    const ctx = new Context()
    try {
      const ready = await Promise.race([
        once(holder, 'message').then(([message]) => message),
        once(holder, 'exit').then(([code]) => { throw new Error(`lock holder exited ${String(code)}: ${diagnostic}`) }),
      ])
      expect(ready).toBe('ready')
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const deps = {
        archiveSession,
        sessionsRoot: root,
        runningSessionIds: new Set<string>(),
        acquireOwnership: (id: string) => ctx.sessionPersistence.open(SessionId(id), 'write'),
      }
      await expect(purgeSessionFiles(deps, SESSION_A)).rejects.toMatchObject({ code: 'running' })
      expect(await ctx.sessionPersistence.stat(SessionId(SESSION_A))).toBeDefined()

      const exited = once(holder, 'exit')
      holder.send('release')
      await exited
      await purgeSessionFiles({
        ...deps,
        acquireOwnership: async (id) => {
          const handle = await ctx.sessionPersistence.open(SessionId(id), 'write')
          return {
            close: async () => {
              try {
                // Data is already absent, but the original kernel lock must
                // still block a recreated session until this handle closes.
                expect(await ctx.sessionPersistence.stat(SessionId(id))).toBeUndefined()
                expect(await contendForSession(root)).toBe('SessionAlreadyOwnedError')
              } finally {
                await handle.close()
              }
            },
          }
        },
      }, SESSION_A)
      expect(await ctx.sessionPersistence.stat(SessionId(SESSION_A))).toBeUndefined()
    } finally {
      if (holder.exitCode === null) {
        const exited = once(holder, 'exit')
        holder.kill()
        await exited
      }
      await ctx.fiber.dispose()
    }
  }, 15_000)
})

describe('createSessionPurger', () => {
  function purgerHarness(running: string[], services: Record<string, unknown> = {}) {
    const methods: string[] = []
    const api = {
      call: vi.fn(async (call: { method: string }) => {
        methods.push(call.method)
        if (call.method === 'session.list') return { ok: true as const, value: { items: running.map((sessionId) => ({ sessionId, running: true })) } }
        if (call.method === 'workspace.list') return { ok: true as const, value: { archivedSessionIds: [] } }
        return { ok: true as const, value: {} }
      }),
    }
    const ctx = {
      get: (name: string) => name === 'sessionPersistence' ? { open: async () => ({ close: async () => {} }) } : services[name],
    } as unknown as Context
    return { api, ctx, methods }
  }

  it('archives, removes the data and then drops the session state', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)
    const { api, ctx, methods } = purgerHarness([])
    const onPurged = vi.fn(async () => {})
    await createSessionPurger(ctx, api as never, root, onPurged)(SESSION_A)
    expect(await readdir(target)).toEqual([])
    expect(methods).toEqual(['session.list', 'workspace.list', 'workspace.archiveSession'])
    expect(onPurged).toHaveBeenCalledWith(SESSION_A)
  })

  describe('archive cleanup across DSH host shapes', () => {
    it('waits for the worktree cleanup on a host that reports it (0.2.2-rc.2 and later)', async () => {
      const root = await makeSessionsRoot()
      const target = await makeSession(root, 'ws', SESSION_A)
      const session = { id: SESSION_A }
      const inspectSession = vi.fn(async (_id: string, read: (value: unknown) => unknown) => read(session))
      const cleanupOf = vi.fn(async (_session: unknown, revision: unknown) => revision === null
        ? { status: 'scheduled', revision: 7 } : { status: 'removed', revision: 7 })
      const { api, ctx } = purgerHarness([], { worktrees: { cleanupOf }, sessionQuery: { inspectSession } })
      await createSessionPurger(ctx, api as never, root)(SESSION_A)
      expect(inspectSession).toHaveBeenCalledWith(SESSION_A, expect.any(Function))
      expect(cleanupOf.mock.calls).toEqual([[session, null], [session, 7]])
      expect(await readdir(target)).toEqual([])
    })

    it('keeps the data and restores the archive state when that cleanup failed', async () => {
      const root = await makeSessionsRoot()
      const target = await makeSession(root, 'ws', SESSION_A)
      const { api, ctx, methods } = purgerHarness([], {
        worktrees: { cleanupOf: async () => ({ status: 'failed' }) },
        sessionQuery: { inspectSession: async (_id: string, read: (value: unknown) => unknown) => read({}) },
      })
      await expect(createSessionPurger(ctx, api as never, root)(SESSION_A)).rejects.toThrow(/worktree cleanup failed/)
      expect(await readdir(target)).not.toEqual([])
      expect(methods).toContain('workspace.unarchiveSession')
    })

    it('purges without the wait on a host whose services predate it (0.2.2-rc.1)', async () => {
      const root = await makeSessionsRoot()
      const target = await makeSession(root, 'ws', SESSION_A)
      // The rc.1 shapes: a worktree service without cleanupOf, a session query without inspectSession.
      const { api, ctx, methods } = purgerHarness([], { worktrees: { list: async () => [] }, sessionQuery: { listSessions: async () => [] } })
      const onPurged = vi.fn(async () => {})
      await createSessionPurger(ctx, api as never, root, onPurged)(SESSION_A)
      expect(await readdir(target)).toEqual([])
      expect(methods).toEqual(['session.list', 'workspace.list', 'workspace.archiveSession'])
      expect(onPurged).toHaveBeenCalledWith(SESSION_A)
    })

    it('refuses when the host reports cleanups but cannot inspect the session', async () => {
      const root = await makeSessionsRoot()
      await makeSession(root, 'ws', SESSION_A)
      const { api, ctx } = purgerHarness([], { worktrees: { cleanupOf: async () => null }, sessionQuery: {} })
      await expect(createSessionPurger(ctx, api as never, root)(SESSION_A)).rejects.toThrow(/session query is required/)
    })
  })

  it('keeps the session state when the purge is refused', async () => {
    const root = await makeSessionsRoot()
    const target = await makeSession(root, 'ws', SESSION_A)
    const { api, ctx } = purgerHarness([SESSION_A])
    const onPurged = vi.fn(async () => {})
    await expect(createSessionPurger(ctx, api as never, root, onPurged)(SESSION_A)).rejects.toMatchObject({ code: 'running' })
    await expect(stat(target)).resolves.toBeTruthy()
    expect(onPurged).not.toHaveBeenCalled()
  })
})
