// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizedDom } from '../src/content/learning.ts'

describe('sanitizedDom with a contenteditable <html> (refactor-security F2)', () => {
  it('masks the sensitive editable, not its neighbour', () => {
    document.documentElement.setAttribute('contenteditable', 'false')
    document.body.innerHTML = '<div id="otp" contenteditable aria-label="password">hunter2-secret</div><div id="notes" contenteditable aria-label="Notes">plain-notes</div>'
    const html = sanitizedDom()
    document.documentElement.removeAttribute('contenteditable')
    expect(html).not.toContain('hunter2-secret')
    expect(html).toContain('plain-notes')
  })
  it('control: without the attribute on <html> the secret is masked', () => {
    document.body.innerHTML = '<div id="otp" contenteditable aria-label="password">hunter2-secret</div><div id="notes" contenteditable aria-label="Notes">plain-notes</div>'
    const html = sanitizedDom()
    expect(html).not.toContain('hunter2-secret')
    expect(html).toContain('plain-notes')
  })
})
