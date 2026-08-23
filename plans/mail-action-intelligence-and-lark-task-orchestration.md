# Divo Action Intelligence — Mail to Lark Work Orchestration

**Status:** Proposed; architecture and delivery plan only  
**Created:** 2026-08-12  
**Scope:** Cloud backend, Gmail Mail Ops, Lark Tasks, native Pi skills, and Admin UI  
**Out of scope for the first release:** autonomous email sending, omniscient employee monitoring, and non-mail signal sources  
**Companion plans:** [mail-automation-production-finalization.md](mail-automation-production-finalization.md), [mail-automation-system-handover.md](mail-automation-system-handover.md)

## 1. Decision

Build a general **Action Intelligence** layer that can turn governed source signals into durable, synchronized work. Gmail is the first source and Lark Tasks is the first work destination. “Unreplied client email” is one policy built on this foundation, not the architecture itself.

**Verdict:** proceed in bounded waves — confidence **88%**.

The direction is strong because the current system already has:

- Durable Gmail Pub/Sub ingestion, history cursors, reconciliation, mailbox health, and `providerThreadId` capture.
- A governed `larkTask` tool, company people resolution, assignees, followers, deadlines, subtasks, and tasklists.
- Backend-owned RBAC, connection selection, approvals, auditing, retries, and Lark delivery.
- Native Pi skills provisioned from the backend database.

The missing pieces are durable work state, full thread-direction tracking, grounded responsibility inference, Lark task synchronization, policy management, and product UI.

## 2. Product boundary

### What Divo should become

Divo observes a work signal, identifies a possible obligation, grounds the people and evidence, then either proposes or creates a Lark Task according to company policy. It keeps the source and task synchronized without silently overriding human decisions.

Examples:

- A client asks for an NDA and explicitly tags Dr. Strange → propose or create a task for Dr. Strange; follow Captain Marvel and the manager.
- An invoice arrives requiring approval → create an approval-preparation task in the Finance tasklist.
- A client thread has no detected company reply after 12 business hours → surface or escalate the existing work item.
- One email contains three independent requests → create three proposed work items only when they have distinct deliverables or owners.
- A Lark Task is reassigned or completed → treat Lark’s human decision as authoritative and update Divo’s orchestration state.

### What “smart from the root” does not mean

- It does not mean an unconstrained model silently assigning employees.
- It does not mean treating To/CC, a name mention, or model confidence as proof of accountability.
- It does not mean copying complete email bodies or attachments into broadly visible Lark tasks.
- It does not mean building a second task manager inside Divo.
- It does not mean auto-sending email replies in V1.

## 3. Authority model

There must be no duplicate authority.

| Concern | Authority |
| --- | --- |
| Gmail tokens, mailbox access, source evidence | Backend connection and Mail Ops services |
| Identity, RBAC, approvals, retention, audit | Backend |
| Semantic extraction and suggestions | Model, as non-authoritative evidence-backed output |
| User identity matching | Company-grounded Lark people resolver |
| Detection lifecycle and idempotency | Divo `WorkItem` orchestration ledger |
| Human-visible assignee, followers, due date, completion | Lark Task after projection |
| Company automation and escalation policy | Backend policy record |
| Interactive agent behavior | Concise native Pi skills; never the enforcement layer |

After a Lark Task exists, human changes in Lark win. A later email may add evidence, recommend reopening, or update the source state, but must not silently undo a human reassignment, deadline, follower, or completion decision.

## 4. Target architecture

```text
Gmail watch + reconciliation
        |
        v
Normalized source events and thread snapshots
        |
        v
Action candidate extraction
  - requested outcome
  - deadline
  - owner candidates
  - followers
  - evidence + confidence
        |
        v
Policy and identity grounding
  - RBAC / connection / destination checks
  - Lark directory resolution
  - propose / confirm / auto-create decision
        |
        v
Divo WorkItem orchestration ledger
  - source state and evidence
  - idempotency and transitions
  - linked Lark projection
        |
        v
Lark Task v2
  - assignee(s)
  - followers (the task equivalent of CC)
  - due date, tasklist, notes, source link
        |
        +-------------------+
                            v
                 Task events/reconciliation
                            |
                            +----> WorkItem state mirror
```

