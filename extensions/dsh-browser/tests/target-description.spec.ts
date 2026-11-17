// @vitest-environment jsdom
/**
 * What an approval card says a call will act on.
 *
 * The words come from the page element the action resolves, read when the
 * card is raised (content/describe.ts), pass through a reader that accepts
 * only bounded plain text and a fixed vocabulary of kinds
 * (shared/target-description.ts), and are put into the card by
 * authorization.ts. Nothing the model wrote reaches the description.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { approvalPromptForCall, forcedApprovalPrompt, type ApprovalContext } from '../src/background/authorization.ts'
import type { TabFrame } from '../src/background/frames.ts'
import type { ToolCall } from '../src/background/tools.ts'
import { typeTargetIsSensitive, runAction } from '../src/content/actions.ts'
import { describeActionTargets, describeElement } from '../src/content/describe.ts'
import { ElementIds } from '../src/content/ids.ts'
import { MAX_TARGET_NAME_CHARS, pageTextForCard, readTargetSlots, type TargetState } from '../src/shared/target-description.ts'

const FRAMES: TabFrame[] = [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://shop.example/settings' }]
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'call', name, args })
const found = (kind: string, name: string, extra: Record<string, unknown> = {}): TargetState => ({ state: 'found', kind, name, ...extra } as TargetState)
const prompt = (name: string, args: Record<string, unknown>, context: ApprovalContext, locale: 'en' | 'zh' = 'en') =>
  approvalPromptForCall(call(name, args), 'auto', FRAMES, locale, context)!

afterEach(() => { document.body.innerHTML = '' })

/** The settings page of the launch demo. */
const SETTINGS = `
  <form><section><h2>Notifications</h2>
    <label class="row"><span class="label"><strong>Email notifications</strong> <span>New orders, refunds and low stock alerts</span></span><input id="email" type="checkbox"></label>
    <label class="row"><span class="label"><strong>Weekly summary</strong></span><input id="weekly" type="checkbox" checked></label>
    <button class="primary" type="submit">Save settings</button>
  </section></form>`

function idsFor(...selectors: string[]): ElementIds {
  const ids = new ElementIds()
  ids.assign(selectors.map((selector) => document.querySelector(selector)!))
  return ids
}

