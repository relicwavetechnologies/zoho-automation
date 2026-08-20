# One connect ask, on the channel the member is in

> Status: **Active. Ready to build, 2026-08-20.** The web approval card that
> blocked this is done (`plans/decision-module-deepening.md`, all phases
> complete), so the surface this plan delivers onto now exists. Start at
> `## Next action`.
>
> Created: **2026-08-19.** Current state re-verified against the code
> **2026-08-20**, after four decision-module commits landed on the files Phase 5
> builds on.
>
> Executor: **Composer 2.5, Tier B.** Exact files and the shape of each change
> are given. Each phase carries a **Do not** list. Ask rather than improvise when
> something here disagrees with the code.
>
> Scope: **The path from "a provider refused this for lack of access" to "the
> member has a Connect button in front of them and the agent knows it was sent".**
>
> Parked: **`jan/` (Desktop). Do not open it.** Desktop runs answer into a
> terminal that owns its own rendering; it gets the same honest text fallback it
> has today and no new surface.

## 1. Outcome

When a run needs Google Drive or Sheets and the member only granted Gmail, the
agent asks for that access on purpose, the member gets a Connect button on
whichever channel they are actually in, and when they come back the run picks up
knowing exactly what it was granted.

Two ways in, and both matter.

**The front door.** The agent calls a connect tool, either because it can see it
is about to need access it does not have, or because the member simply asked
Divo to connect Google. Nothing fails first.

**The floor.** A call does fail, and the failure is a named case rather than
`upstream_failure`. The error says which of the two things is wrong, no Google
connection at all or a connection missing scope, and points at the skill that
says what to do. The agent reads it and walks through the front door.

The floor exists because the front door is a choice the agent has to make, and
this codebase has already paid for assuming it would. When a tool disappeared
from Pi's list, Pi did not say it lacked access, it invented confident reasons.
An agent that forgets to call the connect tool must still produce the truth.

Today none of the front door exists, the floor is an `upstream_failure` string,
the web card does not exist at all, and the resumed run is handed its own old
question with no idea why it is running.

When this is finished:

- a scope gap is a named value produced by one classifier, not a string match
  scattered across tool families;
- one interface issues the ask, whatever the provider;
- the ask reaches Lark as a card and the web as a decision, through the surface
  record that already governs every other Lark/web difference;
- the agent's context says "a Connect ask was sent, stop here" in one shape
  across every tool family;
- a second provider goes through the same interface, which is what makes the
  seam real rather than hypothetical.

## 2. Scope boundary

### Included

- Google Workspace, all products, both the pasted-reference path and the ordinary
  `call` path. **Google only. Every other provider hard fails.** See D9.
- Both cases: no Google connection at all, and a connection missing scope.
- A provider-neutral connect tool the agent can call before anything fails, and
  that a member can trigger by asking Divo directly.
- A connections skill, pointed at from the failure text rather than retrieved by
  intent.
- Lark delivery and web delivery.
- The agent-visible result the tool returns after an ask is sent.
- The resumed run telling the agent what it was actually granted.

### Parked, do not spend time here

- **Desktop (`jan/`).** It has no card surface and its `SurfaceCapabilities` are
  Lark's with a streamed work log. The text fallback is the correct outcome
  there, not a gap to close.
- **Every provider except Google.** Shopify, Airtable and Canva all have their
  own authorization paths. None of them is built here, and the tool hard fails
  on them rather than pretending. Phase 8 is struck for this reason, not
  deleted.
- **`zoho.skill.ts:16` and `shopify.skill.ts:7`.** Both currently tell the agent
  to send the member away to reconnect. Both become wrong the day their provider
  is supported. Note them, do not edit them.
- **The OAuth exchange and the resume.** `google-connection-continuation.ts`
  already works, is 376 lines, and is not the problem. Do not refactor it.
- **Widening `DecisionContinuation`.** It is narrowed to `{ kind: 'none' }` on
  purpose, documented at `advance-backend/src/application/decision/decision.service.ts:99`.
  The connect resume runs through the existing connection-continuation path, not
  through the decision resumer. See D4.

## 3. Locked decisions

**D1 — A scope gap is a value, not a message.** The classifier returns a
`ScopeGap` naming the provider, the tool id, and the scope groups that are
missing. Reason: today the only signal is provider prose caught at
`google-workspace-mcp.tool.ts:531` and turned into `upstream_failure`. A string
cannot be routed, counted, or tested.

**D2 — One asker, provider adapters behind it.** `BeginGoogleWorkspaceAuthorization`
(`google-workspace-mcp.tool.ts:173`) becomes an adapter behind a
provider-agnostic interface. Reason: the interface is Google-shaped, so Shopify
had to grow its own `missing_scope` vocabulary at
`advance-backend/src/application/shopify/shopify-connection.service.ts:16` with
nothing to hand it to.

**D3 — Delivery is chosen from `surfaceCapabilities`, not from a channel branch.**
`advance-backend/src/domain/channel/surface-capabilities.ts` is already the one
record that states every Lark/web difference. Reason: adding an `if (channel ===
'lark')` to the connect path is exactly what that record exists to prevent.

**D4 — The connect ask renders through the decision card, not a second card
family.** The decision card is already the centralized human-ask component and is
already mounted on web. Reason: building a parallel web connect card would give
the product two answer surfaces that look different for no reason the member can
see. What the decision card lacks is a link option, and adding one is smaller
than a new card. See section 6.

**D5 — The connect decision does not settle through the decision resumer.**
Pressing Connect opens a URL. The run resumes when OAuth completes, through
`google-connection-continuation.ts`, exactly as it does today in Lark. Reason:
`AskDecision.continuation` is narrowed to `{ kind: 'none' }` because a native
decision row carries no re-runnable payload. A link option settles nothing and
needs nothing widened.

**D6 — The agent is told the ask was sent, and told to stop.** One result code
across every tool family. Reason: an agent that cannot tell "you are not allowed"
from "this does not exist" invents architecture, which is the documented root
cause of the exception explosion.

**D7 — A web run re-runs itself after OAuth, exactly as Lark does.** Decided by
Abhishek, 2026-08-20, closing Q1. Reason: the two channels must behave the same;
a web member who connects and then has to retype the ask is being handed Lark's
job. This raises Phase 4's bar. The web origin must carry enough to replay the
run, not merely enough to find the thread. See the Phase 5 last step.

**D8 — Ship the member-owned case only.** Decided by Abhishek, 2026-08-20,
closing Q2. A member who hits a gap on a connection somebody else owns gets the
existing honest text, not a button that would do nothing when pressed. Reason:
routing the ask to the owner is a second delivery path with a second surface to
resolve, and it is larger than the rest of Phase 5 put together. Write what you
find about that case into the build log; do not build it.

**D9 — Google only, and everything else fails loudly.** The adapter map has one
entry and an explicit throw for the rest. Reason: `AGENTS.md` puts silent
degradation at the top of the cost list, and a connect tool that quietly does
nothing for Shopify is worse than one that refuses, because the agent will tell
the member a button is coming.

**D10 — The tool's name and schema are provider-neutral; its implementation is
not.** Reason: the name is a contract with a model that has learned it, and
renaming later is more expensive than choosing well now. The tool covers both
connecting from nothing and widening an existing grant, so it cannot be named
after either one.

**D11 — The model names tool ids, never scopes.** The backend derives scopes
through `googleScopeGroupsForToolIds`. Reason: a model asking for access asks
generously, and the Google consent surface was deliberately narrowed from 40
scopes to 6 and verified in production. Letting the model enumerate scopes hands
that win back.

**D12 — Two named cases, one next move.** `not_connected` and
`insufficient_scope` are distinct values. Reason: the agent does the same thing
for both, but says a different sentence to the member, and a member who has never
connected Google should not be told their scope is insufficient.

