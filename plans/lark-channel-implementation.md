# Divo Lark Channel — Production Implementation Plan

> Tracking document for the Lark channel hardening project.
>
> Status: **Waves 2, 2B, and 3A complete and verified against the development database — distributed leases, batching, busy UX, and retry classification still pending**
>
> Last updated: 2026-07-25

## 0. Current Implementation Status

This is the source-of-truth ledger for the code that exists today. The later wave
sections remain the detailed implementation checklist.

### Completed in code

- Exact stable bot-ID admission for groups, separate DM admission, and deterministic bot/self rejection.
- Canonical tenant, chat, message, parent, root/thread, requester, room, lane, and delivery identities.
- Structured human mentions with exact Lark IDs; mentions never transfer requester authority.
- Tenant-scoped Lark member resolution and first-touch persistence, including active tenant-binding checks.
- Tenant-scoped `ChannelIdentity` uniqueness. The development database schema was pushed on 2026-07-25 after confirming there were no conflicting duplicate rows, and the deployment migration is checked in.
- Direct-parent hydration with bounded text/media handling and typed unavailable states for deleted, invisible, forbidden, unsupported, cross-chat, and transient failures.
- Backend-hosted Lark and Zoho connection auto-selection when there is one accessible connection, with safe choices when several exist.
- Initial cancellation propagation, correlation fields, queue-name consistency, and ingress/delivery latency telemetry.
- Lark approval, knowledge-share, and interrupt card callbacks authenticate the
  tenant-scoped actor before applying any control action.
- Interrupt requests are limited to the run owner or a same-company company/super
  admin, and the UI distinguishes a cancellation request from observed completion.
- Status cards, final cards, continuation cards, and text fallbacks remain attached
  to the new triggering message/thread even when an older parent is hydrated as
  semantic context.
- Verified human events are persisted under a tenant-scoped
  `(channel, tenant, message)` receipt and admitted to a stable BullMQ job before
  webhook acknowledgement. Persistence or queue admission failures return `503`
  so Lark can retry.
- The Lark ingress worker claims the persisted payload, records processing,
  completion, and failure lifecycle state, and re-enqueues interrupted
  `accepted`/`processing` receipts on startup and every 30 seconds.
- Duplicate Lark deliveries intentionally repair queue admission with the same
  receipt-backed job ID. A completed receipt cannot be overwritten by a stale
  failure attempt.
- `ChatMessageSerializer` now waits for the exact queued execution when called
  by the durable worker; it remains a process-local ordering aid, not the
  durability boundary.
- Redis is no longer the fail-open idempotency authority for Lark ingress.
- Claiming an ingress receipt is a lease, not a status stamp: a receipt another
  worker is actively processing is only re-claimable once its owner has been
  silent past a staleness threshold. A claim reports `claimed`, `leased`, or
  `terminal` — never a bare null — because a job that completes on a lease it
  did not win closes the only recovery path that receipt had.
- Receipts outside their retry window are dead-lettered rather than retried
  forever, and are excluded from recovery so the oldest poison rows cannot
  starve newer work. Receipts stranded in `processing` by a killed worker are
  retired to `dead` by reconciliation instead of staying invisible.
- AirNote request authentication resolves identity inside a verified Lark
  installation and fails closed when Lark supplies no tenant key. No
  `open_id`-only authentication path remains.
- Lark card-action failures report an error toast instead of reporting success.

### Explicitly not implemented yet

- Retry classification. See the retry-window backstop note below.
- Explicit retry classification remains. Receipts are dead-lettered on a time
  backstop (a retry window measured from acceptance), not by recognising which
  errors are permanent, so a poison payload still consumes its whole window.
- Operator-facing dead-letter tooling remains. `dead` receipts keep their
  payload and last error and are excluded from recovery, but replay is manual
  SQL until the Wave 7B admin view lands.
- Dead-letter and queue metrics, and a process-restart integration fixture,
  remain before production rollout.
- `prisma/migrations/` is not a runnable history, and `divo_dev` confirms it:
  the database has no `_prisma_migrations` table at all, so no migration has
  ever been applied there. `LarkTenantBinding` and `IntegrationConnection` are
  created by no migration, there is no `migration_lock.toml`, and `package.json`
  wires only `migrate dev` and `db push` — never `migrate deploy`. Both new
  migration files were executed individually against the live schema and
  succeed, but their apply *order* is still reasoned about by inspection rather
  than exercised. Closing this is a Wave 7 rollout prerequisite.
- The tenant backfill deliberately skips companies holding more than one active
  Lark binding, because no tenant key is authoritative for their connections.
  Those companies must be resolved through the admin 409 path before their
  legacy connections will resolve. On `divo_dev` the backfill is a verified
  no-op: no company has multiple active bindings, and both Lark connections
  already carry `larkTenantKey`. Its real effect is untested until production,
  where legacy connections predating the field may exist.
- `resolveByLarkOpenId` remains declared but is called by nothing. It should be
  deleted once no caller can plausibly reappear; leaving it invites a future
  unscoped lookup.
- Distributed execution leases and fencing remain in Wave 3. The current
  serializer preserves in-process lane order after durable recovery but does
  not coordinate multiple backend replicas.
- Room-level ambient context and per-turn shared-thread authority hardening begin in Wave 4.
- Persisted idempotent outbound delivery begins in Wave 5.
- Lark media staging, OCR, personal-only indexing, retention, and cleanup begin in Wave 6.

### Validation and review ledger

