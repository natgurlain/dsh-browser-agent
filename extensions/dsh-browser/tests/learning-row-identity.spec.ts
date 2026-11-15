// @vitest-environment jsdom
/**
 * "Do the remaining N", content-script side: which row an element sits in
 * (the identity the approval card shows and the digest it binds), and the
 * comparison made inside the action on the very element it resolved.
 */
import { describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { assertStepTarget, probeRowTargets, rowContainerOf, rowIdentityOf, stepTargetDiffers, stepTargetOf } from '../src/content/learning.ts'
import { rowsDistinct } from '../src/shared/repetition.ts'

const BUDGET = { maxItems: 20, maxForms: 10, maxChars: 2_000 }

const invoices = (): void => {
  document.body.innerHTML = `<table><tbody id="inv">
    <tr><td>1041</td><td>Paid</td><td>300.00</td><td><button class="refund">Refund</button></td></tr>
    <tr><td>1042</td><td>Paid</td><td>12.00</td><td><button class="refund">Refund</button></td></tr>
    <tr><td>1043</td><td>Paid</td><td>9900.00</td><td><button class="refund">Refund</button></td></tr>
  </tbody></table>`
}

describe('F1: the fingerprint identifies the row', () => {
  it('an id-first table whose worded cell repeats: every row has its own identity and digest, and another record under the same selector differs', () => {
    invoices()
    const selector = '#inv > tr:nth-child(2) .refund'
    const approved = stepTargetOf(document.querySelector(selector)!)
    // The id comes first, then the first cell with words; the element's own cell is not part of it.
    expect(approved).toEqual({ tag: 'button', role: 'button', name: 'Refund', row: '1042 · Paid', rowKey: expect.stringMatching(/^[0-9a-f]{32}$/u) })
    const all = [1, 2, 3].map((row) => stepTargetOf(document.querySelector(`#inv > tr:nth-child(${String(row)}) .refund`)!))
    expect(all.map((target) => target.row)).toEqual(['1041 · Paid', '1042 · Paid', '1043 · Paid'])
    expect(new Set(all.map((target) => target.rowKey)).size).toBe(3)
    expect(rowsDistinct(all.map((target) => [target]))).toBe(true)
    // The list re-sorts, or a row above is removed: the selector now hits invoice 1043 (9900.00).
    document.querySelector('#inv > tr:nth-child(1)')!.remove()
    const now = document.querySelector(selector)!
    expect(now.closest('tr')!.textContent).toContain('1043')
    expect(stepTargetDiffers(now, approved)).toEqual({ differs: ['row', 'rowKey'], now: { ...approved, row: '1043 · Paid', rowKey: all[2]!.rowKey } })
    expect(() => { assertStepTarget(now, approved, false) }).toThrow('it no longer looks like the rows you approved (was “1042 · Paid”, now “1043 · Paid”). Nothing was done to it.')
    expect(() => { assertStepTarget(now, approved, true) }).toThrow('它与您批准的行不再一致（原为 “1042 · Paid”，现为 “1043 · Paid”）。未对它执行任何操作。')
  })

  it('binds the whole row: a changed amount is a different row even when its identity reads the same', () => {
    invoices()
    const button = document.querySelector('#inv > tr:nth-child(2) .refund')!
    const approved = stepTargetOf(button)
    document.querySelector('#inv > tr:nth-child(2) > td:nth-child(3)')!.textContent = '12000.00'
    expect(stepTargetDiffers(button, approved).differs).toEqual(['rowKey'])
    expect(() => { assertStepTarget(button, approved, false) }).toThrow('something in its row changed since you approved it. Nothing was done to it.')
    // A step after the first of its row is not held to the digest (earlier steps may have changed what the row says); its identity still is.
    expect(stepTargetDiffers(button, { ...approved, rowKey: '' }).differs).toEqual([])
    document.querySelector('#inv > tr:nth-child(2) > td:nth-child(1)')!.textContent = '2042'
    expect(stepTargetDiffers(button, { ...approved, rowKey: '' }).differs).toEqual(['row'])
  })

  it('numbers-only cells: the identity is the id, never the button\'s own label', () => {
    document.body.innerHTML = '<table><tbody id="inv"><tr><td>1041</td><td>300.00</td><td><button class="refund">Refund</button></td></tr></tbody></table>'
    expect(stepTargetOf(document.querySelector('.refund')!)).toMatchObject({ name: 'Refund', row: '1041' })
    // A row whose only other cell holds another control: nothing identifies it.
    document.body.innerHTML = '<table><tbody><tr><td><button>Edit</button></td><td><button class="refund">Refund</button></td></tr></tbody></table>'
    expect(stepTargetOf(document.querySelector('.refund')!).row).toBe('')
  })

  it('a grid of plain elements: the nearest repeating container is the row', () => {
    document.body.innerHTML = `<div id="grid">${[1, 2, 3].map((n) => `<div class="r"><span>Customer ${String(n)}</span><div class="actions"><button class="edit">Edit</button><button class="del">Delete</button></div></div>`).join('')}</div>`
    const probed = probeRowTargets([1, 2, 3].map((n) => [`#grid > div:nth-child(${String(n)}) .del`]))
    expect(probed.targets.flat().map((target) => target.row)).toEqual(['Customer 1', 'Customer 2', 'Customer 3'])
    expect(rowsDistinct(probed.targets)).toBe(true)
    expect(rowContainerOf(document.querySelector('.del')!)).toBe(document.querySelector('.r'))
    // A list item whose text sits beside its button.
    document.body.innerHTML = '<ul id="l"><li>Ada <button class="a">Archive</button></li><li>Grace <button class="a">Archive</button></li></ul>'
    expect([...document.querySelectorAll('.a')].map((button) => stepTargetOf(button).row)).toEqual(['Ada', 'Grace'])
  })

  it('no row can be established: the identity is empty, so such rows are never told apart', () => {
    document.body.innerHTML = '<main><h1>Inbox</h1><button id="one">Delete</button><p>text</p><button id="two">Delete</button></main>'
    expect(rowContainerOf(document.querySelector('#one')!)).toBeUndefined()
    expect(rowIdentityOf(document.querySelector('#one')!)).toEqual({ row: '', rowKey: '' })
    expect(rowsDistinct([[stepTargetOf(document.querySelector('#one')!)], [stepTargetOf(document.querySelector('#two')!)]])).toBe(false)
    // Rows that all read the same.
    document.body.innerHTML = '<ul><li><span>Paid</span><button>Refund</button></li><li><span>Paid</span><button>Refund</button></li></ul>'
    expect(rowsDistinct([...document.querySelectorAll('button')].map((button) => [stepTargetOf(button)]))).toBe(false)
  })

  it('masks sensitive cells and ignores what the controls of a row say', () => {
    document.body.innerHTML = `<table><tbody>
      <tr><td>Ada</td><td><input type="password" value="hunter2"></td><td><input aria-label="Email" value="a@example.org"></td><td><button class="go">Invite</button></td></tr>
    </tbody></table>`
    const button = document.querySelector('.go')!
    const before = stepTargetOf(button)
    expect(before.row).toBe('Ada')
    // Typing into the row's fields, a relabelled sibling control, a spinner, styling: the row still says the same.
    ;(document.querySelector('input[aria-label="Email"]') as HTMLInputElement).value = 'changed@example.org'
    button.closest('td')!.insertAdjacentHTML('beforeend', '<span class="spinner" aria-hidden="true"></span><a href="#x">Details</a>')
    ;(button as HTMLElement).className = 'go busy'
    document.body.insertAdjacentHTML('afterbegin', '<div class="toast">Saved</div>')
    expect(stepTargetDiffers(button, before).differs).toEqual([])
    // Its own label is the step's name, checked as such.
    button.textContent = 'Delete'
    expect(stepTargetDiffers(button, before).differs).toEqual(['name'])
  })
})

describe('F2: the comparison is made inside the action, on the element it resolved', () => {
  const list = (name: string): void => {
    document.body.innerHTML = `<ul id="l"><li><span>${name}</span><button class="a">Archive</button></li><li><span>Other</span><button class="a">Archive</button></li></ul>`
    for (const el of document.querySelectorAll<HTMLElement>('*')) el.scrollIntoView = vi.fn()
  }
  const args = { selector: '#l > li:nth-child(1) .a' }
  const guarded = (expected: unknown) => ({
    ids: new ElementIds(),
    budget: BUDGET,
    checkTarget: (el: Element): void => { assertStepTarget(el, expected, false) },
  })

  it('a click runs on the approved element, and is refused, with the page untouched, once another node sits under the selector', async () => {
    list('Ada')
    const expected = stepTargetOf(document.querySelector(args.selector)!)
    const clicked = vi.fn()
    document.addEventListener('click', clicked)
    await runAction('browser_click', args, guarded(expected))
    expect(clicked).toHaveBeenCalledTimes(1)
    // The list re-renders after any earlier look at it: the action resolves the selector afresh, and compares what it found.
    list('Grace')
    await expect(runAction('browser_click', args, guarded(expected))).rejects.toThrow('it no longer looks like the rows you approved (was “Ada”, now “Grace”). Nothing was done to it.')
    expect(clicked).toHaveBeenCalledTimes(1)
    document.removeEventListener('click', clicked)
  })

  it('type and select make the same comparison before touching the field', async () => {
    document.body.innerHTML = '<ul id="l"><li><span>Ada</span><input class="a" aria-label="Email"><select class="s" aria-label="State"><option>new</option><option>done</option></select></li><li><span>Other</span></li></ul>'
    for (const el of document.querySelectorAll<HTMLElement>('*')) el.scrollIntoView = vi.fn()
    const input = document.querySelector('input')!
    const select = document.querySelector('select')!
    const expectedInput = stepTargetOf(input)
    const expectedSelect = stepTargetOf(select)
    document.querySelector('#l span')!.textContent = 'Grace'
    await expect(runAction('browser_type', { selector: '#l input', text: 'x', replace: true }, guarded(expectedInput))).rejects.toThrow(/was “Ada”, now “Grace”/u)
    expect(input.value).toBe('')
    await expect(runAction('browser_select', { selector: '#l select', value: 'done' }, guarded(expectedSelect))).rejects.toThrow(/was “Ada”, now “Grace”/u)
    expect(select.value).toBe('new')
    document.querySelector('#l span')!.textContent = 'Ada'
    await runAction('browser_type', { selector: '#l input', text: 'x', replace: true }, guarded(expectedInput))
    expect(input.value).toBe('x')
  })

  it('a hidden element, or an expectation that is not well formed, never passes', () => {
    list('Ada')
    const button = document.querySelector(args.selector)!
    const expected = stepTargetOf(button)
    expect(() => { assertStepTarget(button, expected, false) }).not.toThrow()
    expect(() => { assertStepTarget(button, { tag: 'button' }, false) }).toThrow('its element is gone or hidden. Nothing was done to it.')
    expect(() => { assertStepTarget(button, undefined, false) }).toThrow(/gone or hidden/u)
    button.setAttribute('hidden', '')
    expect(() => { assertStepTarget(button, expected, false) }).toThrow(/gone or hidden/u)
  })
})