The automation worker must use a shared backend application service, not call the public `larkTask` tool internally. The typed tool and the worker should both depend on the same governed task service so behavior cannot drift.

## 5. Core domain model

Names remain source-neutral even though the first implementation is mail-only.

### `WorkAutomationPolicy`

- `id`, `companyId`, `createdByUserId`, `departmentId?`
- `name`, `status`, `sourceType` (`gmail_thread` initially)
- source scope: mailbox, client domains, labels, exact senders, exclusions
- candidate types: request, approval, follow-up, document request, decision, issue, commitment
- assignment strategy: fixed owner, explicit-language owner, responsibility map, queue owner, confirm
- autonomy: observe, propose, confirm-create, auto-create
- default tasklist, followers, manager/escalation policy
- SLA, business hours, timezone, holiday behavior, reminder cap
- confidence thresholds and policy version
- connection IDs and live authorization snapshot references

### `WorkItem`

- Stable unique key: `(companyId, policyId, sourceType, sourceId, candidateKey)`.
- `state`: `candidate | proposed | confirmed | projected | active | snoozed | resolved | suppressed | failed`.
- `sourceState`: `external_waiting | internal_waiting | replied_detected | withdrawn | unknown`.
- Requested outcome, normalized deadline, priority, short safe summary.
- Suggested owner IDs, grounded owner ID, confidence, reasons, and uncertainty flags.
- Follower IDs and why each is included.
- Current Lark task GUID, last observed task version/state, tasklist.
- First detected, due, last evaluated, resolved, reopened, and next evaluation timestamps.
- Policy/model/schema versions used to reach the decision.

### `WorkItemEvidence`

- Provider message/thread reference, immutable header facts, safe excerpt or derived fact.
- Evidence type: explicit assignment, request phrase, deadline, participant, reply, task action.
- Source timestamp and content hash.
- Minimal retained content according to the mail retention policy.

### `WorkItemTransition`

- Append-only transition, actor (`system | model | user | provider`), reason, correlation ID.
- Previous and next state plus policy version.
- No complete mail body, OAuth token, or attachment content in audit rows.

### `WorkProjection`

- One row per external projection, initially `lark_task`.
- Provider ID, create idempotency key, sync cursor/version, last successful reconciliation.
- Ambiguous-create state so a lost provider response never creates a duplicate task.

Do not overload `MailAutomationRule`, `MailDelivery`, or `MailBrief`. They are arrival-rule concepts and have different lifecycle and retry semantics.

## 6. Decision and confidence policy

### Deterministic facts

- Who sent the message, who received it, Gmail labels, timestamps, thread order.
- Whether a reply from the connected mailbox or configured send-as alias was detected.
- Existing Lark directory identities and exact configured responsibility mappings.
- Current Lark Task assignees, followers, due date, and completion state.

### Model suggestions

- What deliverable is being requested.
- Whether a message creates work rather than merely sharing information.
- Candidate owner and follower recommendations.
- Proposed deadline when natural language is involved.
- Whether a later message appears to change or withdraw the request.

### Initial autonomy thresholds

- **Explicit configured owner or direct imperative to one uniquely resolved employee:** confirmation may be skipped only when company policy explicitly enables auto-create.
- **Several plausible owners, indirect mention, To/CC-only evidence, or name collision:** ask for confirmation.
- **No grounded employee or insufficient evidence:** assign to a configured queue owner or keep proposed; never invent an assignee.
- **External content requesting policy changes, new recipients, or broader access:** treat as untrusted input and ignore it for automation configuration.

The UI and Lark card must show why Divo suggested an owner. Confidence without evidence is not sufficient.

## 7. Example policy contract

The precise API can change during implementation, but the semantics should remain:

