# Auto review for page actions: design

Status: implemented for v0.3.0 (unreleased). Revised after three independent
security reviews (findings F1–F8, R2-1…R2-11 and R3-F1…F8, §14). This document is the
reference for security review; README.md / README.zh.md carry the user-facing
text.

## 1. What it is

A per-conversation mode, off by default, in which the conversation's own model
decides eligible ordinary approval cards. The promise to the user is short:

> **Auto approves an action only when you named it, or it is plainly harmless.**

* **The rules decide what CAN be approved.** Deterministic code in the
  extension and the bridge, not a model. "Named" means the user's newest panel
  message asks for it — in an imperative clause with an action verb — by the
  name a person sees: the control's full name (and, when the name repeats on
  the page, its row), the chosen options, both ends of a drag; or gives the
  text to type in quotes, exactly. Each name lets one action through. "Plainly harmless" is a short
  allowlist (§6.2).
* **The model decides whether it SHOULD be.** The reviewer still runs; its
  "ask" always wins; its "allow" counts only when a rule holds.

"Allow" runs the action without a click, exactly like the user's "Allow once"
for that card. Anything else shows the ordinary card with one fixed extra
line chosen by code, which teaches the rule ("Auto review asked: your message
did not name this button. Say “click Save settings” to let it through next
time."). There is no "deny" outcome: the fallback is always the user's card.

The reviewer is the conversation's own provider and model (the DSH session's
current request route), called through DSH's LLM service on the host.

It approves only while a side panel is open **and showing that
conversation**. Otherwise the card waits as it always did; closing the last
panel pauses Auto, it does not end it.

## 2. The worst case, in plain words

Assume the agent is fully compromised and the reviewer always answers "allow".
Then, on the **current site**, Auto review can still let through:

* **plainly harmless steps**: hover; a real same-site link with a name, no
  query and no committing word in its path; a disclosure control (marked up
  as one) named only with show/more/expand/collapse/next/previous/back/menu/
  details/close/cancel and a few UI nouns; navigation keys in a text field or
  on a link or button; a same-site navigation without a query before the
  conversation read any web page;
* **anything you named**, verbatim, once, in an imperative clause of the
  first 600 characters of your newest panel message (before any pasted
  block), unless that message holds back anywhere ("only read", "don't …",
  "tell me if …", "wait for me", "I'll do it myself", "draft", 不要/别/只看/等我
  …). A question or a clause with not/before/after/until/if/when/wait/later
  never names anything.

Residues, stated plainly (each is the cost of not asking more often):

* **A page can name a harmful control with your words.** If you say "click
  Save", a page can call its delete button "Save". The rule checks names, not
  intentions. The reviewer may still ask.
* **An allowed click runs the page's own script.** A "Show more" disclosure or
  a same-site article link can do anything its page code does. The allowlist
  only trusts disclosure markup plus a harmless name.
* **close / cancel / next** stay on the harmless list for disclosures: on a
  dialog's "Cancel" a page could discard a draft; on "Next" it could advance a
  wizard.
* **Escape in a text area** is a navigation key (not while a dialog is open):
  a page can bind it to discard a draft.
* **GET side effects**: a same-site link to an innocent-looking path can still
  change something if the site does that on a plain visit.
* **User activation**: an Auto-approved click is a trusted user gesture for
  the page (it may open a popup or start a download the page wires to it).
* **Hidden text the visibility check misses**: text the same colour as its
  background, moved off-screen, or covered by another element still counts as
  visible.
* **Which row**: the row a repeated name needs comes from the page (the
  row's first cell, emphasised text or heading). Markup inside a row (a mail
  body) can supply a row word; the once-per-message rule limits it to one
  action.
* **Once is per name**: "Delete Bob's and Dana's" lets one Delete through;
  the second asks.
* **New tabs by other means**: `<base target=_blank>` and a form's `target`
  are not detected as opening a new tab.
* **Autosave by script**: a field that saves through `addEventListener` (not
  an `onchange`/`oninput` attribute) is not detected; typing there is still
  named and verbatim.
* **Case and spacing are ignored** ("save settings" names "Save settings");
  Chinese names need 2 characters and are matched without word boundaries.
