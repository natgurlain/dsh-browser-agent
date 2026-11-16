#!/bin/bash
# shellcheck disable=SC1111 # the typographic quotes in the user-facing text are intended
# dsh-browser one-command install: supports both managed remote installs and local checkout installs.
# No further configuration is required: the extension discovers local dsh automatically and authenticates with the bridge token the installer places in its directory.
#
# Where the files come from:
#   ./scripts/install.sh                     run inside a checkout: installs that checkout, downloads nothing
#   install.sh [--release latest|vX.Y.Z]     run on its own (or with --release): downloads that tagged release
#                                            (default: the latest) and verifies it against its SHA256SUMS
#                                            before unpacking or running any of it
#   install.sh --unverified-branch <name>    development only: a branch archive, with no checksum at all
#   install.sh --lang en|zh                  language of the output (every form above takes it)
# DSH_BROWSER_VERSION and DSH_BROWSER_UNVERIFIED_BRANCH are the environment forms of the two
# download options, DSH_BROWSER_LANG that of --lang. Without either, the output is Chinese
# when the locale is Chinese and English otherwise; one language is printed per run.
# DSH_BROWSER_GITHUB_TOKEN (or an authenticated gh) is needed while the repository is
# private. DSH_BROWSER_NO_LAUNCH=1 keeps the installer from opening the browser or touching
# the clipboard.
#
# The bridge is registered with the web profile and, when the DeepSeek Harness desktop app
# is installed, with the app's own profile through the CLI bundled in the app.
# DSH_DESKTOP_APP names the app when it is not in /Applications or ~/Applications;
# DSH_DESKTOP_APP=none skips it. When node or pnpm on PATH is missing or unusable, an
# already installed one is used (the app's, or a version manager's); nothing is installed.
set -euo pipefail

# Corepack would otherwise stop and ask before downloading the pinned pnpm.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
MANAGED_ROOT="$DSH_HOME_DIR/dsh-browser"
MANAGED_MARKER="$MANAGED_ROOT/.managed-by-install-sh"
BOOTSTRAP_TMP=""

# >>> release-fetch
# Shared by install.sh and uninstall.sh. Each must work when piped into bash, so the block
# is duplicated; scripts/tests/release-consistency.test.mjs keeps the copies identical.
#
#   release_fetch <directory> <tag-or-empty> <asset>...
#
# resolves the release (the latest one when the tag is empty), downloads SHA256SUMS and the
# named assets into <directory> and checks every asset's SHA-256 against SHA256SUMS. It
# exits with a message on a download error, a missing SHA256SUMS, a missing or duplicated
# line, or a digest mismatch. Callers must not read, unpack or run anything in <directory>
# before it returns. The resolved tag is left in RELEASE_TAG; "{tag}" in an asset name is
# replaced by it.
#
# A private repository answers anonymous requests with 404. Then the download goes through
# the GitHub API with DSH_BROWSER_GITHUB_TOKEN when that is set, or through an authenticated
# `gh` when one is installed. The token is handed to curl on stdin, so it never appears in a
# process list, and it is only ever sent to the API host.
RELEASE_REPOSITORY="natgurlain/dsh-browser-agent"
RELEASE_GITHUB_URL="${DSH_BROWSER_GITHUB_URL:-https://github.com}"
RELEASE_API_URL="${DSH_BROWSER_GITHUB_API_URL:-https://api.github.com}"
RELEASE_TAG=""
RELEASE_MODE="public"
RELEASE_STATUS=""
RELEASE_EFFECTIVE_URL=""

# One language per run. DSH_BROWSER_LANG=en|zh decides; otherwise Chinese when the locale
# is Chinese (the first of LC_ALL, LC_MESSAGES and LANG that is set; on macOS, when none
# names a language, the first entry of the system language list), English for everything
# else. Every message is written as a pair, Chinese first and English second, and exactly
# one of the two is printed.
RELEASE_LANG="en"

release_detect_lang() {
  local locale=""
  case "${DSH_BROWSER_LANG:-}" in
    [zZ][hH]*)
      RELEASE_LANG="zh"
      return 0
      ;;
    [eE][nN]*) return 0 ;;
  esac
  locale="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
  case "$locale" in
    [zZ][hH]*) RELEASE_LANG="zh" ;;
    "" | C | POSIX | C.* | POSIX.*)
      if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
        # Prints a parenthesised list, one quoted language tag per line.
        locale="$(defaults read -g AppleLanguages 2>/dev/null | sed -n '2{s/[", ]//g;p;}')" || locale=""
        case "$locale" in [zZ][hH]*) RELEASE_LANG="zh" ;; esac
      fi
      ;;
  esac
  return 0
}
release_detect_lang

# release_say <Chinese> <English>: prints the one that matches the run's language.
release_say() {
  if [ "$RELEASE_LANG" = "zh" ]; then
    printf '%s\n' "$1"
  else
    printf '%s\n' "$2"
  fi
}

release_fail() {
  if [ "$RELEASE_LANG" = "zh" ]; then
    printf '\n错误：%s\n' "$1" >&2
  else
    printf '\nError: %s\n' "$2" >&2
  fi
  exit 1
}

# release_set_lang <en|zh>: the --lang option. Exported so that a second stage and
# uninstall.mjs use the same language.
release_set_lang() {
  case "$1" in
    [zZ][hH]) RELEASE_LANG="zh" ;;
    [eE][nN]) RELEASE_LANG="en" ;;
    *) release_fail "--lang 只接受 en 或 zh：$1" "--lang accepts en or zh: $1" ;;
  esac
  export DSH_BROWSER_LANG="$RELEASE_LANG"
}

release_check_base() {
  if [[ "$1" =~ ^https://[^[:space:]]+$ ]] ||
    [[ "$1" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/[^[:space:]]*)?$ ]]; then
    return 0
  fi
  release_fail \
    "下载地址必须使用 HTTPS（只有本机回环地址可以使用 HTTP）：$1" \
    "Download URLs must use HTTPS (plain HTTP is accepted for loopback only): $1"
}

# release_http <url> <output> [token] [accept]: one GET. Leaves the HTTP status in
# RELEASE_STATUS ("000" when the transfer failed, including a short body) and the final URL
# in RELEASE_EFFECTIVE_URL.
release_http() {
  local url="$1" output="$2" token="${3:-}" accept="${4:-}"
  local proto="=https" result=""
  # Only a loopback base passes release_check_base with http://.
  case "$url" in http://*) proto="=http" ;; esac
  RELEASE_STATUS="000"
  RELEASE_EFFECTIVE_URL=""
  if result="$(
    {
      if [ -n "$token" ]; then printf 'header = "Authorization: Bearer %s"\n' "$token"; fi
      if [ -n "$accept" ]; then printf 'header = "Accept: %s"\n' "$accept"; fi
    } | curl --config - --silent --show-error --location \
      --proto "$proto" --proto-redir "$proto" --retry 2 \
      --output "$output" --write-out '%{http_code} %{url_effective}' "$url"
  )"; then
    RELEASE_STATUS="${result%% *}"
    RELEASE_EFFECTIVE_URL="${result#* }"
  fi
}

release_valid_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]
}

release_gh_ready() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

# Find the release without credentials. 0: RELEASE_TAG names an existing release.
# 4: the repository or release is not visible anonymously. 5: no release is published.
# 1: the request itself failed.
release_resolve_public() {
  local releases="$RELEASE_GITHUB_URL/$RELEASE_REPOSITORY/releases"
  if [ -n "$RELEASE_TAG" ]; then
    release_http "$releases/tag/$RELEASE_TAG" /dev/null
  else
    release_http "$releases/latest" /dev/null
  fi
  case "$RELEASE_STATUS" in
    200) ;;
    401 | 403 | 404) return 4 ;;
    *) return 1 ;;
  esac
  if [ -z "$RELEASE_TAG" ]; then
    # /releases/latest redirects to /releases/tag/<tag>, or to /releases when there is none.
    case "$RELEASE_EFFECTIVE_URL" in
      */releases/tag/*) RELEASE_TAG="${RELEASE_EFFECTIVE_URL##*/releases/tag/}" ;;
      *) return 5 ;;
    esac
  fi
  return 0
}

