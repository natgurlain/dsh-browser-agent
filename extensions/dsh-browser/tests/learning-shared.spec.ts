// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { validateWorkflow } from 'dsh-browser-agent/src/learning/workflow.ts'
import { buildWorkflow, type RecordedStep } from '../src/shared/workflow-build.ts'
import { buildProgram, detectRepetition, generalizeSelectors, instantiate, nextSelectors, type WatchEvent } from '../src/shared/repetition.ts'

const steps: RecordedStep[] = [
  { id: 'a', tool: 'browser_navigate', args: { url: 'https://crm.example/new' }, at: 1, origin: 'https://crm.example' },
  { id: 'b', tool: 'browser_type', args: { text: 'Ada', replace: true }, locator: { role: 'textbox', name: 'Name', css: '#name' }, at: 2 },
  { id: 'c', tool: 'browser_type', args: { replace: true }, sensitive: true, locator: { role: 'textbox', name: 'Password', css: '#pw' }, at: 3 },
  { id: 'd', tool: 'browser_click', args: {}, locator: { role: 'button', name: 'Save', text: 'Save', css: '#save' }, at: 4 },
]

describe('Save as workflow', () => {
  it('builds a valid workflow with variables and never a sensitive value', () => {
    const workflow = buildWorkflow(steps, { name: 'Add contact', variables: { b: 'contact' } }, new Date('2026-11-15T00:00:00Z'))
    const valid = validateWorkflow(workflow)
    expect(valid.name).toBe('add-contact')
    expect(valid.origin).toBe('https://crm.example')
    expect(valid.params).toEqual([
      { name: 'contact', default: 'Ada', description: 'Value for Name.' },
      { name: 'password', sensitive: true, description: 'Value for Password (never stored).' },
    ])
    expect(valid.steps[1]!.args.text).toBe('{{contact}}')
    expect(valid.steps[2]!.args.text).toBe('{{password}}')
    expect(JSON.stringify(workflow)).not.toMatch(/"index"|"selector"/)
  })

  it('keeps literal values unless marked, and honors skipped steps', () => {
    const workflow = buildWorkflow(steps, { name: 'x', skip: ['c'] })
    const valid = validateWorkflow(workflow)
    expect(valid.steps.map((step) => step.tool)).toEqual(['browser_navigate', 'browser_type', 'browser_click'])
    expect(valid.steps[1]!.args.text).toBe('Ada')
    expect(() => buildWorkflow(steps, { name: '!!!' })).toThrow(/name/)
    expect(() => buildWorkflow(steps, { name: 'x', skip: ['a', 'b', 'c', 'd'] })).toThrow(/at least one step/)
  })
})

describe('Watch me repetition', () => {
  it('generalizes selectors that differ by a row index', () => {
    const template = generalizeSelectors(['#list > li:nth-child(1) > button', '#list > li:nth-child(2) > button', '#list > li:nth-child(3) > button'])!
    expect(instantiate(template, 5)).toBe('#list > li:nth-child(6) > button')
    expect(instantiate(generalizeSelectors(['#row-3 > td:nth-child(2)', '#row-4 > td:nth-child(2)'])!, 2)).toBe('#row-5 > td:nth-child(2)')
    expect(generalizeSelectors(['#a', '#b'])).toBeUndefined()
    expect(generalizeSelectors(['li:nth-child(1)', 'li:nth-child(2)', 'li:nth-child(4)'])).toBeUndefined()
    expect(instantiate(generalizeSelectors(['#save', '#save'])!, 9)).toBe('#save')
  })

  const row = (index: number, name: string): WatchEvent[] => [
    { kind: 'type', css: `#people > tr:nth-child(${String(index)}) > td:nth-child(3) > input`, value: name, cells: [String(index), name, ''] },
    { kind: 'click', css: `#people > tr:nth-child(${String(index)}) > td:nth-child(4) > button`, label: 'Invite', cells: [String(index), name, ''] },
  ]

  it('detects a two-step block over rows with a cell value source after two repetitions', () => {
    const events = [{ kind: 'click' as const, css: '#unrelated' }, ...row(1, 'Ada'), ...row(2, 'Grace')]
    const pattern = detectRepetition(events)!
    expect(pattern).toMatchObject({ period: 2, done: 2 })
    expect(pattern.steps[0]!.value).toEqual({ kind: 'cell', cell: 1 })
    expect(nextSelectors(pattern, 1)).toEqual([['#people > tr:nth-child(3) > td:nth-child(3) > input', '#people > tr:nth-child(3) > td:nth-child(4) > button']])
    expect(buildProgram(pattern, [['3', 'Linus', ''], ['4', 'Barbara', '']])).toEqual([
      { tool: 'browser_type', args: { selector: '#people > tr:nth-child(3) > td:nth-child(3) > input', text: 'Linus', replace: true } },
      { tool: 'browser_click', args: { selector: '#people > tr:nth-child(3) > td:nth-child(4) > button' } },
      { tool: 'browser_type', args: { selector: '#people > tr:nth-child(4) > td:nth-child(3) > input', text: 'Barbara', replace: true } },
      { tool: 'browser_click', args: { selector: '#people > tr:nth-child(4) > td:nth-child(4) > button' } },
    ])
  })

  it('needs two repetitions, and refuses values it cannot explain or never saw', () => {
    expect(detectRepetition(row(1, 'Ada'))).toBeUndefined()
    const unexplained = [...row(1, 'Ada'), ...row(2, 'Grace')].map((event) => event.kind === 'type' ? { ...event, cells: ['x', 'y'] } : event)
    unexplained[2] = { ...unexplained[2]!, value: 'Somebody else' }
    expect(detectRepetition(unexplained)).toBeUndefined()
    const masked = [...row(1, 'Ada'), ...row(2, 'Grace')].map((event) => event.kind === 'type' ? { kind: 'type' as const, css: event.css, sensitive: true } : event)
    expect(detectRepetition(masked)).toBeUndefined()
    const constantClicks = [{ kind: 'click' as const, css: '#save' }, { kind: 'click' as const, css: '#save' }]
    expect(detectRepetition(constantClicks)).toBeUndefined()
  })
})
