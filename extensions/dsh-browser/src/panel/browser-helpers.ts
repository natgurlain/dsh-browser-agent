/**
 * Small browser helpers shared by panel components.
 *
 * @module
 */

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
