# Auto review for page actions: design

Status: implemented for v0.3.0 (unreleased), revised after an independent
security review (findings F1–F8, §14). This document is the reference for the
security review; README.md / README.zh.md carry the user-facing text.

## 1. What it is

A per-conversation mode, off by default, in which a reviewer model decides,
for each *eligible* ordinary approval card, whether the pending page action
fits what the user asked for. "Allow" runs the action without a click, exactly
like the user's "Allow once" for that card. "Ask" (or any failure) shows the
ordinary card with one fixed extra line chosen by code ("Auto review asked:
this looks like sending something, and your latest message did not ask for
that."). There is no "deny" outcome: the fallback is always the user's card.

The reviewer is the conversation's own provider and model (the DSH session's
current request route), called through DSH's LLM service on the host.

It approves only while a side panel is open **and showing that
conversation**. Otherwise the card waits as it always did (it is neither
approved nor failed); closing the last panel pauses Auto, it does not end it.

## 2. The worst case, in plain words

Assume the agent is fully compromised and the reviewer always answers "allow"
with whatever risk is needed to pass (the "at-the-floor" reviewer). Then, on
the **current site**, Auto review can still let through:

* anything the extension classifies as harmless: hovering, expanding, opening
  menus, buttons whose name starts with show/open/view/next/close/cancel/…,
  checkboxes, radios, switches and tabs whose label does not change who can see
  something, choosing an option whose label does not hand out access, a
  same-origin link without a query whose name and path contain no committing
  word, a same-origin navigation without a query (only before the conversation
  read any web page), typing into an ordinary field that is not a recipient,
  address or amount field (only before the conversation read any web page),
  and navigation keys;
* a committing action (send, delete, save, submit, share, account, change,
  confirm, or a button whose name is unclear) **only** when the user's newest
  panel message names that kind of action and that target, with no
  restriction ("only read", "don't change anything") in it.

What that means: a page script behind a harmless-looking control (a checkbox
that publishes a post on change, a "Show more" button that deletes) can do on
the current site what the user's own click could do. A page can also label a
destructive control with the words of the user's request. The word lists and
the structural rules cut this down; they cannot eliminate it. What Auto review
cannot do in any case: anything a forced card protects (data leaving the site
after the conversation read web pages, other sites, sensitive fields, site
rules, strict mode), uploads, downloads, the clipboard, dialogs, developer
tools, programs, new tabs, or anything without a panel showing the
conversation.

Known residues, stated plainly:

* Target words are page-authored: a page can label a destructive control with
  the words of the user's request; the class verb must still match.
* The restriction veto is lexical and over-cautious ("don't forget to send it"
  vetoes too): an extra card, never an extra approval.
* "Trust this domain for this session" on any card takes that origin out of
  Auto review and its limits entirely: trusted origins skip cards before Auto
  is consulted, exactly as without Auto.
* The record of panel prompts is in memory: after DSH restarts, the user must
  send a new message before anything is approved.
* A side panel counts as "showing" the conversation even when its window is in
  the background.
* The policy decision (site rules, taint) is not recomputed when the review
  answers; eligibility, visibility and the commit class are.

## 3. Threat model

| Attacker | Capability | What Auto review must not let them do |
|---|---|---|
| Compromised agent (prompt-injected or misaligned main model) | Chooses every tool call and its arguments; writes assistant text; can phrase calls to look benign | Get a forced card skipped; reach an ineligible action without a card; make the reviewer see agent text as user instruction |
| Hostile page | Authors element labels, row/section text, page title, URL path, link targets, form actions, option labels; can restyle elements (`role`), relabel or retarget after the card is computed | Break out of the untrusted section; instruct the reviewer; swap the element, link target, form action or chosen option between review and execution |
| Compromised or gullible reviewer | Answers anything in the schema, including allow with risk exactly at the floor | Approve a committing action the user's newest message did not ask for on that target |
| Other DSH clients | SDK, CLI, headless, subagents stamp user sources with an RPC id too | Have their prompts count as the user's instruction |

Out of scope: a compromised DSH host or bridge process, a compromised
extension, a malicious browser, a user who asks for a harmful action in their
own words.

### What the reviewer can and cannot weaken

* It can only turn an **ordinary, eligible** card into "approved once". It
  cannot create grants, trust origins, change settings, approve forced cards,
  or approve a card the extension did not ask it about.
