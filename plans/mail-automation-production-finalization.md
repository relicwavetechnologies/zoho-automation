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
| 4 — Security and governance (S1–S5) | ⬜ | — |
| 5–11 | ⬜ | — |

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

**D12 — `@domain` does not match subdomains.** [mail-rule.matcher.ts:108-110](../advance-backend/src/application/mail-ops/mail-rule.matcher.ts:108) `address.endsWith('@stripe.com')` fails for `receipts@mail.stripe.com`. Nearly every transactional sender uses a bounce subdomain. The skill explicitly instructs the model to use `@example.com` for "every sender at a domain," the rule never fires, and `list` reports `valid: true`.
**Fix:** match the registrable domain and all subdomains, or add explicit `@*.domain` syntax. Whichever is chosen, the skill text must say precisely which.

**D13 — Unknown match keys are silently dropped.** The operation object is `.strict()` but `mailRuleMatchSchema` is a plain `z.object`, so Zod strips unrecognized keys. `{"from":"@x.com","cc":"finance@y.com"}` creates a rule matching *only* `from`, reports success, and the narrowing the user asked for is gone. Make the match schema `.strict()`.

**D14 — Two independent readiness flags.** `pubsubReady` gates whether the tool lets you *create*; `DIVO_AUTONOMOUS_WORKERS_ENABLED` gates whether the worker *runs* ([server.ts:177](../advance-backend/src/server.ts:177)) and whether push wakes it ([server.ts:454](../advance-backend/src/server.ts:454)). With Pub/Sub configured and workers off, `create` returns "Mail automation is active" and nothing ever runs. Defaults to `true`, so not currently firing — but the failure is perfectly silent. Unify into one readiness signal the tool can report on.

### Tier 4 — the instruction layer lies

Each of these is a promise in seeded prompt text that the runtime does not keep. They are defects in the product, not in the prose.

**T1 — OTP extraction does not exist.** The string `otp` appears **6 times in the whole `src/` tree, all 6 in instruction text** ([mail-ops-system-skills.ts](../advance-backend/src/application/skills/mail-ops-system-skills.ts) lines 42, 55, 63, 72, 86 and [mail-automations.tool.ts:175](../advance-backend/src/application/tools/families/mail-automations.tool.ts:175)). Zero OTP code. Both delivery paths ship the entire message: `gmail.forward` re-sends the full raw MIME, and `formatLarkDelivery` emits `From / Subject / full bodyText` at up to 20,000 chars. Because the text says OTP handling "does not invoke an LLM," the model reads it as a deterministic extractor and will not push back or offer an alternative. A user asking for "just the OTP in Lark" gets the complete body of every login email posted into a chat that may include other people.
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

**P2 — The deploy does not provision Mail Ops.** The dev deploy runs `pnpm provision:google-workspace-skills`, which contains **zero** Mail Ops references. Only the manual `scripts/reconcile-capabilities.ts` provisions the mail-ops skills and `mailAutomations` permission rows.

**P3 — The Mail Ops provisioner is the only one that rewrites custom roles.** `provisionMailOpsPermissionsForExistingCompanies` grants all five actions to **every** `DepartmentRole` — including hand-configured "Intern" or "Contractor" roles — with none of the `existing > 0` guard that `backfillEmptyRolePermissions` uses precisely to protect deliberate admin configuration. It also never calls `permissions.invalidateDept`, so grants land 0–15 minutes late, and it hard-fails the whole run if any company lacks an active admin.

**Posture note.** `mailAutomations` matches its sibling `scheduledWorkflows` exactly, so `ALL_ROLES` is a deliberate family-level choice, not an oversight. But every *other* capability that acts outside the requester's own view is `ADMIN_ONLY` — `larkBase`, `larkApproval`, `airtableSchema`, `airtableAutomation`, and `googleAppsScript`, the only other `execute` holder. Granting `execute` on a persistent background mail-forwarder to every member of every role is unusually permissive for what it does. **Open decision, see §10.**

---

## 3. Code quality

**Preserve as house style:** total `Result<T,E>` discipline; optimistic concurrency done properly everywhere (claim token → conditional `updateMany` → `count === 1`) with `advanceCursor`'s subtle and correct signal-version fallback; clean layering with `GmailHistoryClient` injectable via `fetch`; composite FKs that make ownership a database invariant (C-B); behaviour-named tests.

**Fix:**

| Issue | Location | Why |
|---|---|---|
| Validation defeated by a cast | [mail-ops.worker.ts:393-438](../advance-backend/src/application/mail-ops/mail-ops.worker.ts:393) | `readDeliveryPayload` type-checks keys in a loop, then `as unknown as` and spreads unvalidated fields through. Replace with Zod. |
| Error classification by substring | [mail-ops.worker.ts:449-455](../advance-backend/src/application/mail-ops/mail-ops.worker.ts:449) | Greps the error *message* for `'scope'`/`'token'`/`'rate'` when `GmailApiError.status` exists. A Google copy change reclassifies everything. |
| Two phantom delivery states | schema + types | `ambiguous` is only ever written `false`; `'failed'` is declared in the status union and **never written by any code path**. Both read as handled cases that do not exist. |
| `errorText` defined twice | worker:457, repository:82 | Different truncation behaviour in each copy. |
| Repository mixes four aggregates | 825 lines | Split along subscription / rule / event / delivery. |
| MIME functions untested | `extractBody`, `hasAttachment`, `buildForwardMime`, `splitRawMessage`, `selectContentHeaders` | Highest-risk pure logic in the module; only one indirect integration test. |
| Magic numbers split across files | worker:16-17, repository:729/790 | Some are exported constants, some inline literals. |
| Mock-shaped tests over dead code | [mail-automations.tool.test.ts:155](../advance-backend/tests/tools/mail-automations.tool.test.ts:155) | See D5. Any test that stubs the seam where the bug lives cannot detect the bug. |

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

