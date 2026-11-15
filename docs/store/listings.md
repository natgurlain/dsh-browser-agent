# Store listing text

The same product text works for both stores. Field limits are noted where a store enforces them.

## Name

**DSH Browser Assistant** (Chrome: up to 75 characters)

*The current `_locales/en/messages.json` name, "dsh Browser Assistant", should match the listing. Decide on the capitalization once, in both places.*

## Short description / summary

(Chrome: up to 132 characters; AMO summary: up to 250 characters)

> Let your local DSH agent read and operate web pages, with an approval card for every action and a one-key kill switch.

## Category

- Chrome Web Store: **Productivity → Workflow & Planning**, or **Developer Tools**.
- AMO: **Productivity**, with the tag "Web Development".

## Detailed description

> **DSH Browser Assistant connects your browser to the DSH agent running on your own computer.** Hand a tab to the agent from the side panel, ask it for something in plain language, and watch it work: it reads the page as structured text, clicks, types, fills forms, extracts tables and moves between tabs.
>
> **You stay in control**
> • Approval cards show exactly what will be typed, clicked or navigated to, before it happens. A card is bound to the exact action, so it cannot be swapped afterwards.
> • Site rules: block a site, make it read-only, or always ask.
> • Taint protection: after the agent reads untrusted content, writes to other sites need a fresh approval.
> • Pause, take over or resume at any step. A kill switch (Ctrl+Shift+K) stops everything at once.
> • Every action goes into a tamper-evident audit log on your computer.
>
> **Local by design**
> The extension talks only to the DSH bridge on 127.0.0.1, authenticated by a mutual handshake. Pages reach the AI model only through the DSH runtime you configured. There are no publisher servers and no telemetry.
>
> **For developers**
> Optional developer tools (console, network, element inspection) are available after consent per site, in Chrome only. A dev loop feeds console errors and failed requests from your localhost app back to your coding session. A local MCP endpoint lets Claude Code, Cursor or Codex use the same approval-gated browser.
>
> **Requires** DSH (DeepSeek Harness) installed and running on the same computer, with the bridge-browser plugin. Setup: [repository URL].

## Screenshots

Chrome needs 1280×800 or 640×400; AMO needs at least one. The browser smoke saves candidates under `$DSH_SMOKE_ARTIFACTS/run-*/screenshots/`:

1. `panel-running-controls.png`: the side panel during a task.
2. An approval card (take it from a manual run on a demo site).
3. `overlay-ghost-cursor-and-pill.png`: the in-page agent overlay.
4. `panel-step-timeline.png`: the step timeline and audit log.
5. `panel-settings-audit-export.png`: settings and site rules.

Use a neutral demo site (for example a local form fixture). Never use a real account in a screenshot.

## Promo tile (Chrome, optional)

440×280, the icon with the tagline "Your agent. Your browser. Your approval."

## Support / homepage URLs

- Homepage: [repository URL]
- Support: [repository URL]/issues
- Privacy policy: [hosted URL of `privacy-policy.md`]
