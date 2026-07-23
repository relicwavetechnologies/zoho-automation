# Divo execution reliability tracker

> Temporary working document. Keep this file until the execution and approval
> acceptance tests below pass. Delete it only after the final regression run is
> reviewed and the durable architecture notes have been moved into normal docs.

## Outcome

Divo should feel like one capable agent doing ordinary work on this Mac while
the backend quietly remains the authority for company identity, RBAC,
connection policy, rate limits, manager approval, credentials, and audit.

The user must always be able to answer four questions:

1. What is Divo doing now?
2. What ran, what changed, and what was only inspected?
3. Why is an approval required, who must approve it, and what exactly will it allow?
4. If work failed or partially completed, what is safe to retry without duplicating data?

## Architecture decision

### Decision

Move toward **normal terminal execution plus a Divo-owned local broker/CLI** for
governed company calls. Do not expose SaaS credentials or make raw backend HTTP
the agent contract.

```text
Pi Bash / Python
  -> local Divo CLI or client
  -> desktop-owned broker
  -> authenticated Divo gateway
  -> RBAC + connection policy + rate limit + manager HITL + audit
  -> SaaS connector
```

The current `divo_python_automation` tool remains temporarily as the working
bridge. It must not be removed until the Bash/CLI path has parity for:

- structured calls and results;
- visible progress and audit correlation;
- local approval;
- backend/Lark approval;
- cancellation, timeouts, and partial-completion reporting;
- credentials that are not copied into scripts or model-visible output.

### Rejected shortcut

Do not teach the model to call the backend with `curl` using a member bearer
token. Backend RBAC would still help, but the token would become available to
arbitrary shell code and logs, local confirmation could be bypassed, and Divo
would have two invocation contracts to maintain.

### Confidence

85%. The target preserves ordinary Bash flexibility without moving enterprise
authority out of `advance-backend`. A small vertical slice must prove the local
broker before retiring the Python tool.

## Approval authority model

Local execution and company authorization are different decisions and must
never be presented as one ambiguous approval.

| Boundary | Owner | Examples | Allowed choices |
| --- | --- | --- | --- |
| Local execution | Person at this Mac | Bash, local Python, file writes | Deny, allow once, allow for this run; persistent device permission is managed separately |
| Gateway mutation | Person at this Mac | Create/update/delete/send/execute through Divo | Deny, allow once, allow Divo mutations for this run |
| Shared/company policy | Backend + connection owner/admin | Shared Gmail send, Meta spend, company writes | Allowed, denied, rate-limited, or pending/rejected manager approval; a local choice cannot bypass it |

An “always allow” grant must be scoped and named. It must never silently mean
“all tools forever.” The first useful scopes are:

- Bash on this device: existing explicit device setting.
- Bash for the current run: approval-card shortcut.
- Divo gateway mutations for the current run: approval-card shortcut.
- Persistent company-tool permissions: connection governance in the backend,
  not a desktop-local bypass.

Every approval outcome returned to the agent must be structured:

```json
{
  "status": "approved | denied | pending | rejected | expired | misconfigured",
  "authority": "local | connection_owner | department_manager | company_admin",
  "scope": "once | run | connection_policy",
  "reason": "human-readable exact reason",
  "retry": "continue | retry_exact | change_request | do_not_retry"
}
```

## Tool-result guidance

Do not inject ad-hoc prompt paragraphs such as “remember this extra point” into
every response. Return small, typed, deduplicable advisories next to data:

```json
{
  "data": {},
  "advisories": [
    {
      "code": "verify_destination_write",
      "level": "required",
      "instruction": "Read back the written range before reporting success."
    }
  ]
}
```

The agent prompt should say that `required` advisories are part of the tool
contract. This gives Sheets, documents, money movement, messaging, and future
tools precise reminders without continuously enlarging the system prompt.

## Evidence run

