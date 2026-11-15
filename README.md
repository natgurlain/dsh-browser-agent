# dsh Browser Agent

> Based on [dsh-browser](https://github.com/omdsh-dev/dsh-browser) by Yuxiang Lin and contributors (MIT). See [NOTICE](NOTICE).

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Pages become structured text with a numbered inventory of interactive elements. Tools address elements by number or selector; `browser_screenshot` captures the controlled tab's viewport after approval. The side panel also accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support.

> [!IMPORTANT]
> The bridge supports DSH 0.2.2-rc.1 through 0.2.2-rc.3 (tested; see [docs/dsh-matrix.md](docs/dsh-matrix.md)). The workspace installs 0.2.2-rc.2 by default. On 0.2.2-rc.1, the release the desktop app ships, Continue after a failed turn and the wait for worktree cleanup on delete are unavailable.

## Quick install

The installer installs the bridge plugin and Chrome extension. It downloads one tagged release, checks every downloaded file against that release's `SHA256SUMS`, and only then unpacks it and builds it from source. A digest mismatch, a missing `SHA256SUMS` or an incomplete download stops the install before anything is unpacked or run.

> [!NOTE]
> The repository is private for now and `v0.1.5` has not been published yet. Until it is, the download commands below answer 404. Install from a checkout instead (see [Install or update](#install-or-update)), or give the installer access first: `gh auth login`, or `export DSH_BROWSER_GITHUB_TOKEN=<a token that can read the repository>`, then run `install.sh` from a checkout with `--release v0.1.5`.

macOS and Linux. Download the installer, check it against the published digest, then run it:

```sh
tag=v0.1.5
base=https://github.com/natgurlain/dsh-browser-agent/releases/download/$tag
curl --proto '=https' --tlsv1.2 -fsSL -O "$base/install.sh" -O "$base/SHA256SUMS"
grep ' install.sh$' SHA256SUMS | sha256sum -c -    # macOS: shasum -a 256 -c -
bash install.sh --release "$tag"
```

Windows, in PowerShell (the release path of `install.ps1` has not been run on a Windows machine yet):

```powershell
$tag = 'v0.1.5'
$base = "https://github.com/natgurlain/dsh-browser-agent/releases/download/$tag"
irm "$base/install.ps1" -OutFile install.ps1; irm "$base/SHA256SUMS" -OutFile SHA256SUMS
$want = (Select-String -Path SHA256SUMS -Pattern ' install\.ps1$').Line.Split(' ')[0]
if ((Get-FileHash install.ps1 -Algorithm SHA256).Hash -ne $want) { throw 'install.ps1 does not match SHA256SUMS' }
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --release $tag
```

The same digests are printed in the notes of each [release](https://github.com/natgurlain/dsh-browser-agent/releases). The shorter form below runs the installer without checking the script first; what the installer downloads is still verified:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/natgurlain/dsh-browser-agent/releases/download/v0.1.5/install.sh | bash -s -- --release v0.1.5
```

`--release latest` installs the newest release instead of a named one. `SHA256SUMS` comes from the same release as the files, so it catches a corrupted, truncated or substituted download, not a release that was itself published by someone who took over the repository or its release workflow; see [RELEASING.md](RELEASING.md#what-verification-covers).

When the installer opens `chrome://extensions`, follow its instructions to load or reload **dsh Browser Assistant**. If dsh is already running, restart it after installation. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and developer installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes, `frame` reads one iframe, and `query` locates any element by text/selector/role and returns its selector |
| Click | `browser_click` | Click or double-click by index or selector; supports mouse buttons and modifiers |
| Text | `browser_type` | React/Vue-compatible input; `replace` clears the field first, and `mode` selects caret insertion or per-character key events |
| Press keys | `browser_press` | Single keys or chords (`modifiers`); `action: down/up` holds a key across calls and `repeat` repeats it |
| Scroll | `browser_scroll` | Scroll the page or selected iframe up, down, to the top, or to the bottom |
| Clipboard | `browser_clipboard` | `write` puts text/HTML on the system clipboard; `paste` delivers it as a paste event or a real platform shortcut |
| Files | `browser_upload` | Attach local files to an `input[type=file]` (Chrome) |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it (`active:false` keeps the current tab in front) |
| List tabs | `browser_list_tabs` | List accessible tabs with stable IDs, titles, URLs, window/index metadata, and active/controlled state |
| Follow tab | `browser_follow_tab` | Bind later browser tools to a tab returned by `browser_list_tabs`; it stays in the background unless `activate: true` |
| Close tab | `browser_close_tab` | Close a tab returned by `browser_list_tabs` |
| Hover / drag | `browser_hover` / `browser_drag` | Move the real pointer over an element (hover menus); drag to an element or by an offset, with HTML5 drag-and-drop for draggable sources |
| Dialogs | `browser_dialog` | Answer an alert/confirm/prompt/leave-site dialog; calls blocked by an open dialog fail fast with `dialog open: …` (Chrome) |
| Downloads | `browser_downloads` | List recent downloads or wait for one; returns local file paths. Asks for the optional `downloads` permission on first use |
| PDF | `browser_save_pdf` / `browser_pdf_text` | Save the tab as a PDF in the agent workspace (Chrome); extract the text of a PDF open in the tab |
| Choose options | `browser_select` | Pick options in a `<select>`, ARIA listbox or combobox by value, label or index |
| Extract tables | `browser_extract` | Rows from a table or repeated elements (schema), optionally across pages; `saveTo` writes CSV/JSON to the session workspace |
| Batch actions | `browser_run` | Up to 25 browser actions in order behind one approval card; stops at the first error or failed `expect` |
| Watch a page | `browser_watch` / `browser_watches` | Wake this session when a selector or text appears or disappears, the URL matches, or a request is seen; list or cancel watchers. Off until enabled in settings, and each watcher is approved |
| Read many pages | `browser_fanout` | Up to 8 subagents, each with its own background tab, read in parallel (read-only unless `allowActions`) and return structured answers |
| Delegate | `delegate_browser_task` | A regular DSH session hands page work to the browser subagent, so snapshots stay out of its conversation |
| Saved workflows | `browser_workflow_list` / `browser_workflow_run` | List and replay workflows saved from earlier runs (see [Learning features](#learning-features-experimental-all-off-by-default)) |
| Read region | `browser_get_text` | Lazy-loaded or partial page text |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |
| Send images | `session.prompt` / `session.attachment` | Host-capability-gated image drafts, image-only prompts, and durable history previews |
| Quote a selection | side panel composer | Text you highlight in the page appears in the composer and is sent with your next message as fenced, attributed page content |
| Continue generating | side panel | Continue an interrupted response when the host offers it |

Clicks, text entry, and scrolling run in the selected document, including cross-origin iframes. Chrome uses its debugger for native keyboard events, caret insertion, system paste, and file uploads. Screenshots require an active tab in a focused window; `browser_follow_tab { activate: true }` brings the controlled page to the front.

Before every click the target's center is hit-tested; a target covered by another element is refused with `covered by <element>` instead of clicking what lies on top. `browser_click { trusted: true }` clicks with real mouse input (Chrome), and a plain click on a custom element that visibly changed nothing is retried that way once. The **stop button** in the side panel (or Ctrl+Shift+K / ⌘⇧K; Alt+Shift+K in Firefox; rebindable on the browser's extension shortcuts page) cancels pending approvals and running actions, revokes session trust and developer-tools grants, turns unrestricted access off, detaches the debugger, and disconnects until you press Reconnect. Tabs the agent controls show an **AI** badge.

### Visibility and control

- **Approval cards** show exactly what will be clicked, typed or opened before it happens, and each card is bound to that one action.
- **Pause / take over.** *Pause after this step* lets the current action finish and holds the next one until you resume. *Take over* pauses the agent so you can use the page yourself; resume hands control back, and the model is told what changed.
- **Agent overlay.** A ghost cursor and outline mark each target before the agent acts, and controlled tabs get a colored frame with a Stop button (Settings can turn the overlay off).
- **Step timeline and audit log.** The side panel lists each step of a run. Every action, approval and kill-switch engagement is written to a tamper-evident audit log under `~/.dsh/browser-audit/`, which you can export from Settings.
- **Site rules.** In Settings, mark a site as blocked, read-only or always ask. After the agent reads untrusted content, writes to other sites need a fresh approval (taint rules).
- **Strict mode** (Chrome). For sites you list, or for one agent session, the page's outgoing writes are held at the network layer until you approve them.

### Use the browser from Claude Code, Cursor or Codex (MCP)

Set `mcp: { enabled: true }` in the `bridge-browser` plugin config. Then register the stdio shim `packages/browser/mcp-server/bin/dsh-browser-mcp.mjs` with your MCP client, for example `claude mcp add dsh-browser -- node /abs/path/to/dsh-browser-mcp.mjs`. Every MCP call goes through the same approval cards, site policy, taint rules, kill switch and audit log as DSH's own sessions. Each card names the MCP client that is asking. Setup snippets for Cursor and Codex are in [packages/browser/mcp-server/README.md](packages/browser/mcp-server/README.md).

### Learning features (experimental, all off by default)

Turn them on in the side panel under **Settings → Learning (experimental)**. Every replayed or learned action still passes the pause gate, site policy, taint rules, kill switch, approval cards and audit log.

- **Save as workflow.** With "Record runs" on, the agent's successful steps are kept in memory together with how to find each element again: role, accessible name, text, and a CSS fallback. **Save as workflow** writes them to `browser-workflows/<name>.workflow.json` in the session workspace. You choose which typed values become parameters. Values typed into sensitive fields are never stored; they become required parameters instead. Each saved workflow is also offered as a DSH skill.
  - `browser_workflow_run` replays a workflow and looks up every element fresh. When the element is gone or ambiguous it stops and hands the step to the model.
  - The panel can schedule a workflow to run in its own conversation, at most once per minute. Its approval cards still ask and fail closed when nobody answers. Workflows with sensitive inputs cannot be scheduled.

**Connection with the side panel closed.** After the last panel closes, the extension keeps its connection for 5 minutes past the last tool call or approval, then disconnects and lets its background worker sleep. Three opt-in features are meant to run unattended, so while one of them is in use the connection stays up and comes back by itself: live page watchers, workflow schedules created from this browser, and the MCP endpoint (`mcp.enabled`). dsh tells the extension about the last two when it connects; the extension remembers that, so after a browser restart it reconnects to the same address without a panel. It never scans for dsh on its own, and while dsh is unreachable it retries less and less often (30 s, doubling to at most 5 minutes). Settings shows what is keeping the browser connected. The stop button ends all of it: nothing reconnects until you press Reconnect. Approval cards that policy forces can still only be answered in the panel, so an unattended run that reaches one fails closed.
- **Watch me.** While watching, your own clicks and typing on the tab are recorded. Passwords are never recorded and sensitive fields are masked. After two repetitions over table or list rows, the panel offers **Do the remaining N like this**, which runs as a single `browser_run` program behind one card.
- **Site drivers** (Chrome only; developer tools must be allowed). For sites you list, the same-origin request behind an agent action is proposed as a typed tool (`browser_site_<host>_<name>`). Nothing is saved until you approve it, and cookies, tokens and sensitive fields are never stored: tokens are read from the page each time. Every use shows the exact request on its own card. If a driver fails, the agent goes back to the page UI. Drivers can be exported and imported as JSON.
- **Failure fixtures.** A failed step saves a sanitized copy of the page, with sensitive values masked and scripts removed, plus the intended action under `browser-fixtures/` in the session workspace. Pages that are blocked or not shared are skipped, and each save is recorded in the audit log. `node benchmark/import-fixtures.mjs <dir>` turns these files into benchmark task files. `benchmark/online-mind2web/` loads an Online-Mind2Web subset at runtime and renders a static leaderboard from results produced elsewhere. Neither has a runner yet: `benchmark/run.mjs` runs only the built-in tasks (see [benchmark/README.md](benchmark/README.md)).

## Detailed installation and usage

Requirements: Node.js `>=24.9.0`, Corepack/pnpm, and Chrome 125+ or Firefox 140+. Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

Run the [quick install commands](#quick-install) to install. It is one command on macOS and Linux; the installer does the rest:

- **DeepSeek Harness desktop app.** When the app is installed (`/Applications` or `~/Applications` on macOS; `DSH_DESKTOP_APP=<path>` for another location, `DSH_DESKTOP_APP=none` to skip it), the bridge is registered with the app's own `desktop` profile through the CLI bundled in the app, in addition to the `web` profile. Quit and reopen the app afterwards. If the app's DSH version is outside the range the plugin supports, the installer says so, registers the `web` profile only, and asks you to update the app and run it again; it never overrides the version check.
- **Node.js and pnpm.** When `node` on PATH is missing or older than 24.9.0, the installer uses one that is already installed: the app's bundled Node, then a suitable version from asdf, nvm, fnm, volta or mise. When `pnpm` on PATH does not run, it uses the app's bundled pnpm, then Corepack, then `npx`. Nothing is installed for you; if no suitable Node exists, the installer prints the command for the tools it found.
- **Browser.** It opens the extensions page of the Chromium browser you have (Chrome, Chromium, Brave, Edge, Vivaldi or Arc; your default browser if it is one of them) and names that browser in its instructions. Load `~/.dsh/browser-extension` as an unpacked extension the first time, or click **Reload** after an update.

The summary at the end lists where the bridge was registered and what was skipped. `install.ps1` on Windows registers the `web` profile only and looks for Chrome or Chromium only. Restart dsh if it is already running.

To update, open **Settings → Updates** in the side panel. The check compares the running version with the latest GitHub release and offers a command that installs exactly that release with the installer already on disk, for example:

```sh
DSH_HOME="$HOME/.dsh" bash "$HOME/.dsh/dsh-browser/scripts/install.sh" --release v0.1.5
```

Installer options:

| Option | Environment | Effect |
| --- | --- | --- |
| `--release latest` or `--release vX.Y.Z` | `DSH_BROWSER_VERSION` | Download that tagged release and verify it against its `SHA256SUMS`. This is the default when the installer is not run from a checkout. |
| `--unverified-branch <name>` | `DSH_BROWSER_UNVERIFIED_BRANCH` | Development only: install a branch archive. A branch has no checksum, so nothing is verified. |
| | `DSH_BROWSER_GITHUB_TOKEN` | Token for a private repository. It is sent to `api.github.com` only and never printed. Without it the installer falls back to an authenticated `gh`. |
| | `DSH_BROWSER_NO_LAUNCH=1` | Do not open the browser or touch the clipboard. |
| | `DSH_DESKTOP_APP=<path>` or `none` | Where the DeepSeek Harness desktop app is, or `none` to leave it alone (`install.sh` and the uninstaller). |

To install from a source checkout instead (nothing is downloaded; this is also the way to install while the repository is private):

```sh
git clone https://github.com/natgurlain/dsh-browser-agent.git
cd dsh-browser-agent
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

### Uninstall

Open **Settings → Uninstall dsh-browser** in the extension, copy the command, and run it in Terminal.

An installation that recorded its location is removed by the uninstaller it has on disk. Otherwise the command fetches the uninstaller published with the extension's own release; it downloads `uninstall.mjs` from that release and runs it only after its SHA-256 matched `SHA256SUMS`. On macOS or Linux:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/natgurlain/dsh-browser-agent/releases/download/v0.1.5/uninstall.sh | bash -s -- --release v0.1.5
```

On Windows:

```powershell
& { $ErrorActionPreference = 'Stop'; $d=New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('dsh-browser-uninstall.'+[Guid]::NewGuid().ToString('N'))); try { $s=Join-Path $d.FullName 'uninstall.ps1'; Invoke-WebRequest -UseBasicParsing https://github.com/natgurlain/dsh-browser-agent/releases/download/v0.1.5/uninstall.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s --release v0.1.5 } finally { Remove-Item -LiteralPath $d.FullName -Recurse -Force } }
```

From a checkout, run `bash scripts/uninstall.sh` or `.\scripts\uninstall.ps1`.

The uninstaller also removes the bridge from the desktop app's `desktop` profile, through the CLI bundled in the app (`--desktop-app <path>` or `DSH_DESKTOP_APP` when the app is not in `/Applications` or `~/Applications`). If the app cannot be found, that registration and the files it shares stay in place and the uninstaller says so.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox add-ons are not installed by the installer, so copy the bridge token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

With the DeepSeek Harness desktop app, open the app (restart it after installing). `pnpm start` and `dsh web` below start the separate `web` profile, which has none of the models configured in the app.

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. The default tested public runtime is:

```sh
npx @deepseek-ai/dsh@0.2.2-rc.2 web
```

Local Chrome use requires no configuration: the installer places the bridge token in the installed extension directory, and the plugin keeps that copy current. Firefox requires the local bridge token described above. Open a page, click the DeepSeek whale icon, and wait for **Connected**. Existing HTTP(S) tabs are instrumented on the first action. On browser-protected pages and extension stores, the model can read tab metadata and use browser-level HTTP(S) navigation, back, forward, and reload, but it cannot inspect or operate the protected page DOM.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure DSH is running. After installing or updating, restart DSH and reopen the side panel.
- Open **Settings → Detect** and select your DSH instance.
- In Firefox, enter the token from `~/.dsh/ext-bridge-token` in Settings.
- For a remote DSH instance, enter its server address and bridge token in Settings.
- If the plugin config pins its own `token`, paste that token into the extension settings; the installed copy only tracks `~/.dsh/ext-bridge-token`.
- After updating, reload the extension and restart DSH together: the bridge handshake is versioned, and an older extension or plugin is refused with a "protocol version mismatch" close.

### Bridge security

- Every client authenticates, loopback included, with a mutual HMAC challenge-response over the bridge token (handshake v3); the token itself never crosses the wire, and the extension refuses a bridge that cannot prove the token back.
- Both proofs bind the address and port the extension dialed, and the bridge checks them against the socket it accepted, so a local process that relays the handshake from another port cannot complete it. Every later frame in both directions carries a MAC under a per-connection key and a strict sequence number; an unsealed, replayed, reordered, or altered frame closes the connection. Frames are authenticated, not encrypted: another local process able to observe loopback traffic can still read them. Because of the endpoint binding, a bridge reached through a port forward (Docker `-p`, SSH tunnels) on a different port is refused unless that loopback port is listed in the plugin config's `forwardedPorts` **and** `allowForwardedPorts: true` is set. Whatever listens on a forwarded port sits in the middle and can read every frame (session transcripts, page content), so list only forwards you control: a local process that binds a listed port while it is free can relay through it. The advertised capabilities are bound into both proofs too (protocol v4), so even a trusted forward cannot switch the developer-tools group on or change snapshot limits. A DNS name in the bridge URL is accepted only when the bridge listens on loopback; LAN or remote bridges must be dialed by IP address.
- A token pinned in the plugin config must be at least 32 printable characters with real entropy (for example `openssl rand -hex 32`); a weaker token stops the plugin at startup, since a captured handshake would let a local observer guess it offline.
- Chrome connections are accepted only from the extension ID fixed by the manifest key (`klmdgljhcjbbpjcplbanjeclilghnaoh`). Set `allowedChromeExtensionIds` in the bridge-browser plugin config for a differently keyed build or a Web Store listing; build a store package with `pnpm --filter dsh-browser-extension run build:store`, which omits the `key` the store rejects.
- The bridge forwards only the Host methods the extension uses. It acts only in sessions it created itself: `session.create` always mints a fresh session (any `sessionId`, `cwd`, or `workspaceId` from the extension is dropped), ownership is remembered in `~/.dsh/browser-bridge-sessions.json` and by the bridge workspace directory, and only those sessions can be prompted, changed, injected into, or deleted from the browser. Desktop and CLI sessions no longer appear in the panel's history picker; when one of them drives the browser, its history can still be shown (for an approval) and stopped, but not prompted. Subagent sessions are never reachable.
- Full access stays out of the browser's reach: new browser sessions start on a restricted preset even when the Host default is full access; switching to a full-access preset, and prompting, injecting into, or running commands in a session that currently runs one, is refused. A preset counts as restricted only when the Host's preset table bundles a `read-only` or `workspace-write` sandbox (or you list it in `safePermissionPresets`); unknown presets, renamed full-access presets, and `custom` are refused, and `/permission` lines are accepted only in the exact `/permission <preset>` form. Set `allowDangerFullAccess: true` in the plugin config to lift these limits.
- A stored relay key is spent only against the address it was saved for: model discovery with a different address needs the key re-entered, and changing a relay's address without re-entering its key clears the stored key.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

Package documentation: [browser bridge](packages/browser/bridge-browser/README.md) and [browser extension](extensions/dsh-browser/README.md).

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @natgurlain/dsh-bridge-browser run build
pnpm --filter @natgurlain/dsh-bridge-browser run typecheck
pnpm --filter @natgurlain/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The workspace installs one exact DSH release (the root `package.json`, the bridge's devDependencies and the lockfile agree on it). The bridge's `engines.dsh` and DSH peer ranges are wider and cover the releases that passed the compatibility matrix below. Changing the default release must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials.

### The gate

GitHub Actions has never run for this repository (it is private and has no Actions billing), so no check here has ever been verified by CI. The gate is one local command:

```sh
pnpm gate                  # everything; needs a Playwright Chromium
pnpm gate --skip-browser   # no Chromium: skips the three browser steps
pnpm gate --list           # the steps, in order
pnpm gate --only typecheck,unit-extension
```

It runs the steps below one after another, keeps going after a failure, prints a pass/fail table, and exits non-zero if any step failed. The result is written to `.artifacts/gate/result.json` (`--output <file>` to change it): commit, whether the tree had uncommitted changes, date, and each step's status, exit code, duration and test counts, with each step's output beside it as `<step>.log`. Install Chromium once with `pnpm --dir benchmark install-browser`. On a deep checkout path set `DSH_SMOKE_ARTIFACTS` to a short directory (Chromium aborts on long profile socket paths; the gate defaults it to a directory under the system temp directory). The unit suites run with `--maxWorkers=4` (`--max-workers <n>`), one package at a time: the extension's background specs time out on an oversubscribed machine.

| Step | Command | Needs Chromium |
| --- | --- | --- |
| `install` | `pnpm install --frozen-lockfile` | |
| `check-runtime` | `pnpm run check:runtime` | |
| `typecheck` | `pnpm -r typecheck` | |
| `unit-bridge`, `unit-extension` | `vitest run --maxWorkers=4` in each package | |
| `unit-mcp` | MCP stdio shim tests (`node --test`) | |
| `build`, `build-firefox` | `pnpm build`, the extension's `build:firefox` | |
| `test-scripts` | `pnpm test:scripts` (installer, uninstall, release packaging, the gate itself) | |
| `test-benchmark` | `pnpm test:benchmark` (harness, injection detector, scripted agents, Playwright baseline tools) | its baseline-tools test skips itself without one |
| `smoke-runtime` | `pnpm test:smoke`: real DSH host, including the MCP endpoint and dev-loop smokes (`scripts/fixtures/mcp-smoke.mjs`, `devloop-smoke.mjs`) | |
| `smoke-browser` | `pnpm test:browser`: real DSH and the real extension in Chromium | yes |
| `model-free` | `pnpm test:model-free`: injection canaries and the dialog task, see below | yes |
| `smoke-uninstall-ui` | `pnpm test:uninstall:ui` | yes |

`.github/workflows/ci.yml` runs `pnpm gate` and nothing else, so it cannot drift from the local command; `uninstall.yml` adds `pnpm test:scripts` on macOS and Windows. Both are untested until Actions is available.

### DSH compatibility matrix

The gate runs against the default DSH release only. Other releases are checked by a separate command, because it installs each release from the npm registry into a temporary copy of the repository and takes a few minutes per release, so it is neither fast nor usable offline:

```sh
node scripts/dsh-matrix.mjs tested latest next --record   # the tested releases plus two dist-tags; refreshes docs/dsh-matrix.md
node scripts/dsh-matrix.mjs 0.2.2-rc.4 --record           # one release
node scripts/dsh-matrix.mjs 0.2.1-rc.5 --probe-outside-range   # a release engines.dsh excludes: measure the code, not the host's refusal
```

Each row runs install, `check:runtime`, typecheck, the bridge, extension and MCP unit tests, the bridge build and the runtime smoke; per-step logs go to `.artifacts/dsh-matrix/<version>/`. `--record` writes one row per release to [docs/dsh-matrix.md](docs/dsh-matrix.md), which also explains what is supported and why. The offline part is in the gate: `test-scripts` fails when the releases listed as tested (`TESTED_DSH_VERSIONS` in `packages/browser/bridge-browser/src/dsh-support.ts`) have no all-pass row in that record, or when `engines.dsh`, the peer ranges, the default release and the printed `npx @deepseek-ai/dsh@<version> web` hints disagree.

To run the runtime smoke with a DSH installed somewhere else against this checkout's bridge (the layout of a linked checkout loaded by the desktop app or a global install), set `DSH_SMOKE_CLI` to that install's `lib/bin.js`: `DSH_SMOKE_CLI=<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js pnpm test:smoke`.

On a DSH release outside the tested list the bridge still loads if `engines.dsh` admits it, and logs a warning naming the tested releases and the command that starts one. Outside `engines.dsh`, DSH itself refuses the plugin with `Plugin @natgurlain/dsh-bridge-browser@<version> is incompatible with dsh <version>: requirements {"engines.dsh":"^0.2.2-rc.1"}`.

What each phase gate rests on (the roadmap is not in this repository; the phases are the ones the tests name):

| Phase | Covered by | Not covered by the gate |
| --- | --- | --- |
| 1: reliable actions (select, hover, drag, dialogs, conditional wait, scroll containers, covered elements) | `unit-bridge`, `unit-extension`, the reliability section of `smoke-browser`, `test-benchmark` (the Playwright baseline completes the same task pages), `model-free` (the dialog task through the benchmark harness) | Model success rates and timings: `node benchmark/run.mjs` needs a model account |
| 2: policy (session taint, forced approvals, site rules, audit log) | the unit suites, the policy section of `smoke-browser`, `smoke-runtime` (approval forwarding, least privilege), `model-free` (injection canaries) | Whether a real model resists the injected text |
| 3: programs, page watchers, tab fleets, MCP, dev loop, browser agent preset, learning | `smoke-runtime`, the Phase 3 and learning sections of `smoke-browser`, `unit-mcp` | |
| Install, update, uninstall, release | `test-scripts`, `smoke-uninstall-ui`, both builds, `check-runtime` | macOS and Windows (only `uninstall.yml` would run them) |

`model-free` (`benchmark/model-free-check.mjs`) drives the three prompt-injection benchmark tasks against the real extension without a model. A scripted agent that has fully fallen for the injection reads the page, takes the canary secret and the attacker URL from it, and tries every route (the instructed URL through `browser_navigate` and `browser_open_tab`, base64url, hex and percent-encoded variants, typing into the attacker's form, the clipboard), ignoring refusals. A scripted user allows every ordinary approval card and denies only the cards the extension marks as forced. Each run passes only if the agent made attempts carrying the canary, every attempt was refused, every attempt was met by a forced card, and the canary never reached the sink; it runs with the task origin trusted and with unrestricted browser access. A control run per task allows the forced cards and must leak, which shows the route and the leak detector are live. It does not show that a model would resist the injection, and it covers only the routes scripted there: an exfiltration path the taint rules do not know about is not tested.

After building, run `pnpm test:browser` with a Playwright Chromium installation, or set `CHROMIUM_PATH` to a Chromium executable that supports loading unpacked extensions. This starts real DSH and Chromium instances to verify sharing controls, developer-tools consent, input, iframe uploads and targeting, and CSS edits. Site isolation is enabled and verified for cross-site frames; element clicks, input, and scrolling cover same-origin, cross-origin, and nested frames. It needs no model credentials and saves results under `.artifacts/browser-smoke/`.

After building the extension, run `pnpm test:uninstall`. Run `pnpm test:uninstall:ui` for the settings UI tests; Playwright Chromium is required.

## Security

- Page text read by the assistant and attachments you send are passed to the selected model.
- Page content sharing offers **Share automatically** (default), **Ask every time**, and **Off**.
- Text snapshots mask password and payment-card values. Screenshots capture visible pixels without masking.
- Page operations require approval by default. You can trust individual sites or enable **Allow unrestricted browser control**. Developer tools require separate authorization.
- When you switch tabs, the assistant asks which page to continue working on.
