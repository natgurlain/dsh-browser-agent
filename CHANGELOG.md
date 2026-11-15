# Changelog

Each `## vX.Y.Z` section becomes the notes of that GitHub release
(`scripts/package-release.mjs --notes`), followed by the SHA-256 digests of its assets.

## v0.1.5

First release of dsh Browser Agent, a fork of [dsh-browser](https://github.com/omdsh-dev/dsh-browser)
v0.1.4 by Yuxiang Lin and contributors (MIT; see NOTICE). The extension is 0.1.5 and the
bridge plugin is `@natgurlain/dsh-bridge-browser` 0.0.7. It runs on DSH 0.2.2-rc.1 to
0.2.2-rc.3 (0.2.2-rc.2 by default); on 0.2.2-rc.1 Continue after a failed turn and the wait for
worktree cleanup on delete are unavailable. See `docs/dsh-matrix.md`.

Upgrading from upstream 0.1.4: run the installer. It removes the bridge registered under
the earlier package names (`@deepseek-ai/dsh-bridge-browser`, `@yuxianglin/dsh-bridge-browser`)
and registers this one. Reload the extension and restart DSH together, because the bridge
handshake changed and an older extension or plugin is refused.

### Install, update and uninstall

- The installers download one tagged release and check every file against that release's
  `SHA256SUMS` before unpacking or running it. They stop on a mismatch, a missing
  `SHA256SUMS` or an incomplete download. `--release vX.Y.Z` (or `DSH_BROWSER_VERSION`)
  picks a version; the default is the latest release.
- Installing a branch is a separate, explicit development option (`--unverified-branch`),
  and nothing follows `main` any more.
- A private repository is detected and reported; `DSH_BROWSER_GITHUB_TOKEN` or an
  authenticated `gh` is used when present. Installing from a checkout downloads nothing.
- The side panel's update check compares against the latest release, and its update and
  uninstall commands name a release tag.
- Uninstall is available on macOS, Linux and Windows and from Settings. It also removes
  bridges registered under the earlier package names and the bridge's own state files, and
  keeps the audit log and session workspaces.
- The installer provisions the bridge token into the installed extension, so no address or
  token has to be entered, and keeps it across updates.
- `install.sh` also registers the bridge with the DeepSeek Harness desktop app, through the
  CLI bundled in the app, and the uninstaller removes it there. An app whose DSH version
  the plugin does not support is reported and skipped; the version check is never overridden.
- `install.sh` uses an already installed Node.js or pnpm when the one on PATH is missing or
  unusable (the app's, then asdf, nvm, fnm, volta or mise), and opens the Chromium browser
  that is installed (Chrome, Chromium, Brave, Edge, Vivaldi or Arc) instead of assuming Chrome.
- The Windows release path (`install.ps1`, `uninstall.ps1`) has not been run on Windows yet.

### Bridge

- Every client authenticates with a mutual challenge-response over the bridge token, bound
  to the endpoint the extension dialed; later frames are authenticated too. The Chrome
  extension ID is pinned by a manifest key, and weak pinned tokens are refused at startup.
- The bridge is limited to the calls the extension needs and to its own sessions.
- One connection per client, tools routed by session, and approvals forwarded to DSH, so
  the extension works without the side panel open.
- Updated for DSH 0.2.2-rc.2: session streams, images and archive cleanup.

### Page reading and actions

- The page inventory covers shadow DOM, ARIA widgets and custom controls.
- New tools: `browser_select`, `browser_extract`, conditional waits, element scrolling,
  action verification, dialogs, trusted pointer input, downloads and PDF text.
- `browser_run` runs an approved multi-step program behind one approval card.
- Standing page watchers and tab fleets (`browser_fanout`).

### Safety and control

- Approval cards show and bind the full payload. Site rules (blocked, read-only, always
  ask), managed policy, and taint rules that ask again before writes after untrusted
  content was read. An optional strict mode gates agent writes at the network commit point.
- A kill switch that stops input, dialogs and running programs and survives restarts.
- An on-page agent overlay, a step timeline, pause / take over / resume, and a
  tamper-evident audit log under `~/.dsh/browser-audit/`.

### Other harnesses and coding sessions

- An opt-in MCP endpoint and stdio shim let Claude Code, Cursor or Codex drive the browser
  through the same approvals, site policy and audit log.
- A browser subagent preset, bundled browser skills, `delegate_browser_task`, and a dev loop
  that lets a linked localhost tab report back to a coding session (off by default).

### Learning (experimental, all off by default)

- Save a run as a workflow, replay it with fresh element lookup, and schedule it.
- Watch me: repeat a demonstrated pattern over the remaining rows.
- Site drivers: propose a same-origin request as a typed tool, saved only after approval.
- Failure fixtures: sanitized page copies of failed steps, importable as benchmark tasks.

### Panel

- Host state sync, continuing a failed generation, and settings for policy, watchers, the
  dev loop and learning, in English and Chinese.

### Project

- Renamed to dsh Browser Agent, with attribution to the upstream project.
- Release packaging with deterministic archives and `SHA256SUMS`, CI on Linux, macOS and
  Windows, a nightly DSH compatibility matrix, a benchmark suite, and a store submission kit.
