# Releasing

## Cutting a release

1. Bump `version` in `extensions/dsh-browser/manifest.json`, `manifest.firefox.json`
   and `package.json` (they must match; `scripts/package-release.mjs` refuses otherwise),
   and the bridge version in `packages/browser/bridge-browser/package.json` if it changed.
2. Tag and push: `git tag v0.1.5 && git push origin v0.1.5`. A tag containing `-`
   (e.g. `v0.1.5-rc.1`) is published as a prerelease.
3. `.github/workflows/release.yml` runs the checks, packages the assets, attests build
   provenance and creates the GitHub Release. It can also be started manually
   (Actions → Release → Run workflow) for an existing tag; manual runs default to a draft.

To reproduce the assets locally: `node scripts/package-release.mjs --out release`
(add `--skip-build` to reuse existing `dist/`, `dist-firefox/` and bridge `lib/`).
Zips are deterministic, so the same build output gives the same checksums.

## Release assets

| Asset | Contents |
| --- | --- |
| `dsh-browser-chrome-<tag>.zip` | Chrome build; manifest `key` stripped so Chrome Web Store uploads are accepted |
| `dsh-browser-firefox-<tag>.zip` | Firefox build (`dist-firefox/`); manifest `key` stripped |
| `natgurlain-dsh-bridge-browser-<version>.tgz` | `pnpm pack` of the bridge plugin |
| `SHA256SUMS` | `sha256sum -c` compatible checksums of the three files above |

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
