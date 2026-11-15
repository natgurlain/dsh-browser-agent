#!/bin/bash
# shellcheck disable=SC1111 # the typographic quotes in the user-facing text are intended
# dsh-browser uninstall entry point. Inside a checkout or the managed install it runs the uninstall.mjs
# next to it. On its own (piped in, for example) it downloads uninstall.mjs from a tagged
# release and runs it only after its SHA-256 matched that release's SHA256SUMS.
#
#   uninstall.sh [--release latest|vX.Y.Z] [uninstall.mjs options…]
#
# DSH_BROWSER_VERSION is the environment form of --release; the default is the latest release.
set -euo pipefail

download_dir=""

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
  printf 'Verified: %d file(s) of %s match SHA256SUMS.\n' "$#" "$RELEASE_TAG"
  printf '   已校验：%s 的 %d 个文件与 SHA256SUMS 一致。\n' "$RELEASE_TAG" "$#"
}
# <<< release-fetch

main() {
  local engine="" script_dir="" wanted="${DSH_BROWSER_VERSION:-}"
  local -a forwarded=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --release)
        [ "$#" -ge 2 ] || release_fail "--release 需要一个值。" "--release needs a value."
        wanted="$2"
        shift 2
        ;;
      --release=*)
        wanted="${1#--release=}"
        shift
        ;;
      *)
        forwarded+=("$1")
        shift
        ;;
    esac
  done
  case "$wanted" in
    latest) wanted="" ;;
    [0-9]*) wanted="v$wanted" ;;
  esac

  if ! command -v node >/dev/null; then
    printf '%s\n' 'Node.js 24.9.0 or newer is required. / 需要 Node.js 24.9.0 或更新版本。' >&2
    return 1
  fi
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$script_dir/uninstall.mjs" ]; then
      engine="$script_dir/uninstall.mjs"
    fi
  fi
  if [ -z "$engine" ]; then
    download_dir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-browser-uninstall.XXXXXX")"
    trap 'if [ -d "$download_dir" ]; then rm -rf -- "$download_dir"; fi' EXIT
    # uninstall.mjs is not run unless release_fetch has verified it.
    release_fetch "$download_dir" "$wanted" uninstall.mjs
    engine="$download_dir/uninstall.mjs"
  fi
  # ${array[@]+…}: an empty array is "unbound" under set -u in bash 3.2 (macOS).
  node "$engine" ${forwarded[@]+"${forwarded[@]}"}
}

main "$@"
