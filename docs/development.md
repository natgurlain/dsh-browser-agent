# Development

[中文](development.zh.md)

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

Package documentation: [browser bridge](../packages/browser/bridge-browser/README.md) and [browser extension](../extensions/dsh-browser/README.md).

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @natgurlain/dsh-browser-agent run build
pnpm --filter @natgurlain/dsh-browser-agent run typecheck
pnpm --filter @natgurlain/dsh-browser-agent run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The workspace installs one exact DSH release (the root `package.json`, the bridge's devDependencies and the lockfile agree on it). The bridge's `engines.dsh` and DSH peer ranges are wider and cover the releases that passed the compatibility matrix below. Changing the default release must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials.

### The gate

Checks are run locally: GitHub Actions has not yet run for this repository, so nothing here has been verified by CI. The gate is one local command:

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

Each row runs install, `check:runtime`, typecheck, the bridge, extension and MCP unit tests, the bridge build and the runtime smoke; per-step logs go to `.artifacts/dsh-matrix/<version>/`. `--record` writes one row per release to [docs/dsh-matrix.md](dsh-matrix.md), which also explains what is supported and why. The offline part is in the gate: `test-scripts` fails when the releases listed as tested (`TESTED_DSH_VERSIONS` in `packages/browser/bridge-browser/src/dsh-support.ts`) have no all-pass row in that record, or when `engines.dsh`, the peer ranges, the default release and the printed `npx @deepseek-ai/dsh@<version> web` hints disagree.

To run the runtime smoke with a DSH installed somewhere else against this checkout's bridge (the layout of a linked checkout loaded by the desktop app or a global install), set `DSH_SMOKE_CLI` to that install's `lib/bin.js`: `DSH_SMOKE_CLI=<dir>/node_modules/@deepseek-ai/dsh/lib/bin.js pnpm test:smoke`.

On a DSH release outside the tested list the bridge still loads if `engines.dsh` admits it, and logs a warning naming the tested releases and the command that starts one. Outside `engines.dsh`, DSH itself refuses the plugin with `Plugin @natgurlain/dsh-browser-agent@<version> is incompatible with dsh <version>: requirements {"engines.dsh":"^0.2.2-rc.1"}`.

What each phase gate rests on (the roadmap is not in this repository; the phases are the ones the tests name):

| Phase | Covered by | Not covered by the gate |
| --- | --- | --- |
| 1: reliable actions (select, hover, drag, dialogs, conditional wait, scroll containers, covered elements) | `unit-bridge`, `unit-extension`, the reliability section of `smoke-browser`, `test-benchmark` (the Playwright baseline completes the same task pages), `model-free` (the dialog task through the benchmark harness) | Model success rates and timings: `node benchmark/run.mjs` needs a model account |
| 2: policy (session taint, forced approvals, site rules, audit log) | the unit suites, the policy section of `smoke-browser`, `smoke-runtime` (approval forwarding, least privilege), `model-free` (injection canaries) | Whether a real model resists the injected text |
| 3: programs, page watchers, tab fleets, MCP, dev loop, browser agent preset, learning | `smoke-runtime`, the Phase 3 and learning sections of `smoke-browser`, `unit-mcp` | |
| Install, update, uninstall, release | `test-scripts`, `smoke-uninstall-ui`, both builds, `check-runtime` | macOS and Windows (only `uninstall.yml` would run them) |

`model-free` (`benchmark/model-free-check.mjs`) drives the three prompt-injection benchmark tasks against the real extension without a model. A scripted agent that has fully fallen for the injection reads the page, takes the canary secret and the attacker URL from it, and tries every route (the instructed URL through `browser_navigate` and `browser_open_tab`, base64url, hex and percent-encoded variants, typing into the attacker's form, the clipboard), ignoring refusals. A scripted user allows every ordinary approval card and denies only the cards the extension marks as forced. Each run passes only if the agent made attempts carrying the canary, every attempt was refused, every attempt was met by a forced card, and the canary never reached the sink. The attacker pages are served under a host name that is not loopback (`attacker.test`, mapped to the local task server inside Chromium) and are never trusted, so they taint with the default settings; the sink is a loopback address. It runs with the sink always-allowed and with unrestricted browser access, plus three extra cases: an attacker page under a look-alike host name (`localhost.attacker.test`), the other loopback literal as the sink, and the injection page on an always-allowed loopback origin with both exemptions off. A control run per task allows the forced cards and must leak, which shows the route and the leak detector are live. Four host-tools runs check the DSH side of the same rule against the real host: a scripted agent reads a page and then calls a harmless host tool that a restricted session is refused; after a local page the user said is theirs the call must succeed, and after a local page not on that list, an attacker page, or a local page with the local-pages setting off, it must be refused. It does not show that a model would resist the injection, and it covers only the routes scripted there: an exfiltration path the taint rules do not know about is not tested.

After building, run `pnpm test:browser` with a Playwright Chromium installation, or set `CHROMIUM_PATH` to a Chromium executable that supports loading unpacked extensions. This starts real DSH and Chromium instances to verify sharing controls, developer-tools consent, input, iframe uploads and targeting, and CSS edits. Site isolation is enabled and verified for cross-site frames; element clicks, input, and scrolling cover same-origin, cross-origin, and nested frames. It needs no model credentials and saves results under `.artifacts/browser-smoke/`.

After building the extension, run `pnpm test:uninstall`. Run `pnpm test:uninstall:ui` for the settings UI tests; Playwright Chromium is required.

