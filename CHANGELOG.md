# Changelog

Each `## vX.Y.Z` section becomes the notes of that GitHub release
(`scripts/package-release.mjs --notes`), followed by the SHA-256 digests of its assets.

## v0.3.7

Fixes from a review of v0.3.6.

- **Auto approve now reviews page JavaScript, as v0.3.6 said it would.** Developer-tools
  calls did not hand their arguments to Auto approve, so page JavaScript, style and
  attribute changes on your local page still showed a card. The reviewer now gets them.
- **The reviewer sees everything that decides what a script does.** Besides the code it is
  shown the full target selector, the frame, whether a style change edits a whole
  stylesheet rule, and whether JavaScript waits for a promise. A hidden line break
  (U+2028) shows as a real one, and invisible Unicode tag characters are removed.
- **A frame with no web address of its own no longer counts as your local page.** A `data:`,
  `about:blank` or sandboxed frame used to count as the page around it, so a third-party
  widget that turned itself into a `data:` page could be read without pausing coding. Such
  a tab now pauses coding and keeps its developer-tools cards. `srcdoc` frames, which the
  page writes itself, still count as the page.

## v0.3.6

Coding no longer stops after the agent uses the browser on your own local page, and Auto
approve works for conversations started in DeepSeek Harness.

- **Clear works for every conversation.** The banner's **Clear** used to be refused for a
  conversation started in DeepSeek Harness rather than in the side panel, so shell and file
  tools stayed paused until DSH restarted. It now resumes them for any conversation.
- **Your own local pages don't pause coding.** Screenshots, PDFs, console logs, page
  JavaScript and element inspection no longer pause shell and file tools when every frame
  in the tab is a local address you confirmed (or a site you trust). Network captures and
  downloads still pause them, because they carry other sites' responses.
- **"Start conversations in Auto approve" applies everywhere.** It used to cover only
  conversations started in the side panel; it now covers conversations started in DeepSeek
  Harness too.
- **Auto approve covers developer tools on your local pages.** On a confirmed local page,
  reads run without a card, and page JavaScript, style and attribute changes go to the
  reviewer, which now sees the code itself and refuses anything that sends data out. Other
  pages, and anything too long to show the reviewer, keep the card.
- **No error for conversations the side panel can't answer.** For a conversation started
  in DeepSeek Harness the panel now says to reply there, instead of showing an error.

## v0.3.5

- **The plugin package is `@natgurlain/dsh-browser-agent`.** It carries the author's npm
  scope, like the project's other packages. It was `dsh-browser-agent` from v0.3.1 to
  v0.3.4; that name is deprecated on npm and gets no further versions. The repository, the
  extension's name and the release file names have not changed.
- **Updating.** Run the installer as usual. It removes the registration under either
  earlier name from the web profile and the DeepSeek Harness desktop app and adds the new
  one, so exactly one bridge stays registered. Settings saved for an earlier name in DSH's
  plugin settings (for example `autoReview: false`) are carried over. The extension does
  not depend on the package name, so an older extension keeps working with this plugin.
  If you added the plugin with DSH's own plugin command, remove the old package first:
  `dsh plugin --profile web remove dsh-browser-agent`.
- **Releases publish the plugin to npm on their own.** The release workflow publishes the
  same checksummed package the GitHub release carries, by npm trusted publishing, with no
  token stored anywhere.

## v0.3.4

- **No more failed `web_fetch` step after reading a page.** Once a conversation has read a
  web page, fetching and searching the web directly are paused together with shell and file
  tools. The agent used to find that out by trying, which showed as a *Failed* step, and was
  then told to ask you. It is now told up front to open further pages in the browser, and a
  refused fetch or search points it there. What is paused has not changed.
- **A video instead of the screenshot in the README.**

## v0.3.3

One name everywhere.

- **The extension is called `dsh-browser-agent`.** The browser's extensions page, the side
  panel's title, the pairing card in DSH and the installer and uninstaller messages now use
  the same name as the repository and the package, in English and Chinese. It was shown as
  "dsh Browser Agent" before. Nothing else changes: update with the installer as usual and
  reload the extension. The uninstaller still recognises an extension installed under the
  earlier name.

## v0.3.2

Rough edges in everyday use, most of them seen while recording the demo.

- **"Do the remaining N" under Auto approve runs without a card.** Your click on the offer in
  the panel is your request: the reviewer is told so by the bridge, from the click itself and
  never from page or model text. A series that types into fields runs without a card too: a
  program's approval answer is fixed text and no longer counts as a web page the conversation
  read. Each step still counts as a read of the page it touches, so typing is checked as
  before once the conversation holds content from another site.
