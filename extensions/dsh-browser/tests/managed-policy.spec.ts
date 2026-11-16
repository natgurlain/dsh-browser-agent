// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { applyManagedOverrides, loadManagedPolicy, parseManagedPolicy } from '../src/security/managed-policy.ts'

describe('managed policy', () => {
  it('parses forced rules and switches, ignoring junk', () => {
    const managed = parseManagedPolicy({
      siteRules: [{ pattern: 'intranet.corp', rule: 'blocked' }, { pattern: 'x', rule: 'bogus' }],
      disableDevTools: true, disableScreenshots: 'yes', allowedOrigins: ['https://*.corp.example', 'not a url'],
    })
    expect(managed).toMatchObject({
      siteRules: [{ pattern: 'intranet.corp', rule: 'blocked' }],
      disableDevTools: true, disableScreenshots: false, disableUnrestricted: false,
      allowedOrigins: ['https://*.corp.example'], active: true,
    })
    expect(parseManagedPolicy(undefined).active).toBe(false)
    // A pin that parsed to nothing still pins (fail closed).
    expect(parseManagedPolicy({ allowedOrigins: ['junk'] }).allowedOrigins).toEqual([])
  })

  it('overrides user settings: managed wins', () => {
    const managed = parseManagedPolicy({ disableDevTools: true, disableUnrestricted: true, enforceSiteDefaults: true })
    expect(applyManagedOverrides({ allowDevTools: true, unrestrictedBrowserAccess: true, siteDefaultsEnabled: false }, managed))
      .toEqual({ allowDevTools: false, unrestrictedBrowserAccess: false, siteDefaultsEnabled: true })
    expect(applyManagedOverrides({ allowDevTools: true, unrestrictedBrowserAccess: true, siteDefaultsEnabled: false }, parseManagedPolicy({})))
      .toEqual({ allowDevTools: true, unrestrictedBrowserAccess: true, siteDefaultsEnabled: false })
  })

  it('reads managed storage defensively', async () => {
    expect((await loadManagedPolicy({ get: async () => { throw new Error('no policy') } })).active).toBe(false)
    expect((await loadManagedPolicy({ get: async () => ({ disableScreenshots: true }) })).disableScreenshots).toBe(true)
    expect((await loadManagedPolicy(undefined)).active).toBe(false)
  })

  it('ships a schema naming every key the parser reads, declared in the Chrome manifest only', async () => {
    const schema = JSON.parse(await readFile(`${process.cwd()}/managed-schema.json`, 'utf8')) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties).sort()).toEqual(['allowedOrigins', 'disableAutoReview', 'disableDevTools', 'disableLocalTaintExemption', 'disableScreenshots', 'disableTrustedTaintExemption', 'disableUnrestricted', 'enforceSiteDefaults', 'siteRules'])
    const chromeManifest = JSON.parse(await readFile(`${process.cwd()}/manifest.json`, 'utf8')) as { storage?: { managed_schema?: string } }
    const firefoxManifest = JSON.parse(await readFile(`${process.cwd()}/manifest.firefox.json`, 'utf8')) as { storage?: unknown }
    expect(chromeManifest.storage?.managed_schema).toBe('managed-schema.json')
    expect(firefoxManifest.storage).toBeUndefined()
  })
})
