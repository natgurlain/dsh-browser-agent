// @vitest-environment jsdom
/**
 * browser_extract masks sensitive fields exactly as the snapshot does
 * (review PoC extract-pw).
 */
import { expect, it } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'

const ctx = () => ({ ids: new ElementIds(), budget: { maxItems: 60, maxForms: 30, maxChars: 12_000 } })

it('never returns the value of a password or card field', async () => {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  document.body.innerHTML = '<form id="f"><input name="user" value="alice"><input type="password" name="password" value="hunter2-secret"><input name="card-number" value="4111111111111111"></form>'
  const snapshot = JSON.stringify(await runAction('browser_snapshot', {}, ctx()))
  expect(snapshot).not.toContain('hunter2-secret')
  const result = await runAction('browser_extract', {
    schema: { rows: '#f', fields: { user: '[name=user]', pw: 'input[type=password]', pwAttr: { selector: 'input[type=password]', attr: 'value' }, card: '[name=card-number]' } },
  }, ctx())
  const text = JSON.stringify(result)
  expect(text).not.toContain('hunter2-secret')
  expect(text).not.toContain('4111111111111111')
  expect((result as { data: { rows: Record<string, unknown>[] } }).data.rows[0]).toMatchObject({ user: 'alice', pw: '••••', pwAttr: '••••', card: '••••' })
})

it('keeps a field masked after the page flips its type (latched sensitivity)', async () => {
  // A neutral id and name: only the latch (not the field's name) can keep it masked.
  document.body.innerHTML = '<form id="g"><input id="f1" name="f1" type="password" value="s3cret-value"></form>'
  await runAction('browser_snapshot', {}, ctx())
  ;(document.getElementById('f1') as HTMLInputElement).type = 'text'
  const result = await runAction('browser_extract', { schema: { rows: '#g', fields: { v: '#f1' } } }, ctx())
  expect(JSON.stringify(result)).not.toContain('s3cret-value')
})