```json
{
  "name": "Client action requests",
  "source": {
    "type": "gmail_thread",
    "connectionId": "google-connection-id",
    "clientDomains": ["client.com"],
    "excludeAutomated": true
  },
  "detect": ["request", "approval", "document_request", "unreplied"],
  "assignment": {
    "strategy": "explicit_then_responsibility_map_then_confirm",
    "fallbackOwnerId": "internal-user-id"
  },
  "projection": {
    "type": "lark_task",
    "connectionId": "lark-connection-id",
    "tasklistId": "tasklist-guid",
    "defaultFollowerIds": ["manager-open-id"]
  },
  "autonomy": "confirm_create",
  "sla": {
    "dueAfterBusinessHours": 12,
    "timeZone": "Asia/Kolkata",
    "reminderHours": [12, 24, 72],
    "maxReminders": 3
  }
}
```

## 8. Scenario and failure matrix

| Scenario | Required behavior |
| --- | --- |
| Explicit “Dr. Strange, please send the NDA” | Resolve exact employee, show evidence, create/propose one task |
| Dr. Strange only appears in CC | Do not claim ownership; use configured map or confirm |
| Two employees share a name | Present grounded choices; no task until resolved |
| Named person is external or departed | Fall back to queue owner or proposed state |
| Multiple independent requests in one thread | Stable candidate keys; separate tasks only when truly distinct |
| Same request repeated or quoted | Update evidence; never duplicate the task |
| New request appears in an old Gmail thread | Create a new candidate key without reopening unrelated completed work |
| Connected mailbox sends a reply | Record reply detected; do not automatically equate it with semantic completion |
| Another employee replies from an unconnected mailbox | State the coverage limitation; allow manual resolve or shared-mailbox coverage |
| Reply sent from configured alias | Count it as internal after verified alias resolution |
| Client says “thanks” | Do not automatically close a substantive open task |
| Client withdraws the request | Propose resolution with evidence; auto-resolve only under explicit policy |
| Human reassigns/completes task in Lark | Lark wins; mirror the change and preserve audit |
| Human deletes task | Mark projection missing and ask to restore/recreate; never loop-create silently |
| User changes task due date/followers | Preserve the human edit during future source updates |
| Gmail push is delayed/dropped | Periodic history reconciliation catches up |
| History cursor expires | Controlled resync without duplicate candidates/tasks |
| Pub/Sub or task event is replayed/out of order | Idempotent event and transition processing |
| Provider accepted create but response was lost | Reconcile ambiguous projection before any retry |
| Lark/Gmail connection is revoked | Pause affected policy/items and notify owner once |
| RBAC/department changes after policy creation | Reauthorize every evaluation and projection action |
| Holiday, timezone, DST, or outside business hours | Use policy calendar; never server-local time |
| Automated/no-reply/newsletter mail | Suppress using deterministic headers plus policy exclusions |
| Prompt injection inside mail | Mail content cannot change policy, recipients, access, or autonomy |
| Sensitive mail or attachment | Minimized task note; no attachment/body copied by default |
| Manager/group membership changes | Re-resolve governed followers before escalation |
| More than one matching policy | Apply deterministic precedence/dedupe; never create competing tasks |

## 9. Delivery waves

Each wave must ship as a small vertical slice with focused tests and a rollback switch. Do not start autonomous creation before Waves 0–7 have production-like evidence.

### Wave 0 — Product semantics and evaluation baseline

**Goal:** define what “work”, “owner”, “reply”, and “resolved” mean before code hardens guesses.

- [ ] Collect 50–100 sanitized historical threads across requests, FYIs, acknowledgements, shared mailboxes, aliases, and multiple POCs.
- [ ] Label requested outcomes, distinct work items, owner evidence, follower evidence, reply direction, and human resolution.
- [ ] Define acceptable precision targets separately for detection, owner suggestion, and duplicate prevention.
- [ ] Define V1 policy templates: client request, approval request, document request, and unreplied thread.
- [ ] Confirm task-note redaction and mail-content retention with the privacy owner.
- [ ] Decide whether V1 supports personal mailboxes only, shared mailboxes, or both.
- [ ] Record exact coverage language: “no reply detected from connected mailbox(es)”.

**Exit gate:** reviewed semantics, labeled evaluation set, success metrics, privacy boundary, and no claim that Divo can observe unconnected mailboxes.

