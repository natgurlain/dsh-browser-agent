/**
 * `browser_select`: choose options in native `<select>` elements and in ARIA
 * listbox/combobox widgets.
 *
 * A native select is set through the platform's own value setter and then
 * announced with bubbling `input` and `change` events, which is what
 * framework change handlers (React included) listen for. ARIA widgets have no
 * value to set: the combobox is opened like a user would, and the matching
 * option is clicked.
 *
 * @module
 */

import { querySelectorAllDeep } from './dom.ts'
import { accessibleName, clean, isVisible } from './extract.ts'

/** What the caller wants selected. Exactly one of the forms is used. */
export interface SelectRequest {
  /** Match option values first, then visible labels (multi-select takes several). */
  values?: string[]
  /** Match visible option labels only. */
  labels?: string[]
  /** Zero-based option positions. */
  indices?: number[]
}

/** Page operations the selection needs from the action layer. */
export interface SelectDeps {
  /** Dispatch a full pointer click on an element. */
  click: (el: Element) => void
  /** Wait for the page to settle after an interaction. */
  settle: () => Promise<void>
  /** Type text into an editable combobox (autocomplete filtering). */
  type: (el: HTMLInputElement | HTMLTextAreaElement, text: string) => void
}

/** Outcome of a selection, for the model-facing status line. */
export interface SelectOutcome {
  kind: 'native' | 'listbox' | 'combobox'
  /** Labels of the options that are selected afterwards. */
  selected: string[]
  /** Values of those options (native selects only). */
  values: string[]
  multiple: boolean
}

/** Failure carrying whether the caller's arguments were at fault. */
export class SelectError extends Error {
  constructor(readonly code: 'bad-args' | 'action-failed', message: string) {
    super(message)
    this.name = 'SelectError'
  }
}

function wanted(request: SelectRequest): number {
  return (request.values?.length ?? 0) + (request.labels?.length ?? 0) + (request.indices?.length ?? 0)
}

/** Validate and normalize the raw tool arguments. */
export function parseSelectRequest(args: Record<string, unknown>): SelectRequest {
  const strings = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined
    if (typeof value === 'string') return [value]
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
    throw new SelectError('bad-args', `${name} must be a string or a list of strings.`)
  }
  const values = [...strings(args.value, 'value') ?? [], ...strings(args.values, 'values') ?? []]
  const labels = strings(args.label, 'label')
  let indices: number[] | undefined
  if (args.optionIndex !== undefined) {
    const raw = Array.isArray(args.optionIndex) ? args.optionIndex : [args.optionIndex]
    if (!raw.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0)) {
      throw new SelectError('bad-args', 'optionIndex must be a non-negative integer or a list of them.')
    }
    indices = raw as number[]
  }
  const request: SelectRequest = {
    ...values.length > 0 ? { values } : {},
    ...labels !== undefined && labels.length > 0 ? { labels } : {},
    ...indices !== undefined && indices.length > 0 ? { indices } : {},
  }
  const forms = Object.keys(request).length
  if (forms === 0) throw new SelectError('bad-args', 'Provide value, values, label, or optionIndex.')
  if (forms > 1) throw new SelectError('bad-args', 'Use only one of value/values, label, or optionIndex.')
  return request
}

/** One selectable option, native or ARIA. */
interface Choice {
  element: Element
  label: string
  value: string
}

/**
 * Resolve the request against a list of options. Exact (case-insensitive)
 * matches win; a substring match is accepted only when it is unique.
 */
function pickChoices(choices: Choice[], request: SelectRequest): Choice[] {
  if (request.indices !== undefined) {
    return request.indices.map((index) => {
      const choice = choices[index]
      if (choice === undefined) throw new SelectError('action-failed', `optionIndex ${index} is out of range (${choices.length} options).`)
      return choice
    })
  }
  const byValue = request.values !== undefined
  const needles = request.values ?? request.labels ?? []
  return needles.map((needle) => {
    const target = clean(needle).toLowerCase()
    const exact = (byValue ? choices.find((choice) => choice.value.toLowerCase() === target) : undefined)
      ?? choices.find((choice) => choice.label.toLowerCase() === target)
    if (exact !== undefined) return exact
    const partial = choices.filter((choice) => choice.label.toLowerCase().includes(target))
    if (partial.length === 1) return partial[0]!
    if (partial.length > 1) {
      throw new SelectError('action-failed', `"${needle}" matches ${partial.length} options; use the exact label or value.`)
    }
    // Option labels are page text and errors bypass the page-content boundary: report counts only.
    throw new SelectError('action-failed', `No option matches "${needle}" among ${choices.length} option(s). List them with browser_snapshot { query: { role: "option" } } or browser_get_text.`)
  })
}

/** Set a native select through its value setter and fire input + change. */
function selectNative(select: HTMLSelectElement, request: SelectRequest): SelectOutcome {
  if (select.disabled) throw new SelectError('action-failed', 'The select is disabled.')
  const options = [...select.options]
  const choices = options.map((option) => ({ element: option, label: clean(option.label || option.text), value: option.value }))
  const picked = pickChoices(choices, request).map((choice) => choice.element as HTMLOptionElement)
  if (!select.multiple && picked.length > 1) {
    throw new SelectError('bad-args', 'This select accepts one option; pass a single value.')
  }
  for (const option of picked) {
    if (option.disabled) throw new SelectError('action-failed', `The requested option at position ${option.index} is disabled.`)
  }
  select.focus()
  if (select.multiple) {
    for (const option of options) option.selected = picked.includes(option)
  } else {
    // The prototype setter bypasses framework property overrides, exactly
    // like the native value write the type action uses.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')?.set
    const index = options.indexOf(picked[0]!)
    if (setter === undefined) select.selectedIndex = index
    else setter.call(select, index)
  }
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  const selected = [...select.selectedOptions]
  return {
    kind: 'native',
    selected: selected.map((option) => clean(option.label || option.text)),
    values: selected.map((option) => option.value),
    multiple: select.multiple,
  }
}