* The extension decides eligibility and the commit class **before** asking,
  from facts it computed itself; the reviewer cannot widen either.
* For any committing class the bridge allows only if the user's newest panel
  message passes a deterministic check (§8); the reviewer's risk answer cannot
  lower the floor (an answer below it is "ask").
* The extension applies an "allow" only for the exact approval id and payload
  binding it asked about, checks again that the conversation is still shown
  and still eligible, and then re-probes the element (and its link target,
  form action and chosen options, all bound) exactly as for "Allow once".

## 4. Data flow

```
agent model ──browser_click──► bridge (BR) ──tool.call{id, toolCallId}──► extension (EXT)
                                                     │ policy layer (deny / force / trust / default)
                                                     │ probe element (describe.ts): kind, name, context, submits,
                                                     │   link target, form action, chosen options → card + binding
                                                     │ resolveApprovalGate → 'prompt'
                                                     │ eligibility + commit class (security/auto-review.ts) ── ineligible ─► card
                                                     │ panel shows the conversation?                       ── no ─► card
                                                     │ limits (per turn / per message / reviews per hour)  ── exhausted ─► card + line
EXT ──rpc bridge.review.ask {toolCallId, reviewId, binding, action}──► BR
   BR: owned pending call? session from BR's own record; not external; tool name matches
   BR: trusted messages = this session's user prompts THE BRIDGE FORWARDED FROM THE PANEL
   BR: ctx.llm.stream(provider/model of the session's request header, system=policy, 9 s timeout)
   BR: strict JSON schema → floors → medium gate on the newest panel message → {decision, code, risk, reason}
   BR: audit entry kind 'auto-review' (decision, code, risk, reason, model, latency, binding)
BR ──rpc.result {reviewId, binding, decision, code, risk, reason, userTurn}──► EXT
   EXT: reviewId + binding must match; allow → eligibility and visibility again → 'approved' (as Allow once)
        anything else → ordinary card with the fixed sentence for `code` and the commit class
   EXT: dispatchToolCall re-lists frames, re-probes the element, recomputes the binding → mismatch refuses
```

The agent model sees only the tool result as usual. Nothing about the review
is put into tool results or errors.

## 5. Messages

### 5.1 Capability

Server caps gain `autoReview: 1` when the plugin can offer the feature at all
(config not disabled, and the host composes an LLM service with `stream`). The
history reader is checked per conversation by `bridge.review.status`, which
also reports `host-unsupported` when the conversation holds user-sourced
messages but none carries an `rpcId`. `isCaps` accepts an absent value or any
positive safe integer; only version 1 is acted on. An old extension ignores
the key; an old bridge never sends it, so a new extension never offers the
toggle there.

### 5.2 `bridge.review.status`, `bridge.review.cancel`

`status { sessionId }` → `{ available: true, model }` or
`{ available: false, reason: 'host-unsupported' | 'no-model' | 'external-session' | 'disabled' | 'not-started' }`;
session scope is checked; it grants nothing. `cancel { toolCallId, reviewId }`
aborts an in-flight review; reviews also abort when their call settles.

### 5.3 `bridge.review.ask`

```
{ toolCallId, reviewId, binding (sha-256 hex), action: ReviewAction }
```

`ReviewAction` (validated field by field; anything else → `bad-request`):

| field | type | source |
|---|---|---|
| `tool`, `verb` | fixed vocabularies | extension; `tool` must equal the bridge's own record |
| `targetKind`, `targetClass` | fixed vocabularies | extension (native structure) |
| `commitClass` | `none`·`send`·`delete`·`save`·`submit`·`share`·`account`·`change`·`confirm`·`unknown`·`type`·`address` | extension (§9) |
| `formSubmitLikely`, `highRiskWords`, `tainted` | boolean | extension |
| `sameOrigin` | boolean, **only where computed** (navigation, link, form) | extension |
| `typedChars`, `key`, `modifiers` (`Shift` only), `repeat` | number / ≤ 40 chars / list / 1–100 | extension (agent payload) |
| `untrusted.{name,context,title,url,destination,typed,dropTarget}`, `options[]`, `recent[]` | strings ≤ 200 UTF-16 units | page- or agent-authored; always fenced |

