// @vitest-environment jsdom
/**
 * Content half of pointer input: measurement, hit-testing, markers, and the
 * click-effect watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { clearPointerMark, describeElement, endWatch, measureTarget, syntheticHover } from '../src/content/pointer-support.ts'
import { POINTER_REGISTRY_GLOBAL, type PointerRegistry } from '../src/shared/input-setup.ts'

let hit: Element | null = null

beforeEach(() => {
  document.body.innerHTML = `
    <button id="buy" class="primary big">Buy</button>
    <div id="overlay" class="modal backdrop" role="dialog"></div>
    <label id="lbl" for="check">Agree</label><input id="check" type="checkbox">
    <form><button id="send" type="submit">Send</button></form>
    <div id="card" draggable="true">Card</div>`
  hit = null
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const ids = new ElementIds()

describe('measure and hit-test', () => {
  it('reports the element that covers the target center', () => {
    hit = document.getElementById('overlay')
    const measured = measureTarget({ selector: '#buy', hitTest: true }, ids)
    expect(measured.covered).toBe('<div id="overlay" class="modal backdrop" role="dialog">')
  })

  it('accepts hits on the target, its children, and its label, but not an ancestor (#7)', () => {
    hit = document.getElementById('buy')
    expect(measureTarget({ selector: '#buy', hitTest: true }, ids).covered).toBeUndefined()
    hit = document.getElementById('lbl')
    expect(measureTarget({ selector: '#check', hitTest: true }, ids).covered).toBeUndefined()
    // A click landing on an ancestor (pointer-events:none on the target) never reaches the target.
    hit = document.body
    expect(measureTarget({ selector: '#buy', hitTest: true }, ids).covered).toBe('<body>')
  })

  it('aims at the largest visible client rect of a wrapped inline element (#7, wrap-poc)', () => {
    document.body.insertAdjacentHTML('beforeend', '<p id="para">Read the <a id="w1" href="#one">long-agreement-x of</a> <a id="s1" href="#other">privacy</a></p>')
    const link = document.getElementById('w1')!
    // Line 1 ends at the right edge, line 2 starts at the left: the bbox center lies on the sibling.
    const rects = [new DOMRect(150, 10, 90, 20), new DOMRect(0, 30, 40, 20)]
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 240, 40))
    vi.spyOn(link, 'getClientRects').mockReturnValue(Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList)
    const points: Array<[number, number]> = []
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number, y: number) => { points.push([x, y]); return x >= 150 ? link : document.getElementById('s1') } })
    const measured = measureTarget({ selector: '#w1', hitTest: true }, ids)
    expect(measured.center).toEqual({ x: 195, y: 20 })
    expect(points).toEqual([[195, 20]])
    expect(measured.covered).toBeUndefined()
  })

  it('caps and strips page-controlled tag names in descriptions (#10)', () => {
    const custom = document.createElement(`x-${'a'.repeat(200)}-ignore-previous`)
    const text = describeElement(custom)
    expect(text.length).toBeLessThanOrEqual(45)
    expect(text.startsWith('<x-aaaa')).toBe(true)
  })

  it('classifies activation so toggles and submits are never retried', () => {
    expect(measureTarget({ selector: '#check' }, ids).activation).toBe('toggle')
    expect(measureTarget({ selector: '#lbl' }, ids).activation).toBe('toggle')
    expect(measureTarget({ selector: '#send' }, ids).activation).toBe('submit')
    expect(measureTarget({ selector: '#buy' }, ids).activation).toBe('control')
    expect(measureTarget({ selector: '#overlay' }, ids).activation).toBe('other')
    expect(measureTarget({ selector: '#card' }, ids).draggable).toBe(true)
  })

  it('hands an element to the debugger without any DOM-visible marker (#2, pointer-poc)', async () => {
    const records: MutationRecord[] = []
    const observer = new MutationObserver((list) => { records.push(...list) })
    observer.observe(document, { subtree: true, attributes: true, childList: true })
    measureTarget({ selector: '#buy', mark: 'tok-1' }, ids)
    await Promise.resolve()
    records.push(...observer.takeRecords())
    observer.disconnect()
    const button = document.getElementById('buy')!
    expect(records).toEqual([])
    expect([...button.attributes].map((attribute) => attribute.name)).toEqual(['id', 'class'])
    const registry = (globalThis as Record<string, unknown>)[POINTER_REGISTRY_GLOBAL] as PointerRegistry
    expect(registry.has('tok-1')).toBe(true)
    expect(registry.get('tok-1')).toBe(button)
    // The CDP re-hit-test accepts the target and its descendants only.
    button.innerHTML = '<span id="inside">Buy</span>'
    expect(registry.reaches('tok-1', button)).toBe(true)
    expect(registry.reaches('tok-1', document.getElementById('inside')!.firstChild!)).toBe(true)
    expect(registry.reaches('tok-1', document.body)).toBe(false)
    expect(registry.reaches('tok-1', document.getElementById('overlay')!)).toBe(false)
    expect(registry.reaches('other', button)).toBe(false)
    expect(clearPointerMark('tok-1')).toBe(true)
    expect(registry.has('tok-1')).toBe(false)
  })

  it('keeps descriptions inert', () => {
    const element = document.createElement('div')
    element.id = 'x"><script>'
    element.className = 'ignore-previous instructions'
    expect(describeElement(element)).toBe('<div id="xscript" class="ignore-previous instructions">')
  })
})

describe('click-effect watch', () => {
  it('reports no change when nothing happened', () => {
    measureTarget({ selector: '#buy', watch: 'w1' }, ids)
    expect(endWatch('w1')).toEqual({ changed: false, reasons: [] })
  })

  it('notices DOM mutations but ignores its own markers', async () => {
    measureTarget({ selector: '#buy', watch: 'w2' }, ids)
    document.getElementById('buy')!.setAttribute('data-dsh-pointer', 'x')
    expect(endWatch('w2').changed).toBe(false)
    measureTarget({ selector: '#buy', watch: 'w3' }, ids)
    document.body.append(document.createElement('p'))
    expect(endWatch('w3')).toEqual({ changed: true, reasons: ['dom'] })
  })

  it('notices a checkbox state change without mutations', () => {
    measureTarget({ selector: '#buy', watch: 'w4' }, ids)
    ;(document.getElementById('check') as HTMLInputElement).checked = true
    expect(endWatch('w4').reasons).toContain('value')
  })

  it('treats an unknown watch as changed', () => {
    expect(endWatch('missing').changed).toBe(true)
  })
})

describe('synthetic hover', () => {
  it('dispatches the enter/over/move sequence', () => {
    const events: string[] = []
    const button = document.getElementById('buy')!
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) button.addEventListener(type, () => events.push(type))
    syntheticHover({ selector: '#buy' }, ids)
    expect(events).toEqual(['mouseover', 'mouseenter', 'mousemove'])
  })
})
