/**
 * Per-install bridge client identity. The bridge keeps one connection per
 * identity, so two browsers or profiles stay connected side by side and a
 * worker restart replaces only its own previous connection. The id is random,
 * stored in `chrome.storage.local` (per profile), and carries no secret: it is
 * bound into the handshake proof with the rest of the hello caps.
 *
 * @module
 */

import type { BridgeClientIdentity } from '@natgurlain/dsh-browser-agent/src/protocol.ts'

/** `chrome.storage.local` key of the per-install client id. */
export const CLIENT_ID_STORAGE_KEY = 'dshClientId'

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/u

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** Fresh random id: 128 bits, base64url. */
export function createClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/**
 * Load (or create and persist) this install's identity.
 * @param storage - `chrome.storage.local`.
 * @param browser - the build target (`chrome` or `firefox`).
 * @returns the identity to advertise in `hello`.
 */
export async function loadClientIdentity(storage: StorageArea, browser: 'chrome' | 'firefox'): Promise<BridgeClientIdentity> {
  let stored: unknown
  try {
    stored = (await storage.get(CLIENT_ID_STORAGE_KEY))[CLIENT_ID_STORAGE_KEY]
  } catch {
    stored = undefined
  }
  if (typeof stored === 'string' && VALID_ID.test(stored)) return { id: stored, browser }
  const id = createClientId()
  // Not awaited: a slow or failed write only means the next worker picks a
  // new id (and the bridge treats it as a new client until the old
  // connection closes); it must never delay the connection itself.
  try {
    void Promise.resolve(storage.set({ [CLIENT_ID_STORAGE_KEY]: id })).catch(() => {})
  } catch { /* storage unavailable */ }
  return { id, browser }
}
