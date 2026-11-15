// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LearningPanel } from '../src/panel/LearningPanel.tsx'
import { LearningSettings } from '../src/panel/LearningSettings.tsx'
import type { LearningState } from '../src/panel/learning-api.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let posted: Array<Record<string, unknown>> = []
let listeners: Array<(message: unknown) => void> = []

function push(state: Partial<LearningState>): void {
  const full: LearningState = {
    settings: { workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false },
    siteDriversSupported: true, steps: [], watching: null, suggestion: null, proposals: [], drivers: [],
    ...state,
  }
  for (const listener of listeners) listener({ type: 'learning.state', state: full })
}

beforeEach(() => {
  posted = []
  listeners = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: vi.fn(() => ({
        postMessage: (message: Record<string, unknown>) => {
          posted.push(message)
          for (const listener of listeners) listener({ type: 'learning.result', id: message.id, ok: true, result: message.type === 'learning.workflow.list' ? { workflows: [] } : message.type === 'learning.schedule.list' ? { schedules: [] } : true })
        },
        onMessage: { addListener: (listener: (message: unknown) => void) => { listeners.push(listener) } },
        onDisconnect: { addListener: () => {} },
        disconnect: () => {},
      })),
      getManifest: () => ({ optional_permissions: [] }),
    },
    permissions: { request: vi.fn(async () => true) },
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  await act(async () => { createRoot(host).render(element) })
  return host
}