*Acceptance:* revoke the Pub/Sub publisher grant in a test project — mail still syncs within 60 minutes, health reports `watch_degraded` after three failures, owner notified once. Move a user out of a rule's department — that rule blocks with a visible row, the mailbox keeps syncing. **Not yet exercised against a live Google project**; covered by unit tests only (279 passing across the mail, permission, Gmail-client, connection and gateway suites after Wave 3).

**Wave 3 — The dead OAuth path** *(D5)* — ✅ done, P0, cross-cutting beyond mail

The context could not live on `RunContext` as rev 1 assumed, because it does not survive the trip: Pi runs in a container and calls tools back through the gateway long after the Lark event is out of scope. It is recorded at ingress instead — `RunOriginStore`, Redis, 30 minutes — keyed by the run ID already carried on the signed runtime lease, and `createBeginGoogleAuthorization` looks it back up. Every read is re-bound to the calling member, so knowing a run ID is not enough to start an authorization in somebody else's conversation. An ask too long to store faithfully is not stored at all: a continuation re-runs it verbatim, and half an instruction is worse than none.

`ToolExecutor.buildRunContext` now carries `runtimeRunId`, taken off the lease rather than the request body.

Off-Lark behaviour is the `SELF_SERVICE_CONNECT_HINT`: when no card can be delivered — no conversation to put one in, or delivery failed — both Google tools name the route that actually exists, **Connected apps** (`/me/connections`), not the "Settings → Integrations" this document invented before checking.

`selection.reason` is no longer collapsed. `mailOpsConnectionUnavailableMessage` gives `none_accessible`, `insufficient_access` and `requested_not_accessible` their own remedies, and `connectionState` travels beside the sentence so callers branch on state rather than prose.

`continuationToolIds` was deleted. It was written on every continuation run and read nowhere, under a comment promising an RBAC intersection no code performed; a continuation resolves permissions per tool call like any other run, so it granted nothing and guarded nothing.

The closure moved out of composition for one reason: the only test covering it stubbed that exact seam, which is how the feature stayed dead and green. It now has tests against the real store, and the two tool tests assert only what the tools are responsible for.

**Not exercised against a live Google project.** No card has been delivered, no intent issued, no continuation run started for real.

**Wave 4 — Security and governance** *(S1, S2, S3, S4, S5)*
Ground `chatId` in code and scope `deliverLark` by tenant. Pass `ConnectionRateLimitService` and `ApprovalGateService` into the worker; make `connectionId` required for `create`. Approval for first-time external destination domains. Drop `execute` from `pause`.

**Wave 5 — Send correctness** *(D1, D6, D7, D8, D9)*

**Wave 6 — Matching fidelity** *(D10, D11, D12, D13, T7, T8)* plus direct MIME unit tests.

**Wave 7 — Provisioning determinism** *(P1, P2, P3)*
One provisioning path that runs on deploy and covers skills *and* permissions. Add the `existing > 0` guard and cache invalidation. Decide the §10 posture question first.

**Wave 8 — Capability** — `label` / `archive` / `markRead`; exclusions (`notFrom`, `notSubjectContains`); `activeWindow`; `rateLimitPerHour`; multi-destination; **dry run** (`POST /rules/:id/test` against stored events — largest single usability win).

**Wave 9 — Code quality** *(§3)*

**Wave 10 — Retention and operations** *(now also carries the stalled-backlog repair: persist the Gmail `pageToken` on `MailboxSubscription` so a truncated pass resumes where it stopped instead of failing with `history_backlog_stalled`)* — strip `bodyText` after 30 days, delete events after 90, drop terminal `payloadJson` after 30; operator-triggered reconciliation; metrics.

**Wave 11 — Deferred** — `replyTemplate`, `saveAttachmentToDrive`, selectable watched labels, T9 reciprocal routing guards.

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

**O-1 — Permission posture for `execute`.** `mailAutomations` matches `scheduledWorkflows` at `ALL_ROLES`, so it is internally consistent. But every other capability that acts outside the requester's own view is `ADMIN_ONLY`, and this one grants persistent background mail-forwarding to every member of every role. Options: leave as-is (consistent with sibling), move both scheduling tools to `ADMIN_ONLY` for `execute` only, or keep the grant and rely on Wave 4 governance. **Needs a product call before Wave 7.**

**O-2 — D12 semantics.** Registrable-domain-plus-subdomains, or explicit `@*.domain` syntax? The first is what users expect; the second is more precise and less surprising. Either way the skill text must state it exactly.

**O-3 — T1.** Build a deterministic OTP extractor as a real action type, or delete every OTP claim. Not shipping the middle state is non-negotiable; which side to land on is a product call.

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
