import {
  powerShellQuote, releaseAssetUrl, releaseTag, shellQuote, type ExtensionInstallInfo,
} from './updates.ts'

/**
 * The uninstall command to show. An install that recorded its home runs the uninstaller it
 * has on disk. Anything older fetches the uninstaller published with this extension's own
 * release tag; that script downloads uninstall.mjs from the same tag and runs it only after
 * its SHA-256 matched the release's SHA256SUMS.
 */
export function uninstallCommand(
  info: ExtensionInstallInfo,
  userAgent: string = navigator.userAgent,
  version?: string,
): string {
  const home = info.mode === 'unknown' ? undefined : info.dshHome
  const windows = /windows/i.test(userAgent)
  if (home !== undefined) {
    const separator = windows ? '\\' : '/'
    const source = info.mode === 'checkout' ? info.sourceRoot : `${home}${separator}dsh-browser`
    const script = `${source}${separator}scripts${separator}uninstall.${windows ? 'ps1' : 'sh'}`
    return windows
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${powerShellQuote(script)} --home ${powerShellQuote(home)}`
      : `bash ${shellQuote(script)} --home ${shellQuote(home)}`
  }
  // Read lazily: an install with a recorded home never needs the manifest.
  const tag = releaseTag(version ?? chrome.runtime.getManifest().version)
  if (windows) {
    return '& { $ErrorActionPreference = \'Stop\'; '
      + '$d=New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) (\'dsh-browser-uninstall.\'+[Guid]::NewGuid().ToString(\'N\'))); '
      + 'try { $s=Join-Path $d.FullName \'uninstall.ps1\'; '
      + `Invoke-WebRequest -UseBasicParsing ${releaseAssetUrl(tag, 'uninstall.ps1')} -OutFile $s; `
      + `powershell -NoProfile -ExecutionPolicy Bypass -File $s --release ${tag} } `
      + 'finally { Remove-Item -LiteralPath $d.FullName -Recurse -Force } }'
  }
  return `curl --proto '=https' --tlsv1.2 -fsSL ${releaseAssetUrl(tag, 'uninstall.sh')} | bash -s -- --release ${tag}`
}