Answer: `{ reviewId, binding, decision, code, risk?, reason, userTurn? }`.
`code` ∈ `allowed`·`model-ask`·`high-risk`·`under-rated`·`no-instruction`·`restricted`·`timeout`·`failed`·`cancelled`·`superseded`·`no-user-message`·`unavailable`.

### 5.4 Trust anchor: panel prompts

When the extension's panel sends `session.prompt` and the Host accepts it, the
bridge records the request id DSH stamps on that prompt's user source
(`requestId` = the frame's rpc id, `remote-host-api.ts`). Only those prompts
count as the user's words; other gateway clients (web UI, SDK, CLI, headless,
ACP) and subagents also stamp `{kind:'user', rpcId}` and are treated as facts.
The record is in memory: after DSH restarts, earlier messages no longer
authorize anything until the user sends a new one from the panel.

### 5.5 `tool.call` frame

Gains an optional `toolCallId` so the panel can mark the step "Reviewing…".

## 6. Eligibility (extension, deterministic, before any model call)

A card is reviewed only when **every** row holds; otherwise the ordinary card
is shown and no model is called.

| # | Condition | Ineligible examples |
|---|---|---|
| 1 | Auto on for this conversation, not expired (60 min), Setting on, managed `disableAutoReview` unset, cap 1, bridge connected | — |
| 2 | A side panel is open and showing this conversation (checked again when the answer arrives) | no panel, or the panel shows another conversation |
| 3 | The ordinary tab-bound page dispatcher raised the card | strict-mode commit cards, page reads, developer tools, watchers, fan-out, `browser_run` programs and series, dev-loop, tab management, downloads, `browser_open_tab` |
| 4 | A DSH session, not external (MCP), not a fleet child, not a program step | — |
| 5 | Prompt: action, not forced / per-call-only / permission / devtools / browser-only / url-risk / requester / dev-loop; has a binding | every forced card |
| 6 | Policy decision `default` | site ask / trust, blocked, read-only, managed pin |
| 7 | Tool ∈ click, type, select, hover, press, drag, navigate | clipboard, upload, dialog, back, forward, reload, extract |
| 8 | Every addressed element found; none sensitive, `password` or `file`; for typing `typedTargetSensitive === false` | sensitive and unknown targets |
| 9 | Navigation: same origin, no query or fragment, **not after the conversation read web pages** | cross-origin; `?action=delete`; any navigation once tainted |
| 10 | Link clicks: the page reported a destination; same origin, no query or fragment, http(s); once tainted, no path segment that carries a host, percent-encoding or a long letter-digit run | cross-origin or query links, `javascript:`, `/away/evil.example/<data>` |
| 11 | Submit controls, Enter in a field with a form, and selects that submit on change: the form's action is on the same origin and was described | forms posting elsewhere |
| 11a | Links without a `download` attribute | a download writes a file to disk |
| 12 | Typing: no control characters (line break, tab) | a newline can press Enter; a tab moves focus onto a button a typed space presses |
| 13 | Key presses: no `down`/`up` hold; no modifier other than Shift; the key is a navigation key, Space/Enter on a control (classified as a click on it), Enter in a text field, or a character into a text field (classified as typing) | Ctrl/Alt/Meta chords, `#`, `e`, `Delete` and other shortcuts on non-text targets |
| 14 | Select: a native select whose chosen option labels the page itself reported | ARIA comboboxes, unresolved values |
| 15 | Limits not reached (§7) | the card shows with a limit line |

## 7. Limits and lifetime

* Opt-in per conversation from "Approvals: Ask · Auto"; a one-time explanation.
* Pauses while no panel shows the conversation; the panel lists "Auto review is
  on in N other conversations" with **Turn all off**.
* Ends: turned off; 60 minutes; kill switch; take-over; conversation deleted;
  browser restart. A kill switch or take-over that arrives while the worker is
  still loading its state is not undone by the load.
* 25 Auto approvals per user message (the 26th card asks to continue; any
  approval of it — Allow once or Trust — resets the count); 100 without any new
  message (then paused until the user writes); **120 reviews (model calls) per
  conversation per hour**, approved or not.
* One review at a time per conversation; a new panel message cancels pending
  reviews; Off, kill switch, take-over and a cancelled call abort them.