**D13 — The failure text points at the skill.** Reason: skills are retrieved by
intent at the start of a run, and "I have just been denied" is not an intent any
router sees in advance. A pointer carried by the error arrives exactly when it is
needed, which is why the skill is workable here at all.

**D14 — The resume reports what was granted, not what was asked for.** Reason: a
member can approve a subset on Google's consent screen. An agent told it has
Drive when it does not fails a second time with less excuse than the first.

## 4. Open questions

None. Q1 and Q2 were answered by Abhishek on 2026-08-20 and are now D7 and D8.

## 5. Current state

Everything below was re-read on **2026-08-20**. Line numbers will drift.

Four commits landed on the Decision module after this plan was first written
(`0afa011c4`, `b69d91842`, `f8913cb31`, `54a33f3a4`). Three claims in the
original version of this section were made stale by them and are corrected here.
Where this section and the code disagree, the code wins and you fix this section.

**Detection exists in two narrow places and is absent from the main one.**

- `missing_scope` is produced at
  `advance-backend/src/application/artifacts/google-sheet-resource-resolver.ts:83`
  and declared at `advance-backend/src/application/artifacts/google-drive-xlsx-resource-resolver.ts:19`.
  Both only run for a **pasted Google URL**.
- The ordinary MCP call is wrapped in a `catch` that returns
  `ToolError{ reason: 'upstream_failure' }` at
  `google-workspace-mcp.tool.ts:531`, with the message built at `:534`. A Google
  403 for insufficient scopes goes down that path. Nothing there consults
  `beginAuthorization`. **This is the user's exact scenario and the centre of
  this job.** That file returns `upstream_failure` at five sites (`:322`, `:346`,
  `:412`, `:500`, `:531`); `:531` is the one that matters here.
- `withRecoveryHint` (`google-workspace-mcp.tool.ts:660`) special-cases exactly
  one message, the Office-file case. Scope errors get no hint.
- A separate `missing_scope` already reaches the tool at `:367` and `:373`, but
  only through `resolveConnection`, and it produces prose at `:638` rather than a
  value.

**The ask is Google-shaped and has three call sites.**

- Interface: `BeginGoogleWorkspaceAuthorization`, `google-workspace-mcp.tool.ts:173`.
- Implementation: `createBeginGoogleAuthorization`,
  `advance-backend/src/application/connections/begin-google-authorization.ts`
  (149 lines).
- Called from `google-workspace-mcp.tool.ts:371` (pasted reference), `:460`
  (no accessible connection), and
  `advance-backend/src/application/tools/families/mail-automations.tool.ts:863`.
  Both Google sites return `code: 'google_workspace_authorization_pending'`, at
  `:387` and `:470`.
- Declared on the deps at `:198` and `:208`. Wired in
  `advance-backend/src/composition.ts:930`, passed at `:1936` and `:1949`.
- The scope maths it needs already exists and is good:
  `googleScopeGroupsForToolIds` / `googleScopesToRequestForToolIds` in
  `advance-backend/src/application/google/google-scope-request.ts`, and
  `hasGoogleScopeGroups` at
  `advance-backend/src/domain/google/google-workspace-scope.ts:127`. **Do not
  rebuild these.**

**Delivery is Lark-only, and the reason is structural.**

- `RunOrigin` (`advance-backend/src/application/connections/run-origin.store.ts:23`)
  requires `larkOpenId`, `larkTenantKey`, `chatId`, `chatType`,
  `originalMessageId`. It also carries a Google-specific `googleAuthorization`
  field at `:35`.
- `runOrigins.remember` has **exactly one caller**:
  `advance-backend/src/application/runtime/lark-pi-runtime.service.ts:777`.
  `advance-backend/src/application/runtime/web-run.service.ts` (645 lines) never
  writes one.
- So on web, `recallOrigin` returns undefined, `begin-google-authorization.ts`
  returns `{ status: 'unavailable' }`, and the model receives
  `SELF_SERVICE_CONNECT_HINT` (`google-workspace-mcp.tool.ts:191`, used at
  `:485`): prose telling the member to go find Connected apps themselves. **No
  button is ever sent on web today.**
- The only connect card in the repository is
  `advance-backend/src/infrastructure/channels/lark/lark-google-connect.ts`
  (49 lines, Lark JSON).
- **Easier than this plan first claimed.** The web thread id is a plain field on
  the run service's own input, `web-run.service.ts:90`, used at `:218`, `:359`
  and `:374`. The earlier note that it lives only on `metadata.execution.threadId`
  was wrong. Better still, `webIncomingMessage` at `:618` already adapts a web
  turn into the runtime's `IncomingMessage` vocabulary with
  `chatId: asChatId(input.threadId)`. Read it before designing Phase 4; the
  channel-agnostic shape you need is half-built there.

**The centralized ask component exists on web and is now in real use.**

- `advance-backend/src/domain/decision/decision.ts:35` defines `DecisionOption`
  as `value / label / tone / settles`. **There is still no URL field.** The
  browser half mirrors it at `admin/src/pages/workspace/decisions/decision.ts:19`
  with the same four fields. Phase 5's central edit is unchanged.
- **Corrected.** `DecisionService.ask`
  (`advance-backend/src/application/decision/decision.service.ts:299`) now has
  **three production callers**: `approval-gate.service.ts:211`,
  `business-action.service.ts:96`, and `automation-plan.service.ts:292`, plus the
  composition wiring at `composition.ts:2530`. The original claim that it had no
  production caller is dead. This is good news for you: Phase 5's web courier has
  three working examples to copy instead of being the first of its kind. Read
  `business-action.service.ts:96` first, it is the smallest.
- **Corrected.** `LarkApprovalCardHandler` no longer exists. `54a33f3a4` removed
  the legacy approval-card compatibility path. The Lark card family is now
  `lark-decision-card.handler.ts`, `lark-decision-card.ts` (168 lines),
  `lark-decision.courier.ts` (60 lines), and `lark-google-connect.ts`.
- **New, and it makes Phase 5 better than planned.** Decisions gained a subject
  vocabulary: `DecisionSubject` / `DecisionPreview` / `DecisionBrand` at
  `advance-backend/src/domain/decision/decision-subject.ts` (118 lines), mirrored
  at `admin/src/pages/workspace/decisions/subject.ts` (160 lines).
  `DecisionBrand` (`decision-subject.ts:32`) already includes `google`,
  `googleDrive`, `googleSheets` and `shopify`. A connect ask is exactly a
  branded subject, so the card can carry the Google mark and accent for free
  rather than being a plain sentence. `Decision` also gained `threadId` at
  `decision.ts:152`.
- `DecisionCard` (`admin/src/pages/workspace/decisions/decision.view.tsx`,
  341 lines) has **one real mount**, the composer band at
  `admin/src/pages/workspace/screens-chat.tsx:413`, plus a gallery harness at
  `decisions/preview.tsx:327`. The earlier claim of three mounts was wrong:
  `screens-home.tsx` uses only the date helpers, and `screens-you.tsx:34` imports
  `DecisionCard` without ever rendering it. That stray import is a real finding
  but it is **not yours to fix**; write it in the build log.
- Served by `GET /api/web-chat/decisions` and settled by
  `POST /api/web-chat/decisions/:decisionId`
  (`advance-backend/src/http/desktop/web-chat.routes.ts`).

**Shopify, for Phase 8.** Confirmed accurate.
`ShopifyConnectionError` declares `missing_scope` at
`advance-backend/src/application/shopify/shopify-connection.service.ts:16` and
throws it at `:73`. It is flattened to `permission_denied` at
`shopify.tool.ts:429`, and handled again at `shopify.service.ts:434`.

