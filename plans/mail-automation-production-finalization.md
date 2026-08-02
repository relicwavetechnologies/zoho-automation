# Divo Mail Automation — production finalization plan

**Status:** full end-to-end audit complete (code + prompt layer + docs + permissions). Plan agreed. No code written yet.
**Date:** 2026-08-02 (rev 2 — supersedes rev 1 of the same day)
**Companion:** [`mail-automation-system-handover.md`](mail-automation-system-handover.md) — architecture, OAuth, Pub/Sub setup, runbook. Corrections to it are listed in §9 of this document.
**Purpose:** take Mail Ops from "works on the happy path" to a system a user can trust unattended.

---

## Progress

Last synced 2026-08-02. Branch `dev`, **not pushed**.

| Wave | State | Commits |
|---|---|---|
| **0 — Stop lying** | ✅ merged to `dev` | `8148a7b51` |
| **1 — Visibility (backend)** | ✅ merged to `dev` | `e2c2abc62`, `54a2f0f8a` |
| **1 — Visibility (screen)** | ✅ merged to `dev` | `b994c22f7` |
| **2 — Silent death (D2, D3, D4, D14, DR-2)** | ✅ merged to `dev` | `6e0d120cf`, `97be67a46`, `c4a5e2561`, `97b4d22b9` |
| 2 — cold-review fixes (2 rounds) | ✅ merged to `dev` | `0b94131b2`, `458736c01`, `88ef5b75e`, `d4a88353e`, `9067fea78` |
| **3 — Dead OAuth path (D5)** | ✅ merged to `dev` | `04d39a7f0`, `e1f923a66`, `45d6b79c9`, `f20d7935c` |
| **4 — Security and governance (S1–S5)** | ✅ merged to `dev` | `cb7dcca3a`, `505c8032e`, `c9cb95da1`, `654475e2d` |
| **5 — Send correctness (D1, D6–D9)** | ✅ merged to `dev` | `6f0a2e010`, `a67dfc89a`, `6639e23a1`, `1a243b23f`, `5a4c71dcc` |
| 3–5 — cold-review fixes | ✅ merged to `dev` | `cdb1049fb`, `a4ca91b83`, `033caa57d`, `4103e8067`, `0b73456d6`, `cd89879c9`, `0160e44d0`, `38a92af9e`, `45bcfe127` |
| 6–11 | ⬜ | — |

Audit and doc revamp: `cb6b983b2`.

### Blocking before any of this is live

0. **A second `db push` landed for Wave 2** — `MailboxSubscription.watchFailureCount`
   (`INTEGER NOT NULL DEFAULT 0`). Previewed with `migrate diff` first: exactly
   that one column, nothing else pending, nothing dropped. Follow-up diff empty.

1. ~~**`prisma db push`**~~ — ✅ **applied to `divo_dev` 2026-08-02.**
   `MailboxSubscription.notifiedState` and `notifiedStateAt` are live; a
   follow-up `migrate diff` returns empty, so the database matches the schema
   with no drift. The pushed diff was exactly those two nullable columns —
   nothing else was pending, and nothing was dropped. Applied over the SSH
   tunnel (`bash scripts/db-tunnel.sh`); there is still no `_prisma_migrations`
   table, so `db push` remains the mechanism.
2. **`scripts/reconcile-capabilities.ts`** — Wave 0 is text in the DB-seeded
   skill registry. Committed ≠ live. New companies pick it up at creation;
   every existing company needs this script run once. This is defect P2 and it
   will keep biting until Wave 7.
3. ~~**`dev` does not typecheck**~~ — ✅ resolved by the other workstream;
   `tsc --noEmit` exits 0 in `advance-backend/`, and `admin/` typechecks and
   builds clean. `tests/tools/zoho-tools.test.ts` → "personalized scope filters
   Books records after Zoho responds" still fails on `dev`; it predates this
   work and is not Mail Ops.

### What Wave 1 actually shipped

Three read-only endpoints, member-authenticated and pinned to the signed-in
member server-side (`/api/mail-automations/rules`, `/rules/:ruleId/deliveries`,
`/health`), a pure health-interpretation module, a read-only repository split
off from the 800-line write repository, and a Lark notifier that alerts once
per transition into a broken state.

Design decisions made during implementation, beyond what §5 specified:

- **Rule state is resolved against mailbox state, server-side.** A rule whose
  mailbox is not being watched returns `blocked` rather than `active`, so no
  client has to join the two and none can disagree about it.
- **`never_started` outranks `paused`.** A mailbox with no active rules parks
  itself, which would otherwise report "paused" and conceal a watch that never
  registered — D2's exact symptom. The ordering is explicit and tested.
- **A failure code only produces a remedy where we can advise honestly.** An
  unrecognised provider code returns `null` rather than an invented
  instruction.
- **`notifiedState` is persisted, not in-memory.** An in-memory guard would
  re-alert every mailbox on every deploy, which is what teaches people to mute
  the bot.
- **Asymmetric recording:** a failed Lark send is not recorded, so it retries;
  an owner with no Lark identity is recorded, because retrying would never
  succeed.

The screen (`b994c22f7`) is `/me/mail-rules` in the personal scope — a
`YouMailRules` screen in its own `screens-you-mail.tsx` rather than appended to
the 1,400-line `screens-you.tsx`, a `data/use-mail-automations.ts` hook, a nav
entry, a route, and a `mailRules` `DATA_SOURCES` marker reading `live`.

Two things sit above the rule list, in this order, because they are the two
things that actually go wrong:

- **Rules whose destination domain differs from the mailbox domain get their
  own panel** (S3). Domain-to-domain is the only comparison this screen can
  make honestly — there is no company address book to check against — so it
  claims exactly that and no more.
- **The mailbox banner names the failing address.** A watch that never
  registered kills every rule on that mailbox at once, and the per-rule rows
  underneath would each look individually fine.

The screen is read-only: pause and delete still go through Divo, and the panel
footer says so rather than offering buttons that do not exist. `tsc` exits 0
and `npm run build` succeeds; it was not exercised in a browser because
port 5173 is held by another session's dev server and admin OAuth callbacks are
registered against that port.

61 tests pass across the mail suite. Wave 1's endpoints return today's truth —
they cannot yet show deliveries that were refused before a row was written,
because DR-2 lands in Wave 2. Waves 1 and 2 are a pair, and the screen is the
reason: it will faithfully display a rule as `working` right up until the
moment nothing arrives, because the refusal never became a row.

---

## 0. The thesis

The architecture is sound. Content-addressed idempotency, optimistic claim tokens with stale reclaim, a signal-version guard so a push arriving mid-sync isn't swallowed by cursor advancement, deterministic matching with no LLM in the OTP path — all of that stays.

Every defect found sits on a failure edge, and they share one shape:

> **Mail Ops makes promises in the instruction layer that the runtime silently declines to keep.**

Three independent instances, none of which produce an error anyone sees:

- The seeded skill promises **OTP extraction**. There is no OTP code anywhere — the whole message is forwarded.
- The tool reports **"Mail automation is active"** the instant the row is written, before any Gmail watch exists — and if the watch never registers, the mailbox is excluded from the very poll designed to cover that case.
- The skill tells the model a **Connect Google card was sent** and to end the run and wait. The card is never sent. The field that would trigger it is never populated in production.

The organizing principle for every fix below:

> **Every skip becomes a durable row, and no instruction may claim a capability the runtime cannot deliver.**

---

## 1. Corrections to the first-pass audit

Recorded because the wrong version was already written down and acted on.

**C-A — the `channel: 'lark'` diagnosis was wrong.**
Rev 1 claimed `authorizeRule`'s hardcoded `channel: 'lark'` caused non-Lark users to be denied, and named it the prime suspect for the production events-without-deliveries gap. **False.** `PermissionServiceImpl.resolve` destructures only `{ companyId, userId, companyRole, departmentId }`; `channel` appears in the entire permissions module once, as a type field at [permission.types.ts:15](../advance-backend/src/application/permissions/permission.types.ts:15), and is in no cache key. The argument is inert. `resolveByUserId` likewise needs only an active `AdminMembership` — the Lark lookup is optional, `channel` falls back to `'internal'`. A user who has never touched Lark authorizes and delivers normally. The hardcoded literal is misleading to read and should be removed, but it is not a defect. **The real mechanism is D4**, which is worse.

**C-B — there is no cross-user mailbox path.** An intermediate finding suggested the subscription is owned by "the first creator" and the worker authorizes against `claim.userId` rather than the rule's creator. The composite FKs foreclose it: [schema.prisma:1397](../advance-backend/prisma/schema.prisma:1397) binds subscription→connection on `[connectionId, companyId, userId] → [id, companyId, ownerUserId]`, and [:1443](../advance-backend/prisma/schema.prisma:1443) binds rule→subscription on `[subscriptionId, companyId, createdByUserId] → [id, companyId, userId]`. Therefore rule creator ≡ subscription owner ≡ connection owner, always, enforced by the database. Company-owned connections (`ownerUserId = null`) can never carry a subscription. Independently confirmed twice. **Not a defect — and it is the single best-engineered thing in the subsystem.**

**C-C — "accurately documented" is not "correct."** The doc fact-check placed the `watchRegisteredAt` sync gate (D2) and the `rfc822msgid` idempotency guard (D1) under a heading reading *"still accurate and load-bearing — do not fix these."* Both claims do faithfully describe the code; both describe defects. That list is a documentation-fidelity result and must be filtered through "do we want to keep this behaviour" before use.

**C-D — the autonomous-workers kill switch is off-by-default-safe.** `DIVO_AUTONOMOUS_WORKERS_ENABLED` is `booleanStr.default('true')` ([env.ts:315](../advance-backend/src/config/env.ts:315)). The split-brain in D14 is real but is not currently firing in production.

---

## 2. Defect register

Severity-ordered. Every `file:line` is against `dev`.

### Tier 1 — the runtime silently stops working

