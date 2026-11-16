# Auto review for page actions: design

Status: implemented for v0.3.0 (unreleased). This document is the reference
for the security review; README.md / README.zh.md carry the user-facing text.

## 1. What it is

A per-conversation mode, off by default, in which a reviewer model decides,
for each *eligible* ordinary approval card, whether the pending page action
fits what the user asked for. "Allow" runs the action without a click, exactly
like the user's "Allow once" for that card. "Ask" (or any failure) shows the
ordinary card with one extra line, "Auto review asked: <reason>". There is no
"deny" outcome: the fallback is always the user's card.

The reviewer is the conversation's own provider and model (the DSH session's
current request route), called through DSH's LLM service on the host.

## 2. Threat model

| Attacker | Capability | What Auto review must not let them do |
|---|---|---|
| Compromised agent (prompt-injected or misaligned main model) | Chooses every tool call and its arguments; writes assistant text; can phrase calls to look benign | Get a forced card skipped; reach an ineligible action without a card; make the reviewer see agent text as user instruction |
| Hostile page | Authors element labels, row/section text, page title, URL path, typed-into-field placeholders; can restyle elements (`role`), relabel after the card is computed | Break out of the untrusted section of the reviewer prompt; instruct the reviewer; swap the element between review and execution |
| Both together | Agent reads the page, page tells agent what to do and tells reviewer to allow it | Exfiltrate data; trigger commit-like actions the user never asked for |

Out of scope (unchanged by this feature): a compromised DSH host or bridge
process, a compromised extension, a malicious browser, a user who asks for a
harmful action in their own words, DSH plugins/mods that submit text *as the
user* (DSH documents this for its own Auto review too).

### What the reviewer can and cannot weaken

* It can only turn an **ordinary, eligible** card into "approved once". It
  cannot create grants, trust origins, change settings, approve forced cards,
  or approve a card the extension did not ask it about.
* The extension decides eligibility **before** asking, from facts it computed
  itself; the reviewer's answer cannot widen eligibility.
* The extension applies an "allow" only for the exact approval id and payload
  binding it asked about, and then re-probes the element after the answer,
  exactly as for a user's "Allow once". A changed element voids it.
* A wrong "allow" is bounded by: eligibility (no forced cards, no sensitive
  fields, no cross-origin navigation, no uploads/clipboard/dialogs/devtools,
  no programs), deterministic risk floors (commit-like controls are at least
  medium; payment/account/credential words are high = always ask), per-turn
  and consecutive limits, the 60-minute expiry, and the user's kill switch /
  take-over / one-click off.
* What protects data is the **deterministic floor** (taint rules, site policy,
  strict mode, sensitive fields), not the reviewer. The model-free check
  proves this with a reviewer that always says allow.

## 3. Data flow

```
agent model ──browser_click──► bridge (BR) ──tool.call{id, toolCallId}──► extension (EXT)
                                                     │ policy layer (deny / force / trust / default)
                                                     │ probe element (describe.ts) → ApprovalPrompt + review facts
                                                     │ resolveApprovalGate → 'prompt'
                                                     │ eligibility floor (security/auto-review.ts)  ── ineligible ─► card
                                                     │ limits (per turn / consecutive)              ── exhausted ─► card + line
EXT ──rpc bridge.review.ask {toolCallId, reviewId, binding, action}──► BR
   BR: owned pending call? session from BR's own record; not external; tool name matches
   BR: trusted user messages (session log, user-sourced only) + action facts + escaped page data
   BR: ctx.llm.stream(provider/model of the session's request header, system=policy, 9 s timeout)
   BR: strict JSON schema + deterministic floors → {decision, risk, reason}
   BR: audit entry kind 'auto-review' (decision, risk, reason, model, latency, binding)
BR ──rpc.result {reviewId, binding, decision, risk, reason, userTurn}──► EXT
   EXT: reviewId + binding must equal what it asked; decision 'allow' → 'approved' (as Allow once)
        anything else → ordinary card with "Auto review asked: <reason>"
   EXT: dispatchToolCall re-lists frames, re-probes the element, recomputes the binding → mismatch refuses
```

The agent model sees only the tool result as usual. Nothing about the review
(decision, risk, reason, latency) is put into tool results or errors, so the
agent cannot learn to phrase requests to pass.

## 4. Messages

### 4.1 Capability

Server caps gain `autoReview: 1` when the plugin can offer the feature at all
(config not disabled, the host composes an LLM service with `stream`, and the
session API exposes the history reader). It is stripped from configured caps
and re-added by `BridgeServer` like `hostApprovals`. `isCaps` accepts an absent
value or any positive safe integer; only version 1 is acted on. An old
extension ignores the key; an old bridge never sends it, so a new extension
never offers the toggle there.

