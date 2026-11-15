// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  checkForExtensionUpdate,
  checkoutInstallCommand,
  compareExtensionVersions,
  LATEST_RELEASE_URL,
  managedInstallCommand,
  parseExtensionInstallInfo,
  readExtensionInstallInfo,
  releaseInstallCommand,
  releaseTag,
  windowsReleaseInstallCommand,
} from '../src/panel/updates.ts'

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64)'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

describe('extension update checks', () => {
  it('compares Chrome numeric versions component by component', () => {
    expect(compareExtensionVersions('0.2.0', '0.2')).toBe(0)
    expect(compareExtensionVersions('0.2.9', '0.10.0')).toBeLessThan(0)
    expect(compareExtensionVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(() => compareExtensionVersions('1.0.0-beta', '1.0.0')).toThrow('invalid extension version')
  })

  it('reports a newer latest release, read from its tag', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ tag_name: 'v0.3.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    await expect(checkForExtensionUpdate('0.2.0', request)).resolves.toEqual({
      currentVersion: '0.2.0',
      latestVersion: '0.3.0',
      updateAvailable: true,
    })
    expect(request).toHaveBeenCalledWith(LATEST_RELEASE_URL, {
      cache: 'no-store',
      headers: { accept: 'application/vnd.github+json' },
    })
  })

  it('asks GitHub for the latest release of this repository, never for a branch', () => {
    expect(LATEST_RELEASE_URL).toBe('https://api.github.com/repos/natgurlain/dsh-browser-agent/releases/latest')
  })

  it('treats equal or older releases as current', async () => {
    for (const tag of ['v0.2.0', 'v0.1.9']) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ tag_name: tag }),
        { status: 200 },
      ))
      await expect(checkForExtensionUpdate('0.2.0', request)).resolves.toMatchObject({
        latestVersion: tag.slice(1),
        updateAvailable: false,
      })
    }
  })

  it('rejects an unavailable, private or malformed latest release', async () => {
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))
    await expect(checkForExtensionUpdate('0.2.0', unavailable)).rejects.toThrow('(503)')

    // A private repository, or one with no release yet.
    const hidden = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }))
    await expect(checkForExtensionUpdate('0.2.0', hidden)).rejects.toThrow('(404)')

    for (const [body, message] of [
      [{ tag_name: 'vnext' }, 'invalid extension version'],
      [{ tag_name: 'v0.3.0-rc.1' }, 'invalid extension version'],
      [{ tag_name: '0.3.0' }, 'latest release has no version tag'],
      [{ version: '0.3.0' }, 'latest release has no version tag'],
      [null, 'latest release has no version tag'],
    ] as const) {
      const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
      await expect(checkForExtensionUpdate('0.2.0', malformed)).rejects.toThrow(message)
    }
  })

  it('distinguishes managed, checkout, and unknown install provenance', () => {
    expect(parseExtensionInstallInfo({ schemaVersion: 1, mode: 'managed' })).toEqual({ mode: 'managed' })
    expect(parseExtensionInstallInfo({
      schemaVersion: 1,
      mode: 'checkout',
      sourceRoot: '/Users/example/dsh-browser',
    })).toEqual({ mode: 'checkout', sourceRoot: '/Users/example/dsh-browser' })
    expect(parseExtensionInstallInfo({ schemaVersion: 1, mode: 'checkout', sourceRoot: '../relative' }))
      .toEqual({ mode: 'unknown' })
    expect(parseExtensionInstallInfo({ mode: 'managed' })).toEqual({ mode: 'unknown' })
  })

  it('accepts the absolute roots install.ps1 records on Windows', () => {
    expect(parseExtensionInstallInfo({
      schemaVersion: 1,
      mode: 'checkout',
      sourceRoot: 'C:\\Users\\example\\dsh-browser',
    })).toEqual({ mode: 'checkout', sourceRoot: 'C:\\Users\\example\\dsh-browser' })
    expect(parseExtensionInstallInfo({
      schemaVersion: 1,
      mode: 'checkout',
      sourceRoot: '\\\\build\\share\\dsh-browser',
    })).toEqual({ mode: 'checkout', sourceRoot: '\\\\build\\share\\dsh-browser' })
    expect(parseExtensionInstallInfo({ schemaVersion: 1, mode: 'checkout', sourceRoot: 'C:relative' }))
      .toEqual({ mode: 'unknown' })
    expect(parseExtensionInstallInfo({ schemaVersion: 1, mode: 'checkout', sourceRoot: 'dsh-browser' }))
      .toEqual({ mode: 'unknown' })
  })

  it('treats missing or malformed install metadata as unknown', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }))
    await expect(readExtensionInstallInfo('chrome-extension://id/install-info.json', missing))
      .resolves.toEqual({ mode: 'unknown' })

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('{', { status: 200 }))
    await expect(readExtensionInstallInfo('chrome-extension://id/install-info.json', malformed))
      .resolves.toEqual({ mode: 'unknown' })
  })

  it('builds a shell-safe command for the originating checkout', () => {
    expect(checkoutInstallCommand('/Users/example/My Checkout'))
      .toBe("cd '/Users/example/My Checkout' && ./scripts/install.sh")
    expect(checkoutInstallCommand("/Users/example/dev's checkout"))
      .toBe("cd '/Users/example/dev'\"'\"'s checkout' && ./scripts/install.sh")
  })

  it('builds a PowerShell command for a Windows checkout', () => {
    expect(checkoutInstallCommand('C:\\Users\\example\\My Checkout'))
      .toBe("cd 'C:\\Users\\example\\My Checkout'; .\\scripts\\install.ps1")
    expect(checkoutInstallCommand("C:\\Users\\example\\dev's checkout"))
      .toBe("cd 'C:\\Users\\example\\dev''s checkout'; .\\scripts\\install.ps1")
    expect(checkoutInstallCommand('\\\\build\\share\\dsh-browser'))
      .toBe("cd '\\\\build\\share\\dsh-browser'; .\\scripts\\install.ps1")
  })

  it('updates a managed install with the installer already on disk, pinned to the new tag', () => {
    const info = parseExtensionInstallInfo({ schemaVersion: 1, mode: 'managed', dshHome: "/Users/dev's home/.dsh" })
    for (const userAgent of [MAC, LINUX]) {
      expect(managedInstallCommand(info, '0.3.0', userAgent)).toBe(
        "DSH_HOME='/Users/dev'\"'\"'s home/.dsh' bash '/Users/dev'\"'\"'s home/.dsh/dsh-browser/scripts/install.sh' --release v0.3.0",
      )
    }
    const windows = parseExtensionInstallInfo({ schemaVersion: 1, mode: 'managed', dshHome: "C:\\Users\\dev's\\.dsh" })
    expect(managedInstallCommand(windows, '0.3.0', WINDOWS)).toBe(
      "$env:DSH_HOME='C:\\Users\\dev''s\\.dsh'; powershell -NoProfile -ExecutionPolicy Bypass -File "
      + "'C:\\Users\\dev''s\\.dsh\\dsh-browser\\scripts\\install.ps1' --release v0.3.0",
    )
  })

  it('falls back to the one-liner pinned to the same tag when the install recorded no home', () => {
    const info = parseExtensionInstallInfo({ schemaVersion: 1, mode: 'managed' })
    expect(managedInstallCommand(info, '0.3.0', MAC)).toBe(releaseInstallCommand('v0.3.0'))
    expect(managedInstallCommand(info, '0.3.0', LINUX)).toBe(
      "curl --proto '=https' --tlsv1.2 -fsSL https://github.com/natgurlain/dsh-browser-agent/releases/download/v0.3.0/install.sh"
      + ' | bash -s -- --release v0.3.0',
    )
    expect(managedInstallCommand(info, '0.3.0', WINDOWS)).toBe(windowsReleaseInstallCommand('v0.3.0'))
    expect(windowsReleaseInstallCommand('v0.3.0')).toBe(
      '$s="$env:TEMP\\dsh-install.ps1"; '
      + 'irm https://github.com/natgurlain/dsh-browser-agent/releases/download/v0.3.0/install.ps1 -OutFile $s; '
      + 'powershell -NoProfile -ExecutionPolicy Bypass -File $s --release v0.3.0',
    )
  })

  it('never offers a command that follows a branch or leaves the version open', () => {
    const commands = [
      managedInstallCommand({ mode: 'managed' }, '0.3.0', LINUX),
      managedInstallCommand({ mode: 'managed' }, '0.3.0', WINDOWS),
      managedInstallCommand({ mode: 'managed', dshHome: '/home/dev/.dsh' }, '0.3.0', LINUX),
      managedInstallCommand({ mode: 'managed', dshHome: 'C:\\dsh' }, '0.3.0', WINDOWS),
    ]
    for (const command of commands) {
      expect(command).toContain('--release v0.3.0')
      expect(command).not.toMatch(/refs\/heads|raw\.githubusercontent|\bmain\b|latest/)
    }
    expect(() => managedInstallCommand({ mode: 'managed' }, '0.3.0; rm -rf ~', LINUX)).toThrow('invalid extension version')
    expect(() => releaseTag('v0.3.0')).toThrow('invalid extension version')
  })

  it('keeps package, Chrome manifest, and update CSP metadata aligned', () => {
    const extensionRoot = process.cwd()
    const packageManifest = JSON.parse(readFileSync(`${extensionRoot}/package.json`, 'utf8')) as { version: string }
    const chromeManifest = JSON.parse(readFileSync(`${extensionRoot}/manifest.json`, 'utf8')) as {
      version: string
      content_security_policy: { extension_pages: string }
    }
    expect(packageManifest.version).toBe(chromeManifest.version)
    const connectSources = chromeManifest.content_security_policy.extension_pages.split('connect-src')[1]
    expect(connectSources).toContain(new URL(LATEST_RELEASE_URL).origin)
    expect(connectSources).not.toContain('raw.githubusercontent.com')
  })

  it('keeps the Windows installer encoded for PowerShell 5.1', () => {
    const extensionRoot = process.cwd()
    const installerPath = `${extensionRoot}/../../scripts/install.ps1`
    // Windows PowerShell 5.1 needs a BOM to read UTF-8 Chinese text correctly.
    expect(readFileSync(installerPath).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })
})