### Wave 1 — Generic work orchestration domain

**Goal:** build durable source-neutral state without creating Lark tasks yet.

- [ ] Add `WorkAutomationPolicy`, `WorkItem`, `WorkItemEvidence`, `WorkItemTransition`, and `WorkProjection` Prisma models.
- [ ] Add company/user/department relations, scoped unique keys, indexes, retention fields, and cascade/restrict behavior.
- [ ] Implement repositories with optimistic claims, stale-claim recovery, and append-only transitions.
- [ ] Implement an explicit state machine; reject illegal transitions.
- [ ] Add policy-version and model-version pinning.
- [ ] Add feature flags by company and a global kill switch.
- [ ] Add read-only admin diagnostics before mutation endpoints.
- [ ] Preview schema diff; document Development/Main rollout and rollback.

**Exit gate:** duplicate source events cannot produce duplicate `WorkItem`s; worker restart and concurrent evaluation are safe.

### Wave 2 — Gmail thread lifecycle and direction truth

**Goal:** understand relevant conversation changes rather than only new INBOX arrivals.

- [ ] Extend the mailbox watcher/history reader to cover relevant INBOX and SENT changes, or remove the label filter and filter server-side after measuring volume.
- [ ] Preserve the existing watch-renewal and periodic reconciliation path; Gmail push is not treated as lossless.
- [ ] Fetch bounded full thread metadata only for policies that need thread reasoning.
- [ ] Normalize message direction using mailbox address and verified send-as aliases.
- [ ] Track last external/internal messages, participants, and reply evidence per thread.
- [ ] Handle expired history IDs with a bounded catch-up strategy.
- [ ] Ensure old arrival rules still evaluate only intended incoming events.
- [ ] Add mailbox-health dimensions for INBOX, SENT, watch, reconciliation, and coverage gaps.
- [ ] Verify existing Mailer `gmail.modify` grant is sufficient; add no Drive scopes and no new Gmail scope unless a concrete operation requires it.

**Exit gate:** an inbound request followed by a sent reply changes thread state exactly once; dropped/replayed notifications and aliases are covered.

### Wave 3 — Action candidate intelligence

**Goal:** extract useful work proposals without granting authority to model output.

- [ ] Define a strict structured candidate schema: outcome, evidence spans, due date, candidate owner queries, followers, confidence, and uncertainty reasons.
- [ ] Pre-filter obvious automated/FYI mail deterministically.
- [ ] Use the model only after deterministic scope selection.
- [ ] Resolve names/emails through the existing company people resolver.
- [ ] Add responsibility maps as explicit company policy, not learned guesses.
- [ ] Derive stable candidate keys so quoted/repeated requests dedupe.
- [ ] Support several distinct candidates from one thread with a conservative maximum.
- [ ] Store minimal evidence and hashes; keep complete bodies out of traces/logs.
- [ ] Run the Wave 0 corpus and publish precision/recall/error categories.

**Exit gate:** no fabricated identity, no policy mutation from email content, and measured owner-suggestion quality above the agreed threshold.

### Wave 4 — Confirmed Lark Task projection

**Goal:** turn one confirmed proposal into one governed Lark Task.

- [ ] Extract a shared governed Lark Task application service used by both `larkTask` and the background projector.
- [ ] Preserve user-token data boundaries; do not assume a tenant token can see all employee tasks.
- [ ] Add `followerNames` resolution alongside `assigneeNames`.
- [ ] Add safe add/remove member operations; do not overwrite followers when updating assignees.
- [ ] Verify tasklist access and recipient visibility before create.
- [ ] Create concise task notes: requested outcome, requester, safe evidence, Gmail link, coverage statement, and Divo work-item reference.
- [ ] Persist provider task GUID and ambiguous-create state before retrying.
- [ ] Add a confirmation card with Confirm, Change owner, Change followers, Snooze, Suppress, and Open email.
- [ ] Enforce RBAC, connection governance, rate limits, and approvals again at execution time.
- [ ] Add one task per stable work item; card and provider retries must be idempotent.

