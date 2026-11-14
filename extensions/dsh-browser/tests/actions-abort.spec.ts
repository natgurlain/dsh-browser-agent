// @vitest-environment jsdom
/**
 * The kill switch reaches the page: in-flight waits and scroll loops stop
 * at once instead of running to their own timeouts (#8).
 */
import { expect, it } from 'vitest'
import { abortRunningActions, runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const ctx = () => ({ ids: new ElementIds(), budget: { maxItems: 60, maxForms: 30, maxChars: 12_000 } })

it('stops a conditional wait and a fixed wait when the kill switch fires', async () => {
  document.body.innerHTML = '<p>nothing here</p>'
  const started = performance.now()
  const waiting = runAction('browser_wait', { text: 'never appears', timeoutMs: 20_000 }, ctx())
  const sleeping = runAction('browser_wait', { ms: 20_000 }, ctx())
  await new Promise((resolve) => { setTimeout(resolve, 50) })
  abortRunningActions()
  await expect(waiting).rejects.toThrow(/stopped/)
  await expect(sleeping).rejects.toThrow(/stopped/)
  expect(performance.now() - started).toBeLessThan(3_000)
  // Actions that start afterwards run normally.
  await expect(runAction('browser_wait', { text: 'nothing here', timeoutMs: 1_000 }, ctx())).resolves.toBeDefined()
}, 10_000)
