# dsh-browser-agent

English | [中文](README.zh.md)

The plugin of [dsh-browser-agent](https://github.com/natgurlain/dsh-browser-agent). Up to v0.3.0 this package was named `@natgurlain/dsh-bridge-browser`; that name is deprecated.

The **browser-operation bridge** for dsh mounts a token-authenticated WebSocket carrier (`/ext/bridge`) for the browser extension, projects its calls onto DSH Typert Remotes, follows Session and Remote Event streams, and registers tools for reading and operating the controlled tab, capturing screenshots, and using developer tools. The browser retains its login state, and the side panel provides the conversation UI.

Page snapshots contain structured text with numbered controls and masked form fields. Actions target element numbers or selectors. Screenshots and chat images use DSH's durable attachment service; deferred sessions expose image limits when the host mounts that service.

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | `string` | generated | Fixed bearer token. When absent, a token is generated on first boot and saved to `~/.dsh/ext-bridge-token` (chmod 0600). The boot log shows the file path. |
| `pairing` | `boolean` | `true` | Let an extension without a token (a store or Brave build, Firefox) ask to pair: its panel shows a six-character code that the user types into DSH. `false` accepts only the provisioned or pasted token and the configured extension IDs. |
| `toolTimeoutMs` | `number` | 90000 | Per-tool-call budget, leaving time for the extension's 60-second approval window. |
| `snapshotMaxChars` | `number` | 32000 | Upper bound on one rendered snapshot's characters, minimum 500 (also negotiated to the extension via `hello.ok` caps). |
| `maxInteractiveItems` | `number` | 60 | Upper bound on interactive inventory items per snapshot. |
| `devToolsMaxChars` | `number` | 24000 | Upper bound on one developer-tools result's characters, minimum 500. |
| `sessionWorkspacePath` | `string` | `~/.dsh/browser-sessions` | Dedicated Host Workspace for extension-created sessions. The plugin creates and idempotently registers the directory on the first implicit `session.create`; the session cwd becomes this path, so the GUI shows a `browser-sessions` workspace group. Set `""` to keep sessions Ungrouped. |
| `deferSessionCreate` | `boolean` | `true` | Sessions materialize only on the first message: `session.create` answers with a provisional id (nothing persisted), history reads empty, and the first `session.prompt` creates the real session (same id, original payload). Opening the panel without chatting leaves zero trace in the session store/GUI. |
| `beacon` | `boolean` | `true` | Also answer the discovery endpoint on a fixed loopback port, so a randomly assigned Web port (DSH Desktop starts its host with `--port 0`) stays discoverable. Binding failures are diagnostics only; the bridge itself is unaffected. |
| `beaconPorts` | `number[]` | `43189…43198` | Candidate beacon ports, tried in order until one binds; the first free port wins, which keeps several local instances discoverable. Ignored when `beacon` is false. |
| `mcp.enabled` | `boolean` | `false` | Serve a loopback MCP endpoint (Streamable HTTP) so Claude Code, Cursor, Codex and other MCP clients can drive the browser. See [MCP clients](#mcp-clients). |
| `mcp.port` | `number` | `0` | Loopback port of the MCP endpoint (`0`: any free port; the URL is written to `~/.dsh/browser-mcp.json`). |
| `devLoop.enabled` | `boolean` | `false` | Turn the dev loop on. While off, the panel cannot list or link coding sessions and nothing is captured. See [Dev loop](#dev-loop-coding-sessions). |
| `devLoop.trustLoopback` | `boolean` | `true` | Loopback dev-loop injections do not taint the coding session. Set `false` if your dev server renders untrusted data; the bridge then also ignores taint-exemption vouchers that rest on a local page. |
| `honorTaintExemptions` | `boolean` | `true` | Honour the extension's taint-exemption vouchers (a browser result read only from the user's own local pages or from sites the user trusts does not taint its session). `false`: every browser result taints. |
| `devLoop.allowedOrigins` | `string[]` | `[]` | Extra exact origins (beyond localhost / 127.0.0.1 / [::1]) a tab may have to be linked to a coding session. See [Dev loop](#dev-loop-coding-sessions). |

Workspace grouping is best-effort. If the composition has no workspace domain, directory creation fails, or `workspace.create` rejects the path, the plugin logs one warning and sends every session creation without an injected workspace so browser chat remains usable.

## Usage

See the root README for [installation, updates, startup, and uninstall](../../../README.md#detailed-installation-and-usage).

## Development

The package declares `dsh.bundle.patch` as `./cordis.patch.yml`. The installer registers the local package in the `web` profile, which loads that patch.

The bridge and extension share one pnpm workspace. Bridge source imports `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` directly, and its DSH dependencies match the workspace's pinned release. The root build builds the bridge before the extension.

The package manifest declares that support itself: `engines.dsh` (`^0.2.2-rc.1`, the releases recorded in `docs/dsh-matrix.md`) and `dsh.manifestVersion: 1` let dsh refuse an incompatible host before loading the plugin, and the Plugins page reads the localized title and description from `locale/en.json` / `locale/zh.json` plus the icon from `icon.svg` without activating the plugin.

## Host methods the panel drives

Beyond plain gateway passthrough (`rpc`), the adapter composes a few Host
methods the side panel needs. They are the panel's only vocabulary for the
composer's permission, model, command, and skill controls, and they are never
offered to the model as tools.

| Panel method | Payload | Host work | Result |
|---|---|---|---|
| `permission.catalog` | `{}` | `permissionPresets/catalog` | `{ options, defaultOptions, defaultPreset }` |
| `session.permissions` | `{ sessionId }` | the catalog plus the Session's `permissions` projection | `{ current, defaultPreset, options, defaultOptions, routable, provisional }` |
| `session.setPermission` | `{ sessionId, preset }` | validates the preset, then `commands/execute` with `/permission <preset>` | `{ preset, commandId, result }` |
| `commands.list` | `{ sessionId }` | `commands/list` scoped to the Session's agent | `{ commands: [{ name, description, hint?, definitionId? }], provisional }` |
| `commands.execute` | `{ sessionId, line }` | `commands/execute` with the empty attachment list | `{ commandId, result }`; an unknown line is a `bad-request` |
| `skills.list` | `{ sessionId }` | `skills/list` for the Session composition | `{ skills: [{ name, description, whenToUse?, modelInvocable, path? }], provisional }` |

Opening `session.history` activates the Session through `session/follow`; requests with `beforeSeq` use `session/events` for older pages. `session/observeState` supplies the bridge's `session/state` events, and `session/observeProjections` supplies `session/projection` events with `{ sessionId, seq, changes }`.

`session.attachment` takes `{ sessionId, attachment }` with the complete image reference. When the `conversationContinuation` projection permits it and the Session is idle, the panel continues with `session.prompt` and `content: []`. Session deletion waits for the Host's archive-triggered worktree cleanup before removing its log.

Failure semantics: a Host that does not mount the permission service answers
`session.permissions` with `routable: false` instead of failing, so the panel
can hide the control; a method the deployed bridge does not implement answers
`not-found` (`… is unavailable`), which lets a newer panel degrade instead of
breaking. `commands.execute` refuses a line without the Host command grammar,
and an unknown command name from the Host is reported as `bad-request` rather
than an empty success.

## Deferred Sessions

`deferSessionCreate` (default `true`) answers `session.create` with a
provisional id and materializes the real Session on the first `session.prompt`.
Composer methods respect that: a provisional id answers `session.permissions`
from the process catalog plus the remembered choice, `session.setPermission`
records the choice, and materialization replays `/permission <preset>` before
the model selection and before the first prompt is admitted (a failure keeps
the prompt queued for retry instead of running it under the wrong policy).
`commands.list` and `skills.list` need a real agent, so a provisional id
answers empty with `provisional: true`; `commands.execute` accepts only the
permission switch and answers `provisional-session` for everything else.

## Security model

- The bridge route lives **outside** the `/api` trust fence (which only guards client-connection's routes), so it carries its own bearer-token authentication: the first frame must be `hello` with the token within 5s, verified in constant time. Failed auth closes the socket.
- Gateway methods the `/api` carrier pins to loopback (`settings.*`, `credentials.*`, `host.pickDirectory`, `host.openPath`) are refused for non-loopback remotes **even with a valid token** — defense in depth for `--host 0.0.0.0` deployments.
- One active connection at a time; a new authenticated socket replaces the previous one.
- The discovery beacon (`/ext/bridge-config` on a fixed loopback port) only names the bridge URL, the host pid, and its start time. It binds `127.0.0.1`, sends no CORS headers (a web page can see the connection but cannot read the body), rejects a `Host` header that is not `127.0.0.1`/`localhost` on that port (DNS rebinding), and never carries the bearer token. It is skipped entirely when the host binds a non-loopback interface.
- The bridge is a confused-deputy boundary, not a general auth layer: never expose `dsh web --host 0.0.0.0` on untrusted networks.
- **Session taint and its exemption.** Any `browser_*` result taints its session on the Host (shell, file-writing, network and delegation tools off until the panel's Clear), failed results included. The one exception is a result the extension vouched for: a `tool.result` frame carrying `taintExempt: true`, which the extension sets only when everything the result could quote came from the user's own loopback pages or from sites the user marked trusted, and its own record of the session is untainted (`extensions/dsh-browser/README.md`, Taint exemptions). The extension decides because only it sees which frames a result read; the bridge matches the voucher to the exact tool call (session and call id, every extension result of that call) and taints when it is missing, late, or for another call. This keeps the existing trust direction: the paired extension may lower the bridge's restriction (as its Clear does), while the agent and page content cannot, since the flag is on the authenticated frame and not in the result. A snapshot injection carries the same flag; watcher wakes, selections the extension reports, and dev-loop injections outside `devLoop.trustLoopback` always taint. A voucher that rests on a local page carries `taintExemptLocal: true`; the bridge ignores those while `devLoop.trustLoopback` is false, and every voucher while `honorTaintExemptions` is false. What it honours is sent in the server caps (`taintExemptions: { local, trusted }`), so the extension turns the matching exemption off and both records agree. A session with a vouched-exempt read is remembered: calls of its forks and subagents carry `inheritedExemptReads: true`, and the extension then counts an unknown source for them, so no origin is ever such a session's only taint source.
- Extracted page text is marked as untrusted model input. Page reads honor the extension's ask/auto/off policy, while state-changing tools require an origin-scoped side-panel decision and fail closed without a panel. Same-origin repetition can be trusted for the current panel session; permanent trust remains an explicit setting.

## Wire protocol

Frames are JSON objects discriminated by `t`, defined in [`protocol.ts`](src/protocol.ts) and shared with the extension through the workspace package's `./src/*` export. The built package exposes `dsh-browser-agent/protocol` for external consumers.

- Client → server: `hello` (auth + caps), `rpc` (gateway method passthrough), `respond` (resolve a host interaction by its RPC id), `tool.result`, `pong`.
- Server → client: `hello.ok` (echoes negotiated caps), `rpc.result`, `respond.result` (correlated acceptance or error), `event` (bridge-owned projection of dsh Remote streams and waterfalls), `tool.call`, `tool.cancel`, `ping`, `error`.

Each `respond` carries a globally unique transport id as well as the host interaction's `rpcId`. The extension routes its receipt only to the panel that initiated it and rejects pending responses on timeout, panel closure, or bridge disconnection.

## Tools

| Tool | Purpose |
|---|---|
| `browser_snapshot` | Structured text snapshot (title/URL/main/inventory/forms); `delta: true` returns only changes, `frame` reads one iframe, and `query` locates elements by text/selector/role and returns their selectors. |
| `browser_click` | Click or double-click by index or selector; supports mouse buttons and modifiers. |
| `browser_type` | Enter text by index/selector or into the focused element; `replace` selects existing content first, and `mode` chooses caret insertion or per-character keys. |
| `browser_press` | Single keys or chords (`modifiers`), `action: down/up` to hold a key across calls, `repeat` to repeat. |
| `browser_clipboard` / `browser_upload` | Write/paste text and rich HTML; attach local files to a file input (Chrome for system paste and upload). |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Page scrolling and navigation; `frame` selects an iframe for scrolling. |
| `browser_get_text` / `browser_wait` | Read regions / settle detection. |
| `browser_hover` / `browser_drag` | Real-pointer hover; drag to an element or offset (HTML5 drag-and-drop for draggable sources). |
| `browser_dialog` | Answer the JavaScript dialog blocking the tab (Chrome); blocked calls fail fast with `dialog open: …`. |
| `browser_downloads` | List or wait for downloads; returns local paths (optional `downloads` permission, asked on first use). |
| `browser_save_pdf` / `browser_pdf_text` | Save the tab as a PDF under `<sessionWorkspacePath>/pdf` (Chrome); extract the text of a PDF tab. |

Clicks, text entry, and scrolling run in the selected document, including cross-origin iframes. Chrome uses its debugger for native keyboard events, caret insertion, system paste, and file uploads. Screenshots require an active tab in a focused window; `browser_follow_tab { activate: true }` brings the controlled page to the front.

### Developer tools (high privilege)

This group is registered only while the connected extension advertises the `devTools` capability, which Chrome builds do and Firefox builds do not. Each call requires consent through **Allow developer tools** in Settings, a current side-panel session grant, or a per-call approval (allow once / trust this session / deny). Session trust expires when the last panel closes or the worker restarts. The blanket browser-control switch and the persistent origin allowlist do not cover this group.

| Tool | Purpose |
|---|---|
| `browser_devtools_elements` | Inspect an element (computed CSS, box model, matched rules, attributes) by CSS selector or `browser_snapshot` index. |
| `browser_devtools_set_element_style` / `browser_devtools_set_element_attribute` | Live-debug CSS on an element (inline style or the matched stylesheet rule) and read/set/remove one attribute. Script-capable attributes are refused. |
| `browser_console_eval` / `browser_console_logs` | Run JavaScript in the page's own context (optionally awaiting a promise) and read the console output recorded since attach. |
| `browser_devtools_network` | Start/stop/status network capture for the controlled tab. |
| `browser_devtools_list_requests` / `browser_devtools_get_request` / `browser_devtools_request_body` | List captured requests, read one in full, and fetch a request or response body. Credential headers (`Authorization`, `Cookie`, …) are redacted unless the caller opts in per call, and bodies of authentication-shaped URLs are redacted by default. |

Capture notes: Chrome allows only one debugger per tab, so the browser's own DevTools cannot stay open on a tab while capture is attached; the error names that cause. Capture is in-memory, bounded (200 requests, 500 console entries) and resets on attach and on every top-level navigation. All returned page data is untrusted input.

## MCP clients

With `mcp.enabled: true` the plugin serves an MCP endpoint at `http://127.0.0.1:<port>/mcp`. Other agent harnesses reach it through the `dsh-browser-mcp` stdio shim ([setup for Claude Code, Cursor and Codex](../mcp-server/README.md)).

While the endpoint is enabled, or while the bridge holds workflow schedules for a browser, that browser's extension keeps its bridge connection with no side panel open and reconnects by itself. The bridge says so in the `hello.ok` caps (`standing: { schedules, mcp }`, bound into the server proof) and in a sealed `bridge/standing` event when the schedule count changes; extensions that do not advertise `standingUpdates` are not sent the event. The hint only keeps the connection up: every call still passes the extension's gates.

- **Same tool path.** `tools/list` returns the registered `browser_*` definitions from `ctx.tools`, with the same schemas and descriptions DSH Agents get. `tools/call` runs those same definitions. An execution carries an external-caller marker instead of an Agent (`external-caller.ts`), so every call becomes a normal `tool.call` frame to the extension. The pause gate, site policy, taint rules, kill switch, payload-bound approval cards and the audit log all apply unchanged.
- **One external session per MCP connection.** `initialize` mints `mcp-<uuid>` and records it in the session ledger as *external*. It never counts as an owned DSH session, so every Host session method refuses it (`bridge-policy.ts`), as do snapshot injection and purge. Its audit log stays readable from the panel, and the panel may clear its taint.
- **Approvals.** Each frame carries the client's sanitized, self-reported name as `requester`. The approval card and the OS notification show "Requested by MCP client “<name>”". These approvals are never forwarded to DSH's approval service, because no DSH turn exists to ask. They are answered in the browser only.
- **Hardening.**
  - Binds `127.0.0.1` only and refuses non-loopback peers.
  - Uses a separate 0600 token (`~/.dsh/browser-mcp-token`), compared in constant time.
  - Refuses any `Origin` header (browser CSRF) and any `Host` other than the loopback address and bound port (DNS rebinding).
  - Accepts JSON bodies only, with a 1 MB cap. JSON-RPC batches are not supported.
  - Allows at most 16 sessions and expires them after 1 h idle. `DELETE` ends a session, and a dropped HTTP request cancels its call and withdraws its card.
- **Refusals.** Tools that write into a DSH workspace (`browser_save_pdf`, `browser_extract { saveTo }`) refuse MCP callers. `browser_screenshot` returns an MCP image block.

## Dev loop (coding sessions)

The dev loop is off until the Host operator sets `devLoop.enabled: true` in the bridge-browser plugin config.

In **Settings → Dev loop**, open a localhost page (`localhost`, `127.0.0.1` or `[::1]`) in the panel's window. Click "Link this tab to a coding session…" and pick one of your DSH coding sessions. Only sessions on a restricted permission preset (`read-only`, `workspace-write`, or a preset the operator lists as safe) are offered or can be linked; a session on `danger-full-access`, `auto` or an unknown preset never is, and a linked session switched to such a preset is unlinked at its next capture. The picker sees only each session's id and title (never its directory, project or run state). Bridge sessions are never offered, nor are subagent or MCP sessions. After each turn of that session that edited files (a successful `edit`, `write`, `apply_patch`, `str_replace_editor` or `notebook_edit`), the following happens:

1. The bridge sends the reserved `browser_devloop_capture` action to the extension. It is an ordinary `tool.call`, so the pause gate, kill switch, site policy, taint rules, read-approval settings and the audit log all apply. It is not a model tool, and it is never served over MCP.
2. The extension refuses the action unless that session has a link made in this browser, and unless the linked tab is still on the linked origin.
3. Otherwise it answers with:
   - the console errors, uncaught exceptions and failed `fetch`/XHR requests that a small main-world collector recorded since the previous turn;
   - a `browser_snapshot { delta: true }` of the page.

   If that page read is refused, nothing from the page is shared.
4. The bridge injects the answer into the session as read-only browser context, inside an untrusted boundary the bridge writes itself (fresh nonce per injection; any boundary text from the extension or the page stays inside it). The injection does not wake the session. The model sees it with the user's next message.

Rules that still hold:

- **Linking is not prompting.** The session still cannot be prompted, steered, re-permissioned or snapshot-injected from the browser (`bridge-policy.ts`).
- **Origins.** Only loopback origins by default. `devLoop.allowedOrigins` (exact `http(s)://host[:port]`) adds others.
- **Taint.** By default (`devLoop.trustLoopback: true`) an injection does **not** taint the coding session on the Host when every origin the capture read (the linked page and each of its frames) is loopback. That taint would make its edit tools read-only and break the loop. The source is the user's own dev server, and the payload is fenced as untrusted text. An injection that read any non-loopback origin (a third-party iframe, an allowed non-loopback origin, or a capture that cannot say which origins it read) **does** taint it. On the browser side, the capture taints that session's browser actions like any other page read.
- **Caveat.** A local dev server that renders untrusted data (user-generated content, scraped or proxied pages) can put that text into the coding session through the dev loop. For such apps, set `devLoop.trustLoopback: false`: loopback injections then taint the session like any web content.
- **Lifetime.** Links live in the bridge's memory and in the extension's session storage. After DSH restarts, opening the panel's settings re-asserts them. A link ends when its tab closes, and the kill switch removes every link on both sides.

## Browser subagent and skills

- **Agent preset `browser`.** When the Host has the agent-preset registry, the plugin registers a preset with one row, `lib/browser-preset.js`. That row restricts the agent's tools to the registered `browser_*` tools, and to `skill` when that tool is global. It re-applies the restriction when the developer-tools group comes or goes, and it adds a short role prompt. You can also start a session on the "Browser" preset directly in DSH.
- **Delegation: `delegate_browser_task { task, label? }`.** The plugin registers this tool for every agent when the Host has the subagent manager with the in-process `spawn` backend (the shipped web profile has it). The tool runs the task in a child agent on the `browser` preset and returns only the child's summary, so large page snapshots never enter the caller's context. A tainted session cannot delegate: the taint guard denies it. The child is linked into the bridge's taint lineage (its session header names the caller), so its page reads taint the caller and delegation cannot launder page content. No profile change is needed.
- **Skills.** The package ships `skills/*/SKILL.md`: `fill-form-safely`, `extract-table-to-csv`, `research-across-tabs` and `debug-localhost-page`. They are registered on `ctx.skills` as bundled skills, so the `skill` tool lists them for every session.

## Extension points

- The tool set is the consumer surface; the seam is the bridge wire (`protocol.ts`). Add tools by registering on `ctx.tools` and dispatching over the bridge; the extension's content script dispatches by action name.
- Negotiated caps (`hello.ok`) let the plugin dictate snapshot budgets to the extension without a shared config file.

## Known limitations

- One active extension connection at a time.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Token rotation is manual (edit `~/.dsh/ext-bridge-token` or set `token` in config); no expiry. An extension that obtained the token by pairing must pair again after a rotation.
- Pairing (for extensions without an installer-written token) is a password-authenticated key exchange keyed by a six-character code the extension shows and the user types into DSH; see `docs/store/README.md`. Paired extensions (Chrome IDs and Firefox origins) are kept in `~/.dsh/browser-paired-extensions.json` and can be unpaired in DSH Settings or with `/browser-pair unpair <extension>`: the extension's connection is closed and its origin refused. Unpairing does not take the token back; "Reset bridge token" (or `/browser-pair reset-token`) replaces it and disconnects every browser. A Firefox extension that is reinstalled gets a new origin, so for Firefox only the token reset is a complete cut-off.