**D1 — Duplicate forwards.** [gmail-history.client.ts:81-90](../advance-backend/src/infrastructure/google/gmail-history.client.ts:81)
The resend guard searches `in:sent rfc822msgid:<key@mailops.divo>`. Two independent failures: Gmail's `messages.send` does not reliably preserve a client-supplied `Message-ID` (it commonly generates its own and demotes yours to `X-Google-Original-Message-ID`), and `rfc822msgid:` hits an eventually-consistent **search index** queried 5 seconds after a failed attempt ([mail-ops.repository.ts:790](../advance-backend/src/infrastructure/persistence/mail-ops.repository.ts:790)). Send succeeds, response is lost, retry forwards again.
Tell: `MailDelivery.ambiguous` exists and the only write in the codebase is `ambiguous: false`. The case was designed and never built.
**Fix (DR-3):** `drafts.create` → persist `providerDraftId` → `drafts.send`. On retry, `drafts.get`: present means the send never completed, absent (404) means it did. Index-independent, uses an identifier we own. Set `ambiguous: true` before the network call and clear it on a confirmed outcome. Delete the search path.

**D2 — A mailbox whose watch never registers is never synced.** [mail-ops.repository.ts:297-302](../advance-backend/src/infrastructure/persistence/mail-ops.repository.ts:297)
With Pub/Sub on, `claimNextDueMailbox` requires `watchRegisteredAt != null` **and** `historyId != null`. If `watch` fails permanently — classically the Pub/Sub topic missing its publisher grant to `gmail-api-push@system.gserviceaccount.com` — `failWatchRenewal` retries every 15 minutes forever while the mailbox is excluded from the 60-minute reconciliation that exists precisely for this. Rules are 100% dead; the tool still says "active."
**Fix (DR-4):** drop both conditions. A null `historyId` is already handled — `sync()` bootstraps from `users/me/profile`. Push stays the fast path; reconciliation becomes unconditional. Add `watchFailureCount` and `degradedAt`; escalate after 3 failures and notify the owner once.

**D3 — High-volume mailbox wedges permanently.** [gmail-history.client.ts:152-154](../advance-backend/src/infrastructure/google/gmail-history.client.ts:152)
More than 10 pages of history between cursors → `throw` → `markSyncFailed` → retry in 5 minutes **with the same cursor** → throws again, forever.
**Fix (DR-5):** on hitting the cap, return what was gathered with `nextHistoryId` from the last page and `truncated: true`; advance the cursor and set `nextPollAt = now` to keep draining. Reserve `reconcileStaleCursor` for genuine 404s.