| Slice | Validation | Cold review |
|---|---|---|
| Canonical referenced messages | 14 focused tests + typecheck passed | Round 2: ship, no findings |
| Tenant-scoped Lark identity | 130 focused tests + typecheck + Prisma validation passed after the active-binding, OAuth callback, migration, and approval-resume corrections | Three review rounds completed and all verified Lark findings fixed; final Lark-only review is in progress |
| Wave 1 identity schema | `prisma db push --accept-data-loss` completed; tenant-scoped unique index verified | No conflicting duplicate identity rows were present before that push |
| Wave 2/2B schema on `divo_dev` | Pushed 2026-07-26 over the SSH tunnel. `IngressIdempotencyKey` had only `id, channel, messageId, createdAt` and 0 rows beforehand, so the tenant-scoped unique index carried no duplicate risk. `prisma migrate diff --from-url` now reports zero drift, and both new migration files execute cleanly against the live schema | 15/15 live round-trip checks passed against real Postgres: tenant-scoped dedupe, duplicate delivery returning the same receipt, claimed/leased/terminal outcomes, stale-lease re-claim, retry-window recovery and retirement filters, dead-lettering, and refusal to resurrect a `dead` row |
| Approval and share cards | 108 focused tests + typecheck passed | Fresh review: ship, no findings |
| Run interruption | 53 focused tests + orchestration tests + typecheck passed | Two fresh reviews; final verdict: ship, no findings |
| Trigger/thread delivery | 53 focused tests + typecheck passed | Fresh review: ship, no findings |
| Durable ingress acceptance | Prisma validation + 16 focused repository/webhook/scenario tests + typecheck passed | Initial review found two fixed error-boundary/harness gaps; final review found the expected Wave 2B blocker: accepted receipts still need durable recovery before deployment |
| Durable ingress recovery | 28 focused receipt/queue/worker/webhook/restart-scenario tests passed; Prisma validation passed; full typecheck is temporarily blocked by unrelated in-progress Airtable mappings | Two fresh reviews found and verified the retained-failed-job recovery gap; failed receipts now reach reconciliation and retained failed jobs are explicitly retried. Final review: ship, no findings |
| Wave 3A process-local lanes | 25 focused routing/webhook/scenario/serializer tests + full typecheck passed | Review found lane telemetry reporting the company-scoped key while the serializer ordered on the ingress key; corrected so `laneKey` is the key actually used and the contract key is recorded separately as `companyLaneKey` |
| Wave 2B ingress leases and dead-lettering | 170 focused ingress/lark/identity/AirNote/serializer tests + full typecheck + `prisma validate` passed | Two cold-review rounds. Round 1 found five issues, all corrected: the backfill migration sorted before the migration creating the table it altered; an attempt-counted dead-letter budget a 3-minute outage would exhaust; a stale AirNote test left failing by the tenant-scoped auth change; an index name not matching Prisma's derived name; and a widened repository assertion. Round 2 found the lease's own regression — a claim that returned "not yours" for both *finished* and *leased* let the queue complete a job whose work never ran, so a worker restart dropped the message permanently — plus retirement racing a live lease, a retryable failure able to resurrect a `dead` row, a backfill that guessed when a company held two active bindings, and a missed `updatedAt` default. All corrected. Migration apply order and the backfill itself remain unverified — no database was reachable |

### Immediate next step

Wave 3A's process-local lane activation is complete: the serializer now orders on
a canonical lane rather than the chat, so unrelated group requesters run
concurrently while a thread, a DM, and a single requester each stay FIFO. Lane
selection is synchronous and carries no authority — identity and RBAC are still
resolved inside execution, immediately before `engine.run()`.

What Wave 3 still owes before this is safe on more than one replica:

- Distributed lane leases with owner, heartbeat, expiry, and fencing token
  (Phase 3A). Today's ordering is process-local; two replicas would each run
  their own lane for the same thread.
- Initial-burst batching (Phase 3B). No compatible-message debouncing exists.
- Busy-turn UX (Phase 3C): first busy acknowledgement, queue position, cancel.
- Global lane concurrency is currently unbounded by default. Group top-level
  lanes are now per-requester, so a busy group can open many parallel runs until
  `maxConcurrent` is set deliberately.

The development schema push is done. `divo_dev` is reachable over the SSH
tunnel (`pnpm dev:e2e`, or `bash scripts/db-tunnel.sh start` for the tunnel
alone), the Wave 2/2B schema is applied, drift is zero, and the receipt
lifecycle has been exercised end to end against real Postgres.

Still outstanding on the reliability track:

- The real Redis/Postgres process-restart smoke test. The live checks covered
  the repository's lease and dead-letter semantics directly; they did not kill
  a worker mid-run and prove the successor picks the receipt up. This is the
  last thing gating the Wave 2 exit gate.
- Retry classification, so a known-permanent failure terminates before its
  window elapses rather than after.
- Queue depth, age, attempts, stalled-job, and dead-letter metrics.

**Deployment shape, and what it means for Wave 3.** `docker-compose.yml`
defines a single `advance-backend` service with no `replicas` key, so Divo runs
one backend process today. The process-local serializer is therefore sufficient
for correct ordering right now, and Wave 3A's distributed leases and fencing
tokens are pre-work for horizontal scale rather than a current correctness gap.
They must land before a second replica is ever started — the failure they
prevent (two replicas each running their own lane for one thread, both
publishing a final reply) is silent and user-visible. Until then the honest
statement is that ordering is correct for the deployment we actually run.

## 1. Decision and Confidence

**Decision:** Keep Divo's backend-owned identity, RBAC, approvals, integrations, and audit model. Adapt Hermes's channel-runtime patterns for admission, session routing, batching, busy runs, retries, and reconnect behavior without porting Hermes's local runtime architecture.

**Verdict:** Proceed wave-by-wave — **confidence: 91%**.

The direction is strong because it preserves Divo's enterprise authority while correcting the channel-runtime weaknesses already visible in the current code. The media boundary is now decided: Lark processing may use private cloud staging, but raw uploads are not permanent by default and derived knowledge keeps the source ACL.

## 2. Non-Negotiable Product Contract

### 2.1 Invocation

- In a Lark group, Divo responds **only when the Divo bot is explicitly mentioned by stable bot ID**.
- `@all`, matching display names, quoted bot text, or mentioning another user must not invoke Divo.
- Every ordinary group follow-up must mention Divo again. Approval-card actions and Divo clarification responses are control events and may resume a waiting run without another mention.
- In a personal DM, each human message may invoke Divo without a mention.
- Bot/self messages are ignored.
- Untagged group messages never start an agent run or invoke tools.

### 2.2 Authority

- The human who triggered the turn is the requester for that turn.
- The worker resolves that person's current company membership, role, department, tool grants, connection grants, rate limits, and approval rules immediately before execution.
- Every gateway/tool call continues to re-authorize backend-side.
- Shared conversation context must never transfer another participant's permissions.
- A later participant in the same thread runs with their own permissions, not the permissions of the person who started the thread.
- Approval actions are accepted only from the intended requester or an authorized approver.

