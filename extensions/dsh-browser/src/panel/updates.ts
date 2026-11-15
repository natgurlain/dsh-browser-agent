/**
 * Release checks for the unpacked browser extension.
 *
 * Updates follow tagged GitHub releases: the check reads the latest release tag, and every
 * command offered here installs one named tag, which the installer verifies against that
 * release's SHA256SUMS before unpacking or running it. The check is deliberately read-only:
 * Chrome does not let an unpacked extension replace itself.
 */

export const RELEASE_REPOSITORY = 'natgurlain/dsh-browser-agent'

/** GitHub REST: the newest release that is neither a draft nor a prerelease. */
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`

const RELEASE_DOWNLOAD_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/download`

/** The release tag of an extension version: 0.1.5 is published as v0.1.5. */
export function releaseTag(version: string): string {
  // A build from a checkout carries a fourth part, the build number
  // (shared/build-stamp.ts); releases are tagged by the first three.
  return `v${versionParts(version).slice(0, 3).join('.')}`
}

/** URL of one asset of a tagged release (the bootstrap scripts are published as assets). */
export function releaseAssetUrl(tag: string, asset: string): string {
  return `${RELEASE_DOWNLOAD_URL}/${tag}/${asset}`
}

/**
 * Fetch the installer of one tag and have it install that same tag. The piped script itself
 * is only protected by TLS; what it downloads is checked against the release's SHA256SUMS.
 */
export function releaseInstallCommand(tag: string): string {
  return `curl --proto '=https' --tlsv1.2 -fsSL ${releaseAssetUrl(tag, 'install.sh')} | bash -s -- --release ${tag}`
}

/**
 * install.ps1 carries a UTF-8 BOM so Windows PowerShell renders its Chinese half, and a
 * leading BOM is exactly what Invoke-Expression refuses, so the file is downloaded and run.
 */
export function windowsReleaseInstallCommand(tag: string): string {
  return '$s="$env:TEMP\\dsh-install.ps1"; '
    + `irm ${releaseAssetUrl(tag, 'install.ps1')} -OutFile $s; `
    + `powershell -NoProfile -ExecutionPolicy Bypass -File $s --release ${tag}`
}

export interface ExtensionUpdateResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
}

export type ExtensionInstallInfo =
  | { mode: 'managed'; dshHome?: string }
  | { mode: 'checkout'; sourceRoot: string; dshHome?: string }
  | { mode: 'unknown' }

/** A drive-letter root (C:\dsh-browser) or a UNC share (\\host\share\dsh-browser). */
function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Installers only ever record an absolute root, so a relative one is corrupt metadata. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || isWindowsPath(value)
}

/** Parse installer-written provenance without trusting malformed local data. */
export function parseExtensionInstallInfo(value: unknown): ExtensionInstallInfo {
  if (typeof value !== 'object' || value === null) return { mode: 'unknown' }
  const info = value as { schemaVersion?: unknown; mode?: unknown; sourceRoot?: unknown; dshHome?: unknown }
  if (info.schemaVersion !== 1) return { mode: 'unknown' }
  if (info.dshHome !== undefined && (typeof info.dshHome !== 'string'
    || !isAbsolutePath(info.dshHome) || /[\u0000-\u001f]/u.test(info.dshHome))) return { mode: 'unknown' }
  const location = typeof info.dshHome === 'string' ? { dshHome: info.dshHome } : {}
  if (info.mode === 'managed') return { mode: 'managed', ...location }
  if (info.mode === 'checkout'
    && typeof info.sourceRoot === 'string'
    && isAbsolutePath(info.sourceRoot)
    && !info.sourceRoot.includes('\0')) {
    return { mode: 'checkout', sourceRoot: info.sourceRoot, ...location }
  }
  return { mode: 'unknown' }
}

/** Read install provenance from the extension package; older installs safely resolve as unknown. */
export async function readExtensionInstallInfo(
  url: string,
  request: typeof fetch = fetch,
): Promise<ExtensionInstallInfo> {
  try {
    const response = await request(url, { cache: 'no-store' })
    if (!response.ok) return { mode: 'unknown' }
    return parseExtensionInstallInfo(await response.json())
  } catch {
    return { mode: 'unknown' }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function powerShellQuote(value: string): string {
  return `'${value.replace(/['\u2018-\u201b]/gu, quote => quote + quote)}'`
}

/**
 * Re-run the installer from the exact checkout that produced this extension. The recorded
 * root already says which platform wrote it, so the command matches that shell.
 */
export function checkoutInstallCommand(sourceRoot: string): string {
  if (isWindowsPath(sourceRoot)) {
    return `cd ${powerShellQuote(sourceRoot)}; .\\scripts\\install.ps1`
  }
  return `cd ${shellQuote(sourceRoot)} && ./scripts/install.sh`
}

/**
 * The update command for a managed install: move it to the release `latestVersion`.
 *
 * When the installer recorded its home, the command runs the installer that is already on
 * disk (it came out of a verified release) and nothing is piped from the network. Older
 * installs without that record get the one-liner pinned to the same tag.
 */
export function managedInstallCommand(
  info: ExtensionInstallInfo,
  latestVersion: string,
  userAgent: string = navigator.userAgent,
): string {
  const tag = releaseTag(latestVersion)
  const windows = /windows/i.test(userAgent)
  const home = info.mode === 'managed' ? info.dshHome : undefined
  if (home === undefined) return windows ? windowsReleaseInstallCommand(tag) : releaseInstallCommand(tag)
  if (windows) {
    return `$env:DSH_HOME=${powerShellQuote(home)}; powershell -NoProfile -ExecutionPolicy Bypass -File `
      + `${powerShellQuote(`${home}\\dsh-browser\\scripts\\install.ps1`)} --release ${tag}`
  }
  return `DSH_HOME=${shellQuote(home)} bash ${shellQuote(`${home}/dsh-browser/scripts/install.sh`)} --release ${tag}`
}

function versionParts(version: string): number[] {
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('invalid extension version')
  return version.split('.').map((part) => Number(part))
}

/** Compare Chrome's one-to-four-part numeric extension versions. */
export function compareExtensionVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/**
 * Read the latest release tag and compare it with the running extension. A private
 * repository, or one without a release, answers 404 and is reported as a failed check.
 */
export async function checkForExtensionUpdate(
  currentVersion: string,
  request: typeof fetch = fetch,
): Promise<ExtensionUpdateResult> {
  versionParts(currentVersion)
  const response = await request(LATEST_RELEASE_URL, {
    cache: 'no-store',
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`latest release request failed (${response.status})`)

  const release = await response.json() as { tag_name?: unknown } | null
  const tag = release?.tag_name
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error('latest release has no version tag')
  const latestVersion = tag.slice(1)
  versionParts(latestVersion)

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareExtensionVersions(currentVersion, latestVersion) < 0,
  }
}
