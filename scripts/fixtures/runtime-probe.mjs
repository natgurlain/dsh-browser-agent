// Loaded only by smoke-runtime.mjs into its isolated real DSH profile.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'runtime-smoke-probe'
export const inject = [
  'sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjectionCache', 'attachments', 'worktrees',
  'webServer', 'typertGateway', 'connection',
]

export async function apply(ctx, config) {
  // The browser bridge no longer lets its client name a session id or a
  // directory, so the smoke creates its placed fixture sessions the way a
  // Desktop client would: as the owner, through the Host gateway.
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/smoke/create-session',
    handler: (req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const { sessionId, cwd } = JSON.parse(body)
          const value = await ctx.typertGateway.invoke({
            namespace: 'session', method: 'create', args: { request: { sessionId, cwd } }, peer,
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        } catch (error) {
          res.writeHead(500)
          res.end(String(error))
        }
      })
    },
  }), 'runtime-smoke-probe: session placement route')
  // Stand-in for another owner client (the DSH web UI or CLI) answering
  // approvals: browser approvals forwarded by the bridge reach dsh's real
  // approval service, which asks every answerer. Only browser tools are
  // answered here; the decision is read from the question so the smoke can
  // exercise both outcomes.
  if (config.approvalLog !== undefined) {
    ctx.on('approval/request', (request, next) => {
      if (!request.toolName.startsWith('browser_')) return next()
      writeFileSync(config.approvalLog, JSON.stringify({
        toolName: request.toolName,
        sessionId: String(request.agent.session.id),
        reason: request.reason ?? '',
      }) + '\n', { flag: 'a' })
      return Promise.resolve((request.reason ?? '').includes('SMOKE-ALLOW') ? 'allowed-once' : 'rejected')
    })
  }
  ctx.on('worktree/cleanup', info => {
    if (info.cleanup.status !== 'scheduled') {
      writeFileSync(`${config.marker}.cleanup-${info.sessionId}`, JSON.stringify(info))
    }
  })
  // DSH 0.1.7 resolves profile packages through process-local module hooks.
  // Inspect providers inside the host where those hooks are installed.
  const resolve = createRequire(config.profileManifest)
  for (const [name, service] of [
    ['dsh-session-query', 'sessionQuery'],
    ['dsh-session-projection-cache', 'sessionProjectionCache'],
  ]) {
    const packageName = `@deepseek-ai/${name}`
    const path = resolve.resolve(`${packageName}/package.json`)
    const { version } = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(version, config.expectedVersion, `Profile resolved an incompatible ${name} at ${path}`)
    const { default: Provider } = await import(pathToFileURL(resolve.resolve(packageName)).href)
    assert.ok(ctx.get(service) instanceof Provider, `${service} must use the profile's resolved provider`)
  }
  if (config.reopen) {
    assert.equal(ctx.sessions.get(config.sessionId), undefined, 'session must be cold after restart')
    // A prepared observation calls the real cache.hydratePrepared, the exact
    // failing boundary in #71. No mocked query, cache, or persistence services.
    const observation = await ctx.sessionQuery.observeSession(config.sessionId)
    try {
      assert.equal(observation.source, 'prepared')
      assert.ok(observation.projections)
      await writeFile(config.marker, JSON.stringify({ source: observation.source }))
    } finally {
      observation[Symbol.dispose]()
    }
    return
  }
  ctx.on('agent/created', async ({ agent }) => {
    const session = agent.session
    const worktreeSession = config.worktreeSessions.find(entry => entry.sessionId === session.id)
    if (worktreeSession !== undefined) {
      const worktree = await ctx.worktrees.create(agent)
      if (worktreeSession.dirty) await writeFile(`${worktree.path}/user-note.txt`, 'Keep this file.\n')
      await ctx.sessionPersistence.flush()
      await writeFile(`${config.marker}.${session.id}`, JSON.stringify(worktree))
      return
    }
    if (session.id !== config.sessionId) return
    // A durable Session choice must survive catalog refreshes and cold reads,
    // independently of the deployment default. No model request is needed.
    session.append('model/selection', { provider: 'smoke-provider', model: 'smoke-model' })
    // Persist a blank session without an LLM call so restart exercises reads
    // from disk even though normal empty sessions may be deferred.
    // AgentLoop owns writes through its SessionHandle; the service flush
    // barrier drains those handles and materializes even an empty session.
    await ctx.sessionPersistence.flush()
    const attachment = await ctx.attachments.saveImage({
      data: await readFile(config.imagePath), mediaType: 'image/png', name: 'browser-icon.png',
    })
    await writeFile(config.marker, JSON.stringify({ sessionId: session.id, attachment }))
  })
}