**Exit gate:** one confirmed NDA request creates exactly one correctly assigned task with followers and a working source link, including lost-response retry tests.

### Wave 5 — Lark synchronization and human authority

**Goal:** keep Divo aligned with human changes made in Lark.

- [ ] Verify and provision the exact Task v2 change-event subscription/scopes available to the installed app.
- [ ] If event coverage is insufficient, implement bounded task reconciliation with cursors/backoff.
- [ ] Mirror task reassignment, follower changes, deadline changes, completion, and deletion.
- [ ] Never overwrite a human edit with a stale mail-derived suggestion.
- [ ] Preserve task completion as authoritative while allowing a later distinct request to create new work.
- [ ] Support manual reopen/restore with an audit transition.
- [ ] Add task comments or activity notes only after verifying visibility and noise behavior.
- [ ] Add reconciliation health, lag, and drift metrics.

**Exit gate:** Lark edits survive source reevaluation, and event loss/replay cannot cause split-brain state or duplicate tasks.

### Wave 6 — Policy engine, tools, and native skills

**Goal:** let users configure the capability without turning instructions into enforcement.

- [ ] Add a typed `workAutomations` tool for list, create, update, pause, test, and archive.
- [ ] Keep existing `mailAutomations` for arrival forwarding/organizing; do not overload it with work lifecycle semantics.
- [ ] Add dry-run volume and historical preview with no task creation.
- [ ] Add a concise native skill such as `mail-work-orchestration`.
- [ ] Update `google-workspace-router`: future arrival delivery → `mail-ops`; mail-derived work/tasks → the new skill.
- [ ] Update `lark-work-management` to state actual follower support; it currently incorrectly says followers are unavailable.
- [ ] Explain propose/confirm/auto modes and genuine stop conditions in skill text.
- [ ] Keep schemas, scopes, auth, and retry details in typed tools/backend, not duplicated in skills.
- [ ] Provision changed skills through `reconcile-capabilities` and verify native Cloud-Pi loading.

**Exit gate:** a vague user request routes to the right specialist, previews safely, and cannot bypass backend policy by prompt wording.

### Wave 7 — Member and Admin UI

**Goal:** make configuration, evidence, and failures understandable without talking to Divo.

- [ ] Add “Action Intelligence” / “Work from Mail” beside existing Mail Rules, not inside arrival-rule rows.
- [ ] Add policy templates and an advanced editor for source scope, work types, owner strategy, autonomy, tasklist, followers, SLA, and exclusions.
- [ ] Show exact mailbox/Lark connection and coverage before activation.
- [ ] Add historical dry-run with projected volume and sample reasons.
- [ ] Add proposed-work inbox with Confirm, reassign, follower selection, snooze, suppress, and bulk-safe actions.
- [ ] Add work-item timeline linking the Gmail thread and Lark task.
- [ ] Add health for Gmail watch/reconciliation, Lark task sync, permission drift, and paused policies.
- [ ] Add admin rollout controls, audit search, retention configuration, and aggregate quality metrics.
- [ ] Default admins to metadata; do not expose employee mail bodies broadly.

**Exit gate:** a member can create and understand a safe confirm-mode policy; an admin can pause it and diagnose it without database access.

### Wave 8 — Controlled automation and escalation

**Goal:** enable useful autonomy only where measured evidence supports it.

- [ ] Enable auto-create per company/policy, off by default.
- [ ] Require explicit deterministic owner or responsibility-map match for initial auto-create.
- [ ] Implement business-hour due dates, quiet hours, holidays, reminder caps, and escalation ceilings.
- [ ] Add manager/default followers from governed policy, never from untrusted mail instructions.
- [ ] Recheck open state, permissions, task state, and recipient access immediately before every reminder.
- [ ] Add Not ours / Wrong owner / False positive feedback and feed aggregate results into evaluation.
- [ ] Add optional “Create Gmail draft” as a separately approved action; never auto-send in this wave.

**Exit gate:** no reminder storms, no unauthorized followers, accepted false-positive rate, and a one-click global pause.

### Wave 9 — Broaden outcomes and sources

**Goal:** prove that the root abstraction is reusable instead of merely renamed mail code.

