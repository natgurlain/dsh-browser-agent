# Release 0.2.0 checklist

For the repository owner, in order. Details behind each step are in
[RELEASING.md](../RELEASING.md). Nothing here runs by itself.

1. **Check the upstream contact issue for a reply.** If there is one, read it before going on.

2. **Merge the release branch** and take a clean checkout of `main`:

   ```sh
   git checkout main && git pull --ff-only && git status --short   # must print nothing
   grep '"version"' package.json                                    # 0.2.0
   ```

3. **Run the gate** (about 15 minutes; needs a Playwright Chromium). Every step must pass:

   ```sh
   export DSH_SMOKE_ARTIFACTS=/tmp/dshgate
   pnpm install --frozen-lockfile && pnpm gate
   pnpm test:release-dry-run      # optional; needs the npm registry, a few minutes
   ```

4. **Tag and publish by hand.** Recommended order: publish while the repository is still
   private, then make it public. A tag pushed to a private repository starts no workflow,
   so the release is exactly what you built and checked, and the repository is never
   public without the release its README points at.

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   node scripts/package-release.mjs --tag v0.2.0 --out release --notes release-notes.md
   (cd release && sha256sum -c SHA256SUMS)      # macOS: shasum -a 256 -c SHA256SUMS
   gh release create v0.2.0 release/* --verify-tag --title v0.2.0 --notes-file release-notes.md
   ```

   Then check it with credentials, before anyone else can see it:

   ```sh
   DSH_HOME="$(mktemp -d)" DSH_BROWSER_NO_LAUNCH=1 DSH_DESKTOP_APP=none bash scripts/install.sh --release v0.2.0
   ```

   Then make the repository public: GitHub → Settings → General → Danger Zone → Change
   visibility. Only you can do this.

   The other order (public first, then `git push origin v0.2.0`) lets
   `.github/workflows/release.yml` build and publish the release and attest the assets.
   That workflow has never run; if you choose it, do not also run `gh release create`,
   and watch Actions → Release. If it fails, publish by hand with the commands above.

5. **Verify the README commands against the published release**, anonymously (no `gh`
   login, no `DSH_BROWSER_GITHUB_TOKEN`), in a scratch directory:

   ```sh
   tag=v0.2.0
   base=https://github.com/natgurlain/dsh-browser-agent/releases/download/$tag
   curl --proto '=https' --tlsv1.2 -fsSL -O "$base/install.sh" -O "$base/SHA256SUMS"
   grep ' install.sh$' SHA256SUMS | shasum -a 256 -c -
   curl -fsSI https://github.com/natgurlain/dsh-browser-agent/releases/latest | grep -i '^location'   # ends in /v0.2.0
   ```

   Also check that the release notes show the changelog and the SHA-256 list.

6. **Retest on your Mac**, with the published release:

   - Installer: `bash install.sh --release v0.2.0` (from step 5). It must report a verified
     release, register the `web` and `desktop` profiles, and open the extensions page.
   - DeepSeek Harness desktop app: quit and reopen it, open the side panel, wait for
     **Connected**, send one message, approve one click. Quit and reopen the app with the
     panel open: the panel reconnects and keeps the conversation.
   - Brave: reload the extension from `~/.dsh/browser-extension`, same check. Settings →
     Updates must say it is up to date; the extensions page must show version 0.2.0.
   - Uninstall command from Settings, then install again.

7. **Rolling back.** Delete the release and the tag, fix, and publish again under a new
   version if anyone could have installed it:

   ```sh
   gh release delete v0.2.0 --yes
   git push origin :refs/tags/v0.2.0 && git tag -d v0.2.0
   ```

   Making the repository private again is the same Settings click.
