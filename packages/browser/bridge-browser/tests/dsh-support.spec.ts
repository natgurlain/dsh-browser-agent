import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectDshVersion,
  DSH_DEFAULT_VERSION,
  dshSupport,
  TESTED_DSH_VERSIONS,
  unsupportedDshError,
  untestedDshWarning,
} from '../src/dsh-support.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A fake installed package with a `lib/bin.js` entry; returns the entry path. */
async function fakeCli(name: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-support-'))
  dirs.push(dir)
  await mkdir(join(dir, 'lib'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }))
  await writeFile(join(dir, 'lib', 'bin.js'), '')
  return join(dir, 'lib', 'bin.js')
}

describe('detectDshVersion', () => {
  it('reads the version of the @deepseek-ai/dsh package that owns the entry script', async () => {
    expect(detectDshVersion(await fakeCli('@deepseek-ai/dsh', '0.2.2-rc.1'))).toBe('0.2.2-rc.1')
  })

  it('is undefined when the entry is not the DSH CLI', async () => {
    expect(detectDshVersion(await fakeCli('vitest', '4.0.0'))).toBeUndefined()
    expect(detectDshVersion(join(tmpdir(), 'no-such-dir', 'bin.js'))).toBeUndefined()
    expect(detectDshVersion('')).toBeUndefined()
  })
})

describe('dshSupport', () => {
  it('knows the tested releases, the workspace default among them', () => {
    expect(TESTED_DSH_VERSIONS).toContain(DSH_DEFAULT_VERSION)
    for (const version of TESTED_DSH_VERSIONS) expect(dshSupport(version)).toBe('tested')
  })

  it('treats every other release as untested and an undetected host as unknown', () => {
    expect(dshSupport('0.2.1-rc.5')).toBe('untested')
    expect(dshSupport('0.2.2')).toBe('untested')
    expect(dshSupport(undefined)).toBe('unknown')
  })
})

describe('messages', () => {
  it('names the host, the tested releases and the command that starts one', () => {
    const warning = untestedDshWarning('0.2.2-rc.9')
    expect(warning).toContain('DSH 0.2.2-rc.9 is not a release this bridge was tested with')
    expect(warning).toContain(`Tested DSH releases: ${TESTED_DSH_VERSIONS.join(', ')}`)
    expect(warning).toContain(`npx @deepseek-ai/dsh@${DSH_DEFAULT_VERSION} web`)
    expect(warning).toContain('node scripts/dsh-matrix.mjs 0.2.2-rc.9 --record')

    expect(unsupportedDshError('Gateway wireStream', '0.2.1-rc.5').message)
      .toBe(`bridge-browser: DSH 0.2.1-rc.5 is not supported (Gateway wireStream unavailable). Tested DSH releases: ${TESTED_DSH_VERSIONS.join(', ')}. Start a tested one with: npx @deepseek-ai/dsh@${DSH_DEFAULT_VERSION} web`)
    expect(unsupportedDshError('Gateway wireStream', undefined).message).toContain('this DSH host is not supported')
  })
})
