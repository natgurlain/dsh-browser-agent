/**
 * Step-timeline labels that name the element a call acted on ("Click button
 * “Save settings”" instead of "Click element").
 *
 * The background builds the label from what the page reported when the call
 * was dispatched (authorization.ts `stepLabelFor`) and keeps it per bridge
 * call id in `chrome.storage.session`: memory only, gone with the browser
 * session, readable by extension pages but not by content scripts. The panel
 * joins it to a timeline step through the audit log, which pairs the bridge
 * call id with the model's tool-call id. The label never goes to the bridge,
 * the audit log, or the model.
 *
 * @module
 */

/** `chrome.storage.session` key of the labels (`Record<bridge call id, label>`). */
export const STEP_LABELS_STORAGE_KEY = 'dshStepLabels'
/** Most labels kept (oldest dropped first). */
export const MAX_STEP_LABELS = 200
/** Longest label kept: a verb, a kind, and two quoted names of 80 characters fit. */
export const MAX_STEP_LABEL_CHARS = 240

/** Read a stored label map, dropping anything that is not a short string. */
export function readStepLabels(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const labels: Record<string, string> = {}
  for (const [callId, label] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof label === 'string' && label !== '' && label.length <= MAX_STEP_LABEL_CHARS) labels[callId] = label
  }
  return labels
}

/** The map with one more label, bounded to the newest {@link MAX_STEP_LABELS}. */
export function withStepLabel(labels: Record<string, string>, callId: string, label: string): Record<string, string> {
  const entries = Object.entries(labels).filter(([id]) => id !== callId)
  entries.push([callId, label.slice(0, MAX_STEP_LABEL_CHARS)])
  return Object.fromEntries(entries.slice(-MAX_STEP_LABELS))
}

/** Where the labels are kept. */
export interface StepLabelStore {
  read(): Promise<unknown>
  write(value: Record<string, string>): Promise<void>
}

/** The background's writer: remembers labels across worker restarts, best effort. */
export class StepLabels {
  private labels: Record<string, string> | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly store: StepLabelStore) {}

  /** Remember the label of one dispatched call. Never throws; a storage failure only loses the label. */
  note(callId: string, label: string): void {
    this.chain = this.chain.then(async () => {
      this.labels ??= readStepLabels(await this.store.read().catch(() => undefined))
      this.labels = withStepLabel(this.labels, callId, label)
      await this.store.write(this.labels)
    }).catch(() => {})
  }
}
