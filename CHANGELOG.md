# Changelog

Each `## vX.Y.Z` section becomes the notes of that GitHub release
(`scripts/package-release.mjs --notes`), followed by the SHA-256 digests of its assets.

## v0.2.0

First release of dsh Browser Agent, based on [dsh-browser](https://github.com/omdsh-dev/dsh-browser)
v0.1.4 by Yuxiang Lin and contributors (MIT; see NOTICE). Version numbers here are this
project's own and start at 0.2.0. The extension is 0.2.0 and the bridge plugin is
`@natgurlain/dsh-bridge-browser` 0.1.0.

Coming from dsh-browser 0.1.4: run the installer. It removes the bridge registered under
the `@deepseek-ai/dsh-bridge-browser` and `@yuxianglin/dsh-bridge-browser` package names and
registers this one. Then reload the extension and restart DSH together: the two check each
other's protocol version when they connect.

### Install and setup

- **One command.** `./scripts/install.sh` from a checkout, or the release commands in the
  README, build the extension and the plugin, register the plugin, and open the browser's
  extensions page. No address or token has to be entered: the installer gives the installed
  extension what it needs to find and authenticate to DSH, and keeps it across updates.
- **DeepSeek Harness desktop app.** `install.sh` registers the plugin with the
  app's `desktop` profile through the CLI bundled in the app, as well as with the `web`
  profile. An app whose DSH version the plugin does not support is reported and skipped.
- **Brave and other Chromium browsers.** The installer opens the extensions page of the
  browser you have (Chrome, Chromium, Brave, Edge, Vivaldi or Arc) and names it in its
  instructions.
- **Uses the Node.js and pnpm you already have.** When the ones on PATH are missing or too
  old, the installer uses the ones bundled with the desktop app, then asdf, nvm, fnm, volta
  or mise (Corepack or `npx` for pnpm). It installs nothing by itself and says what to
  install if it finds none.
- **Verified release downloads.** A release install downloads one tagged release and
  checks every file against that release's `SHA256SUMS` before unpacking or running it. A
  mismatch, a missing `SHA256SUMS` or an incomplete download stops the install and leaves
  an existing installation untouched. `--release vX.Y.Z` picks a version; `--release
  latest` is the default outside a checkout. Installing a branch is a separate development
  option (`--unverified-branch`). What the check covers and does not cover is in
  RELEASING.md.
- **One language per run.** Installer and uninstaller print English by default and Chinese
  on a Chinese locale; `--lang en|zh` or `DSH_BROWSER_LANG` chooses.
- **Uninstaller** for macOS, Linux and Windows, also offered as a command under Settings
  in the side panel. It removes the plugin registrations (the desktop app's too), the
  installed extension and the bridge's state files, and keeps the audit log and session
  workspaces.
- **Updates.** Settings compares the running version with the latest release and shows the
  command that installs exactly that release.

### Using it

- **Dark theme**, next to light and automatic, and adjustable text size. English and
  Chinese throughout.
- **Redesigned Settings.** Seven collapsible sections (Connection, Appearance, Permissions
  & safety, Behaviour, Automation, Models & API relay, About), one row pattern, and a Save
  / Discard bar that appears only when something changed.
- **Build number on checkout builds.** An extension built from a git checkout shows, for
  example, "0.2.0 build 548 (d4ed74d)" on the extensions page, so a reload after a pull is
  visible. Release builds carry the plain version.
- **More of the page is reachable.** The numbered inventory covers shadow DOM, ARIA
  widgets, custom controls, and elements that only a script makes clickable (listed with
  the role "clickable").
- **More tools.** `browser_select`, `browser_extract` (tables to CSV or JSON), conditional
  waits, element scrolling, hover and drag, dialogs, real pointer input, downloads, PDF
  save and PDF text, and `browser_run`, which runs up to 25 approved steps behind one card.
- **Works with the side panel closed.** Tool calls and approvals reach the extension
  without an open panel. Page watchers (`browser_watch`, off until enabled) wake a session
  when something appears on a page, and `browser_fanout` reads several tabs in parallel.
- **Reconnects through a DSH restart.** With a panel open, the extension looks for DSH
  again for up to ten minutes after it goes away, including when it comes back on another
  port, and the panel keeps its conversation.
- **Seeing and steering the agent.** An on-page overlay marks each target, the panel shows
  a step timeline, and Pause and Take over hold the agent while you use the page.
- **Other harnesses.** An opt-in MCP endpoint and stdio shim let Claude Code, Cursor or
  Codex use the browser. `delegate_browser_task` and a browser subagent preset let a
  regular DSH session hand page work over.
- **DSH 0.2.2-rc.1 to 0.2.2-rc.3** are supported (0.2.2-rc.2 is the default). On
  0.2.2-rc.1, Continue after a failed turn and the wait for worktree cleanup on delete are
  unavailable. See `docs/dsh-matrix.md`.
- **Learning features (experimental, all off by default).** Save a run as a workflow,
  replay it with fresh element lookup, and schedule it. Watch me: after you repeat an
  action over two rows, "Do the remaining N like this" does the rest behind one card, in
  batches when it is more than 25 steps (up to 250), and stops before any row that no
  longer looks like the ones you approved. Site drivers and failure fixtures are described
  in the README.

### Safety

- **Mutually authenticated connection.** The extension and DSH authenticate each other on
  every connection with a shared token that never crosses the wire, bound to the address
  the extension dialed; every later frame is authenticated too. The Chrome extension ID is
  fixed by a manifest key.
- **Pairing by typed code.** An extension installed without a token (a store build, a
  release zip loaded unpacked, Firefox) shows a short code in its panel; typing it into DSH
  connects it. DSH lists paired browsers with **Unpair**, and **Reset bridge token**
  disconnects every browser at once.
- **Approval cards bound to exactly what runs.** A card shows the full action, and the
  approval covers that action only.
- **Untrusted page content (taint rules).** Once a conversation has read a web page,
  sending data to another site, the clipboard or a file asks first, and the conversation's
  shell and file-writing tools are switched off in DSH. Your own local pages and sites you
  marked trusted (https only) do not count as untrusted; both allowances can be switched
  off. A one-line banner names the sites and offers Clear.
- **Developer-tools allowance ends after 8 hours.** Running JavaScript still asks on every
  call unless trusted on its card for 30 minutes.
- **Site rules and strict mode.** Mark a site blocked, read-only, always ask or trusted;
  banking, password and cloud-console sites are read-only by default; administrators can
  set managed policy. Strict mode (Chrome) holds a page's outgoing writes at the network
  layer until you approve them.
- **Kill switch.** The stop button or its shortcut cancels pending approvals and running
  actions, revokes grants, detaches the debugger and disconnects until you press Reconnect.
  It survives restarts.
- **Tamper-evident audit log** of every action, approval and stop under
  `~/.dsh/browser-audit/`, exportable from Settings.
- **Least privilege.** The bridge forwards only the calls the extension needs and acts only
  in sessions it created; browser sessions start on a restricted permission preset.
- **MCP behind the same controls.** Calls from an MCP client pass the same approval cards,
  site rules, taint rules, kill switch and audit log, and each card names the client.

### For developers

- **`pnpm gate`**: one local command that runs install, runtime check, typecheck, the unit
  suites, both builds, the script tests, and the runtime, browser and uninstall smokes, and
  writes a result file.
- **Model-free injection check** (`pnpm test:model-free`): scripted agents that follow the
  injected instructions try every route against the real extension; each run passes only
  if every attempt is met by a forced card and the canary never leaves.
- **DSH matrix** (`node scripts/dsh-matrix.mjs`): runs the checks against several DSH
  releases and records the result in `docs/dsh-matrix.md`.
- Release packaging with deterministic archives and `SHA256SUMS`, a benchmark suite, and a
  store submission kit under `docs/store/`.

### Known limitations

- The Windows installer and uninstaller (`install.ps1`, `uninstall.ps1`) have never been
  run on Windows. `install.ps1` registers the `web` profile only.
- Firefox is built by the gate but only lightly exercised by hand; it is loaded as a
  temporary add-on and connects by pairing or by pasting the token.
- Pairing is covered by automated tests against a real DSH host; it has not yet been tried
  by hand in the desktop app, Brave or Firefox.
- The benchmark numbers in the README are dsh-browser's and have not been re-measured here.
- The learning features are experimental and off by default.
- GitHub Actions has not run for this repository; the checks were run locally with
  `pnpm gate`.
