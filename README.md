# dsh Browser Agent

> Based on [dsh-browser](https://github.com/omdsh-dev/dsh-browser) by Yuxiang Lin and contributors (MIT). See [NOTICE](NOTICE).

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Pages become structured text with a numbered inventory of interactive elements. Tools address elements by number or selector; `browser_screenshot` captures the controlled tab's viewport after approval. The side panel also accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support.

> [!IMPORTANT]
> The workspace is pinned to DSH 0.2.2-rc.2.

## Quick install

The installer installs the bridge plugin and Chrome extension. It downloads the current `main` branch and builds it from source; it does not use the release assets or verify checksums yet (see [RELEASING.md](RELEASING.md)).

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

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

Run the [quick install command](#quick-install) to install or update. The installer opens `chrome://extensions`; load `~/.dsh/browser-extension` as an unpacked extension the first time, or click **Reload** after an update. Restart dsh if it is already running.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/natgurlain/dsh-browser-agent.git
cd dsh-browser-agent
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

### Uninstall

Open **Settings → Uninstall dsh-browser** in the extension, copy the command, and run it in Terminal.

You can also run it directly. On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/uninstall.sh | bash
```

On Windows:

```powershell
& { $ErrorActionPreference = 'Stop'; $d=New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('dsh-browser-uninstall.'+[Guid]::NewGuid().ToString('N'))); try { $s=Join-Path $d.FullName 'uninstall.ps1'; Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/natgurlain/dsh-browser-agent/refs/heads/main/scripts/uninstall.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s } finally { Remove-Item -LiteralPath $d.FullName -Recurse -Force } }
```

From a checkout, run `bash scripts/uninstall.sh` or `.\scripts\uninstall.ps1`.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox add-ons are not installed by the installer, so copy the bridge token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is:

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
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials. CI runs these checks on every push to `main` and every pull request (`pnpm install --frozen-lockfile` with a cached pnpm store), together with `pnpm test:scripts` on Linux, macOS and Windows and `pnpm test:benchmark`.

After building, run `pnpm test:browser` with a Playwright Chromium installation, or set `CHROMIUM_PATH` to a Chromium executable that supports loading unpacked extensions. This starts real DSH and Chromium instances to verify sharing controls, developer-tools consent, input, iframe uploads and targeting, and CSS edits. Site isolation is enabled and verified for cross-site frames; element clicks, input, and scrolling cover same-origin, cross-origin, and nested frames. It needs no model credentials and saves results under `.artifacts/browser-smoke/`.

After building the extension, run `pnpm test:uninstall`. Run `pnpm test:uninstall:ui` for the settings UI tests; Playwright Chromium is required.

## Security

- Page text read by the assistant and attachments you send are passed to the selected model.
- Page content sharing offers **Share automatically** (default), **Ask every time**, and **Off**.
- Text snapshots mask password and payment-card values. Screenshots capture visible pixels without masking.
- Page operations require approval by default. You can trust individual sites or enable **Allow unrestricted browser control**. Developer tools require separate authorization.
- When you switch tabs, the assistant asks which page to continue working on.
