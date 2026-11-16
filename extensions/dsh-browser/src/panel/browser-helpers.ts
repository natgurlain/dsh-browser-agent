/**
 * Small browser helpers shared by panel components.
 *
 * @module
 */

import { readStepLabels, STEP_LABELS_STORAGE_KEY } from '../shared/step-labels.ts'

/** Ask the browser for an optional permission (must run inside a click). */
export function requestOptionalPermission(permission: string): Promise<boolean> {
  const permissions = (globalThis as { chrome?: { permissions?: { request?: (value: { permissions: string[] }) => Promise<boolean> } } }).chrome?.permissions
  if (typeof permissions?.request !== 'function') return Promise.resolve(false)
  try {
    return Promise.resolve(permissions.request({ permissions: [permission] })).catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * The extension's step labels (shared/step-labels.ts): what each dispatched
 * call's element is called. Empty where the session store is not available.
 */
export async function storedStepLabels(): Promise<Record<string, string>> {
  try {
    const stored = await chrome.storage.session.get(STEP_LABELS_STORAGE_KEY)
    return readStepLabels(stored[STEP_LABELS_STORAGE_KEY])
  } catch {
    return {}
  }
}

/** Whether the manifest lists an optional permission. */
export function hasOptionalPermission(permission: string): boolean {
  try {
    return (chrome.runtime.getManifest().optional_permissions as readonly string[] | undefined)?.includes(permission) === true
  } catch {
    return false
  }
}

/**
 * Save text as a download. The anchor is attached while it is clicked and the
 * object URL is revoked later: revoking at once can cancel the download in
 * Firefox.
 */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}
