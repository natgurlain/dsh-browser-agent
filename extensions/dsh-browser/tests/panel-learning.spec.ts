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

  it('offers "Do the remaining N like this" in both languages', async () => {
    const suggestion = { tabId: 1, origin: 'https://a.example', remaining: 3, done: 2, period: 1, program: [], labels: ['click "Invite"'] }
    const host = await mount(createElement(LearningPanel, { locale: 'zh', connected: true }))
    await act(async () => { push({ settings: { workflows: false, siteDrivers: false, siteDriverOrigins: [], watchMe: true, fixtures: false }, suggestion, watching: { tabId: 1, origin: 'https://a.example', events: 4 } }) })
    expect(host.textContent).toContain('按同样方式完成剩余 3 项')
    await act(async () => { (host.querySelector('.learning-suggestion button') as HTMLButtonElement).click() })
    expect(posted.some((message) => message.type === 'learning.watch.run')).toBe(true)
  })
})
