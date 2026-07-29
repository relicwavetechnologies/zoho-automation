# Cloud Google Connection and Mail Ops — Living Plan

> Source of truth for cloud-initiated Google OAuth, automatic Lark
> continuation, and Gmail-first event automation.
>
> **Status:** Backend implementation, database reconciliation, and local
> OAuth-to-Gmail continuation verification complete; Google Cloud Pub/Sub setup
> and deployed mail-automation verification pending
>
> **Current priority:** Configure Google Cloud Pub/Sub, then verify Gmail
> arrival → deterministic delivery on the dev deployment
>
> **Owner:** Abhishek / Divo engineering
>
> **Last updated:** 2026-07-29

---

## 0. Working protocol

- This file is the source of truth for this workstream.
- Check a todo only after the implementation, focused tests, and stated
  verification gate pass.
- Record changed decisions in the decision log instead of silently rewriting
  history.
- Add adjacent ideas to the deferred backlog; do not expand the active phase.
- Backend identity, connection ownership, credentials, RBAC, policy, audit, and
  provider execution remain authoritative.
- No implementation phase starts with more than eight expected files without
  confirming the scope first.
- This repository applies Prisma schema changes with `prisma db push`; do not
  create Prisma migration folders for this workstream.
- Governed agent skills are provisioned as database `Skill`/`SkillVersion`
  records through the existing capability reconciliation path. Do not add
  standalone Mail Ops or router `.md` files to the codebase.

### Status legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Verified complete
- `[!]` Blocked or requires a decision

---

## 1. Product goal

A member should be able to ask Divo naturally for Google or mail-related work
from Lark without knowing whether their Google account is connected or which
internal capability owns the request.

When Google is not connected:

1. Divo identifies the missing connection.
2. Divo shows a **Connect Google** button in Lark.
3. The current agent run ends while the member completes OAuth.
4. The backend identifies the exact request and Lark conversation that initiated
   OAuth.
5. The backend automatically starts a fresh agent run after OAuth succeeds.
6. The fresh run continues the original request in the same Lark DM or thread.
7. The member does not repeat the request or send a "continue" message.

Mail Ops then adds durable Gmail-triggered work such as:

- When mail from a sender arrives, forward or deliver it to a chosen person.
- Deliver OTP or other matching mail according to a rule the member created.
- Notify a Lark DM or chat when matching mail arrives.
- Summarize or classify new matching mail only when the rule requests semantic
  processing.
- Support additional mail providers later without moving credentials or policy
  into the agent runtime.

---

## 2. Existing foundation

The implementation should extend these paths rather than create a second
authority:

- Desktop Google OAuth already creates encrypted, user-owned Google connections:
  [`desktop-auth.routes.ts`](../advance-backend/src/http/desktop/desktop-auth.routes.ts).
- Google OAuth URL construction, code exchange, refresh, and user-info lookup
  already live in
  [`google-oauth.service.ts`](../advance-backend/src/infrastructure/google/google-oauth.service.ts).
- `IntegrationConnection` already owns encrypted provider tokens, scopes,
  account identity, owner, grants, status, and governance:
  [`schema.prisma`](../advance-backend/prisma/schema.prisma).
- Work bootstrap already returns accessible Google connections and structured
  `connection_required` guidance:
  [`work-bootstrap.service.ts`](../advance-backend/src/application/gateway/work-bootstrap.service.ts).
- The Lark sign-in flow already proves an open-URL card and post-login replay
  shape:
  [`lark-signin.ts`](../advance-backend/src/infrastructure/channels/lark/lark-signin.ts),
  [`lark-auth.routes.ts`](../advance-backend/src/http/lark/lark-auth.routes.ts).
- The scheduler already owns durable time-triggered agent work:
  [`scheduled-workflow.service.ts`](../advance-backend/src/application/scheduling/scheduled-workflow.service.ts).
- The Gmail governed capability already owns immediate search, read, draft,
  send, label, filter, thread, and attachment operations:
  [`google-workspace-mcp-manifest.ts`](../advance-backend/src/application/google/google-workspace-mcp-manifest.ts).
- The Lark router demonstrates a tool-free skill that selects an executable
  child skill:
  [`router.ts`](../advance-backend/src/application/skills/lark-system-skills/router.ts).

### Existing route that is not the Phase 0 foundation