release_resolve_token() {
  local directory="$1" token="$2" path="releases/latest"
  [[ "$token" =~ ^[A-Za-z0-9_.-]+$ ]] || release_fail \
    "DSH_BROWSER_GITHUB_TOKEN 含有不允许的字符。" \
    "DSH_BROWSER_GITHUB_TOKEN contains characters a GitHub token never has."
  command -v node >/dev/null 2>&1 || release_fail \
    "通过 token 下载需要 Node.js。" "Downloading with a token needs Node.js."
  if [ -n "$RELEASE_TAG" ]; then path="releases/tags/$RELEASE_TAG"; fi
  release_http "$RELEASE_API_URL/repos/$RELEASE_REPOSITORY/$path" "$directory/.release.json" "$token" "application/vnd.github+json"
  case "$RELEASE_STATUS" in
    200) ;;
    401 | 403) release_fail \
      "GitHub 拒绝了 DSH_BROWSER_GITHUB_TOKEN（HTTP ${RELEASE_STATUS}）。" \
      "GitHub rejected DSH_BROWSER_GITHUB_TOKEN (HTTP $RELEASE_STATUS)." ;;
    404) release_fail \
      "用该 token 找不到 $RELEASE_REPOSITORY 的发布版本 ${RELEASE_TAG:-latest}；请确认版本已发布且 token 可以读取该仓库。" \
      "No release ${RELEASE_TAG:-latest} of $RELEASE_REPOSITORY is visible to this token; check that it is published and that the token can read the repository." ;;
    *) release_fail \
      "无法从 GitHub API 读取发布信息（HTTP ${RELEASE_STATUS}）。" \
      "Could not read the release from the GitHub API (HTTP $RELEASE_STATUS)." ;;
  esac
  # One "name<TAB>url" line per asset, after the tag on the first line.
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  node -e '
    const release = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const lines = [String(release.tag_name)]
    for (const asset of release.assets ?? []) lines.push(`${asset.name}\t${asset.url}`)
    process.stdout.write(`${lines.join("\n")}\n`)
  ' "$directory/.release.json" >"$directory/.release-assets" || release_fail \
    "GitHub API 返回的发布信息无法解析。" "The release description from the GitHub API could not be parsed."
  RELEASE_TAG="$(head -n 1 "$directory/.release-assets")"
}

