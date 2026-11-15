/**
 * Which DSH releases the bridge supports, and what it says on any other one.
 *
 * The evidence is `docs/dsh-matrix.md` (written by `scripts/dsh-matrix.mjs
 * --record`): `TESTED_DSH_VERSIONS` lists the releases whose row passed every
 * step. `scripts/tests/dsh-matrix.test.mjs` fails when this list, the record,
 * `engines.dsh` in package.json and the workspace default drift apart.
 *
 * DSH itself refuses a plugin whose `engines.dsh` excludes the running host
 * (unless the user granted `dsh plugin allow-version`), so the bridge normally
 * only loads inside `SUPPORTED_DSH_RANGE`. Inside that range but outside the
 * tested list (a newer release candidate, say) the bridge loads and warns.
 *
 * @module
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The release the workspace lockfile installs and the installers start. */
export const DSH_DEFAULT_VERSION = '0.2.2-rc.2'

/** Releases with an all-pass row in docs/dsh-matrix.md, oldest first. */
export const TESTED_DSH_VERSIONS: readonly string[] = ['0.2.2-rc.2']

/** `engines.dsh` in package.json: the range DSH enforces before it loads the plugin. */
export const SUPPORTED_DSH_RANGE = '^0.2.2-rc.2'

/** The range of every `@deepseek-ai/dsh-*` peer dependency in package.json. */
export const DSH_PEER_RANGE = '0.2.2-rc.2'

const DSH_HOST_PACKAGE = '@deepseek-ai/dsh'

export type DshSupport = 'tested' | 'untested' | 'unknown'

/**
 * The version of the DSH host running this process: the `@deepseek-ai/dsh`
 * package that owns the entry script. The bridge's own DSH imports are no
 * guide, because a host started elsewhere can load a bridge whose workspace
 * holds another release.
 *
 * @param entry - the process entry script; defaults to `process.argv[1]`.
 * @returns the host version, or undefined when the entry is not the DSH CLI.
 */
export function detectDshVersion(entry: string | undefined = process.argv[1]): string | undefined {
  if (entry === undefined || entry === '') return undefined
  let dir: string
  try {
    dir = dirname(realpathSync(entry))
  } catch {
    return undefined
  }
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === DSH_HOST_PACKAGE && typeof manifest.version === 'string') return manifest.version
    } catch {
      // No package.json here (or not JSON): keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Classify a host version against the tested list. */
export function dshSupport(version: string | undefined): DshSupport {
  if (version === undefined) return 'unknown'
  return TESTED_DSH_VERSIONS.includes(version) ? 'tested' : 'untested'
}

function remedy(): string {
  return `Tested DSH releases: ${TESTED_DSH_VERSIONS.join(', ')}. Start a tested one with: npx ${DSH_HOST_PACKAGE}@${DSH_DEFAULT_VERSION} web`
}

/**
 * The warning logged when the bridge loads on a host outside the tested list.
 *
 * @param version - the detected host version.
 */
export function untestedDshWarning(version: string): string {
  return `browser bridge: DSH ${version} is not a release this bridge was tested with, so browser tools may fail in ways that are not reported clearly. `
    + `${remedy()}. To add ${version} to the tested list, run \`node scripts/dsh-matrix.mjs ${version} --record\` in the dsh-browser repository.`
}

/**
 * The error thrown when the host lacks an API the bridge cannot work without.
 *
 * @param missing - the missing host capability, e.g. `Gateway wireStream`.
 * @param version - the detected host version, when known.
 */
export function unsupportedDshError(missing: string, version: string | undefined): Error {
  const host = version === undefined ? 'this DSH host' : `DSH ${version}`
  return new Error(`bridge-browser: ${host} is not supported (${missing} unavailable). ${remedy()}`)
}