### 4.2 `bridge.review.status` (extension → bridge)

`{ sessionId }` → `{ available: true, model: "<provider>/<model>" }` or
`{ available: false, reason: 'host-unsupported' | 'no-model' | 'external-session' | 'disabled' | 'not-started' }`.
Session scope is checked (`allowsSession(..., 'read')`). Used only to enable /
disable the toggle with a one-line reason; it grants nothing.

### 4.3 `bridge.review.ask` (extension → bridge)

```
{ toolCallId, reviewId, binding (sha-256 hex), action: ReviewAction }
```

`ReviewAction` (validated field by field; anything else → `bad-request`):

| field | type | source |
|---|---|---|
| `tool` | one of the eligible tool names | extension; must equal the bridge's own record of the pending call |
| `verb` | `click`·`double-click`·`type`·`select`·`hover`·`press`·`drag`·`navigate` | extension |
| `targetKind` | `TARGET_KINDS` vocabulary or `none` | extension (content-script description) |
| `targetClass` | `link`·`button`·`field`·`control`·`other`·`none` | extension |
| `formSubmitLikely` | boolean | extension (native tag / type / form ancestor; Enter in a form field) |
| `commitLike` | boolean | extension (structure + EN/ZH name words) |
| `highRiskWords` | boolean | extension (payment/account/credential words in the name/context) |
| `sameOrigin` | boolean | extension (navigation destination vs current top origin) |
| `tainted` | boolean | extension's taint record for the session |
| `typedChars` / `key` / `options` | number / ≤ 40 chars / ≤ 5×80 chars | extension (agent-authored payload, shown as untrusted) |
| `untrusted.name`, `untrusted.context`, `untrusted.title`, `untrusted.url`, `untrusted.destination`, `untrusted.typed`, `untrusted.recent[]` | strings ≤ 200 chars | page-authored or agent-authored; always in the untrusted section |

Answer: `{ reviewId, binding, decision: 'allow' | 'ask', risk?, reason, userTurn? }`
or an RPC error. `userTurn` is an opaque marker of the newest user message the
reviewer saw; the extension uses it to reset the per-turn counter.

### 4.4 `bridge.review.cancel` (extension → bridge)

`{ toolCallId, reviewId }`: aborts an in-flight review (Auto turned off, kill
switch, take-over, new user message, call cancelled). Reviews are also aborted
when their tool call settles or the connection closes.

### 4.5 `tool.call` frame

