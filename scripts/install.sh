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
# DSH_BROWSER_VERSION and DSH_BROWSER_UNVERIFIED_BRANCH are the environment forms of the two
# options. DSH_BROWSER_GITHUB_TOKEN (or an authenticated gh) is needed while the repository is
# private. DSH_BROWSER_NO_LAUNCH=1 keeps the installer from opening Chrome or touching the
# clipboard.
set -euo pipefail

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

release_fail() {
  printf '\nError: %s\n' "$2" >&2
  printf '错误：%s\n' "$1" >&2
  exit 1
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
      "GitHub 拒绝了 DSH_BROWSER_GITHUB_TOKEN（HTTP $RELEASE_STATUS）。" \
      "GitHub rejected DSH_BROWSER_GITHUB_TOKEN (HTTP $RELEASE_STATUS)." ;;
    404) release_fail \
      "用该 token 找不到 $RELEASE_REPOSITORY 的发布版本 ${RELEASE_TAG:-latest}；请确认版本已发布且 token 可以读取该仓库。" \
      "No release ${RELEASE_TAG:-latest} of $RELEASE_REPOSITORY is visible to this token; check that it is published and that the token can read the repository." ;;
    *) release_fail \
      "无法从 GitHub API 读取发布信息（HTTP $RELEASE_STATUS）。" \
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
      "$name 的 SHA-256 与 SHA256SUMS 不符（期望 $expected，实际 $actual）。文件未被解压或执行。" \
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
    release_fail "不是有效的发布版本号：$RELEASE_TAG（示例：v0.1.5）。" "Not a release tag: $RELEASE_TAG (expected something like v0.1.5)."
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
        "下载失败：无法连接 $RELEASE_GITHUB_URL。现有安装未被修改。" \
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
  printf 'Verified: %d file(s) of %s match SHA256SUMS.\n' "$#" "$RELEASE_TAG"
  printf '   已校验：%s 的 %d 个文件与 SHA256SUMS 一致。\n' "$RELEASE_TAG" "$#"
}
# <<< release-fetch

# Messages are bilingual: English first, Chinese on the indented line below.
# Callers pass the Chinese text first and the English text second.
print_step() {
  printf '\n[%s/4] %s\n' "$1" "$3"
  printf '      %s\n' "$2"
}

print_pair() {
  printf '%s\n' "$2"
  printf '   %s\n' "$1"
}

fail_pair() {
  printf '\nError: %s\n' "$2" >&2
  printf '错误：%s\n' "$1" >&2
  exit 1
}

