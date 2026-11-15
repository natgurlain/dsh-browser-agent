# Releasing

## Cutting a release

1. Bump `version` in the root `package.json`, `extensions/dsh-browser/manifest.json`,
   `extensions/dsh-browser/manifest.firefox.json` and `extensions/dsh-browser/package.json`.
   All four must match; `scripts/package-release.mjs` and
   `scripts/tests/release-consistency.test.mjs` refuse otherwise. The bridge has its own
   version: bump `packages/browser/bridge-browser/package.json` together with
   `BRIDGE_PACKAGE_VERSION` in its `src/index.ts` when the plugin changed.
2. Replace the previous tag with the new one in the install and uninstall commands of
   `README.md` and `README.zh.md` (the same test checks them), and add a `## vX.Y.Z`
   section to `CHANGELOG.md`. That section becomes the release notes.
3. Run the gates and the local dry run (below).
4. Tag and push: `git tag v0.1.5 && git push origin v0.1.5`. A tag containing `-`
   (e.g. `v0.1.5-rc.1`) is published as a prerelease, with the notes of `v0.1.5`. A
   prerelease is never what `--release latest` or the panel's update check resolves to.
5. `.github/workflows/release.yml` runs the checks and packages the assets in a `build`
   job (read-only token, no OIDC), then a separate `publish` job downloads those assets,
   re-verifies `SHA256SUMS`, attests build provenance and creates the GitHub Release with
   the notes from `CHANGELOG.md` plus the digests. The publish job never overwrites: if the
   release already has an asset of the same name the upload fails; delete the stale asset
   by hand first. It can also be started manually (Actions → Release → Run workflow) for an
   existing tag; manual runs default to a draft, and a draft is invisible to the installers
   until it is published.

To reproduce the assets locally: `node scripts/package-release.mjs --out release`
(add `--skip-build` to reuse existing `dist/`, `dist-firefox/` and bridge `lib/`,
`--installer-only` for just the files the installers download, `--notes notes.md` for the
release notes). Archives are deterministic, with timestamps fixed to the release commit, so
the same commit and build output give the same checksums.

### While the repository is private

GitHub Actions cannot run in the private repository, so `release.yml` has never executed
and step 5 does not happen on its own. Until the repository is public, publish by hand from
a clean checkout of the tag:

```sh
pnpm install --frozen-lockfile && pnpm run check:runtime && pnpm run typecheck && pnpm run test
node scripts/package-release.mjs --tag v0.1.5 --out release --notes release-notes.md
(cd release && sha256sum -c SHA256SUMS)
gh release create v0.1.5 release/* --verify-tag --title v0.1.5 --notes-file release-notes.md
```

Anonymous downloads of a private repository's release answer 404. The installers say so
and then use `DSH_BROWSER_GITHUB_TOKEN` (sent to `api.github.com` only, never printed) or
an authenticated `gh`. The panel's update check and the copy-paste commands in the README
have no credentials and keep failing until the repository is public; installing from a
checkout (`./scripts/install.sh`) needs neither a release nor the network to GitHub.

### Local dry run

`pnpm test:scripts` includes `scripts/tests/release-install.test.mjs`: it serves a release
from a temporary directory (`scripts/lib/local-release.mjs`) and runs `install.sh` and
`uninstall.sh` against it. It covers the happy path, a checksum mismatch, a missing
`SHA256SUMS`, a truncated download, pinned version selection, the branch opt-in, a private
repository with and without credentials, and the real source archive of the working tree
including a tampered copy that must fail. Those tests stop before the build.

The full dry run packages the real installer assets, serves them, and lets the installer
download, verify, `pnpm install`, build, and register into a throwaway `DSH_HOME`, then
runs the uninstaller that release shipped. It needs the npm registry and takes a few minutes:

```sh
pnpm test:release-dry-run
```

