# Security

dsh Browser Agent lets an AI agent act in your browser, so we take reports about it seriously.

## Reporting a problem

Please report security problems privately, not in a public issue:

- On GitHub, open this repository's **Security** tab and choose **Report a vulnerability**. This creates a private report that only the maintainers can see.

Include what you did, what happened, what you expected, and the build number from the side panel under **Settings → About** (or the release version). A proof of concept helps; so does the browser, operating system and DSH version.

You will get an acknowledgement, and we will tell you when a fix is released. Please give us a reasonable time to fix a problem before describing it publicly.

## Scope

In scope: the browser extension (`extensions/dsh-browser`), the DSH bridge plugin (`packages/browser/bridge-browser`), the MCP shim, and the install and uninstall scripts in this repository.

Out of scope: DeepSeek Harness itself, model providers, and web sites the agent visits. Report those to their own maintainers.

## What the project assumes

The design assumes that web pages may be hostile and that the model driving the agent may follow instructions hidden in a page. Approval cards, site rules, the rules for conversations that have read web pages, the stop button and the audit log are built around that. The README's Security sections describe them. A page that owns its own content can still mislead a person who approves an action without reading the card; reports that show how the cards or the panel could be made clearer are welcome too.

## Supported versions

Fixes go into the latest release.