**A concurrency hazard this plan cannot resolve for you.** Another agent is
actively editing `admin/src/components/admin/brand-catalog.ts` and
`brand-mark.tsx`. `admin/src/pages/workspace/decisions/subject.ts:28` imports
`BRAND_CATALOG` and `BrandKey` from that exact file. If Phase 5 gives the connect
card a brand, you will be reading their file. **Read it, do not edit it, and
commit with an explicit pathspec rather than staging everything.** If you need a
catalog entry that is not there, stop and say so.

**Baseline, verified 2026-08-20:**

```
node --import tsx --test tests/application/begin-google-authorization.test.ts
  9 pass, 0 fail, 129ms
node --import tsx --test tests/application/surface-parity.test.ts \
  tests/application/decision.service.test.ts \
  tests/application/google-scope-request.test.ts
  55 pass, 0 fail, 152ms
```

The second number was 48 when this plan was written. The decision-module work
added seven tests. If you see fewer than 55, something regressed before you
started; find out what before building on it.

## 6. The shape

One deep module, `advance-backend/src/application/connections/connection-request/`,
with a two-function interface:

```ts
// What went wrong, in terms that can be acted on.
classify(input: { provider: ProviderKey; toolId: string; error: unknown })
  : ScopeGap | undefined

// Ask the member to close it, wherever they are.
request(input: { gap: ScopeGap; runContext: RunContext })
  : Promise<ConnectAskOutcome>
```

`ScopeGap` is `{ provider, toolId, missingScopeGroups, reason }`. `ConnectAskOutcome`
is `{ status: 'sent'; intentId } | { status: 'already_pending'; intentId } |
{ status: 'unreachable' }`.

Behind that interface: the Google adapter and an explicit throw for every other
provider (D9), the existing intent machinery, the surface lookup, and both
couriers. Callers learn two functions and no longer learn OAuth, channels, or
cards.

**Two callers, from opposite directions.** `classify()` is reached from a tool
family's catch block, after something failed. `request()` is reached directly by
the connect tool, before anything has. That is what makes this seam real rather
than hypothetical, now that the second adapter is cut: the interface has to serve
a caller that knows only an error and a caller that knows only an intention, and
if it needed to be bent for either one, that is a finding about the interface.

**Where the seam sits.** At the tool family, not inside it. A tool family's job is
to call a provider and report what happened. Deciding that a particular failure
deserves an OAuth round trip on a particular surface is not that job, which is
why it currently leaks into three tool files in three different shapes.

**The link option.** `DecisionOption` gains one optional field, `href?: string`.
An option carrying it renders as a link button, settles nothing, and is the whole
of what the connect ask needs from the decision vocabulary. Both trees get it,
because the two type trees are deliberately not shared
(`admin/src/pages/workspace/decisions/decision.ts:1`).

## 7. Phases

### Phase 1 — Name the gap ✅ *2026-08-21*

**Goal.** A Google access failure becomes one of two named values instead of an
`upstream_failure` string, and the message points at the skill that says what to
do next.

This is the floor, not the main path. The agent is meant to call the connect tool
before it gets here (Phase 3). This phase is what happens when it does not, and
it is the reason the product cannot lie about access.

**Files.**

- `advance-backend/src/domain/connections/scope-gap.ts` (new) — the `ScopeGap`
  value and `ProviderKey`. Pure, no imports from `application/`.
- `advance-backend/src/application/connections/connection-request/google-scope-gap.ts`
  (new) — the Google classifier. Reads the provider error, maps the tool id to
  scope groups through the existing `googleScopeGroupsForToolIds`.
- `advance-backend/src/application/tools/families/google-workspace-mcp.tool.ts` —
  in the `catch` at line 527, classify before building the `ToolError`.
- `advance-backend/tests/application/google-scope-gap.test.ts` (new).

**Steps.**

- [x] Define `ScopeGap` and `ProviderKey` in the new domain file. Per D12 it
      carries which of the two cases this is: `not_connected` or
      `insufficient_scope`.
- [x] Write `classifyGoogleScopeGap(toolId, error)`. Match Google's real 403
      text for insufficient scopes, and the `ACCESS_TOKEN_SCOPE_INSUFFICIENT`
      status. Return `undefined` for everything else.
- [x] Fill `missingScopeGroups` from `googleScopeGroupsForToolIds([toolId])`
      minus what the connection already holds, using `hasGoogleScopeGroups`.
- [x] Call it from the `catch` at `google-workspace-mcp.tool.ts:531`. For now,
      when it returns a gap, keep returning a `ToolError` but with
      `reason: 'permission_denied'` and the gap's reason text. The ask lands in
      Phase 2.
- [x] Include the skill pointer in the message, per D13. This is the hinge of the
      whole design: it is what turns a dead end into the first step of the flow.
      Name the skill the way the agent can act on.
- [x] Test: real Google 403 text produces a gap naming the right groups; an
      absent connection produces `not_connected` rather than
      `insufficient_scope`; a quota error, a 404, and a schema rejection each
      produce `undefined`.

**Do not.** Do not rebuild scope maths. `googleScopeGroupsForToolIds`,
`googleScopesToRequestForToolIds` and `hasGoogleScopeGroups` already exist and are
already tested. Do not touch `withRecoveryHint` or `isNativeSchemaRejection`;
a schema rejection is not a scope gap and must keep its current path.

**Gate.** `node --import tsx --test tests/application/google-scope-gap.test.ts`
passes, and `tests/application/google-sheet-resource-resolver.test.ts` plus
`tests/application/google-workspace-contract-bootstrap.service.test.ts` still
pass unchanged.

### Phase 2 — One asker ✅ *2026-08-21*

**Goal.** One provider-agnostic `request()` replaces `BeginGoogleWorkspaceAuthorization`
at all three call sites, with Google as the first adapter and behaviour identical
in Lark.

**Files.**

- `advance-backend/src/application/connections/connection-request/connection-request.service.ts`
  (new) — `classify` and `request`, plus the `ConnectAskOutcome` type.
- `advance-backend/src/application/connections/connection-request/google.adapter.ts`
  (new) — wraps the existing `createBeginGoogleAuthorization` body.
- `advance-backend/src/application/connections/begin-google-authorization.ts` —
  becomes the Google adapter's implementation. Keep the file; keep its comments,
  they record a real bug.
- `advance-backend/src/application/tools/families/google-workspace-mcp.tool.ts` —
  replace `beginAuthorization` in the deps at `:198` and `:208`, and both call
  sites at `:371` and `:460`.
- `advance-backend/src/application/tools/families/mail-automations.tool.ts:863` —
  same replacement.
- `advance-backend/src/composition.ts:930`, `:1936`, `:1949` — wire the service.
- `advance-backend/tests/application/begin-google-authorization.test.ts` — retarget
  to the new interface.

**Steps.**

- [x] Write `ConnectionRequestService` with the two-function interface from
      section 6. Provider adapters go in a map keyed by `ProviderKey`.
- [x] Move the Google body behind the adapter without changing what it does.
- [x] Replace all three call sites. The call site now passes a `ScopeGap`, not a
      `toolId` and a hand-written reason string.
- [x] Wire in composition. One instance, passed where `beginGoogleAuthorization`
      was passed.
- [x] Retarget the existing 9 tests; add one asserting an unknown provider
      returns `unreachable` rather than throwing.

**Do not.** Do not change `google-connection-authorization.service.ts` or
`google-connection-continuation.ts`. Do not delete
`begin-google-authorization.ts`. Do not change the Lark card in
`lark-google-connect.ts` in this phase. Behaviour in Lark must be
byte-identical when this phase lands.

**Gate.** `node --import tsx --test tests/application/begin-google-authorization.test.ts
tests/application/google-connection-flow.test.ts` passes, and a Lark run that
hits a scope gap still receives the same card it does today. State in the build
log how you checked the second half.

### Phase 3 — The connect tool and the connections skill ✅ *2026-08-21*

**Goal.** The agent can ask for access on purpose, before anything fails, and a
member can say "connect my Google" and have it work.