# release_get <directory> <name> [token]: download one asset. 0: saved. 4: the release has
# no such asset. 1: the download failed.
release_get() {
  local directory="$1" name="$2" token="${3:-}" url="" problem=""
  case "$RELEASE_MODE" in
    public)
      release_http "$RELEASE_GITHUB_URL/$RELEASE_REPOSITORY/releases/download/$RELEASE_TAG/$name" "$directory/$name"
      ;;
    token)
      url="$(awk -F '\t' -v name="$name" 'NR > 1 && $1 == name { print $2 }' "$directory/.release-assets")"
      [ -n "$url" ] || return 4
      # The token goes to the API host only, whatever the release description says.
      case "$url" in
        "$RELEASE_API_URL"/*) ;;
        *) return 1 ;;
      esac
      release_http "$url" "$directory/$name" "$token" "application/octet-stream"
      ;;
    gh)
      if problem="$(gh release download "$RELEASE_TAG" --repo "$RELEASE_REPOSITORY" --pattern "$name" --dir "$directory" --clobber 2>&1)"; then
        [ -f "$directory/$name" ] && return 0
        return 4
      fi
      case "$problem" in
        *"no assets match"*) return 4 ;;
      esac
      printf '%s\n' "$problem" >&2
      return 1
      ;;
  esac
  case "$RELEASE_STATUS" in
    200) return 0 ;;
    404) return 4 ;;
    *) return 1 ;;
  esac
}

release_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    return 1
  fi
}

release_verify() {
  local directory="$1" name="$2" expected="" actual=""
  expected="$(awk -v name="$name" 'NF == 2 && ($2 == name || $2 == "*" name) { print $1 }' "$directory/SHA256SUMS" | tr 'A-F' 'a-f')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || release_fail \
    "$RELEASE_TAG 的 SHA256SUMS 中没有 $name 的唯一校验值，已停止。" \
    "SHA256SUMS of $RELEASE_TAG has no single digest for $name; stopping."
  actual="$(release_sha256 "$directory/$name")" || release_fail \
    "未找到 sha256sum、shasum 或 openssl，无法校验下载内容。" \
    "None of sha256sum, shasum or openssl was found, so the download cannot be verified."
  if [ "$actual" != "$expected" ]; then
    release_fail \
      "$name 的 SHA-256 与 SHA256SUMS 不符（期望 ${expected}，实际 ${actual}）。文件未被解压或执行。" \
      "SHA-256 mismatch for $name (expected $expected, got $actual). Nothing was unpacked or run."
  fi
}

release_fetch() {
  local directory="$1" token="${DSH_BROWSER_GITHUB_TOKEN:-}" name="" status=0
  RELEASE_TAG="$2"
  shift 2
  command -v curl >/dev/null 2>&1 || release_fail "未找到 curl；请先安装 curl。" "curl was not found; install curl first."
  release_check_base "$RELEASE_GITHUB_URL"
  release_check_base "$RELEASE_API_URL"
  if [ -n "$RELEASE_TAG" ] && ! release_valid_tag "$RELEASE_TAG"; then
    release_fail "不是有效的发布版本号：${RELEASE_TAG}（示例：v0.1.5）。" "Not a release tag: $RELEASE_TAG (expected something like v0.1.5)."
  fi
  mkdir -p "$directory"

  if [ -n "$token" ]; then
    RELEASE_MODE="token"
    release_resolve_token "$directory" "$token"
  else
    RELEASE_MODE="public"
    release_resolve_public || status=$?
    if [ "$status" -eq 4 ] && release_gh_ready; then
      RELEASE_MODE="gh"
      status=0
      if [ -z "$RELEASE_TAG" ]; then
        RELEASE_TAG="$(gh release view --repo "$RELEASE_REPOSITORY" --json tagName --jq .tagName 2>/dev/null)" || status=4
      fi
    fi
    case "$status" in
      0) ;;
      4) release_fail \
        "无法匿名访问 $RELEASE_REPOSITORY 的发布版本 ${RELEASE_TAG:-latest}：仓库是私有的，或该版本不存在。可以先运行 gh auth login，或设置 DSH_BROWSER_GITHUB_TOKEN 为可读取该仓库的 token，或者 git clone 后在 checkout 中运行 ./scripts/install.sh。" \
        "Release ${RELEASE_TAG:-latest} of $RELEASE_REPOSITORY is not reachable anonymously: the repository is private, or there is no such release. Run 'gh auth login' first, or set DSH_BROWSER_GITHUB_TOKEN to a token that can read the repository, or clone it and run ./scripts/install.sh from the checkout." ;;
      5) release_fail \
        "$RELEASE_REPOSITORY 还没有发布任何版本。" \
        "$RELEASE_REPOSITORY has not published a release yet." ;;
      *) release_fail \
        "下载失败：无法连接 ${RELEASE_GITHUB_URL}。现有安装未被修改。" \
        "Download failed: could not reach $RELEASE_GITHUB_URL. The existing installation was not changed." ;;
    esac
  fi
  release_valid_tag "$RELEASE_TAG" || release_fail \
    "发布版本号无效：$RELEASE_TAG" "The release reports an invalid tag: $RELEASE_TAG"

  status=0
  release_get "$directory" SHA256SUMS "$token" || status=$?
  case "$status" in
    0) ;;
    4) release_fail \
      "发布版本 $RELEASE_TAG 没有 SHA256SUMS，无法校验，已停止。" \
      "Release $RELEASE_TAG has no SHA256SUMS, so nothing can be verified; stopping." ;;
    *) release_fail \
      "下载 SHA256SUMS 失败。现有安装未被修改。" \
      "Downloading SHA256SUMS failed. The existing installation was not changed." ;;
  esac

  for name in "$@"; do
    name="${name//\{tag\}/$RELEASE_TAG}"
    status=0
    release_get "$directory" "$name" "$token" || status=$?
    if [ "$status" -ne 0 ]; then
      release_fail \
        "下载 $name 失败（不完整或不存在）。现有安装未被修改。" \
        "Downloading $name failed (incomplete or missing). The existing installation was not changed."
    fi
    release_verify "$directory" "$name"
  done
  rm -f -- "$directory/.release.json" "$directory/.release-assets"
  release_say "已校验：$RELEASE_TAG 的 $# 个文件与 SHA256SUMS 一致。" "Verified: $# file(s) of $RELEASE_TAG match SHA256SUMS."
}
# <<< release-fetch

# Every message exists in Chinese and in English, and a run prints one of them (see
# RELEASE_LANG above). Callers pass the Chinese text first and the English text second.
print_step() {
  printf '\n[%s/4] ' "$1"
  release_say "$2" "$3"
}

print_pair() {
  release_say "$1" "$2"
}

fail_pair() {
  release_fail "$1" "$2"
}

# Runs a command in the checkout with its output hidden. When it fails, the end
# of that output is shown and the command's exit code is returned, so a failed
# build or dependency install is never silent.
run_logged() {
  local zh="$1" en="$2" log status=0
  shift 2
  local watcher=""
  log="$(mktemp "${TMPDIR:-/tmp}/dsh-browser-install.XXXXXX")"
  # A long step (the first dependency install downloads a few hundred MB) must
  # not look like a hang: every 15 seconds show the latest line of its output.
  (
    waited=0
    # Its stdio is detached so the sleep still running at the end holds no pipe of ours.
    while sleep 15 >/dev/null 2>&1; do
      waited=$((waited + 15))
      printf '      ... %ss: %s\n' "$waited" "$(tail -n 1 "$log" 2>/dev/null | cut -c1-100)"
    done
  ) &
  watcher=$!
  # No terminal input: a hidden prompt (Corepack asking to download pnpm, for
  # example) would otherwise wait forever on a question nobody can see.
  (cd "$ROOT" && "$@") >"$log" 2>&1 </dev/null || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  if [ "$status" -eq 0 ]; then
    rm -f "$log"
    return 0
  fi
  printf '\n' >&2
  tail -n 40 "$log" >&2
  {
    printf '\n'
    print_pair "完整输出：$log" "Full output: $log"
    printf '\n'
    print_pair "错误：${zh}（退出码 ${status}）。" "Error: $en (exit code $status)."
  } >&2
  return "$status"
}

# A build step. A failure stops the install with the command's own exit code, with one
# exception: when the Node in use is the one bundled with the DeepSeek Harness app (it can
# be Electron running as Node, which not every build tool accepts), the step is retried with
# the next usable Node the installer found.
run_quiet() {
  local status=0
  while :; do
    status=0
    run_logged "$@" || status=$?
    [ "$status" -eq 0 ] && return 0
    if [ "$NODE_FROM_APP" -eq 1 ] && activate_next_node; then
      unset -f pnpm 2>/dev/null || true
      resolve_pnpm
      print_pair "上一步使用 DeepSeek Harness 应用自带的 Node.js 执行失败，改用上面的 Node.js 重试。" "That step failed with the Node.js bundled in the DeepSeek Harness app; retrying with the Node.js named above."
      continue
    fi
    exit "$status"
  done
}

has_workspace() {
  local candidate="$1"
  [ -f "$candidate/package.json" ] &&
    [ -f "$candidate/pnpm-lock.yaml" ] &&
    [ -f "$candidate/extensions/dsh-browser/package.json" ] &&
    [ -f "$candidate/packages/browser/bridge-browser/package.json" ] &&
    [ -f "$candidate/scripts/install.sh" ]
}

workspace_root_from_script() {
  local script_path="${BASH_SOURCE[0]:-}"
  local script_dir
  local candidate

  [ -n "$script_path" ] && [ -f "$script_path" ] || return 1
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  candidate="$(cd "$script_dir/.." && pwd)"
  has_workspace "$candidate" || return 1
  printf '%s\n' "$candidate"
}

# A pnpm on PATH can be present and still not run: a version-manager shim with no version
# set for the active Node exits non-zero on every call. Use pnpm when it runs; otherwise
# define a pnpm shell function (inherited by subshells and by run_quiet) that goes through
# the pnpm bundled in the DeepSeek Harness app, or Corepack, or npx with the version
# package.json pins.
resolve_pnpm() {
  local found=0
  if command -v pnpm >/dev/null 2>&1; then
    found=1
    if pnpm --version >/dev/null 2>&1; then return 0; fi
  fi
  if [ -n "$DESKTOP_PNPM" ] && node "$DESKTOP_PNPM" --version >/dev/null 2>&1; then
    pnpm() { node "$DESKTOP_PNPM" "$@"; }
    if [ "$found" -eq 1 ]; then
      print_pair "PATH 上的 pnpm 无法在当前 Node 下运行，改用 DeepSeek Harness 应用自带的 pnpm：$DESKTOP_PNPM" "pnpm on PATH does not run with this Node; using the pnpm bundled in the DeepSeek Harness app instead: $DESKTOP_PNPM"
    else
      print_pair "未找到 pnpm，改用 DeepSeek Harness 应用自带的 pnpm：$DESKTOP_PNPM" "pnpm was not found; using the pnpm bundled in the DeepSeek Harness app instead: $DESKTOP_PNPM"
    fi
    return 0
  fi
  if corepack --version >/dev/null 2>&1; then
    pnpm() { COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"; }
    if [ "$found" -eq 1 ]; then
      print_pair "PATH 上的 pnpm 无法在当前 Node 下运行，改用 Corepack。" "pnpm on PATH does not run with this Node; using Corepack instead."
    else
      print_pair "未找到 pnpm，改用 Corepack。" "pnpm was not found; using Corepack instead."
    fi
    return 0
  fi
  if npx --version >/dev/null 2>&1; then
    PNPM_NPX_SPEC="$(node -e '
      const pinned = String(require(process.argv[1]).packageManager ?? "").split("+")[0]
      process.stdout.write(/^pnpm@[0-9A-Za-z.-]+$/.test(pinned) ? pinned : "pnpm")
    ' "$ROOT/package.json" 2>/dev/null)" || PNPM_NPX_SPEC="pnpm"
    [ -n "$PNPM_NPX_SPEC" ] || PNPM_NPX_SPEC="pnpm"
    pnpm() { npx --yes "$PNPM_NPX_SPEC" "$@"; }
    if [ "$found" -eq 1 ]; then
      print_pair "PATH 上的 pnpm 无法在当前 Node 下运行，改用 npx ${PNPM_NPX_SPEC}。" "pnpm on PATH does not run with this Node; using npx $PNPM_NPX_SPEC instead."
    else
      print_pair "未找到 pnpm，改用 npx ${PNPM_NPX_SPEC}。" "pnpm was not found; using npx $PNPM_NPX_SPEC instead."
    fi
    return 0
  fi
  if [ "$found" -eq 1 ]; then
    fail_pair "PATH 上的 pnpm 无法运行，也没有可用的 Corepack 或 npx；请先启用 Corepack 或重新安装 pnpm。" "pnpm on PATH does not run, and neither Corepack nor npx is usable; enable Corepack or reinstall pnpm first."
  fi
  fail_pair "未找到 pnpm；请先启用 Corepack 或安装 pnpm。" "pnpm was not found; enable Corepack or install pnpm first."
}

# ---- DeepSeek Harness desktop app -------------------------------------------------------
# The desktop app owns the reserved profile <DSH home>/profiles/desktop; the npm dsh CLI
# refuses that profile, the CLI bundled in the app manages it. The app also ships a Node
# and a pnpm, which the installer can borrow. Layout seen on macOS:
#   <app>/Contents/Resources/runtime/bin/node            (may be Electron running as Node)
#   <app>/Contents/Resources/runtime/cli/bin/dsh         (shell launcher of the bundled CLI)
#   <app>/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
# DSH documents the desktop app for macOS and Windows only, so on Linux it is looked for
# only when DSH_DESKTOP_APP names it. DSH_DESKTOP_APP=none turns the detection off.
DESKTOP_APP=""
DESKTOP_RUNTIME=""
DESKTOP_CLI=""
DESKTOP_PNPM=""
# absent | registered | no-profile | no-cli | rejected | failed
DESKTOP_STATUS="absent"
DESKTOP_APP_VERSION=""
DESKTOP_PLUGIN_RANGE=""
DESKTOP_RUNNING=0

first_existing() {
  local candidate
  for candidate in "$@"; do
    if [ -e "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

find_desktop_app() {
  local candidate override="${DSH_DESKTOP_APP:-}"
  if [ "$override" = "none" ]; then return 0; fi
  if [ -n "$override" ]; then
    if [ -d "$override" ]; then
      DESKTOP_APP="${override%/}"
    else
      print_pair "DSH_DESKTOP_APP 指向的目录不存在，按未安装桌面应用处理：$override" "DSH_DESKTOP_APP names a directory that does not exist; continuing as if the desktop app were not installed: $override"
      return 0
    fi
  elif is_macos; then
    for candidate in "/Applications/DeepSeek Harness.app" "$HOME/Applications/DeepSeek Harness.app"; do
      if [ -d "$candidate" ]; then
        DESKTOP_APP="$candidate"
        break
      fi
    done
  fi
  [ -n "$DESKTOP_APP" ] || return 0

  DESKTOP_RUNTIME="$(first_existing \
    "$DESKTOP_APP/Contents/Resources/runtime" \
    "$DESKTOP_APP/Resources/runtime" \
    "$DESKTOP_APP/resources/runtime")" || DESKTOP_RUNTIME=""
  [ -n "$DESKTOP_RUNTIME" ] || return 0
  DESKTOP_CLI="$(first_existing "$DESKTOP_RUNTIME/cli/bin/dsh" "$DESKTOP_RUNTIME/bin/dsh")" ||
    DESKTOP_CLI="$(find "$DESKTOP_RUNTIME" -maxdepth 5 -type f -name dsh -path '*/bin/*' 2>/dev/null | head -n 1)" ||
    DESKTOP_CLI=""
  DESKTOP_PNPM="$(first_existing \
    "$DESKTOP_RUNTIME/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
    "$DESKTOP_RUNTIME/primary-runtime/dependencies/pnpm/bin/pnpm.cjs")" ||
    DESKTOP_PNPM="$(find "$DESKTOP_RUNTIME" -maxdepth 7 -type f \( -name pnpm.mjs -o -name pnpm.cjs \) -path '*/pnpm/bin/*' 2>/dev/null | head -n 1)" ||
    DESKTOP_PNPM=""
}

# Node binaries the app may ship, most likely first; one path per line.
desktop_node_paths() {
  [ -n "$DESKTOP_RUNTIME" ] || return 0
  printf '%s\n' "$DESKTOP_RUNTIME/bin/node" "$DESKTOP_RUNTIME/node/bin/node" "$DESKTOP_RUNTIME/primary-runtime/bin/node"
  find "$DESKTOP_RUNTIME" -maxdepth 6 -name node \( -type f -o -type l \) -path '*/bin/*' 2>/dev/null || true
}

desktop_cli() {
  if [ -x "$DESKTOP_CLI" ]; then
    "$DESKTOP_CLI" "$@"
  else
    /bin/sh "$DESKTOP_CLI" "$@"
  fi
}

desktop_app_running() {
  [ -n "$DESKTOP_APP" ] || return 1
  # The main process is started by its full path below <app>/Contents/MacOS/.
  ps -axo command= 2>/dev/null |
    DSH_APP_PREFIX="$DESKTOP_APP/Contents/MacOS/" awk 'index($0, ENVIRON["DSH_APP_PREFIX"]) == 1 { found = 1 } END { exit found ? 0 : 1 }'
}

desktop_profile_has() {
  profile_has_dependency "$DSH_HOME_DIR/profiles/desktop/package.json" "$1"
}

# Shows why a bundled-CLI call failed: the command, its exit code and the end of its output.
desktop_report_failure() {
  local status="$1" log="$2"
  shift 2
  local command
  command="$(printf '%q' "$DESKTOP_CLI")$(printf ' %q' "$@")"
  {
    print_pair "   应用：$DESKTOP_APP" "   app:       $DESKTOP_APP"
    print_pair "   命令：$command" "   command:   $command"
    print_pair "   工作目录：$ROOT" "   cwd:       $ROOT"
    print_pair "   DSH 目录：$DSH_HOME_DIR" "   DSH home:  $DSH_HOME_DIR"
    print_pair "   退出码：$status" "   exit code: $status"
    print_pair "   输出（最后 20 行）：" "   output (last 20 lines):"
    tail -n 20 "$log" | sed 's/^/      /'
  } >&2
}

# Registers the bridge with the desktop profile through the app's own CLI. Nothing here
# stops the install: the web profile and the extension do not depend on it. The CLI's
# version override (allow-version --accept-risk) is never used.
register_desktop() {
  local log status=0 legacy_plugin
  [ -n "$DESKTOP_APP" ] || return 0
  if [ -z "$DESKTOP_CLI" ]; then
    DESKTOP_STATUS="no-cli"
    print_pair "找到了 DeepSeek Harness 应用，但没有找到它自带的 CLI，跳过桌面应用。应用：${DESKTOP_APP}；已查找：${DESKTOP_RUNTIME:-$DESKTOP_APP/Contents/Resources/runtime}/cli/bin/dsh" "The DeepSeek Harness app was found, but not its bundled CLI; skipping the desktop app. App: $DESKTOP_APP; looked for: ${DESKTOP_RUNTIME:-$DESKTOP_APP/Contents/Resources/runtime}/cli/bin/dsh"
    return 0
  fi
  if [ ! -d "$DSH_HOME_DIR/profiles/desktop" ]; then
    DESKTOP_STATUS="no-profile"
    print_pair "找到了 DeepSeek Harness 应用，但 $DSH_HOME_DIR/profiles/desktop 不存在：请先打开一次应用，再重新运行本安装脚本。" "The DeepSeek Harness app was found, but $DSH_HOME_DIR/profiles/desktop does not exist: open the app once, then run this installer again."
    return 0
  fi
  if desktop_app_running; then DESKTOP_RUNNING=1; fi
  print_pair "通过应用自带的 CLI 注册到 DeepSeek Harness 桌面应用：$DESKTOP_APP" "Registering with the DeepSeek Harness desktop app through its bundled CLI: $DESKTOP_APP"
  log="$(mktemp "${TMPDIR:-/tmp}/dsh-browser-install.XXXXXX")"

  for legacy_plugin in $LEGACY_PLUGINS; do
    if desktop_profile_has "$legacy_plugin"; then
      status=0
      (cd "$ROOT" && desktop_cli plugin --profile desktop remove "$legacy_plugin") >"$log" 2>&1 </dev/null || status=$?
      if [ "$status" -ne 0 ]; then
        DESKTOP_STATUS="failed"
        print_pair "警告：无法从桌面应用移除旧的桥插件 ${legacy_plugin}，桌面应用未注册。" "WARNING: could not remove the old bridge plugin $legacy_plugin from the desktop app; the desktop app was not registered." >&2
        desktop_report_failure "$status" "$log" plugin --profile desktop remove "$legacy_plugin"
        rm -f "$log"
        return 0
      fi
    fi
  done

  status=0
  (cd "$ROOT" && desktop_cli plugin --profile desktop add -w "@natgurlain/dsh-bridge-browser@link:$PLUGIN") >"$log" 2>&1 </dev/null || status=$?
  if [ "$status" -eq 0 ]; then
    DESKTOP_STATUS="registered"
    rm -f "$log"
    if [ "$DESKTOP_RUNNING" -eq 1 ]; then
      print_pair "DeepSeek Harness 正在运行：插件已写入，请退出并重新打开应用后生效。" "DeepSeek Harness is running: the plugin was added, and it takes effect after you quit and reopen the app."
    fi
    return 0
  fi

  if grep -q -E 'installation rejected|is incompatible with dsh' "$log"; then
    DESKTOP_STATUS="rejected"
    DESKTOP_APP_VERSION="$(sed -n 's/.*is incompatible with dsh \([^: ]*\):.*/\1/p' "$log" | head -n 1)"
    DESKTOP_PLUGIN_RANGE="$(sed -n 's/.*"engines\.dsh":"\([^"]*\)".*/\1/p' "$log" | head -n 1)"
    [ -n "$DESKTOP_PLUGIN_RANGE" ] || DESKTOP_PLUGIN_RANGE="$(node -e 'process.stdout.write(String(require(process.argv[1]).engines?.dsh ?? ""))' "$PLUGIN/package.json" 2>/dev/null)" || true
    [ -n "$DESKTOP_APP_VERSION" ] || DESKTOP_APP_VERSION="unknown"
    [ -n "$DESKTOP_PLUGIN_RANGE" ] || DESKTOP_PLUGIN_RANGE="unknown"
    print_pair "警告：DeepSeek Harness 应用的 DSH 版本是 ${DESKTOP_APP_VERSION}，本插件支持 ${DESKTOP_PLUGIN_RANGE}，应用拒绝了安装。请更新 DeepSeek Harness 应用，然后重新运行本安装脚本。安装会继续，web profile 不受影响。" "WARNING: the DeepSeek Harness app has DSH $DESKTOP_APP_VERSION and this plugin supports $DESKTOP_PLUGIN_RANGE, so the app rejected it. Update the DeepSeek Harness app, then run this installer again. The install continues; the web profile is not affected." >&2
  else
    DESKTOP_STATUS="failed"
    print_pair "警告：注册到 DeepSeek Harness 桌面应用失败。安装会继续完成其余步骤。" "WARNING: registering with the DeepSeek Harness desktop app failed. The install continues with the remaining steps." >&2
  fi
  desktop_report_failure "$status" "$log" plugin --profile desktop add -w "@natgurlain/dsh-bridge-browser@link:$PLUGIN"
  rm -f "$log"
  return 0
}

# ---- Node.js ------------------------------------------------------------------------------
# The build needs Node.js >= 24.9.0. When `node` on PATH is missing or older, an already
# installed one is used instead, in this order: the one bundled in the DeepSeek Harness app,
# then the newest suitable version each of asdf, nvm, fnm, volta and mise already has.
# Nothing is installed or downloaded; the chosen directory is put first on PATH for this
# process only.
NODE_CANDIDATES=""
NODE_TRIED=""
NODE_INDEX=0
NODE_FROM_APP=0
NODE_BASE_PATH="$PATH"
NODE_APP_LABEL="the DeepSeek Harness app"
if [ "$RELEASE_LANG" = "zh" ]; then NODE_APP_LABEL="DeepSeek Harness 应用"; fi

node_version_of() {
  "$1" -e 'process.stdout.write(process.versions.node)' 2>/dev/null </dev/null
}

# Echoes a sortable key for a suitable version (>= 24.9.0); fails for anything else.
node_version_key() {
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
  [ "$major" -gt 24 ] || { [ "$major" -eq 24 ] && [ "$minor" -ge 9 ]; } || return 1
  printf '%05d%05d%05d\n' "$major" "$minor" "$patch"
}

# add_node_candidates <label> <node path>...: keeps the newest suitable one of the paths.
add_node_candidates() {
  local label="$1" bin version key best="" best_key="" best_version="" unusable="did not run"
  if [ "$RELEASE_LANG" = "zh" ]; then unusable="无法运行"; fi
  shift
  for bin in "$@"; do
    [ -e "$bin" ] || continue
    version="$(node_version_of "$bin")" || version=""
    NODE_TRIED="${NODE_TRIED}   $bin (${label}): ${version:-$unusable}"$'\n'
    key="$(node_version_key "$version")" || continue
    if [ -z "$best_key" ] || [ "$key" \> "$best_key" ]; then
      best="$bin"
      best_key="$key"
      best_version="$version"
    fi
  done
  [ -n "$best" ] || return 0
  NODE_CANDIDATES="${NODE_CANDIDATES}${label}|${best_version}|${best}"$'\n'
}

collect_node_candidates() {
  local bin data="${XDG_DATA_HOME:-$HOME/.local/share}"
  while IFS= read -r bin; do
    [ -n "$bin" ] || continue
    # Each app path is its own candidate, so one that does not build can be skipped.
    case "$NODE_TRIED" in *"   $bin ("*) continue ;; esac
    add_node_candidates "$NODE_APP_LABEL" "$bin"
  done <<<"$(desktop_node_paths)"
  add_node_candidates asdf "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node
  add_node_candidates nvm "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node
  add_node_candidates fnm "${FNM_DIR:-$data/fnm}"/node-versions/*/installation/bin/node \
    "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin/node \
    "$HOME/.fnm"/node-versions/*/installation/bin/node
  add_node_candidates volta "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin/node
  add_node_candidates mise "${MISE_DATA_DIR:-$data/mise}"/installs/node/*/bin/node
}

# Switches to the next collected Node; fails when there is none left.
activate_next_node() {
  local line label version bin
  NODE_INDEX=$((NODE_INDEX + 1))
  line="$(printf '%s' "$NODE_CANDIDATES" | sed -n "${NODE_INDEX}p")"
  [ -n "$line" ] || return 1
  label="${line%%|*}"
  line="${line#*|}"
  version="${line%%|*}"
  bin="${line#*|}"
  PATH="$(dirname "$bin"):$NODE_BASE_PATH"
  export PATH
  hash -r 2>/dev/null || true
  NODE_FROM_APP=0
  if [ "$label" = "$NODE_APP_LABEL" ]; then NODE_FROM_APP=1; fi
  print_pair "PATH 上没有可用的 Node.js，改用 $label 提供的 Node.js ${version}（仅本次安装）：$bin" "No usable Node.js on PATH; using Node.js $version from $label (for this install only): $bin"
  return 0
}

# The exact command for each tool this machine has.
print_node_install_hints() {
  local any=0
  if command -v asdf >/dev/null 2>&1 || [ -d "${ASDF_DATA_DIR:-$HOME/.asdf}" ]; then
    printf '   asdf:   asdf plugin add nodejs; asdf install nodejs 24.11.0; asdf set nodejs 24.11.0\n'
    any=1
  fi
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    printf '   nvm:    nvm install 24 && nvm alias default 24\n'
    any=1
  fi
  if command -v fnm >/dev/null 2>&1; then
    printf '   fnm:    fnm install 24 && fnm default 24\n'
    any=1
  fi
  if command -v volta >/dev/null 2>&1; then
    printf '   volta:  volta install node@24\n'
    any=1
  fi
  if command -v mise >/dev/null 2>&1; then
    printf '   mise:   mise use --global node@24\n'
    any=1
  fi
  if command -v brew >/dev/null 2>&1; then
    printf '   brew:   brew install node\n'
    any=1
  fi
  if [ "$any" -eq 0 ]; then
    printf '   https://nodejs.org/en/download\n'
  fi
}

resolve_node() {
  local current="" found=0 where=""
  if command -v node >/dev/null 2>&1; then
    found=1
    current="$(node_version_of node)" || current=""
    if node_version_key "$current" >/dev/null; then return 0; fi
  fi
  collect_node_candidates
  if activate_next_node; then return 0; fi
  {
    printf '\n'
    if [ "$found" -eq 1 ]; then
      where="$(command -v node)"
      print_pair "错误：需要 Node.js 24.9.0 或更新版本；PATH 上的 node 是 ${current:-无法运行}（${where}）。" "Error: Node.js 24.9.0 or newer is required; node on PATH is ${current:-not runnable} ($where)."
    else
      print_pair "错误：未找到 Node.js；需要 24.9.0 或更新版本。" "Error: Node.js was not found; version 24.9.0 or newer is required."
    fi
    if [ -n "$NODE_TRIED" ]; then
      print_pair "同时检查了以下位置，均不可用：" "Also checked, none usable:"
      printf '%s' "$NODE_TRIED"
    fi
    print_pair "请用下面任一命令安装，然后重新运行本安装脚本：" "Install it with one of these, then run this installer again:"
    print_node_install_hints
  } >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_pair "$2" "$3"
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

has_display() {
  [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]
}

copy_to_clipboard() {
  local text="$1"

  if is_macos; then
    command -v pbcopy >/dev/null 2>&1 || return 1
    printf '%s' "$text" | pbcopy && return 0
    return 1
  fi

  # The X11/Wayland helpers need a display, and they fork a daemon that keeps owning the
  # selection; keep its stdio off the terminal so the installer's own output stays readable.
  has_display || return 1
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$text" | wl-copy >/dev/null 2>&1 && return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$text" | xclip -selection clipboard >/dev/null 2>&1 && return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    printf '%s' "$text" | xsel --clipboard --input >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Chromium browsers the extension can be loaded into, in order of preference:
#   label|extensions page|macOS app name|macOS bundle id (lower case)|Linux commands|xdg desktop-file prefix
BROWSER_TABLE='Google Chrome|chrome://extensions|Google Chrome|com.google.chrome|google-chrome google-chrome-stable|google-chrome
Google Chrome Canary|chrome://extensions|Google Chrome Canary|com.google.chrome.canary||
Chromium|chrome://extensions|Chromium|org.chromium.chromium|chromium chromium-browser|chromium
Brave|brave://extensions|Brave Browser|com.brave.browser|brave-browser brave-browser-stable brave|brave
Microsoft Edge|edge://extensions|Microsoft Edge|com.microsoft.edgemac|microsoft-edge microsoft-edge-stable|microsoft-edge
Vivaldi|vivaldi://extensions|Vivaldi|com.vivaldi.vivaldi|vivaldi vivaldi-stable|vivaldi
Arc|arc://extensions|Arc|company.thebrowser.browser||'
# What the instructions name. They stay on Chrome when no browser was detected.
BROWSER_NAME="Chrome"
BROWSER_URL="chrome://extensions"
BROWSER_TARGET=""

# Echoes the user's default browser in lower case: a bundle id on macOS, a desktop-file
# name on Linux. Empty when it cannot be read; the table order decides then.
default_browser_id() {
  if is_macos; then
    # Each handler prints LSHandlerRoleAll before LSHandlerURLScheme.
    defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null |
      awk '/LSHandlerRoleAll/ { id = $3 } /LSHandlerURLScheme = https;/ { print id; exit }' |
      tr -d '";' | tr '[:upper:]' '[:lower:]' || true
  elif command -v xdg-settings >/dev/null 2>&1; then
    xdg-settings get default-web-browser 2>/dev/null </dev/null | tr '[:upper:]' '[:lower:]' || true
  fi
}

# Echoes a launch target for one browser: on macOS an app bundle path or a LaunchServices
# app name (both accepted by `open -a`), on Linux an executable on PATH.
browser_target() {
  local app="$1" commands="$2" dir name
  if is_macos; then
    for dir in "/Applications" "$HOME/Applications"; do
      if [ -x "$dir/$app.app/Contents/MacOS/$app" ]; then
        printf '%s\n' "$dir/$app.app"
        return 0
      fi
    done
    # Apps registered with LaunchServices in non-standard locations.
    if open -Ra "$app" >/dev/null 2>&1; then
      printf '%s\n' "$app"
      return 0
    fi
    return 1
  fi
  for name in $commands; do
    if command -v "$name" >/dev/null 2>&1; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 1
}

# Sets BROWSER_TARGET, BROWSER_NAME and BROWSER_URL to the default browser when it is one
# of the installed Chromium browsers, otherwise to the first installed one in table order.
detect_browser() {
  local wanted label url app id commands xdg target is_default
  wanted="$(default_browser_id)" || wanted=""
  BROWSER_TARGET=""
  while IFS='|' read -r label url app id commands xdg; do
    target="$(browser_target "$app" "$commands")" || continue
    is_default=0
    if [ -n "$wanted" ]; then
      if is_macos; then
        if [ "$wanted" = "$id" ]; then is_default=1; fi
      elif [ -n "$xdg" ]; then
        case "$wanted" in "$xdg"*) is_default=1 ;; esac
      fi
    fi
    if [ -z "$BROWSER_TARGET" ] || [ "$is_default" -eq 1 ]; then
      BROWSER_TARGET="$target"
      BROWSER_NAME="$label"
      BROWSER_URL="$url"
    fi
    if [ "$is_default" -eq 1 ]; then break; fi
  done <<<"$BROWSER_TABLE"
  [ -n "$BROWSER_TARGET" ]
}

open_browser_extensions() {
  # Every Chromium browser accepts chrome://extensions and shows its own page for it.
  local url="chrome://extensions"
  local target="$BROWSER_TARGET"
  local pid

  if is_macos; then
    if [ -n "$target" ]; then
      # `open -a <app> chrome://…` is refused by LaunchServices for some
      # browsers (seen with Brave: no handler is registered for the scheme), so
      # ask the browser itself first. Its name is the bundle name without ".app".
      local app_name="${target##*/}"
      app_name="${app_name%.app}"
      if command -v osascript >/dev/null 2>&1 &&
        osascript \
          -e 'on run argv' \
          -e 'tell application (item 1 of argv)' \
          -e 'open location (item 2 of argv)' \
          -e 'activate' \
          -e 'end tell' \
          -e 'end run' "$app_name" "$url" >/dev/null 2>&1; then
        return 0
      fi
      open -a "$target" "$url" >/dev/null 2>&1 && return 0
      return 1
    fi
    open -b com.google.Chrome "$url" >/dev/null 2>&1 && return 0
    return 1
  fi

  has_display || return 1
  if [ -n "$target" ]; then
    # Launch detached: a first run starts a foreground browser process that would otherwise
    # block the installer until the user quits it.
    "$target" "$url" >/dev/null 2>&1 </dev/null &
    pid=$!
    # Forwarding the URL to a running instance exits almost immediately; a fresh window keeps
    # running. Wait briefly so a browser that fails to start is reported as such.
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    wait "$pid" && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 </dev/null && return 0
  fi
  return 1
}