function optionChoices(listbox: Element): Choice[] {
  return querySelectorAllDeep(listbox, '[role="option"]')
    .filter((option) => isVisible(option) && option.getAttribute('aria-disabled') !== 'true')
    .map((option) => ({
      element: option,
      label: accessibleName(option),
      value: option.getAttribute('data-value') ?? option.getAttribute('value') ?? option.id,
    }))
}

/** Elements referenced by an id-list attribute, resolved in the element's tree and the document. */
function referenced(el: Element, attribute: string): Element[] {
  const ids = (el.getAttribute(attribute) ?? '').split(/\s+/).filter((id) => id !== '')
  const root = el.getRootNode() as Document | ShadowRoot
  return ids
    .map((id) => ('getElementById' in root ? root.getElementById(id) : null) ?? document.getElementById(id))
    .filter((found): found is HTMLElement => found !== null)
}

function visibleListboxes(): Element[] {
  return querySelectorAllDeep(document, '[role="listbox"]').filter(isVisible)
}

/** The popup a combobox controls: its referenced listbox, else a newly shown one. */
function popupFor(combobox: Element, before: Set<Element>): Element | undefined {
  for (const ref of [...referenced(combobox, 'aria-controls'), ...referenced(combobox, 'aria-owns')]) {
    if (ref.getAttribute('role') === 'listbox') return ref
    const inner = querySelectorAllDeep(ref, '[role="listbox"]')[0]
    if (inner !== undefined) return inner
    if (querySelectorAllDeep(ref, '[role="option"]').length > 0) return ref
  }
  const nested = querySelectorAllDeep(combobox, '[role="listbox"]').find(isVisible)
  if (nested !== undefined) return nested
  const shown = visibleListboxes()
  return shown.find((listbox) => !before.has(listbox)) ?? (shown.length === 1 ? shown[0] : undefined)
}

function selectedLabels(listbox: Element): string[] {
  return querySelectorAllDeep(listbox, '[role="option"][aria-selected="true"]').map((option) => accessibleName(option))
}

/**
 * Select options in a native select, an ARIA listbox, or an ARIA combobox.
 * @param target - the addressed element.
 * @param request - which options to select.
 * @param deps - page interaction primitives from the action layer.
 * @returns what is selected afterwards.
 */
export async function selectOptions(target: Element, request: SelectRequest, deps: SelectDeps): Promise<SelectOutcome> {
  if (target instanceof HTMLSelectElement) return selectNative(target, request)
  const nativeInside = target.querySelector('select')
  if (nativeInside !== null && target instanceof HTMLLabelElement) return selectNative(nativeInside, request)

  const role = target.getAttribute('role')
  if (role === 'listbox') {
    const multiple = target.getAttribute('aria-multiselectable') === 'true'
    if (!multiple && wanted(request) > 1) throw new SelectError('bad-args', 'This listbox accepts one option; pass a single value.')
    const picked = pickChoices(optionChoices(target), request)
    for (const choice of picked) {
      if (choice.element.getAttribute('aria-selected') === 'true') continue
      deps.click(choice.element)
      await deps.settle()
    }
    return { kind: 'listbox', selected: selectedLabels(target), values: [], multiple }
  }

  const combobox = role === 'combobox' || target.getAttribute('aria-haspopup') === 'listbox'
    ? target
    : target.closest('[role="combobox"]')
  if (combobox === null) {
    throw new SelectError('action-failed', 'The element is not a select, listbox, or combobox. Click it to open its menu, then click the option.')
  }
  if (wanted(request) > 1) throw new SelectError('bad-args', 'A combobox takes one option per call.')
  const before = new Set(visibleListboxes())
  let popup = combobox.getAttribute('aria-expanded') === 'true' ? popupFor(combobox, new Set()) : undefined
  if (popup === undefined || !isVisible(popup)) {
    deps.click(combobox)
    if (combobox instanceof HTMLElement) combobox.focus()
    await deps.settle()
    popup = popupFor(combobox, before)
  }
  const editable = combobox instanceof HTMLInputElement || combobox instanceof HTMLTextAreaElement
    ? combobox
    : combobox.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null
  const needle = request.values?.[0] ?? request.labels?.[0]
  let choices = popup === undefined ? [] : optionChoices(popup)
  let picked: Choice | undefined
  try {
    picked = choices.length === 0 ? undefined : pickChoices(choices, request)[0]
  } catch (error: unknown) {
    if (editable === null || needle === undefined) throw error
  }
  if (picked === undefined && editable !== null && needle !== undefined) {
    // Autocomplete comboboxes list options only after filtering by typed text.
    deps.type(editable, needle)
    await deps.settle()
    popup = popupFor(combobox, before) ?? popup
    choices = popup === undefined ? [] : optionChoices(popup)
    picked = pickChoices(choices, request)[0]
  }
  if (picked === undefined) {
    throw new SelectError('action-failed', 'The combobox did not show any options after it was opened.')
  }
  deps.click(picked.element)
  await deps.settle()
  const shown = editable !== null ? editable.value : clean(combobox.textContent ?? '')
  return { kind: 'combobox', selected: [shown !== '' ? shown : picked.label], values: [], multiple: false }
}