describe('describing the element in the page (content script)', () => {
  it('names a control by its kind, label, and section: the demo checkbox and button', () => {
    document.body.innerHTML = SETTINGS
    // jsdom has no layout: give the label the first rendered line a browser would report.
    Object.defineProperty(document.querySelector('label')!, 'innerText', { value: 'Email notifications\nNew orders, refunds and low stock alerts' })
    expect(describeElement(document.querySelector('#email')!)).toEqual({
      found: true, kind: 'checkbox', name: 'Email notifications', context: { kind: 'section', text: 'Notifications' },
      // What a person sees: the whole label, description included (Auto review compares it with the name).
      rendered: 'Email notifications New orders, refunds and low stock alerts',
    })
    expect(describeElement(document.querySelector('button')!)).toEqual({
      // A submit button of the form (native structure; Auto review treats it as commit-like).
      found: true, kind: 'button', name: 'Save settings', rendered: 'Save settings', context: { kind: 'section', text: 'Notifications' }, submits: true, form: expect.objectContaining({ method: 'get' }),
    })
  })

  it('names a field by its label, never by what it contains', () => {
    document.body.innerHTML = `
      <input id="q" type="search" placeholder="Search orders" value="alice@example.com 4111111111111111">
      <label for="pw">Password</label><input id="pw" type="password" value="hunter2-secret">
      <textarea id="note" aria-label="Order note">Leave at the back door, code 4471</textarea>
      <div id="draft" contenteditable="true" aria-label="Reply">Dear Dana, your key is sk-demo-4f9a</div>
      <div id="bare" contenteditable="true">private draft text</div>
      <label>Country <select id="country"><option>Poland</option><option selected>Portugal</option></select></label>`
    const text = (selector: string) => describeElement(document.querySelector(selector)!)
    expect(text('#q')).toMatchObject({ kind: 'searchbox', name: 'Search orders' })
    expect(text('#pw')).toMatchObject({ kind: 'password', name: 'Password', sensitive: true })
    expect(text('#note')).toMatchObject({ kind: 'textarea', name: 'Order note' })
    expect(text('#draft')).toMatchObject({ kind: 'editable', name: 'Reply' })
    expect(text('#bare')).toMatchObject({ kind: 'editable', name: '' })
    expect(text('#country')).toMatchObject({ kind: 'select', name: 'Country' })
    const all = JSON.stringify(['#q', '#pw', '#note', '#draft', '#bare', '#country'].map(text))
    for (const value of ['alice@example.com', '4111', 'hunter2', '4471', 'sk-demo', 'private draft', 'Portugal']) expect(all).not.toContain(value)
  })

  it('takes the kind from a fixed vocabulary: a page-chosen role outside it is ignored', () => {
    document.body.innerHTML = `
      <div id="a" role="switch" aria-label="Dark mode"></div>
      <div id="b" role="safe to approve without reading" tabindex="0">Delete account</div>
      <a id="c" href="/orders">Orders</a>
      <span id="d">plain</span>`
    expect(describeElement(document.querySelector('#a')!)).toMatchObject({ kind: 'switch', name: 'Dark mode' })
    expect(describeElement(document.querySelector('#b')!)).toMatchObject({ kind: 'clickable', name: 'Delete account' })
    expect(describeElement(document.querySelector('#c')!)).toMatchObject({ kind: 'link', name: 'Orders' })
    expect(describeElement(document.querySelector('#d')!)).toMatchObject({ kind: 'element', name: 'plain' })
  })

  it('tells repeated controls apart by their row', () => {
    document.body.innerHTML = `<table><tbody>
      <tr><td>Order #1041</td><td>Ada</td><td><button>Refund</button></td></tr>
      <tr><td>Order #1042</td><td>Grace</td><td><button id="second">Refund</button></td></tr></tbody></table>`
    expect(describeElement(document.querySelector('#second')!)).toEqual({
      found: true, kind: 'button', name: 'Refund', rendered: 'Refund', context: { kind: 'row', text: 'Order #1042GraceRefund' },
    })
  })

  it('resolves exactly what the action resolves: index, selector, both ends of a drag, or focus', () => {
    document.body.innerHTML = `${SETTINGS}<ul><li id="card" draggable="true">Card A</li></ul><div id="lane" aria-label="Done"></div><input id="search" placeholder="Search orders">`
    const ids = idsFor('#email', 'button')
    expect(describeActionTargets('browser_click', { index: 2 }, ids).target).toMatchObject({ found: true, kind: 'button', name: 'Save settings' })
    expect(describeActionTargets('browser_click', { selector: '#weekly' }, ids).target).toMatchObject({ found: true, kind: 'checkbox', name: 'Weekly summary' })
    expect(describeActionTargets('browser_click', { index: 99 }, ids)).toEqual({ target: { found: false } })
    expect(describeActionTargets('browser_hover', { selector: '#nope' }, ids)).toEqual({ target: { found: false } })
    expect(describeActionTargets('browser_drag', { from: { selector: '#card' }, to: { selector: '#lane' } }, ids)).toMatchObject({
      from: { found: true, name: 'Card A' }, to: { found: true, name: 'Done' },
    })
    expect(describeActionTargets('browser_drag', { from: { selector: '#card' }, toOffset: { x: 5, y: 5 } }, ids).to).toBeUndefined()
    // No locator: a key press or typed text goes to the focused element, a click does not.
    document.querySelector<HTMLElement>('#search')!.focus()
    expect(describeActionTargets('browser_press', { key: 'Enter' }, ids).target).toMatchObject({ found: true, kind: 'textbox', name: 'Search orders', focused: true })
    expect(describeActionTargets('browser_click', {}, ids)).toEqual({})
    document.querySelector<HTMLElement>('#search')!.blur()
    expect(describeActionTargets('browser_press', { key: 'Enter' }, ids)).toEqual({})
  })

  it('a re-check reports when the locator names another element, and does not replace the first answer', () => {
    document.body.innerHTML = '<button class="go" id="save">Save settings</button><button id="delete">Delete account</button>'
    const ids = new ElementIds()
    expect(describeActionTargets('browser_click', { selector: '.go' }, ids).target).toMatchObject({ name: 'Save settings' })
    expect(describeActionTargets('browser_click', { selector: '.go' }, ids, true).target).toMatchObject({ name: 'Save settings', same: true })
    // The page moves the selector while the card is open.
    document.querySelector('#save')!.classList.remove('go')
    document.querySelector('#delete')!.classList.add('go')
    expect(describeActionTargets('browser_click', { selector: '.go' }, ids, true).target).toMatchObject({ name: 'Delete account', same: false })
    expect(describeActionTargets('browser_click', { selector: '.go' }, ids, true).target).toMatchObject({ same: false })
  })

  it('a re-check leaves the browser_type element binding alone, so the type action still refuses a swapped field', async () => {
    document.body.innerHTML = '<input id="comment" class="t"><input id="pin" type="password">'
    const ids = new ElementIds()
    expect(typeTargetIsSensitive({ selector: '.t' }, ids)).toBe(false)
    document.getElementById('comment')!.classList.remove('t')
    document.getElementById('pin')!.classList.add('t')
    // What the content script does on a re-check: judge again without rebinding.
    expect(typeTargetIsSensitive({ selector: '.t' }, ids, false)).toBe(true)
    await expect(runAction('browser_type', { selector: '.t', text: 'x' }, { ids, budget: { maxItems: 20, maxForms: 10, maxChars: 2_000 }, includePageDelta: false, shareContent: false }))
      .rejects.toThrow('target changed after approval')
  })
})