The same server can stand in for GitHub by hand: set `DSH_BROWSER_GITHUB_URL` to a loopback
URL that serves `/<owner>/<repo>/releases/download/<tag>/<asset>`. Any other plain-HTTP URL
is refused.

## Release assets

| Asset | Contents |
| --- | --- |
| `dsh-browser-source-<tag>.tar.gz` | The tracked source tree under `dsh-browser-<tag>/`. This is what `install.sh` downloads, verifies and builds. |
| `dsh-browser-source-<tag>.zip` | The same tree for `install.ps1` |
| `install.sh`, `install.ps1` | The installers, so the documented commands fetch them from the tag instead of a branch |
| `uninstall.sh`, `uninstall.ps1`, `uninstall.mjs` | The uninstaller; the two shell entry points download and verify `uninstall.mjs` when it is not next to them |
| `dsh-browser-chrome-<tag>.zip` | Chrome build; manifest `key` stripped so Chrome Web Store uploads are accepted |
| `dsh-browser-firefox-<tag>.zip` | Firefox build (`dist-firefox/`); manifest `key` stripped |
| `dsh-bridge-browser-<tag>.tgz` | `pnpm pack` of the bridge plugin (`@natgurlain/dsh-bridge-browser`) |
| `SHA256SUMS` | One `<64 hex>  <file name>` line per asset above, sorted by name; `sha256sum -c` compatible |

The installers build from the source archive rather than use the prebuilt zips: the zips
have the manifest `key` stripped (see below), and the bridge is registered as a link to the
built workspace. `scripts/package-release.mjs` (`assetNames`, `BOOTSTRAP_SCRIPTS`) is the
one definition of these names; the installers derive the same names from the tag.

### Extension IDs and the bridge Origin check

The bridge accepts a `chrome-extension://` Origin only for IDs in the plugin config
`allowedChromeExtensionIds` (default: the ID pinned by the manifest `key`,
`klmdgljhcjbbpjcplbanjeclilghnaoh`). The release zips have the `key` stripped, so:

- **Loading a release zip unpacked** (`chrome://extensions` → Load unpacked) gives the
  extension a path-derived ID. The bridge closes it with code 4004 ("origin not allowed")
  and the panel cannot connect. Either install with the installer (which keeps the key),
  or add the ID shown on `chrome://extensions` to `allowedChromeExtensionIds`.
- **Chrome Web Store builds** get the store-assigned ID. Once the listing exists, add that
  ID to `allowedChromeExtensionIds` (and to the default in the plugin) before announcing it.
- Firefox (`moz-extension://`) has per-install UUIDs; it is admitted by token alone.

### Bridge token copies

The installer (`scripts/provision-bridge-token.mjs`) writes `~/.dsh/ext-bridge-token` and a
copy at `<extension>/bridge-token`, both 0600, never through a symlink (a symlink at either
path aborts provisioning), and tightens a looser existing file to 0600. The plugin keeps the
copy in sync on every start, **unless the token is pinned in the plugin config** (`token`):
then the copy is deliberately left alone, and if it differs the extension fails the
handshake (close code 4002). The plugin logs a warning when it detects that mismatch; fix it
by pasting the pinned token into the extension settings or removing the pin. A pinned token
must be at least 32 printable characters with real entropy (for example
`openssl rand -hex 32`); weaker values stop the plugin at startup.

On Windows the token files have no POSIX mode bits; an existing file is rewritten in place
so an ACL the user tightened survives a refresh. That path is not covered by CI.

When the repository is public, each asset and `SHA256SUMS` carry a GitHub build-provenance
attestation: `gh attestation verify <file> --repo natgurlain/dsh-browser-agent`. A private
repository gets none (the workflow skips the step).

## Installer verification

`scripts/install.sh`, `scripts/uninstall.sh` and their `.ps1` counterparts share one
"release-fetch" block per language (duplicated because each script must work on its own;
`scripts/tests/release-consistency.test.mjs` keeps the copies identical).