print_browser_install_hint() {
  if is_macos; then
    if command -v brew >/dev/null 2>&1; then
      print_pair "请手动安装：brew install --cask google-chrome" "Install it manually: brew install --cask google-chrome"
    else
      print_pair "请手动安装 Google Chrome：https://www.google.com/chrome/" "Install Google Chrome manually: https://www.google.com/chrome/"
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    print_pair "请手动安装：sudo apt-get update && sudo apt-get install -y chromium-browser（或 chromium）" "Install it manually: sudo apt-get update && sudo apt-get install -y chromium-browser (or chromium)"
  elif command -v dnf >/dev/null 2>&1; then
    print_pair "请手动安装：sudo dnf install -y chromium" "Install it manually: sudo dnf install -y chromium"
  elif command -v yum >/dev/null 2>&1; then
    print_pair "请手动安装：sudo yum install -y chromium" "Install it manually: sudo yum install -y chromium"
  elif command -v zypper >/dev/null 2>&1; then
    print_pair "请手动安装：sudo zypper --non-interactive install chromium" "Install it manually: sudo zypper --non-interactive install chromium"
  elif command -v pacman >/dev/null 2>&1; then
    print_pair "请手动安装：sudo pacman -S --noconfirm chromium" "Install it manually: sudo pacman -S --noconfirm chromium"
  else
    print_pair "未找到可用的软件包管理器，请手动安装 Chrome 或 Chromium。" "No supported package manager was found; install Chrome or Chromium manually."
  fi
}