**D4 — A stale department stalls the entire mailbox.** [composition.ts:1972](../advance-backend/src/composition.ts:1972) *(replaces rev 1's D6)*
The rule pins `departmentId` at creation. When the user later moves teams, `resolve()` returns `err(department_access_denied)` and `authorizeRule` does `throw resolved.error` **instead of returning `false`**. Inside `syncMailbox` that throw escapes the per-rule loop into the method-level catch ([mail-ops.worker.ts:271-283](../advance-backend/src/application/mail-ops/mail-ops.worker.ts:271)) → `markSyncFailed` → **the cursor never advances**. One departed user's stale rule stalls the whole mailbox — every other rule on it included — retrying every 5 minutes indefinitely. In `deliver` the same throw burns all five attempts instead of taking the intended `markDeliveryAbandoned` path.
This is the best available explanation for the observed production numbers: events persist (written before the rule loop), deliveries stop dead, re-syncs re-record the same dedup'd range.
**Fix:** return `false` on `PermissionError`, or short-circuit `department_access_denied` to a denial. Then per DR-2, write a `blocked` delivery row so it is visible. Hoist the check out of the inner loop — it currently runs N events × M rules per sync.

**D5 — The OAuth continuation path is dead in production.** [composition.ts:609-611](../advance-backend/src/composition.ts:609) **P0, cross-cutting**
`runContext.connectionAuthorization` appears in `src/` exactly twice: declared at [run-context.ts:78](../advance-backend/src/domain/orchestration/run-context.ts:78), read at composition.ts:609. **Zero writes.** So `beginGoogleAuthorization` short-circuits to `unavailable` on every production call. Consequence chain: `mailAutomations` can never return `google_workspace_authorization_pending`, never creates a `ConnectionAuthorizationIntent`, never schedules a continuation run — it falls through to an `unrecoverable` ToolError carrying the collapsed string "Connect or reconnect Google to continue." Meanwhile the skill tells the model the card was sent and to end the run and wait.
**Not mail-specific:** every `google-<product>` skill asserts that only `google_workspace_authorization_pending` proves the card went out, and that code is unreachable.
Dead alongside it: `continuationToolIds`, written at [google-connection-continuation.ts:367](../advance-backend/src/application/connections/google-connection-continuation.ts:367), read nowhere, with a doc comment describing an RBAC intersection that does not happen.
**Why it was never caught:** the covering test stubs `beginAuthorization` to return `{status:'sent'}` outright and hand-builds `connectionAuthorization` into the context, then asserts the tool forwards the field it was handed ([mail-automations.tool.test.ts:155](../advance-backend/tests/tools/mail-automations.tool.test.ts:155)). The mock supplies the exact precondition production never supplies, so the test is permanently green over a dead feature.
**Fix:** populate `connectionAuthorization` at Lark ingress and propagate it through `ToolExecutor.buildRunContext`. Separately define off-Lark behaviour (see S3). Add a test that exercises the real composition closure, not a stub.

### Tier 2 — security and governance

**S1 — Cross-company Lark delivery is open.** [mail-automations.tool.ts:20-24](../advance-backend/src/application/tools/families/mail-automations.tool.ts:20)
`destinationSchema` accepts any `chatId` string; nothing validates it against the creator's or the company's accessible chats. The "use governed Lark chat discovery" constraint exists **only as prompt text**. `deliverLark` calls `larkAdapter.sendToChatId`, which uses the **app-level** client built from `LARK_APP_ID`/`LARK_APP_SECRET` with no `companyId`, `tenantKey`, or membership check — despite `LarkTenantBinding` existing to map tenants to companies. Anything the bot can post to is reachable. If one Lark installation serves more than one Divo company, a rule in company A can pipe mail into company B's chat.
**Fix:** ground `chatId` against the creator's accessible chats at create time, and scope `deliverLark` by the rule's `companyId`/tenant at delivery time. Validation must live in code, not in the prompt.

**S2 — `IntegrationConnectionGovernance` does not reach mail automations.** [composition.ts:1921-1991](../advance-backend/src/composition.ts:1921)
`MailOpsWorker` is constructed with `repo / gmail / resolveAccessToken / authorizeRule / deliverLark / logger` — **no `ConnectionRateLimitService`, no `ApprovalGateService`.** Every forward and every Lark delivery bypasses per-action rate ceilings and approval modes entirely. Two compounding holes:
- `connectionId` is *optional* on `create`, so omitting it makes `connectionIdFromArgs` return `undefined` and the interactive path short-circuits to `not_governed` — a `connection_owner` approval policy is bypassed by simply not naming the connection.
- Approval gates on the **tool action**, which for rule creation is `create`, never `execute`. A department that gates `execute` therefore does not gate the act of authorizing unlimited future background execution. Approval also defaults to off when `managerApprovalJson` is unset.

Net: a manager can throttle and require approval for interactive use of a connection, and a background rule on that same connection then runs under no policy at all.
**Fix:** pass both services into the worker and evaluate the stored `execute` policy per delivery; make `connectionId` required for `create`.

**S3 — Persistent exfiltration surface.** `destination.type: 'email'` accepts any address, and `gmail.forward` sends the full original MIME from the user's own mailbox. Combined with S2 (no approval by default, governance bypassable by omission) and the fact that `{"from":"@company.com"}` is a legal match, **one successful tool call establishes a silent, persistent, full-mailbox forward to an arbitrary address.** Only *matching* is LLM-free — *creation* is not, so this is reachable by indirect prompt injection into an earlier tool result. Nothing in the delivery path ever re-validates the destination.
**Fix:** require explicit approval for a first-time external destination domain; re-validate destination at delivery; surface active external-forward rules prominently in the Wave 1 UI.

**S4 — De-escalation requires the capability being revoked.** [mail-automations.tool.ts:187-190](../advance-backend/src/application/tools/families/mail-automations.tool.ts:187)
`actionFor` maps `pause` → `update`, and `update` is in the `needsExecute` set. Revoke `execute` and the user can no longer **stop** their own live rules — only `archive` (mapped to `delete`) still works.
**Fix:** drop `execute` from the `pause` requirement.

**S5 — The owner-access downgrade check is dead code.** The connection **owner** is hardcoded to `admin` access, and Mail Ops rules can only exist on owner-owned connections (FK). So the `read_write → read_only` downgrade check can never fire for any rule that can exist. Not exploitable today, but it is a control that reads as active and is not.

### Tier 3 — correctness

**D6 — Unbounded concurrent message fetches.** [gmail-history.client.ts:192](../advance-backend/src/infrastructure/google/gmail-history.client.ts:192) `Promise.all` over up to 1000 `format=full` fetches. Cap at 6. A message returning **404** (deleted between the history record and the fetch) must write a tombstone and be skipped, or it wedges the cursor exactly like D3; any other per-message failure must still abort the batch so the cursor cannot advance past unread mail.

**D7 — Stale-cursor recovery loses mail and can burst-send.** [gmail-history.client.ts:166-169](../advance-backend/src/infrastructure/google/gmail-history.client.ts:166) `newer_than:1d`, cap 100. Older mail is gone with no record; conversely up to 100 fresh events can hit a broad rule in one tick. Widen to `newer_than:7d` paginated to 500, write a `MailboxReconciliation` audit row, add the per-rule hourly cap.

**D8 — Pausing the last rule pauses the whole mailbox, and resuming replays.** [mail-ops.repository.ts:264-276](../advance-backend/src/infrastructure/persistence/mail-ops.repository.ts:264)
`setRuleStatus` counts remaining active rules and at zero sets `MailboxSubscription.status = 'paused'`, which excludes the mailbox from **both** sync claims and watch renewal. Watch expiry self-heals on resume; the **cursor does not**. Pause for longer than Gmail's ~1 week history retention, resume, and: `history.list` 404s → recovery queries `newer_than:1d` capped at 100 → the intervening days are **silently lost**, *and* those ≤100 messages are brand-new events matched against the just-resumed rule, so **up to a day of old mail is forwarded**. Both failure directions, from one ordinary user action the skill presents as trivially reversible.
**Fix:** keep the subscription active (or at minimum keep watch renewal alive) while any non-archived rule exists; on resume after a long pause, reconcile forward-only and record the gap instead of replaying.

**D9 — No forwarding-loop guard.** A destination aliasing back into the mailbox plus a `subjectContains`-only rule re-matches its own `Fwd:` output. Stamp `X-Divo-Mailops: <ruleId>`, skip events carrying it, backstop with the per-rule cap.

**D10 — `hasAttachment` fires on inline images.** [gmail-history.client.ts:288-292](../advance-backend/src/infrastructure/google/gmail-history.client.ts:288) Any part with a `filename` counts, so signature logos qualify. Exclude `Content-Disposition: inline` and parts carrying a `Content-ID`.

**D11 — `to` ignores Cc, Bcc, and Delivered-To.** [mail-rule.matcher.ts:91](../advance-backend/src/application/mail-ops/mail-rule.matcher.ts:91) "Forward mail sent to my alias" silently never fires when the user was Cc'd. Match the union; adopt exact-mailbox semantics per DR-8.

**D12 — `@domain` does not match subdomains.** ✅ **fixed 2026-08-02, see O-2.** [mail-rule.matcher.ts:108-110](../advance-backend/src/application/mail-ops/mail-rule.matcher.ts:108) `address.endsWith('@stripe.com')` fails for `receipts@mail.stripe.com`. Nearly every transactional sender uses a bounce subdomain. The skill explicitly instructs the model to use `@example.com` for "every sender at a domain," the rule never fires, and `list` reports `valid: true`.
**Fix:** match the registrable domain and all subdomains, or add explicit `@*.domain` syntax. Whichever is chosen, the skill text must say precisely which.

**D13 — Unknown match keys are silently dropped.** The operation object is `.strict()` but `mailRuleMatchSchema` is a plain `z.object`, so Zod strips unrecognized keys. `{"from":"@x.com","cc":"finance@y.com"}` creates a rule matching *only* `from`, reports success, and the narrowing the user asked for is gone. Make the match schema `.strict()`.

**D14 — Two independent readiness flags.** `pubsubReady` gates whether the tool lets you *create*; `DIVO_AUTONOMOUS_WORKERS_ENABLED` gates whether the worker *runs* ([server.ts:177](../advance-backend/src/server.ts:177)) and whether push wakes it ([server.ts:454](../advance-backend/src/server.ts:454)). With Pub/Sub configured and workers off, `create` returns "Mail automation is active" and nothing ever runs. Defaults to `true`, so not currently firing — but the failure is perfectly silent. Unify into one readiness signal the tool can report on.

### Tier 4 — the instruction layer lies

Each of these is a promise in seeded prompt text that the runtime does not keep. They are defects in the product, not in the prose.

**T1 — OTP extraction does not exist.** ✅ **closed by deletion, permanently — see O-3.** The string `otp` appears **6 times in the whole `src/` tree, all 6 in instruction text** ([mail-ops-system-skills.ts](../advance-backend/src/application/skills/mail-ops-system-skills.ts) lines 42, 55, 63, 72, 86 and [mail-automations.tool.ts:175](../advance-backend/src/application/tools/families/mail-automations.tool.ts:175)). Zero OTP code. Both delivery paths ship the entire message: `gmail.forward` re-sends the full raw MIME, and `formatLarkDelivery` emits `From / Subject / full bodyText` at up to 20,000 chars. Because the text says OTP handling "does not invoke an LLM," the model reads it as a deterministic extractor and will not push back or offer an alternative. A user asking for "just the OTP in Lark" gets the complete body of every login email posted into a chat that may include other people.
**Fix:** either build a deterministic extractor as a real action type, or delete every OTP claim from the instruction layer. Do not ship the current middle state.

**T2 — "Mail automation is active" is asserted before any watch exists.** [mail-automations.tool.ts:380-396](../advance-backend/src/application/tools/families/mail-automations.tool.ts:380) returns `status: 'active'` as a hardcoded literal immediately after the DB write. Watch registration happens later, asynchronously, and may never succeed (D2). Report a pending state until a watch is confirmed.

**T3 — A Connect card the system never sends.** Surface of D5.

**T4 — `current_lark_chat` is invalid off-Lark, and only `parameterDocs` says so.** The skill markdown the model composes from presents it unconditionally. Worse, the throw happens *after* connection resolution, so an unconnected desktop user first gets a Connect card, completes OAuth, and only then hits the failure — which is then misclassified as `upstream_failure` rather than `bad_args`.

**T5 — `create` silently resurrects and renames archived rules.** `mailRuleDedupeKey` hashes companyId + userId + connectionId + match + action + destination — **not `name`**. Re-creating an identical rule un-archives the old one, renames it, and returns the same `ruleId`, which the model reports as brand new. It is also the only way to undo an archive, since `resume` on an archived rule returns the misleading "Mail automation rule was not found in your account."

**T6 — Capabilities the instructions never mention.** `list` already returns a per-rule `valid` / `invalidReason` verdict — the exact "your rule died" surface the product needs — and no instruction tells the model to read it. `includeInactive` is never mentioned. The multi-account `choose_connection` round-trip is absent from the skill markdown, so a model working from the skill treats a selection prompt as a failure. The skill's step 3 tells the model to reuse a `connectionId` "from the current run," but `mailAutomations` is in the `scheduling` family with `connectionMode: 'none'`, so loading `mail-ops` surfaces **zero** Google connections.

**T7 — The anti-brand rule is scoped to `from` only.** The skill forbids turning a brand word into a sender criterion, but `from` is the only validated field. A model can satisfy the letter with `to: "Anthropic"` or `bodyContains: "Anthropic"` and produce a far broader rule. Related: "at least one match field is required" reads as "one is sufficient" — `{"hasAttachment": true}` is legal and forwards every attachment-bearing message to an arbitrary address with no approval.

**T8 — Substring matching is literal and undocumented.** `String.includes` on lowercased values. A model will plausibly emit `subjectContains: "OTP|verification code"` or `"*invoice*"`, which match nothing.

**T9 — Reciprocal routing guards are missing.** `google-gmail` says to use Gmail filter operations "when the user explicitly asks for an ongoing Gmail rule"; `mail-ops` says never substitute a native Gmail filter. Once a run has entered `google-gmail` — which the router does for any "forward this email" — nothing routes it back. `schedule-divo-work` has no arrival-trigger prohibition at all and ships a mail-polling exemplar. `mail-ops` is named in no other skill's markdown.

### Tier 5 — provisioning is not deterministic

Three independent mechanisms decide whether a user can use mail automation at all.

**P1 — Department template snapshot.** `mailAutomations` is declared `ALL_ROLES` at [tool-id.ts:168](../advance-backend/src/domain/tools/tool-id.ts:168), flowing into `memberTemplateGrants()`, which every **new department** uses to seed its two system roles. A department created *before* `mailAutomations` entered the taxonomy has no rows for it — and missing rows are denied at runtime.

**P2 — The deploy does not provision Mail Ops.** ~~The dev deploy runs `pnpm provision:google-workspace-skills`, which contains **zero** Mail Ops references. Only the manual `scripts/reconcile-capabilities.ts` provisions the mail-ops skills and `mailAutomations` permission rows.~~ **[wrong, corrected 2026-08-02]** Both halves of the first sentence are true and the conclusion drawn from them is not. `scripts/reconcile-capabilities.ts` is not manual: `package.json` binds it to `prestart`, the backend image's `CMD` is `pnpm start`, and `docker-compose.dev.yml` gives `divo-dev-backend` no `command:` override. It therefore runs on **every boot of every backend container**, and Mail Ops skills and permissions are provisioned on every deploy already.

That correction makes P3 considerably worse than it was written, and is why Wave 7 is a fix rather than a new deploy step: the unguarded rewrite of every custom role was not an occasional manual act, it ran at every boot; and the hard-throw on a company with no active administrator failed `prestart`, which aborts `pnpm start`, which means the container never serves and restarts into the same failure.

**P3 — The Mail Ops provisioner is the only one that rewrites custom roles.** `provisionMailOpsPermissionsForExistingCompanies` grants all five actions to **every** `DepartmentRole` — including hand-configured "Intern" or "Contractor" roles — with none of the `existing > 0` guard that `backfillEmptyRolePermissions` uses precisely to protect deliberate admin configuration. It also never calls `permissions.invalidateDept`, so grants land 0–15 minutes late, and it hard-fails the whole run if any company lacks an active admin.

**Posture note.** `mailAutomations` matches its sibling `scheduledWorkflows` exactly, so `ALL_ROLES` is a deliberate family-level choice, not an oversight. But every *other* capability that acts outside the requester's own view is `ADMIN_ONLY` — `larkBase`, `larkApproval`, `airtableSchema`, `airtableAutomation`, and `googleAppsScript`, the only other `execute` holder. Granting `execute` on a persistent background mail-forwarder to every member of every role is unusually permissive for what it does. **Open decision, see §10.**

---

## 3. Code quality

**Preserve as house style:** total `Result<T,E>` discipline; optimistic concurrency done properly everywhere (claim token → conditional `updateMany` → `count === 1`) with `advanceCursor`'s subtle and correct signal-version fallback; clean layering with `GmailHistoryClient` injectable via `fetch`; composite FKs that make ownership a database invariant (C-B); behaviour-named tests.

**Fix:**

**Status 2026-08-02: done.**

| Issue | Status |
|---|---|
| Validation defeated by a cast | ✅ `readDeliveryPayload` is a Zod schema. It also **drops** unknown keys now, so a field removed in a later version cannot ride out of a row written before the removal. |
| Error classification by substring | ✅ `GmailApiError` carries Google's machine-readable `reason` beside the status, and classification keys off both. A `403` is genuinely ambiguous — "insufficient permissions" *and* "too fast" — so the reason separates them. The substring pass survives only for errors that never came from Gmail, and no longer looks for `scope` or `permission`: a Divo-side error saying "permission" is our problem. This one mattered because `scope_missing` puts "Reconnect Google" in front of the mailbox owner. |
| Two phantom delivery states | ✅ half stale, half real. `ambiguous` **is** written `true` — fixed in Waves 3–5, the audit entry was out of date. `'failed'` was real: declared, never written. The union also **omitted `blocked`**, which every refusal and rate-limit drop writes — wrong in both directions at once, and nothing referenced it, which is how it drifted. |
| `errorText` defined twice | ✅ stale. One copy in the worker; the repository's is a distinct `const` with deliberate 500-char truncation for a database column. |
| Repository mixes four aggregates | ✅ split into `persistence/mail-ops/{subscription,rule,event,delivery}.repository.ts`. Each now declares only the models it touches, so a delivery cannot reach a subscription row by accident. `MailOpsRepository` stays as the callers' single object, its methods bound to the four — splitting the callers is a separate change from splitting the code, and doing both at once would make each harder to review. The split is what surfaced the surviving `5` below. |
| MIME functions untested | ✅ `buildForwardMime` / `splitRawMessage` / `selectContentHeaders` covered by the byte-for-byte forward tests (see Wave 8); `extractBody` / `hasAttachment` now have direct tests, having been reachable only through a full sync. Both were exported for the purpose. No defect found in either — the tests pin behaviour that had none. |
| Magic numbers split across files | ✅ `MAIL_DELIVERY_MAX_ATTEMPTS`, `MAIL_DELIVERY_RETRY_BASE_MS`, `MAILBOX_WATCH_RENEWAL_INTERVAL_MS`. The retry ladder's `5` was three separate literals across the claim predicate, the failure path and the stale sweep — they have disagreed before, and rows at the end of the ladder became both unclaimable and unabandonable. **One survived that pass:** the stale sweep still asked for `attempts: { gte: 5 }` while the two predicates beside it read the constant — the same file, twelve lines apart. It was found by moving the code, not by the pass that claimed to have removed it, which is the argument for the split above. |
| Mock-shaped tests over dead code | ✅ **appears resolved with D5 itself.** `runContext.connectionAuthorization` no longer exists in `run-context.ts` or `composition.ts`; `beginGoogleAuthorization` now decides on `googleOAuthService.isConfigured()`, and `tests/application/begin-google-authorization.test.ts` exercises it. Confirmed by grep, **not** by tracing the whole OAuth continuation end to end — D5 is cross-cutting and its closure should be verified on its own terms, not assumed from this. |

---

## 4. Decision records

**DR-1** Visibility ships before correctness. Every later fix is unverifiable in production without it.
**DR-2** Every declined message writes a durable row — `blocked`, `deferred`, or `abandoned` with a reason. No bare `continue`.
**DR-3** Send idempotency uses drafts, not search (see D1).
**DR-4** Watch health must never gate the reconciliation poll (see D2).
**DR-5** Bounded history is drained, never thrown (see D3).
**DR-6** Rules stay deterministic — no LLM in matching or delivery. OTP forwarding must not depend on model availability or cost.
**DR-7** Gmail-only is accepted V1 scope, but must be stated in the tool description, the skill text, and the UI.
**DR-8** Match semantics move to exact-mailbox parsing; substring becomes legacy, flagged in the health API.
**DR-9 *(new)*** **No instruction may claim a capability the runtime cannot deliver.** Any skill or `parameterDocs` change that describes new behaviour requires a test asserting that behaviour against real wiring. This is the direct lesson of T1 and D5.
**DR-10 *(new)*** **Grounding constraints belong in code, not prompts.** "Use governed Lark chat discovery" as prompt text is not a security control (S1).

---

## 5. Wave plan

Each wave independently shippable and verifiable. Cold-review each before commit.

**Wave 0 — Stop lying** ✅ *(`8148a7b51`)*
Deleted every OTP claim (T1) while keeping the `otp` routing aliases — routing such a request to `mail-ops` is correct, only the capability description was wrong. Stated Gmail-only (DR-7). Moved the `current_lark_chat` off-Lark constraint into the skill markdown (T4). Documented `valid`/`invalidReason`, `includeInactive`, and the `choose_connection` round-trip (T6). Rewrote skill step 3, which told the model to reuse a `connectionId` the skill never surfaces. Also documented the match semantics users actually hit: AND-only, literal substring, the subdomain gap, `To`-header-only, inline-image `hasAttachment`, and silently-dropped unknown keys. Handover corrected per §9.
Added a guard test asserting no surface claims OTP extraction, **verified by reintroducing the claim and watching it fail** — a test that cannot fail is what let D5 survive.

**Wave 1 — Visibility** *(DR-1)*
- ✅ **Backend** *(`e2c2abc62`, `54a2f0f8a`)* — the three endpoints, the health-interpretation module, the read repository split, and the Lark notifier. See Progress above for the decisions taken during implementation.
- ✅ **Screen** (`b994c22f7`) — `/me/mail-rules` in the personal "You" scope: `screens-you-mail.tsx`, `data/use-mail-automations.ts`, nav entry, route, `mailRules` `DATA_SOURCES` marker. Built on the workspace's own `ui.tsx` primitives. Rules leaving the mailbox's own domain get a dedicated panel above the list (S3), and the mailbox banner names the failing address above rules that would otherwise look fine.

*Acceptance:* a user whose rule stopped firing can determine unaided that it stopped and why.

**Wave 2 — Silent death** ✅ *(D2, D3, D4, D14, DR-2)*
- ✅ **D3** *(`6e0d120cf`)* — the page cap stops instead of throwing. The cursor it reports is the last history record actually consumed, **not** `payload.historyId`: that field is the mailbox's newest record, so returning it after ten pages of a longer backlog would have skipped the remainder permanently. A truncated pass that consumed nothing leaves the cursor alone. `advanceCursor` gained `pollImmediately` so a partial drain comes back on the next tick.
- ✅ **D2** *(`97be67a46`)* — `requireRegisteredWatch` deleted; reconciliation is unconditional. **This changed what health means**, so the state model changed with it: a broken watch now costs latency, not delivery. `watch_delayed` (rules still fire hourly, nobody told) escalates to `watch_degraded` after `watchFailureCount >= 3` (new column, pushed to `divo_dev`), which notifies once. `sync_failing` outranks both. `never_started` now requires no watch **and** no successful sync. `rulesCanFire` stays true through both watch states, and the screen grew a third badge — "Delayed" — because "Not watching" would send someone reconnecting a working account.
- ✅ **D4 + DR-2** *(`c4a5e2561`)* — `authorizeRule` returns `allowed | denied | unavailable`. Denials are recorded and the sync continues; `unavailable` holds the cursor. This required splitting the source: `PermissionServiceImpl` reported an unreadable department store and genuine non-membership under the same `department_access_denied`, so a database blip was indistinguishable from a decision. New reason `permission_lookup_failed`. Refusals write an inert `blocked` delivery row carrying the human reason; **matching is checked before authorizing**, so a blocked row always means "this matched and was refused". Unparseable rules deliberately write no row — the failed clause *is* the match clause, so there is no honest per-message claim to make, and the rule already reports `broken`. Authorization resolved once per rule per sync, not once per event per rule.
- ✅ **D14** *(`97b4d22b9`)* — `pubsubReady` replaced by a `runtime` object carrying `pubsubConfigured` **and** `workersEnabled`. Two distinct refusal messages, because an unfinished Google setup and an environment that runs no background work need different fixes.

**Cold review of Wave 2, two rounds.** Round one found four defects I had introduced, all fixed: the `permission_lookup_failed` split covered only the department axis, so a company-axis DB blip still became a permanent `blocked` row (`0b94131b2`); a truncated pass that consumed nothing still asked to be re-polled, giving a 200-Gmail-call-per-tick hot loop with the mailbox reporting healthy (`458736c01`); the `unavailable` error's message contained "permission", so `syncFailureCode`'s substring match stamped it `scope_missing` and told the member to reconnect a healthy Google account (`458736c01`); and `blocked` was derived from a 30-day count, so a recovered rule went on reporting itself refused (`88ef5b75e`, which also split `lastBlockedAt`/`blockedReason` out of the conflated `lastError`, reordered `paused` above the watch states, and made the alert card title follow `rulesCanFire`). Round two found that stopping the loop had left the branch *asserting success* — fixed in `9067fea78` by failing with `history_backlog_stalled`, plus completing the screen's error gate and dropping a serialised field nothing read.

**Known and deferred:** a stalled backlog is now visible but still cannot make progress. Resuming from a stored Gmail `pageToken` is the real repair — it needs a column on `MailboxSubscription` and belongs in **Wave 10**.

*Acceptance:* revoke the Pub/Sub publisher grant in a test project — mail still syncs within 60 minutes, health reports `watch_degraded` after three failures, owner notified once. Move a user out of a rule's department — that rule blocks with a visible row, the mailbox keeps syncing. **Not yet exercised against a live Google project**; covered by unit tests only (the full backend suite is green after the Wave 3–5 cold review and its fixes: 2505 tests, 0 failures).

**Wave 3 — The dead OAuth path** *(D5)* — ✅ done, P0, cross-cutting beyond mail

The context could not live on `RunContext` as rev 1 assumed, because it does not survive the trip: Pi runs in a container and calls tools back through the gateway long after the Lark event is out of scope. It is recorded at ingress instead — `RunOriginStore`, Redis, 30 minutes — keyed by the run ID already carried on the signed runtime lease, and `createBeginGoogleAuthorization` looks it back up. Every read is re-bound to the calling member, so knowing a run ID is not enough to start an authorization in somebody else's conversation. An ask too long to store faithfully is not stored at all: a continuation re-runs it verbatim, and half an instruction is worse than none.

`ToolExecutor.buildRunContext` now carries `runtimeRunId`, taken off the lease rather than the request body.

Off-Lark behaviour is the `SELF_SERVICE_CONNECT_HINT`: when no card can be delivered — no conversation to put one in, or delivery failed — both Google tools name the route that actually exists, **Connected apps** (`/me/connections`), not the "Settings → Integrations" this document invented before checking.

`selection.reason` is no longer collapsed. `mailOpsConnectionUnavailableMessage` gives `none_accessible`, `insufficient_access` and `requested_not_accessible` their own remedies, and `connectionState` travels beside the sentence so callers branch on state rather than prose.

`continuationToolIds` was deleted. It was written on every continuation run and read nowhere, under a comment promising an RBAC intersection no code performed; a continuation resolves permissions per tool call like any other run, so it granted nothing and guarded nothing.

The closure moved out of composition for one reason: the only test covering it stubbed that exact seam, which is how the feature stayed dead and green. It now has tests against the real store, and the two tool tests assert only what the tools are responsible for.

**Not exercised against a live Google project.** No card has been delivered, no intent issued, no continuation run started for real.

**Wave 4 — Security and governance** *(S1–S5)* — ✅ done

**S1.** A named `lark_chat` is grounded against a room this company has actually been in — `LarkChatContext`, which Divo writes when it observes a group chat and which is already scoped by company. Refusals split: a room Divo has never seen is the member's to fix and the message says how; a room belonging to another company is not, and says so. `current_lark_chat` is exempt by design — it resolves to the chat on the signed run context, and demanding a room record for it would break every DM. Delivery keeps a backstop that refuses only a room positively known to belong elsewhere, and *abandons* rather than retrying.

**S2.** `MailOpsWorker` now charges the connection's `execute` budget per delivery attempt, before the send. A refused budget hands back the attempt the claim spent and reschedules to the moment the store says the window reopens. *(Corrected after cold review: the first version threw, which routed into the retry ladder and abandoned the mail about seventy-five seconds into an hour-long window — `cdb1049fb`.)* Creation is governed on `execute` rather than `create`, because creating a rule authorizes unbounded future background execution, and that check asks about the **resolved** connection: `connectionId` is optional on `create`, so a connection-owner policy was bypassable by omission. Rev 1 proposed making `connectionId` required instead; that was rejected because `mailAutomations` sits in the `scheduling` family with `connectionMode: 'none'` (T6), so the model sees zero Google connections and could not supply one.

**S3.** A create or update whose destination leaves the requester's own email domain requires a manager or company admin to approve it, asserted by the approval gate itself alongside the knowledge-mutation branch rather than waiting to be configured. Fails closed twice: an unknown requester domain counts as external, and no reachable approver refuses the rule. Every external rule, not merely the first to a domain — "first time" is state that would have to be right for the control to be worth anything.

**S4 — the audit's claim did not reproduce.** `needsExecute` keys on the operation name and `pause` is not among create/update/resume, so revoking `execute` never blocked pausing. The real defect was next to it: `pause` shares the `update` action group with editing, so revoking `update` to stop members rewriting rules also removed their ability to stop a live one. Anyone who can archive a rule can now pause it.

**S5 — documented rather than changed.** The `minimumAccess: 'read_write'` floor is dead: a connection's owner is always granted `admin` and a rule can only exist on an owned connection, so it cannot reject anything. It stays, because it becomes real if rules are ever allowed on shared connections, with a comment at the site saying plainly that the ownership and scope checks below it are what actually stop a downgraded share.

**Still open from S3:** an already-reserved delivery is not re-checked against its rule, so pausing or archiving a rule does not stop deliveries already in flight. Narrow window, but real — carried into Wave 10 with the other delivery-lifecycle work.

**Wave 5 — Send correctness** *(D1, D6–D9)* — ✅ done

**D1.** A forward is staged as a Gmail draft, its ID persisted, and only then sent. On a retry the draft is resolved **before** authorization or the budget charge — everything after that point assumes nothing has been sent, and for a retry that assumption can be false (`4103e8067`). On retry the draft's presence answers the one question that matters, with no search index involved: Gmail consumes a draft when it sends it, so a 404 proves the mail went out and a live draft proves no send completed — and that same draft is then sent, which is also what stops a retry composing a second copy. `ambiguous` finally means something: set at staging, and cleared only by an answer — a confirmed send, or a probe that proved no send happened. The second case matters because abandoning is terminal: a delivery refused by permission, or one that ran out the retry ladder before it ever reached the send, would otherwise carry "may already be in somebody's inbox" forever with nothing left to resolve it (`0b73456d6`, `cd89879c9`). The proof is dropped the instant a send is attempted, so it can never claim a completed send never happened. Relatedly, every claimed delivery now reaches a terminal state: the stale-claim sweep used to return any abandoned-mid-attempt row to `pending` without looking at `attempts`, but the claim spends the attempt first and the search refuses anything at five, so a worker killed on the last rung stranded its row `pending` for the life of the table — never claimed again, never abandoned, still showing "Unconfirmed". Those rows are abandoned outright now, with `ambiguous` left standing, because a process that died during a send genuinely did not establish whether the mail went out (`38a92af9e`). The `rfc822msgid:` search path is deleted. Schema: `MailDelivery.providerDraftId`, pushed to `divo_dev`, re-diff empty.

**D6.** Message fetches run six at a time. A 404 message is skipped — deleted between the history record and the fetch, undeliverable by anyone, and failing on it wedged the cursor exactly like the old page cap. Every other per-message failure still aborts the batch.

**D7.** Recovery sweeps seven days paginated to 500, and at most 20 pages — a filtered `messages.list` can return an empty page still carrying a next-page token, so counting only messages let the loop run indefinitely while holding the mailbox claim (`a4ca91b83`). The dedupe argument for dropping the per-rule ceiling holds only for rules that already existed when the mail was recorded; a rule created afterwards dedupes against nothing, so events older than a rule are now skipped outright (`033caa57d`). The floor is `activatedAt`, not `createdAt`, because the row outlives its own archival: it moves when a rule is revived from archived, resumed from paused, or replaced with a different match, action or destination — and deliberately does not move for an idempotent re-create of a live rule, a pure rename, a case-only edit, a pause or an archive, all of which would otherwise discard backlog nobody asked to stop (`0b73456d6`, `cd89879c9`, `0160e44d0`). Reviving and starting a fresh watch are a single conditional write, issued last in the transaction so it also catches a pause that commits while that transaction is in flight. Genuinely undelivered mail reaching the rules that *were* live for it is what the member asked for, and that still happens. A recovery is logged distinctly, and escalated to an error when the window held more than one pass reads — that case still loses mail. The `MailboxReconciliation` audit row is deferred to Wave 10; the log line carries the same facts.

**D8.** The mailbox stays live while any non-archived rule exists, and is paused only when every rule on it is archived. It is chased immediately only when something can fire.

**D9.** Forwards carry `X-Divo-Mailops: <ruleId>`; the marker survives into event metadata and the sync loop skips any message wearing one, whichever rule sent it. The skip runs before authorization, so a self-forward costs no permission lookup.

**Wave 6 — Matching fidelity** *(D10, D11, D13, T7)* — ✅ done. **D12 and T8 remain open**, both waiting on decisions rather than on work. The wave's "plus direct MIME unit tests" is only partly met: `hasAttachment` is covered through the sync path, but `extractBody`, `splitRawMessage` and `selectContentHeaders` still have no test of their own and move to Wave 9 with the rest of §3.

**D10.** A filename alone no longer makes a message attachment-bearing. An inline part — a signature logo, a tracking pixel, an embedded screenshot — is one the message draws itself with, and says so through `Content-Disposition: inline` or the `Content-ID` its HTML points at. A part saying `attachment` outright is one regardless, since some clients stamp a `Content-ID` on every part they emit. A filename with nothing contradicting it still counts, because Gmail omits the disposition on plenty of genuine attachments; the test asserts each direction.

**D11.** `to` matches the union of `To`, `Cc`, `Bcc` and `Delivered-To`. Being copied is not a different event to the person receiving the mail, and `Delivered-To` is the only header that survives an alias or group expansion — the case where the address the user actually typed appears nowhere else in the message. Recipients are compared as whole mailboxes per DR-8, so `ana@example.com` no longer matches `dana@example.com`, and a display name claiming to be an address (`"ana@example.com" <impostor@evil.example>`) is read as the bracketed mailbox, and `from` now goes through the same parsing, which it did not before: it read the leftmost address anywhere in its header, so `From: (receipts@stripe.com) evil@attacker.tld` — a legal header from `evil@attacker.tld` — satisfied a rule on `@stripe.com` and put an outsider's message wherever that rule pointed. That holds for every construct the display position allows — a quoted name, a parenthesised comment, an encoded word — because each may legally hold a comma, and splitting the header through one leaves a fragment that reads as the address it imitates, so a rule fires on a message never sent to the mailbox it names.

**What that buys is correctness, not authority, and the distinction is worth stating because the parsing work makes it easy to assume otherwise.** Every recipient header is written by the sender and passed through untouched: anyone who can email a member can put any address in `To` and fire that member's rule on their own message, which then goes wherever the rule points — an external address, or a Lark chat with other people in it. Widening `to` to four headers widened that surface. `to` narrows a member's own mail and is not evidence of anything. The only recipient header that is not sender-authored is the `Delivered-To` the receiving server adds, and using it as a boundary would mean taking that one header rather than the union — a design decision about what `to` means, not a patch, and one nobody has asked for. Recorded here so it is a choice rather than an assumption. `MailMessageMetadata` gained optional `cc` / `bcc` / `deliveredTo`; events recorded before this carry `to` alone and match exactly as they used to.

**D13 and T7.** The creation schema is `.strict()`, so `{"from":"@x.com","cc":"finance@y.com"}` is now rejected instead of being silently stripped down to `from` and reported as a success. `to` is validated as a mailbox or `@domain` like `from`, which closes the T7 workaround of smuggling a brand word into `to`. And `hasAttachment` on its own is refused: at least one of `from`, `to`, `subjectContains`, `bodyContains` is required, because "every message carrying a file, forwarded to an arbitrary address" was never what anyone meant.

**Stored rules are parsed by a deliberately looser schema.** Tightening how a rule may be *written* must not change what rules already written match — a stored `to` of free text keeps its substring test **against `To` alone**, not the new union, because a free-text `to` is the loosest shape in the system and widening it would alter a rule nobody asked to alter. A stored `hasAttachment`-only rule still parses and still fires.

Three changes do reach stored rules, and are meant to. **The largest, and the one to actually tell people about: a stored `to` that already holds a mailbox or an `@domain` takes the new semantics in full** — matching moves from a substring test on `To` to a whole-mailbox comparison across all four headers. That is the common shape, not the free-text one, so most existing recipient rules both stop matching some mail (a lookalike address that used to pass as a substring) and start matching more (anything the member was merely Cc'd on, which for a Lark destination means messages appearing in a chat that may have other people in it). Matching is what the routing turns on, so this is the change that warrants saying out loud on deploy. Second, `hasAttachment` narrowed for every rule, so one that used to fire on a signature logo now does not — that was the defect, and leaving old rules on the old reading would mean two answers to the same question. Third, a repeated `To` header is now read whole rather than last-wins.

Only a free-text `to` is frozen, because there is no honest way to reinterpret one. Note also that `update` submits the whole rule through the strict schema, so a rule in either legacy shape cannot be renamed without being rewritten into the current one — and that an edit landing on a key another rule already holds is now reported as a duplicate rather than failing on the constraint. Nothing new can be created in either shape. This departs from DR-8's "flagged in the health API": flagging them `valid: false` would be a lie, since they do match mail. They are simply the last of their kind.

~~**D12 is unchanged and still blocked on O-2**, and the skill text still states the current behaviour exactly: `@domain` matches that domain only.~~ **[superseded 2026-08-02 — O-2 decided, D12 fixed; see below.]** **T8 needed no runtime change** — Wave 0 documented literal substring semantics, and the alternative, rejecting strings that look like patterns, would refuse legitimate subjects such as `Invoice | Acme`. It stays documented rather than enforced.

**Rule identity, carried in from the Wave 5 review.** `mailRuleDedupeKey` was `sha256(JSON.stringify(input))`, so a rule's identity turned on the case of every value it held. Matching is case-insensitive, so asking for the same rule with `otp` instead of `OTP` produced a second active rule watching exactly the same mail, and **every matching message was then forwarded twice**, with nothing in either rule to suggest the other existed. (Key *order* was already stable in practice — `parseMailRule` rebuilds the match in a fixed order — but the key is now derived from a fixed sequence, so it cannot come back.) Case is folded only where the runtime already ignores it: the match clause and a destination email address, never a Lark `chatId`, which is an opaque identifier.

That rewrites the identity of every rule already in the database, which is why the change is not a one-line one: on its first use the create would find nothing and fork the rule in two, causing the duplicate it exists to prevent. `createRuleForMailbox` therefore scans the member's rules on that mailbox, recomputes the canonical key **from what each one stores**, and moves the match onto its canonical key before the upsert. Recomputing the old key from the *request* was tried first and is unsound: the fork being repaired is a difference of case, so the request that exposes it hashes to a third value of its own and matches nothing — precisely the case that caused the damage would have gone unmigrated. Migration is still one rule at a time, as each is asked for again, rather than a bulk rewrite of every row on deploy that would have to be right about all of them at once; a rule nobody asks for again keeps its old key and comes to no harm. The adoption is skipped when a canonical row already exists, because then the two rules genuinely are the fork: the canonical one wins and the other keeps running until someone removes it. **Detecting and merging pairs that already forked is not attempted** — it is a data question, not a code one.

**Instruction layer updated in the same commit**, per DR-9: the seeded skill and `parameterDocs` previously told the model that `to` reads the `To` header only, that `hasAttachment` counts inline images, and that unknown keys are ignored. All three were true when written and all three are now false.

**Wave 7 — Provisioning determinism** *(P1, P2, P3)* — ✅ done.

**P2 needed no work** and the finding was wrong; see the correction above. One provisioning path already runs on deploy and already covers skills *and* permissions — `prestart` → `capabilities:reconcile`, on every container boot. Adding a second explicit deploy step would have duplicated it.

**P1 and P3 have one fix between them, and it is a scoping decision.** `createDepartment` seeds `memberTemplateGrants()` onto the two **system** roles and nothing else, so a department predating `mailAutomations` in the taxonomy is missing exactly those rows and no others. The provisioner now does for existing departments precisely what department creation does for new ones: system roles only. A custom "Intern" or "Contractor" role is deliberate configuration and is no longer written to at all — it was previously granted all five actions on every backend boot, so an admin could narrow one and watch it re-widen at the next deploy.

The literal `existing > 0` guard the plan called for would have been a no-op here, and saying why matters: every role in a pre-taxonomy department already holds rows, just for other tools, so a count across all tools skips every role and the provisioner stops doing the one thing it exists for. The guard is therefore **per-tool** — a role holding any `mailAutomations` row is left alone whether that row allows or denies, because re-asserting `allowed: true` over a deliberate denial is the same defect in a shorter window.

Two smaller repairs ride along. A company with no active administrator is now **skipped and reported** rather than thrown on — with `prestart` in the picture, one such company kept the backend from starting at all. And the run invalidates the permission cache for each department it actually wrote to, so a grant is visible immediately instead of within fifteen minutes; the invalidator is passed in and is best-effort, because a Redis that is not up yet must not be able to stop a boot. A second run writes nothing and invalidates nothing.

**O-1 was decided rather than deferred — `execute` stays `ALL_ROLES`.** The posture note argues from "acts outside the requester's own view", and Mail Ops does not: the composite foreign keys make rule creator ≡ subscription owner ≡ connection owner a database invariant, so a rule can only ever watch the mailbox of the member who asked for it, through that member's own connection. That is what separates it from `larkBase` or `googleAppsScript`, which reach company-wide resources. What the capability *can* do that is worth watching is send a member's own mail outward — to an external address or a shared Lark chat — and that is a governance question (Wave 4, plus the ungoverned-worker gap in §8), not a role question; `ADMIN_ONLY` would not have addressed it, it would only have meant fewer people could reach an ungoverned path. Reversing this is one entry in `TOOL_DEFAULT_PERMISSIONS` plus a permission backfill.

**Wave 8 — Capability** — ✅ done, except multi-destination.

**Exclusions.** `notFrom` and `notSubjectContains`, both narrowing-only: a rule made of exclusions alone is the broadest thing the system can express, and nobody writing "not from noreply@" means "everything else in my inbox". Two contradictions are refused at creation rather than left to be discovered by a rule's silence — an exclusion that covers its own match (`from: @acme.com` with `notFrom: @acme.com`, decidable because both shapes are exact), and a `notSubjectContains` that every string satisfying `subjectContains` contains. The one judgement call: a `From` header nothing can be read out of **fails** the exclusion, so the rule does not fire. That is the same direction the rest of the matcher leans — an unreadable header loses a match rather than inventing one — and the cost is a rule skipping mail from a malformed sender rather than forwarding mail a member explicitly excluded, which is the failure that would matter.

**`activeWindow`.** Days plus `HH:MM`–`HH:MM` in a required IANA timezone. No server-local default, because a window is a claim about the member's day and resolving it against whatever timezone a container booted in is wrong for everyone except by accident. Resolved through `Intl` rather than an offset: an offset is not a timezone, and a rule written in March against a fixed one is an hour wrong from the last Sunday of the month for half the world. Half-open (`09:00`–`18:00` excludes 18:00); an `end` at or before `start` wraps, and **a wrapped window belongs to the day it opened on**, so mail at 01:00 Saturday is inside a Friday 22:00–02:00 window — reading the calendar day would make every overnight window ask for the wrong day at exactly the hours it exists for. Judged on `event.occurredAt`, never on evaluation time, or a backlog drained late turns "only during office hours" into "only when Divo happened to catch up during office hours". Unlike `to`, the window is **not** loosened for stored rules: a timezone this runtime cannot resolve has no honest answer, so it fails to parse and the rule reports itself broken with the reason, which is the mechanism that already exists for exactly this.

**`organize`.** One action carrying `label` / `archive` / `markRead` rather than three action types, because "label it and archive it" is one intent and three rules on one match would triple the delivery rows and the Gmail calls for it. Archiving is removing `INBOX`, which is what archiving is in Gmail. It takes `destination: { type: 'none' }` and a destination on one is refused outright — a stray destination on an `organize` rule means its author believed mail was being sent somewhere, and refusing is the only way that belief gets corrected. No draft staging and no send probe: Gmail's `modify` is idempotent, so a retry repeating it changes nothing. Label IDs are resolved per delivery rather than stored on the rule, because a stored ID outlives the label a member deletes and would then fail forever; resolving by name recreates it. Name matching is case-insensitive, since Gmail refuses to create `receipts` beside `Receipts` and a case-sensitive lookup would try to.

**`rateLimitPerHour`.** *[corrected after review — see below.]* Per rule, distinct from the connection budget above it: that one protects Google from Divo, this one protects whoever is on the other end of the destination. Over the ceiling a message is **dropped and recorded as blocked**, not deferred — deferring holds the flood back for an hour and then releases all of it at once, which is the outcome a ceiling exists to prevent. `blocked` and `abandoned` rows are excluded from the count, or a rule that hit its limit once could never recover: the refusals it then recorded would hold it at the limit forever. Counted from the hour the mail arrived in, for the same reason `activeWindow` is — and **that claim was false when first written**. The window's lower bound came from the event's arrival time but the rows were counted on `firstAttemptAt`, when the delivery was reserved, with no upper bound at all. The two clocks agree only while Divo is keeping up. Drain a backlog after an outage and every row reserved in that pass carries the same `firstAttemptAt` of now, so a hundred messages that arrived at a genuine seventeen an hour all fall inside one window and everything past the ceiling is dropped permanently. An outage would have turned a rate limit into mail loss. The count now filters on the delivery's *event* `occurredAt`, bounded at both ends. `organize` has no ceiling, because filing a member's own mail floods nobody.

**Dry run**, the largest single usability win and the one that changes how the other four get used. `POST /rules/:id/test` and a `test` tool operation, sharing one pure function. It reads through the read repository so it cannot touch a lease, a cursor, or a status even by accident; it is gated on `read`, not `update`, so the member who most needs to check a rule — one whose edit rights were just withdrawn — is not the one who cannot; it parses through the same matcher the worker uses, so a rule the runtime refuses to run cannot report a clean dry run; and hits older than `activatedAt` are counted **separately**, because the runtime skips them and folding them in would promise a backfill that will never happen. An empty result on a fresh mailbox says so in those words rather than letting silence read as "this rule matches nothing".

**Identity.** The new fields join `mailRuleDedupeKey`, which re-keys every stored rule — carried by the lazy adoption Wave 6 added, which recomputes from what each row holds and therefore covers this migration without further work. A window with its days out of order, or spelled as all seven rather than omitted, is one rule and not two. `rateLimitPerHour` is deliberately **outside** the identity: two rules alike but for their ceiling are one rule with two opinions about how fast it may go, and treating them as two would leave both running and forward everything twice. The consequence is that re-creating a rule with a new ceiling has to apply it, so `createRuleForMailbox` now writes `actionJson` on the upsert's update branch — every other field of the action is in the key, so landing there proves they already agree and the ceiling is the only thing that can differ. Without it the tool reported the new ceiling and the rule kept the old one.

**Multi-destination is deferred to Wave 11, and this is a real decision rather than work left over.** `MailDelivery` is unique on `(ruleId, eventId)`, so it would take a constraint change on a database that has only ever been `db push`ed — the riskiest single change in the wave — and two rules with the same match already express it exactly, since the identity function keeps rules with different destinations distinct. The only thing genuinely lost is managing them as one unit: renaming, pausing, or archiving both together. Worth building when someone asks for that, not before.

**P2 correction applies here too:** provisioning runs on every backend boot, so none of this needs a deploy step of its own beyond the usual `prestart`.

**Raw forwarding, verified 2026-08-02.** A forward is the original message nested whole inside a `multipart/mixed` wrapper: the source's body bytes are concatenated in verbatim and its `Content-Type`, `Content-Transfer-Encoding` and `Content-Language` come with them. Nothing is re-parsed, re-rendered, or re-encoded, so HTML, inline images, attachments and transfer encodings arrive as sent. That was a doc sentence with nothing asserting it — the shape of every other defect here — and it now has direct tests holding the original body to being present **byte for byte**.

Writing them found one real way bytes were mangled. The original's content headers were read with `latin1` (byte-for-byte) and written back as UTF-8, so every byte above `0x7F` became two: a `Content-Type` boundary parameter or a filename holding one non-ASCII byte came out corrupted, and a corrupted boundary takes the whole part with it. The three pieces now carry their own encodings — Divo's intro as UTF-8, the original's headers as the latin1 bytes they arrived as, the body untouched.

**Known ceiling, not fixed:** the source is fetched with `format=raw` and posted as JSON, so a message with large attachments is held in memory twice base64-encoded and can exceed Gmail's non-resumable draft limit. Resumable upload is the fix and belongs with Wave 10.

**Wave 9 — Code quality** *(§3)*

**Wave 10 — Retention and operations** *(now also carries the stalled-backlog repair: persist the Gmail `pageToken` on `MailboxSubscription` so a truncated pass resumes where it stopped instead of failing with `history_backlog_stalled`)* — strip `bodyText` after 30 days, delete events after 90, drop terminal `payloadJson` after 30; operator-triggered reconciliation; metrics.

**Wave 11 — Deferred** — `replyTemplate`, `saveAttachmentToDrive`, selectable watched labels, T9 reciprocal routing guards, and **multi-destination** (moved here from Wave 8; reasoning above).

---

## 6. Schema changes

```prisma
model MailboxSubscription {
  watchFailureCount Int       @default(0)   // W2
  degradedAt        DateTime?               // W2
  watchedLabels     String[]  @default(["INBOX"]) // W11
}

model MailAutomationRule {
  notMatchJson     Json?     // W8 exclusions
  activeWindowJson Json?     // W8
  rateLimitPerHour Int?      @default(60) // W8
  lastFiredAt      DateTime?              // W1
  activatedAt      DateTime  @default(now()) // W5 — D7, the watch floor
}

model MailDelivery {
  providerDraftId String?   // W5 — DR-3
  blockedReason   String?   // W2 — DR-2
  deferredUntil   DateTime? // W8
  // status gains 'blocked' | 'deferred'; 'failed' is removed (never written)
  // `ambiguous` starts being written
}

model MailboxReconciliation {   // W5, new
  id             String   @id @default(uuid())
  companyId      String
  subscriptionId String
  windowStart    DateTime
  messagesSeen   Int
  truncated      Boolean  @default(false)
  triggeredBy    String   // 'stale_cursor' | 'operator' | 'page_cap'
  createdAt      DateTime @default(now())
  @@index([subscriptionId, createdAt])
}
```

**Note:** rev 1 proposed `MailAutomationRule.createdChannel` to fix the `channel:'lark'` resolve. Dropped — per C-A that argument is inert. Remove the literal instead.

`activatedAt` deploy note: the column lands `NOT NULL DEFAULT now()`, so on the deploy every existing rule's watch floor becomes deploy time and any mail already sitting unprocessed behind a stale cursor is skipped once. That is the intended direction — the alternative is backfilling `createdAt`, which is the very value that cannot be trusted for a revived or replaced row — but it means a deploy should not be run while a mailbox is knowingly far behind.

Deployment constraint: `divo_dev` has no `_prisma_migrations` table — schema changes go through `db push` over the SSH tunnel (`pnpm dev:e2e`). An empty untracked `prisma/migrations/20260729_cloud_google_mail_ops_foundation/` directory exists on disk and should be deleted; separately, `ci.yml` now runs `prisma db execute` against a migration SQL file, so the "db push only" rule is no longer strictly true and needs restating.

---

## 7. Test plan

Existing tests stay. Test pure logic precisely; reserve integration tests for what only integration proves.

**New pure-logic:** `extractBody` across multipart/alternative, HTML-only, nested multipart, base64url edges. `hasAttachment` distinguishing a real attachment from an inline signature logo. `splitRawMessage` on CRLF, bare-LF, malformed. `senderMatches` subdomain cases (D12). Exclusion truth table.

**One behaviour test per defect:**

| Defect | Test |
|---|---|
| D1 | Send succeeds, response lost, retry → exactly one send, proven by draft absence |
| D2 | `watch` fails permanently → reconciliation still claims; `degraded` after 3; one notification |
| D3 | History exceeds page cap → cursor advances, no throw, drains over ticks |
| D4 | User removed from a rule's department → that rule blocks, **mailbox keeps syncing**, other rules unaffected |
| D5 | Real composition closure (not a stub) with no `connectionAuthorization` → asserts the card path is reachable |
| D6 | One message 404s → tombstone, cursor advances; a 500 aborts the batch |
| D7 | Stale cursor → `MailboxReconciliation` row with correct window; rate cap defers, never drops |
| D8 | Pause the only rule, resume after simulated history expiry → gap recorded, **no replay of old mail** |
| D9 | Event carrying `X-Divo-Mailops` is skipped |
| D10–D13 | Inline logo; Cc-only recipient; `receipts@mail.stripe.com` vs `@stripe.com`; unknown key rejected not dropped |
| S1 | `chatId` outside the creator's accessible chats is rejected at create |
| S2 | A delivery is subject to the connection's rate ceiling and approval mode |
| S4 | A user without `execute` can still pause their own rule |

---

## 8. Acceptance checklist

- [ ] No instruction claims a capability the runtime lacks — OTP text is gone or the extractor is real.
- [ ] A user can see every rule they own, its health, and its recent deliveries, without an engineer.
- [ ] A rule that stops working notifies its owner exactly once.
- [ ] Killing the Pub/Sub publisher grant degrades to 60-minute polling and reports `degraded`.
- [ ] A stale department blocks one rule and does not stall the mailbox.
- [ ] The Connect Google card is actually sent, and off-Lark users get a real path.
- [ ] A Lark destination outside the creator's accessible chats is rejected in code.
- [ ] Background deliveries are subject to connection governance.
- [ ] A user without `execute` can still stop their own rules.
- [ ] A mailbox with 5,000 unread messages drains without wedging.
- [ ] A lost send response produces exactly one delivered message.
- [ ] Pause-then-resume neither loses mail silently nor replays old mail.
- [ ] `@stripe.com` matches `receipts@mail.stripe.com`, or the skill says precisely why it doesn't.
- [ ] An unsupported match key is rejected, not silently dropped.
- [ ] No code path declines to act without writing a durable, readable reason.
- [ ] Whether mail automation works does not depend on when a department was created or whether an operator ran a script.
- [ ] Body text is not retained indefinitely.
- [ ] The handover doc, this plan, and the code agree.

---

## 9. Corrections owed to the handover doc

Applied as a revamp in place (decision: keep the handover canonical). Root cause of the drift: the handover documents commit `b8eb000dc`; `dev` is 102 commits ahead, three of which touched Mail Ops (`6b9d65751`, `c8f9b9a10`, `e115a9a09`). The companion plan doc was updated for those; the handover was not.

| # | Section | Wrong | Right |
|---|---|---|---|
| H1 | §2 L68, §12.5 L1039-1045, §20 L1663 | "Full MIME/attachment forwarding — not implemented by design" | Implemented. Source fetched `format=raw`, content entity embedded verbatim in a new `multipart/mixed`; HTML, inline CID images and attachments survive. Envelope/auth headers are not reused. |
| H2 | §12.5 L1017-1028 | Forward template ends with an extracted text body | The intro part carries only `From/To/Date/Subject`; the body is a separate MIME part. |
| H3 | §12.3 L993-995 | "backoff starts at 30 seconds, capped at one hour" | 5/10/20/40 seconds across a five-attempt budget. No cap logic exists. |
| H4 | §8 L493, §22 L1739 | `src/application/orchestration/tools/...` | `src/application/tools/families/mail-automations.tool.ts` — the `orchestration` directory no longer exists. |
| H5 | §7.1 L434-436 | Provisioned by `provision-google-workspace-skills.ts` | That script has zero Mail Ops references. Provisioned by `reconcile-capabilities.ts` and at signup by `admin-auth.routes.ts:420`. **Operational trap — see P2.** |
| H6 | §11.3, §20 L1674, §21 item 7 | Legacy invalid rules "skipped but not marked invalid"; next-work item to surface them | Already shipped — `list` returns `valid` / `invalidReason`. Delete item 7. |
| H7 | §8.1 L528-534 | List result shape | Add `valid` and `invalidReason`. |
| H8 | §17.1 | "17 passed" / "3 passed" | Now 19 and 5. Better: cite the command, drop absolute counts. |
| H9 | §19 step 11, §17.3 | Deploy "seeds dynamic agents" | No such step exists in `ci.yml`. Add the `prisma db execute` one-off migration step. |
| H10 | §15.1 | Worker log list | Missing `mail_ops.wake_failed`, `mail_ops.delivery_attempt_started`, `mail_ops.delivery_delivered`. |
| H11 | §2 L63-88 | Deployed `b8eb000dc`; dev at `0ed7c3f48` | Date-stamp it; `dev` is 102 commits ahead. |
| H12 | §12.3 L983-987 | Delivery state machine | `'failed'` is declared and never written. Remove it or mark reserved. |
| H13 | §13.5 | `MailDelivery` fields | `ambiguous` and `firstAttemptAt` are undocumented. |
| H14 | §8.4 | "one eligible user-owned connection" | Define eligible: user-owned **and** same owner **and** access ≠ `read_only` **and** both `gmail.modify` + `gmail.send`. |
| H15 | §20 | "history bounded to ten pages" | It is a hard throw, not a silent truncation — see D3. |
| H16 | §9.2 | "all four Pub/Sub settings" as the readiness checklist | Incomplete — add `DIVO_AUTONOMOUS_WORKERS_ENABLED` (D14). |
| H17 | §9.5, §10.1 | Ack contract and cadence | Omit the push→worker immediate `wake()` added in `c8f9b9a10`. |
| H18 | §7.2 | Router described as instruction markdown only | Routing is also structured `SkillRoute` DB rows seeded by `SYSTEM_SKILL_ROUTE_SEEDS`. |
| H19 | §3.6 | Rule creation is the approval | Add the concrete mechanism: Lark gateway mutations skip the local-approval intent, and the audit record captures `operation` and `ruleId`. |
| H20 | §8.1 | Pause/resume described at rule level only | Pausing the last active rule pauses the whole subscription — see D8. |

Also correct in the companion plan doc: "30–60 minute reconciliation" → 60 minutes (the 30-second figure elsewhere is the *OAuth continuation* reconciler, a different thing — disambiguate); and mark semantic processing in §1/§4 as future, matching the already-unchecked §8.4.

---

## 10. Open decisions

**O-1 — Permission posture for `execute`. — ✅ decided 2026-08-02: leave as-is.** `mailAutomations` matches `scheduledWorkflows` at `ALL_ROLES`, so it is internally consistent. The argument for `ADMIN_ONLY` was that every other capability holding it acts outside the requester's own view — and Mail Ops does not, because the composite foreign keys make rule creator ≡ subscription owner ≡ connection owner a database invariant. The real exposure is outbound delivery, which is a governance gap and not a role one. Full reasoning in Wave 7 above; reversing it is one taxonomy entry plus a backfill.

**O-2 — D12 semantics. — ✅ decided 2026-08-02: a domain covers its subdomains.** `@example.com` now matches `alerts@example.com` and `receipts@mail.example.com` alike. The exact reading was more precise and was the wrong one: nearly every service sends transactional mail from a bounce or delivery subdomain the recipient has no reason to know about, so a member asking for mail from a company — and a model writing the obvious `@company.com` — produced a rule that was created, reported active, and never fired once. A rule that silently matches nothing is the exact failure this subsystem is being cleaned of.

Three consequences, all deliberate:

- **Matching is on label boundaries, never string suffix.** `endsWith` would make `@example.com` match `billing@notexample.com`, handing anyone who registers a lookalike a rule that was never meant for them.
- **A bare registry is now refused** — `@com`, `@co.uk`, `@com.au`. These were previously inert (nobody has a mailbox at a public suffix); with subdomains counted they would match half the internet. The check is a short list rather than a real public-suffix list, because a stale copy of the latter would refuse legitimate domains as confidently as it refuses these.
- **"This domain but not its subdomains" is no longer expressible.** No syntax was added for it, because nobody has asked and the silent dead rule is the failure that was actually happening. `@*.domain` could be added later without disturbing this reading.

The contradiction check for `notFrom` had to move with the matcher: `from: @mail.acme.com` with `notFrom: @acme.com` now cancels out completely, and a check still using the exact reading would have accepted that rule and let it match nothing forever — the failure the check exists to prevent.

**This changes what stored rules match**, in the same class as Wave 6's `to` widening, and for the same reason: two answers to one question is worse than one changed answer. Every existing `@domain` rule starts matching its subdomains, which for most of them is the mail they were written for and never received. Worth saying out loud on deploy.

**Input is now forgiving, separately from all of this.** `from`, `to` and `notFrom` accept `acme.com` without the `@`, `Alerts <alerts@acme.com>` pasted from a mail client, `mailto:` prefixes, `https://acme.com`, a trailing dot, and any capitalisation — every one a mechanical conversion, none a guess. A bare brand word is still refused and is **never** guessed into a domain: `Stripe` → `@stripe.com` is a guess, and the rule it builds is wrong while being reported as right. The refusal names what to write instead, and the skill tells the model to ask or to read a real message rather than retry with something invented.

**O-3 — T1. — ✅ decided 2026-08-02: no extractor, ever. The Wave 0 deletion is permanent.**

Mail Ops forwards the whole message. That is the product, and it is not a limitation being worked around — it is the shape of the thing. What Mail Ops is asked to be good at is *which* mail and *where it goes*: the match clause, the exclusions, the window, the destination, the dry run that tells you whether you got it right. Reading the mail is somebody else's job.

An extractor was never one action type. A code, a link, a tracking number, an amount, a date — each is a different parser, each is wrong in a different way on a sender nobody tested, and each fails **silently**, delivering a confidently wrong fragment in place of a message the member could have read themselves. Multiply that by every service that changes its template without telling anyone. The subsystem's whole defect class is *promising more than the runtime delivers*; an extractor is that class as a feature.

There is also a plainer reason. Forwarding the entire message is not a worse answer to "just send me the OTP" — it is a correct answer with more in it. Nobody was ever harmed by receiving the whole email.

So: **`T1` is closed by deletion and stays closed.** The `otp` routing aliases remain, because routing "forward my OTP emails" to `mail-ops` is right; only the claim about what happens next was wrong, and it is gone. Every surviving mention of OTP in the tree is a code comment, an example subject string, or an explicit denial that extraction exists — verified 2026-08-02.

If semantic reading of mail is ever wanted, it belongs to a different capability with a different name and its own honest description, not to a rule that people rely on to move mail deterministically with no LLM in the path (DR-6).

---

## 11. Out of scope

Non-Gmail providers. Shared, delegated, or Google Group mailboxes. LLM-composed replies or semantic classification in the matching path (DR-6). OR / nested boolean composition — exclusions only. Company-wide rules created by an admin on another user's mailbox.

---

## 12. Source map

Worker [`mail-ops.worker.ts`](../advance-backend/src/application/mail-ops/mail-ops.worker.ts) · Matcher [`mail-rule.matcher.ts`](../advance-backend/src/application/mail-ops/mail-rule.matcher.ts) · Types [`mail-ops.types.ts`](../advance-backend/src/application/mail-ops/mail-ops.types.ts) · Persistence [`mail-ops.repository.ts`](../advance-backend/src/infrastructure/persistence/mail-ops.repository.ts) · Gmail I/O [`gmail-history.client.ts`](../advance-backend/src/infrastructure/google/gmail-history.client.ts) · Push route [`gmail-pubsub.routes.ts`](../advance-backend/src/http/google/gmail-pubsub.routes.ts) · Tool [`mail-automations.tool.ts`](../advance-backend/src/application/tools/families/mail-automations.tool.ts) · Seeded skills [`mail-ops-system-skills.ts`](../advance-backend/src/application/skills/mail-ops-system-skills.ts) · Wiring [`composition.ts:1746-1991`](../advance-backend/src/composition.ts:1746) · Permissions [`permission.service.ts`](../advance-backend/src/application/permissions/permission.service.ts) · Continuation [`google-connection-continuation.ts`](../advance-backend/src/application/connections/google-connection-continuation.ts)

**External**
- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push) — 7-day watch expiry; 1 notification/second/user with excess **dropped**; delivery may be delayed or dropped; fallback polling explicitly required.
- [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync) — history retained "typically at least one week"; 404 on an out-of-range `startHistoryId` mandates a full sync.
- [users.messages reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages) — `messages.send` behaviour underlying DR-3.
