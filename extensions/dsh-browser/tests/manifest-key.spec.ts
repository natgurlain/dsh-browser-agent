// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PINNED_CHROME_EXTENSION_ID } from '@natgurlain/dsh-bridge-browser/src/protocol.ts'
import { extensionIdFromKey, storeManifest } from '../src/shared/manifest-key.ts'

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as Record<string, unknown>
}

describe('Chrome extension identity', () => {
  it('pins unpacked installs to the ID the bridge accepts', async () => {
    const manifest = await readJson('../manifest.json')
    expect(typeof manifest.key).toBe('string')
    // Drift between the manifest key and the bridge's pinned ID would lock the
    // extension out of its own bridge.
    expect(await extensionIdFromKey(manifest.key as string)).toBe(PINNED_CHROME_EXTENSION_ID)
  })

  it('derives IDs with the a-p alphabet over the first 128 bits of SHA-256', async () => {
    // A 1-byte "key" makes the mapping easy to check by hand: sha256(0x00)
    // starts 6e340b9cffb37a989ca544e6bb780a2c.
    expect(await extensionIdFromKey('AA==')).toBe('godealjmppldhkjijmkfeeogllhiakcm')
  })

  it('keeps the Firefox manifest free of a Chrome key', async () => {
    expect('key' in await readJson('../manifest.firefox.json')).toBe(false)
  })

  it('strips the key for Chrome Web Store packages and changes nothing else', async () => {
    const manifest = await readJson('../manifest.json')
    const store = storeManifest(manifest)
    expect('key' in store).toBe(false)
    expect({ ...store, key: manifest.key }).toEqual(manifest)
    // The source manifest is not mutated.
    expect(typeof manifest.key).toBe('string')
  })

  it('never ships the bridge token as a web-accessible resource', async () => {
    const manifest = await readJson('../manifest.json')
    expect(JSON.stringify(manifest.web_accessible_resources ?? [])).not.toContain('bridge-token')
  })
})
