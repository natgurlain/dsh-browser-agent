# This file is UTF-8 with a BOM on purpose: Windows PowerShell 5.1 needs the BOM to read the Chinese text.
# dsh-browser uninstall entry point. It runs the uninstall.mjs next to it when there is one. On its own
# it downloads uninstall.mjs from a tagged release and runs it only after its SHA-256 matched
# that release's SHA256SUMS.
#
#   uninstall.ps1 [--release latest|vX.Y.Z] [uninstall.mjs options…]
#
# DSH_BROWSER_VERSION is the environment form of --release; the default is the latest release.
# The download path of this script has never been run on Windows (see RELEASING.md).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

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
# digest mismatch) throws after recording a bilingual message in $script:ReleaseFailure.
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

function Stop-Release {
  param([string]$Zh, [string]$En)
  $script:ReleaseFailure = @($Zh, $En)
  throw "dsh-browser release: $En"
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

  Write-Host ("Verified: {0} file(s) of {1} match SHA256SUMS." -f $Assets.Count, $Tag)
  Write-Host ("   已校验：{0} 的 {1} 个文件与 SHA256SUMS 一致。" -f $Tag, $Assets.Count)
  return $Tag
}
# <<< release-fetch

Get-Command node -ErrorAction Stop | Out-Null

$Wanted = [string]$env:DSH_BROWSER_VERSION
$Forwarded = @()
$Arguments = @($args)
for ($index = 0; $index -lt $Arguments.Count; $index++) {
  $argument = [string]$Arguments[$index]
  if ($argument -eq '--release' -and $index + 1 -lt $Arguments.Count) {
    $index++
    $Wanted = [string]$Arguments[$index]
  } elseif ($argument.StartsWith('--release=')) {
    $Wanted = $argument.Substring('--release='.Length)
  } else {
    $Forwarded += $argument
  }
}
if ($Wanted -eq 'latest') { $Wanted = '' }
if ($Wanted -match '^[0-9]') { $Wanted = "v$Wanted" }

$Engine = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'uninstall.mjs' } else { '' }
$DownloadDir = $null
$OriginalLocation = (Get-Location).ProviderPath
$OriginalDirectory = [System.IO.Directory]::GetCurrentDirectory()
$Result = 1
try {
  if (-not $Engine -or -not (Test-Path -LiteralPath $Engine -PathType Leaf)) {
    $DownloadDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-browser-uninstall.' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $DownloadDir | Out-Null
    # uninstall.mjs is not run unless Get-VerifiedRelease has verified it.
    $Engine = ''
    try {
      Get-VerifiedRelease -Directory $DownloadDir -Tag $Wanted -Assets @('uninstall.mjs') | Out-Null
      $Engine = Join-Path $DownloadDir 'uninstall.mjs'
    } catch {
      # Anything Get-VerifiedRelease did not explain itself is a real error: let it surface.
      if (-not $script:ReleaseFailure) { throw }
      [Console]::Error.WriteLine("Error: $($script:ReleaseFailure[1])")
      [Console]::Error.WriteLine("错误：$($script:ReleaseFailure[0])")
    }
  }

  if ($Engine) {
    # Release the current directory of both the runspace and the process.
    $ExecutionRoot = [System.IO.Path]::GetPathRoot($Engine)
    Set-Location -LiteralPath $ExecutionRoot
    [System.IO.Directory]::SetCurrentDirectory($ExecutionRoot)
    & node $Engine @Forwarded
    $Result = $LASTEXITCODE
  }
} finally {
  if (Test-Path -LiteralPath $OriginalLocation -PathType Container) {
    Set-Location -LiteralPath $OriginalLocation
  }
  if (Test-Path -LiteralPath $OriginalDirectory -PathType Container) {
    [System.IO.Directory]::SetCurrentDirectory($OriginalDirectory)
  }
  if ($DownloadDir -and (Test-Path -LiteralPath $DownloadDir)) {
    Remove-Item -LiteralPath $DownloadDir -Recurse -Force
  }
}
exit $Result
