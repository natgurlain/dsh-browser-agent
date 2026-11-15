# Privacy policy (draft)

*Draft for the Chrome Web Store and AMO listings. Have it reviewed before you publish it. Replace the bracketed placeholders.*

**Effective date:** [date]
**Publisher:** [publisher name], [contact email]

## What the extension does

The DSH Browser Assistant connects your browser to the DSH agent runtime that you run on your own computer. When you hand a tab to the agent, the agent can read that page as text and act on it: click, type, navigate. You approve these actions according to your settings.

## Data the extension handles

| Data | When | Where it goes |
|---|---|---|
| Content of pages you hand to the agent: text, form-field labels, links, and screenshots when requested | Only for the tab or tabs you hand over, and only when the agent asks (subject to your approval settings) | To the DSH runtime on your computer (`127.0.0.1`). DSH sends it to the AI model provider **you configured in DSH**, as part of the conversation. |
| Text you type into the side panel, and text you select on a page and quote | When you send a message | Same as above |
| Page URLs and titles of your tabs | When you hand over a tab, or the agent lists tabs | Same as above |
| Downloads list (file names, paths) | Only if you grant the optional `downloads` permission and approve the action | Same as above |
| Developer-tools data: console output, network requests | Only if you enable developer tools and approve them for a site | Same as above |
| Settings, site rules, approval state, and the bridge token | Always | Stored locally in the browser's extension storage. Never transmitted except to your local DSH bridge. |
| Audit log of agent actions | While the agent acts | Written by the DSH bridge on your computer (`~/.dsh/browser-audit`). It never leaves your computer unless you export it. |

## What the extension does not do

- It does not send data to the publisher or to any server other than your local DSH bridge. There is one exception: the optional update check asks `api.github.com` for the latest public release tag, and sends no personal data. [Delete this exception if the store build removes the update check.]
- It does not sell data, use it for advertising, or use it to determine creditworthiness.
- It does not collect analytics or telemetry.
- It does not read tabs you have not handed to the agent.

## Third parties

The AI model provider you configure in DSH receives the conversation, including page content the agent read, under **that provider's** terms and privacy policy. The publisher of this extension does not choose that provider and has no access to that data.

If you connect other agent tools (such as Claude Code, Cursor or Codex) through the optional local MCP endpoint, those tools receive the page content their actions return, under their own terms. Every such action is labelled with the requesting tool on the approval card.

## Your controls

- Per-site rules (block, read-only, ask), approval settings, and the option to never share page content automatically.
- A kill switch (side panel button, or Ctrl+Shift+K / ⌘⇧K) stops all agent activity at once.
- Uninstalling the extension deletes its local storage. You can delete the DSH bridge data under `~/.dsh`.

## Children

The extension is not directed to children under 13.

## Changes

We will post changes to this policy at [URL] and update the effective date.

## Contact

[contact email]