### 2.3 Conversation and Concurrency

Three identifiers have different responsibilities:

```text
Room key
  company + Lark installation/tenant + chat
  Owns bounded room transcript and summary.

Execution lane key
  DM                 = company + tenant + chat
  Group top-level    = company + tenant + chat + requester
  Group thread       = company + tenant + chat + root/thread
  Owns ordering, active-run state, and queued follow-ups.

Delivery target
  chat + triggering message + root/thread
  Owns status and final-response placement.
```

- Different DMs run concurrently.
- Different users making unrelated top-level group requests can run concurrently.
- Requests within one thread are processed in FIFO order.
- Multiple top-level requests from the same user in one group are processed in FIFO order.
- Each queued item preserves its own requester identity.
- Divo defaults to **queue**, not interrupt, for work arriving during an active run.
- Compatible rapid messages may be debounce-batched before a run starts.
- Approval and clarification control events can resume a waiting run without waiting behind ordinary queued work.

### 2.4 Reliability

- A verified Lark event is acknowledged only after durable acceptance.
- Duplicate deliveries do not create duplicate runs, replies, OCR jobs, or indexed files.
- A process restart or worker crash does not lose accepted work.
- A network/provider failure is classified as retryable or terminal.
- Delivery retries use a stable idempotency identity.
- Exhausted work remains inspectable and replayable; it is never silently dropped.
- Cancellation must reach the agent and tool execution before an execution-lane lease is released.

### 2.5 Replies, references, and mentions

A Lark reply has three independent meanings:

```text
Direct parent
  The older message the user explicitly replied to.
  It supplies bounded semantic context.

Root/thread
  The topic that owns conversational ordering and working context.
  It supplies the execution lane.

Triggering message
  The new message that invoked Divo.
  It supplies requester authority and the delivery anchor.
```

- Preserve `messageId`, `parentMessageId`, `rootMessageId`, and `threadId` separately. Never collapse them into one reply field.
- Hydrate at most the direct parent plus the existing bounded thread summary. Do not recursively fetch an unbounded ancestor chain.
- A referenced message carries structured provenance: source message ID, sender IDs, internal identity when resolvable, message type, timestamp, sanitized text excerpt, mentions, attachments, and availability status.
- If an old message is recalled, deleted, invisible, cross-tenant, or inaccessible, give the agent an explicit `unavailable` reference—not an empty string that invites guessing.
- A reference can contribute context but never requester identity, RBAC, connection ownership, or approval authority.
- A final answer is attached to the triggering message/thread, not accidentally sent as a new reply to the older parent.
- Messages with different parents, roots, threads, or attachment references are never debounce-batched.

Mentions are structured identities, not decorated text:

- Identify the Divo bot by stable bot ID; display-name matching is never an admission fallback.
- Preserve every non-bot mention from the event envelope using available `open_id`, `user_id`, and `union_id`, plus display name for presentation.
- Resolve mentioned people against Divo membership using company + Lark installation/tenant + stable Lark ID.
- An unmapped person remains a valid external Lark identity; they do not silently acquire a Divo account, role, or tool permission.
- A mention of a human does not grant access or authorize an action. If the agent later messages, assigns, or shares with that person, the gateway uses the exact stable ID and performs normal backend policy checks.
- Fuzzy name resolution is reserved for plain-language names that were not delivered as structured Lark mentions.

## 3. What We Borrow from Hermes

Evidence sources:

- `research/hermes-agent/plugins/platforms/feishu/adapter.py`
- `research/hermes-agent/gateway/session.py`
- `research/hermes-agent/gateway/run.py`
- `research/hermes-agent/tests/gateway/test_feishu*.py`
- `research/hermes-agent/tests/gateway/test_session_race_guard.py`

Adapt these patterns:

- Verify and deduplicate before agent admission.
- Identify the bot using stable Lark IDs.
- Separate DM, group-user, and group-thread session identities.
- Atomically install active-session state before starting work.
- Batch compatible rapid messages.
- Model busy behavior explicitly: queue, steer, or interrupt.
- Let clarification/approval responses bypass ordinary busy handling.
- Bound every in-memory cache and buffer.
- Retry transient outbound delivery with backoff.
- Persist conversation state independently from ephemeral delivery UI.
- Preserve human mentions as structured prompt hints while stripping only the bot's own mention.
- Fetch and cache the direct referenced message, then keep parent/thread identity in batching compatibility checks.

Do **not** port these Hermes choices:

- Local JSON files as enterprise deduplication authority.
- Process-local inbound buffers as durable queues.
- Environment allowlists or pairing as Divo's RBAC authority.
- Local session configuration as permission policy.
- Dropping queued events after a reconnect timeout.
- Treating `@all` as equivalent to explicitly tagging Divo.
- Copying the Python adapter/runtime into `advance-backend`.

## 4. Baseline Divo Gaps Recorded Before Implementation

Primary paths:

- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts`
- `advance-backend/src/infrastructure/channels/lark/lark.adapter.ts`
- `advance-backend/src/application/orchestration/chat-message-serializer.ts`
- `advance-backend/src/application/chat-context/lark-chat-context.service.ts`
- `advance-backend/src/domain/channel/incoming-message.ts`
- `advance-backend/src/application/channels/channel.adapter.ts`

This list is retained as the original audit baseline. Items already resolved are
marked accordingly; open items are owned by the wave named beside them.

1. **Resolved in code; schema push pending:** The webhook persists and durably
   queues before acknowledgement, and accepted/processing receipts are recovered.
2. **Open — Wave 3:** `ChatMessageSerializer` remains process-local ordering;
   it is no longer the ingress durability boundary. Its own doc comments still
   describe per-chat serialization and must be corrected when Wave 3 replaces it.
3. **Resolved for a single replica:** The serializer orders on canonical lane
   keys instead of the chat ID, so chat-wide routing ambiguity is gone.
   Distributed lane ownership remains in Wave 3.
4. **Resolved for current orchestration path:** Cancellation now reaches the engine and governed tool contexts; individual integration-client cancellation remains incremental.
5. **Resolved:** Parent, root, and thread IDs are distinct canonical fields.
6. **Open — Wave 4:** Runtime conversation context still needs complete thread-aware isolation.
7. **Resolved in code; production fixture pending:** Durable tenant-scoped
   deduplication and stable replay run before acknowledgement.
8. **Resolved:** Admission identifies the bot by stable ID, not display name.
9. **Open — Wave 3:** There is no ingress-level compatible-message batching.
10. **Open — Wave 5:** Persisted delivery idempotency and classified retries do not exist yet.
11. **Partially resolved:** Focused joined admission, routing, reference, and identity tests exist; restart and approval scenarios remain.
12. **Open — Waves 2 and 6:** Attachment jobs still need durable source-derived identities.
13. **Resolved:** Producer and ingestion worker use the configured queue name.
14. **Resolved:** Parent, root, and thread IDs are preserved.
15. **Resolved:** Exact bot-ID mention admission is enforced.
16. **Resolved:** Human mentions are structured identities through orchestration.
17. **Resolved:** Parent hydration returns typed availability states.
18. **Open — Wave 6:** Old-image/media references still need the final persistence and visibility policy implementation.
19. **Open — Wave 6:** Duplicate inline/worker attachment processing must be removed after the replacement path is proven.
20. **Open — Wave 6:** Internal media requires authenticated/private storage delivery.
21. **Open — Wave 6:** Source-retention metadata and cleanup are not implemented.

## 5. Execution Tracker

| Wave | Outcome | Status |
|---|---|---|
| 0 | Lock behavior, baselines, and prerequisite defects | Substantially complete; restart/approval fixtures remain |
| 1 | Canonical Lark event, mention, identity, and routing model | Complete |
| 2 | Durable ingress and idempotent acceptance | Code and cold review complete; schema push blocked by offline DB tunnel |
| 3 | Distributed execution lanes, batching, and busy behavior | 3A process-local lanes complete; distributed leases/fencing, batching (3B), and busy UX (3C) not started |
| 4 | Thread-aware context plus per-turn RBAC/HITL | Not started |
| 5 | Reliable status and final delivery | Not started |
| 6 | Images, documents, OCR, indexing, and retrieval safety | Plan ready |
| 7 | Production rollout, replay operations, and legacy cleanup | Not started |

After every wave:

- [ ] Run the narrow focused test set.
- [ ] Run affected package typecheck.
- [ ] Review the actual diff for duplicated authority and stale comments.
- [ ] Run a cold review against blockers, edge cases, reuse, and local code quality.
- [ ] Fix accepted findings and rerun the narrow validation.
- [ ] Commit the wave independently.
- [ ] Update this tracker and decision log.

## 6. Wave 0 — Contract, Baseline, and Prerequisite Defects

**Goal:** Freeze observable behavior and fix blockers that would make later queue/media work misleading.

### Phase 0A — Golden behavior tests

- [x] Add table-driven admission tests for DM, explicit bot mention, other-user mention, display-name collision, `@all`, bot/self echo, and malformed events.
- [x] Add scenario fixtures for repeated delivery, rapid messages from two users in one group, and independent chats.
- [x] Add scenario fixtures for two threads in one group and authenticated approval/control responses.
- [ ] Add backend-restart scenarios with the Wave 2 durable receipt.
- [x] Add joined webhook tests proving when ACK occurs and whether engine execution occurs.
- [x] Record current webhook latency/error baselines: verification, ACK, enqueue wait, run time, and total time.
- [x] Record status-card and final-reply delivery latency/error baselines.

### Phase 0B — Existing correctness blockers

- [x] Pass the configured ingestion queue name into `IngestionWorker`.
- [x] Add a regression test using a non-default queue name.
- [x] Propagate cancellation from the current serializer into the orchestration engine and model work.
- [x] Propagate cancellation into governed tool execution contexts.
- [ ] Pass cancellation into individual integration clients as their ports gain signal support.
- [x] Do not release a timed-out lane until cancellation is acknowledged or the run is marked orphaned.
- [x] Add ingress correlation fields consistently: tenant/app, company, chat, message, root/thread, requester, lane, attempt, run.
- [x] Let backend-hosted Lark tools auto-select one accessible account and return safe choices when several are available.
- [ ] Replace the null job correlation field with the durable queue job ID when Wave 2 lands.

### Exit gate

- [ ] Existing behavior is covered before routing changes begin.
- [x] Custom ingestion queue names cannot strand OCR/document jobs.
- [x] Timeout tests prove that a second run cannot overlap a timed-out first run.
- [x] No schema migration in this wave.

### Rollback

Revert only the Wave 0 commit; behavior remains the current process-local implementation.

## 7. Wave 1 — Canonical Event, Admission, Identity, and Routing

**Goal:** Give every event an unambiguous tenant, requester, room, lane, thread, and delivery identity.

### Phase 1A — Domain model

- [x] Add Lark installation/tenant identity to normalized ingress.
- [x] Add `rootMessageId`, `threadId`, and `parentMessageId` as distinct fields.
- [x] Add a canonical `ReferencedMessage` with `available`, `deleted`, `invisible`, `forbidden`, `unsupported`, and transient `unavailable` states.
- [x] Preserve sender `open_id`, `user_id`, `union_id`, sender type, and tenant key where Lark supplies them.
- [x] Preserve structured non-bot mention identities instead of only rendering names into prompt text.
- [x] Add pure builders for `roomKey`, `executionLaneKey`, and `deliveryTarget`.
- [x] Scope identity lookup and first-touch persistence by installation/tenant plus `openId`.
- [x] Preserve raw event data only for audit/debugging, never routing logic.

### Phase 1B — Admission

- [x] Resolve the installed bot's stable `open_id`.
- [x] Invoke in groups only for an exact bot-ID mention.
- [x] Strip only the bot's own mention from user intent.
- [x] Pass human mentions to the agent as a compact structured identity block.
- [x] Map explicit Lark mention IDs directly; use fuzzy person search only for unstructured names.
- [x] Treat `@all` as neither a Divo invocation nor a human identity.
- [x] Ignore bot/self events deterministically.
- [x] Keep DM admission separate from group mention admission.
- [x] Treat approval/card actions as authenticated control events, not chat prompts.

### Phase 1C — Routing tests

- [x] Alice and Bob top-level tags in one group produce different lane keys.
- [x] Alice and Bob tags in one thread produce the same lane key but retain different requester IDs.
- [x] Two threads in one room produce different lane keys.
- [x] Replies and status cards retain the correct root/thread target.
- [x] A reply to an old message hydrates that direct parent while delivering the result against the new trigger.
- [x] Deleted/invisible/cross-tenant parents produce a typed unavailable reference without leaking content.
- [x] Mentioning another human preserves their exact identity but does not change requester authority.
- [x] A user cannot acquire another tenant's identity through an `openId` collision.

### Exit gate

- [x] Routing builders are pure, deterministic, and unit-tested.
- [x] No authorization decision moves into the adapter.
- [x] The old and new keys can be shadow-logged for comparison.

### Rollback

Feature flag continues to use the old `chatId` key while retaining new normalized fields and telemetry.

## 8. Wave 2 — Durable Ingress and Idempotent Acceptance

**Goal:** Make the webhook a reliable intake edge rather than the owner of running work.

### Phase 2A — Durable receipt

- [x] Introduce a backend-owned ingress receipt with event/message identity, raw
      recovery payload, lifecycle status, attempts, and timestamps. Canonical
      lane/requester columns remain a Wave 3 optimization because they are
      deterministically reconstructed from the authenticated source payload.
- [x] Enforce a unique tenant-scoped source event/message key.
- [x] Persist and admit the stable queue job before returning `200`.
- [x] Return a retryable error to Lark if persistence or queue admission fails.
- [x] Use a stable job ID derived from the tenant-scoped receipt identity.

> This phase requires explicit approval for its schema migration before implementation.

### Phase 2B — Queue/worker

- [x] Use the existing BullMQ infrastructure as wake-up/retry transport.
- [x] Keep Postgres/receipt state as the auditable lifecycle source of truth.
- [ ] Classify retryable and terminal failures. A time-window backstop now
      dead-letters receipts that outlive their retry window, but nothing yet
      recognises a permanently-failing payload and terminates it early.
- [x] Record every failed attempt for retry/replay instead of silently discarding it.
- [x] Recover retained BullMQ jobs after exhausted attempts instead of treating
      their stable IDs as already runnable.
- [ ] Add queue depth, age, attempts, stalled jobs, and dead-letter metrics.

### Phase 2C — Recovery tests

- [x] Duplicate Lark delivery produces one receipt and one run in the focused
      recovery scenario.
- [ ] Crash after durable acceptance resumes without Lark redelivery in a real
      Redis/Postgres process-restart fixture. Repository/worker recovery is unit-tested.
- [ ] Crash during execution retries without duplicate final output.
- [x] Two acceptance races converge on one tenant-scoped receipt.
- [x] Queue outage causes a retryable webhook response, not a false success.

### Exit gate

- [ ] Accepted work survives restart.
- [ ] Duplicate accepted work is observable but executes once.
- [x] No process-local Promise chain is the durability boundary.

### Rollback

Disable the durable-ingress consumer flag, drain or inspect persisted jobs, and re-enable the old path only for a single backend replica. Never blindly replay completed jobs.

## 9. Wave 3 — Execution Lanes, Batching, and Busy Behavior

**Goal:** Preserve order where it matters without making an entire group wait behind one user.

### Phase 3A — Lane ownership

- [x] Activate canonical process-local lanes: the serializer orders on
      `buildLarkIngressLaneKey` (tenant + app + chat + DM/thread/requester)
      instead of the chat ID. The key is derived synchronously from the parsed
      event so an identity lookup can never reorder FIFO admission, and it
      carries no company or authority.
- [x] Preserve FIFO sequence inside a lane.
- [x] Re-resolve each queued item's requester when its turn begins.
- [ ] Implement one active lease per execution lane with owner, heartbeat,
      expiry, and fencing token. Not a correctness gap for the current
      single-replica deployment, but a hard prerequisite for starting a second.
- [ ] Prevent an expired owner from publishing a final response after a new owner takes the lane.
- [ ] Allow unrelated lanes to use bounded global concurrency. `maxConcurrent`
      exists on the serializer but still defaults to unbounded.

### Phase 3B — Initial burst batching

- [ ] Debounce only compatible pre-run text events from the same lane.
- [ ] Never merge different requesters, threads, reply targets, attachments, approvals, or commands.
- [ ] Bound batch delay, message count, and character count.
- [ ] Preserve every source message ID in the resulting run audit.
- [ ] Require identical parent/root/thread/reference identity before batching.

### Phase 3C — Busy turns

- [ ] Default ordinary work to FIFO queue.
- [ ] Add a concise first busy acknowledgement and suppress repeated noise.
- [ ] Let approval/clarification control events resume their exact waiting run.
- [ ] Do not add interrupt/steer until cancellation semantics are proven.
- [ ] Add queue position/cancel UX only after the underlying lifecycle is trustworthy.

### Exit gate

- [ ] Alice and Bob can run unrelated group requests concurrently.
- [ ] One thread never has overlapping agent runs.
- [ ] Rapid compatible messages create one turn.
- [ ] Restart and lease expiry preserve order without duplicate final replies.

### Rollback

Set global lane concurrency to one while retaining durable jobs and lifecycle state. Do not return to process-local durability.

## 10. Wave 4 — Thread Context, Per-Turn RBAC, and HITL

**Goal:** Share conversational knowledge without sharing authority.

### Phase 4A — Context boundaries

- [ ] Keep a bounded room-level transcript/summary for ambient context.
- [ ] Maintain thread-level working context for thread turns.
- [ ] Keep DM context private to that DM/user.
- [ ] Prevent quote/parent hydration from contaminating unrelated threads.
- [ ] Record which room messages and attachment observations supported a response.
- [ ] Fetch only the direct parent by default; use the bounded thread summary for older history.
- [ ] Re-check that the referenced message belongs to the expected tenant/chat/thread before exposing its content.
- [ ] Cache reference hydration by tenant + message ID with a bounded TTL, but re-apply access policy on use.

### Phase 4B — Authority per turn

- [ ] Resolve membership, company role, active department, grants, connection ownership, rate limits, and approval policy when the worker starts the turn.
- [ ] Re-authorize every tool call through the existing backend gateway.
- [ ] Never cache a previous participant's effective authority in shared thread context.
- [ ] Bind pending approvals to run, requester, intended approver, connection, and exact action.
- [ ] Reject another participant's attempt to resume or approve a run without authority.

### Phase 4C — Untagged group context policy

Recommended default:

- [ ] Untagged text does not invoke Divo.
- [ ] Bounded text context may be retained only under an explicit company/chat policy.
- [ ] Untagged attachments are not downloaded, OCR'd, uploaded, or indexed by default.
- [ ] The policy and retention window are visible to admins.

### Exit gate

- [ ] Shared context cannot produce shared permissions.
- [ ] Bob's follow-up in Alice's thread uses Bob's RBAC.
- [ ] Unauthorized approval/card actions are rejected and audited.
- [ ] Untagged messages never execute tools.

### Rollback

Disable room-level ambient context while retaining thread/DM context and per-turn authority.

## 11. Wave 5 — Status, Delivery, Retry, and User Recovery

**Goal:** Produce one understandable, correctly placed response even through transient Lark failures.

### Phase 5A — Delivery lifecycle

- [ ] Persist a delivery record keyed by run + segment/purpose.
- [ ] Reuse one stable idempotency key across retries.
- [ ] Classify network/429/5xx as retryable and ordinary 4xx as terminal unless explicitly mapped.
- [ ] Add exponential backoff with jitter and a maximum attempt/time budget.
- [ ] Preserve the current card → new card → plain-text degradation path.

### Phase 5B — Status semantics

- [ ] One status object per run.
- [ ] Status accurately represents queued, running, waiting for approval, retrying delivery, completed, failed, or cancelled.
- [ ] Completion cleans up typing/reaction/status state.
- [ ] Failure never displays success language.
- [ ] A user can retry/recover a terminally failed delivery without rerunning completed side effects.

### Phase 5C — Delivery tests

- [ ] Lost HTTP response after successful Lark send does not create duplicate final replies.
- [ ] Missing/withdrawn parent uses a documented safe fallback.
- [ ] Thread replies remain in the correct thread.
- [ ] Status-card failure still produces one plain-text terminal result.

### Exit gate

- [ ] Exactly one terminal outcome is visible per run.
- [ ] Delivery retry is independent from agent/tool retry.
- [ ] Completed side effects are never repeated merely to resend the answer.

## 12. Wave 6 — Images, Documents, OCR, and Indexing

**Goal:** Handle media asynchronously, securely, and predictably without making the webhook or chat lane perform unbounded extraction.

### 12.0 Storage decision

Lark has no trusted local desktop filesystem. Divo therefore uses a hybrid backend flow:

```text
Lark file reference
  -> reference-only durable job
  -> bounded worker download
  -> private authenticated staging asset
  -> extraction/OCR
  -> ACL-scoped derived text/chunks
  -> source deleted on retention schedule