install_browser() {
  local sudo_cmd=""

  if is_macos; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask google-chrome || true
    else
      print_browser_install_hint
    fi
    return 0
  fi

  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      print_pair "需要管理员权限才能安装浏览器。" "Administrator rights are required to install a browser."
      print_browser_install_hint
      return 0
    fi
  fi

  if command -v apt-get >/dev/null 2>&1; then
    $sudo_cmd apt-get update || true
    $sudo_cmd apt-get install -y chromium-browser || $sudo_cmd apt-get install -y chromium || true
  elif command -v dnf >/dev/null 2>&1; then
    $sudo_cmd dnf install -y chromium || true
  elif command -v yum >/dev/null 2>&1; then
    $sudo_cmd yum install -y chromium || true
  elif command -v zypper >/dev/null 2>&1; then
    $sudo_cmd zypper --non-interactive install chromium || true
  elif command -v pacman >/dev/null 2>&1; then
    $sudo_cmd pacman -S --noconfirm chromium || true
  else
    print_browser_install_hint
  fi
  return 0
}

# Nothing is installed when any browser of BROWSER_TABLE is present.
ensure_chrome() {
  if [ -n "$BROWSER_TARGET" ]; then
    return 0
  fi

  print_pair "未检测到 Chrome、Chromium、Brave、Edge、Vivaldi 或 Arc 浏览器。" "No Chrome, Chromium, Brave, Edge, Vivaldi or Arc browser was detected."

  # Installing a browser system-wide is a surprising side effect for a one-line installer,
  # so it stays opt-in and never runs sudo on its own.
  if [ "${DSH_INSTALL_BROWSER:-0}" != "1" ]; then
    print_browser_install_hint
    print_pair "安装后重新运行本脚本；或设置 DSH_INSTALL_BROWSER=1 让脚本尝试自动安装。" "Install it and rerun this script, or set DSH_INSTALL_BROWSER=1 to let the installer attempt it."
    return 1
  fi

  print_pair "DSH_INSTALL_BROWSER=1，尝试自动安装……" "DSH_INSTALL_BROWSER=1 is set; attempting to install…"
  install_browser

  if detect_browser; then
    return 0
  fi
  print_pair "自动安装未完成，本次安装会继续，但需要你手动安装浏览器后再加载扩展。" "Automatic browser installation did not complete; continuing, but install a browser manually before loading the extension."
  return 1
}

