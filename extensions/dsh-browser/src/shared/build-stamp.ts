/**
 * Build number for extensions built from a git checkout.
 *
 * The manifest version (0.1.5) only changes at a release, so after pulling
 * and rebuilding nothing on the browser's extensions page showed that the
 * reloaded extension was a different build. A checkout build therefore gets a
 * fourth version part, the number of commits on HEAD, and (Chrome) a
 * `version_name` with the commit: "0.1.5 build 412 (ab5fc92)".
 *
 * Release archives have no `.git`, the store build and the release packager
 * opt out, so published builds keep the plain three-part version.
 *
 * Build-time only (Node); never imported by extension code.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'

/** What identifies one build of a checkout. */
export interface CheckoutBuild {
  /** Commits on HEAD: grows with every pull. */
  count: number
  /** Short commit hash. */
  commit: string
  /** Whether tracked files differ from that commit. */
  dirty: boolean
}

function git(args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
    return result.status === 0 ? result.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the build identity of the checkout around `cwd`, or `undefined` when
 * this is not a git checkout, git is missing, or `DSH_BROWSER_RELEASE_BUILD=1`.
 */
export function checkoutBuild(cwd: string = import.meta.dirname, env: NodeJS.ProcessEnv = process.env): CheckoutBuild | undefined {
  if (env.DSH_BROWSER_RELEASE_BUILD === '1') return undefined
  const count = Number(git(['rev-list', '--count', 'HEAD'], cwd))
  const commit = git(['rev-parse', '--short', 'HEAD'], cwd)
  if (!Number.isInteger(count) || count <= 0 || count > 65_535 || commit === undefined || !/^[0-9a-f]{4,40}$/.test(commit)) return undefined
  const status = git(['status', '--porcelain', '--untracked-files=no'], cwd)
  return { count, commit, dirty: status !== undefined && status !== '' }
}

/**
 * Add the build number to a manifest. Only a plain one-to-three-part version
 * is extended; Firefox gets the version part but no `version_name`, which it
 * does not know.
 */
export function stampBuild<T extends Record<string, unknown>>(
  manifest: T,
  build: CheckoutBuild | undefined,
  target: 'chrome' | 'firefox',
): T & { version_name?: string } {
  const version = manifest.version
  if (build === undefined || typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(version)) return manifest
  const padded = [...version.split('.'), '0', '0'].slice(0, 3).join('.')
  return {
    ...manifest,
    version: `${padded}.${build.count}`,
    ...target === 'chrome' ? { version_name: `${version} build ${build.count} (${build.commit}${build.dirty ? ', modified' : ''})` } : {},
  }
}
