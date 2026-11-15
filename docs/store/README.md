# Store submission kit

Everything needed to list the extension on the Chrome Web Store and on addons.mozilla.org (AMO). **Nothing here has been published or submitted.**

| File | Contents |
|---|---|
| [listings.md](listings.md) | Name, summary, detailed description, category, screenshot plan |
| [permissions.md](permissions.md) | Single-purpose statement, remote-code answer, one justification per permission (`debugger`, `<all_urls>`, optional `downloads`, `tabGroups` and `pageCapture`, `notifications`, …), Firefox data-collection note |
| [privacy-policy.md](privacy-policy.md) | Privacy policy draft (needs placeholders filled in and a review) |

## Checklist: what you (the publisher) must do

### Accounts and fees

- [ ] **Chrome Web Store developer account.** Register at https://chrome.google.com/webstore/devconsole with a Google account. The registration fee is a one-time **US$5**. Turn on 2-step verification, which is required to publish.
- [ ] Verify the publisher contact email. Optionally verify a domain or a group publisher.
- [ ] **AMO developer account.** Create a Firefox account at https://addons.mozilla.org/developers/ (free). Accept the Firefox Add-on Distribution Agreement.
- [ ] Decide on the publisher name, the support email, and where the privacy policy is hosted (it needs a public URL; GitHub Pages works).

### Build the packages