1. Resolve the tag. `--release vX.Y.Z` / `DSH_BROWSER_VERSION` names it; otherwise the
   latest release is read from the redirect of
   `https://github.com/natgurlain/dsh-browser-agent/releases/latest`, which needs neither
   `gh` nor the API. Only `vN.N.N` and `vN.N.N-suffix` are accepted as tags.
2. Download `SHA256SUMS` and the needed asset from
   `https://github.com/natgurlain/dsh-browser-agent/releases/download/<tag>/`, HTTPS only
   (`curl --proto '=https' --proto-redir '=https'`), into a fresh temporary directory.
3. Look up the asset's line in `SHA256SUMS` by exact file name and compare the digest
   (`sha256sum`, `shasum -a 256` or `openssl` on Unix, `Get-FileHash` on Windows). No
   `SHA256SUMS`, no line, more than one line, or a different digest aborts before anything
   is unpacked or run, and an existing installation is left untouched. A short body is a
   download error.
4. Only then unpack the source archive into `~/.dsh/dsh-browser`, hand over to the
   `scripts/install.sh` inside it, and build. `~/.dsh/dsh-browser/.managed-by-install-sh`
   records what was installed, e.g. `release v0.1.5 (SHA256SUMS verified)`.

Run inside a checkout without options, the installer installs that checkout and downloads
nothing. `--unverified-branch <name>` / `DSH_BROWSER_UNVERIFIED_BRANCH` installs a branch
archive for development; it prints a warning, verifies nothing, and is never a default.

The panel shows commands on the same path. Update, for an install that recorded its home:
`DSH_HOME='<home>' bash '<home>/dsh-browser/scripts/install.sh' --release <tag>`; otherwise
`curl … /releases/download/<tag>/install.sh | bash -s -- --release <tag>`. Uninstall runs
the uninstaller on disk, or fetches `uninstall.sh` from the extension's own release tag.
The update check reads `https://api.github.com/repos/natgurlain/dsh-browser-agent/releases/latest`.

### What verification covers

It covers a corrupted, truncated or substituted download: bytes that differ from what the
release lists never get unpacked or run.

It does not cover:

- **A compromised release.** `SHA256SUMS` is fetched from the same release as the files.
  Whoever can publish or edit a release (the repository owner's account, a token with
  `contents: write`, the release workflow) can replace both. The digests in the release
  notes are a second copy under the same control. Once the repository is public,
  `gh attestation verify <file> --repo natgurlain/dsh-browser-agent` ties an asset to this
  repository's release workflow; the installers do not run it.
- **The installer script itself in the one-liner form.** `curl … | bash` runs `install.sh`
  as delivered over TLS. Use the two-step form in the README to check it first.
- **Dependencies.** The build runs `pnpm install --frozen-lockfile`; npm packages are
  pinned by the lockfile's integrity hashes, not by `SHA256SUMS`.
- **`--release latest`.** It trusts GitHub's answer about which release is the latest.
- **Windows.** `install.ps1` and `uninstall.ps1` implement the same steps but have never
  been run, on Windows or elsewhere; treat them as unreviewed until someone has.

## DSH compatibility

The workspace installs one exact DSH release (root `package.json`, enforced by
`scripts/check-runtime.mjs`). The bridge declares a wider range (`engines.dsh` and its DSH
peers) that covers the releases with an all-pass row in `docs/dsh-matrix.md`. Before a
release, and before changing the default release or the range, refresh that record:

```sh
node scripts/dsh-matrix.mjs tested latest next --record
```

It needs the npm registry and takes a few minutes per release. Add a release to
`TESTED_DSH_VERSIONS` (`packages/browser/bridge-browser/src/dsh-support.ts`) only when its
row passes every step; `pnpm test:scripts` fails when the list, the record, the manifests
and the printed start hints disagree. `.github/workflows/dsh-matrix.yml` would run the same
script nightly (the `tested` row must pass, `latest` and `next` only report), but Actions
has never run for this repository.