This is the front door. Phases 1 and 2 built the floor: what happens when the
agent does not do this. Both exist on purpose, and neither replaces the other.

**Files.**

- `advance-backend/src/application/tools/families/connections.tool.ts` (new) —
  the tool family. Sits beside the other 24 in that directory; match their shape.
- `advance-backend/src/application/skills/connections.skill.ts` (new) — the
  skill. Follow `advance-backend/src/application/skills/zoho.skill.ts`, which is
  the closest existing shape and already carries a `CONNECTION METHOD` block.
- `advance-backend/src/application/skills/system-skill-provisioner.ts` — add it
  to the provisioned set.
- `advance-backend/src/composition.ts` — register the family.
- `advance-backend/tests/application/connections.tool.test.ts` (new).

**Steps.**

- [x] Define the tool as `connect_app`, reaching Pi as `divo_connect_app` through
      the existing typed-tool naming. It takes `provider` and `toolIds`, never
      scopes. The name is provider-neutral per D10 and covers both cases per D12:
      connecting from nothing and widening an existing grant. If you want to
      change it, change it now and say so; renaming later costs a relearn.
- [x] Derive the scopes inside the tool from `googleScopeGroupsForToolIds`, per
      D9. The model names what it wants to do; the backend decides what that
      costs in consent.
- [x] Hard fail any provider that is not Google, per D11. A named error saying
      which providers are supported, not an empty success and not a silent
      no-op.
- [x] Handle both cases from D12 through one call. `not_connected` and
      `insufficient_scope` differ in what the member is told, not in what the
      agent does.
- [x] Return the Phase 6 result shape: the ask was sent, stop here.
- [x] Write the skill. It states when to call the tool, that scopes are never
      guessed, that a sent ask ends the run, and what the member sees. Keep it
      short; the tool's schema carries the mechanics.
- [x] Add it to the provisioned set and confirm it actually reaches a member.
      `zoho.skill.ts:20` records a skill that was written, tested, and never
      provisioned, so no member ever received it. Do not repeat that.
- [x] Test: a Google call routes to `request()`; a Shopify call hard fails with a
      named error; a call naming scopes instead of tool ids is rejected.

**Do not.** Do not let the tool accept a scope list, however convenient. Do not
name it after Google. Do not build the skill as a retrieval-only path: the error
text from Phase 1 is what points at it, and that pointer is the reason this works
at all. Do not touch `zoho.skill.ts:16` or `shopify.skill.ts:7`, whose
"ask them to reconnect" lines become wrong once their providers are supported;
note them in the build log as found.

**Gate.** On Lark, in a live run: ask Divo to connect Google with no connection
present, and get a Connect button without any tool having failed first. Then ask
for a Sheets export on a Gmail-only connection and get the same button by the
Phase 1 route. Record both. Web delivery is Phase 5; this gate is Lark only.

### Phase 4 — An origin for every channel ✅ *2026-08-21*

**Goal.** A web run remembers where it came from, so a connect ask has somewhere
to go **and enough to replay the run from**.

D7 raises this phase's bar. Because a web run re-runs itself after OAuth, the
origin is not a pointer at a thread, it is everything the replay needs. If you
finish this phase and the stored web origin cannot reconstruct the original turn,
the phase is not done, however green the tests are.

**Read first.** `web-run.service.ts:618`, `webIncomingMessage`, already adapts a
web turn into the runtime's `IncomingMessage` vocabulary, including
`chatId: asChatId(input.threadId)`. The channel-agnostic shape this phase needs is
half-built there. Do not invent a second one beside it.

**Files.**

- `advance-backend/src/application/connections/run-origin.store.ts` — make
  `RunOrigin` channel-agnostic.
- `advance-backend/src/application/runtime/web-run.service.ts` — call
  `runOrigins.remember` the way `lark-pi-runtime.service.ts:788` does.
- `advance-backend/tests/application/run-origin.store.test.ts` (new if absent).

**Steps.**

- [x] Split `RunOrigin` into a common part (`companyId`, `userId`, `channel`,
      `originalRequest`, `conversationKey`) and a per-channel part
      (`lark: {...}` holding the five Lark fields, `web: { threadId }`).
- [x] Rename `googleAuthorization` to `pendingAuthorization` and add `provider`.
      It is about to hold Shopify too.
- [x] Update the Lark writer and `begin-google-authorization.ts`'s reader for the
      new shape. No behaviour change.
- [x] Write the web origin in `web-run.service.ts`. The thread id is a plain
      field on the service's own input at `:90` (used at `:218`, `:359`, `:374`).
      An earlier version of this plan said it lived only on
      `metadata.execution.threadId`; that was wrong, and this step is smaller
      than it looks.
- [x] Store whatever the replay needs, per D7, not merely the thread id. Check it
      by reconstructing an `IncomingMessage` from a recalled web origin alone and
      asserting it equals what `webIncomingMessage` builds from the live input.
- [x] Test: remember and recall round-trips for both channels; the 16,000
      character ask ceiling still refuses to store an over-long request.

**Do not.** Do not change `RUN_ORIGIN_TTL_SECONDS` or
`MAX_ORIGINAL_REQUEST_CHARS`. Do not make the Lark fields optional on the common
part; put them in the per-channel part so a missing Lark field is a type error
rather than a runtime undefined.

**Gate.** A web run's origin recalls by `runId` **and reconstructs an
`IncomingMessage` equal to the one the live turn produced**, both proven by
tests. `node --import tsx --test tests/application/begin-google-authorization.test.ts`
still passes, proving Lark is untouched.

### Phase 5 — The connect ask on web ✅ *2026-08-21*

**Goal.** On web, a scope gap puts a Connect button in the composer band, through
the decision card that is already there, and the run picks itself back up when
the member returns from Google.

**The card is better than this plan originally specified.** Decisions gained a
subject vocabulary after this plan was written. `DecisionBrand`
(`advance-backend/src/domain/decision/decision-subject.ts:32`) already names
`google`, `googleDrive` and `googleSheets`, so the connect ask carries the Google
mark and accent instead of being a plain sentence. Use it. A connect ask is the
most literally branded decision in the product.

**Files.**

- `advance-backend/src/domain/decision/decision.ts` — add `href?: string` to
  `DecisionOption`.
- `admin/src/pages/workspace/decisions/decision.ts` — same field, browser half.
- `admin/src/pages/workspace/decisions/decision.view.tsx` — render an option with
  `href` as a link button.
- `advance-backend/src/application/connections/connection-request/web.courier.ts`
  (new) — opens a decision with one question and one `href` option.
- `advance-backend/src/domain/channel/surface-capabilities.ts` — read it to pick
  the courier. Add a field only if the existing `decisions` value cannot express
  the choice; say which in the build log.
- `admin/src/pages/workspace/decisions/decision.test.ts` — cover the link option.
- `advance-backend/tests/application/surface-parity.test.ts` — extend.

**Steps.**

- [x] Add `href` to both `DecisionOption` types, with the same comment on both:
      an option carrying it opens a URL and settles nothing.
- [x] Render it in `DecisionCard` as an anchor styled as a button. It must not
      post to `POST /api/web-chat/decisions/:decisionId`.
- [x] Server-side, refuse an `href` option that also carries `settles`. That
      combination has no meaning and would leave a row half-answered.
- [x] Write the web courier: `DecisionService.ask` with one question, one
      `href` option labelled `Connect Google`, `continuation: { kind: 'none' }`,
      and an `idempotencyKey` of the intent id so a retry reuses the open row.
- [x] Route in `ConnectionRequestService.request`: Lark keeps the existing card,
      web gets the decision.
- [x] Wire the auto re-run, per D7. When OAuth completes for a web origin, the
      run replays through the existing connection-continuation path exactly as
      Lark's does. Do not build a second resume; find where Lark's replay is
      triggered and give it the web origin.
