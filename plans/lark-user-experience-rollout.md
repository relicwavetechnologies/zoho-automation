# Lark User Experience Rollout

> Living roadmap for making Divo reliable and complete inside Lark.
>
> **Current priority:** Zoho end-to-end readiness
> **Status:** Planning and discovery
> **Owner:** Abhishek / Divo engineering
> **Last updated:** 2026-07-27

---

## 0. How to use this file

This is the source of truth for the Lark UX rollout.

- Add new ideas to the backlog before starting implementation.
- Move an item into a rollout wave only after its scope and acceptance gate are clear.
- Check a todo only when the behavior is implemented, tested, and verified through Lark.
- Record architecture decisions in the decision log with their reasoning.
- Keep product requirements separate from proposed implementation.
- Do not mark a provider “ready” based only on unit tests or desktop behavior.

### Status legend

- `[ ]` Not started
- `[~]` In discovery or active implementation
- `[x]` Verified complete
- `[!]` Blocked or needs a decision

---

## 1. Product goal

A member should be able to do meaningful company work from a Lark conversation
without understanding Divo’s internal tools, credentials, departments, or agent
runtime.

The experience must be:

1. **Reliable** — no silent partial work, duplicate mutations, or bare `Done.`
2. **Context-aware** — current user, department, permissions, and connected account are clear.
3. **Recoverable** — expired auth, changed departments, missing scopes, and interrupted work have an obvious next action.
4. **Governed** — backend RBAC, connection grants, and approvals remain authoritative.
5. **Visible** — progress, results, links, partial failures, and scheduled work are surfaced clearly in Lark.

---

## 2. Rollout order

| Wave | Workstream | Outcome | Status |
|---|---|---|---|
| 1 | Zoho overall | Zoho work is dependable end to end in Lark | **Current** |
| 2 | Personal memory | Every user has understandable, controllable personal memory | Planned; architecture open |
| 3 | Skills ownership and sharing | Users create private skills and managers share them safely | Planned; scope open |
| 4 | Email and scheduling | Detailed email operations and scheduled follow-up work act as one workflow | Planned |
| 5 | Airtable / AITable E2E | The intended table provider flows are verified through real Lark conversations | Planned; naming decision required |

Only Wave 1 is committed as the immediate implementation priority. Later waves
may be reordered after architecture review.

---

## 3. Cross-cutting Lark UX acceptance gate

Every rollout wave must pass these checks.

### Identity and context

- [ ] The Lark user resolves to the correct Divo member.
- [ ] The active department and company context are visible and current.
- [ ] A department or role change invalidates stale context safely.
- [ ] Stale login state produces a clear sign-in-again action, not a generic permission error.
- [ ] `/login`, `/logout`, first-time login, and forced re-auth use one consistent interaction pattern.

### Permissions and connections

- [ ] The backend remains the only RBAC and policy authority.
- [ ] The selected provider connection is explicit when multiple connections are accessible.
- [ ] Missing, revoked, or under-scoped credentials produce a specific recovery action.
- [ ] Members never see or handle provider credentials in chat.
- [ ] Writes and destructive actions use the existing approval policy.

### Execution and presentation

- [ ] Progress accurately describes the current stage.
- [ ] Long runs do not end with only `Done.`
- [ ] Created links and resource identifiers survive final-response synthesis failures.
- [ ] Partial success is reported honestly and is safe to resume.
- [ ] Retrying cannot silently duplicate completed writes.
- [ ] The final message summarizes the outcome and the next useful action.

### Verification

- [ ] Focused unit or contract tests cover changed behavior.
- [ ] A real dev Lark conversation passes the happy path.
- [ ] At least one permission-denied and one recovery path are exercised.
- [ ] Audit/trace evidence can explain what happened without exposing secrets.
- [ ] No neighboring project or production environment is affected.

---

## 4. Wave 1 — Zoho overall readiness

### Goal

Make Zoho the first provider that feels complete, predictable, and supportable
from Lark before expanding the same UX standard to other providers.

### 4.1 Scope inventory

- [ ] List every currently registered Zoho tool and operation.
- [ ] Map each operation to read, create, update, delete, send, or execute.
- [ ] Mark which operations are currently usable from Lark.
- [ ] Mark which operations have focused contract tests.
- [ ] Mark which operations have been verified against a real Zoho account.
- [ ] Identify overlapping or misleading operations and choose one canonical path.
- [ ] Document current account-selection behavior for one and multiple Zoho connections.

### 4.2 Authentication and connection UX

- [ ] Verify first-time Zoho connection from the intended user surface.
- [ ] Verify reconnect after revoked or expired authorization.
- [ ] Verify the correct account is used when a user has multiple connections.
- [ ] Show human-readable connection labels in account selection.
- [ ] Distinguish “no account,” “wrong account,” “missing scope,” and “provider unavailable.”
- [ ] Ensure department changes cannot reuse an unauthorized cached capability context.