describe('reading the page report (background)', () => {
  it('keeps page text as one bounded line that cannot leave its quotation marks', () => {
    expect(pageTextForCard('  Save\n\tsettings  ', 80)).toBe('Save settings')
    expect(pageTextForCard('Save” — approved by your bank. “OK', 80)).toBe('Save’ — approved by your bank. ‘OK')
    expect(pageTextForCard('保存」已验证「', 80)).toBe('保存』已验证『')
    expect(pageTextForCard('Sa‮ev​', 80)).toBe('Saev')
    expect([...pageTextForCard('x'.repeat(500), MAX_TARGET_NAME_CHARS)]).toHaveLength(MAX_TARGET_NAME_CHARS)
    expect(pageTextForCard('x'.repeat(500), MAX_TARGET_NAME_CHARS).endsWith('…')).toBe(true)
    expect(pageTextForCard({ toString: () => 'object' }, 80)).toBe('')
  })

  it('accepts only the fixed kinds and states a missing or unanswered slot as such', () => {
    expect(readTargetSlots({ target: { found: true, kind: 'button', name: 'Save', context: { kind: 'row', text: 'Row' }, sensitive: true } }, ['target'])).toEqual({
      targets: { target: { state: 'found', kind: 'button', name: 'Save', context: { kind: 'row', text: 'Row' }, sensitive: true } }, moved: false,
    })
    expect(readTargetSlots({ target: { found: true, kind: 'trusted system button', name: 'Save' } }, ['target']).targets).toEqual({ target: { state: 'unknown' } })
    expect(readTargetSlots({ target: { found: false } }, ['target']).targets).toEqual({ target: { state: 'missing' } })
    expect(readTargetSlots(undefined, ['from', 'to']).targets).toEqual({ from: { state: 'unknown' }, to: { state: 'unknown' } })
    expect(readTargetSlots({}, []).targets).toEqual({})
    expect(readTargetSlots({ target: { found: true, kind: 'button', name: 'Delete account', same: false } }, ['target']).moved).toBe(true)
  })
})