cleanup_bootstrap() {
  if [ -n "$BOOTSTRAP_TMP" ] && [ -d "$BOOTSTRAP_TMP" ]; then
    rm -rf -- "$BOOTSTRAP_TMP"
  fi
}

# bootstrap_remote_install <release tag, or empty for the latest> <branch, or empty>
bootstrap_remote_install() {
  local wanted="$1"
  local branch="$2"
  local archive
  local source_dir
  local source_label
  local source_label_zh
  local temp_base="${TMPDIR:-/tmp}"

  require_command curl "未找到 curl；请先安装 curl。" "curl was not found; install curl first."
  require_command tar "未找到 tar；请先安装 tar。" "tar was not found; install tar first."
  require_command rsync "未找到 rsync；请先安装 rsync。" "rsync was not found; install rsync first."

  if [ -d "$MANAGED_ROOT" ] && [ ! -f "$MANAGED_MARKER" ] && [ -n "$(ls -A "$MANAGED_ROOT" 2>/dev/null)" ]; then
    fail_pair \
      "$MANAGED_ROOT 已存在且不是脚本托管的安装目录；为避免覆盖，请移动该目录或在其中运行 ./scripts/install.sh。" \
      "$MANAGED_ROOT already exists and is not managed by this installer; move it or run ./scripts/install.sh inside it to avoid overwriting it."
  fi

  BOOTSTRAP_TMP="$(mktemp -d "$temp_base/dsh-browser-install.XXXXXX")"
  trap cleanup_bootstrap EXIT HUP INT TERM
  source_dir="$BOOTSTRAP_TMP/source"
  mkdir -p "$source_dir" "$BOOTSTRAP_TMP/download"

  if [ -n "$branch" ]; then
    [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$branch" != *..* ]] || fail_pair \
      "不是有效的分支名：$branch" "Not a usable branch name: $branch"
    print_pair \
      "警告：正在安装 $RELEASE_REPOSITORY 的 $branch 分支。分支归档没有校验值，内容未经校验；仅用于开发。" \
      "WARNING: installing branch $branch of $RELEASE_REPOSITORY. A branch archive has no checksum and is NOT verified; use this for development only."
    release_check_base "$RELEASE_GITHUB_URL"
    archive="$BOOTSTRAP_TMP/download/branch.tar.gz"
    release_http "$RELEASE_GITHUB_URL/$RELEASE_REPOSITORY/archive/refs/heads/$branch.tar.gz" "$archive"
    case "$RELEASE_STATUS" in
      200) ;;
      401 | 403 | 404) fail_pair \
        "无法匿名下载 $branch 分支：仓库是私有的，或没有这个分支。请 git clone 后在 checkout 中运行 ./scripts/install.sh。" \
        "Branch $branch cannot be downloaded anonymously: the repository is private, or there is no such branch. Clone the repository and run ./scripts/install.sh from the checkout." ;;
      *) fail_pair \
        "下载 $branch 分支失败。现有安装未被修改。" \
        "Downloading branch $branch failed. The existing installation was not changed." ;;
    esac
    source_label="branch $branch (unverified)"
    source_label_zh="$branch 分支，未校验"
  else
    print_pair \
      "正在从 $RELEASE_REPOSITORY 下载发布版本 ${wanted:-latest} 并校验……" \
      "Downloading release ${wanted:-latest} of $RELEASE_REPOSITORY and verifying it…"
    # Nothing below this line touches the download until release_fetch has verified it.
    release_fetch "$BOOTSTRAP_TMP/download" "$wanted" "dsh-browser-source-{tag}.tar.gz"
    archive="$BOOTSTRAP_TMP/download/dsh-browser-source-$RELEASE_TAG.tar.gz"
    source_label="release $RELEASE_TAG (SHA256SUMS verified)"
    source_label_zh="发布版本 ${RELEASE_TAG}，已通过 SHA256SUMS 校验"
  fi

  tar -xzf "$archive" -C "$source_dir" --strip-components=1 || fail_pair \
    "无法解压下载的归档，未修改现有安装。" \
    "The downloaded archive could not be unpacked; the existing installation was not changed."
  has_workspace "$source_dir" || fail_pair \
    "下载内容不完整，未修改现有安装。" \
    "The download is incomplete; the existing installation was not changed."

  mkdir -p "$MANAGED_ROOT"
  # The marker exists before the sync starts, so an interrupted sync is still a managed
  # directory the next run may repair; it names the source once the sync is complete.
  [ -f "$MANAGED_MARKER" ] || : >"$MANAGED_MARKER"
  # --checksum: archive timestamps are fixed per release, so size and time alone could
  # miss a changed file of the same length.
  rsync -a --checksum --delete-after \
    --exclude 'node_modules/' \
    --exclude '.managed-by-install-sh' \
    "$source_dir/" "$MANAGED_ROOT/"
  printf '%s\n' "$source_label" >"$MANAGED_MARKER"

  cleanup_bootstrap
  trap - EXIT HUP INT TERM
  print_pair "安装文件已同步到 ${MANAGED_ROOT}（${source_label_zh}）。" "Installation files are ready in $MANAGED_ROOT ($source_label)."
  # The second stage must install what was just unpacked, not download again.
  DSH_BROWSER_BOOTSTRAPPED=1 exec /bin/bash "$MANAGED_ROOT/scripts/install.sh"
}

