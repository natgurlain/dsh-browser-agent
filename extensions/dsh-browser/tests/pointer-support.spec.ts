// @vitest-environment jsdom
/**
 * Content half of pointer input: measurement, hit-testing, markers, and the
 * click-effect watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElementIds } from '../src/content/ids.ts'
import { clearPointerMark, describeElement, endWatch, measureTarget, syntheticHover } from '../src/content/pointer-support.ts'

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

  it('accepts hits on the target, its children, its ancestors, and its label', () => {
    hit = document.getElementById('buy')
    expect(measureTarget({ selector: '#buy', hitTest: true }, ids).covered).toBeUndefined()
    hit = document.body
    expect(measureTarget({ selector: '#buy', hitTest: true }, ids).covered).toBeUndefined()
    hit = document.getElementById('lbl')
    expect(measureTarget({ selector: '#check', hitTest: true }, ids).covered).toBeUndefined()
  })

  it('classifies activation so toggles and submits are never retried', () => {
    expect(measureTarget({ selector: '#check' }, ids).activation).toBe('toggle')
    expect(measureTarget({ selector: '#lbl' }, ids).activation).toBe('toggle')
    expect(measureTarget({ selector: '#send' }, ids).activation).toBe('submit')
    expect(measureTarget({ selector: '#buy' }, ids).activation).toBe('control')
    expect(measureTarget({ selector: '#overlay' }, ids).activation).toBe('other')
    expect(measureTarget({ selector: '#card' }, ids).draggable).toBe(true)
  })

  it('marks and clears an element for the debugger', () => {
    measureTarget({ selector: '#buy', mark: 'tok-1' }, ids)
    expect(document.getElementById('buy')!.getAttribute('data-dsh-pointer')).toBe('tok-1')
    expect(clearPointerMark('tok-1')).toBe(true)
    expect(document.getElementById('buy')!.hasAttribute('data-dsh-pointer')).toBe(false)
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