- [ ] Bump the version in `extensions/dsh-browser/manifest.json`, `manifest.firefox.json` and `package.json`. Store versions must strictly increase.
- [ ] Chrome: upload `dsh-browser-chrome-<tag>.zip` from the GitHub release ([RELEASING.md](../../RELEASING.md)); `scripts/package-release.mjs` already strips the manifest `key`, which the Web Store rejects. Without a release, `pnpm --filter dsh-browser-extension run build:store` produces the same key-less build in `dist-store/`; zip the **contents** of that directory.
  - The store assigns a **new extension ID**, and a store build has **no bridge token** (the installer writes the token into the unpacked extension's own directory; a store-installed extension has no such file). Neither needs manual setup any more: the user pairs once, as described in [Pairing a store-installed extension](#pairing-a-store-installed-extension). Pairing delivers the token and records the extension ID on the bridge. Put those steps in the listing's setup instructions and in the reviewer notes.
- [ ] Firefox: run `pnpm --filter dsh-browser-extension run build:firefox` and zip it. Keep `browser_specific_settings.gecko.id` stable (`dsh-browser-agent@natgurlain.github.io`, or your own domain).
- [ ] AMO requires **source code** whenever the upload is bundled or minified (Vite output is). Upload a source zip with build instructions: `pnpm install && pnpm --filter dsh-browser-extension run build:firefox`, with Node and pnpm versions pinned.
- [ ] Decide whether store builds keep the GitHub update check (`api.github.com` in `connect-src`, the update card). Stores update extensions themselves. If you remove it, update `permissions.md` and the privacy policy.
- [ ] Remove the uninstall-script card, or reword it, if it points at `curl | bash` installers. Reviewers flag that.

### Signing

- [ ] Chrome signs on publish. Nothing to do locally. Keep the developer account's 2SV on.
- [ ] Firefox: listed add-ons are signed by AMO when review passes. For self-distribution, use **unlisted** signing (`web-ext sign --channel=unlisted` with AMO API keys from the developer hub). Release Firefox will not install unsigned add-ons.

### Listing and review

- [ ] Paste the text from `listings.md`. Upload the icon (128×128), at least one screenshot, and optionally a promo tile.
- [ ] Chrome **Privacy practices** tab:
  - single purpose;
  - a justification for each permission (`permissions.md`);
  - remote code: "No";
  - data usage: tick "Website content", "Personal communications" and "Web history". Certify no sale, no unrelated use, no creditworthiness use;
  - the privacy policy URL.
- [ ] AMO: fill in the data-collection answers to match `manifest.firefox.json`, give the privacy policy URL or text, and add reviewer notes. The notes should explain that a local DSH install is needed and how to test without one (see below).
- [ ] **Reviewer test instructions.** Reviewers cannot use the extension without a local DSH install. Write short steps for them: install DSH, run the installer script, open the side panel. Also provide a short video, which both stores accept and which speeds up review.
- [ ] Expect a longer review: `debugger`, `<all_urls>` and AI-agent behaviour each trigger manual review. Chrome typically takes several days to a few weeks, and AMO is similar for a first listing.
- [ ] Choose the visibility. Start with **unlisted** (Chrome) or a **self-distributed / unlisted** channel (AMO) for beta testers, then switch to public.

### After publishing

- [ ] Update the README install instructions with the store links.
- [ ] Optionally record the store extension ID in the bridge defaults (`PINNED_CHROME_EXTENSION_ID` or `allowedChromeExtensionIds`). Pairing makes this unnecessary; with the ID in the defaults a store user would still need the token, so it does not replace pairing.
- [ ] Native messaging, the planned long-term answer, would remove even the one approval. It is not built.
- [ ] Watch the developer dashboards for policy emails. Unanswered emails can lead to takedown.

## Pairing a store-installed extension

A store build (Chrome Web Store, Brave, Edge, or Firefox) connects to DSH after one approval. Nothing is copied, typed, or edited in a config file.

What the user does:

1. Open the extension's side panel. It finds the local DSH, shows "This browser is not connected to DSH yet" and a six-character code such as `4F7-K2Q`, with "Approve in DeepSeek Harness".
2. Look at DeepSeek Harness. A prompt appears over the app: "Brave wants to connect", the same code, and **Approve** / **Deny**. (The same prompt is in Settings → General → "Pair a browser".)
3. Check that the two codes are the same and click **Approve**. The side panel connects by itself.

That is one click, and it is needed once per browser profile. The bridge remembers the extension ID in `~/.dsh/browser-paired-extensions.json`, and the extension keeps the token in its own storage.

In a terminal-only DSH session, step 2 and 3 are a command: `/browser-pair` lists the waiting requests, and `/browser-pair approve 4F7-K2Q` approves the one whose code the browser shows. `/browser-pair deny` refuses all of them.

### What protects it

- **Only the DSH owner can approve.** The prompt and the command go through DSH's own authenticated channel. A web page, another extension, or a local process that merely reaches the bridge port can ask to pair, but it cannot see the waiting requests and cannot approve one.
- **Nothing is released before approval.** A request that is not approved gets no token and no allowlist entry. It expires after two minutes, and it disappears as soon as the browser closes its request.
- **The code ties the approval to the right browser.** Both sides compute the code from a key agreement, and the extension commits to its key share before it sees the bridge's. Something in the middle (a process squatting on a local port, another extension relaying frames) ends up with a different code on the DSH side, so the code the user sees there does not match their browser. The code also covers the extension's origin and the port it dialed.
- **The token is encrypted to the approved request.** It travels under a key that only the two ends of the approved exchange hold. An observer of loopback traffic reads nothing, and no other socket can use the approval.
- **The queue is bounded.** At most 4 requests wait at once and at most 12 exchanges start per minute. Web pages are refused before any frame is read.

The one thing the user must do is compare the code. An approval given without looking would pair whatever asked. When more than one request is waiting, the prompt says so and lists each with its own code: approve the one your browser shows and deny the rest.

### Manual fallback

Pairing needs a bridge plugin that includes it and a DSH surface that can show the prompt or run the command. Without either, set the connection up by hand, as before:

1. Copy the token from `~/.dsh/ext-bridge-token` (the dsh startup log prints that file's path) into the extension's Settings → Token. The field accepts a pasted token only; nothing in the extension can read the file for the user.
2. Chrome-family browsers only: add the extension ID shown on `chrome://extensions` to the bridge plugin's `allowedChromeExtensionIds`, then restart DSH.

The developer install (`scripts/install.sh`) is unchanged: it writes the token into the unpacked extension's directory and uses the manifest-keyed ID, so it connects with no pairing.

### Reviewer notes

Store reviewers need a local DSH to exercise the extension. With DSH running, the steps above are the whole setup; include them, and the fact that the extension only talks to a DSH on the same computer, in the reviewer notes.