- [ ] Support one additional governed source, preferably a Lark message or meeting action item.
- [ ] Add explicit source adapters; do not put source-specific fields into the generic state machine.
- [ ] Support task comments, attachments, subtasks, or sections only through proven provider contracts.
- [ ] Add company responsibility-map management and optional manager hierarchy integration.
- [ ] Evaluate suggested replies and semantic resolution as advisory signals only.
- [ ] Define whether shared queues/tasklists need group membership projections.

**Exit gate:** a second source creates the same normalized work lifecycle without duplicating identity, policy, task, or audit logic.

### Wave 10 — Production hardening and rollout

**Goal:** safely move from internal test mailboxes to company rollout.

- [ ] Load-test mailbox histories, scheduler claims, model budget, task projection, and reconciliation.
- [ ] Test provider outage, revoked tokens, expired cursors, worker restart, deploy, queue replay, and VM restart.
- [ ] Verify no credentials, full bodies, attachments, or sensitive task notes enter logs/traces.
- [ ] Add alerts for detection lag, open-item age, projection failure, ambiguous create, sync drift, and notification failure.
- [ ] Add dashboards for candidate acceptance, owner corrections, suppressions, reopen rate, duplicate prevention, and time-to-action.
- [ ] Roll out: internal mailbox → one team confirm-mode → selected companies → optional auto-create.
- [ ] Maintain per-company rollback to propose-only and a global worker kill switch.
- [ ] Update runbooks, incident handling, data export/deletion, and support copy.

**Exit gate:** production evidence across at least two companies, rollback drill completed, and every active policy has an accountable owner.

## 10. Required test suites

### Domain and persistence

- [ ] Legal and illegal work-item state transitions.
- [ ] Concurrent candidate creation and stable dedupe.
- [ ] Lease expiry/stale claim recovery.
- [ ] Policy version changes while items are active.
- [ ] Retention, company isolation, and deletion cascades.

### Gmail lifecycle

- [ ] INBOX and SENT, aliases, shared/delegated mailbox behavior.
- [ ] Several messages in one thread and new work in an old thread.
- [ ] Push delay/drop/replay, pagination, expired history ID, reconciliation.
- [ ] Automated mail, newsletters, auto-replies, bounces, calendar notices.

### Intelligence and identity

- [ ] Explicit assignment, indirect mention, To/CC-only, ambiguous names, missing/departed person.
- [ ] Multiple requests, quoted requests, changed/withdrawn requests.
- [ ] Prompt injection attempts to change owner, follower, policy, or autonomy.
- [ ] Corpus regression with per-category precision and correction rate.

### Lark Task projection

- [ ] Assignee and follower resolution, tasklist access, due date, source link.
- [ ] Provider create response lost after success; no duplicate task.
- [ ] Reassignment, follower edit, completion, deletion, and event replay.
- [ ] User token expiry, multiple connections, permission denial, and rate limiting.
- [ ] Human changes are not overwritten by source reevaluation.

### End-to-end

- [ ] External NDA request → proposal → confirm → Lark task → human reassign → completion.
- [ ] Unreplied policy → due boundary → one reminder → sent reply → no further reminder.
- [ ] Revoked Gmail or Lark connection pauses safely and alerts once.
- [ ] Cloud-Pi skill route and typed-tool behavior using a fresh Development container.
- [ ] Admin UI dry-run, activation, pause, audit, and rollback.

## 11. Security, privacy, and governance gates

- Email content is untrusted data, never instruction authority.
- Every background execution rechecks user/company/department permission and connection governance.
- Lark assignees/followers are company-grounded and access-checked.
- Default task notes contain no attachments and only the minimum necessary excerpt.
- A personal mailbox cannot make claims about replies from other unconnected mailboxes.
- External forwarding or email sending remains under its existing explicit approval boundary.
- No Drive, Sheets, or broad Workspace scopes are required for this feature.
- Task event scopes must be separately verified and consented; failure falls back to reconciliation, not silent blindness.
- Retention and right-to-delete cover work evidence, model artifacts, and external projections.