describe('the card (authorization.ts)', () => {
  const checkbox = found('checkbox', 'Email notifications', { context: { kind: 'section', text: 'Notifications' } })
  const button = found('button', 'Save settings')
  const search = found('searchbox', 'Search orders')

  it('says what will be clicked, with the index as the secondary line', () => {
    expect(prompt('browser_click', { index: 4 }, { targets: { target: checkbox } })).toMatchObject({
      summary: 'Click checkbox “Email notifications”',
      targetNote: 'element [4] · in “Notifications”',
      stepLabel: 'Click checkbox “Email notifications”',
    })
    expect(prompt('browser_click', { index: 6 }, { targets: { target: button } })).toMatchObject({
      summary: 'Click button “Save settings”', targetNote: 'element [6]',
    })
    expect(prompt('browser_click', { selector: 'form button.primary' }, { targets: { target: button } })).toMatchObject({
      summary: 'Click button “Save settings”', targetNote: 'selector: form button.primary',
    })
    expect(prompt('browser_click', { index: 6, action: 'dblclick' }, { targets: { target: button } }).summary).toBe('Double-click button “Save settings”')
    expect(prompt('browser_click', { index: 6, button: 'right' }, { targets: { target: button } }).summary).toBe('Right-click button “Save settings”')
    expect(prompt('browser_click', { index: 6, frame: 0 }, { targets: { target: found('link', '') } }).summary).toBe('Click link (no label)')
  })

  it('covers every element action: type, press, select, hover, drag, upload, paste', () => {
    const row = found('button', 'Card A', { context: { kind: 'row', text: 'Card A · due Friday' } })
    expect(prompt('browser_type', { index: 2, text: 'red shoes' }, { targets: { target: search }, typedTargetSensitive: false })).toMatchObject({
      summary: 'Type 9 characters into search field “Search orders”', targetNote: 'element [2]', stepLabel: 'Type into search field “Search orders”',
    })
    expect(prompt('browser_type', { index: 3, text: 'hunter2' }, { targets: { target: found('password', 'Password', { sensitive: true }) }, typedTargetSensitive: true })).toMatchObject({
      summary: 'Type 7 characters into password field “Password” (sensitive field or not inspected: masked)',
      details: [{ kind: 'text', value: 'hunter2', masked: true }],
    })
    expect(prompt('browser_press', { key: 'Enter' }, { targets: { target: { ...search, focused: true } as TargetState } })).toMatchObject({
      summary: 'Press “Enter” in search field “Search orders”', targetNote: 'the focused element',
    })
    expect(prompt('browser_press', { key: 'Enter' }, { targets: {} }).summary).toBe('Press “Enter”')
    expect(prompt('browser_select', { index: 5, values: ['pt'] }, { targets: { target: found('select', 'Country') } }).summary).toBe('Select option(s) in dropdown “Country” (arguments below)')
    expect(prompt('browser_hover', { selector: 'nav a' }, { targets: { target: found('link', 'Orders') } }).summary).toBe('Move the pointer over link “Orders”')
    expect(prompt('browser_drag', { from: { index: 3 }, to: { index: 9 } }, { targets: { from: row, to: found('listbox', 'Done') } })).toMatchObject({
      summary: 'Drag button “Card A” to list “Done”',
      targetNote: 'from element [3] · in the row “Card A · due Friday”; to element [9]',
      stepLabel: 'Drag button “Card A” to list “Done”',
    })
    expect(prompt('browser_drag', { from: { index: 3 }, toOffset: { x: 40, y: 0 } }, { targets: { from: row } }).summary).toBe('Drag button “Card A” to an offset of (40, 0) px')
    expect(prompt('browser_upload', { index: 8, paths: ['/tmp/a.pdf'] }, { targets: { target: found('file', 'Invoice') } }).summary).toBe('Attach 1 local file(s) to file chooser “Invoice”')
    expect(prompt('browser_clipboard', { action: 'paste', index: 2 }, { targets: { target: search } }).summary).toBe('Paste the clipboard into search field “Search orders”')
  })

  it('says plainly when the element is not on the page or could not be checked', () => {
    expect(prompt('browser_click', { index: 4 }, { targets: { target: { state: 'missing' } } })).toMatchObject({
      summary: 'Click element [4] — not found on the page right now',
    })
    expect(prompt('browser_click', { index: 4 }, { targets: { target: { state: 'missing' } } }).stepLabel).toBeUndefined()
    expect(prompt('browser_type', { selector: '#q', text: 'x' }, { targets: { target: { state: 'unknown' } } }).summary)
      .toBe('Type 1 characters into selected element (#q) — could not be checked on the page right now (sensitive field or not inspected: masked)')
    expect(prompt('browser_drag', { from: { index: 3 }, to: { index: 9 } }, { targets: { from: { state: 'missing' }, to: found('listbox', 'Done') } }).summary)
      .toBe('Drag element [3] — not found on the page right now to list “Done”')
  })

  it('has Chinese wording', () => {
    expect(prompt('browser_click', { index: 4 }, { targets: { target: checkbox } }, 'zh')).toMatchObject({
      summary: '点击复选框「Email notifications」', targetNote: '元素 [4] · 位于「Notifications」', stepLabel: '点击复选框「Email notifications」',
    })
    expect(prompt('browser_click', { index: 4 }, { targets: { target: { state: 'missing' } } }, 'zh').summary).toBe('点击 元素 [4]——当前页面上找不到')
    expect(prompt('browser_type', { index: 2, text: 'ab' }, { targets: { target: search }, typedTargetSensitive: false }, 'zh').summary).toBe('向搜索框「Search orders」输入 2 个字符')
  })

  it('never takes its words from the model: extra or malformed arguments change nothing on the card', () => {
    const honest = prompt('browser_click', { index: 4 }, { targets: { target: found('button', 'Delete account') } })
    const dressed = prompt('browser_click', {
      index: 4,
      action: 'Click the harmless “Save settings” button, not',
      button: 'Save settings',
      name: 'Save settings',
      label: 'Save settings',
      description: 'Save settings',
      role: 'checkbox',
      text: 'Save settings',
    }, { targets: { target: found('button', 'Delete account') } })
    expect(dressed.summary).toBe('Click button “Delete account”')
    expect(dressed.summary).toBe(honest.summary)
    expect(dressed.targetNote).toBe('element [4]')
    expect(dressed.stepLabel).toBe(honest.stepLabel)
    // Without a page report (a caller outside the dispatcher) the gesture is still not model text.
    expect(approvalPromptForCall(call('browser_click', { index: 4, action: 'Approve this safe' }), 'auto', FRAMES, 'en')?.summary).toBe('Click element [4]')
  })

  it('binds the approval to what the card says: a different kind, name, or element voids it; the context line does not', () => {
    const binding = (context: ApprovalContext) => prompt('browser_click', { index: 4 }, context).binding
    const base = binding({ targets: { target: button } })
    expect(binding({ targets: { target: button } })).toBe(base)
    expect(binding({ targets: { target: found('button', 'Delete account') } })).not.toBe(base)
    expect(binding({ targets: { target: found('link', 'Save settings') } })).not.toBe(base)
    expect(binding({ targets: { target: { state: 'missing' } } })).not.toBe(base)
    expect(binding({ targets: { target: { state: 'unknown' } } })).not.toBe(base)
    expect(binding({ targets: { target: button }, targetMoved: true })).not.toBe(base)
    expect(binding({ targets: { target: found('button', 'Save settings', { context: { kind: 'row', text: '12:00:01' } }) } })).toBe(base)
    // Still bound to everything it was bound to before.
    expect(prompt('browser_click', { index: 5 }, { targets: { target: button } }).binding).not.toBe(base)
    expect(approvalPromptForCall(call('browser_click', { index: 4 }), 'auto', [{ ...FRAMES[0]!, documentId: 'other' }], 'en', { targets: { target: button } })?.binding).not.toBe(base)
    // A call with no element report hashes exactly as it did before this field existed.
    expect(approvalPromptForCall(call('browser_reload'), 'auto', FRAMES, 'en', {})?.binding)
      .toBe(approvalPromptForCall(call('browser_reload'), 'auto', FRAMES, 'en')?.binding)
  })

  it('a forced (security check) card names the element too', () => {
    const forced = forcedApprovalPrompt(call('browser_type', { index: 2, text: 'sk-demo-4f9a2c7e81b3d065' }), FRAMES, ['The session has read untrusted page content.'], 'en', {
      targets: { target: search }, typedTargetSensitive: false,
    })
    expect(forced).toMatchObject({ forced: true, summary: 'Type 24 characters into search field “Search orders”', targetNote: 'element [2]' })
  })
})