### 4.3 Read operations

- [ ] Define a representative E2E scenario for each enabled Zoho product.
- [ ] Verify list, search, get, summary, and report operations with real data.
- [ ] Verify pagination and result limits are disclosed.
- [ ] Verify currency, dates, statuses, customer names, and totals remain accurate.
- [ ] Verify personalized-scope filtering fails closed.
- [ ] Verify empty results are distinguishable from connection or permission failures.

### 4.4 Write operations

- [ ] Inventory every create, update, send, and delete operation exposed to Lark.
- [ ] Confirm exact approval/HITL behavior for each mutation class.
- [ ] Add idempotency or durable duplicate protection where retries are possible.
- [ ] Verify validation errors name the incorrect field and expected value.
- [ ] Verify partial provider success is reported without blindly retrying.
- [ ] Verify destructive operations require explicit authority and confirmation.

### 4.5 Lark conversation quality

- [ ] Define five realistic Zoho prompts used by actual Finance/Operations members.
- [ ] Confirm the correct Zoho capability is selected without tool-name prompting.
- [ ] Keep progress readable during long reports.
- [ ] Return compact summaries with supporting totals and links.
- [ ] Ensure generated Lark Docs use populated tables and native list structure.
- [ ] Confirm final-response recovery preserves created report links.
- [ ] Confirm follow-up questions reuse valid context without repeating expensive reads unnecessarily.

### 4.6 Zoho Wave 1 release gate

- [ ] All agreed Zoho operations are classified as ready, blocked, or intentionally unavailable.
- [ ] Critical read and write scenarios pass through Lark on dev.
- [ ] Permission, revoked-auth, multi-account, and partial-failure paths pass.
- [ ] No open issue can cause silent data corruption, duplicate writes, or false success.
- [ ] A concise operator runbook exists for diagnosing Zoho Lark failures.
- [ ] Abhishek signs off that Zoho is ready before Wave 2 becomes the primary focus.

---

## 5. Wave 2 — Personal memory

### Product requirement

Every user should have personal memory that improves their own Divo experience.
A dedicated memory capability should be available to all authenticated users.

### Confirmed requirements

- [ ] Personal memory is private to the user by default.
- [ ] It is available regardless of department membership.
- [ ] A user can understand what Divo proposes to remember.
- [ ] Sensitive credentials and secret-like values are rejected.
- [ ] Department/company sharing is never inferred from a personal-memory request.

### Architecture decisions still required

- [!] Decide whether the existing `memoryPublishing` tool is the dedicated user-facing tool or only an internal foundation.
- [!] Define automatic memory versus explicit “remember this” behavior.
- [!] Define review, edit, delete, export, and retention behavior.
- [!] Define what memory is injected into Lark conversations and under which compatibility rules.
- [!] Define the boundary between personal, department, and company memory.
- [!] Decide how memory behaves after department changes or company removal.

### E2E scenarios to design

- [ ] Save a harmless personal preference.
- [ ] Use that preference in a later Lark conversation.
- [ ] Review and remove a stored preference.
- [ ] Reject a credential-like fact without echoing it.
- [ ] Deny unauthorized department/company publication without downgrading silently.

---

## 6. Wave 3 — Skills ownership and sharing

### Product requirement

A user can create skills for personal use. A manager with the required authority
can share a reviewed skill with an allowed department or company audience.

### Confirmed requirements

- [ ] Newly created skills are personal/private by default.
- [ ] Skill ownership is visible.
- [ ] Sharing is an explicit action with a visible target audience.
- [ ] Managers can share only to scopes they are authorized to manage.
- [ ] Tool dependencies are revalidated for the target audience.
- [ ] Publishing cannot grant capabilities the recipients do not already hold.

### Scope and architecture decisions

- [!] Decide whether the existing `skillPublishing` tool is sufficient or needs a separate personal-skill surface.
- [!] Define create, draft, test, publish, update, unshare, and archive states.
- [!] Define manager review and approval behavior.
- [!] Define versioning and what happens to conversations using an older skill version.
- [!] Define whether company-wide publishing is administrator-only.
- [!] Define discoverability: personal library, department library, company library.

### E2E scenarios to design

- [ ] Create and use a private skill from Lark.
- [ ] Edit a private skill without affecting a previously shared version.
- [ ] Manager reviews and shares a skill with one department.
- [ ] Unauthorized member cannot share or widen scope.
- [ ] Recipient can discover and use the shared skill only with compatible tools.
- [ ] Manager unshares or replaces a problematic skill safely.

---

## 7. Wave 4 — Email management, forwarding, and scheduling

