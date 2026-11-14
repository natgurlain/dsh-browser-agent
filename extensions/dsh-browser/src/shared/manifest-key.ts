/**
 * Chrome extension identity helpers shared by the build and its tests.
 *
 * `manifest.json` carries the extension's public key (`key`), which fixes the
 * ID of every unpacked install so the bridge can pin `chrome-extension://<id>`.
 * The Chrome Web Store rejects uploads that contain `key` (it assigns its own),
 * so store packages are built from {@link storeManifest}.
 *
 * @module
 */

/**
 * Derive a Chrome extension ID from the manifest `key`: SHA-256 of the DER
 * public key, first 16 bytes, each hex digit mapped 0-f → a-p.
 * @param base64Key - the manifest's base64 SubjectPublicKeyInfo.
 * @returns the 32-letter extension ID.
 */
export async function extensionIdFromKey(base64Key: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0))
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', der))
  let id = ''
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f))
  }
  return id
}

/**
 * The manifest to upload to the Chrome Web Store: identical except for `key`.
 * @param manifest - parsed `manifest.json`.
 * @returns a copy without `key`.
 */
export function storeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { key, ...rest } = manifest
  void key
  return rest
}