## 8. Reviewer output and the deterministic gate

Output schema, strict: `{ "decision": "allow"|"ask", "risk": "low"|"medium"|"high", "reason": "…" }`;
anything else, a non-`stop` finish, an error, or 9 s → ask.

1. `ask` → ask (`model-ask`).
2. Floor = high if `highRiskWords`; medium if `commitClass ≠ none` or `formSubmitLikely`; else low.
   A risk of high → ask (`high-risk`). A reviewer risk below the floor → ask (`under-rated`).
3. Medium allow → the **newest** panel message only (older messages never
   authorize a committing action):
   * a restriction in it ("only read", "read-only", "don't/do not/never/without
     … send/delete/change/…", "no changes", 不要/别/只读/只看/不得/无需/不用/勿) → ask (`restricted`);
   * `confirm` / `unknown`: the message must name the control **as a
     control**: in quotes ("Done", 「完成」) or right after an imperative that
     presses or picks it ("click Done", "press Send", 点击完成). A name that
     merely occurs ("OK, read my inbox", "tell me when you're done", "send me
     the summary") does not count;
   * `address`: the typed value must appear in the message; `type`: **every**
     significant word of the typed text must (the user dictated it; one shared
     word would let the agent append what it read to the user's words);
   * every other class: the message must use a verb of that class (send ↔
     send/forward/reply/email; delete ↔ delete/remove/trash/archive/clear;
     save ↔ save/update/apply/change/set; submit ↔ submit/post/publish/comment;
     share ↔ share/publish/invite/make public; account ↔ sign in/out, follow,
     subscribe, join, …; change ↔ transfer/move/merge/revoke/reset/enable/…; EN
     and ZH) **and** share a significant word with the target (name, context,
     chosen options, drop target, destination path; verbs and stop words do
     not count). A control named only by its verb ("Send") must be named as a
     control, as for `confirm`: "send the email" alone does not let a bare Send
     button through (cost: the user writes "click Send", or answers the card).
   Otherwise ask (`no-instruction`).
4. Otherwise allow (`allowed`).

Known residue: the target words are page-authored. A page that labels a
destructive control with the words of the user's request passes the overlap
test; the class verb still has to match the user's words.

The card never shows model text: the extension maps `code` and its own commit
class to a fixed sentence (EN/ZH). The model's `reason` goes only to the
timeline details of Auto-approved rows ("Auto review's note (model text)") and
to the audit log.

## 9. Commit classes (extension)

`describe.ts` reports, besides kind and name: `submits` (native: a submit
button or image input with a form owner, never from `role`), `inForm` (a
single-line field where Enter submits), `href` (a link's origin and path, and
whether a query or fragment is attached; `other` for non-web targets),
`download`, `form` (the form action and method of a submit control, a field
where Enter submits, or a select in a form), `chosen` (the labels a
`browser_select` would choose, read from the page) and `autoSubmit` (an
`onchange` handler on the select or its form). All of these are folded into
the approval binding.

Classes come first from words (EN/ZH stems: delete/remove/trash/archive/
empty/clear…, send/forward/reply/email, share/publish/public/private/everyone/
invite, submit/post/comment/checkout/order, save/update/apply, log in/out/
sign up/subscribe/follow/join/leave/block/report/mute, transfer/move/merge/
revoke/reset/enable/disable/approve/accept/reject/book/restore/rename/
assign, and the generic confirmers done/ok/yes/confirm/continue/proceed/
finish/agree) over the name and, for links and forms, the destination path.
Then structure:

* **buttons, menu items, clickable elements** with no committing word are
  `none` only when **every** word of their name is a non-committing UI word
  (show/open/view/expand/collapse/more/next/previous/back/close/cancel/hide/
  menu/details/page/all/comments/replies/…; ZH 打开/显示/查看/展开/… with an
  optional 更多/详情/全部/评论/…): "Show more" and "Next page" are low, "Close
  issue", "Cancel membership", "Go live" are not. Any other button is
  `unknown` — at least medium. A word list can never be complete, so the
  default for a button is "needs your words";
* **submit controls** are at least `submit`;
* **checkboxes, radios, switches, tabs, options** stay `none` unless their
  label changes who can see something (`share`);
* **typing** into a recipient, address, link or amount field (by kind or by
  label: to, cc, bcc, recipient, email, url, link, website, amount, quantity,
  price, share with, invite, phone) is `address`; any other typing after the
  conversation read web pages is `type`;
* **select**: options naming access (public, private, everyone, editor,
  member, viewer, …) are `share`; owner/admin are high risk; `autoSubmit` makes
  it at least `submit`;
* **drag**: the drop target's words decide;
* **key presses**: as in row 13 of §6.

High-risk words (always ask): payments, purchases, checkout, transfer, billing,
subscription, bank, passwords, 2FA, recovery, keys, tokens, credentials,
permissions, admin, owner, ownership, account deletion; and paths such as
`/checkout`, `/billing`, `/security`, `/admin`, `/permissions`.

## 10. Reviewer input (bridge)

* Trusted: the session's own user prompts the bridge forwarded from the
  panel (§5.4), text blocks only, attached page selections cut out, newest 12,
  ≤ 8 000 characters. The last is "the current request".
* Facts: the extension's structured action.
* Untrusted: element name and context, page title, page address and
  destination (origin + path), drop target, chosen option labels, typed text
  (ordinary fields only), the last ≤ 3 approved step labels; each one plain
  line ≤ 200 UTF-16 units, JSON-encoded with `<`, `>` and `&` escaped, inside
  a block fenced with a per-request random nonce.
* No page content or snapshots.

## 11. Failure modes

| Failure | Result |
|---|---|
| Old bridge (no cap) | toggle disabled with a reason |
| Old extension | never sends review RPCs |
| Host without LLM service / history API, or without RPC ids on user prompts | `host-unsupported` |
| No panel prompt in the conversation | "ask" (`no-user-message`) |
| Model error / timeout / invalid output | card with a fixed sentence |
| Panel closed or switched during the review | the answer is ignored; the card waits |
| Binding or review id mismatch | card |
| Element, link target, form action or chosen option changed after an allow | re-probe voids it |
| New user message during review | review aborted → card |

## 12. Audit

One entry per review: `kind: 'auto-review'`, `callId`, `toolCallId`,
`decision`, `code`, `risk`, `reason` (model text, sanitized, ≤ 300), `model`,
`durationMs`, `binding`, `failure`. The model's reason can echo page text
(it is attacker-influenced); that is the one place page-derived text reaches
the audit log beyond what approval entries already hold.

## 13. Cost and privacy

Each reviewed action makes one extra request to the conversation's own model
through DSH (the user's account), at most 120 per conversation per hour. It
sends the user's panel messages in this conversation, the structured action,
the element's label and context, the page title and address (origin + path),
the destination, chosen options, and typed text for ordinary fields. No
`sessionId` is attached, so per-session extensions (the DeepSeek session-log
upload) add nothing; the cost is no session-keyed prompt caching.

## 14. Security review findings and what changed

* **F1** medium gate: newest panel message only; restriction veto; class verbs;
  target overlap or the control's own name. Generic task words never pass.
* **F2** link targets, form actions, chosen options and drop targets are
  described, bound and shown; cross-origin/query links and forms ineligible;
  path words; key presses classified or ineligible; unknown buttons medium;
  recipient/address/amount typing medium; more EN/ZH stems and confirmers.
* **F3** approvals only while a panel shows the conversation; "on in N other
  conversations" with Turn all off.
* **F4** after reading web pages: navigation ineligible, data-carrying link
  paths ineligible, typing needs the user's words.
* **F5** trust only prompts the bridge forwarded from the panel.
* **F6** fixed card sentences; model text only in timeline details and audit.
* **F7** model-free: same-site inbox-trash and comment-leak attacks with an
  allow-low and an at-the-floor reviewer; docs say what is and is not enforced.
* **F8** tombstones for early kill switch / take-over; reviews per hour; UTF-16
  caps; any approval of the continue card resets the count; eligibility and
  visibility re-checked when the answer arrives (the policy decision itself is
  not recomputed at that point, same as for the user's own cards).

## 15. Deferred

* Cross-origin navigation to origins the user named.
* Reviewing new tabs, reload, back/forward, dialogs, reads, ARIA comboboxes.
* Page snapshots for the reviewer; prompt caching.
* MCP/external sessions; prompts from the DSH web UI as instructions.
* A per-site "never auto-review" list (set the site to `ask`).