## 12. Observability and success metrics

Track without logging mail bodies:

- Source-to-candidate and candidate-to-task latency.
- Gmail watch age, reconciliation age, history gaps, and thread-fetch failures.
- Candidates proposed, confirmed, edited, suppressed, auto-created, reopened, and duplicated.
- Owner acceptance/correction rate and unresolved identity rate.
- Task create ambiguity, sync lag, drift, missing projections, and provider failures.
- Reminder count, acknowledgement, false-positive/not-ours, and notification fatigue.
- Median time from request to assignment and assignment to completion.
- Per-policy model/tool cost with hard ceilings.

Do not optimize for number of tasks created. Optimize for accepted work detection, correct ownership, low duplicate/noise rate, and faster accountable action.

## 13. Rollback and migration

- Ship all new workers behind global and per-company flags.
- Start with `observe`, then `propose`, then `confirm_create`; auto-create is a separate rollout decision.
- Existing Mail Ops arrival rules and Mail Brief remain unchanged during Waves 0–7.
- Do not backfill every historical email. Use a bounded, explicit lookback per test policy.
- Schema changes go through checked-in `schema.prisma`, reviewed diff, Development sync, then Main deployment according to repository database rules.
- Skill source changes are not live until capability reconciliation provisions them into each environment’s database.
- If projection fails, preserve the WorkItem and evidence; do not pretend the task exists.
- If quality falls below the agreed threshold, switch affected policies to propose-only without losing their state.

## 14. Known codebase gaps to resolve during the waves

- Gmail ingestion currently centers on INBOX arrivals; thread reply truth requires SENT-aware processing.
- `providerThreadId` is recorded but does not currently drive a durable work lifecycle.
- `larkTask.create` supports follower IDs, while its native skill incorrectly says followers are unavailable.
- Human-readable names are resolved for assignees but not followers.
- Current task updates set `members` from assignees and can discard follower semantics if reused carelessly.
- There is no durable mail-work ↔ Lark-task projection or task-event reconciliation today.
- Mail arrival rules and mail-derived work policies need separate tools, models, workers, and UI concepts.

## 15. Implementation ownership map

Likely areas; exact files should follow local patterns after inspection:

- `advance-backend/src/application/work-intelligence/` — state machine, evaluator, policy, projection service.
- `advance-backend/src/infrastructure/persistence/` — work repositories.
- `advance-backend/src/infrastructure/google/gmail-history.client.ts` — thread/direction ingestion.
- `advance-backend/src/infrastructure/channels/lark/clients/lark-task.client.ts` — member and sync parity.
- `advance-backend/src/application/tools/families/` — shared task service integration and `workAutomations`.
- `advance-backend/src/application/skills/` — router and concise specialist skill.
- `advance-backend/prisma/schema.prisma` — new source-neutral orchestration models.
- `admin/src/pages/workspace/` — member queue, policy builder, health, and admin controls.

## 16. First implementation slice

Do not begin with automatic unreplied reminders. Begin with the smallest honest vertical proof:

1. One Gmail thread produces one source-neutral proposed `WorkItem`.
2. Divo extracts one requested outcome and one evidence-backed owner query.
3. The existing people resolver grounds that query or reports ambiguity.
4. A human confirms owner and followers in Lark.
5. The shared task service creates exactly one Lark Task and stores its GUID.
6. Completing or reassigning the task is reconciled back without being overwritten.

Only after that lifecycle is proven should SLA reminders, auto-create, suggested drafts, or more signal sources be enabled.

## 17. External contract evidence

- Gmail watches can be label-filtered, must be renewed at least every seven days, and notifications may be delayed or dropped; periodic history reconciliation is required: [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push).
- Gmail threads expose ordered conversation messages, while `SENT` is a system label on sent messages: [Gmail threads](https://developers.google.com/workspace/gmail/api/guides/threads), [Gmail labels](https://developers.google.com/workspace/gmail/api/guides/labels).
- Lark Task v2 natively distinguishes assignees and followers, and followers receive task-change notifications: [Lark Task v2 overview](https://open.feishu.cn/document/task-v2/overview).