Do not build the Lark flow on
[`http/google/google-auth.routes.ts`](../advance-backend/src/http/google/google-auth.routes.ts).
Its connect route currently reads company and user identity from request headers,
and it accepts a caller-provided `returnTo`. Phase 0 needs backend-resolved Lark
identity, an opaque one-time authorization intent, and a fixed continuation
target.

Hardening or removing the legacy route is a separate cleanup decision.

---

## 3. Confirmed decisions

### 3.1 Google connections are user-owned in Phase 0

- Phase 0 creates `ownerType: user` connections only.
- The authenticated Divo member who started OAuth owns the connection.
- Shared and company-owned mailboxes are deferred.
- Existing grants and connection governance remain the only sharing mechanism.

### 3.2 OAuth requests the same complete Google scope set as Desktop

- Phase 0 does not introduce incremental scope bundles.
- The cloud flow uses the existing Desktop Google Workspace scope set.
- The stored scopes remain explicit and are checked before provider execution.
- Scope expansion or least-privilege reconnection may be revisited later, but
  it is not part of Phase 0.

### 3.3 OAuth completion automatically starts a fresh agent run

The original LLM call is not kept open and no model stream is resurrected.

The first run ends after delivering the connection card. A successful callback
creates or releases one durable continuation job. The continuation worker:

1. Claims the authorization intent exactly once.
2. Re-resolves the member, company, role, department, and current permissions.
3. Revalidates that the completed connection belongs to the same member/company.
4. Reconstructs the original Lark request and exact conversation target.
5. Starts a fresh engine run using the **Flash** model.
6. Marks the continuation complete only after the engine run reaches a terminal
   outcome.

The agent receives the original user request plus trusted internal continuation
metadata such as `resumeReason: google_connected` and the completed
`connectionId`. It does not receive a fabricated user message such as
"connection done, continue."

### 3.4 The authorization intent binds the complete continuation target

Store at least:

- opaque intent ID and one-time nonce;
- provider (`google_workspace`);
- company ID and user ID;
- originating Lark open ID;
- Lark chat ID;
- original Lark message ID;
- root/reply message ID when present;
- chat type and group reply mode;
- original user request;
- requested Google capability or tool IDs when known;
- created, expiry, consumed, connected, continuation-queued, and continuation
  terminal timestamps/statuses;
- completed connection ID;
- stable continuation idempotency key;
- safe failure code and audit correlation identifiers.

Do not trust a company ID, user ID, destination, or arbitrary return URL supplied
by the card or browser callback.

### 3.5 Local and deployed callback targets are separate exact URLs

- Local backend: port `8000`, started with the existing development commands.
- Dev deployment:
  `https://app-dev.103.172.92.187.sslip.io/`.
- Google Cloud must register the exact new local and dev callback paths.
- A localhost callback is valid for a card opened on the same development
  machine. It is not a multi-device callback.
- The dev nginx routes the public `/api/` and `/webhooks/` paths to the deployed
  backend, not to a developer laptop.

### 3.6 No per-message OTP approval

- Creating or updating a mail rule is the member's explicit instruction.
- Once enabled, matching messages execute the configured action automatically.
- Do not add per-message HITL or approval to OTP forwarding.
- Existing backend connection ownership, RBAC, destination validation, audit,
  retry, and idempotency still apply.
- Deterministic forwarding does not call an LLM.

### 3.7 One trigger owner per automation

| Request | Owner |
|---|---|
| Read, search, draft, send, or organize mail now | Existing `googleGmail` capability |
| Run Gmail work at a time or recurrence | Existing Scheduler |
| React when matching mail arrives | Mail Ops |
| Reserve time, invite attendees, or create a meeting | Calendar |

Examples:

- "Read my latest mail from X" → Gmail.
- "Every morning at 9 summarize yesterday's inbox" → Scheduler using Gmail.
- "Whenever mail from X arrives send it to Y" → Mail Ops.
- "Collect matching mail as it arrives and send one digest at 9" → Mail Ops
  owns ingestion; Scheduler owns the timed digest release.

Mail Ops must not create a `ScheduledWorkflow` per mail rule.

### 3.8 Gmail Pub/Sub is the primary trigger

- Phase 1 registers `users.watch` once per active connected mailbox and renews
  the watch daily.
- Gmail publishes a mailbox-change signal to Divo's Pub/Sub topic; the
  authenticated push webhook decodes `emailAddress` and `historyId`, durably
  enqueues that mailbox, and acknowledges quickly.
