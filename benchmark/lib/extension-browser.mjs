import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, findChromiumExecutable } from './chromium.mjs'

/**
 * @param {object} options
 * @param {string} options.trustedOrigin - origin of the page the benchmark tab starts on; always-allowed for actions.
 * @param {Record<string, unknown>} [options.settings] - extra extension settings applied with the first save.
 * @param {string[]} [options.hostResolverRules] - Chromium `--host-resolver-rules` entries, e.g.
 *   `MAP attacker.test 127.0.0.1`: lets a loopback server be reached under a host name that is not loopback.
 */
export async function startExtensionBrowser({ repoRoot, benchmarkRoot, bridgeUrl, trustedOrigin, connectTimeoutMs = 30_000, actionTimeoutMs = 8_000, profileRoot, settings = {}, hostResolverRules = [] }) {
  const extensionDir = resolve(repoRoot, 'extensions/dsh-browser/dist')
  const executablePath = await findChromiumExecutable(undefined, { requireExtensions: true })
  if (executablePath === undefined) throw new Error('no Chromium executable found; set PLAYWRIGHT_CHROMIUM_PATH')
  // Chromium aborts when the profile's socket path is too long; callers under a deep checkout pass a short profileRoot.
  const tempParent = profileRoot ?? resolve(benchmarkRoot, '.tmp')
  await mkdir(tempParent, { recursive: true })
  const profileDir = await mkdtemp(join(tempParent, 'extension-profile-'))
  let context
  let stage = 'launching Chromium'
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      channel: 'chromium',
      headless: true,
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--disable-background-networking',
        '--disable-component-update',
        ...hostResolverRules.length === 0 ? [] : [`--host-resolver-rules=${hostResolverRules.join(', ')}`],
      ],
    })
    // Playwright dismisses dialogs nobody listens for; leave them open so the
    // extension (browser_dialog) answers them as in a user's browser.
    context.on('page', (page) => { page.on('dialog', () => {}) })
    stage = 'waiting for extension service worker'
    let worker = context.serviceWorkers()[0]
    if (worker === undefined) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 })
    const extensionId = new URL(worker.url()).host
    stage = 'opening benchmark target tab'
    const target = await context.newPage()
    target.setDefaultTimeout(actionTimeoutMs)
    await target.goto(`${trustedOrigin}/health`, { waitUntil: 'domcontentloaded' })
    stage = 'opening extension panel'
    const panel = await context.newPage()
    panel.setDefaultTimeout(actionTimeoutMs)
    await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
    await panel.waitForSelector('header.topbar', { timeout: 15_000 })
    stage = 'configuring extension bridge'
    await panel.evaluate(async ({ configuredBridgeUrl, configuredOrigin, extraSettings, timeoutMs }) => {
      await new Promise((resolveConnection, rejectConnection) => {
        const port = chrome.runtime.connect({ name: 'dsh-panel' })
        window.__dshBenchmarkPort = port
        // Request acknowledgements (settings, tab binding), and the approval cards this port answered
        // as the benchmark's stand-in user (see setApprovalPolicy).
        window.__dshBenchmarkResults = []
        window.__dshBenchmarkApprovals = []
        window.__dshBenchmarkApprovalPolicy = undefined
        port.onMessage.addListener((message) => {
          if (typeof message?.type === 'string' && message.type.endsWith('.result')) window.__dshBenchmarkResults.push(message)
          if (message?.type === 'auto-review.state') window.__dshAutoReviewState = message
          if (message?.type !== 'approval.request' || window.__dshBenchmarkApprovalPolicy === undefined) return
          const request = message.request
          const decision = request.forced === true ? window.__dshBenchmarkApprovalPolicy.forced : window.__dshBenchmarkApprovalPolicy.other
          window.__dshBenchmarkApprovals.push({ ...request, decision, at: Date.now() })
          port.postMessage({ type: 'approval.response', id: request.id, decision })
        })
        const timer = setTimeout(() => {
          port.disconnect()
          rejectConnection(new Error(`extension bridge did not connect within ${timeoutMs}ms`))
        }, timeoutMs)
        port.onDisconnect.addListener(() => {
          clearTimeout(timer)
          rejectConnection(new Error(chrome.runtime.lastError?.message ?? 'extension benchmark port disconnected'))
        })
        port.onMessage.addListener((message) => {
          if (message?.type !== 'status' || message.state !== 'connected') return
          clearTimeout(timer)
          resolveConnection()
        })
        port.postMessage({
          type: 'settings',
          settings: {
            bridgeUrl: configuredBridgeUrl,
            token: 'dsh-browser-benchmark-local-token',
            sharePageContent: 'auto',
            trustedActionOrigins: [configuredOrigin],
            approvalNotifications: false,
            autoResumeSession: false,
            ...extraSettings,
          },
        })
      })
    }, { configuredBridgeUrl: bridgeUrl, configuredOrigin: trustedOrigin, extraSettings: settings, timeoutMs: connectTimeoutMs })
    stage = 'waiting for extension bridge connection'
    try {
      await panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: connectTimeoutMs })
    } catch (error) {
      const status = await panel.locator('.connection').textContent().catch(() => '(status unavailable)')
      const discovery = await panel.evaluate(async (configuredBridge) => {
        try {
          const target = new URL(configuredBridge)
          target.protocol = 'http:'
          target.pathname = '/ext/bridge-config'
          return { status: (await fetch(target)).status }
        } catch (cause) {
          return { error: String(cause) }
        }
      }, bridgeUrl).catch((cause) => ({ error: String(cause) }))
      throw new Error(`extension did not connect to benchmark DSH; UI=${JSON.stringify(status)} discovery=${JSON.stringify(discovery)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await target.bringToFront()
    /** Post one panel message with a fresh id and wait for its `<type>.result`. */
    const request = (message, resultType) => panel.evaluate(async ({ value, type, timeoutMs }) => {
      const id = crypto.randomUUID()
      window.__dshBenchmarkPort.postMessage({ ...value, id })
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const answer = window.__dshBenchmarkResults.find((candidate) => candidate.type === type && candidate.id === id)
        if (answer !== undefined) return answer
        await new Promise((resolveWait) => setTimeout(resolveWait, 25))
      }
      return { ok: false, error: `no ${type} within ${timeoutMs}ms` }
    }, { value: message, type: resultType, timeoutMs: actionTimeoutMs })
    return {
      context,
      worker,
      panel,
      target,
      executablePath,
      /** Merge settings into the extension's and wait until the worker applied them. */
      async configure(settings) {
        const result = await request({ type: 'settings', settings }, 'settings.result')
        if (result.ok !== true) throw new Error(`extension rejected benchmark settings ${JSON.stringify(settings)}: ${JSON.stringify(result)}`)
      },
      /**
       * Bind an agent session to the benchmark tab, as a user does by choosing
       * the current page in the side panel. A session created through the DSH
       * API (not from the panel) has no tab of its own, and every browser tool
       * call of an unbound session fails with "The controlled tab was closed".
       */
      async bindSession(sessionId) {
        await target.bringToFront()
        const result = await request({ type: 'tab-affinity.rebind', sessionId }, 'tab-affinity.rebind.result')
        if (result.ok !== true) throw new Error(`extension did not bind session ${sessionId} to the benchmark tab: ${JSON.stringify(result)}`)
      },
      /**
       * Answer approval cards as a scripted user: `forced` decides the cards
       * no setting can waive (session taint), `other` every ordinary card.
       * `undefined` leaves cards unanswered (the default: a benchmark run
       * expects none).
       */
      async setApprovalPolicy(policy) {
        await panel.evaluate((value) => {
          window.__dshBenchmarkApprovalPolicy = value
          window.__dshBenchmarkApprovals = []
        }, policy)
      },
      /**
       * Turn Auto review on or off for one conversation, as the panel's
       * control does, and wait until the extension reports it.
       */
      async setAutoReview(sessionId, enabled) {
        await panel.evaluate(async ({ id, on, timeoutMs }) => {
          // This panel shows the conversation: Auto approves only in a conversation a panel shows.
          window.__dshBenchmarkPort.postMessage({ type: 'session.active', sessionId: id })
          window.__dshBenchmarkPort.postMessage({ type: 'auto-review.set', sessionId: id, enabled: on })
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const state = window.__dshAutoReviewState
            if (state?.offered === true && (state.sessions?.[id]?.on === true) === on) return
            await new Promise((resolveWait) => setTimeout(resolveWait, 25))
          }
          throw new Error(`Auto review did not turn ${on ? 'on' : 'off'} for ${id}: ${JSON.stringify(window.__dshAutoReviewState)}`)
        }, { id: sessionId, on: enabled, timeoutMs: actionTimeoutMs })
      },
      /**
       * A session RPC sent from the panel, as the user's own panel sends it:
       * prompts sent this way are the only ones Auto review trusts.
       */
      async panelRpc(method, payload) {
        const answer = await request({ type: 'rpc', method, payload }, 'rpc.result')
        const result = answer?.result?.result
        if (answer?.ok !== true || result?.ok !== true) throw new Error(`panel ${method} failed: ${JSON.stringify(answer)}`)
        return result.value
      },
      /** The approval cards answered since the last setApprovalPolicy call. */
      approvals() {
        return panel.evaluate(() => window.__dshBenchmarkApprovals)
      },
      /**
       * The extension's taint records by session id: `sources` are the origins
       * the taint banner says a conversation read, `attempted` the destinations
       * of navigations that did not succeed.
       */
      async taintRecords() {
        const stored = await worker.evaluate(async () => (await chrome.storage.session.get('dshSessionTaint')).dshSessionTaint)
        return typeof stored === 'object' && stored !== null ? stored : {}
      },
      /** Close tabs a run opened (browser_open_tab), leaving the benchmark tab and the panel. */
      async closeOtherTabs() {
        for (const page of context.pages()) {
          if (page !== target && page !== panel) await page.close().catch(() => undefined)
        }
      },
      async prepare(url) {
        await target.goto(url, { waitUntil: 'domcontentloaded' })
        await target.bringToFront()
        await target.waitForTimeout(200)
      },
      async close() {
        await context.close()
        await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      },
    }
  } catch (error) {
    if (context !== undefined) await context.close().catch(() => undefined)
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    const browserHint = stage === 'waiting for extension service worker'
      ? ' Install Chrome for Testing with `pnpm --dir benchmark install-browser`; current Google Chrome Stable builds ignore --load-extension.'
      : ''
    throw new Error(`extension browser failed while ${stage}: ${error instanceof Error ? error.message : String(error)}.${browserHint}`, { cause: error })
  }
}
