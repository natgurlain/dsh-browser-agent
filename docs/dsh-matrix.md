# DSH compatibility matrix

Which DSH releases the bridge was run against, and how each did. The table is
written by `node scripts/dsh-matrix.mjs <targets> --record`; edit the text
around it, not the rows. A rerun replaces the row for each version it runs and
keeps the others.

## What is supported

- **Tested:** DSH 0.2.2-rc.1, 0.2.2-rc.2 and 0.2.2-rc.3. Each has an all-pass
  row below. The list lives in `TESTED_DSH_VERSIONS`
  (`packages/browser/bridge-browser/src/dsh-support.ts`);
  `scripts/tests/dsh-matrix.test.mjs` fails when a version is listed there
  without an all-pass row here.
- **Default:** 0.2.2-rc.2. The root `package.json`, the bridge's
  devDependencies and `pnpm-lock.yaml` install exactly this release, and the
  installers' "start the pinned version" hint names it.
- **Declared range:** `engines.dsh` and every DSH peer dependency of the bridge
  are `^0.2.2-rc.1`, that is `>=0.2.2-rc.1 <0.3.0-0`. DSH checks `engines.dsh`
  before it loads a plugin and counts prereleases, so 0.2.2-rc.0 and older are
  refused and 0.3.0 is refused. The lower bound is the oldest tested release.
  The upper bound is wider than the tested list on purpose: a newer 0.2.x
  loads, and the bridge logs a warning that names the tested releases, rather
  than being refused until someone reruns the matrix.

## What 0.2.2-rc.1 lacks

0.2.2-rc.1 is the release the DeepSeek Harness desktop app shipped on
2026-11-15. The bridge works on it with two features off, because the host
does not have them:

- **Continue after a failed turn.** rc.1 has no `conversationContinuation`
  projection, so the side panel does not offer Continue after a transport
  failure.
- **Waiting for worktree cleanup on delete.** rc.1 has no
  `worktrees.cleanupOf` and no `worktree/cleanup` event. Deleting a session
  archives it and removes its data without waiting for the host's worktree
  cleanup or reporting its failure.

The runtime smoke checks the degraded behaviour on rc.1 and says so in its
last line (the row's note repeats it). On any other release a host without
these features fails the smoke; that is why the 0.2.2-alpha.3 row fails.

The rc.1 row installs every DSH package at rc.1. The desktop-app layout is
different: the host is rc.1, and the bridge is a linked checkout whose own
`node_modules` holds the default release. That layout was run once by hand on
2026-11-15 at commit c4e594a and passed:

```sh
# <dir> holds an install of @deepseek-ai/dsh@0.2.2-rc.1
DSH_SMOKE_CLI=<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js pnpm test:smoke
```

Not covered by any row: the desktop app itself (only the npm release of the
host was run, on Linux), and the browser smoke (`pnpm test:browser`) on any
release other than the default.

## Releases that fail

- **0.2.2-alpha.3** (`alpha`): `check:runtime` fails (the root and the host
  resolve different copies of the session projection cache), and the smoke
  stops because the host has no archive-cleanup report and is not a release
  the smoke allows that for. Typecheck, unit tests and build pass. Not
  supported; `engines.dsh` excludes it.
- **0.2.1-rc.5**: does not compile (`ToolRuntime.definitions` is missing) and
  has no `@deepseek-ai/dsh-tool-executor-native`. Not supported.

Before commit c4e594a, 0.2.2-rc.1 failed too: `tsc` reported
`session-purge.ts: Property 'inspectSession' does not exist on type
'SessionQueryEngine'` and `Property 'cleanupOf' does not exist on type
'WorktreeService'`, and the tab fleet and `delegate_browser_task` failed at
run time with `Cannot read properties of undefined (reading 'maxDepth')`
because rc.1's `subagents.startActivation` takes the task under `request`.

## Reading the table

Dist-tags on 2026-11-15: `latest` 0.2.2-rc.1, `next` 0.2.2-rc.3, `alpha`
0.2.2-alpha.3. "In `engines.dsh`: no" rows were run with
`--probe-outside-range`, which rewrites `engines.dsh` in the temporary copy so
the code is measured instead of the host refusing the plugin. `not run` under
Install is the default release, which runs in place against the committed
lockfile. Rows for releases other than the default need the npm registry.

<!-- dsh-matrix:begin -->
| DSH version | Target | Run (UTC) | Bridge commit | In `engines.dsh` | Install | check:runtime | Typecheck | Bridge unit tests | Extension unit tests | MCP shim tests | Bridge build | Runtime smoke | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.2.2-rc.3 | next | 2026-11-15 20:40 | c4e594a | yes | pass | pass | pass | pass (622 passed) | pass (1277 passed) | pass (17 passed) | pass | pass |  |
| 0.2.2-rc.2 | pin | 2026-11-15 20:37 | c4e594a | yes | not run | pass | pass | pass (622 passed) | pass (1277 passed) | pass (17 passed) | pass | pass |  |
| 0.2.2-rc.1 | latest | 2026-11-15 20:38 | c4e594a | yes | pass | pass | pass | pass (622 passed) | pass (1277 passed) | pass (17 passed) | pass | pass | not published at 0.2.2-rc.1, removed from the copy: `@deepseek-ai/dsh-error`; smoke-runtime passed with a gap: DSH 0.2.2-rc.1 lacks archive-cleanup and continuation: continuation after the transport failure and the worktree cleanup wait, failure and retry were NOT exercised |
| 0.2.2-alpha.3 | alpha | 2026-11-15 20:43 | c4e594a | no | pass | FAIL (exit 1) | pass | pass (622 passed) | pass (1277 passed) | pass (17 passed) | pass | FAIL (exit 1) | not published at 0.2.2-alpha.3, removed from the copy: `@deepseek-ai/dsh-error`; outside the declared `engines.dsh` (`^0.2.2-rc.1`): probed with it rewritten to `0.2.2-alpha.3` in the copy; check:runtime: AssertionError [ERR_ASSERTION]: root and host must resolve the same cache; smoke-runtime: AssertionError [ERR_ASSERTION]: DSH 0.2.2-alpha.3: unexpected archive-cleanup support (worktrees.cleanupOf missing) |
| 0.2.1-rc.5 | version | 2026-11-15 20:44 | c4e594a | no | pass | FAIL (exit 1) | FAIL (exit 1) | FAIL (exit 1; 616 passed) | pass (1277 passed) | pass (17 passed) | FAIL (exit 1) | skipped | not published at 0.2.1-rc.5, removed from the copy: `@deepseek-ai/dsh-error`, `@deepseek-ai/dsh-tool-executor-native`; outside the declared `engines.dsh` (`^0.2.2-rc.1`): probed with it rewritten to `0.2.1-rc.5` in the copy; check:runtime: AssertionError [ERR_ASSERTION]: root and host must resolve the same cache; typecheck: src/browser-preset.ts(46,29): error TS2339: Property 'definitions' does not exist on type 'ToolRuntime'.; bridge unit tests: Error: Cannot find package '@deepseek-ai/dsh-tool-executor-native' imported from ./packages/browser/bridge-browser/tests/composition.spec.ts; bridge build: src/browser-preset.ts(46,29): error TS2339: Property 'definitions' does not exist on type 'ToolRuntime'. |
<!-- dsh-matrix:end -->