# Runs a command in the checkout with its output hidden. When it fails, the end
# of that output is shown and the install stops, so a failed build or dependency
# install is never a silent exit.
run_quiet() {
  local zh="$1" en="$2" log status=0
  shift 2
  log="$(mktemp "${TMPDIR:-/tmp}/dsh-browser-install.XXXXXX")"
  (cd "$ROOT" && "$@") >"$log" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    rm -f "$log"
    return 0
  fi
  printf '\n' >&2
  tail -n 40 "$log" >&2
  printf '\nFull output: %s\n' "$log" >&2
  printf '完整输出：%s\n' "$log" >&2
  printf '\nError: %s (exit code %s).\n' "$en" "$status" >&2
  printf '错误：%s（退出码 %s）。\n' "$zh" "$status" >&2
  # Keep the command's own exit code for whoever called the installer.
  exit "$status"
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
# Corepack, or through npx with the version package.json pins.
resolve_pnpm() {
  local found=0
  if command -v pnpm >/dev/null 2>&1; then
    found=1
    if pnpm --version >/dev/null 2>&1; then return 0; fi
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
      print_pair "PATH 上的 pnpm 无法在当前 Node 下运行，改用 npx $PNPM_NPX_SPEC。" "pnpm on PATH does not run with this Node; using npx $PNPM_NPX_SPEC instead."
    else
      print_pair "未找到 pnpm，改用 npx $PNPM_NPX_SPEC。" "pnpm was not found; using npx $PNPM_NPX_SPEC instead."
    fi
    return 0
  fi
  if [ "$found" -eq 1 ]; then
    fail_pair "PATH 上的 pnpm 无法运行，也没有可用的 Corepack 或 npx；请先启用 Corepack 或重新安装 pnpm。" "pnpm on PATH does not run, and neither Corepack nor npx is usable; enable Corepack or reinstall pnpm first."
  fi
  fail_pair "未找到 pnpm；请先启用 Corepack 或安装 pnpm。" "pnpm was not found; enable Corepack or install pnpm first."
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

# Echoes a launch target for the local Chrome, Chromium or Brave install: on macOS an app bundle path
# or a LaunchServices app name (both accepted by `open -a`), on Linux an executable on PATH.
find_browser_target() {
  local name

  if is_macos; then
    local dir app
    for dir in "/Applications" "$HOME/Applications"; do
      for name in "Google Chrome" "Google Chrome Canary" "Chromium" "Brave Browser"; do
        app="$dir/$name.app"
        if [ -x "$app/Contents/MacOS/$name" ]; then
          printf '%s\n' "$app"
          return 0
        fi
      done
    done

    # Fallback: recognize apps registered with LaunchServices in non-standard locations.
    for name in "Google Chrome" "Google Chrome Canary" "Chromium" "Brave Browser"; do
      if open -Ra "$name" >/dev/null 2>&1; then
        printf '%s\n' "$name"
        return 0
      fi
    done
    return 1
  fi

  for name in google-chrome google-chrome-stable chromium chromium-browser brave-browser brave-browser-stable brave; do
    if command -v "$name" >/dev/null 2>&1; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  return 1
}

open_chrome_extensions() {
  local url="chrome://extensions"
  local target
  local pid

  target="$(find_browser_target)" || target=""

  if is_macos; then
    if [ -n "$target" ]; then
      open -a "$target" "$url" >/dev/null 2>&1 && return 0
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

ensure_chrome() {
  if find_browser_target >/dev/null 2>&1; then
    return 0
  fi

  print_pair "未检测到 Chrome/Chromium 浏览器。" "No Chrome/Chromium browser was detected."

  # Installing a browser system-wide is a surprising side effect for a one-line installer,
  # so it stays opt-in and never runs sudo on its own.
  if [ "${DSH_INSTALL_BROWSER:-0}" != "1" ]; then
    print_browser_install_hint
    print_pair "安装后重新运行本脚本；或设置 DSH_INSTALL_BROWSER=1 让脚本尝试自动安装。" "Install it and rerun this script, or set DSH_INSTALL_BROWSER=1 to let the installer attempt it."
    return 1
  fi

  print_pair "DSH_INSTALL_BROWSER=1，尝试自动安装……" "DSH_INSTALL_BROWSER=1 is set; attempting to install…"
  install_browser

  if find_browser_target >/dev/null 2>&1; then
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
  else
    print_pair \
      "正在从 $RELEASE_REPOSITORY 下载发布版本 ${wanted:-latest} 并校验……" \
      "Downloading release ${wanted:-latest} of $RELEASE_REPOSITORY and verifying it…"
    # Nothing below this line touches the download until release_fetch has verified it.
    release_fetch "$BOOTSTRAP_TMP/download" "$wanted" "dsh-browser-source-{tag}.tar.gz"
    archive="$BOOTSTRAP_TMP/download/dsh-browser-source-$RELEASE_TAG.tar.gz"
    source_label="release $RELEASE_TAG (SHA256SUMS verified)"
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
  print_pair "安装文件已同步到 ${MANAGED_ROOT}（${source_label}）。" "Installation files are ready in $MANAGED_ROOT ($source_label)."
  # The second stage must install what was just unpacked, not download again.
  DSH_BROWSER_BOOTSTRAPPED=1 exec /bin/bash "$MANAGED_ROOT/scripts/install.sh"
}

print_usage() {
  cat <<'USAGE'
Usage: install.sh [--release latest|vX.Y.Z] [--unverified-branch <name>]

  (no option, inside a checkout)   install this checkout; nothing is downloaded
  (no option, standalone)          same as --release latest
  --release latest|vX.Y.Z          download that tagged release, verify every file against
                                   its SHA256SUMS, then install it (env: DSH_BROWSER_VERSION)
  --unverified-branch <name>       development only: install a branch archive, which has no
                                   checksum (env: DSH_BROWSER_UNVERIFIED_BRANCH)

Private repository: set DSH_BROWSER_GITHUB_TOKEN, or log in with gh, or install from a checkout.
USAGE
}

REQUESTED_RELEASE="${DSH_BROWSER_VERSION:-}"
REQUESTED_BRANCH="${DSH_BROWSER_UNVERIFIED_BRANCH:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release | --unverified-branch)
      [ "$#" -ge 2 ] || fail_pair "$1 需要一个值。" "$1 needs a value."
      if [ "$1" = "--release" ]; then REQUESTED_RELEASE="$2"; else REQUESTED_BRANCH="$2"; fi
      shift 2
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

require_command node "未找到 Node.js；请先安装受支持的 Node.js 版本。" "Node.js was not found; install a supported Node.js version first."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)' ||
  fail_pair "需要 Node.js 24.9.0 或更新版本。" "Node.js 24.9.0 or newer is required."
resolve_pnpm
require_command rsync "未找到 rsync；请先安装 rsync。" "rsync was not found; install rsync first."

print_step 1 "构建浏览器桥" "Build the browser bridge"
run_quiet "依赖安装失败" "Installing dependencies failed" pnpm install --frozen-lockfile
run_quiet "桥插件构建失败" "Building the bridge plugin failed" pnpm --filter @natgurlain/dsh-bridge-browser run build

print_step 2 "注册到本机 web profile" "Register with the local web profile"
for legacy_plugin in $LEGACY_PLUGINS; do
  if profile_has_dependency "$WEB_PROFILE_MANIFEST" "$legacy_plugin"; then
    (cd "$ROOT" && pnpm exec dsh plugin --profile web remove "$legacy_plugin" >/dev/null)
  fi
done
(cd "$ROOT" && pnpm exec dsh plugin --profile web add -w "@natgurlain/dsh-bridge-browser@link:$PLUGIN" >/dev/null)

print_step 3 "构建 Chrome 扩展" "Build the Chrome extension"
run_quiet "扩展构建失败" "Building the extension failed" pnpm --filter dsh-browser-extension run build

print_step 4 "准备扩展并打开 Chrome" "Prepare the extension and open Chrome"
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

if [ "$NO_LAUNCH" != "1" ] && open_chrome_extensions; then
  CHROME_OPENED=1
else
  CHROME_OPENED=0
fi
printf '\n'
if [ "$CHROME_OPENED" -ne 1 ]; then
  print_pair "无法自动打开 Chrome，请手动打开浏览器并在地址栏输入 chrome://extensions。" "Could not open Chrome automatically; open the browser and type chrome://extensions in the address bar."
fi
if [ "$IS_UPDATE" -eq 1 ]; then
  print_pair "检测到已有扩展目录，文件已安全更新。" "Existing extension directory detected; its files were updated safely."
  print_pair "打开 Google Chrome（注意不是 Edge/Firefox）：" "Open Google Chrome (not Edge/Firefox):"
  printf '\n'
  print_pair "    地址栏输入 chrome://extensions" "    Type chrome://extensions in the address bar"
  printf '\n'
  print_pair "如果页面上已有“dsh 浏览器助手”卡片：" "If the “dsh Browser Assistant” card is already listed:"
  print_pair "  点击卡片上的“重新加载”按钮，让扩展加载新文件。" "  Click “Reload” on that card so it picks up the updated files."
  printf '\n'
  print_pair "如果没有该卡片（例如从未加载过）：" "If the card is not listed (e.g. it was never loaded):"
  print_pair "  打开右上角 “开发者模式”" "  Enable “Developer mode” in the upper-right corner"
  print_pair "  点左上角 “加载已解压的扩展程序”" "  Click “Load unpacked” in the upper-left corner"
  print_pair "  选择这个目录：" "  Select this directory:"
  printf '   %s\n' "$DIST_DIR"
  printf '\n'
  print_pair "出现 “dsh 浏览器助手” 卡片即成功。" "When the “dsh Browser Assistant” card appears, it is loaded."
else
  if [ "$CHROME_OPENED" -eq 1 ]; then
    print_pair "Chrome 扩展管理页已打开，请完成以下操作：" "Chrome Extensions is open. Complete these steps:"
  else
    print_pair "请在 Chrome 扩展管理页完成以下操作：" "Complete these steps on the Chrome Extensions page:"
  fi
  printf '\n'
  print_pair "开启右上角的“开发者模式”" "1. Enable “Developer mode” in the upper-right corner"
  print_pair "点击“加载已解压的扩展程序”" "2. Click “Load unpacked”"
  if is_macos; then
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "按 Cmd+Shift+G，粘贴以下路径（已复制到剪贴板）：" "3. Press Cmd+Shift+G and paste this path (already copied):"
    else
      print_pair "按 Cmd+Shift+G，粘贴以下路径：" "3. Press Cmd+Shift+G and paste this path:"
    fi
  else
    if [ "$CLIPBOARD_READY" -eq 1 ]; then
      print_pair "粘贴以下路径（已复制到剪贴板）：" "3. Paste this path (already copied):"
    else
      print_pair "复制并粘贴以下路径：" "3. Copy and paste this path:"
    fi
  fi
  printf '   %s\n' "$DIST_DIR"
fi

printf '\n'
print_pair "加载完成后：" "After loading the extension:"
print_pair "点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏" "• Click the DeepSeek whale icon in the toolbar to open the side panel"
print_pair "扩展会自动发现本机 dsh，无需填写地址或 token（已放入扩展目录）" "• The extension discovers local dsh automatically; no address or token is required (it was placed in the extension directory)"
printf '• Start the pinned version: cd %q && pnpm start\n' "$ROOT"
printf '   启动固定版本：cd %q && pnpm start\n' "$ROOT"
print_pair "或直接启动固定版本：npx @deepseek-ai/dsh@0.2.2-rc.2 web" "• Or start the pinned version directly: npx @deepseek-ai/dsh@0.2.2-rc.2 web"
printf '\n'
print_pair "如果用得顺手，欢迎在 GitHub 点个 Star 支持我们：https://github.com/natgurlain/dsh-browser-agent" "If dsh-browser is useful to you, we'd appreciate a Star on GitHub: https://github.com/natgurlain/dsh-browser-agent"