- Task: `Divo Gmail Operations Analysis`
- Thread: `600b0801-b1b1-40d4-a2c9-509c163ebee2`
- Trace: `~/Library/Application Support/Jan/data/threads/600b0801-b1b1-40d4-a2c9-509c163ebee2/messages.jsonl`
- Requested: up to 500 Gmail messages, complete pagination, one Python workflow,
  four Sheets tabs, read-back verification.
- Observed: four Python workflows, more than 70 gateway calls, repeated local
  approvals, silent pagination loss, partial writes, and a false success claim.

## Failure inventory

### P0 — correctness and trust

- [x] Normalize Gmail structured data before model-facing compaction. The
  current order truncates each page to 20 messages while the continuation token
  advances by the requested page size.
- [x] Preserve honest pagination metadata: returned count, provider page size,
  truncation, and next-page availability must agree.
- [x] Return structured Sheets reads (`values`, `range`, row/column counts), not
  prose that forces fragile parsing.
- [ ] Make verification evidence-based. A script cannot return `verified: true`
  when the read-back is empty or has a header mismatch.
- [ ] Normalize dates before comparison/grouping; never compare display strings
  or group daily volume by full timestamps.
- [ ] Never call omitted records “unparseable.” Distinguish provider omissions,
  Divo truncation, parsing failure, filtering, and deduplication.
- [ ] Report partial completion with created resource IDs and safe retry advice.
  Never claim “no data loss” without reconciled input/output counts.

### P0 — approval reliability

- [ ] Separate local Bash approval, local gateway-mutation approval, and
  backend/Lark approval in protocol, UI copy, state, and audit.
- [x] Add chat-scoped local grants without bypassing backend RBAC, rate limits,
  shared-connection policy, or manager approval.
- [x] Remove device-global local permission controls. Approval choices live only
  on the exact action card and expire when the desktop app stops.
- [ ] Deduplicate identical pending approvals and tell the agent whether it
  should continue, retry the exact action, change it, or stop.
- [ ] Ensure the agent receives backend actions and decisions as structured tool
  results rather than learning about them only from UI cards.

### P1 — execution model

- [ ] Build a small local Divo broker/CLI vertical slice callable from ordinary
  Bash/Python without putting bearer or SaaS tokens in generated scripts.
- [ ] Make ordinary Bash the execution surface for local Python, files,
  subprocesses, and packages; reserve the broker for governed company calls.
- [ ] Preserve worklog labels for the script and each governed operation.
- [ ] Support cancellation and a durable checkpoint containing the existing
  destination ID before any retry.
- [ ] After parity tests, remove the specialized Python tool and stale prompt,
  registration, packaging, tests, and comments in one cleanup change.

### P1 — agent efficiency

- [ ] Prefer one coherent program, but do not impose a rigid one-run rule. A
  natural workflow may inspect/clarify, run one transformation/write program,
  then perform a bounded read-back verification.
- [ ] Prevent mutations used only to discover response shape. Tool contracts
  must be available before execution.
- [ ] Avoid repeated `tools.list`, connection discovery, and schema probes in
  the same run by returning the needed contract once and caching it locally.
- [ ] Keep todos tied to actual evidence; source fetching is not complete after
  a debug sample, and verification is not complete before read-back checks pass.
- [ ] Show semantic progress: fetching page 2, transforming 60 records, writing
  Domain Summary, verifying 46 rows—not generic “running commands.”

### P1 — skill and result routing

- [ ] Stop the agent from reading stale bundled/local company skills. The
  backend registry is authoritative; only fixed helper assets may be local.
- [ ] Ensure the current Python/data-movement recipe is actually resolved before
  a complex transfer workflow.
- [ ] Return connection-selection failure as a real top-level failure, not an
  outer success containing `success: false`.
- [ ] Do not expose connection IDs or internal routing details in ordinary
  user-facing narration.

## Delivery waves

Only one large issue or two small issues may be in progress at once.

### Wave 1 — approval semantics (complete)

- [x] Remove the permission shield, popover, and device-persistent Bash toggle.
- [x] Keep the primary card action bound to the exact displayed action as
  **Allow only this time**.