- **A click that submits a form is "Done".** A submit that navigates away was shown as
  *Failed* in the step timeline although it had saved.
- **No "Follow your current page?" for the agent's own tab.** The question no longer flashes
  when the agent opens a tab itself.
- **The thread keeps following the newest message** when a banner appears in the middle of a
  turn or you scroll inside a card.
- **The status line lists only the sites that were read.** Your own local pages and sites you
  trust are no longer named as sources.
- **The "AI controlling · Stop" pill and frame** show only while a turn acts on the tab, not
  before you have asked for anything.
- **Narrow panel.** The connection status fits a panel about 360 px wide (a dot only).
- **Step timeline.** Rows no longer blink or lose their open details when a new step or a
  screenshot arrives.

## v0.3.1

The plugin package has the repository's name, and Auto approve is quieter.

- **Plugin package `dsh-browser-agent`.** The bridge plugin is now `dsh-browser-agent` on
  npm, the same name as the repository. The old package `@natgurlain/dsh-bridge-browser`
  ends at 0.2.1 and is deprecated in favour of `dsh-browser-agent`. The plugin file in the
  release is `dsh-browser-agent-plugin-v0.3.1.tgz`.
- **Updating.** Run the installer as usual. It removes the registration under the old name
  from the `web` profile and the DeepSeek Harness app's `desktop` profile and registers the
  new one, so exactly one bridge stays registered. Settings saved for the old name in DSH's
  plugin settings (for example `autoReview: false`) are carried over to the new name.
  Pairings, the bridge token, workflows, schedules and the audit log are kept: none of them
  depends on the package name, and a v0.3.0 extension works with the renamed plugin.
- **Plugin-only installs.** If you added the plugin with `dsh plugin add`, remove the old one
  first (`dsh plugin --profile web remove @natgurlain/dsh-bridge-browser`); see the README.
- **Quieter status under Auto approve.** While Auto approve is on, the yellow "this
  conversation read web pages" banner is replaced by one slim neutral line (*Web pages read ·
  shell and file tools paused*) with the same *Clear*; click it for the full explanation. With
  Auto approve off the banner is unchanged. Nothing about what is restricted has changed.

## v0.3.0

Auto approve: an opt-in mode in which the agent works without asking. It is off by default,
and with it off nothing changes from v0.2.1. With it on, a web page that tricks the model can
make the agent do things you did not ask for; the first-time confirmation and the Setting say
so.

- **Auto approve.** Like DeepSeek Harness's auto-approve: click *Auto approve* under the
  message box and the agent works without asking. Ordinary steps (navigate, click, type,
  choose, search, read, open tabs) run at once with no card and no extra model call.
  Consequential steps (send, delete, POST submit, publish, unsubscribe, transfer, pay, buy,
  password and payment fields, files, programs, watchers, and steps the taint rules flag
  after reading web pages) are first checked silently by the conversation's own model;
  if it objects, times out or fails, the usual card shows with its one-line reason. Stays
  on for the conversation until turned off; Settings → *Start conversations in Auto
  approve* (off by default). Still asks: developer tools, the first download, sites set to
  *Always ask*, strict mode, MCP conversations. Every auto-approved step is marked *Auto*
  in the timeline and the audit log. Managed policy `disableAutoReview`, bridge config
  `autoReview`. Design and honest limit: `docs/auto-approve-design.md`.

## v0.2.1

One version number for everything. The bridge plugin `@natgurlain/dsh-bridge-browser` now
carries the same version as the extension and the release (it was 0.1.0 inside v0.2.0), and a
test keeps the two in step.

- **Plugin package for npm.** The plugin package is `@natgurlain/dsh-bridge-browser`, with
  keywords and repository links so plugin lists and indexes can find it.
- **Plugin-only install.** The README describes adding the plugin with `dsh plugin add` from
  the release file and pairing an extension loaded from the release zip, for people who
  prefer DSH's own plugin command to the installer.
- No change in behaviour from v0.2.0.

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
  approval covers that action only. For an action on an element the card names it, for
  example "Click checkbox “Email notifications”", read from the page when the card is
  raised, and the page outlines that element while the card is open. If the element
  changes before you answer, the approval does not apply.
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
- The learning features are experimental and off by default.
- GitHub Actions has not run for this repository; the checks were run locally with
  `pnpm gate`.