### Product requirement

Email should support detailed operational work from Lark: finding messages,
understanding threads, drafting/replying/forwarding safely, and scheduling
follow-ups or recurring work as one coherent workflow.

### Email scope to define

- [ ] Search and filter mail by sender, recipient, date, label/folder, and content.
- [ ] Read complete thread context and attachment metadata.
- [ ] Draft new messages, replies, reply-all, and forwards.
- [ ] Preserve recipients, quoted context, and attachments correctly when forwarding.
- [ ] Manage drafts, folders/labels, archive, unread state, and flags where supported.
- [ ] Define which actions always require approval before sending.
- [ ] Prevent duplicate sends during retry or resume.
- [ ] Report partial attachment or recipient failures honestly.

### Scheduling scope to define

- [ ] “Send later” for an approved draft.
- [ ] Schedule a follow-up if no reply is received.
- [ ] Recurring inbox summaries or operational reports.
- [ ] Scheduled searches that create tasks or notify a Lark chat.
- [ ] Pause, resume, edit, run-now, and cancel controls.
- [ ] Clear timezone, owner, delivery target, and next-run visibility.
- [ ] Durable linkage between the schedule and its originating Lark thread.

### Combined E2E scenarios

- [ ] Find a thread, summarize it, draft a forward, approve it, and send once.
- [ ] Draft an email now and schedule delivery for a specified timezone.
- [ ] Schedule a reply-check and notify the originating Lark thread.
- [ ] Edit or cancel scheduled work from Lark.
- [ ] Recover safely when authorization expires before the scheduled execution.

---

## 8. Wave 5 — Airtable / AITable end-to-end testing

### Decision required first

This repository contains two separate integrations:

- **Airtable** — Airtable’s bases/tables product using its managed connection flow.
- **AITable** — `aitable.ai` / APITable using a personal API key and Fusion API.

- [!] Confirm whether this wave covers Airtable, AITable, or both.
- [ ] Keep test plans and user-facing naming separate if both are in scope.

### Airtable E2E checklist

- [ ] Connect and reconnect an Airtable account.
- [ ] Verify accessible bases, schemas, and records.
- [ ] Verify read/search/filter behavior.
- [ ] Verify create/update/delete approvals and duplicate protection.
- [ ] Verify automation operations, including draft versus active state.
- [ ] Verify multi-account selection and under-scoped OAuth recovery.

### AITable E2E checklist

- [ ] Complete the existing plan’s live-account verification wave.
- [ ] Validate a pasted API key before storage.
- [ ] Verify spaces, nodes, datasheets, fields, views, and records.
- [ ] Verify schema-aware record writes across representative field types.
- [ ] Verify 10-record write chunking and 5-QPS behavior.
- [ ] Verify stale-key transition and key-replacement UX.
- [ ] Verify multi-key connection selection.

### Shared Lark gate

- [ ] Natural-language prompts select the correct product.
- [ ] Divo never confuses Airtable terminology with AITable terminology.
- [ ] Real read and approved write scenarios pass through Lark on dev.
- [ ] Errors identify the provider and recovery action precisely.

---

## 9. Discovery inbox

Add ideas here before promoting them into a wave.

- [ ] Lark-native controls for reviewing memories and skills.
- [ ] Unified “My connected accounts” experience inside Lark.
- [ ] Better long-run progress and resumability across provider workflows.
- [ ] User-visible audit trail for completed and approved actions.
- [ ] Notification preferences and quiet hours.
- [ ] Shared report templates and reusable Lark document layouts.
- [ ] Cross-provider workflows after individual providers are stable.

---

## 10. Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-07-27 | Lark UX is the primary product focus. | The next rollout is being designed around complete user journeys inside Lark. |
| 2026-07-27 | Zoho is Wave 1 and must be sorted before broadening focus. | It establishes the reliability and UX standard for later providers. |
| 2026-07-27 | Personal memory needs a capability available to every user. | Personal context should not depend on department access; architecture remains open. |
| 2026-07-27 | Skills are private by default and shareable only with authority. | Creation ownership and distribution authority are different concerns. |
| 2026-07-27 | Email and scheduling are one combined workflow area. | Operational email work frequently requires delayed sends, follow-ups, and recurring checks. |

---

## 11. Immediate next actions

- [ ] Build the Zoho operation/readiness inventory.
- [ ] Select the first five real Zoho-in-Lark E2E scenarios.
- [ ] Classify current Zoho gaps by auth, RBAC, tool correctness, Lark UX, and observability.
- [ ] Hold a focused architecture discussion for personal memory.
- [ ] Confirm whether “Airtable E2E” means Airtable, AITable, or both.
- [ ] Add newly discovered requirements to this file before implementation begins.