describe('learning panel UI', () => {
  it('renders nothing while every feature is off (the default)', async () => {
    const host = await mount(createElement(LearningPanel, { locale: 'en', connected: true, sessionId: 's1' }))
    await act(async () => { push({}) })
    expect(host.innerHTML).toBe('')
  })

  it('settings start unchecked, explain what is recorded, and save a toggle immediately (EN and ZH)', async () => {
    expect(renderToStaticMarkup(createElement(LearningSettings, { locale: 'zh' }))).toContain('默认全部关闭')
    const host = await mount(createElement(LearningSettings, { locale: 'en' }))
    await act(async () => { push({}) })
    const boxes = [...host.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
    expect(boxes).toHaveLength(4)
    expect(boxes.every((box) => !box.checked)).toBe(true)
    expect(host.textContent).toContain('never recorded')
    await act(async () => { boxes[0]!.click() })
    expect(posted.find((message) => message.type === 'learning.settings')).toMatchObject({ settings: { workflows: true } })
  })

  it('shows recorded steps with sensitive values masked and sends the save choices', async () => {
    const host = await mount(createElement(LearningPanel, { locale: 'en', connected: true, sessionId: 's1' }))
    await act(async () => {
      push({
        settings: { workflows: true, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false },
        steps: [
          { id: 'a', tool: 'browser_type', args: { text: 'Ada' }, locator: { role: 'textbox', name: 'Name' }, at: 1 },
          { id: 'b', tool: 'browser_type', args: {}, sensitive: true, locator: { role: 'textbox', name: 'Password' }, at: 2 },
        ],
      })
    })
    expect(host.textContent).toContain('2 step(s) recorded')
    await act(async () => { (host.querySelector('button.secondary') as HTMLButtonElement).click() })
    expect(host.textContent).toContain('never stored')
    const nameInput = host.querySelector('input[aria-label="Workflow name"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(nameInput, 'login')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const variable = host.querySelector('.learning-variable input[type=checkbox]') as HTMLInputElement
    await act(async () => { variable.click() })
    await act(async () => { ([...host.querySelectorAll('button.primary')].find((button) => button.textContent === 'Save') as HTMLButtonElement).click() })
    expect(posted.find((message) => message.type === 'learning.workflow.save')).toMatchObject({ sessionId: 's1', choices: { name: 'login', variables: { a: 'name' } } })
  })

  it('gives two same-named fields distinct default variable names, so Save does not fail (finding 5)', async () => {
    const host = await mount(createElement(LearningPanel, { locale: 'en', connected: true, sessionId: 's1' }))
    await act(async () => {
      push({
        settings: { workflows: true, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false },
        steps: [
          { id: 'a', tool: 'browser_type', args: { text: 'a@x' }, locator: { role: 'textbox', name: 'Email' }, at: 1 },
          { id: 'b', tool: 'browser_type', args: { text: 'b@x' }, locator: { role: 'textbox', name: 'Email' }, at: 2 },
        ],
      })
    })
    await act(async () => { (host.querySelector('button.secondary') as HTMLButtonElement).click() })
    const boxes = [...host.querySelectorAll('.learning-variable input[type=checkbox]')] as HTMLInputElement[]
    await act(async () => { boxes[0]!.click() })
    await act(async () => { boxes[1]!.click() })
    const names = ([...host.querySelectorAll('input[aria-label="Variable name"]')] as HTMLInputElement[]).map((input) => input.value)
    expect(names).toEqual(['email', 'email_2'])
  })

  it('clears the save form after a successful save (finding 21)', async () => {
    const host = await mount(createElement(LearningPanel, { locale: 'en', connected: true, sessionId: 's1' }))
    const settings = { workflows: true, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false }
    await act(async () => {
      push({ settings, steps: [{ id: 'a', tool: 'browser_type', args: { text: 'Ada' }, locator: { role: 'textbox', name: 'Name' }, at: 1 }] })
    })
    await act(async () => { (host.querySelector('button.secondary') as HTMLButtonElement).click() })
    const nameInput = host.querySelector('input[aria-label="Workflow name"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'login')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { (host.querySelector('.learning-variable input[type=checkbox]') as HTMLInputElement).click() })
    await act(async () => { ([...host.querySelectorAll('button.primary')].find((button) => button.textContent === 'Save') as HTMLButtonElement).click() })
    await act(async () => { push({ settings, steps: [{ id: 'c', tool: 'browser_type', args: { text: 'Bo' }, locator: { role: 'textbox', name: 'Name' }, at: 3 }] }) })
    await act(async () => { (host.querySelector('button.secondary') as HTMLButtonElement).click() })
    expect((host.querySelector('input[aria-label="Workflow name"]') as HTMLInputElement).value).toBe('')
    expect(host.querySelector('input[aria-label="Variable name"]')).toBeNull()
  })

  it('drops the previous conversation state when the session changes (finding 21)', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(LearningPanel, { locale: 'en', connected: true, sessionId: 's1' })) })
    await act(async () => {
      push({ settings: { workflows: true, siteDrivers: false, siteDriverOrigins: [], watchMe: false, fixtures: false }, steps: [{ id: 'a', tool: 'browser_click', args: {}, at: 1 }] })
    })
    expect(host.textContent).toContain('1 step(s) recorded')
    await act(async () => { root.render(createElement(LearningPanel, { locale: 'en', connected: true, sessionId: 's2' })) })
    expect(host.textContent).not.toContain('1 step(s) recorded')
    expect(posted.filter((message) => message.type === 'learning.subscribe').map((message) => message.sessionId)).toEqual(['s1', 's2'])
  })

  it('resets the import file input so the same file can be chosen again (finding 21)', async () => {
    const host = await mount(createElement(LearningPanel, { locale: 'en', connected: true }))
    await act(async () => { push({ settings: { workflows: false, siteDrivers: true, siteDriverOrigins: [], watchMe: false, fixtures: false } }) })
    const input = host.querySelector('input[type=file]') as HTMLInputElement
    // jsdom's File has no text(); the panel only reads it.
    const file = { name: 'drivers.json', text: async () => '[]' }
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    let value = 'C:\\fakepath\\drivers.json'
    Object.defineProperty(input, 'value', { configurable: true, get: () => value, set: (next: string) => { value = next } })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(value).toBe('')
  })

  it('offers "Do the remaining N like this" in both languages', async () => {
    const suggestion = { tabId: 1, origin: 'https://a.example', remaining: 3, done: 2, period: 1, program: [], labels: ['click "Invite"'] }
    const host = await mount(createElement(LearningPanel, { locale: 'zh', connected: true }))
    await act(async () => { push({ settings: { workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: true, fixtures: false }, suggestion, watching: { tabId: 1, origin: 'https://a.example', events: 4 } }) })
    expect(host.textContent).toContain('按同样方式完成剩余 3 项')
    await act(async () => { (host.querySelector('.learning-suggestion button') as HTMLButtonElement).click() })
    expect(posted.some((message) => message.type === 'learning.watch.run')).toBe(true)
  })

  it('states the true total on a long offer, and offers to continue a run that stopped part-way', async () => {
    const watching = { settings: { workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: true, fixtures: false }, watching: null }
    const long = { tabId: 1, origin: 'https://a.example', remaining: 38, more: false, done: 2, period: 3, program: Array.from({ length: 114 }, () => ({ tool: 'browser_click' as const, args: {} })), labels: [] }
    const host = await mount(createElement(LearningPanel, { locale: 'en', connected: true }))
    await act(async () => { push({ ...watching, suggestion: long }) })
    expect(host.textContent).toContain('Do the remaining 38 like this (114 steps)')
    await act(async () => { push({ ...watching, suggestion: { ...long, remaining: 83, more: true, program: long.program.concat(long.program, long.program).slice(0, 249) } }) })
    expect(host.textContent).toContain('Do the next 83 like this (249 steps, the most one run does)')
    // A run stopped after 20 of 38 rows: one button continues, with a new approval from the page as it is.
    await act(async () => { push({ ...watching, suggestion: null, resume: { rows: 18 } }) })
    expect(host.textContent).toContain('The run stopped with 18 rows left. Continuing looks at the page as it is now and asks you again.')
    const button = host.querySelector('.learning-suggestion button') as HTMLButtonElement
    expect(button.textContent).toBe('Continue with the 18 rows left')
    await act(async () => { button.click() })
    expect(posted.some((message) => message.type === 'learning.watch.continue')).toBe(true)
    await act(async () => { push({ ...watching, suggestion: null, resume: null }) })
    expect(host.querySelector('.learning-suggestion')).toBeNull()
    // F7: a row the run left part-done is named and skipped; with nothing else left there is no button.
    await act(async () => { push({ ...watching, suggestion: null, resume: { rows: 17, skipped: 'Person 23' } }) })
    expect(host.textContent).toContain('The run stopped with 17 rows left. “Person 23” was left part-done and is skipped; do it by hand. Continuing looks at the page as it is now and asks you again.')
    await act(async () => { push({ ...watching, suggestion: null, resume: { rows: 0, skipped: 'Person 40' } }) })
    expect(host.textContent).toContain('The run stopped. “Person 40” was left part-done and is skipped; do it by hand.')
    expect(host.querySelector('.learning-suggestion button')).toBeNull()
    // F1: rows that cannot be told apart are offered one program at a time, and the panel says why.
    await act(async () => { push({ ...watching, resume: null, suggestion: { ...long, remaining: 8, limited: 'indistinct' as const, program: long.program.slice(0, 24) } }) })
    expect(host.textContent).toContain('Do the remaining 8 like this (24 steps)')
    expect(host.textContent).toContain('These rows can\'t be told apart, so only 25 steps at a time.')
  })
})