print_usage() {
  if [ "$RELEASE_LANG" = "zh" ]; then
    cat <<'USAGE'
用法：install.sh [--release latest|vX.Y.Z] [--unverified-branch <name>] [--lang en|zh]

  （不带选项，在 checkout 中）     安装当前 checkout，不下载任何文件
  （不带选项，单独运行）           等同于 --release latest
  --release latest|vX.Y.Z          下载该发布版本，按其 SHA256SUMS 校验每个文件后再安装
                                   （环境变量：DSH_BROWSER_VERSION）
  --unverified-branch <name>       仅用于开发：安装分支归档，分支归档没有校验值
                                   （环境变量：DSH_BROWSER_UNVERIFIED_BRANCH）
  --lang en|zh                     输出语言（环境变量：DSH_BROWSER_LANG）；默认在中文
                                   环境下为中文，其他环境为英文

私有仓库：设置 DSH_BROWSER_GITHUB_TOKEN，或先用 gh 登录，或在 checkout 中安装。
USAGE
    return 0
  fi
  cat <<'USAGE'
Usage: install.sh [--release latest|vX.Y.Z] [--unverified-branch <name>] [--lang en|zh]

  (no option, inside a checkout)   install this checkout; nothing is downloaded
  (no option, standalone)          same as --release latest
  --release latest|vX.Y.Z          download that tagged release, verify every file against
                                   its SHA256SUMS, then install it (env: DSH_BROWSER_VERSION)
  --unverified-branch <name>       development only: install a branch archive, which has no
                                   checksum (env: DSH_BROWSER_UNVERIFIED_BRANCH)
  --lang en|zh                     language of the output (env: DSH_BROWSER_LANG); default:
                                   Chinese when the locale is Chinese, English otherwise

Private repository: set DSH_BROWSER_GITHUB_TOKEN, or log in with gh, or install from a checkout.
USAGE
}

REQUESTED_RELEASE="${DSH_BROWSER_VERSION:-}"
REQUESTED_BRANCH="${DSH_BROWSER_UNVERIFIED_BRANCH:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release | --unverified-branch | --lang)
      [ "$#" -ge 2 ] || fail_pair "$1 需要一个值。" "$1 needs a value."
      case "$1" in
        --release) REQUESTED_RELEASE="$2" ;;
        --unverified-branch) REQUESTED_BRANCH="$2" ;;
        *) release_set_lang "$2" ;;
      esac
      shift 2
      ;;
    --lang=*)
      release_set_lang "${1#--lang=}"
      shift
      ;;
    --release=*)
      REQUESTED_RELEASE="${1#--release=}"
      shift
      ;;
    --unverified-branch=*)
      REQUESTED_BRANCH="${1#--unverified-branch=}"
      shift
      ;;
    -h | --help)
      print_usage
      exit 0
      ;;
    *)
      print_usage >&2
      fail_pair "未知参数：$1" "Unknown option: $1"
      ;;
  esac
done
if [ -n "$REQUESTED_RELEASE" ] && [ -n "$REQUESTED_BRANCH" ]; then
  fail_pair "--release 与 --unverified-branch 不能同时使用。" "--release and --unverified-branch cannot be combined."
fi
# A bare version number is accepted for the tag: 0.1.5 means v0.1.5.
case "$REQUESTED_RELEASE" in
  [0-9]*) REQUESTED_RELEASE="v$REQUESTED_RELEASE" ;;
esac

if [ "${DSH_BROWSER_BOOTSTRAPPED:-0}" = "1" ]; then
  # Second stage of a download: install the files this script sits in.
  ROOT="$(workspace_root_from_script)" || fail_pair \
    "下载的安装文件不完整。" "The downloaded installation files are incomplete."
elif [ -n "$REQUESTED_BRANCH" ]; then
  bootstrap_remote_install "" "$REQUESTED_BRANCH"
elif [ -n "$REQUESTED_RELEASE" ]; then
  if [ "$REQUESTED_RELEASE" = "latest" ]; then REQUESTED_RELEASE=""; fi
  bootstrap_remote_install "$REQUESTED_RELEASE" ""
elif ROOT="$(workspace_root_from_script)"; then
  if [ ! -f "$ROOT/.managed-by-install-sh" ]; then
    print_pair "从本地 checkout 安装，不下载任何文件：$ROOT" "Installing from this local checkout; nothing is downloaded: $ROOT"
  fi
else
  print_pair "未检测到完整的本地 checkout，切换到免 clone 安装。" "No complete local checkout was detected; switching to the clone-free install."
  bootstrap_remote_install "" ""
fi

EXT="$ROOT/extensions/dsh-browser"
PLUGIN="$ROOT/packages/browser/bridge-browser"
WEB_PROFILE_MANIFEST="$DSH_HOME_DIR/profiles/web/package.json"
# Earlier package names of this bridge (upstream and its origin). Installing over
# either must not leave the old, unhardened bridge registered next to this one;
# scripts/uninstall.mjs knows the same names.
LEGACY_PLUGINS="@deepseek-ai/dsh-bridge-browser @yuxianglin/dsh-bridge-browser"

# Bridge token provisioning (zero-config Chrome). Kept in its own function so other
# installer changes stay independent. The plugin creates ~/.dsh/ext-bridge-token on
# first start; the installer runs earlier, so the helper creates it in the plugin's
# format when absent and copies it (0600) into the installed extension, which reads
# it through chrome.runtime.getURL. Must run after the dist sync, whose --delete-after
# would otherwise remove the copy. A token pinned in the plugin config is not copied:
# paste that one into the extension settings instead.
provision_bridge_token() {
  local extension_dir="$1"

  node "$ROOT/scripts/provision-bridge-token.mjs" "$DSH_HOME_DIR" "$extension_dir" ||
    fail_pair "无法写入浏览器桥 token。" "Could not provision the browser bridge token."
}

profile_has_dependency() {
  local manifest="$1"
  local package_name="$2"

  [ -f "$manifest" ] || return 1
  node -e '
    const manifest = require(process.argv[1]);
    process.exit(Object.hasOwn(manifest.dependencies ?? {}, process.argv[2]) ? 0 : 1);
  ' "$manifest" "$package_name"
}

find_desktop_app
resolve_node
resolve_pnpm
require_command rsync "未找到 rsync；请先安装 rsync。" "rsync was not found; install rsync first."

print_step 1 "构建浏览器桥" "Build the browser bridge"
run_quiet "依赖安装失败" "Installing dependencies failed" pnpm install --frozen-lockfile
run_quiet "桥插件构建失败" "Building the bridge plugin failed" pnpm --filter @natgurlain/dsh-bridge-browser run build

print_step 2 "注册到 DSH（web profile 与桌面应用）" "Register with DSH (web profile and desktop app)"
for legacy_plugin in $LEGACY_PLUGINS; do
  if profile_has_dependency "$WEB_PROFILE_MANIFEST" "$legacy_plugin"; then
    run_quiet "从 web profile 移除旧的桥插件失败" "Removing the old bridge plugin from the web profile failed" \
      pnpm exec dsh plugin --profile web remove "$legacy_plugin"
  fi
done
run_quiet "注册到 web profile 失败" "Registering with the web profile failed" \
  pnpm exec dsh plugin --profile web add -w "@natgurlain/dsh-bridge-browser@link:$PLUGIN"
print_pair "已注册到 web profile。" "Registered with the web profile."
register_desktop

print_step 3 "构建浏览器扩展" "Build the browser extension"
run_quiet "扩展构建失败" "Building the extension failed" pnpm --filter dsh-browser-extension run build

detect_browser || true
print_step 4 "准备扩展并打开 $BROWSER_NAME" "Prepare the extension and open $BROWSER_NAME"
NO_LAUNCH="${DSH_BROWSER_NO_LAUNCH:-0}"
if [ "$NO_LAUNCH" != "1" ]; then
  ensure_chrome || true
fi
DIST_DIR="$DSH_HOME_DIR/browser-extension"
if [ -f "$DIST_DIR/manifest.json" ]; then
  IS_UPDATE=1
else
  IS_UPDATE=0