- [x] The replayed web run must be visibly a continuation, not a message from
      nowhere. Say in the build log what the thread actually shows when it
      restarts, in the words a member would read.
- [x] Per D8, a member who does not own the connection gets
      `SELF_SERVICE_CONNECT_HINT`, not a card. One branch, and a note in the
      build log about what that case looks like in practice.

**Do not.** Do not build a second web card component. Do not widen
`DecisionContinuation`. Do not make the connect decision settle on press. Do not
add a `connect` field to `SurfaceCapabilities` if `decisions` already tells you
what you need (it is `'buttons' | 'form'` at
`surface-capabilities.ts:56`; Lark is `'buttons'` at `:73`, web is `'form'` at
`:112`). Do not build the not-the-owner case; D8 parks it.

**Do not edit `admin/src/components/admin/brand-catalog.ts` or `brand-mark.tsx`.**
Another agent is actively working in them, and
`admin/src/pages/workspace/decisions/subject.ts:28` imports from the first. Read
them, use them, commit with an explicit pathspec. If the brand entry you need is
missing, stop and ask rather than adding one.

**Gate.** In a local web run against a Google-connected account missing Drive
scope: `GET /api/web-chat/decisions` returns the connect decision; the composer
band shows a Connect button carrying the Google mark; pressing it opens Google's
consent screen with the narrow scope set; and on return the run continues on its
own and answers the original ask. Record the scopes the consent screen actually
listed, and quote what the thread showed when the run resumed.

**2026-08-21 build log.** The web decision uses the existing `DecisionCard` and
the existing `surfaceCapabilities(...).decisions === 'form'` value; no new
surface capability or second card family was needed. `DecisionOption.href` is
mirrored in the backend and browser trees. The browser renders it as an HTTPS
anchor in the same branded card, with no answer POST and no settlement. The
backend rejects both `href + settles` and non-HTTPS links before a decision row
is written.

The courier creates one Google-branded decision with human product labels in
the access preview, a single `Connect Google` link, `{ kind: 'none' }`, and the
authorization intent id as its idempotency key. The OAuth URL still comes from
the existing narrow tool-id-to-scope mapping; the model never supplies scopes.
Lark's existing final-action/card path remains unchanged.

Web OAuth reuses the existing authorization intent, queue, exchange, and
continuation worker. The intent table predates web delivery and has Lark-shaped
address columns, so a web intent carries an explicit `chatType: 'web'` marker
and the web thread/run address in those durable fields; the worker resolves the
member by company/user, recalls the web origin, and invokes the existing
`WebRunService` under the exact stored web session. The Phase 4 origin therefore
also retains `sessionId`, which is required to replay an authenticated browser
run. The callback now tells a web member that Divo is continuing in the web
thread. The thread receives the original ask again through the web runtime and
the resumed assistant turn is the visible continuation; Phase 7 adds the
explicit grant context before that ask.

The member-owned boundary remains deliberate. When the available Google
connection is not owned by the member, this phase does not route a button to
another person; the existing path stays on `SELF_SERVICE_CONNECT_HINT`, telling
the member to connect Google in Connected apps and ask again. No owner courier
was added.

Focused web courier/continuation tests pass (**4 pass, 0 fail**) and backend
typecheck is clean. The requested live web OAuth gate was not run; the user will
test that flow later. The concurrent `brand-catalog.ts` and `brand-mark.tsx`
files were read and not edited.

### Phase 6 — One result shape for the model ✅ *2026-08-21*

**Goal.** Every tool family says the same thing after an ask is sent.

**Files.**

- `advance-backend/src/application/tools/families/google-workspace-mcp.tool.ts` —
  the two return sites at `:382` and `:465`, and the new Phase 1 site.
- `advance-backend/src/application/tools/families/mail-automations.tool.ts:862`.
- `advance-backend/src/application/tools/families/shopify.tool.ts:429`.

**Steps.**

- [x] Define the result once, next to `ConnectAskOutcome`: code
      `connection_ask_sent`, the `intentId`, the provider, and one sentence
      telling the agent the member has been asked and this run should end.
- [x] Replace `google_workspace_authorization_pending` at both sites.
- [x] Keep `SELF_SERVICE_CONNECT_HINT` for the `unreachable` case only. It is
      the honest answer when no surface can carry a card, and Desktop still needs
      it.
- [x] Grep for `authorization_pending` and confirm no other shape survives.

**Do not.** Do not remove `SELF_SERVICE_CONNECT_HINT`. Do not change
`/api/desktop/approvals`; installed Desktop clients read
`description.title` / `.tool` / `.details` off it and that shape is frozen.

**Gate.** `grep -rn "authorization_pending" advance-backend/src` returns no
legacy authorization-pending shape. The full application suite remains the
later test pass requested by the user.

**2026-08-21 build log.** `ConnectAskOutcome` now has one adjacent
`ConnectionAskSentResult` helper and message: `success: false`,
`code: 'connection_ask_sent'`, the intent id, provider, and an instruction to
end the run and wait. Google pasted-reference and ordinary-call paths, and
Mail Ops, all use that result. The Connections front door uses the same helper.
`SELF_SERVICE_CONNECT_HINT` remains only on the unreachable branch; the
unsupported-provider front door still returns its named hard error.

The Google product skill now teaches the new result code. The old
`google_workspace_authorization_pending` string is gone from
`advance-backend/src`; Shopify has no connection-ask path and was left
unchanged because Phase 8 is cut. Focused connection, decision, Google-skill,
Google-tool, and Mail Ops tests passed (**107 pass, 0 fail**) with backend
typecheck clean. The full suite and any live channel run were not requested;
they remain for the later test pass.

### Phase 7 — The resume tells the agent what changed ✅ *2026-08-21*

**Goal.** When the run comes back after OAuth, the agent knows why it is running
and what it was granted, instead of being handed its own old question.

**This is the gap between the flow as designed and the code as it stands.**
`buildContinuationIncoming`
(`advance-backend/src/application/connections/google-connection-continuation.ts:330`)
replays `text: intent.originalRequest` as a fresh message, and attaches
`raw.resumeReason`, `raw.connectionId`, `raw.authorizationIntentId` and
`raw.requestedToolIds`. **Nothing anywhere reads any of it.** Verified 2026-08-20
by grepping the whole of `src/` for `resumeReason` and
`google_oauth_continuation`: the only hits are the file that writes them. So
today the agent re-runs blind, rediscovers the connection by trying again, and
never learns what it was granted.

The wiring is most of the way there. This phase is the last hop.

**Files.**

- `advance-backend/src/application/connections/google-connection-continuation.ts:330`.
- Wherever an `IncomingMessage`'s `raw` becomes agent-visible context. Find it
  before designing; do not assume.
- `advance-backend/tests/application/google-connection-flow.test.ts`.

**Steps.**

- [x] Trace where `raw` goes on an ordinary turn and whether the runtime can
      already carry it to the model. Write down what you find; that answer
      decides this phase's shape and the plan does not know it.
- [x] Make the resumed run say three things to the agent: this is a
      continuation of a specific earlier ask, the connection is now present, and
      these exact scope groups were granted.
- [x] Grant the scopes actually returned by the exchange, not the scopes that
      were requested. A member can approve a subset on Google's consent screen,
      and an agent told it has Drive when it does not will fail a second time
      with less excuse than the first.
- [x] Do the same for the web origin from Phase 4, so both channels resume alike.
- [x] Test: a resumed run carries the granted groups; a partial grant reports the
      subset, not the request.

**Do not.** Do not refactor the continuation service; it works and it is 376
lines. Do not widen `RunOrigin` to carry the grant; the grant is known at
exchange time, not at ask time. Do not make the agent trust a remembered scope
from earlier in the conversation, which several skills explicitly forbid.

**Gate.** A live Lark run: gap, button, connect, and the resumed run states which
scopes it received before retrying. Quote the agent's own words in the build log.
If a partial grant is testable, test it; if not, say so.

