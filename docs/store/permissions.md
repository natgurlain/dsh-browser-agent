# Permission justifications

The Chrome Web Store asks for one justification per permission, plus a "single purpose" statement. AMO reviewers read the same reasons. Paste the text after each heading into the matching field.

**Single purpose:** The extension lets a DSH agent running on the user's own computer read and operate pages in the user's browser, at the user's request, with per-action approval. The DSH agent is the local AI coding/assistant runtime the user installs separately.

**Remote code:** None. All extension code ships in the package. The extension connects only to the DSH bridge on `127.0.0.1` and exchanges data with it, never code. `browser_console_eval` runs JavaScript that the user approves on a per-call card in the page under inspection. It is page-context evaluation through `chrome.debugger`, not extension code, and it is off unless the user enables developer tools.

| Permission | Chrome | Firefox | Justification |
|---|---|---|---|
| `sidePanel` | yes | n/a (`sidebar_action`) | The extension's UI is a side panel. There the user chats with the local agent, sees each proposed action, and approves or denies it. |
| `storage` | yes | yes | Saves the user's settings (site rules, trusted origins, language, the bridge connection), pending approvals across service-worker restarts, and the pause state. Nothing is synced to a server. |
| `tabs` | yes | yes | Lists tabs and reads their URL and title. The user picks which tab the agent controls, tabs the agent opened can be followed and closed, and the approval card can name the site an action targets. |
| `activeTab` | yes | yes | Gives temporary access to the tab the user invoked the extension on. Used when the user hands the current tab to the agent. |
| `scripting` | yes | yes | Injects the extension's packaged content script. It renders the page as text and performs clicks and typing in the tab the user handed to the agent. It also re-injects that script after navigation. |
| `webNavigation` | yes | yes | Lists the frames of the controlled tab and observes navigations, so actions target the right document and the agent is told when a page changed under it. |
| `alarms` | yes | yes | Keeps the connection to the local DSH bridge alive while an agent task is running (MV3 workers are suspended otherwise), and expires pending approvals. |
| `notifications` | yes | yes | Shows a system notification when an action is waiting for the user's approval and the side panel is closed. From the notification the user can allow a simple action once, deny it, or open the full review. |
| `debugger` | yes | no | Chrome only, attached to the controlled tab only. It powers: (1) real keyboard and mouse input for pages that ignore synthetic events; (2) the optional developer tools (console, network, element inspection), which are off by default and need explicit consent per site; (3) the optional strict mode, which holds network writes until they are approved. The extension detaches as soon as the action ends, and Chrome shows its "being debugged" banner whenever it is attached. |
| `clipboardWrite` | yes | — | Lets the agent paste rich text into editors that only accept clipboard input, after the user approves that action. |
| `offscreen` | yes | — | MV3 service workers cannot write to the clipboard. A packaged offscreen document performs the approved clipboard write, then closes. |
| `downloads` (optional) | yes | yes | Requested at runtime, the first time the user approves a "list or wait for downloads" action. With it, the agent can find the file a page just downloaded. The user can decline. |
| `<all_urls>` host access | yes | yes | The user chooses which site the agent works on, and that can be any site, so the extension needs to be able to run its content script on whatever page the user hands over. Access is used only on the tab(s) handed to the agent. Each read or write is gated by the user's approval settings, per-site rules (block, read-only, ask) and a taint guard. |
| `tabGroups` (optional) | yes | — | Declared optional and used only when granted: the background tabs a "read many pages" task (`browser_fanout`) opens are put into one labelled group, so the user can see and close them together. Without it the tabs stay ungrouped. The current build checks for the permission but never prompts for it, so a store reviewer may ask why it is declared; either add a prompt (for example on the fan-out approval card) or drop it from `optional_permissions` before submitting. |
| `pageCapture` (optional) | yes | — | Requested at runtime only when the user turns on the experimental failure fixtures. When an agent step fails, the page is saved as MHTML (`chrome.pageCapture.saveAsMHTML`) into the user's own session workspace, so the failure can be replayed locally as a test. Sensitive values are masked and nothing is uploaded. |
| `http://127.0.0.1/*` in `connect-src` | yes | yes | The panel and the worker connect only to the DSH bridge on the user's own computer (a loopback WebSocket with a mutual challenge-response handshake). |
| `https://raw.githubusercontent.com` in `connect-src` | yes | yes | The optional "check for updates" button reads the published `manifest.json` version. No user data is sent. Remove this, and the update card, from store builds if the store's own updates are enough. |

## Host permission justification (Chrome "Host permission" field)

> The extension operates whatever site the user chooses to hand to their local agent. It cannot know that site in advance, so it requests access to all sites. It only acts on tabs the user hands over. Every page read or action goes through the user's approval settings, site rules and a kill switch. The extension makes no requests to any server except the DSH bridge on 127.0.0.1.

## Firefox data-collection declaration

`manifest.firefox.json` declares `browsingActivity`, `personalCommunications`, `websiteActivity` and `websiteContent` as required data-collection permissions. The page content the agent reads is sent to the user's own DSH runtime on 127.0.0.1. That runtime forwards it to the model provider the user configured. The AMO listing and the privacy policy must say this.
