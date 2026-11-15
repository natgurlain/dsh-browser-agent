// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { checkoutBuild, stampBuild } from '../src/shared/build-stamp'
import { compareExtensionVersions, releaseTag } from '../src/panel/updates'

const build = { count: 412, commit: 'ab5fc92', dirty: false }

describe('stampBuild', () => {
  it('adds the build number and a readable name for Chrome', () => {
    expect(stampBuild({ name: 'x', version: '0.1.5' }, build, 'chrome'))
      .toEqual({ name: 'x', version: '0.1.5.412', version_name: '0.1.5 build 412 (ab5fc92)' })
  })

  it('marks a build with local changes', () => {
    expect(stampBuild({ version: '0.1.5' }, { ...build, dirty: true }, 'chrome').version_name).toBe('0.1.5 build 412 (ab5fc92, modified)')
  })

  it('gives Firefox the version part only', () => {
    expect(stampBuild({ version: '0.1.5' }, build, 'firefox')).toEqual({ version: '0.1.5.412' })
  })

  it('pads a short version to three parts first', () => {
    expect(stampBuild({ version: '1.2' }, build, 'chrome').version).toBe('1.2.0.412')
  })

  it('leaves the manifest alone without a build or with a four-part version', () => {
    expect(stampBuild({ version: '0.1.5' }, undefined, 'chrome')).toEqual({ version: '0.1.5' })
    expect(stampBuild({ version: '0.1.5.9' }, build, 'chrome')).toEqual({ version: '0.1.5.9' })
  })
})

describe('checkoutBuild', () => {
  it('reads this checkout', () => {
    const found = checkoutBuild()
    expect(found).toBeDefined()
    expect(found!.count).toBeGreaterThan(0)
    expect(found!.commit).toMatch(/^[0-9a-f]{4,40}$/)
  })

  it('is off for a release build and outside a checkout', () => {
    expect(checkoutBuild(undefined, { DSH_BROWSER_RELEASE_BUILD: '1' })).toBeUndefined()
    expect(checkoutBuild('/')).toBeUndefined()
  })
})

describe('a stamped version and releases', () => {
  it('maps to the release tag of its first three parts', () => {
    expect(releaseTag('0.1.5.412')).toBe('v0.1.5')
    expect(releaseTag('0.1.5')).toBe('v0.1.5')
  })

  it('is not older than its own release, and is older than the next one', () => {
    expect(compareExtensionVersions('0.1.5.412', '0.1.5')).toBe(1)
    expect(compareExtensionVersions('0.1.5.412', '0.1.6')).toBe(-1)
  })
})