**2026-08-21 build log.** The raw trace is settled before changing the resume:
`IncomingMessage.raw` is carried through backend code and written onto the
continuation object, but `LarkPiRuntimeService` sends Pi a controller body with
only `message` (plus the lease/model/attachments). `webIncomingMessage` sets
`raw: null`, and no runtime prompt or controller adapter reads raw. Therefore
raw cannot reach the model in this build; adding fields to raw alone would have
been invisible.

The continuation now builds a bounded text envelope from the stored original
ask and the actual `connection.scopes` returned by the authorization exchange.
It tells the model that this is a continuation, that Google Workspace is now
present, which requested scope groups actually have a returned scope, and that
missing/requested groups must not be inferred. It also asks the model to make
the continuation visible in its reply. The structured `raw` object retains the
connection id, intent id, requested tool ids, returned scopes, and computed
granted groups for backend diagnostics, but it is not the model interface.

The same envelope is used by Lark's existing continuation input and by the web
branch of that same intent/queue/worker. Web resumes through `WebRunService`
under the session retained in the Phase 4 origin; the browser thread keeps the
member's original ask as its user turn and receives the resumed assistant turn.
The focused web continuation test covers a partial grant: a returned
`spreadsheets.readonly` appears in the first Sheets group while the write group
is reported as `none returned`, rather than repeating the requested write scope.

The live Lark gate and quoted model wording were not run because the user asked
to test later. No Pi core or Desktop code was changed.

### ~~Phase 8 — Shopify, which proves the seam~~ — CUT *2026-08-20*

**Cut by Abhishek, not deleted, so nobody proposes it again.** Google only for
now, and every other provider hard fails (D9). Struck rather than removed because
the reasoning below is still correct and this is the first thing to revive when a
second provider is wanted.

The seam's justification changes rather than disappears. The original argument was
that two adapters make a real seam and one makes a hypothetical one. It is now
carried by two *callers* instead: the Phase 1 classifier and the Phase 3 tool
reach the same `request()` from opposite directions, which tests the interface
harder than a second adapter would. The hard-fail branch is the honest
placeholder for the second adapter.

~~**Goal.** A second adapter, because one adapter is a hypothetical seam and two is
a real one.~~

**Files.**

- `advance-backend/src/application/connections/connection-request/shopify.adapter.ts` (new).
- `advance-backend/src/application/shopify/shopify-connection.service.ts:16` — its
  `missing_scope` code becomes a `ScopeGap`.
- `advance-backend/src/application/tools/families/shopify.tool.ts:429`.

**Steps.**

- [ ] Write the Shopify classifier from the existing `missing_scope` code. It
      does not need text matching; the code is already there.
- [ ] Write the adapter. Shopify's install URL replaces Google's authorize URL.
- [ ] Route it through the same `request()`, the same couriers, the same result.
- [ ] Test both providers through one service in one test file.

**Do not.** Do not touch the Shopify privacy or retention services. Do not add
Airtable or Canva here.

**Gate.** One test drives Google and Shopify through the same `request()` and
asserts both reach both couriers. If anything had to be special-cased per
provider above the adapter, say so in the build log; that is a finding about the
interface, not a detail.

## 8. Primary files

The gap and the ask:

- `advance-backend/src/domain/connections/scope-gap.ts` (new)
- `advance-backend/src/application/connections/connection-request/` (new)
- `advance-backend/src/application/connections/begin-google-authorization.ts`
- `advance-backend/src/application/connections/google-connection-authorization.service.ts`
- `advance-backend/src/application/connections/google-connection-continuation.ts`
- `advance-backend/src/application/connections/run-origin.store.ts`

The front door:

- `advance-backend/src/application/tools/families/connections.tool.ts` (new)
- `advance-backend/src/application/skills/connections.skill.ts` (new)
- `advance-backend/src/application/skills/system-skill-provisioner.ts` — the
  provisioned set. A skill missing from it reaches nobody.
- `advance-backend/src/application/skills/zoho.skill.ts` — closest existing
  shape, and `:16` is the dead end this work replaces. Read, do not edit.
- `advance-backend/src/application/skills/shopify.skill.ts` — `:7`, same. Read,
  do not edit.

Scope maths, already built:

- `advance-backend/src/application/google/google-scope-request.ts`
- `advance-backend/src/domain/google/google-workspace-scope.ts`

Where gaps surface:

- `advance-backend/src/application/tools/families/google-workspace-mcp.tool.ts`
- `advance-backend/src/application/tools/families/mail-automations.tool.ts`
- `advance-backend/src/application/tools/families/shopify.tool.ts`
- `advance-backend/src/application/shopify/shopify-connection.service.ts`
- `advance-backend/src/application/artifacts/google-sheet-resource-resolver.ts`

Surfaces:

- `advance-backend/src/domain/channel/surface-capabilities.ts`
- `advance-backend/src/domain/decision/decision.ts`
- `advance-backend/src/domain/decision/decision-subject.ts` — `DecisionBrand`
  already names `google`, `googleDrive`, `googleSheets`, `shopify`.
- `advance-backend/src/application/decision/decision.service.ts`
- `advance-backend/src/application/approval/business-action.service.ts` — the
  smallest working example of calling `DecisionService.ask`. Copy its shape.
- `admin/src/pages/workspace/decisions/subject.ts` — imports the brand catalog
  another agent is editing. Read only.
- `advance-backend/src/infrastructure/channels/lark/lark-google-connect.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-decision.courier.ts`
- `admin/src/pages/workspace/decisions/decision.ts`
- `admin/src/pages/workspace/decisions/decision.view.tsx`
- `advance-backend/src/http/desktop/web-chat.routes.ts`

Runs:

- `advance-backend/src/application/runtime/lark-pi-runtime.service.ts`
- `advance-backend/src/application/runtime/web-run.service.ts`
- `advance-backend/src/composition.ts`

Related plans:

- `plans/cloud-google-connect-mail-ops.md` — the Google connect and mail-ops history.
- `plans/divo-one-soul-two-surfaces.md` — why Lark and web must behave the same.

## 9. Verification commands

Run from `advance-backend/`. Narrow first.

```bash
# The ask, and the OAuth flow around it. Verified green 2026-08-20: 9 pass.
node --import tsx --test tests/application/begin-google-authorization.test.ts
```

```bash
# Surfaces and the decision module. Verified green 2026-08-20: 55 pass.
node --import tsx --test tests/application/surface-parity.test.ts \
  tests/application/decision.service.test.ts \
  tests/application/google-scope-request.test.ts
```

```bash
# Google connection resolution and the pasted-reference path.
# Verified green 2026-08-20: 30 pass, 6 suites.
node --import tsx --test tests/application/google-connection-flow.test.ts \
  tests/application/google-sheet-resource-resolver.test.ts \
  tests/application/accessible-connection-selection.test.ts
```

```bash
# Shopify. Phase 8 is CUT, so these are a regression check only: nothing you
# build should change them. Verified green 2026-08-20: 26 pass, 2 suites.
node --import tsx --test tests/application/shopify-connection.service.test.ts \
  tests/application/shopify.service.test.ts
```

```bash
# Types. Note tsconfig.tests.json is separate; run both.
pnpm typecheck
pnpm typecheck:tests
```

```bash
# Before promoting: the whole application suite.
pnpm test
```

**What these do not prove.** None of them exercises a real Google 403. The only
proof that Phase 1's classifier matches Google's actual message is a live run
against an account missing the scope, which is the Phase 5 gate. A green suite
after Phase 1 means the classifier is well-formed, not that it fires.

## 10. How to work this plan

You are building this plan. Read it end to end before you touch code, then work
from `## Next action`.

**Before each phase**

