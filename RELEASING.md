# Releasing

## Cutting a release

1. Bump `version` in `extensions/dsh-browser/manifest.json`, `manifest.firefox.json`
   and `package.json` (they must match; `scripts/package-release.mjs` refuses otherwise),
   and the bridge version in `packages/browser/bridge-browser/package.json` if it changed.
2. Tag and push: `git tag v0.1.5 && git push origin v0.1.5`. A tag containing `-`
   (e.g. `v0.1.5-rc.1`) is published as a prerelease.
3. `.github/workflows/release.yml` runs the checks and packages the assets in a `build`
   job (read-only token, no OIDC), then a separate `publish` job downloads those assets,
   re-verifies `SHA256SUMS`, attests build provenance and creates the GitHub Release. The
   publish job never overwrites: if the release already has an asset of the same name the
   upload fails; delete the stale asset by hand first. It can also be started manually
   (Actions → Release → Run workflow) for an existing tag; manual runs default to a draft.

To reproduce the assets locally: `node scripts/package-release.mjs --out release`
(add `--skip-build` to reuse existing `dist/`, `dist-firefox/` and bridge `lib/`).
Zips are deterministic, so the same build output gives the same checksums.

## Release assets

| Asset | Contents |
| --- | --- |
| `dsh-browser-chrome-<tag>.zip` | Chrome build; manifest `key` stripped so Chrome Web Store uploads are accepted |
| `dsh-browser-firefox-<tag>.zip` | Firefox build (`dist-firefox/`); manifest `key` stripped |
| `dsh-bridge-browser-<tag>.tgz` | `pnpm pack` of the bridge plugin (`@natgurlain/dsh-bridge-browser`) |
| `SHA256SUMS` | `sha256sum -c` compatible checksums of the three files above |

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

Each asset and `SHA256SUMS` carry a GitHub build-provenance attestation:
`gh attestation verify <file> --repo natgurlain/dsh-browser-agent`.

## Installer verification (to be implemented in `scripts/install.sh` / `install.ps1`)

The installer must download from one **pinned tag**, never `releases/latest`:

1. Download `https://github.com/natgurlain/dsh-browser-agent/releases/download/<tag>/SHA256SUMS`
   and the assets it needs from the same `<tag>` URL, over HTTPS only (`curl -fsSL --proto '=https'`).
2. For each asset, look up its line in `SHA256SUMS` by exact file name and compare the hash
   (`sha256sum` / `shasum -a 256` on Unix, `Get-FileHash -Algorithm SHA256` on Windows).
   A missing line or a mismatch aborts the install before anything is unpacked or installed.
3. Optionally, when `gh` is available, run
   `gh attestation verify SHA256SUMS --repo natgurlain/dsh-browser-agent` to tie the sums
   to this repository's release workflow; skip with a notice when `gh` is absent.
4. Install the bridge from the verified local tarball (not a registry name) and unpack the
   extension from the verified zip.

## DSH compatibility

The DSH runtime is pinned exactly (see root `package.json`, enforced by
`scripts/check-runtime.mjs`). `.github/workflows/dsh-matrix.yml` runs nightly against the
pin plus the `latest` and `next` dist-tags via `node scripts/dsh-matrix.mjs <target>`;
non-pin rows only report. Check its job summary before moving the pin.
