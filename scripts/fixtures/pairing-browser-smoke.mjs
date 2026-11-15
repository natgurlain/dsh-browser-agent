/**
 * Browser smoke for one-step pairing (roadmap 3.10), run by smoke-browser.mjs
 * against a real DSH host and a real Chromium.
 *
 * A second browser profile loads a store-style copy of the built extension:
 * no manifest `key` (so Chromium gives it an ID the bridge has never heard
 * of) and no installer-written `bridge-token` file. Its side panel asks the
 * host to pair and shows a code; the host shows the same code, and once the
 * request is approved there the panel connects. Nothing is injected into the
 * extension: the token arrives only through the exchange.
 */

import assert from 'node:assert/strict'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * @param {object} ctx
 * @param {object} ctx.chromium - playwright's chromium launcher.
 * @param {string} ctx.builtExtension - the built `dist/` directory.
 * @param {string} ctx.directory - this run's artifact directory.
 * @param {string} ctx.runtimeTmp - TMPDIR for the browser.
 * @param {string} ctx.wsUrl - the host's own bridge URL (not the smoke's proxy).
 * @param {string} ctx.appUrl - the DSH web app, with its launch token (what `dsh web` prints and opens).
 * @param {string} ctx.home - DSH_HOME of the smoke host.
 * @param {string} ctx.token - the bridge token the host was configured with.
 * @param {string} ctx.pinnedId - the manifest-keyed extension ID.
 * @param {(body: object) => Promise<{ status: number, body: any }>} ctx.ownerPairing - the control route, called as the authenticated owner.
 * @param {Function} ctx.waitFor - polling helper.
 * @param {string[]} ctx.results - verified behaviours.
 * @returns {Promise<string[]>} screenshots taken.
 */