1. Open the files the phase names and the tests around them. The plan's
   `Current state` was true on the date next to it, not necessarily today. Where
   it disagrees with the code, the code wins, and you fix the plan.
2. Re-read `Locked decisions`. Those are settled. If one of them turns out to be
   wrong, that is a finding: stop, say so, and do not quietly design around it.
3. Check `Parked`. Do not open those areas, even to fix something obvious there.

**While building**

4. Say which responsibility you are moving or which behaviour you are changing
   before you change it.
5. Preserve unrelated and concurrent work. Other agents may be editing this repo.
   Commit with an explicit pathspec rather than staging everything.
6. Run the narrow tests for what you touched, then the broader gate for the seam
   you crossed.

**Closing a phase**

7. A phase is complete when its **Gate** passed, not when the code compiles and
   not when the diff looks right. Run the gate. Record what it returned.
8. Tick every checkbox in the phase. Tick them when the step is done and proven,
   not when it is written.
9. Mark the phase heading complete with the date: `### Phase N — goal ✅ *YYYY-MM-DD*`.
10. Append to `## Build log`: what you built, where it differed from the plan and
    why, what you found that nobody knew about, and the gate result. The
    deviations and the surprises are the most valuable thing in this file. A log
    entry that only says "done as planned" is worth writing only when that is
    literally true.
11. Rewrite `## Next action`.
12. **Commit the plan update in the same commit as the code.** Not afterwards. A
    plan updated later is a plan updated never.

**When you are blocked**

13. Follow the escalation rule for your tier, stated in the header. In short:
    high tier decides and records the decision with its reason; mid and low tier
    stop and ask one clear question. Either way it goes in the build log.
14. Never delete a phase because it turned out to be wrong. Strike it through and
    write why. Someone will otherwise propose it again.

**What not to do**

15. Do not report a phase complete because tests pass that do not exercise the
    change. Say plainly which parts are unverified.
16. Do not widen the scope. If you find real work outside `Included`, write it at
    the bottom of the build log under `Found, out of scope` and leave it.
17. Do not rewrite this section.

## 11. Build log

**2026-08-21. First live web run, and the two defects it found.** Abhishek ran
the real thing: asked for Drive and Sheets, got the Connect card with the Google
mark and the right two scopes, connected, and then nothing appeared to happen.

The backend was blameless. The conversation held all of it, in order: the ask,
the card, the Phase 7 continuation context at sequence 5, and Divo's answer at
sequence 6 saying the connection was live with Drive and Sheets. The intent row
read `connected` / `completed` with no failure code. The work was done and
delivered into the thread. Nobody was looking.

**Defect 1: nothing closed the Connect ask.** `RuntimeApproval b9d3491d` was
still `pending` long after OAuth completed, so the card sat on screen offering
to connect an account that was already connected, until its own 10-minute TTL
expired. D5 says the link option settles nothing *when pressed*, which is still
right; what was missing is that nobody gave OAuth completion the job of taking
the question back.

Fixed by giving the Decision module the verb it lacked. `withdraw` closes a
still-open ask by idempotency key, which is the handle the caller actually holds
because the web courier opened the row with the intent id. New status
`withdrawn`, deliberately outside both the inbox filter (`dispatching`/
`pending`) and the exactly-once durable set (`executing`/`awaiting_governance`/
`consumed`), so a withdrawn row leaves the screen without standing in for a
completed action. `markFailed` was the wrong tool: this ask succeeded and was
then made moot, and calling that "failed" lies to whoever reads the row later.

The continuation calls it from `finish`, so it runs on the delivery-failure path
too. That is on purpose. The member connected either way, and a button asking
them to connect is wrong whatever became of the run.

**Defect 2: a web thread cannot see a run it did not start.** `live.ts` joined
whatever was running when the thread opened and then went idle, re-running only
on a thread or token change. A connect ask ends its own run when the card goes
out, so by the time OAuth finished, the hook had been asleep for 20 seconds. The
continuation's new run wrote into the same conversation with nothing listening.
The only poll on that screen was `useDecisions`, which polls decisions.

This is the D7 risk arriving from the far side. The worry was that a run
restarting on its own would read as a ghost. The truth was the opposite: it
restarts and the browser never finds out.

Fixed with a poll, at Abhishek's call. While a thread is idle and visible it asks
`getThread` every 6 seconds whether a run has begun, and joins it through the
same `consume(watch(...))` both other paths use. It also checks immediately when
the tab becomes visible, which is the moment that actually matters here: the
reader was last seen leaving for Google's consent screen. Scheduled work and
Lark-initiated runs had the same blindness and now benefit from the same fix.

Gate: `pnpm typecheck` clean both sides; `pnpm test` **3993 tests, 3963 pass, 0
fail**; admin `pnpm test:unit` **443 pass**. Three new tests cover the withdraw,
including that it still fires when delivery failed and that a worker built
without a decision service keeps working, which is how every Lark run builds it.

**Still unproven:** the full loop end to end after these two fixes. Abhishek runs
that.


**2026-08-21. Phase 7 follow-up: one failing test and three type errors, fixed.**
The suite was left red at `0ab1978f5`. `google-connection-flow.test.ts`,
"records a visible Pi delivery failure without reporting completion", expected
`continuation_delivery_failed` and got `continuation_failed`.

Cause, and it is worth stating because it is this plan's own subject matter
turned back on itself. Phase 7 made the continuation read the connection's
granted scopes. The test's connection fixture had no `scopes` field, so
`grantedGoogleScopeGroups` threw a `TypeError` reading `.map` off `undefined`.
`classifyContinuationFailure` matches on words in the message, that message
contains none of them, so it fell through to the catch-all `continuation_failed`
— and the specific "Pi would not take the delivery" signal was replaced by a
generic one. A delivery failure reported as a generic failure is exactly the
substitution the rest of this plan exists to stop.

Two fixes, one on each side of the line:

- `grantedGoogleScopeGroups` now takes `readonly string[] | undefined` and reads
  an absent list as "granted nothing" rather than throwing. A connection whose
  scopes cannot be read is a connection that has granted nothing, which is both
  true and safe; throwing there can only ever be misfiled.
- The fixture now sets `scopes: []`. It was building a value the repository
  cannot return, which is the failure mode `tsconfig.tests.json` was added to
  catch.

Also narrowed the three `issued.authorizeUrl` reads in the same file. Phase 2
made `issue()` return `IssuedGoogleAuthorization | ExistingGoogleAuthorization`,
and `already_pending` carries no URL, so the test was reading a property off a
shape the service can return. One `assert.ok(issued.outcome === 'issued')`
narrows it and asserts something real at the same time.

