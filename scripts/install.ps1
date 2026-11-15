<#
.SYNOPSIS
dsh-browser one-command install (Windows): supports both managed remote installs and local checkout installs.

.DESCRIPTION
No further configuration is required: the extension discovers local dsh automatically and authenticates with the bridge token the installer places in its directory.

This is the Windows counterpart of scripts/install.sh; both share one managed-root and install-info.json contract.

Where the files come from (same rules as install.sh):
  .\scripts\install.ps1                     inside a checkout: installs that checkout, downloads nothing
  install.ps1 [--release latest|vX.Y.Z]     on its own (or with --release): downloads that tagged release
                                            (default: the latest) and verifies it against its SHA256SUMS
                                            before unpacking or running any of it
  install.ps1 --unverified-branch <name>    development only: a branch archive, with no checksum at all
  install.ps1 --lang en|zh                  language of the output (every form above takes it)
DSH_BROWSER_VERSION and DSH_BROWSER_UNVERIFIED_BRANCH are the environment forms of the two download
options, DSH_BROWSER_LANG that of --lang. Without either, the output is Chinese when the Windows
display language is Chinese and English otherwise; one language is printed per run.
DSH_BROWSER_GITHUB_TOKEN (or an authenticated gh) is needed while the repository is private.
DSH_BROWSER_NO_LAUNCH=1 keeps the installer from opening Chrome or touching the clipboard.

The release path of this script has never been run on Windows (see RELEASING.md).
#>
# This file is UTF-8 with a BOM on purpose: Windows PowerShell 5.1 decodes a BOM-less script
# with the machine's ANSI codepage and turns every Chinese line into mojibake. The BOM is also
# why the documented one-liner downloads this file and runs it instead of piping it into
# Invoke-Expression, which chokes on a leading BOM. No param() block, for the same reason: it
# keeps the script runnable even when someone pipes it in anyway.
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is an order of magnitude slower in Windows PowerShell while it draws a progress bar.
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell picks the console codepage, which can turn Chinese text (a Chinese run,
# or a path with Chinese characters) into question marks.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$DshHomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$ManagedRoot = Join-Path $DshHomeDir 'dsh-browser'
# Same marker filename as scripts/install.sh: one managed root, one definition of "managed".
$ManagedMarker = Join-Path $ManagedRoot '.managed-by-install-sh'
# Earlier package names of this bridge (upstream and its origin); scripts/uninstall.mjs knows the same names.
$LegacyPlugins = @('@deepseek-ai/dsh-bridge-browser', '@yuxianglin/dsh-bridge-browser')
$BridgePlugin = '@natgurlain/dsh-bridge-browser'
$InstallArguments = @($args)

# >>> release-fetch
# Shared by install.ps1 and uninstall.ps1 (each must run on its own, so the block is
# duplicated; scripts/tests/release-consistency.test.mjs keeps the copies identical). It is
# the PowerShell counterpart of the release-fetch block in install.sh.
#
#   Get-VerifiedRelease -Directory <dir> -Tag <tag or ''> -Assets <names>
#
# resolves the release (the latest one when -Tag is empty), downloads SHA256SUMS and the
# named assets into <dir>, checks every asset's SHA-256 against SHA256SUMS and returns the
# resolved tag. Any failure (download error, missing SHA256SUMS, missing or duplicated line,
# digest mismatch) throws after recording its message (Chinese, English) in $script:ReleaseFailure.
# Callers must not read, unpack or run anything in <dir> before it returns. "{tag}" in an
# asset name is replaced by the resolved tag.
#
# A private repository answers anonymous requests with 404. Then the download goes through
# the GitHub API with DSH_BROWSER_GITHUB_TOKEN when that is set, or through an authenticated
# gh when one is installed. The token is only ever sent to the API host and is never printed.
$ReleaseRepository = 'natgurlain/dsh-browser-agent'
$ReleaseGitHubUrl = if ($env:DSH_BROWSER_GITHUB_URL) { $env:DSH_BROWSER_GITHUB_URL.TrimEnd('/') } else { 'https://github.com' }
$ReleaseApiUrl = if ($env:DSH_BROWSER_GITHUB_API_URL) { $env:DSH_BROWSER_GITHUB_API_URL.TrimEnd('/') } else { 'https://api.github.com' }
$ReleaseTagPattern = '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
$script:ReleaseFailure = $null

# One language per run. DSH_BROWSER_LANG=en|zh decides; otherwise Chinese when the Windows
# display language is Chinese, and English for everything else. Every message is written as
# a pair, Chinese first and English second, and exactly one of the two is printed.
$ReleaseLang = 'en'
$ReleaseLangWanted = ([string]$env:DSH_BROWSER_LANG).ToLowerInvariant()
if ($ReleaseLangWanted.StartsWith('zh')) {
  $ReleaseLang = 'zh'
} elseif (-not $ReleaseLangWanted.StartsWith('en')) {
  try { if ((Get-UICulture).Name -like 'zh*') { $ReleaseLang = 'zh' } } catch { }
}

function Get-ReleaseText {
  <# The Chinese or the English text, whichever matches the run's language. #>
  param([string]$Zh, [string]$En)
  if ($ReleaseLang -eq 'zh') { return $Zh }
  return $En
}

function Set-ReleaseLang {
  <# The --lang option: $true when the value is en or zh. Child processes inherit the choice. #>
  param([string]$Value)
  $wanted = $Value.ToLowerInvariant()
  if ($wanted -ne 'en' -and $wanted -ne 'zh') { return $false }
  $script:ReleaseLang = $wanted
  $env:DSH_BROWSER_LANG = $wanted
  return $true
}

function Stop-Release {
  param([string]$Zh, [string]$En)
  $script:ReleaseFailure = @($Zh, $En)
  throw "dsh-browser release: $(Get-ReleaseText $Zh $En)"
}

function Assert-ReleaseBase {
  param([string]$Url)
  if ($Url -match '^https://\S+$' -or $Url -match '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/\S*)?$') { return }
  Stop-Release "下载地址必须使用 HTTPS（只有本机回环地址可以使用 HTTP）：$Url" `
    "Download URLs must use HTTPS (plain HTTP is accepted for loopback only): $Url"
}

function Invoke-ReleaseRequest {
  <#
    One GET. Returns @{ Status = <HTTP status, 0 when the transfer failed>; Url = <final URL> }.
    With -OutFile the body is saved there; without it the body is discarded.
  #>
  param([string]$Uri, [string]$OutFile = '', [hashtable]$Headers = @{})

  # Windows PowerShell defaults to protocols GitHub no longer accepts.
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  try {
    if ($OutFile) {
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -Headers $Headers -UseBasicParsing | Out-Null
      return @{ Status = 200; Url = $Uri }
    }
    $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing
    $final = $Uri
    # Windows PowerShell exposes the final URL as ResponseUri, PowerShell 7 through the request message.
    if ($response.BaseResponse.ResponseUri) {
      $final = $response.BaseResponse.ResponseUri.AbsoluteUri
    } elseif ($response.BaseResponse.RequestMessage) {
      $final = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    }
    return @{ Status = [int]$response.StatusCode; Url = $final }
  } catch {
    $failed = $_.Exception.Response
    if ($failed -and $failed.StatusCode) { return @{ Status = [int]$failed.StatusCode; Url = $Uri } }
    return @{ Status = 0; Url = $Uri }
  }
}

function Invoke-ReleaseGh {
  <# Run gh quietly. Returns @{ Code = <exit code, -1 when gh is absent>; Output = <stdout and stderr> }. #>
  param([string[]]$Arguments)

  if (-not (Get-Command -Name 'gh' -ErrorAction SilentlyContinue)) { return @{ Code = -1; Output = '' } }
  # A native command's stderr becomes a terminating error while $ErrorActionPreference is Stop.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = (& gh @Arguments 2>&1 | Out-String)
    return @{ Code = $LASTEXITCODE; Output = $output.Trim() }
  } catch {
    return @{ Code = 1; Output = [string]$_ }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Get-ReleaseDigest {
  <# The digest SHA256SUMS records for $Name; stops unless there is exactly one. #>
  param([string]$Directory, [string]$Name, [string]$Tag)

  $found = @()
  foreach ($line in @(Get-Content -LiteralPath (Join-Path $Directory 'SHA256SUMS') -Encoding UTF8)) {
    $parts = @($line.Trim() -split '\s+')
    if ($parts.Count -eq 2 -and ($parts[1] -ceq $Name -or $parts[1] -ceq "*$Name")) { $found += $parts[0].ToLowerInvariant() }
  }
  if ($found.Count -ne 1 -or $found[0] -notmatch '^[0-9a-f]{64}$') {
    Stop-Release "$Tag 的 SHA256SUMS 中没有 $Name 的唯一校验值，已停止。" `
      "SHA256SUMS of $Tag has no single digest for $Name; stopping."
  }
  return $found[0]
}