- Pub/Sub does not contain the email. The sync worker uses the persisted Gmail
  history cursor and `history.list` to discover actual messages.
- One mailbox sync discovers events; all enabled rules for that mailbox evaluate
  those events.
- A successful sync advances the cursor only after new events are durably
  recorded.
- Duplicate syncs, events, and deliveries are idempotent.
- A stale/invalid history cursor triggers bounded reconciliation instead of
  silently skipping mail.
- A 30–60 minute reconciliation scan remains only as a safety net for delayed
  or dropped notifications; there is no five-minute steady polling loop.

### 3.9 Pub/Sub requires one-time backend setup, not extra user consent

Gmail `users.watch` uses an existing Gmail read/modify/metadata OAuth scope; it
does not add a separate end-user Pub/Sub OAuth consent.

Phase 1 requires the one-time Google Cloud setup below before real push delivery
can be verified.

Pub/Sub requires backend Google Cloud setup:

- enable the Pub/Sub API once for Divo's Google Cloud project;
- a topic in the same Google developer project used for the watch request;
- publish permission for `gmail-api-push@system.gserviceaccount.com`;
- a push or pull subscription;
- authenticated push verification when push delivery is used;
- persisted `historyId` and watch expiration;
- watch renewal at least every seven days (daily is the intended cadence);
- periodic reconciliation because Gmail notifications may be delayed or
  dropped.

Official references:

- [Configure Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [`users.watch` reference and accepted OAuth scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch)
- [Synchronize Gmail clients with history IDs](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Pub/Sub push subscriptions](https://docs.cloud.google.com/pubsub/docs/push)
- [Authenticate Pub/Sub push requests](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

---

## 4. Target architecture

```text
Lark request
  → authenticated Divo engine run
  → work/skill routing
  ├─ immediate Gmail work → googleGmail
  ├─ time-triggered work → scheduledWorkflows
  └─ mail-event rule → mailAutomations
       ├─ missing Google connection
       │    → authorization intent + Connect Google card
       │    → current run ends
       │    → OAuth callback
       │    → durable continuation job
       │    → fresh Flash engine run in the same Lark conversation
       └─ connected
            → create/update/list/pause/resume/delete rule

Gmail Pub/Sub trigger (Phase 1)
  → authenticated push webhook
  → decode emailAddress + historyId
  → coalesce/enqueue mailbox sync
  → serialize/claim mailbox sync
  → Gmail history client
  → durable MailEvent
  → deterministic rule matcher
  → optional semantic processor only when requested
  → delivery outbox
  → Lark/email delivery adapter

30–60 minute reconciliation trigger
  → same mailbox sync pipeline (safety net only)
```

### Proposed ownership boundaries

| Component | Responsibility |
|---|---|
| Connection authorization | Issue and complete provider OAuth intents; never execute mail rules |
| Existing `IntegrationConnection` | Credential, account, ownership, grants, status, scopes |
| Mailbox subscription/checkpoint | One provider mailbox cursor, health, and next sync |
| Mail rule | Deterministic match and configured action/destination |
| Mail event | Deduplicated provider message/change discovered from a mailbox |
| Mail delivery/outbox | Retryable, idempotent external delivery |
| Scheduler | Time-triggered agent work only |
| Gmail capability | Immediate user-requested Gmail operations |
| Agent/skills | Intent routing and rule authoring; never token storage or runtime enforcement |

---

## 5. Agent and skill design

### 5.1 Work Trigger Router

Add or extend one tool-free router that distinguishes:

- immediate provider action;
- time-triggered Divo work;
- provider-event-triggered automation;
- calendar scheduling.

The router contains positive examples, anti-examples, and the exact child skill
slug. It contains no provider schemas and grants no tool.

### 5.2 Existing Google Gmail skill

Continue to use the existing Google Gmail skill for immediate search, reading,
drafting, sending, organization, filters, threads, and attachments.

Do not put durable watcher state or rule CRUD into the existing Gmail native
operation contract.

### 5.3 Mail Automation skill

Add one governed Mail Automation skill for:

- create a rule;
- list rules;
- pause/resume;
- update;
- archive.

`list` returns the complete owned rule summaries needed for inspection and
subsequent mutation. Preview/test and multi-destination rules are deferred.

The skill declares one exact backend tool such as `mailAutomations`. It should
explain the Scheduler boundary and require an exact connection and destination.

Do not split connection checking into a separate prose skill. Missing connection
must be a structured gateway remediation that can produce the OAuth card.

---

## 6. Phase 0 — Cloud Google connection and continuation

### 6.1 Contract and persistence

- [x] Confirm the expected file list and direct `prisma db push` before editing.
- [x] Define the authorization-intent state machine.
- [x] Define exact idempotency semantics for callback replay and continuation
  replay.
- [x] Add durable authorization-intent persistence.
- [x] Store normalized continuation context without OAuth tokens or provider
  secrets.
- [x] Add expiry and terminal failure states.
- [ ] Add audit events for issued, denied, expired, connected, continuation
  queued, continuation started, and continuation terminal.

### 6.2 Authorization issuance

- [x] Add a backend-authenticated provider-neutral authorization issuance
  service, initially supporting Google.
- [x] Resolve company/user/Lark identity from trusted run context.
- [x] Enforce user-owned connection creation.
- [x] Use the existing full Desktop Google scope set.
- [x] Generate an opaque one-time state.
- [x] Return Lark-card-safe open-URL metadata; never return a member token or
  provider credential.
- [x] Show a plain-link fallback when card delivery fails.
- [x] End the current agent run after the card is delivered.

### 6.3 Callback and connection completion

- [x] Add exact local and dev callback routes.
- [x] Validate state, expiry, provider, user/company binding, and single use.
- [x] Exchange the code and fetch Google identity through the existing OAuth
  service.
- [x] Upsert the existing user-owned `IntegrationConnection`.
- [x] Verify the connection has the expected stored scopes and usable refresh
  credential.
- [x] Mark the authorization intent connected atomically with the exact
  connection ID.
- [x] Return a safe browser success/failure page without raw internal errors.

### 6.4 Automatic continuation

- [x] Enqueue exactly one continuation job after successful connection.
- [x] Return the browser callback response without waiting for the agent run.
- [x] Re-resolve current member identity, department, role, connection access,
  and permissions inside the worker.
- [x] Reconstruct the original `IncomingMessage`, `RunContext`, and
  `ConversationHandle`.
- [x] Preserve DM versus group-thread delivery semantics.
- [x] Request the Flash model explicitly for the continuation run.
- [x] Include trusted continuation metadata without fabricating a user message.
- [x] Persist continuation run ID and terminal outcome.
- [x] Make duplicate callbacks and worker retries incapable of starting a
  second continuation.

### 6.5 Focused tests

- [ ] Missing/invalid initiating identity cannot obtain a URL.
- [x] The returned card/URL contains no bearer token or trusted identity fields.
- [x] Expired, mismatched, cross-tenant, and replayed state fail without saving
  a connection.
- [x] Successful callback saves one encrypted user-owned connection.
- [x] Duplicate callback produces one connection and one continuation.
- [x] Continuation rechecks current membership and permissions.
- [x] DM continuation returns to the originating DM.
- [x] Group continuation returns to the exact originating thread/reply mode.
- [x] OAuth denial/failure does not start the continuation.
- [x] Callback success is not blocked on engine execution.

### 6.6 Phase 0 live verification

Local startup:

```bash
cd advance-backend
pnpm dev:e2e
pnpm dev
```

Harness defaults:

- User selector: `abhishek@emiactech.com`
- Delivery: `oc_4da3c8e6a6a2b9eb29a2aea24fd17e50`
- Model: Flash
- Persisted lifecycle trace: `/tmp/divo-harness-latest.jsonl`

Representative command:

```bash
pnpm tsx scripts/run-engine-harness.ts \
  --model flash \
  --fresh-context \
  --full-debug \
  --oauth-e2e \
  "Find my latest email from the selected sender and summarize it."
```

- [x] Use a user-owned test account with no accessible Google connection.
- [x] Verify the first run emits the connection-required path and Lark card.
- [x] Click the card on the same local development machine.
- [x] Complete OAuth through the registered localhost callback.
- [x] Verify no user follow-up message is sent.
- [x] Verify one fresh Flash run starts automatically.
- [x] Verify the resumed run selects the newly connected account and completes
  the original request.
- [x] Inspect the persisted lifecycle and tool events.
- [ ] Repeat the callback URL and verify no second run starts.
- [ ] Repeat the scenario against the dev callback domain.

Local E2E status on 2026-07-29:

- [x] Harness `--oauth-e2e` mode seeds a real Lark DM request, binds its message
  ID into the authorization context, and monitors the durable intent and fresh
  continuation lifecycle without holding the original model call open.
- [x] The test temporarily revoked only the target and three unrelated
  user-owned Google connections. OAuth reactivated the existing
  `abhishek@emiactech.com` connection without creating a duplicate; the three
  unrelated connections were restored after the run.
- [x] The first local Flash run loaded the Google router and Gmail specialist,
  invoked the governed Google tool, persisted one authorization intent, sent
  the real Connect Google card, and stopped.
- [x] The localhost callback moved the intent through
  `exchanging → connected`, then automatically moved its durable continuation
  through `pending → running → completed`; no manual agent start or user
  follow-up message occurred.
- [x] The fresh continuation re-resolved current work/RBAC, used the backend-
  bound `googleGmail` continuation capability, searched the inbox, fetched the
  newest message body, and delivered its summary to the originating Lark DM.
- [x] Persisted evidence: intent
  `e31a2b28-1611-4183-af98-3d958c6318df`, run
  `41c1cf97-dec5-43d1-91b9-f1f48223f834`, Flash model, two successful governed
  Gmail calls, and terminal `connected/completed` state.
- [x] Google Cloud OAuth client configuration includes the exact local callback
  `http://localhost:8000/api/google/connection/callback`.

### Phase 0 exit gate

- [x] A member with no Google connection can ask for Gmail work in Lark,
  connect through the card, and receive the completed original request in the
  same conversation without typing again.
- [ ] Callback and continuation retries are exactly-once from the user's
  perspective.
- [x] No Google token or member session leaves the backend.
- [x] Focused tests and one real Lark DM run pass on Flash.

---

## 7. Phase 1 — Mailbox history ingestion

### 7.1 Persistence and contracts

- [x] Confirm the persistence scope and direct `prisma db push` before editing.
- [ ] Define a provider-neutral mailbox sync port.
- [x] Add one mailbox subscription/checkpoint record per Google connection.
- [x] Add durable, deduplicated mail event records.
- [x] Define provider message, thread, history, and mailbox dedupe keys.
- [x] Define cursor initialization and bounded stale-cursor reconciliation.

### 7.2 Pub/Sub watch and notification ingress

- [x] Register `users.watch` when a mailbox becomes active.
- [x] Renew active watches daily and persist watch expiration.
- [x] Authenticate the Pub/Sub push JWT and expected audience/service account.
- [x] Validate the exact Pub/Sub subscription and decode notification data.
- [x] Coalesce duplicate signals and enqueue the mailbox sync durably.
- [x] Acknowledge only after durable queue admission.
- [x] Claim each signalled mailbox once across backend instances.
- [x] Obtain a valid Google access token through existing backend connection
  resolution.
- [x] Call the backend-owned Gmail history client from the stored cursor.
- [x] Record discovered events before advancing the cursor.
- [x] Advance the cursor only after durable event and delivery reservations.
- [ ] Back off on provider/rate-limit failures.
- [x] Persist revoked, missing-scope, refresh, watch, and sync failure codes as
  mailbox health.
- [ ] Add metrics for due, claimed, synced, failed, stale cursor, event count,
  and sync latency.
- [x] Run a 60-minute reconciliation scan only as a missed-notification
  safety net.

### 7.3 Ingestion tests

- [ ] No-change sync advances safely without creating events.
- [ ] Multiple changes create the exact expected events.
- [x] Duplicate and overlapping history pages do not duplicate events.
- [x] Concurrent workers cannot process one mailbox simultaneously.
- [x] A crash before cursor advancement is safe to retry.
- [x] A stale history cursor executes bounded reconciliation.
- [ ] Revoked/missing-scope connections stop cleanly and request reconnection.

### Phase 1 exit gate

- [ ] A Pub/Sub notification produces one durable `MailEvent` promptly without
  invoking an LLM.
- [ ] Duplicate notifications, reconciliations, and worker retries do not
  duplicate events.
- [ ] Mailbox health and cursor state are observable.

---

## 8. Phase 2 — Mail rules, routing, and delivery

### 8.1 Rule model

- [x] Define deterministic V1 match fields.
- [x] Bind every rule to an exact accessible user-owned connection/mailbox.
- [x] Store creator, company, department context, version, enabled state, and
  destination.
- [x] Define create/update/pause/resume/archive transitions.
- [x] Prevent free-form executable prompts from becoming rule authority.
- [x] Revalidate current RBAC, user-owned connection access, Gmail scopes, and
  provider destination eligibility immediately before each delivery; terminally
  abandon work whose authority was revoked.

### 8.2 Tool and skill

- [x] Add one canonical `mailAutomations` capability and tool contract.
- [x] Add RBAC actions for read/create/update/delete/execute as required.
- [x] Add the database-seeded Mail Automation governed skill.
- [x] Add database-seeded Work Trigger Router routes and anti-routes.
- [x] Add structured missing-connection remediation through Phase 0.
- [x] Add tests proving immediate Gmail, Scheduler, Calendar, and Mail Ops route
  to different owners.

### 8.3 Delivery and idempotency

- [x] Add an outbox/delivery record uniquely keyed by rule and source event;
  rule updates do not replay already observed messages.
- [x] Reuse existing Lark delivery adapters where their identity boundary
  matches.
- [x] Implement the agreed V1 destination types.
- [x] Do not call an LLM for deterministic forwarding or OTP delivery.
- [x] Retry provider failures without duplicating successful delivery.
- [x] Record safe delivery metadata and exclude OAuth tokens and raw secrets
  from logs.

### 8.4 Optional semantic processing

- [ ] Run semantic processing only after a new durable event matches a rule that
  explicitly requests summary/classification/extraction.
- [ ] Pass only the bounded content required by that rule.
- [ ] Keep connection selection, rule matching, destination, and authorization
  deterministic and backend-owned.
- [ ] Record model and run correlation without storing credentials.

### Phase 2 exit gate

- [ ] A member can create, inspect, pause, resume, update, and remove a mail rule
  through Lark.
- [ ] A matching message automatically reaches the configured destination once.
- [x] OTP forwarding does not request per-message approval.
- [x] A non-matching message produces no action and no LLM call.

### 8.5 Current implementation verification

- [x] `mailAutomations` RegisteredTool exists in the live database.
- [x] `google-workspace-router`, `mail-ops`, and `schedule-divo-work` are active
  database-seeded skills for the current company.
- [x] The direct schema push completed without creating a migration.
- [x] Before adding the nullable unique rule dedupe key, the live
  `MailAutomationRule` row count was verified as zero.
- [x] After the push, the live table still has zero rows, the nullable
  `dedupeKey` column exists, and `MailAutomationRule_dedupeKey_key` exists.
- [x] Final focused validation: 80 tests passed, 0 failed.
- [x] Whole-project `pnpm typecheck` passed.
- [x] Final `$cold-review` found no P0/P1 code issue. Its one P2 documentation
  finding (stale validation/review wording) was corrected here.

---

## 9. Pub/Sub infrastructure and production rollout

### 9.1 Cloud setup

These are one-time platform/operator tasks in Divo's Google Cloud project. They
are not permissions requested from every member during Google OAuth.

- [ ] Identify the Google Cloud project ID used by the OAuth/watch request.
- [ ] Enable Pub/Sub API.
- [ ] Create the Gmail mailbox topic.
- [ ] Grant publisher access to
  `gmail-api-push@system.gserviceaccount.com`.
- [ ] Create the selected push or pull subscription.
- [ ] Document local credentials and deployment configuration without committing
  secrets.

### 9.2 Watch lifecycle (implemented in Phase 1)

- [x] Call `users.watch` for each enabled mailbox subscription.
- [x] Persist returned history ID and expiration.
- [x] Renew active watches daily.
- [ ] Stop watches when subscriptions are disabled or connections are revoked.
- [x] Reconcile mailboxes every 60 minutes even when no notification arrives.

### 9.3 Notification ingress (implemented in Phase 1)

- [x] Validate Pub/Sub authentication and expected audience/service account for
  push delivery.
- [x] Validate the expected project/subscription.
- [x] Decode mailbox/history notifications.
- [x] Acknowledge quickly after durably enqueueing mailbox sync.
- [x] Coalesce duplicate signals for one mailbox.
- [x] Feed the existing Phase 1 mailbox sync path unchanged.

### 9.4 Rollout

- [ ] Run Pub/Sub and the slow reconciliation safety net together in shadow
  mode.
- [ ] Compare detected event/cursor coverage and latency.
- [ ] Keep periodic reconciliation after Pub/Sub activation.
- [ ] Keep reconciliation slow enough that it is not the normal trigger.
- [ ] Preserve an operator-controlled reconciliation path as rollback.

### Phase 3 exit gate

- [ ] Pub/Sub normally triggers mailbox sync within the agreed latency.
- [ ] Delayed, duplicate, or dropped notifications do not lose or duplicate
  mail actions.
- [ ] Disabling Pub/Sub returns safely to the polling trigger.

---

## 10. Open product decisions

These are intentionally not assumed by the architecture.

- [x] V1 destinations are one email address, the current Lark chat, or one
  exact accessible Lark chat ID grounded through Lark discovery.
- [x] V1 email forwarding sends a bounded plain-text representation with
  original sender/recipient/date/subject headers. It does not retransmit
  attachments or claim to be a full MIME forward.
- [x] V1 deterministic match fields are sender, recipient, subject contains,
  body contains, and attachment presence.
- [x] One rule has exactly one destination in V1.
- [!] Define mail event/body/attachment retention and deletion windows.
- [!] Decide whether rule actions may modify the source mailbox
  (label/archive/mark read) or are delivery-only in V1.
- [!] Define user-visible failure behavior when a connection is revoked after a
  rule is enabled.

---

## 11. Non-goals for the first release

- Shared/company-owned Google mailboxes.
- Per-message OTP approval.
- A `ScheduledWorkflow` per mail rule.
- Asking an LLM to poll or decide whether a deterministic sender rule matches.
- Giving Pi, Lark, Jan, or the agent a Google token.
- Replacing the existing immediate Gmail capability.
- Moving RBAC, destination authorization, or connection selection into skills.
- Supporting non-Gmail providers before the Gmail rule pipeline is verified.
- Depending on Gmail native global forwarding settings as the Mail Ops
  foundation.

---

## 12. Decision log

### 2026-07-29 — Fresh backend continuation after OAuth

The initiating agent run stops after showing the OAuth card. The callback queues
one fresh Flash engine run bound to the original Lark conversation and request.
The user does not send another message.

### 2026-07-29 — User-owned connections and Desktop-equivalent scopes

Phase 0 creates user-owned Google connections and requests the same complete
Google scope set as the existing Desktop flow.

### 2026-07-29 — Local and dev verification targets

Local work uses `pnpm dev:e2e`, then `pnpm dev`, then the real engine harness.
The default live destination is Abhishek's Divo Lark DM. The dev public origin is
`https://app-dev.103.172.92.187.sslip.io/`.

### 2026-07-29 — OTP rules execute without per-message approval

The member's explicit rule creation is sufficient to enable automatic matching
and delivery. Per-message HITL is not part of Mail Ops.

### 2026-07-29 — Pub/Sub first, slow reconciliation fallback

Gmail Pub/Sub is the primary trigger from Phase 1. Divo registers and renews
`users.watch`, durably admits authenticated push notifications, and then uses
`history.list` to discover actual messages. A 30–60 minute reconciliation scan
remains only as protection against delayed or dropped notifications.

### 2026-07-29 — One complete Pub/Sub readiness state

Topic, subscription, push audience, and push service-account email are parsed
as one complete configuration. The webhook, watch renewal worker, and new-rule
activation are all disabled when any one value is absent. Partial configuration
must never silently turn the 60-minute reconciliation safety net into the
primary trigger.

### 2026-07-29 — Delivery-time authority recheck

Every durable delivery rechecks the creator's current company/department RBAC,
the exact user-owned Google connection, required Gmail scopes, and destination
provider access immediately before sending. Revoked work is terminally
abandoned and is not retried or delivered.

### 2026-07-29 — V1 deterministic delivery boundary

V1 supports sender, recipient, subject-text, body-text, and attachment-presence
matching with exactly one email or Lark-chat destination. Email forwarding is a
bounded plain-text representation and does not retransmit attachments. Semantic
summary/classification/extraction remains a separately governed future action;
the current deterministic path never invokes an LLM.

### 2026-07-29 — Company-wide Mail Ops capability

`mailAutomations` is available to every existing department role in each
company for all five capability actions. Reconciliation inserts only missing
permission rows and preserves existing explicit permission records.