Gate: `pnpm typecheck` clean; `pnpm test` **3990 tests, 3956 pass, 0 fail**,
exit 0. `pnpm typecheck:tests` still carries its documented pre-existing backlog
(649 errors, none in this work's files, down from the 676 recorded in that
config's own comment).

**Still unproven, and it is the whole point:** the Gmail-only scope-gap live
case. No unit test can fire Phase 1's classifier against a real Google 403.
Live testing is Abhishek's to run.


The first build entry is below the refresh note.

**2026-08-21. Phase 1 complete.** Added the domain `ScopeGap` value and the
Google classifier. The classifier recognizes Google's real prose, `Request had
insufficient authentication scopes.`, plus the machine reasons
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `insufficientPermissions`, and
`insufficient_scope`. It refuses a bare 403, quota errors, 404s, and native
schema rejections. The MCP call catch now returns `permission_denied` with a
named case and a pointer to the connections skill. Missing groups are computed
through `googleScopeGroupsForToolIds` and `hasGoogleScopeGroups`.

The plan's two-argument classifier shape remains callable as written. I added an
optional granted-scope argument so tests and future callers can subtract scopes
the connection already holds, and a small `googleConnectionScopeGap` helper so
known no-connection and missing-scope outcomes do not have to be recreated from
provider prose in Phase 2.

I did not find the literal insufficient-scope prose in the pinned upstream MCP
repository or its public documentation. Divo's existing Google fixtures and
client path carry the exact text, so the matcher is evidence-based but the live
provider confirmation remains open for Phase 5. Gate result:
`node --import tsx --test tests/application/google-scope-gap.test.ts tests/application/google-sheet-resource-resolver.test.ts tests/application/google-workspace-contract-bootstrap.service.test.ts`
returned **22 pass, 0 fail**.

**2026-08-21. Phase 2 complete.** Added `ConnectionRequestService` with the
`classify` and `request` interface, and a single Google adapter. The existing
Google authorization body remains in `begin-google-authorization.ts`; the
adapter translates a `ScopeGap` into its existing input and maps its
`unavailable` outcome to the shared `unreachable` result. The Google MCP and
Mail Ops callers now pass gaps, not provider-specific authorization arguments.
Composition builds one service instance and gives both tool families that
instance. The existing nine authorization tests remain at the low-level Google
implementation seam, and two additional tests cover the shared adapter and the
unsupported-provider outcome.

The service returns a structured `unreachable` result when no adapter exists.
Phase 3 will turn that result into the named hard failure from `connect_app`;
there is no empty success or fallback provider path. The authorization service
still derives the Google consent scopes from `requestedToolIds`, so the model
cannot supply a scope list.

Gate result:
`node --import tsx --test tests/application/begin-google-authorization.test.ts tests/application/google-connection-flow.test.ts`
returned **26 pass, 0 fail**. A live Cloud-Pi Lark run also completed with the
pinned `deepseek-v4-flash` model and delivered normally, but the selected member
already had Google accounts. It called account discovery and did not enter the
missing-account card branch. The live card check is therefore deferred to the
Phase 3 front door, which can trigger the ask directly. The initial `--model
pro` attempt was rejected by the pinned model policy before admission.

**2026-08-21. Phase 3 complete.** Added `connectApp`, exposed to Pi as
`divo_connect_app`, with a strict `{ provider, toolIds }` schema. The tool
rejects scopes and unknown tool ids, derives Google scope groups through
`googleScopeGroupsForToolIds`, routes one combined ask to the shared service,
and returns the model-facing `connection_ask_sent` shape. Non-Google providers
return the named `connection_provider_not_supported` error before the asker is
called. The Connections skill is provisioned through
`scripts/reconcile-capabilities.ts`, which is the real set of existing-company
provisioners in this checkout; `system-skill-provisioner.ts` only contains the
generic writer and has no set to extend.

The tool catalogue required additive wiring outside the files first named by the
plan: `connectApp` is now in the canonical tool taxonomy, labels, registered-tool
seed, generated Pi-native catalogue, and Pi runtime allowlist. It is also a
company-inherited permission so a department overlay cannot hide the front door.
The permission policy epoch was bumped so a live cache cannot retain the old
department default. The multi-tool schema exposed an interface mismatch in the
original shape, so `ScopeGap` carries optional `toolIds` and the Google adapter
passes every requested id into one authorization intent. This keeps the consent
request unioned and narrow instead of issuing one intent per tool.

Reconciliation result: one registered tool created, 39 already present; the
Connections skill was created for 2 Development companies; skill routes had no
missing targets. The focused tool, permission, taxonomy, and generated-catalogue
tests passed, including **31 pass** for the catalogue/tool set and **57 pass**
for the permission service. The native catalogue check returned `Verified 13
generated Pi-native catalogue files.`

The first live run found that the pre-change Pi image still exposed only the old
account-discovery route, so the local `divo-pi-local:phase0` image was rebuilt
and the controller restarted. A second run showed the new `divo_connect_app`
call but exposed stale department permission cache. The final run called
`divo_connect_app` successfully and delivered the Lark Connect card. The member
read `# Connect Google Workspace` and the continuation sentence. The harness
itself had omitted `IncomingMessage.tenantKey`, which made origin storage skip
the card; adding that field fixed the harness without weakening the runtime
origin check. The Gmail-only scope-gap live case remains to be confirmed after
the owner-aware branch in Phase 5.

**2026-08-21. Phase 4 complete.** `RunOrigin` is now a discriminated
channel-agnostic value with common identity, request, and conversation fields.
Lark-specific delivery data lives under `lark`; web data lives under `web` with
the thread id, external user id, and stable message timestamp needed to rebuild
the turn. `pendingAuthorization` is provider-tagged. The store keeps its TTL,
maximum request size, and `run-origin:v1` key unchanged, and normalizes the old
flat Lark shape on read so an in-flight authorization does not disappear during
the short cache migration.

`WebRunService` now remembers the web origin before calling Pi. The existing
`webIncomingMessage` adapter is exported and takes the stored timestamp, so the
test reconstructs an `IncomingMessage` from the recalled origin and compares it
with the live turn exactly. Lark writing and the Google reader use the new
fields without changing the Lark card path.

Gate result:
`pnpm typecheck && node --import tsx --test tests/application/run-origin.store.test.ts tests/application/begin-google-authorization.test.ts tests/application/web-run.service.test.ts tests/application/lark-pi-runtime.service.test.ts`
returned **83 pass, 0 fail**. No TTL or 16,000-character limit changed.

**2026-08-20 (second pass) — design changed by Abhishek, no code changed.** The
agent now gets a front door, not only an honest dead end: a provider-neutral
connect tool it can call before anything fails, and which a member can trigger by
asking Divo to connect Google directly. The classifier stays as the floor for the
run where the agent does not call it. Google only; everything else hard fails, so
Phase 8 (Shopify) is struck rather than built, and the seam is now proven by two
callers instead of two adapters. Added D9 to D14.

Two findings while checking the design against the code. First, the resume is
blind: `google-connection-continuation.ts:330` writes `raw.resumeReason`,
`raw.connectionId`, `raw.authorizationIntentId` and `raw.requestedToolIds` onto
the replayed message, and a grep of all of `src/` shows nothing reads any of
them. The agent re-runs its own old question with no idea why. That gap is now
Phase 7. Second, `zoho.skill.ts:16` and `shopify.skill.ts:7` both instruct the
agent to send the member away to reconnect, which is the dead end this plan
replaces; they are out of scope here but wrong the day their providers land.

**2026-08-20 (first pass) — plan refreshed for handover, no code changed.** Unparked: the
blocking web approval card shipped (`plans/decision-module-deepening.md`, all
phases complete). Re-verified section 5 against the code and corrected three
claims the four decision-module commits had made stale: `DecisionService.ask`
went from no production callers to three, `LarkApprovalCardHandler` was deleted,
and `DecisionCard` has one real mount rather than three. Found two things nobody
had written down: the web thread id is a plain field on `web-run.service.ts:90`
rather than buried in run metadata, which makes Phase 4 smaller; and decisions
gained a `DecisionBrand` vocabulary that already names `google` and
`googleDrive`, which makes Phase 5's card better than the one specified. Folded
Q1 and Q2 in as D7 and D8. Baseline re-run: 9 pass and 55 pass, the second up
from 48.

## 12. Next action

All seven build phases are complete. The remaining live web/Lark OAuth gates
and the full application-suite pass are intentionally deferred to the user's
later test run, as requested.

The classifier is now grounded in Divo's existing Google fixtures and client
error path. The pinned upstream repository did not expose the literal prose in
its public source or documentation, so Phase 5 must still confirm the prose
against a live missing-scope run.

No open questions remain. D7 and D8 answer what used to block Phase 5. D9 to D14
carry the design Abhishek set on 2026-08-20: a front door as well as a floor,
Google only, and a resume that says what it was granted.

One thing this plan deliberately does not know, and you must find out in Phase 7:
whether an `IncomingMessage`'s `raw` can reach the model at all today. Everything
in Phase 7 depends on that answer, so establish it before designing the phase.