export async function runPairingSmoke({ chromium, builtExtension, directory, runtimeTmp, wsUrl, appUrl, home, token, pinnedId, ownerPairing, waitFor, results }) {
  const store = join(directory, 'store-extension')
  await cp(builtExtension, store, { recursive: true })
  await rm(join(store, 'bridge-token'), { force: true })
  const manifest = JSON.parse(await readFile(join(store, 'manifest.json'), 'utf8'))
  delete manifest.key
  await writeFile(join(store, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const context = await chromium.launchPersistentContext(join(directory, 'chromium-store'), {
    executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
    channel: 'chromium', headless: true,
    env: { ...process.env, TMPDIR: runtimeTmp },
    viewport: { width: 420, height: 860 },
    args: [`--disable-extensions-except=${store}`, `--load-extension=${store}`],
  })
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    const extensionId = new URL(worker.url()).host
    assert.notEqual(extensionId, pinnedId, 'a build without the manifest key gets its own extension ID')
    // Point this profile at the smoke host before its panel opens (a developer
    // machine may run other DSH instances, and the panel asks the bridge it finds).
    const setup = await context.newPage()
    await setup.goto(`chrome-extension://${extensionId}/offscreen/index.html`)
    await setup.evaluate(async (bridgeUrl) => {
      const port = chrome.runtime.connect({ name: 'dsh-panel' })
      await new Promise((resolve, reject) => {
        const id = crypto.randomUUID()
        port.onMessage.addListener((message) => {
          if (message.type !== 'settings.result' || message.id !== id) return
          if (message.ok) resolve()
          else reject(new Error(JSON.stringify(message)))
        })
        port.postMessage({ type: 'settings', id, settings: { bridgeUrl, token: '' } })
      })
      port.disconnect()
    }, wsUrl)
    await setup.close()

    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
    const label = () => panel.locator('.connection-label').textContent()
    const card = panel.locator('[data-testid="pairing-card"]')
    const status = card.locator('[role="status"]')

    // The host answers, but this install has no token: the panel says so and
    // asks the host by itself. The user's only step here is to read the code.
    await waitFor(async () => await label() === 'Not paired with DSH yet', 'the unpaired status of the store build')
    const shown = card.locator('[data-testid="pairing-code"]')
    await shown.waitFor({ timeout: 30_000 })
    const code = (await shown.textContent()).trim()
    assert.match(code, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/u)
    assert.match(await card.textContent(), /Approve in DeepSeek Harness/u)
    await panel.screenshot({ path: join(directory, 'screenshots', 'pairing-store-build-code.png') }).catch(() => {})

    // The host shows the same code for this very extension, and has released nothing.
    const listed = await waitFor(async () => {
      const answer = await ownerPairing({ action: 'list' })
      return answer.body?.requests?.length === 1 ? answer.body.requests : undefined
    }, 'the pairing request on the host')
    assert.equal(listed[0].code, code, 'the host must show the code the panel shows')
    assert.equal(listed[0].origin, `chrome-extension://${extensionId}`)
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('dshSettings')).dshSettings?.token ?? ''), '')
    assert.equal(await label(), 'Not paired with DSH yet')

    // Denied on the host: the panel explains, stores nothing, and asks again only on a click.
    assert.equal((await ownerPairing({ action: 'deny', id: listed[0].id })).status, 200)
    await waitFor(async () => (await status.textContent().catch(() => ''))?.startsWith('The request was denied'), 'the denial in the panel')
    await card.getByRole('button', { name: 'Ask again', exact: true }).click()
    await shown.waitFor({ timeout: 30_000 })
    const secondCode = (await shown.textContent()).trim()
    const again = await waitFor(async () => {
      const answer = await ownerPairing({ action: 'list' })
      return answer.body?.requests?.length === 1 ? answer.body.requests : undefined
    }, 'the second pairing request on the host')
    assert.equal(again[0].code, secondCode)

    // The user's one click: DSH's own web app shows the prompt over the page
    // ("<browser> wants to connect", the same code), and Approve is pressed there.
    const app = await context.newPage()
    await app.setViewportSize({ width: 1280, height: 860 })
    await app.goto(appUrl)
    const prompt = app.locator('[data-testid="dsh-pairing-prompt"]')
    await prompt.waitFor({ timeout: 45_000 })
    assert.equal((await prompt.locator('[data-testid="dsh-pairing-code"]').textContent()).trim(), secondCode,
      'the DSH app must show the code the panel shows')
    assert.match(await prompt.textContent(), /wants to connect/u)
    await app.screenshot({ path: join(directory, 'screenshots', 'pairing-dsh-app-prompt.png') }).catch(() => {})
    // A fresh DSH profile opens with a one-time preview notice whose backdrop covers the page.
    await app.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 5_000 }).catch(() => {})
    await prompt.getByRole('button', { name: 'Approve', exact: true }).click()
    await waitFor(async () => await label() === 'Connected', 'the paired store build to connect', 30_000)
    assert.equal(await card.count(), 0, 'the pairing card leaves once the panel is connected')
    const shot = join(directory, 'screenshots', 'pairing-store-build-connected.png')
    await panel.screenshot({ path: shot }).catch(() => {})

    // The host saw exactly this extension pair, and remembers its ID.
    const after = (await ownerPairing({ action: 'list' })).body
    assert.deepEqual(after.requests, [])
    assert.equal(after.paired.origin, `chrome-extension://${extensionId}`)
    const record = await waitFor(async () => {
      try { return JSON.parse(await readFile(join(home, 'browser-paired-extensions.json'), 'utf8')) } catch { return undefined }
    }, 'the paired-extension record')
    assert.deepEqual(record.chromeExtensionIds, [extensionId])
    // The token reached the extension's settings through the exchange, not through a file.
    const stored = await worker.evaluate(async () => (await chrome.storage.local.get('dshSettings')).dshSettings?.token ?? '')
    assert.equal(stored, token)
    results.push('a store-style build (no manifest key, no token file) asks to pair by itself and shows the code the host shows; a denial stores nothing, and one click on Approve in the DSH web app\'s own prompt connects it, with nothing typed or copied')
    return [shot]
  } finally {
    await context.close().catch(() => {})
  }
}