```

- **Immediate one-shot image question:** stream/download in the worker, pass bounded image context to the model, and discard source bytes after the run unless the requester explicitly asks to save/index it.
- **Document or explicit knowledge ingestion:** stage the source privately so retries survive worker/network failure; store derived text/chunks under the triggering user's owner scope.
- **All durable OCR text, captions, chunks, embeddings, and source records are user-owned in V1**, including media received in group chats. No Lark-derived media enters room, department, or company memory.
- **Do not permanently retain every raw Lark upload.** Default source retention is 24 hours after successful extraction and up to 7 days after terminal failure for controlled retry. Both are configurable company policy.
- **Do not treat Cloudinary `secure_url` as private.** Upload Lark/internal sources as `authenticated` assets and generate short-lived signed delivery URLs server-side. If the current Cloudinary plan cannot satisfy that contract, use a private S3-compatible bucket rather than public `upload` assets.
- Store only asset references in jobs. Never store large base64 media in Redis.
- A quoted old attachment is context, not automatic consent to index it. If saved, it is indexed only for the triggering user.
- Immediate OCR/model output is untrusted evidence. It is quoted as data and never inserted as system/developer instructions.

### 12.1 Proposed ownership

| Concern | Lark edge/adapter | Ingestion worker |
|---|---|---|
| Verify event and requester | Yes | Re-check authoritative references |
| Parse message/file/image references | Yes | No |
| Create source descriptor and enqueue | Yes | Consume it |
| Download bytes | No, except a deliberately capped immediate path | Yes |
| MIME sniffing and limits | No | Yes |
| Native extraction/OCR/table parsing | No | Yes |
| Chunking, embeddings, asset state | No | Yes |
| User progress/final notice | Notification port only | Determines lifecycle outcome |

### Phase 6A — Safety prerequisites

- [ ] Fix full-document retrieval so company, owner, visibility, and role policy are checked before vector/file reads.
- [ ] Apply the same effective access policy to filename search and full reads.
- [ ] Replace time-based ingestion job IDs with `company + message + fileKey`.
- [ ] Make producer and worker use the same configured queue name.
- [ ] Add stable source identity and lifecycle status.
- [ ] Do not put large base64 payloads in Redis; queue a private staged-object/reference instead.
- [ ] Add explicit Cloudinary delivery type/resource type to stored asset metadata.
- [ ] Upload Lark/internal sources as authenticated assets and mint short-lived URLs only after authorization.
- [ ] Delete the underlying staged/source asset when the `FileAsset` is deleted.
- [ ] Add retention metadata (`retainUntil`, disposition, deletion status) and a cleanup worker.

### Phase 6B — Attachment intake

- [ ] Default untagged group attachments to no download/OCR/index.
- [ ] For a tagged message/DM, enqueue reference-only attachment jobs quickly.
- [ ] Stream downloads with hard byte limits.
- [ ] Sniff actual MIME rather than trusting file extension.
- [ ] Enforce image dimensions, PDF pages, workbook sheets/cells, extracted characters, and worker wall-clock limits.
- [ ] Send one concise received/indexing acknowledgement when processing will outlive the immediate turn.
- [ ] Do not synchronously OCR/upload every attachment inside the webhook.
- [ ] Do not automatically index a parent/quoted attachment; process it only for the current request unless persistence is explicit.

### Phase 6C — Extraction strategy

Images:

- [ ] Use the multimodal model for visual reasoning when the immediate request needs the image itself.
- [ ] Use OCR as derived untrusted text for exact labels, retrieval, and indexing.
- [ ] Store provider/model/version, confidence, warnings, and source provenance.
- [ ] Normalize images and remove metadata before external processing where practical.

Documents:

- [ ] PDF: run native text extraction first.
- [ ] Scanned PDF: detect near-empty text relative to page count, then OCR bounded rendered pages.
- [ ] DOCX: use native extraction; fail clearly for unsupported legacy/encrypted formats.
- [ ] XLSX/CSV/TSV: preserve sheet, header, row range, and truncation provenance rather than flattening blindly.
- [ ] Large documents: index asynchronously and let the agent query them after readiness.

Initial configurable guardrails for the internal canary:

- [ ] Immediate image path: 10 MB and 25 megapixels maximum.
- [ ] Scanned-PDF OCR: 25 pages at 150 DPI; larger files produce explicit partial indexing.
- [ ] Source retention: 24 hours after success, 7 days after terminal failure.
- [ ] No long-term original retention without explicit user action or company policy.

### Phase 6D — Deduplication and cache

- [ ] `sourceKey = lark:{companyId}:{messageId}:{fileKey}` prevents source replay.
- [ ] Compute `contentSha256` after download for compatible cross-message reuse.
- [ ] Reuse derived OCR/text/embeddings only when company and owner user are identical.
- [ ] Never reuse or promote a user's asset into room, department, shared, or company visibility.
- [ ] Version extractors/OCR so reprocessing is explicit and auditable.

### Phase 6E — Failure UX

- [ ] Distinguish download permission expiry, size/page limit, encrypted/unsupported format, OCR limit, provider exhaustion, and transient failure.
- [ ] Show exactly one terminal result: indexed, partially indexed, unsupported, or failed.
- [ ] Retain replay metadata without leaking raw provider errors.
- [ ] Clean staged bytes after success or terminal failure according to retention policy.

### OCR decisions

1. **Untagged group attachments:** no download/OCR/index by default.
2. **Visibility:** all Lark-derived OCR, documents, and embeddings are personal to the triggering user in V1, including explicitly saved group attachments.
3. **Retention:** immediate source bytes are discarded; staged ingestion sources follow the 24-hour/7-day policy; durable derived text follows the knowledge asset's lifecycle.
4. **Scanned PDFs:** bounded page OCR with explicit partial indexing above the cap.
5. **Provider routing:** use the configured provider abstraction initially; do not silently change providers inside a retry. Record provider/model/version per result.
6. **Immediate images:** use the bounded fast path; otherwise acknowledge and queue.

### Exit gate

- [ ] OCR/document work never blocks webhook acknowledgement.
- [ ] No cross-company or ACL-incompatible retrieval is possible.
- [ ] Replayed events create one asset and one final notice.
- [ ] Scanned PDFs have page-level provenance and explicit partial-result behavior.

## 13. Wave 7 — Canary, Operations, and Cleanup

**Goal:** Prove the new runtime under real traffic, then remove superseded code deliberately.

### Phase 7A — Shadow and canary

- [ ] Shadow-log old/new admission and lane keys without double execution.
- [ ] Canary one internal company/tenant.
- [ ] Observe duplicates, lane wait, queue age, lease expiry, retries, DLQ, approval waits, delivery failure, attachment latency, and OCR cost.
- [ ] Expand only after scenario tests and canary SLOs pass.

### Phase 7B — Operations

- [ ] Admin view for queued/running/waiting/failed/replayable Lark jobs.
- [ ] Safe replay that refuses completed side effects.
- [ ] Run cancellation with visible terminal state.
- [ ] Alerts for oldest queue age, stalled lane, repeated delivery failure, dead letters, and OCR/provider exhaustion.

### Phase 7C — Explicit cleanup approval

After telemetry proves the new path:

- [ ] Ask before removing `ChatMessageSerializer` from the Lark path.
- [ ] Remove stale comments claiming process-local serialization is production ordering.
- [ ] Review the weaker root challenge handler after confirming Lark configuration.
- [ ] Remove duplicate attachment inline/full processing paths only after the replacement is proven.
- [ ] Keep desktop/channel-generic behavior untouched unless separately approved.

### Exit gate

- [ ] Production SLOs and rollback procedures are documented.
- [ ] No two components independently own admission, RBAC, lane ordering, or delivery state.
- [ ] Superseded code is removed only with explicit approval.

## 14. End-to-End Scenario Matrix

These scenarios must pass before broad rollout:

| Scenario | Required outcome |
|---|---|
| DM from known member | Runs with sender's current RBAC |
| DM from unknown user | Safe onboarding/login flow; no tools |
| Group message without Divo mention | No reply and no agent/tool execution |
| Group message mentioning another user | No Divo invocation |
| Exact Divo mention | One requester-scoped run |
| Divo plus human mentions | Run once; preserve exact human IDs; requester authority unchanged |
| Reply to an older visible message | Direct parent included with provenance; result delivered to current trigger/thread |
| Reply to a recalled/deleted message | Explicit unavailable-reference context; no hallucinated quote |
| Reply to a message from another tenant/chat | Reference denied before content hydration |
| Quoted attachment without “save/index” | Available only to the current bounded run; not persisted |
| Group attachment explicitly saved by Alice | Indexed only under Alice's owner scope; unavailable to Bob and company retrieval |
| Alice and Bob tag Divo at top level simultaneously | Independent lanes; bounded concurrent execution |
| Alice and Bob tag Divo in the same thread | FIFO shared thread lane; authority resolved per turn |
| Same user sends three rapid compatible messages | One audited batched turn |
| Same user sends attachment then clarification | No incompatible batching; deterministic ordering |
| Duplicate webhook delivery | One receipt, run, side effect, and final reply |
| Backend dies after ACK | Accepted job resumes |
| Worker dies mid-run | Lease/attempt recovery; fenced stale worker |
| Approval required | Exact run waits; authorized action resumes it |
| Unauthorized user clicks approval | Rejected and audited |
| Lark send returns 429/5xx | Retried without duplicate terminal output |
| Tagged image | Bounded visual/OCR flow with untrusted derived text |
| Untagged group image | No OCR/index under default policy |
| Native-text PDF | Native extraction before OCR |
| Scanned PDF | Bounded page OCR with partial-result semantics |
| Same file delivered twice | Source/content dedup consistent with ACL |
| Cross-company asset read | Denied before vector/file content is returned |

## 15. Observability and SLO Candidates

Track at minimum:

- webhook verification failures by reason;
- durable-accept latency and failures;
- duplicate-event count;
- queue depth and oldest age;
- execution-lane wait and run duration;
- active/expired leases and fencing rejections;
- batched source-message count;
- RBAC/approval outcomes without sensitive payloads;
- outbound attempts, fallback path, and terminal state;
- attachment bytes/pages/cells and extraction time;
- OCR calls, confidence, failures, cost proxy, and dedup hit rate;
- dead-letter and replay outcomes.

Initial internal targets to validate during canary:

- webhook durable ACK within Lark's deadline;
- zero lost accepted events;
- zero overlapping runs for one lane;
- zero duplicate terminal replies for one run;
- zero cross-user/company authorization leakage;
- all terminal failures visible and replayable.

## 16. Decision Log

| Date | Decision | State |
|---|---|---|
| 2026-07-24 | Adapt Hermes runtime patterns; do not port Hermes architecture | Accepted |
| 2026-07-24 | Backend remains sole identity/RBAC/HITL/tool authority | Accepted |
| 2026-07-24 | Group invocation requires an explicit Divo bot-ID mention | Accepted |
| 2026-07-24 | Each turn uses the triggering user's current authority | Accepted |
| 2026-07-24 | Default busy behavior is FIFO queue, not interrupt | Proposed |
| 2026-07-24 | Room context, execution lane, and delivery target use separate keys | Proposed |
| 2026-07-24 | Untagged attachments are not OCR'd/indexed by default | Accepted |
| 2026-07-24 | Lark-derived OCR/embeddings are never room/department/company memory in V1 | Accepted |
| 2026-07-24 | Scanned PDFs use native-text-first, bounded page OCR | Proposed |
| 2026-07-24 | Parent, root/thread, and triggering message are separate identities | Accepted |
| 2026-07-24 | Human mentions preserve stable IDs but never transfer authority | Accepted |
| 2026-07-24 | Direct parent hydration is one hop plus bounded thread summary | Accepted |
| 2026-07-24 | Lark media uses private cloud staging, not permanent raw retention by default | Accepted |
| 2026-07-24 | Saved group attachments remain personal to the triggering user | Accepted |
| 2026-07-24 | Untagged group attachments are not downloaded/OCR'd/indexed by default | Accepted |
| 2026-07-25 | Canonical routing keys are shadow-logged while the live serializer remains on `chatId` | Superseded on 2026-07-25 by Wave 3A |
| 2026-07-25 | The live serializer orders on the canonical ingress lane key; lane selection is synchronous and authority-free | Implemented |
| 2026-07-26 | Ingress dead-lettering is bounded by a retry window measured from acceptance, not by an attempt count, so queue-level retries cannot exhaust the budget during a transient outage | Implemented |
| 2026-07-26 | A worker that cannot win a receipt's lease fails its job rather than completing it, so recovery stays reachable | Implemented and cold-reviewed |
| 2026-07-26 | Wave 2/2B schema pushed to `divo_dev` over the SSH tunnel; receipt lifecycle verified against real Postgres | Implemented |
| 2026-07-25 | Lark webhook ACK follows durable receipt persistence, stable queue admission, and receipt/job linkage | Implemented |
| 2026-07-25 | Failed durable receipts remain recoverable; reconciliation retries retained failed BullMQ jobs | Implemented and cold-reviewed |

## 17. Configuration Verification — 2026-07-24

Verified without printing secret values:

| Dependency | Configuration | Live check | Finding |
|---|---|---|---|
| Lark app | App ID and secret present | Tenant-token endpoint `200`, provider code `0` | Credentials work |
| Lark webhook verification | Verification token present; encrypt key absent | Configuration inspection only | Valid only while encrypted event delivery is disabled; startup must reject an enabled-encryption deployment without the key |
| Gemini OCR | Key present; provider defaults to `gemini` | Models endpoint `200` | Active generic ingestion provider is Gemini |
| OpenRouter OCR | Key present; default vision model is Scout | Auth endpoint `200` | Available but not active unless `IMAGE_OCR_PROVIDER=openrouter` |
| Cloudinary | Cloud name/key/secret complete | Admin ping `ok` | Credentials work; current general uploads are public `upload` assets and are not production-safe for internal Lark sources |
| Qdrant | URL and API key present | Collections endpoint `200` | Vector store is reachable |

Configuration work required before rollout:

- [ ] Add OCR provider/model, Cloudinary, Qdrant, Lark verification/encryption, retention, and media limits to `.env.example`.
- [ ] Validate all-or-none Cloudinary credentials at startup instead of silently disabling on a partial set.
- [ ] Validate that encrypted Lark delivery and `LARK_ENCRYPT_KEY` agree.
- [ ] Log selected OCR provider/model and storage mode without logging secrets.
- [ ] Add a read-only startup health summary for Lark auth, private object storage, OCR provider, queue, and vector store.
- [ ] Resolve the current product drift: Teach OCR is configured separately, while generic Lark/document OCR currently defaults to Gemini.

## 18. Out-of-Scope Findings

Do not silently fix these during unrelated waves:

- Full-document and filename retrieval authorization inconsistencies must be handled explicitly in Wave 6A.
- Any future shared/room/company media memory requires a separate product decision and explicit RBAC design.
- Existing image OCR providers should not be replaced without representative quality/cost evidence.
- Current Cloudinary temp-export comments describe signed public-upload URLs as expiring access; signing does not by itself make a public `upload` asset private.
- A dedicated graph/session redesign outside Lark is not required for this project.
- Desktop chat reliability and scheduled workflow reliability remain separate projects.
