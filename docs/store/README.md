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
  - The store assigns a **new extension ID**, and a store build has **no bridge token** (the installer writes the token into the unpacked extension's own directory; a store-installed extension has no such file). Neither needs manual setup: the user types one short code, as described in [Pairing a store-installed extension](#pairing-a-store-installed-extension). Pairing delivers the token and records the extension ID on the bridge. Put those steps in the listing's setup instructions and in the reviewer notes.
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
- [ ] Native messaging, the planned long-term answer, would remove even the one typed code. It is not built.
- [ ] Watch the developer dashboards for policy emails. Unanswered emails can lead to takedown.

## Pairing a store-installed extension

A store build (Chrome Web Store, Brave, Edge, or Firefox) connects to DSH after the user types one short code. No token is copied and no config file is edited.

What the user does:

1. Open the extension's side panel. It finds the local DSH, shows "This browser is not connected to DSH yet" and a six-character code such as `4F7-K2Q`, with "Enter this code in DeepSeek Harness".
2. Look at DeepSeek Harness. A card appears over the app: "A browser wants to connect", who is asking, and one input for the code. (The same input is in Settings → General → "Pair a browser".)
3. Type the code and press Enter. The side panel connects by itself.

This is needed once per browser profile. The bridge remembers the extension ID in `~/.dsh/browser-paired-extensions.json`, and the extension keeps the token in its own storage.

In a terminal-only DSH session, steps 2 and 3 are one command: `/browser-pair 4F7-K2Q`. `/browser-pair` alone says whether a browser is waiting.

DSH never shows a code. The code exists only in the extension's panel and in what the user types, so enter a code only when you opened the extension yourself and it is showing one.

The card names the extension that is asking. The published build reads "DSH Browser Agent (official)". Any other extension reads "Unknown extension <id> — not the published DSH extension", in warning style: enter a code for it only if you installed that extension yourself and trust it, because a paired extension can drive DSH. After pairing, the card says which extension was paired and has an **Unpair** button next to it. The label goes by the extension ID the browser reports; it tells extensions apart, and it is not what stops a local program (the code is).

### What protects it

- **The code is the only way in.** The extension picks the code at random and never sends it. Both sides run a password-authenticated key exchange keyed by it. The token is released only to a requester that proves it holds the code the user typed, and the extension stores a token only from a bridge that proves the same.
- **Nothing can be approved by a click.** DSH shows no list of requesters to accept. A local process or another extension can ask to pair (even under a forged extension ID), but without the code on the user's screen it receives nothing it can use, not even something to guess against offline.
- **A fake bridge gets nothing either.** A process that answers on DSH's port cannot make the extension accept a token, because it was never given the code. An extension that already holds a token never starts pairing by itself, whatever the connection error says; pairing again is an explicit action in the extension's Settings, behind a warning.
- **Only the DSH owner can enter a code.** The input and the command go through DSH's own authenticated channel. A paired browser cannot run `/browser-pair` through the bridge.
- **The exchange cannot be relayed.** It is bound to the extension's origin as the browser reports it and to the port the extension dialed.
- **Guesses are counted.** A code is tried once against every waiting request, and each request sees one code only. A wrong guess succeeds with probability 2^-30 (about one in a billion). After 5 failed attempts within 10 minutes pairing pauses until the user resumes it, and DSH says so. At most 8 requests wait at once, for 2 minutes each; when more arrive, the oldest gives way, is told so, and the extension asks again once by itself.

### Pausing, unpairing, revoking

Settings → General → "Pair a browser" also has:

- **Pause pairing / Resume pairing.** While paused, no browser can ask to pair. Pairing also pauses by itself after several wrong codes.
- **Paired extensions** (Chrome and Firefox), each with **Unpair**. Unpairing closes that extension's connection at once and refuses it from then on. It still holds the bridge token.
- **Reset bridge token.** Replaces the token and disconnects every browser. Use it when a browser that was paired is no longer yours. The installed developer extension picks the new token up by itself; paired browsers pair again. In a terminal: `/browser-pair reset-token`. A token pinned in the plugin config cannot be reset here; change it in the config.

`pairing: false` in the bridge plugin config switches pairing off entirely.

### Manual fallback

Pairing needs a bridge plugin that includes it and a DSH surface that can show the card or run the command. Without either, set the connection up by hand, as before:

1. Copy the token from `~/.dsh/ext-bridge-token` (the dsh startup log prints that file's path) into the extension's Settings → Token. The field accepts a pasted token only; nothing in the extension can read the file for the user.
2. Chrome-family browsers only: add the extension ID shown on `chrome://extensions` to the bridge plugin's `allowedChromeExtensionIds`, then restart DSH.

The developer install (`scripts/install.sh`) is unchanged: it writes the token into the unpacked extension's directory and uses the manifest-keyed ID, so it connects with no pairing.

### Reviewer notes

Store reviewers need a local DSH to exercise the extension. With DSH running, the steps above are the whole setup; include them, and the fact that the extension only talks to a DSH on the same computer, in the reviewer notes.
