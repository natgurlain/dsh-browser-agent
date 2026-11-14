// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveSelector, resolveSelectorAll } from '../src/content/dom.ts'
import { accessibleName, collectInteractive, isVisible, mainText, structuredText } from '../src/content/extract.ts'
import { findElements, uniqueSelectorFor } from '../src/content/find.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, collapseRuns, diffLines, renderSnapshot } from '../src/content/snapshot.ts'
import { resolveActionTarget } from '../src/content/actions.ts'

const BUDGET = { maxItems: 60, maxForms: 30, maxChars: 12_000 }

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('inventory blind spots', () => {
  it('lists ARIA widget roles, focusable and clickable elements, and summary', () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="Country">Pick</div>
      <div role="option">Option A</div>
      <div role="switch" aria-checked="true">Wi-Fi</div>
      <div role="slider" aria-label="Volume"></div>
      <div role="spinbutton" aria-label="Qty"></div>
      <div role="searchbox" aria-label="Search"></div>
      <div role="textbox" aria-label="Notes"></div>
      <div role="menuitemcheckbox">Bold</div>
      <div role="menuitemradio">Left</div>
      <div role="treeitem">Folder</div>
      <div role="gridcell" aria-selected="false">Cell</div>
      <div role="gridcell">Plain cell</div>
      <div tabindex="0">Focusable card</div>
      <div tabindex="-1">Not focusable by tab</div>
      <div onclick="void 0">Clickable row</div>
      <details><summary>More</summary></details>
      <div contenteditable="false">Read only</div>
    `
    const names = collectInteractive(document).map((el) => accessibleName(el))
    expect(names).toEqual([
      'Country', 'Option A', 'Wi-Fi', 'Volume', 'Qty', 'Search', 'Notes', 'Bold', 'Left', 'Folder', 'Cell',
      'Focusable card', 'Clickable row', 'More',
    ])
  })

  it('drops clickable wrappers around real controls', () => {
    document.body.innerHTML = '<div onclick="void 0" tabindex="0"><button>Buy</button></div>'
    expect(collectInteractive(document).map((el) => el.tagName)).toEqual(['BUTTON'])
  })

  it('treats opacity:0 checkboxes behind a visible label as visible', () => {
    document.body.innerHTML = '<label id="l"><input id="c" type="checkbox" style="opacity:0">Remember me</label>'
    const input = document.querySelector('#c')!
    expect(isVisible(input)).toBe(true)
    expect(collectInteractive(document)).toEqual([input])
  })

  it('lists the label of a fully hidden custom control as its click target', () => {
    document.body.innerHTML = '<input id="t" type="checkbox" style="display:none" checked><label for="t">Dark mode</label>'
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const text = renderSnapshot(view, false)
    expect(text).toMatch(/\[\d+\] checkbox label "Dark mode" \[checked\]/)
  })

  it('joins every aria-labelledby reference', () => {
    document.body.innerHTML = '<span id="a">Billing</span><span id="b">address</span><input aria-labelledby="a b">'
    expect(accessibleName(document.querySelector('input')!)).toBe('Billing address')
  })
})

describe('open shadow roots', () => {
  function mountShadow(): { host: HTMLElement; button: HTMLButtonElement } {
    document.body.innerHTML = '<x-card id="card"></x-card>'
    const host = document.querySelector<HTMLElement>('#card')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<span id="lbl">Shadow</span><button aria-labelledby="lbl">x</button><input id="field" placeholder="Inner field">'
    return { host, button: shadow.querySelector('button')! }
  }

  it('collects controls inside open shadow roots and names them within the root', () => {
    const { button } = mountShadow()
    const inventory = collectInteractive(document)
    expect(inventory).toContain(button)
    expect(accessibleName(button)).toBe('Shadow')
  })

  it('resolves piercing selectors and falls back to shadow search for plain ones', () => {
    const { button } = mountShadow()
    expect(resolveSelector('#card >>> button')).toBe(button)
    expect(resolveSelector('button')).toBe(button)
    expect(resolveSelectorAll('x-card >>> input')).toHaveLength(1)
  })

  it('splits >>> only outside quoted strings and brackets (#11)', () => {
    const { button } = mountShadow()
    // (jsdom's selector engine mis-parses spaces around > inside quotes, so the values avoid them.)
    document.getElementById('card')!.setAttribute('title', 'a>>>b')
    document.getElementById('card')!.setAttribute('data-x', 'a>>>b')
    expect(resolveSelector('[title="a>>>b"] >>> button')).toBe(button)
    expect(resolveSelector("[data-x='a>>>b'] >>> button")).toBe(button)
    expect(resolveSelector('#card:not([title="x >>> y"]) >>> button')).toBe(button)
  })

  it('builds selectors that address shadow elements and are accepted by actions', () => {
    const { button } = mountShadow()
    const selector = uniqueSelectorFor(button)
    expect(selector).toContain('>>>')
    expect(resolveSelector(selector)).toBe(button)
    expect(resolveActionTarget({ selector }, new ElementIds())).toBe(button)
  })

  it('finds shadow elements by text and renders shadow text in the main content', () => {
    mountShadow()
    const found = findElements({ text: 'inner field', limit: 5 })
    expect(found.map((item) => item.selector)).toEqual(['#card >>> #field'])
    expect(structuredText(document.body)).toContain('Shadow')
  })

  it('assigns snapshot indices to shadow elements', () => {
    const { button } = mountShadow()
    const ids = new ElementIds()
    buildSnapshot(ids, { budget: BUDGET }, null)
    const index = ids.indexOf(button)
    expect(index).toBeDefined()
    expect(resolveActionTarget({ index }, ids)).toBe(button)
  })
})

describe('structured main text', () => {
  it('keeps headings, nested lists and table rows as lightweight structure', () => {
    document.body.innerHTML = `<main>
      <h2>Orders</h2>
      <ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul>
      <table><tr><th>Id</th><th>Total</th></tr><tr><td>A-1</td><td>¥5</td></tr></table>
      <p>Done <b>today</b>.</p>
    </main>`
    expect(mainText(document).split('\n')).toEqual([
      '## Orders', '- First', '  - Nested', '- Second', '| Id | Total |', '| A-1 | ¥5 |', 'Done today.',
    ])
  })
})

describe('snapshot knobs', () => {
  function manyLinks(count: number): string {
    return Array.from({ length: count }, (_, index) => `<a href="/item/${index + 1}">Item ${index + 1}</a>`).join('')
  }

  it('collapses long runs of similar items and can list them all', () => {
    document.body.innerHTML = `<main><p>Catalog</p></main><button>Top</button>${manyLinks(20)}`
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget: BUDGET }, null)
    const text = renderSnapshot(view, false)
    expect(text).toContain('"Item 3"')
    expect(text).not.toContain('link "Item 4"')
    expect(text).toMatch(/\[\d+–\d+\] 17 more links like "Item 4"/)
    const full = renderSnapshot(buildSnapshot(ids, { budget: BUDGET, collapse: false }, view), false)
    expect(full).toContain('"Item 20"')
  })

  it('never hides distinct navigation links in a collapsed run (#11, collapse PoC)', () => {
    const names = ['Products', 'Pricing', 'Docs', 'Blog', 'About', 'Careers', 'Contact', 'Delete account', 'Log out']
    document.body.innerHTML = `<nav>${names.map((name) => `<a href="/${name.toLowerCase().replace(/ /g, '-')}">${name}</a>`).join(' ')}</nav>`
      + `<div>${['Profile', 'Settings', 'Billing', 'Security', 'Sessions', 'Tokens', 'Export', 'Delete'].map((name) => `<a href="/account/${name.toLowerCase()}">${name}</a>`).join(' ')}</div>`
    const text = renderSnapshot(buildSnapshot(new ElementIds(), { budget: BUDGET }, null), false)
    for (const name of [...names, 'Tokens', 'Export', 'Delete']) expect(text).toContain(`"${name}"`)
    expect(text).not.toMatch(/more links like/)
  })

  it('does not collapse short or dissimilar runs', () => {
    const items = ['A', 'B', 'C'].map((name, index) => ({ index, role: 'button', name, inViewport: true }))
    expect(collapseRuns(items)).toHaveLength(3)
  })

  it('renders interactive-only and text-only modes', () => {
    document.body.innerHTML = '<main><p>Body text</p></main><button>Go</button>'
    const ids = new ElementIds()
    const interactive = renderSnapshot(buildSnapshot(ids, { budget: BUDGET, mode: 'interactive' }, null), false)
    expect(interactive).not.toContain('Body text')
    expect(interactive).toContain('"Go"')
    const text = renderSnapshot(buildSnapshot(ids, { budget: BUDGET, mode: 'text' }, null), false)
    expect(text).toContain('Body text')
    expect(text).not.toContain('Interactive elements:')
  })

  it('limits the inventory to the viewport on request', () => {
    document.body.innerHTML = '<button id="in">Inside</button><button id="out">Outside</button>'
    const out = document.querySelector('#out')!
    Object.defineProperty(out, 'getBoundingClientRect', {
      value: () => ({ top: 5000, bottom: 5040, left: 0, right: 100, width: 100, height: 40 }),
    })
    const view = buildSnapshot(new ElementIds(), { budget: BUDGET, viewportOnly: true }, null)
    const text = renderSnapshot(view, false)
    expect(text).toContain('"Inside"')
    expect(text).not.toContain('"Outside"')
    expect(text).toContain('Scope: viewport only')
  })

  it('diffs main text by lines', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual({ added: ['d'], removed: ['b'] })
    expect(diffLines('x\nx', 'x')).toEqual({ added: [], removed: ['x'] })
  })
})