* **Restrictions are lexical and over-cautious** ("don't forget to click
  Send" vetoes too, as does 别 inside 别人): an extra card, never an extra
  approval. "Draft"/"prepare" veto clicks and selections but not typing the
  text you dictated.
* "Trust this domain for this session" on any card takes that origin out of
  Auto review entirely, exactly as without Auto.
* The record of panel prompts is in memory: after DSH restarts, the user must
  send a new message before anything is approved.
* A side panel counts as "showing" the conversation even when its window is in
  the background.

What Auto review cannot do in any case: anything a forced card protects (data
leaving the site after the conversation read web pages, other sites,
sensitive fields, site rules, strict mode), uploads, downloads, the
clipboard, dialogs, developer tools, programs, new tabs, Enter in a text
field, keyboard shortcuts, value changes by arrow keys or by dragging a
slider, typing into a field that already holds text (unless replacing it), or
anything without a panel showing the conversation; clicks with modifiers,
non-left buttons or more than one click; links opening a new tab; anything in
a frame from another origin; typing other than plain insertion into a located
text field; controls whose accessible name differs from their visible text.

## 3. Threat model

| Attacker | Capability | What Auto review must not let them do |
|---|---|---|
| Compromised agent | Chooses every tool call and its arguments; writes assistant text | Get a forced card skipped; reach an action the user neither named nor is harmless; make the reviewer see agent text as user instruction |
| Hostile page | Authors labels, row/section text, title, URL path, link targets, form actions, option labels; can restyle and relabel or retarget after the card | Break out of the untrusted section; instruct the reviewer; swap the element, target, form action, chosen option, download flag, disclosure markup or field emptiness between review and execution |
| Compromised or gullible reviewer | Answers anything in the schema | Approve anything a rule does not hold for |
| Other DSH clients | SDK, CLI, headless, subagents stamp user sources with an RPC id too, and may choose the id | Have their prompts count as the user's words |

Out of scope: a compromised DSH host or bridge process, a compromised
extension, a malicious browser, a user who asks for a harmful action in their
own words.

## 4. Data flow

```
agent model ──browser_click──► bridge (BR) ──tool.call{id, toolCallId}──► extension (EXT)
                                                     │ policy layer (deny / force / trust / default)
                                                     │ probe element (describe.ts): kind, name, context, submits, href,
                                                     │   download, form action, chosen options, disclosure, empty → card + binding
                                                     │ resolveApprovalGate → 'prompt'
                                                     │ rules (security/auto-review.ts): ineligible / harmless / named ── ineligible ─► card
                                                     │ panel shows the conversation?                                   ── no ─► card
                                                     │ limits (per turn / per message / reviews per hour)              ── exhausted ─► card + line
EXT ──rpc bridge.review.ask {toolCallId, reviewId, binding, action}──► BR
   BR: owned pending call? session from BR's own record; not external; tool name matches
   BR: trusted messages = user prompts carrying an id THE BRIDGE MINTED, each bound to its first event
   BR: ctx.llm.stream(provider/model of the session's request header, system=policy, 9 s timeout)
   BR: strict JSON → ask wins → high risk asks → harmless: allow / named: verbatim check on the newest message
   BR: audit entry kind 'auto-review' (decision, code, risk, reason, model, latency, binding)
BR ──rpc.result {reviewId, binding, decision, code, risk, reason, userTurn}──► EXT
   EXT: reviewId + binding must match; allow → rules and visibility again (same rule, same words) → 'approved'
        anything else → ordinary card with the fixed sentence for `code`
   EXT: dispatchToolCall re-lists frames, RE-DESCRIBES the element, recomputes the binding → mismatch refuses
```

## 5. Messages

### 5.1 Capability

Server caps gain `autoReview: 1` when the plugin can offer the feature (config
not disabled, and the host composes an LLM service with `stream`).
`bridge.review.status` reports per conversation, including `host-unsupported`
when user-sourced messages carry no `rpcId`.

### 5.2 `bridge.review.status`, `bridge.review.cancel`

`status { sessionId }` → `{ available: true, model }` or
`{ available: false, reason }`; `cancel { toolCallId, reviewId }` aborts an
in-flight review; reviews also abort when their call settles.

### 5.3 `bridge.review.ask`

```
{ toolCallId, reviewId, binding (sha-256 hex), action: ReviewAction }
```

`ReviewAction` (validated field by field; anything else → `bad-request`):

| field | type | source |
|---|---|---|
| `tool`, `verb` | fixed vocabularies | extension; `tool` must equal the bridge's own record |
| `targetKind`, `targetClass` | fixed vocabularies | extension (native structure) |
| `rule` | `harmless` · `named` | extension (§6) |
| `mustName` | 1–5 strings ≤ 200, only with `named` | the exact names the page reported (control, chosen options, both drag ends) |
| `exactText`, `exactToken` | string ≤ 500 / boolean, only with `named` | the full `args.text` of a typing action; `exactToken` for address fields |
| `commitClass` | `none`·`send`·`delete`·… | extension, a label for the prompt and the card only |
| `formSubmitLikely`, `highRiskWords`, `tainted` | boolean | extension |
| `sameOrigin` | boolean, only where computed | extension |
| `typedChars`, `key`, `modifiers` (`Shift` only), `repeat` | number / ≤ 40 chars / list / 1–100 | extension |
| `untrusted.{name,context,title,url,destination,typed,dropTarget}`, `options[]`, `recent[]` | strings ≤ 200 UTF-16 units | page- or agent-authored; always fenced (the reviewer's view only) |

A `named` action without `mustName` or `exactText`, or a `harmless` one with
either, is refused. Answer: `{ reviewId, binding, decision, code, risk?, reason, userTurn? }`,
`code` ∈ `allowed`·`model-ask`·`high-risk`·`not-named`·`restricted`·`timeout`·`failed`·`cancelled`·`superseded`·`no-user-message`·`unavailable`.

### 5.4 Trust anchor: panel prompts

When the extension's panel sends `session.prompt`, the bridge **mints** a
fresh random request id, overwrites any `requestId` in the payload with it,
and records it for that conversation before the Host runs the prompt. DSH
stamps that id on the prompt's user source. When the history is read, the
first event carrying a recorded id binds it to its `seq`; a later event with
the same id is not trusted. Only these prompts count as the user's words;
other gateway clients and subagents also stamp `{kind:'user', rpcId}` but
cannot know a minted id. The record is in memory and forgotten when the
conversation is purged.

### 5.5 `tool.call` frame

Gains an optional `toolCallId` so the panel can mark the step "Reviewing…".

## 6. The rules (extension, deterministic, before any model call)

### 6.1 Eligibility

A card is reviewed only when **every** row holds; otherwise the ordinary card
is shown and no model is called.

| # | Condition |
|---|---|
| 1 | Auto on for this conversation, not expired (60 min), Setting on, managed `disableAutoReview` unset, cap 1, bridge connected |
| 2 | A side panel is open and showing this conversation (checked again when the answer arrives) |
| 3 | The ordinary tab-bound page dispatcher raised the card (not programs, series, watchers, fan-out, dev-loop, tab management) |
| 4 | A DSH session, not external (MCP), not a fleet child |
| 5 | Prompt: an action, not forced / per-call-only / permission / devtools / browser-only / url-risk / requester / dev-loop; has a binding |
| 6 | Policy decision `default` |
| 7 | Tool ∈ click, type, select, hover, press, drag, navigate |
| 8 | Every addressed element found; none sensitive, `password` or `file`; for typing `typedTargetSensitive === false` |
| 9 | Not a download; links and forms on the same origin, links without a query; after reading web pages no data-carrying link path |
| 10 | The action falls under §6.2 or §6.3 |
| 11 | Limits not reached (§7) |

### 6.2 Rule "harmless" (the reviewer's allow counts)

| Action | Condition |
|---|---|
| Hover | always |
| Link click | a plain left click on a **real** link that opens in the same tab, its name equal to its visible text: `describe.ts` drops empty, fragment-only, `javascript:` and same-document hrefs (those links are buttons, §6.3); same origin, no query; a name of ≥ 3 letters; no committing word in the path (`/logout`, `/items/7/delete` → named) |
| Disclosure click | a plain left click; the element itself is a disclosure by its own markup (`aria-expanded`, `<summary>`, or a button with `aria-haspopup`/`aria-controls`) **and** its visible text equals its name and every word of the visible text is one of show, more, less, expand, collapse, next, previous, back, menu, details, close, cancel, all, comments, replies, results, items, options, info, page(s), section, thread (digits allowed; ZH 显示/展开/收起/更多/下一页/上一页/返回/菜单/详情/关闭/取消 with an optional noun) |
| Key press | Tab (not where the field offers suggestions), arrows, Home/End, PageUp/PageDown, Escape (not while a dialog is open), with at most Shift, only on a text field, text area, content-editable, email/url/tel field, link or button; `repeat` > 1 only in a text field, ≤ 10 |
| Navigation | same origin, no query or fragment, no committing word in the path, not after reading web pages |

### 6.3 Rule "named" (allowed only when the newest message names it verbatim, once)

| Action | What must appear in the user's newest panel message |
|---|---|
| Plain left click (no modifier, one click) on any other control (button, menu item, option, tree item, checkbox, radio, switch, tab, summary, link without a real destination, unknown element), submit controls, Space/Enter on a control | its full name (`mustName = [name]`); when other visible, enabled controls in the document share the name, also its row or section (`mustContext`: the row's first cell, emphasised text or heading, or the labelled section) in the same clause |
| Select (a native select whose chosen labels the page reported) | every chosen label |
| Drag (element to element) | both ends' names |
| Typing (3–500 characters, no control characters) into a located text field (textbox, search, email, url, tel, textarea, contenteditable host) with the default insertion path; the field empty, or a single-line field with `replace: true`; not autosaving | the full text as one whole quoted string (`exactText`, case kept); into a recipient/address/link/amount field one whole word (`exactToken`) |

The name is the accessible name, which must **equal** the element's visible
text (all lines, hidden parts skipped: `hidden`, aria-hidden, display none,
visibility hidden, opacity 0, font size 0, a zero clip, no box). For a
labelled field the visible text is its `<label>`s. An icon-only control has
none and is never Auto. Disclosure markup counts only on the element itself.

Never Auto (the card waits): a control without a visible name or with fewer
than 3 letters/digits (2 Han); a name cut short when read; a repeated name
without a row to say; arrow keys on selects, radios, sliders, spin buttons,
dates, comboboxes, tabs; Tab in a field that offers suggestions; Escape while
a dialog is open; Enter in a text field; character keys; shortcuts; drags by
offset or onto a slider; key-by-key, `insert`, trusted or focused-element
typing; typing longer than 500 characters, appending to a non-empty field or
replacing a multi-line one; fields that save on input; frames from another
origin.

### 6.4 The verbatim check (bridge, `namedCovers`)

* **Folding**: NFKC; ’ ‘ ʼ ＇ ` ´ → '; curly and angled double quotes → ";
  invisible format characters removed; case-folded for names.
* **Veto**: the restriction list runs on the WHOLE newest message (never a
  truncated copy): only/just read|look|check…, read-only, don't / do not /
  never / without / avoid / no need to, tell me if/whether, wait for me/my,
  leave … as, I will / I'll … myself|later, look but, no changes, 不要 别 只读
  只看 不得 无需 不用 勿 等我 我自己 我来 保持原样 先别 告诉我是否 看看就好.
  Draft / prepare / compose / write up veto clicks and selections, not typing.
* **Authorising part**: the first 600 characters, cut before the first
  blank-line-separated block that looks pasted (≥ 3 lines, or a line starting
  with >, From:, Subject:, To:, Date:, ---).
* **Clauses**: split at . ! ? ; followed by a space, at 。！？； and at line
  breaks, with quoted strings lifted out first. A clause authorises only if
  it is not a question (ends with ?, or starts with what/should/can/could/
  would/will/do/does/is/are/how/why/when/where/which/who/if/whether/may/…)
  and holds no negation, condition or deferral (not, n't, never, no,
  nothing, without, unless, until, before, after, once, if, when, wait,
  stop, hold, later, yet, myself, maybe, I will/I'll/I'd; 不 别 勿 等 之后 以后
  如果 是否 吗 再).
* **Names**: every required name, and the row (`mustContext`), in ONE such
  clause that holds an action verb (click, press, tap, hit, choose, select,
  pick, open, turn on/off, switch, enable, disable, check, uncheck, tick,
  toggle, drag, drop, move; 点击 点 按 选择 选中 打开 开启 关闭 启用 停用 勾选 切换 拖).
  A name is a quoted string that is not text to type, or follows the verb
  directly (later names of a list may follow "and" or ","), or — for several
  words — occurs as a whole phrase. A quoted string after
  type/write/enter/search/say/reply/comment/fill/put/paste (输入 搜索 回复 写)
  is text to type and names nothing. Common words (the, button, …) never name.
* **Typed text**: equals a whole quoted string of an imperative clause
  (whitespace collapsed, case kept); never a substring.
* **Empty**: no names and no text, or an empty newest message (an image or
  "Continue" only), authorises nothing.
* **Newest message**: a prompt the panel sent that the history does not show
  yet (queued behind a running turn) is the newest from the moment it was
  sent; its minted id is the turn marker the extension's per-message limits
  and "once" bookkeeping key on.

## 7. Limits and lifetime

* Opt-in per conversation from "Approvals: Ask · Auto"; a one-time explanation.
* Pauses while no panel shows the conversation; "Auto review is on in N other
  conversations" with **Turn all off**.
* Ends: turned off; 60 minutes; kill switch; take-over; conversation deleted;
  browser restart; early kill switches are not undone by a late state load.
* 25 Auto approvals per user message (then a "continue" card); 100 without a
  new message; **120 reviews (model calls) per conversation per hour**, kept
  with the rest of the state so a worker restart does not reset it.
* One review at a time per conversation; a new panel message cancels pending
  reviews.

## 8. Reviewer output and the decision

Output schema, strict: `{ "decision": "allow"|"ask", "risk": "low"|"medium"|"high", "reason": "…" }`;
anything else, a non-`stop` finish, an error, or 9 s → ask.

1. `ask` → ask (`model-ask`). The reviewer's ask always wins.
2. `highRiskWords` or a risk of high → ask (`high-risk`).
3. `harmless` → allow.
4. `named` → the newest panel message only (§6.4): a restriction → ask
   (`restricted`); a missing name, row or quoted text → ask (`not-named`);
   else allow, and the extension then lets each name or quoted text through
   once per message (a second use → card, "already used once").

The rules decide what CAN be approved; the model whether it SHOULD be.

The card never shows model text: the extension maps `code` to a fixed
sentence (EN/ZH) that names what to say, built from the names the card already
shows ("Say “click Save settings”", "Say “select Weekly”", "Say “drag Card to
Done”", "Put the whole text in your message"). The model's `reason` goes only
to the timeline details of Auto-approved rows and to the audit log.

## 9. What the extension reports and binds

`describe.ts` reports, besides kind and name: `submits`, `inForm`, `href`
(only for a real link, §6.2), `download`, `form`, `chosen`, `autoSubmit`
(selects; for text fields an onchange/oninput attribute), `disclosure` (on
the element itself), `rendered` (visible text), `newTab`, `dialogOpen`, for
text fields `empty` (one bit, measured on the editing host for editors) and
`suggests`, and for clicks and key presses `sameName` (visible enabled
controls sharing the name) and `rowKey`. All of these are folded into the approval binding, so a link that
turns into a download, a select that starts submitting, a control that stops
being a disclosure, or a field that is no longer empty after the review voids
the approval when the dispatcher re-describes the element.

Commit classes (send, delete, save, submit, share, account, change, confirm,
unknown, type, address) remain as labels for the reviewer's prompt and the
card; they no longer decide anything except that a committing word in a
link's path makes the link `named`. High-risk words (payments, purchases,
checkout, billing, banking, passwords, 2FA, recovery, keys, tokens,
credentials, permissions, admin, owner, account deletion; paths such as
`/checkout`, `/security`, `/admin`) always ask.

## 10. Reviewer input (bridge)

* Trusted: the session's own user prompts the bridge forwarded from the panel
  (§5.4), text blocks only, attached page selections cut out, newest 12,
  ≤ 8 000 characters.
* Facts: the extension's structured action, including `rule`.
* Untrusted: element name and context, title, address and destination
  (origin + path), drop target, chosen options, typed text (first 200 units;
  the verbatim check uses the full text), the last ≤ 3 approved steps; each a
  plain line JSON-encoded inside a block fenced with a per-request nonce.

## 11. Failure modes

| Failure | Result |
|---|---|
| Old bridge (no cap) | toggle disabled with a reason |
| Host without LLM service / history API, or without RPC ids on user prompts | `host-unsupported` |
| No panel prompt in the conversation | ask (`no-user-message`) |
| Model error / timeout / invalid output | card with a fixed sentence |
| Panel closed or switched during the review | the answer is ignored; the card waits |
| Binding or review id mismatch; a different rule or different required words on the re-check | card |
| Element, target, form, options, download, disclosure or emptiness changed after an allow | re-describe voids it |
| New user message during review | review aborted → card |

## 12. Audit

One entry per review: `kind: 'auto-review'`, `callId`, `toolCallId`,
`decision`, `code`, `risk`, `reason` (model text, sanitized, ≤ 300), `model`,
`durationMs`, `binding`, `failure`.

## 13. Cost and privacy

Each reviewed action makes one extra request to the conversation's own model
through DSH (the user's account), at most 120 per conversation per hour.
Actions no rule can approve (unnamed controls, shortcuts, appends) make no
model call. It sends the user's panel messages in this conversation, the
structured action (including the exact names and the typed text the rule
checks), the element's label and context, the page title and address
(origin + path), the destination and chosen options. No `sessionId` is
attached.

What the rules cost the user: a button is approved automatically only when
the newest message names it ("click Save settings", not "save it"); typing
only when the message contains the text; one-word names need "click X" or
quotes; anything else is the ordinary card, with a sentence saying what to
write next time.

## 14. Security review findings and what changed

First review (F1–F8): newest panel message only; restriction veto; link
targets, form actions, chosen options described and bound; approvals only
while a panel shows the conversation; navigation and data-carrying links
ineligible after reading web pages; trust only panel prompts; fixed card
sentences; same-site model-free attacks; tombstones, per-hour review cap,
UTF-16 caps.

Second review (verbatim rules replace the verb-class/overlap gate):

* **R2-1** typed text beyond 200 characters was unchecked → the full text
  (≤ 500) travels as `exactText` and must appear verbatim.
* **R2-2** smuggling via short tokens, punctuation, class verbs, `includes`
  and appends → whole-text substring; address fields whole-token; appends to a
  non-empty field ineligible.
* **R2-3** verb anywhere / context overlap ("tell me if I should reply" →
  Send; context stuffing; German "Post") → names only, never context;
  one-word names need "click"/quotes; extended restrictions.
* **R2-4** choice kinds collapsed to none; treeitem → option → every control
  kind is `named`.
* **R2-5** arrow keys changed values → navigation keys only on text fields,
  links and buttons.
* **R2-6** fragment-only and empty-name links were low → no destination
  reported; button rules; unnamed never Auto.
* **R2-7** the harmless list was too broad → disclosure markup required; list
  trimmed (no toggle/up/down/read/hide/answer/go/dismiss/open).
* **R2-8** drag judged by words → both ends named; offset and slider drags
  ineligible.
* **R2-9** prefix matches → whole-phrase word boundaries.
* **R2-10** download, autoSubmit, disclosure and emptiness bound; the
  dispatcher re-describes the element after an allow; the background's own
  re-check requires the same rule and words.
* **R2-11** caller-chosen trusted id → the bridge mints it, overwrites the
  payload's, binds it to its first event, forgets it on purge. Attempts are
  persisted.

Third review (R3):

* **F1** typing onto non-text controls by keystrokes → typing only into a
  located caret field via the default path; keystrokes/insert/trusted/focused
  never Auto.
* **F2** the veto ran on a 2 000-character tail; curly apostrophes; names in
  questions and deferrals → whole-message veto, folding, imperative clauses
  with an action verb.
* **F3** pasted mail and quoted dictation named controls; substrings typed →
  600-character authorising part, paste detection, dictation quotes never
  name, typed text equals a whole quoted string.
* **F4** a name bound no instance and was never consumed → once per message,
  row required for repeated names.
* **F5** accessible name ≠ visible text; inherited disclosure → equality with
  visible text, icon-only never Auto, disclosure on the element only.
* **F6** modifiers/buttons/click counts, new-tab links, foreign frames →
  never Auto.
* **F7** replace on multi-line fields, editor emptiness on a child,
  forwarding/recovery/payout addresses, autosaving fields → fixed.
* **F8** Tab with suggestions, Escape with a dialog, text-less newer
  messages, queued prompts, empty `mustName` → fixed.

## 15. Deferred

* Cross-origin navigation to origins the user named.
* Reviewing new tabs, reload, back/forward, dialogs, reads, ARIA comboboxes.
* MCP/external sessions; prompts from the DSH web UI as instructions.
* A per-site "never auto-review" list (set the site to `ask`).
