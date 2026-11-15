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
    // A step after the first of its row is held to the row's first text cell only (see N3).
    const later = stepTargetOf(button, true)
    expect(later).toMatchObject({ row: '1042', rowKey: '' })
    expect(stepTargetDiffers(button, later).differs).toEqual([])
    document.querySelector('#inv > tr:nth-child(2) > td:nth-child(1)')!.textContent = '2042'
    expect(stepTargetDiffers(button, later).differs).toEqual(['row'])
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
    expect(rowIdentityOf(document.querySelector('#one')!)).toEqual({ row: '', first: '', rowKey: '' })
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
    button.closest('td')!.insertAdjacentHTML('beforeend', '<span class="spinner" aria-hidden="true"></span><button type="button">More</button>')
    ;(button as HTMLElement).className = 'go busy'
    document.body.insertAdjacentHTML('afterbegin', '<div class="toast">Saved</div>')
    expect(stepTargetDiffers(button, before).differs).toEqual([])
    // Its own label is the step's name, checked as such.
    button.textContent = 'Delete'
    expect(stepTargetDiffers(button, before).differs).toEqual(['name'])
  })
})

describe('N1: link text is row text', () => {
  const row = (id: number, name: string, amount: string): string =>
    `<tr><td><a href="/invoices/${String(id)}">${String(id)}</a></td><td><a href="/people/${name}">${name}</a></td><td>Paid</td><td>${amount}</td><td><button class="refund">Refund</button></td></tr>`

  it('a table whose id and name cells are links is identified by them, and another record in that position differs', () => {
    document.body.innerHTML = `<table><tbody id="inv">${row(1041, 'Ada', '12.00')}${row(1042, 'Grace', '12.00')}${row(1043, 'Linus', '12.00')}</tbody></table>`
    const selector = '#inv > tr:nth-child(2) .refund'
    const all = [1, 2, 3].map((n) => stepTargetOf(document.querySelector(`#inv > tr:nth-child(${String(n)}) .refund`)!))
    // It used to read "Paid" for every row, with a digest that saw only the status and the amount.
    expect(all.map((target) => target.row)).toEqual(['1041 · Ada', '1042 · Grace', '1043 · Linus'])
    expect(new Set(all.map((target) => target.rowKey)).size).toBe(3)
    expect(rowsDistinct(all.map((target) => [target]))).toBe(true)
    document.querySelector('#inv > tr:nth-child(1)')!.remove()
    expect(stepTargetDiffers(document.querySelector(selector)!, all[1]!).differs).toEqual(['row', 'rowKey'])
    // A changed link text alone is a changed row.
    document.body.innerHTML = `<table><tbody id="inv">${row(1042, 'Grace', '12.00')}${row(1043, 'Linus', '12.00')}</tbody></table>`
    const button = document.querySelector('#inv > tr:nth-child(1) .refund')!
    const approved = stepTargetOf(button)
    document.querySelector('#inv > tr:nth-child(1) a')!.textContent = '9042'
    expect(stepTargetDiffers(button, approved).differs).toEqual(['row', 'rowKey'])
  })

  it('the step\'s own element never counts as row text, a link included; buttons and form controls never do', () => {
    document.body.innerHTML = '<ul id="l"><li><span>Ada</span> <a class="x" href="#archive">Archive</a> <button>Edit</button></li><li><span>Grace</span> <a class="x" href="#archive">Archive</a> <button>Edit</button></li></ul>'
    const link = document.querySelector('.x')!
    const approved = stepTargetOf(link)
    expect(approved).toMatchObject({ tag: 'a', name: 'Archive', row: 'Ada' })
    link.textContent = 'Archived'
    document.querySelector('#l button')!.textContent = 'Editing…'
    expect(stepTargetDiffers(link, approved).differs).toEqual(['name'])
  })
})