Gains an optional `toolCallId` (the model's tool-call id), so the panel can
mark the right timeline step "Reviewing…". Old extensions drop it.

## 5. Eligibility (extension, deterministic, before any model call)

A card is reviewed only when **every** row holds. Otherwise the ordinary
card is shown and no model is called.

| # | Condition | Ineligible examples (and why) |
|---|---|---|
| 1 | Auto is on for this conversation, not expired (60 min), the Setting allows it, managed `disableAutoReview` is not set, the bridge advertised `autoReview: 1`, the bridge is connected | — |
| 2 | The call came through the ordinary tab-bound page-action path (`routeToolCall` → `dispatchToolCall`), which is the only caller that passes the review option | commit-gate (strict mode) cards, page-delta/follow refresh reads, developer tools, watchers, `browser_fanout`, `browser_run` programs and series, dev-loop captures, tab management, downloads, `browser_open_tab` |
| 3 | DSH session: `sessionId` present, not an external (MCP) session, the call's approval session is its own (not a fleet child), no program step (`call.program`, program cover) | MCP clients have no user instruction source; fleets act with their own allowlists |
| 4 | Prompt: `kind === 'action'`; not `forced`; not `perCallOnly`; no `permission`; not `devTools`; not `browserOnly`; no `urlRisk`; no `requester`; no `devLoopFor`; has a `binding` | every forced card (taint, site ask, read-only, secrets in URL) |
| 5 | Policy decision for the call is `default` | site `ask` (forced), `read-only`/`blocked` (denied), managed pin (denied outside) |
| 6 | Tool ∈ {`browser_click`, `browser_type`, `browser_select`, `browser_hover`, `browser_press`, `browser_drag`, `browser_navigate`} | `browser_clipboard`, `browser_upload`, `browser_dialog` (confirm() is often the commit), `browser_back`/`forward` (destination unknown), `browser_reload` (may resubmit POST), paginated `browser_extract`, every read |
| 7 | Every addressed element was found (`state: 'found'`), none is `sensitive`, none is a `password` or `file` kind; for `browser_type`, `typedTargetSensitive === false` (undefined counts as sensitive); for `browser_press` without a locator the focused element must be found and not sensitive | password, payment, one-time-code fields (privacy.ts), unknown/missing targets |
| 8 | `browser_navigate` only to the current top page's origin | cross-origin navigation is **ineligible in v1** (the bridge does not tell the extension which origins the user named) |
| 9 | Per-conversation limits not reached (§7) | then the card shows with a limit line |

Note: an explicit user or managed site rule stricter than default never
produces an ordinary card (blocked/read-only deny, ask forces), so row 5 covers
it; the check is still explicit.

## 6. Reviewer input (bridge)

### 6.1 Trusted: the user's own messages

From `agent.session.snapshotEvents()` (DSH 0.2.2-rc.1…rc.3, same API), events
of type `user/message` whose `source.kind === 'user'` **and** `source.rpcId` is
a string (a prompt a client submitted over the session RPC: the side panel or
the DSH web UI), and whose seq is the session's own (`isOwnSeq`). Excluded:
schedule deliveries (`kind: 'schedule'`), browser snapshots and watcher wakes
(the bridge's own kinds), subagent creation prompts (no `rpcId`), inherited
fork history, tool results, assistant text and reasoning, project
instructions. Only text blocks are used. A page selection the user attached is
wrapped by the panel in an `<UNTRUSTED_PAGE_CONTENT nonce=…>` fence inside the
user message: every fenced block is cut out (an unterminated fence cuts the
rest of the message) and replaced with `[page text the user attached: omitted]`.
The newest 12 messages, each ≤ 2 000 characters, ≤ 8 000 total (newest kept).

Feature detection: the history reader (`snapshotEvents`, `isOwnSeq`,
`requestHeader`) must be functions and the LLM service must have `stream`.
If not, `bridge.review.status` reports `host-unsupported` and the cap is not
advertised. If a session has no user message with an `rpcId`, reviews answer
"ask" ("no message from you in this conversation authorizes page actions").

### 6.2 The action (extension-computed, structured) — trusted facts

Tool, verb, element kind/class, same-origin, form-submit-likely, commit-like,
high-risk words, taint state. These are computed by the extension from the
call arguments and the content-script description (native structure, not the
page-chosen `role`).

### 6.3 Untrusted: page and agent text

Element name and context, page title, page URL (origin + path, no query or
fragment), navigation destination (origin + path), typed text (≤ 200 chars,
only for non-sensitive fields), selected option labels, the step labels of the
last ≤ 3 actions Auto approved this turn. Each value is reduced to one line of
plain text (`pageTextForCard` rules: invisible/bidi characters removed),
capped at 200 characters, then JSON-encoded inside a block fenced with a
per-request random nonce:

```
<untrusted_page_data nonce="k3Jx…">
{"element_name":"…","element_context":"…",…}
</untrusted_page_data nonce="k3Jx…">
```

JSON encoding escapes quotes, backslashes and newlines; in addition `<` and `>`
are encoded as `<` / `>`, so page text can never contain the closing
tag, and the nonce is unknown to the page.

### 6.4 State

`tainted` (the conversation has read web pages that taint), the number of
actions Auto approved this turn, and the last ≤ 3 of their labels (untrusted).
No page content or snapshots are sent in v1.

## 7. Limits and lifetime

* Opt-in per conversation from the composer control "Approvals: Ask · Auto";
  first use shows a one-time explanation dialog (stored as acknowledged).
* Setting "Offer Auto review" (default on) makes the control available; the
  managed key `disableAutoReview` forces it off and hides it.
* Ends when: the user turns it off; 60 minutes after it was turned on (the
  control says "ended — turn on again"); the kill switch; take-over; the
  conversation is deleted; the browser restarts (state lives in
  `chrome.storage.session`).
* At most **25** auto-approved actions per user turn. The 26th eligible card is
  shown with "Auto review has approved 25 actions since your last message.
  Approve this one to let it continue." Approving it (or sending a message)
  resets the count.
* At most **100** auto-approved actions without any new user message (the
  continue card does not reset this). After that every card shows with "Auto
  review is paused until you send a message."
* One review at a time per conversation (queued in the extension, serialized
  again on the bridge). A new user message (panel `session.prompt`, or a newer
  user message seen by the bridge after the model answered) cancels pending
  reviews: their cards are shown.
* Turning Auto off, kill switch, take-over, a cancelled call: in-flight reviews
  are aborted and fall back to the card (or the call is cancelled).

## 8. Reviewer prompt and output

The system prompt is fixed (see `packages/browser/bridge-browser/src/auto-review/prompt.ts`,
quoted in the README's design notes). Output schema, strict:

```
{ "decision": "allow" | "ask", "risk": "low" | "medium" | "high", "reason": "<one short sentence>" }
```

Exactly these three members, no duplicates, no other text (reasoning blocks
before the text are allowed; tool calls are not). `reason` ≤ 300 characters.
Anything else, a non-`stop` finish, an error, or no answer within **9 s** →
"ask".

Deterministic post-rules (pure, unit-tested):

1. `decision: 'ask'` → ask.
2. `risk: 'high'` → ask.
3. Floor: `highRiskWords` → floor high → ask. `commitLike` or `formSubmitLikely`
   → floor medium; a reviewer risk below the floor → ask ("the reviewer rated a
   commit-like control as low risk").
4. Effective medium + allow → also requires that one of the user's own
   messages contains a commit verb (EN/ZH list: submit, send, post, save,
   delete, remove, confirm, publish, apply, update, 提交, 发送, 发布, 保存,
   删除, 确认, …). Without it → ask. This is a weak lexical check that the
   instruction exists, not proof that it covers this target; the model judges
   the target.
5. Otherwise allow.

The reviewer's `reason` is attacker-influenced text: it is sanitized like page
text, capped at 160 characters, and only ever shown to the user, attributed to
Auto review (card line, timeline row) and stored in the audit log.

## 9. Commit-like detection (extension)

`describe.ts` reports, besides kind and name, the element's native
`submits` flag: a `<button>` whose effective type is `submit` (no type
attribute counts) with a form owner, an `<input type=submit|image>` with a
form owner, or an input/textarea/select inside a form (Enter there submits;
used for `browser_press` Enter/NumpadEnter). This is derived from the DOM
structure, never from `role`, so a page cannot hide a submit button behind
`role="tab"`. On top, the element name and context are matched against EN/ZH
words (submit, send, post, publish, save, apply, confirm, delete, remove,
pay, buy, order, checkout, transfer, sign in, log out, 提交, 发送, 发布,
保存, 确认, 删除, 移除, 支付, 付款, 购买, 下单, 转账, 登录, 退出 …).

`submits` is folded into the approval binding (only when true, so bindings of
other elements are unchanged): a target that becomes a submit control between
the review and the execution voids the approval.

Known gap: a click on a plain `<div>` whose JavaScript handler deletes or
sends something is undetectable structurally; only its name can betray it.
That is why the floor, not the reviewer, protects data, and why the limits
exist.

## 10. Failure modes

| Failure | Result |
|---|---|
| Old bridge (no cap) | Toggle hidden-disabled with "Update DSH browser bridge"; behaviour unchanged |
| Old extension | Never sends review RPCs; bridge unchanged for it |
| Host lacks LLM service / history API | `host-unsupported`; toggle disabled with the reason |
| Session has no route yet | `not-started` (toggle can still be switched on; the first review then asks) |
| Model error / timeout (9 s) / invalid output | Card with "Auto review could not decide: …" |
| Bridge disconnects mid-review | RPC rejects → card |
| Binding or reviewId mismatch in the answer | Card |
| Element changed after an allow | Re-probe voids it: the call fails with "The page changed while approval was pending" |
| New user message during review | Review aborted → card |
| Auto turned off / kill switch / take-over during review | Review aborted → card (kill switch/take-over also hold or cancel the call as before) |

## 11. Audit

The bridge writes one entry per review: `kind: 'auto-review'`, `callId`,
`toolCallId`, `decision` (`allow`/`ask`), `risk`, `reason` (sanitized, ≤ 300),
`model` (`provider/model`), `durationMs` (the review's latency), `binding`,
`floor` when a deterministic floor overrode the reviewer, and `failure` when it
failed (timeout, invalid output, cancelled, no user message, …). No page text beyond what approval entries already hold (the URL is
redacted as elsewhere; element names are not stored). The extension annotates
the call's decision as `auto-reviewed` when the review allowed it.

## 12. Cost and privacy

Each reviewed action makes one extra request to the conversation's own
provider and model through DSH (the user's account and quota). It sends: the
user's own messages in this conversation (bounded as in §6.1), the structured
action, the element's label and context, the page title and address (origin +
path), and typed text for ordinary fields. The request carries
`purpose: 'browser-auto-review'` and **no** `sessionId`, so DSH extensions
that attach per-session data to requests (e.g. the DeepSeek session-log
upload) do not attach it to reviews; the cost is that provider prompt caching
keyed by session does not apply.

## 13. Deferred (not in v1)

* Cross-origin navigation to origins the user named.
* Reviewing `browser_open_tab`, reload, back/forward, dialogs, reads.
* Sending page snapshots to the reviewer.
* Reviewing MCP/external sessions.
* A per-site "never auto-review" list (users can set the site to `ask`).
* Prompt caching across reviews.