function Get-VerifiedRelease {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [string]$Tag = '',
    [Parameter(Mandatory = $true)][string[]]$Assets
  )

  Assert-ReleaseBase $ReleaseGitHubUrl
  Assert-ReleaseBase $ReleaseApiUrl
  if ($Tag -and $Tag -notmatch $ReleaseTagPattern) {
    Stop-Release "不是有效的发布版本号：$Tag（示例：v0.1.5）。" "Not a release tag: $Tag (expected something like v0.1.5)."
  }
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $token = $env:DSH_BROWSER_GITHUB_TOKEN
  $wanted = if ($Tag) { $Tag } else { 'latest' }
  $mode = 'public'
  $assetUrls = @{}

  if ($token) {
    $mode = 'token'
    if ($token -notmatch '^[A-Za-z0-9_.-]+$') {
      Stop-Release "DSH_BROWSER_GITHUB_TOKEN 含有不允许的字符。" "DSH_BROWSER_GITHUB_TOKEN contains characters a GitHub token never has."
    }
    $path = if ($Tag) { "releases/tags/$Tag" } else { 'releases/latest' }
    $description = Join-Path $Directory '.release.json'
    $answer = Invoke-ReleaseRequest -Uri "$ReleaseApiUrl/repos/$ReleaseRepository/$path" -OutFile $description `
      -Headers @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' }
    if ($answer.Status -eq 401 -or $answer.Status -eq 403) {
      Stop-Release "GitHub 拒绝了 DSH_BROWSER_GITHUB_TOKEN（HTTP $($answer.Status)）。" "GitHub rejected DSH_BROWSER_GITHUB_TOKEN (HTTP $($answer.Status))."
    }
    if ($answer.Status -eq 404) {
      Stop-Release "用该 token 找不到 $ReleaseRepository 的发布版本 $wanted；请确认版本已发布且 token 可以读取该仓库。" `
        "No release $wanted of $ReleaseRepository is visible to this token; check that it is published and that the token can read the repository."
    }
    if ($answer.Status -ne 200) {
      Stop-Release "无法从 GitHub API 读取发布信息（HTTP $($answer.Status)）。" "Could not read the release from the GitHub API (HTTP $($answer.Status))."
    }
    try {
      $release = Get-Content -LiteralPath $description -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      Stop-Release "GitHub API 返回的发布信息无法解析。" "The release description from the GitHub API could not be parsed."
    }
    $Tag = [string]$release.tag_name
    foreach ($asset in @($release.assets)) { $assetUrls[[string]$asset.name] = [string]$asset.url }
    Remove-Item -LiteralPath $description -Force -ErrorAction SilentlyContinue
  } else {
    # Find the release without credentials: 404 means it is not visible anonymously.
    $releases = "$ReleaseGitHubUrl/$ReleaseRepository/releases"
    $probe = if ($Tag) { "$releases/tag/$Tag" } else { "$releases/latest" }
    $answer = Invoke-ReleaseRequest -Uri $probe
    if ($answer.Status -eq 200) {
      if (-not $Tag) {
        # /releases/latest redirects to /releases/tag/<tag>, or to /releases when there is none.
        if ($answer.Url -match '/releases/tag/([^/?#]+)$') {
          $Tag = $Matches[1]
        } else {
          Stop-Release "$ReleaseRepository 还没有发布任何版本。" "$ReleaseRepository has not published a release yet."
        }
      }
    } elseif (@(401, 403, 404) -contains $answer.Status) {
      $reachable = $false
      if ((Invoke-ReleaseGh @('auth', 'status')).Code -eq 0) {
        $mode = 'gh'
        $reachable = $true
        if (-not $Tag) {
          $viewed = Invoke-ReleaseGh @('release', 'view', '--repo', $ReleaseRepository, '--json', 'tagName', '--jq', '.tagName')
          if ($viewed.Code -eq 0) { $Tag = $viewed.Output } else { $reachable = $false }
        }
      }
      if (-not $reachable) {
        Stop-Release "无法匿名访问 $ReleaseRepository 的发布版本 $wanted：仓库是私有的，或该版本不存在。可以先运行 gh auth login，或设置 DSH_BROWSER_GITHUB_TOKEN 为可读取该仓库的 token，或者 git clone 后在 checkout 中运行 .\scripts\install.ps1。" `
          "Release $wanted of $ReleaseRepository is not reachable anonymously: the repository is private, or there is no such release. Run 'gh auth login' first, or set DSH_BROWSER_GITHUB_TOKEN to a token that can read the repository, or clone it and run .\scripts\install.ps1 from the checkout."
      }
    } else {
      Stop-Release "下载失败：无法连接 $ReleaseGitHubUrl。现有安装未被修改。" `
        "Download failed: could not reach $ReleaseGitHubUrl. The existing installation was not changed."
    }
  }
  if ($Tag -notmatch $ReleaseTagPattern) {
    Stop-Release "发布版本号无效：$Tag" "The release reports an invalid tag: $Tag"
  }

  # SHA256SUMS first, then each asset; every name goes through the same download.
  $names = @('SHA256SUMS') + @($Assets | ForEach-Object { $_.Replace('{tag}', $Tag) })
  foreach ($name in $names) {
    $target = Join-Path $Directory $name
    $status = 0
    if ($mode -eq 'public') {
      $status = (Invoke-ReleaseRequest -Uri "$ReleaseGitHubUrl/$ReleaseRepository/releases/download/$Tag/$name" -OutFile $target).Status
    } elseif ($mode -eq 'token') {
      $url = $assetUrls[$name]
      if (-not $url) {
        $status = 404
      } elseif (-not $url.StartsWith("$ReleaseApiUrl/", [System.StringComparison]::Ordinal)) {
        # The token goes to the API host only, whatever the release description says.
        $status = 0
      } else {
        $status = (Invoke-ReleaseRequest -Uri $url -OutFile $target `
            -Headers @{ Authorization = "Bearer $token"; Accept = 'application/octet-stream' }).Status
      }
    } else {
      $fetched = Invoke-ReleaseGh @('release', 'download', $Tag, '--repo', $ReleaseRepository, '--pattern', $name, '--dir', $Directory, '--clobber')
      if ($fetched.Code -eq 0 -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        $status = 200
      } elseif ($fetched.Code -eq 0 -or $fetched.Output -match 'no assets match') {
        $status = 404
      } else {
        Write-Host $fetched.Output
      }
    }

    if ($status -ne 200) {
      if ($name -eq 'SHA256SUMS' -and $status -eq 404) {
        Stop-Release "发布版本 $Tag 没有 SHA256SUMS，无法校验，已停止。" "Release $Tag has no SHA256SUMS, so nothing can be verified; stopping."
      }
      Stop-Release "下载 $name 失败（不完整或不存在）。现有安装未被修改。" `
        "Downloading $name failed (incomplete or missing). The existing installation was not changed."
    }
    if ($name -eq 'SHA256SUMS') { continue }

    $expected = Get-ReleaseDigest -Directory $Directory -Name $name -Tag $Tag
    $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Stop-Release "$name 的 SHA-256 与 SHA256SUMS 不符（期望 $expected，实际 $actual）。文件未被解压或执行。" `
        "SHA-256 mismatch for $name (expected $expected, got $actual). Nothing was unpacked or run."
    }
  }

  Write-Host (Get-ReleaseText ("已校验：{0} 的 {1} 个文件与 SHA256SUMS 一致。" -f $Tag, $Assets.Count) `
      ("Verified: {0} file(s) of {1} match SHA256SUMS." -f $Assets.Count, $Tag))
  return $Tag
}
# <<< release-fetch

# Every message exists in Chinese and in English, and a run prints one of them (see
# $ReleaseLang above). Callers pass the Chinese text first and the English text second.
function Write-Step {
  param([int]$Number, [string]$Zh, [string]$En)
  Write-Host ''
  Write-Host ("[{0}/4] {1}" -f $Number, (Get-ReleaseText $Zh $En))
}

function Write-Pair {
  param([string]$Zh, [string]$En)
  Write-Host (Get-ReleaseText $Zh $En)
}

function Stop-Install {
  param([string]$Zh, [string]$En)
  Write-Host ''
  [Console]::Error.WriteLine((Get-ReleaseText "错误：$Zh" "Error: $En"))
  exit 1
}

function Test-Workspace {
  param([string]$Candidate)

  if (-not $Candidate) { return $false }
  foreach ($relative in @(
      'package.json',
      'pnpm-lock.yaml',
      'extensions\dsh-browser\package.json',
      'packages\browser\bridge-browser\package.json',
      'scripts\install.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate $relative) -PathType Leaf)) { return $false }
  }
  return $true
}

function Get-WorkspaceRoot {
  # $PSScriptRoot is empty when the script arrives through `irm ... | iex`, which is exactly
  # the case that has to fall through to the managed install.
  if (-not $PSScriptRoot) { return $null }
  $candidate = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
  if (Test-Workspace $candidate) { return $candidate }
  return $null
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Assert-Command {
  param([string]$Name, [string]$Zh, [string]$En)
  if (-not (Test-Command $Name)) { Stop-Install $Zh $En }
}

function Test-ExcludedPath {
  param([string]$RelativePath, [hashtable]$Excluded)

  foreach ($segment in $RelativePath.Split([char]'\', [char]'/')) {
    if ($segment -and $Excluded.ContainsKey($segment)) { return $true }
  }
  return $false
}

function Get-SyncEntry {
  <#
    Walk $Root breadth-first without ever descending into an excluded directory, so a
    node_modules tree costs nothing instead of dominating the walk.
  #>
  param([string]$Root, [hashtable]$Excluded)

  $entries = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Queue[string]
  $pending.Enqueue('')

  while ($pending.Count -gt 0) {
    $relativeDir = $pending.Dequeue()
    $absoluteDir = if ($relativeDir) { Join-Path $Root $relativeDir } else { $Root }
    foreach ($child in @(Get-ChildItem -LiteralPath $absoluteDir -Force)) {
      if ($Excluded.ContainsKey($child.Name)) { continue }
      $relative = if ($relativeDir) { Join-Path $relativeDir $child.Name } else { $child.Name }
      $entries.Add([pscustomobject]@{ Relative = $relative; Item = $child })
      if ($child.PSIsContainer) { $pending.Enqueue($relative) }
    }
  }
  return $entries
}

function Sync-Directory {
  <#
    The `rsync -a --delete-after` the Unix installer relies on: copy everything across first,
    then drop whatever the source no longer has. Excluded names are skipped on both sides, so
    node_modules and the managed marker survive the purge instead of being treated as extra.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludeName = @(),
    # Copy every file even when size and timestamp match: archive timestamps are fixed per
    # release, so those two alone could miss a changed file of the same length.
    [switch]$AlwaysCopy
  )

  $sourceRoot = (Resolve-Path -LiteralPath $Source).ProviderPath.TrimEnd('\')
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  }
  $destinationRoot = (Resolve-Path -LiteralPath $Destination).ProviderPath.TrimEnd('\')

  $excluded = @{}
  foreach ($name in $ExcludeName) { $excluded[$name] = $true }

  $keep = @{}
  foreach ($entry in @(Get-SyncEntry -Root $sourceRoot -Excluded $excluded)) {
    $keep[$entry.Relative] = $true
    $target = Join-Path $destinationRoot $entry.Relative
    if ($entry.Item.PSIsContainer) {
      if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
      }
      continue
    }
    $existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if (-not $AlwaysCopy -and $existing -and -not $existing.PSIsContainer -and
        $existing.Length -eq $entry.Item.Length -and
        $existing.LastWriteTimeUtc -eq $entry.Item.LastWriteTimeUtc) {
      continue
    }
    $parent = Split-Path -Parent $target
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $entry.Item.FullName -Destination $target -Force
  }

  $stale = @(Get-SyncEntry -Root $destinationRoot -Excluded $excluded |
    Where-Object { -not $keep.ContainsKey($_.Relative) })
  # Deepest first: removing a child before its parent keeps Remove-Item off already-gone paths.
  foreach ($entry in @($stale | Sort-Object { $_.Relative.Length } -Descending)) {
    if (Test-Path -LiteralPath $entry.Item.FullName) {
      Remove-Item -LiteralPath $entry.Item.FullName -Recurse -Force
    }
  }
}

function Test-ProfileDependency {
  param([string]$Manifest, [string]$PackageName)

  if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { return $false }
  try {
    $parsed = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $false
  }
  if ($null -eq $parsed -or $null -eq $parsed.dependencies) { return $false }
  return [bool]($parsed.dependencies.PSObject.Properties.Name -contains $PackageName)
}

function Get-BrowserPath {
  <# Echoes the path to a local Chrome/Chromium executable, or $null when none is installed. #>
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $candidates.Add((Join-Path $base 'Google\Chrome\Application\chrome.exe'))
    $candidates.Add((Join-Path $base 'Google\Chrome SxS\Application\chrome.exe'))
    $candidates.Add((Join-Path $base 'Chromium\Application\chrome.exe'))
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  # Fallback: a browser installed outside those roots still registers an App Paths entry.
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    foreach ($exe in @('chrome.exe', 'chromium.exe')) {
      $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
      try {
        $registered = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
      } catch {
        continue
      }
      if ($registered -and (Test-Path -LiteralPath $registered -PathType Leaf)) { return $registered }
    }
  }
  return $null
}

function Start-ExtensionsPage {
  param([string]$BrowserPath)

  if (-not $BrowserPath) { return $false }
  try {
    # Start-Process returns as soon as the browser is launched, so the instructions below
    # print immediately even on a first run that opens a brand new window.
    Start-Process -FilePath $BrowserPath -ArgumentList 'chrome://extensions' | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Set-ClipboardText {
  param([string]$Text)

  try {
    Set-Clipboard -Value $Text -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Write-BrowserInstallHint {
  if (Test-Command 'winget') {
    Write-Pair "请手动安装：winget install --id Google.Chrome --exact" "Install it manually: winget install --id Google.Chrome --exact"
  } else {
    Write-Pair "请手动安装 Google Chrome：https://www.google.com/chrome/" "Install Google Chrome manually: https://www.google.com/chrome/"
  }
}

function Install-Browser {
  if (-not (Test-Command 'winget')) {
    Write-Pair "未找到 winget，无法自动安装。" "winget was not found, so the browser cannot be installed automatically."
    Write-BrowserInstallHint
    return
  }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & winget install --id Google.Chrome --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  } catch {
    Write-Pair "自动安装过程中出错。" "The automatic installation reported an error."
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Confirm-Browser {
  if (Get-BrowserPath) { return $true }

  Write-Pair "未检测到 Chrome/Chromium 浏览器。" "No Chrome/Chromium browser was detected."

  # Installing a browser is a surprising side effect for a one-line installer, so it stays
  # opt-in, exactly as scripts/install.sh does on Linux and macOS.
  if ($env:DSH_INSTALL_BROWSER -ne '1') {
    Write-BrowserInstallHint
    Write-Pair "安装后重新运行本脚本；或设置 DSH_INSTALL_BROWSER=1 让脚本尝试自动安装。" "Install it and rerun this script, or set DSH_INSTALL_BROWSER=1 to let the installer attempt it."
    return $false
  }

  Write-Pair "DSH_INSTALL_BROWSER=1，尝试自动安装……" "DSH_INSTALL_BROWSER=1 is set; attempting to install…"
  Install-Browser

  if (Get-BrowserPath) { return $true }
  Write-Pair "自动安装未完成，本次安装会继续，但需要你手动安装浏览器后再加载扩展。" "Automatic browser installation did not complete; continuing, but install a browser manually before loading the extension."
  return $false
}

function Invoke-Quiet {
  <# Run a build/registration command silently, and surface its output only when it fails. #>
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailZh,
    [Parameter(Mandatory = $true)][string]$FailEn
  )

  Push-Location -LiteralPath $WorkingDirectory
  # PowerShell 7.3+ turns a native command's stderr into a terminating error while
  # $ErrorActionPreference is Stop; a non-zero exit code is the signal we actually want.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = $null
  try {
    $output = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
  }
  if ($code -ne 0) {
    foreach ($line in @($output)) { Write-Host $line }
    Stop-Install $FailZh $FailEn
  }
}

function Install-BridgeToken {
  <#
  Bridge token provisioning (zero-config Chrome), kept separate from the rest of the
  installer. The helper creates ~/.dsh/ext-bridge-token in the plugin's format when it
  is missing and copies it into the installed extension, which reads it through
  chrome.runtime.getURL. Windows ignores POSIX modes, so both files are then limited
  to the current user with an explicit ACL. Must run after the dist sync.
  #>
  param([Parameter(Mandatory = $true)][string]$ExtensionDir)

  & node (Join-Path $Root 'scripts\provision-bridge-token.mjs') $DshHomeDir $ExtensionDir
  if ($LASTEXITCODE -ne 0) { Stop-Install '无法写入浏览器桥 token。' 'Could not provision the browser bridge token.' }
  foreach ($file in @((Join-Path $DshHomeDir 'ext-bridge-token'), (Join-Path $ExtensionDir 'bridge-token'))) {
    try {
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $file -AclObject $acl
    } catch {
      Write-Pair "警告：无法收紧 $file 的访问权限。" "Warning: could not restrict access to $file."
    }
  }
}

function Install-RemoteWorkspace {
  <# -Wanted: a release tag, or '' for the latest. -Branch: a branch name for the unverified development path. #>
  param([string]$Wanted = '', [string]$Branch = '')

  Assert-Command 'Expand-Archive' "当前 PowerShell 缺少 Expand-Archive；请升级到 PowerShell 5.1 或更高版本。" "This PowerShell has no Expand-Archive; upgrade to PowerShell 5.1 or newer."

  if ((Test-Path -LiteralPath $ManagedRoot -PathType Container) -and
      -not (Test-Path -LiteralPath $ManagedMarker -PathType Leaf) -and
      @(Get-ChildItem -LiteralPath $ManagedRoot -Force).Count -gt 0) {
    Stop-Install `
      "$ManagedRoot 已存在且不是脚本托管的安装目录；为避免覆盖，请移动该目录或在其中运行 .\scripts\install.ps1。" `
      "$ManagedRoot already exists and is not managed by this installer; move it or run .\scripts\install.ps1 inside it to avoid overwriting it."
  }

  $tempBase = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
  $bootstrap = Join-Path $tempBase ('dsh-browser-install-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
  $download = Join-Path $bootstrap 'download'
  $expanded = Join-Path $bootstrap 'source'
  New-Item -ItemType Directory -Path $download -Force | Out-Null

  $failure = $null
  $sourceLabel = ''
  $sourceLabelZh = ''
  try {
    if ($Branch) {
      if ($Branch -notmatch '^[A-Za-z0-9._/-]+$' -or $Branch.Contains('..')) {
        Stop-Release "不是有效的分支名：$Branch" "Not a usable branch name: $Branch"
      }
      Write-Pair "警告：正在安装 $ReleaseRepository 的 $Branch 分支。分支归档没有校验值，内容未经校验；仅用于开发。" `
        "WARNING: installing branch $Branch of $ReleaseRepository. A branch archive has no checksum and is NOT verified; use this for development only."
      Assert-ReleaseBase $ReleaseGitHubUrl
      $archive = Join-Path $download 'branch.zip'
      $answer = Invoke-ReleaseRequest -Uri "$ReleaseGitHubUrl/$ReleaseRepository/archive/refs/heads/$Branch.zip" -OutFile $archive
      if (@(401, 403, 404) -contains $answer.Status) {
        Stop-Release "无法匿名下载 $Branch 分支：仓库是私有的，或没有这个分支。请 git clone 后在 checkout 中运行 .\scripts\install.ps1。" `
          "Branch $Branch cannot be downloaded anonymously: the repository is private, or there is no such branch. Clone the repository and run .\scripts\install.ps1 from the checkout."
      }
      if ($answer.Status -ne 200) {
        Stop-Release "下载 $Branch 分支失败。现有安装未被修改。" "Downloading branch $Branch failed. The existing installation was not changed."
      }
      $sourceLabel = "branch $Branch (unverified)"
      $sourceLabelZh = "${Branch} 分支，未校验"
    } else {
      $shown = if ($Wanted) { $Wanted } else { 'latest' }
      Write-Pair "正在从 $ReleaseRepository 下载发布版本 $shown 并校验……" "Downloading release $shown of $ReleaseRepository and verifying it…"
      # Nothing below this line touches the download until Get-VerifiedRelease has verified it.
      $tag = [string](Get-VerifiedRelease -Directory $download -Tag $Wanted -Assets @('dsh-browser-source-{tag}.zip') |
          Select-Object -Last 1)
      $archive = Join-Path $download "dsh-browser-source-$tag.zip"
      $sourceLabel = "release $tag (SHA256SUMS verified)"
      $sourceLabelZh = "发布版本 ${tag}，已通过 SHA256SUMS 校验"
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $extracted = @(Get-ChildItem -LiteralPath $expanded -Directory)
    if ($extracted.Count -ne 1 -or -not (Test-Workspace $extracted[0].FullName)) {
      Stop-Release "下载内容不完整，未修改现有安装。" "The download is incomplete; the existing installation was not changed."
    }

    New-Item -ItemType Directory -Path $ManagedRoot -Force | Out-Null
    # The marker exists before the sync starts, so an interrupted sync is still a managed
    # directory the next run may repair; it names the source once the sync is complete.
    if (-not (Test-Path -LiteralPath $ManagedMarker -PathType Leaf)) {
      New-Item -ItemType File -Path $ManagedMarker -Force | Out-Null
    }
    Sync-Directory -Source $extracted[0].FullName -Destination $ManagedRoot `
      -ExcludeName @('node_modules', '.managed-by-install-sh') -AlwaysCopy
    [System.IO.File]::WriteAllText($ManagedMarker, "$sourceLabel`n", (New-Object System.Text.UTF8Encoding $false))
  } catch {
    $failure = if ($script:ReleaseFailure) {
      $script:ReleaseFailure
    } else {
      @("下载或解压安装文件失败：$($_.Exception.Message)", "Downloading or unpacking the installation files failed: $($_.Exception.Message)")
    }
  } finally {
    Remove-Item -LiteralPath $bootstrap -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($failure) { Stop-Install $failure[0] $failure[1] }

  Write-Pair "安装文件已同步到 ${ManagedRoot}（${sourceLabelZh}）。" "Installation files are ready in $ManagedRoot ($sourceLabel)."

  # Hand over to the version that was just downloaded, the way the Unix installer re-execs.
  # -ExecutionPolicy Bypass keeps a restricted machine from rejecting the freshly written file.
  $hostExe = if ($PSVersionTable.PSEdition -eq 'Core') {
    Join-Path $PSHOME 'pwsh.exe'
  } else {
    Join-Path $PSHOME 'powershell.exe'
  }
  # The second stage must install what was just unpacked, not download again.
  $env:DSH_BROWSER_BOOTSTRAPPED = '1'
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ManagedRoot 'scripts\install.ps1')
  exit $LASTEXITCODE
}

function Write-Usage {
  if ($ReleaseLang -eq 'zh') {
    Write-Host @'
用法：install.ps1 [--release latest|vX.Y.Z] [--unverified-branch <name>] [--lang en|zh]

  （不带选项，在 checkout 中）     安装当前 checkout，不下载任何文件
  （不带选项，单独运行）           等同于 --release latest
  --release latest|vX.Y.Z          下载该发布版本，按其 SHA256SUMS 校验每个文件后再安装
                                   （环境变量：DSH_BROWSER_VERSION）
  --unverified-branch <name>       仅用于开发：安装分支归档，分支归档没有校验值
                                   （环境变量：DSH_BROWSER_UNVERIFIED_BRANCH）
  --lang en|zh                     输出语言（环境变量：DSH_BROWSER_LANG）；默认在 Windows
                                   显示语言为中文时为中文，其他情况为英文

私有仓库：设置 DSH_BROWSER_GITHUB_TOKEN，或先用 gh 登录，或在 checkout 中安装。
'@
    return
  }
  Write-Host @'
Usage: install.ps1 [--release latest|vX.Y.Z] [--unverified-branch <name>] [--lang en|zh]

  (no option, inside a checkout)   install this checkout; nothing is downloaded
  (no option, standalone)          same as --release latest
  --release latest|vX.Y.Z          download that tagged release, verify every file against
                                   its SHA256SUMS, then install it (env: DSH_BROWSER_VERSION)
  --unverified-branch <name>       development only: install a branch archive, which has no
                                   checksum (env: DSH_BROWSER_UNVERIFIED_BRANCH)
  --lang en|zh                     language of the output (env: DSH_BROWSER_LANG); default:
                                   Chinese when the Windows display language is Chinese,
                                   English otherwise

Private repository: set DSH_BROWSER_GITHUB_TOKEN, or log in with gh, or install from a checkout.
'@
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Stop-Install "install.ps1 仅用于 Windows；macOS 与 Linux 请运行 scripts/install.sh。" "install.ps1 is for Windows only; run scripts/install.sh on macOS and Linux."
}

$RequestedRelease = [string]$env:DSH_BROWSER_VERSION
$RequestedBranch = [string]$env:DSH_BROWSER_UNVERIFIED_BRANCH
for ($index = 0; $index -lt $InstallArguments.Count; $index++) {
  $argument = [string]$InstallArguments[$index]
  if ($argument -eq '--release' -or $argument -eq '--unverified-branch' -or $argument -eq '--lang') {
    if ($index + 1 -ge $InstallArguments.Count) { Stop-Install "$argument 需要一个值。" "$argument needs a value." }
    $index++
    $value = [string]$InstallArguments[$index]
    if ($argument -eq '--release') {
      $RequestedRelease = $value
    } elseif ($argument -eq '--unverified-branch') {
      $RequestedBranch = $value
    } elseif (-not (Set-ReleaseLang $value)) {
      Stop-Install "--lang 只接受 en 或 zh：$value" "--lang accepts en or zh: $value"
    }
  } elseif ($argument.StartsWith('--lang=')) {
    $value = $argument.Substring('--lang='.Length)
    if (-not (Set-ReleaseLang $value)) {
      Stop-Install "--lang 只接受 en 或 zh：$value" "--lang accepts en or zh: $value"
    }
  } elseif ($argument.StartsWith('--release=')) {
    $RequestedRelease = $argument.Substring('--release='.Length)
  } elseif ($argument.StartsWith('--unverified-branch=')) {
    $RequestedBranch = $argument.Substring('--unverified-branch='.Length)
  } elseif ($argument -eq '--help' -or $argument -eq '-h') {
    Write-Usage
    exit 0
  } else {
    Write-Usage
    Stop-Install "未知参数：$argument" "Unknown option: $argument"
  }
}
if ($RequestedRelease -and $RequestedBranch) {
  Stop-Install "--release 与 --unverified-branch 不能同时使用。" "--release and --unverified-branch cannot be combined."
}
# A bare version number is accepted for the tag: 0.1.5 means v0.1.5.
if ($RequestedRelease -match '^[0-9]') { $RequestedRelease = "v$RequestedRelease" }

$Root = $null
if ($env:DSH_BROWSER_BOOTSTRAPPED -eq '1') {
  # Second stage of a download: install the files this script sits in.
  $Root = Get-WorkspaceRoot
  if (-not $Root) { Stop-Install "下载的安装文件不完整。" "The downloaded installation files are incomplete." }
} elseif ($RequestedBranch) {
  Install-RemoteWorkspace -Branch $RequestedBranch
} elseif ($RequestedRelease) {
  if ($RequestedRelease -eq 'latest') { $RequestedRelease = '' }
  Install-RemoteWorkspace -Wanted $RequestedRelease
} else {
  $Root = Get-WorkspaceRoot
  if (-not $Root) {
    Write-Pair "未检测到完整的本地 checkout，切换到免 clone 安装。" "No complete local checkout was detected; switching to the clone-free install."
    Install-RemoteWorkspace
  } elseif (-not (Test-Path -LiteralPath (Join-Path $Root '.managed-by-install-sh') -PathType Leaf)) {
    Write-Pair "从本地 checkout 安装，不下载任何文件：$Root" "Installing from this local checkout; nothing is downloaded: $Root"
  }
}

$Ext = Join-Path $Root 'extensions\dsh-browser'
$Plugin = Join-Path $Root 'packages\browser\bridge-browser'
$WebProfileDir = Join-Path $DshHomeDir 'profiles\web'
$WebProfileManifest = Join-Path $DshHomeDir 'profiles\web\package.json'
$DshCli = Join-Path $Root 'node_modules\@deepseek-ai\dsh\lib\bin.js'

Assert-Command 'pnpm' "未找到 pnpm；请先启用 Corepack 或安装 pnpm。" "pnpm was not found; enable Corepack or install pnpm first."
Assert-Command 'node' "未找到 Node.js；请先安装受支持的 Node.js 版本。" "Node.js was not found; install a supported Node.js version first."
$NodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { Stop-Install "无法读取 Node.js 版本。" "Failed to read the Node.js version." }
if ([version]$NodeVersion -lt [version]'24.9.0') {
  Stop-Install "需要 Node.js 24.9.0 或更新版本。" "Node.js 24.9.0 or newer is required."
}

Write-Step 1 "构建浏览器桥" "Build the browser bridge"
Invoke-Quiet -WorkingDirectory $Root -Command 'pnpm' -Arguments @('install', '--frozen-lockfile') `
  -FailZh "依赖安装失败。" -FailEn "Dependency installation failed."
Invoke-Quiet -WorkingDirectory $Root -Command 'pnpm' -Arguments @('--filter', $BridgePlugin, 'run', 'build') `
  -FailZh "桥插件构建失败。" -FailEn "The bridge plugin build failed."

Write-Step 2 "注册到 DSH（web profile）" "Register with DSH (web profile)"
# Initialize through dsh without forwarding a package path through cmd.exe.
if (-not (Test-Path -LiteralPath $WebProfileManifest -PathType Leaf)) {
  Invoke-Quiet -WorkingDirectory $Root -Command 'node' `
    -Arguments @($DshCli, 'plugin', '--profile', 'web', 'install') `
    -FailZh "初始化 web profile 失败。" -FailEn "Initializing the web profile failed."
}

foreach ($LegacyPlugin in $LegacyPlugins) {
  if (Test-ProfileDependency -Manifest $WebProfileManifest -PackageName $LegacyPlugin) {
    Invoke-Quiet -WorkingDirectory $WebProfileDir -Command 'pnpm' `
      -Arguments @('remove', '-w', $LegacyPlugin) `
      -FailZh "移除旧插件失败。" -FailEn "Removing the legacy plugin failed."
  }
}

# A profile-local junction keeps the link spec free of absolute Windows paths.
# This avoids cmd.exe splitting a checkout path that contains spaces.
$ProfileSourceLink = Join-Path $WebProfileDir '.dsh-browser-source'
$DesiredTarget = (Resolve-Path -LiteralPath $Plugin).ProviderPath
if (Test-Path -LiteralPath $ProfileSourceLink) {
  $SourceItem = Get-Item -LiteralPath $ProfileSourceLink -Force
  if (-not ($SourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    Stop-Install `
      "$ProfileSourceLink 已存在且不是目录联接；请移动该路径后重试。" `
      "$ProfileSourceLink exists and is not a directory junction; move it and retry."
  }
  $ExistingTarget = [System.IO.Path]::GetFullPath([string]$SourceItem.Target)
  if ($ExistingTarget -ne $DesiredTarget) {
    Remove-Item -LiteralPath $ProfileSourceLink -Force
    New-Item -ItemType Junction -Path $ProfileSourceLink -Target $DesiredTarget | Out-Null
  }
} else {
  New-Item -ItemType Junction -Path $ProfileSourceLink -Target $DesiredTarget | Out-Null
}

Invoke-Quiet -WorkingDirectory $WebProfileDir -Command 'pnpm' `
  -Arguments @('add', '-w', 'link:./.dsh-browser-source') `
  -FailZh "注册桥插件失败。" -FailEn "Registering the bridge plugin failed."

# The direct pnpm registration above bypasses dsh's bundle-roster update.
$ProfileManifest = Get-Content -LiteralPath $WebProfileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
$Bundles = @(@($ProfileManifest.dsh.profile.bundles) | Where-Object { $LegacyPlugins -notcontains $_ })
if ($Bundles -notcontains $BridgePlugin) { $Bundles += $BridgePlugin }
$ProfileManifest.dsh.profile.bundles = $Bundles
$ProfileJson = ($ProfileManifest | ConvertTo-Json -Depth 20) + "`n"
[System.IO.File]::WriteAllText(
  $WebProfileManifest,
  $ProfileJson,
  (New-Object System.Text.UTF8Encoding $false))

Write-Step 3 "构建 Chrome 扩展" "Build the Chrome extension"
Invoke-Quiet -WorkingDirectory $Root -Command 'pnpm' -Arguments @('--filter', 'dsh-browser-extension', 'run', 'build') `
  -FailZh "扩展构建失败。" -FailEn "The extension build failed."

Write-Step 4 "准备扩展并打开 Chrome" "Prepare the extension and open Chrome"
$NoLaunch = $env:DSH_BROWSER_NO_LAUNCH -eq '1'
if (-not $NoLaunch) { Confirm-Browser | Out-Null }
$DistDir = Join-Path $DshHomeDir 'browser-extension'
$IsUpdate = Test-Path -LiteralPath (Join-Path $DistDir 'manifest.json') -PathType Leaf
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
# bridge-token is not in dist: keep the existing copy so an ACL the user tightened survives.
Sync-Directory -Source (Join-Path $Ext 'dist') -Destination $DistDir -ExcludeName @('bridge-token')

$InstallMode = if (Test-Path -LiteralPath (Join-Path $Root '.managed-by-install-sh') -PathType Leaf) { 'managed' } else { 'checkout' }
& node (Join-Path $Root 'scripts\write-install-info.mjs') `
  (Join-Path $DistDir 'install-info.json') $InstallMode $Root $DshHomeDir
if ($LASTEXITCODE -ne 0) { Stop-Install '写入安装信息失败。' 'Writing install metadata failed.' }
Install-BridgeToken -ExtensionDir $DistDir

$ClipboardReady = (-not $NoLaunch) -and (Set-ClipboardText $DistDir)
$ChromeOpened = (-not $NoLaunch) -and (Start-ExtensionsPage (Get-BrowserPath))

Write-Host ''
if (-not $ChromeOpened) {
  Write-Pair "无法自动打开 Chrome，请手动打开浏览器并在地址栏输入 chrome://extensions。" "Could not open Chrome automatically; open the browser and type chrome://extensions in the address bar."
}
# PowerShell treats the typographic quotes “ ” as string delimiters, so every message that
# contains them has to use single-quoted literals or it splits into extra arguments.
if ($IsUpdate) {
  Write-Pair "检测到已有扩展目录，文件已安全更新。" "Existing extension directory detected; its files were updated safely."
  Write-Pair "打开 Google Chrome（注意不是 Edge/Firefox）：" "Open Google Chrome (not Edge/Firefox):"
  Write-Host ''
  Write-Pair "    地址栏输入 chrome://extensions" "    Type chrome://extensions in the address bar"
  Write-Host ''
  Write-Pair '如果页面上已有“dsh 浏览器助手”卡片：' 'If the “dsh Browser Assistant” card is already listed:'
  Write-Pair '  点击卡片上的“重新加载”按钮，让扩展加载新文件。' '  Click “Reload” on that card so it picks up the updated files.'
  Write-Host ''
  Write-Pair "如果没有该卡片（例如从未加载过）：" "If the card is not listed (e.g. it was never loaded):"
  Write-Pair '  打开右上角 “开发者模式”' '  Enable “Developer mode” in the upper-right corner'
  Write-Pair '  点左上角 “加载已解压的扩展程序”' '  Click “Load unpacked” in the upper-left corner'
  Write-Pair "  选择这个目录：" "  Select this directory:"
  Write-Host ("   {0}" -f $DistDir)
  Write-Host ''
  Write-Pair '出现 “dsh 浏览器助手” 卡片即成功。' 'When the “dsh Browser Assistant” card appears, it is loaded.'
} else {
  if ($ChromeOpened) {
    Write-Pair "Chrome 扩展管理页已打开，请完成以下操作：" "Chrome Extensions is open. Complete these steps:"
  } else {
    Write-Pair "请在 Chrome 扩展管理页完成以下操作：" "Complete these steps on the Chrome Extensions page:"
  }
  Write-Host ''
  Write-Pair '1. 开启右上角的“开发者模式”' '1. Enable “Developer mode” in the upper-right corner'
  Write-Pair '2. 点击“加载已解压的扩展程序”' '2. Click “Load unpacked”'
  if ($ClipboardReady) {
    Write-Pair "3. 在路径栏粘贴以下路径（已复制到剪贴板）：" "3. Paste this path into the folder picker's address bar (already copied):"
  } else {
    Write-Pair "3. 在路径栏复制并粘贴以下路径：" "3. Copy and paste this path into the folder picker's address bar:"
  }
  Write-Host ("   {0}" -f $DistDir)
}

# The same summary install.sh prints. This script registers the web profile only: it does
# not look for the DeepSeek Harness desktop app, its bundled CLI, Node or pnpm.
Write-Host ''
Write-Pair "DSH 注册结果：" "DSH targets:"
Write-Pair "• web profile：已注册" "• web profile: registered"
Write-Pair "• DeepSeek Harness 桌面应用：已跳过，Windows 安装脚本暂不注册桌面应用。" "• DeepSeek Harness desktop app: skipped, the Windows installer does not register the desktop app yet."

Write-Host ''
Write-Pair "加载完成后：" "After loading the extension:"
Write-Pair "• 点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏" "• Click the DeepSeek whale icon in the toolbar to open the side panel"
Write-Pair "• 扩展会自动发现本机 dsh，无需填写地址或 token（已放入扩展目录）" "• The extension discovers local dsh automatically; no address or token is required (it was placed in the extension directory)"
$QuotedRoot = "'" + $Root.Replace("'", "''") + "'"
Write-Pair ("• 启动固定版本：cd {0}; pnpm start" -f $QuotedRoot) ("• Start the pinned version: cd {0}; pnpm start" -f $QuotedRoot)
Write-Pair "• 或直接启动固定版本：npx @deepseek-ai/dsh@0.2.2-rc.2 web" "• Or start the pinned version directly: npx @deepseek-ai/dsh@0.2.2-rc.2 web"
Write-Pair "  注意：这样启动的是独立的 web profile，不包含 DeepSeek Harness 桌面应用里配置的模型。" "  Note: this starts the separate web profile, which has none of the models configured in the DeepSeek Harness desktop app."
Write-Host ''
Write-Pair "如果用得顺手，欢迎在 GitHub 点个 Star 支持我们：https://github.com/natgurlain/dsh-browser-agent" "If dsh-browser is useful to you, we'd appreciate a Star on GitHub: https://github.com/natgurlain/dsh-browser-agent"