fi
mkdir -p "$DIST_DIR"
# bridge-token is not in dist/: keep the existing copy (provisioned below) instead
# of deleting and re-creating it on every update.
rsync -a --delete-after --exclude '/bridge-token' "$EXT/dist/" "$DIST_DIR/"
if [ -f "$ROOT/.managed-by-install-sh" ]; then
  INSTALL_MODE="managed"
else
  INSTALL_MODE="checkout"
fi
node "$ROOT/scripts/write-install-info.mjs" \
  "$DIST_DIR/install-info.json" "$INSTALL_MODE" "$ROOT" "$DSH_HOME_DIR"
provision_bridge_token "$DIST_DIR"
if [ "$NO_LAUNCH" != "1" ] && copy_to_clipboard "$DIST_DIR"; then
  CLIPBOARD_READY=1
else
  CLIPBOARD_READY=0
fi

if [ "$NO_LAUNCH" != "1" ] && open_browser_extensions; then
  BROWSER_OPENED=1
else
  BROWSER_OPENED=0
fi
printf '\n'
if [ "$BROWSER_OPENED" -ne 1 ]; then
  print_pair "无法自动打开 ${BROWSER_NAME}，请手动打开浏览器并在地址栏输入 ${BROWSER_URL}。" "Could not open $BROWSER_NAME automatically; open the browser and type $BROWSER_URL in the address bar."
fi
if [ "$IS_UPDATE" -eq 1 ]; then
  print_pair "检测到已有扩展目录，文件已安全更新。" "Existing extension directory detected; its files were updated safely."
  print_pair "打开 ${BROWSER_NAME}（注意不是 Firefox）：" "Open $BROWSER_NAME (not Firefox):"
  printf '\n'
  print_pair "    地址栏输入 $BROWSER_URL" "    Type $BROWSER_URL in the address bar"
  printf '\n'
  print_pair "如果页面上已有“dsh 浏览器助手”卡片：" "If the “dsh Browser Agent” card is already listed:"
  print_pair "  点击卡片上的“重新加载”按钮，让扩展加载新文件。" "  Click “Reload” on that card so it picks up the updated files."
  printf '\n'
  print_pair "如果没有该卡片（例如从未加载过）：" "If the card is not listed (e.g. it was never loaded):"
  print_pair "  打开“开发者模式”" "  Enable “Developer mode”"
  print_pair "  点击“加载已解压的扩展程序”" "  Click “Load unpacked”"
  print_pair "  选择这个目录：" "  Select this directory:"
  printf '   %s\n' "$DIST_DIR"
  printf '\n'
  print_pair "出现 “dsh 浏览器助手” 卡片即成功。" "When the “dsh Browser Agent” card appears, it is loaded."
else
  if [ "$BROWSER_OPENED" -eq 1 ]; then
    print_pair "$BROWSER_NAME 扩展管理页（${BROWSER_URL}）已打开，请完成以下操作：" "$BROWSER_NAME Extensions ($BROWSER_URL) is open. Complete these steps:"
  else
    print_pair "请在 $BROWSER_NAME 扩展管理页（${BROWSER_URL}）完成以下操作：" "Complete these steps on the $BROWSER_NAME Extensions page ($BROWSER_URL):"
  fi
  printf '\n'
  print_pair "1. 开启“开发者模式”" "1. Enable “Developer mode”"
  print_pair "2. 点击“加载已解压的扩展程序”" "2. Click “Load unpacked”"
  if is_macos; then
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "3. 按 Cmd+Shift+G，粘贴以下路径（已复制到剪贴板）：" "3. Press Cmd+Shift+G and paste this path (already copied):"
    else
      print_pair "3. 按 Cmd+Shift+G，粘贴以下路径：" "3. Press Cmd+Shift+G and paste this path:"
    fi
  else
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "3. 粘贴以下路径（已复制到剪贴板）：" "3. Paste this path (already copied):"
    else
      print_pair "3. 复制并粘贴以下路径：" "3. Copy and paste this path:"
    fi
  fi
  printf '   %s\n' "$DIST_DIR"
fi

# ---- Summary: where the bridge was registered, then how to start DSH ----------------------
printf '\n'
print_pair "DSH 注册结果：" "DSH targets:"
print_pair "• web profile：已注册" "• web profile: registered"
case "$DESKTOP_STATUS" in
  registered)
    print_pair "• DeepSeek Harness 桌面应用：已注册（${DESKTOP_APP}）" "• DeepSeek Harness desktop app: registered ($DESKTOP_APP)"
    ;;
  rejected)
    print_pair "• DeepSeek Harness 桌面应用：未注册。警告：应用的 DSH 版本是 ${DESKTOP_APP_VERSION}，本插件支持 ${DESKTOP_PLUGIN_RANGE}。请更新 DeepSeek Harness 应用，然后重新运行本安装脚本。" "• DeepSeek Harness desktop app: NOT registered. WARNING: the app has DSH $DESKTOP_APP_VERSION and this plugin supports $DESKTOP_PLUGIN_RANGE. Update the DeepSeek Harness app, then run this installer again."
    ;;
  failed)
    print_pair "• DeepSeek Harness 桌面应用：未注册。警告：应用自带的 CLI 执行失败，命令、退出码和输出见上文第 2 步。" "• DeepSeek Harness desktop app: NOT registered. WARNING: its bundled CLI failed; the command, exit code and output are under step 2 above."
    ;;
  no-profile)
    print_pair "• DeepSeek Harness 桌面应用：已跳过，$DSH_HOME_DIR/profiles/desktop 不存在。请先打开一次应用，再重新运行本安装脚本。" "• DeepSeek Harness desktop app: skipped, $DSH_HOME_DIR/profiles/desktop does not exist. Open the app once, then run this installer again."
    ;;
  no-cli)
    print_pair "• DeepSeek Harness 桌面应用：已跳过，在 $DESKTOP_APP 中没有找到自带的 CLI。" "• DeepSeek Harness desktop app: skipped, no bundled CLI was found in $DESKTOP_APP."
    ;;
  *)
    if is_macos; then
      print_pair "• DeepSeek Harness 桌面应用：已跳过，未在 /Applications 或 ~/Applications 找到（可用 DSH_DESKTOP_APP 指定路径）。" "• DeepSeek Harness desktop app: skipped, not found in /Applications or ~/Applications (set DSH_DESKTOP_APP to its path if it is elsewhere)."
    else
      print_pair "• DeepSeek Harness 桌面应用：已跳过，仅在 macOS 上自动检测（可用 DSH_DESKTOP_APP 指定路径）。" "• DeepSeek Harness desktop app: skipped, it is detected on macOS only (set DSH_DESKTOP_APP to its path to use one here)."
    fi
    ;;
esac

printf '\n'
print_pair "加载完成后：" "After loading the extension:"
if [ "$DESKTOP_STATUS" = "registered" ]; then
  if [ "$DESKTOP_RUNNING" -eq 1 ]; then
    print_pair "• 打开 DeepSeek Harness（它正在运行：请先退出再重新打开）" "• Open DeepSeek Harness (it is running now: quit it and open it again)"
  else
    print_pair "• 打开 DeepSeek Harness（如果它正在运行，请重启）" "• Open DeepSeek Harness (restart it if it was running)"
  fi
fi
print_pair "• 点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏" "• Click the DeepSeek whale icon in the toolbar to open the side panel"
print_pair "• 扩展会自动发现本机 dsh，无需填写地址或 token（已放入扩展目录）" "• The extension discovers local dsh automatically; no address or token is required (it was placed in the extension directory)"
if [ "$DESKTOP_STATUS" = "registered" ]; then
  print_pair "• 没有桌面应用时的替代方式（独立的 web profile，不包含桌面应用里配置的模型）：" "• Alternative without the desktop app (the separate web profile, which has none of the models configured in the app):"
  printf '    cd %q && pnpm start\n' "$ROOT"
  printf '    npx @deepseek-ai/dsh@0.2.2-rc.2 web\n'
else
  QUOTED_ROOT="$(printf '%q' "$ROOT")"
  print_pair "• 启动固定版本：cd $QUOTED_ROOT && pnpm start" "• Start the pinned version: cd $QUOTED_ROOT && pnpm start"
  print_pair "• 或直接启动固定版本：npx @deepseek-ai/dsh@0.2.2-rc.2 web" "• Or start the pinned version directly: npx @deepseek-ai/dsh@0.2.2-rc.2 web"
  if [ "$DESKTOP_STATUS" != "absent" ]; then
    print_pair "  注意：这样启动的是独立的 web profile，不包含 DeepSeek Harness 桌面应用里配置的模型。" "  Note: this starts the separate web profile, which has none of the models configured in the DeepSeek Harness desktop app."
  fi
fi
printf '\n'
print_pair "如果用得顺手，欢迎在 GitHub 点个 Star 支持我们：https://github.com/natgurlain/dsh-browser-agent" "If dsh-browser is useful to you, we'd appreciate a Star on GitHub: https://github.com/natgurlain/dsh-browser-agent"
if [ "$DESKTOP_STATUS" = "failed" ]; then
  # Everything else is installed; the exit code still says one target was not.
  exit 1
fi