- [x] Offer **Always allow commands in this chat** only on a Bash approval. It
  suppresses later Bash cards for that chat and nothing else.
- [x] Offer **Give Divo full access to this chat** on recognized local actions,
  with an explicit warning. It suppresses later Bash/edit/write/local-gateway
  cards for that chat only.
- [x] Preserve both chat choices across turns and worker reclamation, but clear
  them on app stop/restart or an explicit chat cleanup.
- [x] Keep every gateway call subject to backend RBAC, connection governance,
  rate limits, and manager/Lark approval regardless of the local chat choice.
- [x] Tests: Bash-only and full-access grants are chat-bound, source-aware, and
  do not change the backend gateway approval result path.

### Wave 2 — Google structured correctness (complete)

**Completed:** source data is normalized before model-facing compaction. Gmail
keeps complete provider-page IDs and exact continuation metadata; Sheets reads
expose structured values/counts, partial-view truth, and required verification
advisories.

- [x] Move Gmail normalization before compaction and preserve pagination truth.
- [x] Add structured Sheets read results and required verification advisories.

### Wave 3 — honest workflow completion (two related issues)

**Next:** reconcile source, transformed, written, and verified counts before a
workflow can claim completion; then normalize dates before grouping.

- [ ] Add reconciliation helpers/counts and partial-completion contracts.
- [ ] Correct date normalization and daily grouping in the data-movement recipe.

### Wave 4 — normal Bash + broker vertical slice (large)

- [ ] Implement one read and one mutation through the local broker/CLI.
- [ ] Prove local approval, backend approval, RBAC, rate limits, audit,
  cancellation, and trace labels end to end.
- [ ] Decide whether to migrate all Python workflows based on this parity test;
  do not run a broad benchmark project.

### Wave 5 — agent efficiency and cleanup (two related issues)

- [ ] Replace repeated discovery with one contract/bootstrap response and typed
  advisories.
- [ ] Remove the old Python tool only after Wave 4 parity and regression tests.

## Acceptance tests

### Approval matrix

- [ ] Bash “allow once” approves exactly one command.
- [ ] Bash “always allow commands in this chat” suppresses later Bash cards in
  that chat only, across later turns.
- [ ] Divo “allow once” approves exactly one prepared mutation.
- [ ] “Give Divo full access to this chat” suppresses later Bash/edit/write and
  local Divo cards in that chat while backend manager approval still triggers
  when policy requires it.
- [ ] A personal connection owner is not sent a manager-approval request merely
  for using their own connection.
- [ ] A shared connection requiring owner/admin approval still pauses in Lark.
- [ ] Stopping one run, a worker crash, and a later turn in the same chat retain
  chat grants; app restart and a new chat require approval again.

### Gmail to Sheets regression

- [ ] Fetch at least three Gmail pages with a requested page size greater than
  20; no IDs are skipped between continuation tokens.
- [ ] Reconcile requested, provider-returned, parsed, filtered, deduplicated,
  written, skipped, and failed counts.
- [ ] Create one spreadsheet and never create a duplicate after partial failure.
- [ ] Read back every tab's header and last populated row using structured data.
- [ ] Dates are ISO-normalized and `first <= last`; Daily Volume keys are dates.
- [ ] Final response includes the spreadsheet link, exact counts, verification
  state, and any partial-completion/retry information.

## Rollback

- Wave 1 is additive. Disable the chat grant and fall back to per-action
  local approval without changing backend policy.
- Wave 2 can fall back to the existing compact text under a compatibility field,
  but must never silently claim complete pagination.
- Wave 4 keeps `divo_python_automation` until the broker path passes parity; if
  the broker fails, revert the CLI registration without losing the current tool.

## Current progress

- [x] Read-only trace investigation completed.
- [x] Existing Bash, Python bridge, local approval, and backend approval paths mapped.
- [x] Target architecture and phased acceptance criteria recorded.
- [x] Wave 1 approval semantics implemented and covered by focused tests.
- [ ] Wave 2 Google structured correctness is next.