describe('N2: a cell is not taken for the row', () => {
  it('a grid whose cells share a class: the row is what holds the cells, and the sibling cells are bound', () => {
    document.body.innerHTML = `<div id="g">${[1, 2, 3].map((n) => `<div class="row"><div class="cell">Customer ${String(n)}</div><div class="cell">note ${String(n)} <button class="del">Delete</button></div></div>`).join('')}</div>`
    const buttons = [...document.querySelectorAll('.del')]
    expect(rowContainerOf(buttons[0]!)).toBe(document.querySelector('.row'))
    const targets = buttons.map((button) => stepTargetOf(button))
    // It used to be "note 1" with the digest of an empty string and the customer cell unbound.
    expect(targets.map((target) => target.row)).toEqual(['Customer 1', 'Customer 2', 'Customer 3'])
    expect(targets.every((target) => /^[0-9a-f]{32}$/u.test(target.rowKey))).toBe(true)
    document.querySelector('.row .cell')!.textContent = 'Customer 9'
    expect(stepTargetDiffers(buttons[0]!, targets[0]!).differs).toEqual(['row', 'rowKey'])
  })

  it('a container that holds only the control\'s own cell is passed over: a layout table around a button, a lone cell', () => {
    document.body.innerHTML = `<table><tbody id="t">${[1, 2].map((n) => `<tr><td>10${String(n)}</td><td>Ada ${String(n)}</td><td><table><tr><td><button class="b">Buy</button></td></tr></table></td></tr>`).join('')}</tbody></table>`
    const buttons = [...document.querySelectorAll('.b')]
    expect(rowContainerOf(buttons[0]!)).toBe(document.querySelector('#t > tr'))
    expect(buttons.map((button) => stepTargetOf(button).row)).toEqual(['101 · Ada 1', '102 · Ada 2'])
    // Nothing anywhere says which record it is: no container, no identity, no digest.
    document.body.innerHTML = '<div id="g"><div class="row"><div class="cell"><button class="del">Delete</button></div></div><div class="row"><div class="cell"><button class="del">Delete</button></div></div></div>'
    expect(rowContainerOf(document.querySelector('.del')!)).toBeUndefined()
    expect(stepTargetOf(document.querySelector('.del')!)).toMatchObject({ row: '', rowKey: '' })
  })

  it('a row that says nothing has no digest, and is never part of a series even with an identity', () => {
    const named = { tag: 'button', role: 'button', name: 'Delete', row: 'note 1', rowKey: '' }
    expect(rowsDistinct([[named], [{ ...named, row: 'note 2' }]])).toBe(false)
    expect(rowsDistinct([[{ ...named, rowKey: 'a' }], [{ ...named, row: 'note 2', rowKey: 'b' }]])).toBe(true)
    // A later step carries no digest by design; only the first step of a row must.
    expect(rowsDistinct([[{ ...named, rowKey: 'a' }, { ...named, rowKey: '' }]])).toBe(true)
  })
})

describe('N3: only what the user can see is bound, and later steps of a row only to its id cell', () => {
  it('hidden text is neither the identity nor part of the digest', () => {
    document.body.innerHTML = '<table><tbody id="t"><tr><td style="display:none">uuid-9f3</td><td>Ada</td><td><span hidden>nonce1</span>Paid</td><td><button class="b">Buy</button></td></tr></tbody></table>'
    const button = document.querySelector('.b')!
    const approved = stepTargetOf(button)
    // It used to read "uuid-9f3 · Ada" on the card.
    expect(approved.row).toBe('Ada')
    // A nonce that changes on every render does not stop the run.
    document.querySelector('span[hidden]')!.textContent = 'nonce2'
    document.querySelector('td[style]')!.textContent = 'uuid-000'
    expect(stepTargetDiffers(button, approved).differs).toEqual([])
    // What the user can see still does.
    document.querySelector('#t td:nth-child(2)')!.textContent = 'Grace'
    expect(stepTargetDiffers(button, approved).differs).toEqual(['row', 'rowKey'])
  })

  it('a row whose first step changes a later cell: the second step still runs, held to the id cell', () => {
    document.body.innerHTML = '<table><tbody id="t"><tr><td>1042</td><td class="s">Pending</td><td><button class="ok">Approve</button><button class="n">Notify</button></td></tr></tbody></table>'
    const probed = probeRowTargets([['#t > tr:nth-child(1) .ok', '#t > tr:nth-child(1) .n']])
    const [approve, notify] = probed.targets[0]!
    // The first step binds the whole row; the one after it only the first text cell, with no digest.
    expect(approve).toMatchObject({ name: 'Approve', row: '1042 · Pending', rowKey: expect.stringMatching(/^[0-9a-f]{32}$/u) })
    expect(notify).toEqual({ tag: 'button', role: 'button', name: 'Notify', row: '1042', rowKey: '' })
    // Step 1 runs and the status flips (an ordinary 25-step program was refused here).
    document.querySelector('.s')!.textContent = 'Approved'
    expect(() => { assertStepTarget(document.querySelector('.n')!, notify, false) }).not.toThrow()
    // Another record under the selector is still caught.
    document.querySelector('#t td')!.textContent = '1043'
    expect(() => { assertStepTarget(document.querySelector('.n')!, notify, false) }).toThrow('it no longer looks like the rows you approved (was “1042”, now “1043”). Nothing was done to it.')
  })
})

describe('N5: a custom combobox cannot be a checked step', () => {
  it('select on anything but a native select is refused when the step must act on an approved element', async () => {
    document.body.innerHTML = '<ul id="l"><li><span>Ada</span><div class="c" role="combobox" aria-label="State" tabindex="0">new</div></li><li><span>Other</span></li></ul>'
    for (const el of document.querySelectorAll<HTMLElement>('*')) el.scrollIntoView = vi.fn()
    const combo = document.querySelector('.c')!
    const clicked = vi.fn()
    combo.addEventListener('click', clicked)
    const expected = stepTargetOf(combo)
    await expect(runAction('browser_select', { selector: '#l .c', value: 'done' }, {
      ids: new ElementIds(), budget: BUDGET, checkTarget: (el: Element): void => { assertStepTarget(el, expected, false) },
    })).rejects.toThrow('This list is not a native select, so its options cannot be checked against the approved row. Nothing was done to it.')
    expect(clicked).not.toHaveBeenCalled()
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
