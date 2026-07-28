# Lark SDK Full-Parity Implementation — Living Plan

> Status: **Implementation — parity baseline complete; gateway expansion active**
>
> Last updated: **2026-07-28**
>
> Scope: implement SDK parity for the eight existing Divo Lark families:
> Documents/Drive, Task v2, Messaging, Calendar, Base, Approval, Meetings, and
> Contacts.
>
> Current implementation focus: **SDK inventory, gateway contracts, provider
> adapters, governance, and verification only. Skill routing is deferred until
> supported-operation gateway parity is complete.**

## 0. How to use this file

- This is the source of truth for Lark SDK parity and its agent-facing skill
  tree.
- Check an item only after implementation, focused tests, and a representative
  Lark run have passed.
- Record changed decisions in the decision log instead of silently rewriting
  the architecture.
- Add adjacent improvements to the backlog; do not expand an active phase.
- Backend contracts, RBAC, HITL, credentials, and provider execution remain
  authoritative even when a recipe is loaded.

### Status legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Verified complete
- `[!]` Blocked or requires a decision

## 1. Goal

Reach auditable parity for the eight target Divo families without putting the
SDK, credentials, or policy inside the agent runtime. The target covers 510
unique SDK endpoints across nine SDK services (`docx` and `drive` jointly form
the Documents/Drive family). Every target operation must be assigned an
explicit state:

- implemented and verified;
- implemented but awaiting live verification;
- blocked by app edition, scope, identity mode, or Lark API limitation;
- intentionally unavailable because Divo policy forbids it;
- not yet implemented, with an owner and rollout phase.

No target operation should be silently absent. The full 1,628-endpoint SDK
inventory remains as a drift detector, but non-target services do not count
toward executable parity.

```text
Lark router
  → family router
  → leaf recipe
  → exact governed operation contract
  → preflight and policy
  → provider execution
  → read-after-write verification
```

The agent should never receive the complete Lark SDK surface in one prompt. It
receives lightweight routing information first and detailed instructions plus
the exact operation schema only for the selected capability.

## 2. Definition of parity

Parity has four separate gates. An operation is not “complete” merely because
an SDK method can be called.

| Gate | Requirement |
|---|---|
| Coverage parity | Every operation in the eight target families is classified against the pinned SDK inventory |
| Gateway parity | Every supported operation has a typed backend contract and provider adapter |
| Governance parity | Token mode, scopes, RBAC action, approval policy, audit behavior, and idempotency are declared |
| Agent parity | The operation is reachable through the router tree, has the necessary recipe guidance, and has truthful verification behavior |

The parity report must calculate each gate independently by SDK version and API
family. “100% inventoried” must not be presented as “100% executable.”

## 3. Decisions

### 3.1 The backend implements parity; skills make it usable

The SDK parity layer lives in `advance-backend`. It owns SDK calls, tokens,
schemas, validation, account selection, RBAC, HITL, auditing, retries, and
verification.

Skills never call the raw SDK, `lark-cli`, `curl`, or Lark HTTP endpoints. They
reference governed Divo operation IDs and explain how to select and sequence
them.

### 3.2 One gateway surface does not mean one giant tool schema

Pi/Desktop continues to call the single Divo gateway surface. Inside the
backend, Lark capabilities remain split into bounded family or sub-family
contracts. Loading thousands of optional fields into one model-facing tool
would undermine parity by making correct selection less reliable.

Exact schemas are progressively loaded from the parity manifest after the
router selects a leaf.

### 3.3 Router skills route; leaf recipes execute

A router contains:

- child names and summaries;
- positive and negative routing examples;
- ambiguity rules;
- the stable slug of the next router or leaf.

A router should not contain full request schemas or broad SDK documentation.
It should not directly execute provider mutations.

A leaf recipe contains:

- positive triggers and anti-triggers;
- required and optional inputs;
- exact governed Divo tool, operation, and argument structure;
- ID and account resolution rules;
- permissions and approval expectations;
- execution order;
- verification and recovery instructions;
- compact correct and incorrect examples.

### 3.4 Search sees summaries, not all instructions

Discovery may search the complete permission-filtered catalogue, but search
results expose only names, summaries, and routing metadata. Full instructions
and operation contracts are loaded only for the selected node.

### 3.5 The traversal path is enforced

The backend records which router and leaf revisions were resolved for the
current run. Operations that require a leaf recipe are blocked before provider
execution when that recipe was not loaded.

The required path is deterministic metadata, not a prompt convention:

```text
tool + operation + intent variant
  → router path
  → required leaf slug and revision
```

Simple, unambiguous direct operations may continue to use their authoritative
tool contract without a mandatory recipe. Advanced, risky, multi-step, or
semantically overlapping operations require the relevant leaf recipe.

### 3.6 Recovery happens before side effects

When Divo selects the wrong family, operation, or argument shape:

1. Preflight blocks the provider call.
2. It returns a structured internal recovery response with the required next
   router or leaf.
3. Divo loads the referenced instructions and rebuilds the call.
4. Divo retries the original operation at most once.
5. A remaining ambiguity becomes one precise user question; a deterministic
   failure becomes a truthful blocker.

Raw schemas, internal skill IDs, and “forgot to load a skill” messages should
not be exposed to the member.

### 3.7 Verification precedes success claims

After a mutation, Divo reads the affected document, task, message, or event
when the provider supports a reliable read. It reports success only after the
expected state is confirmed.

## 4. Parity inventory

The pinned SDK is the machine-readable starting point. A repeatable inventory
generator should record, for every API family and operation:

- SDK package and version;
- service, resource, version, and method;
- HTTP method and endpoint when available;
- request and response type references;
- user, tenant, or app identity mode;
- required scopes;
- pagination and rate-limit behavior;
- mutation/read classification;
- generated SDK method availability versus low-level `request` fallback;
- corresponding Divo tool ID, operation ID, action group, and recipe slug;
- implementation, test, live-verification, and rollout status;
- documented reason when execution is blocked or intentionally unavailable.

The generated inventory should feed a checked-in parity report. CI should fail
when an SDK upgrade introduces unclassified operations.

### Current baseline

The repository currently exposes bounded tools for:

- Approval;
- Base/Bitable;
- Calendar;
- Contacts;
- Documents/Drive content;
- Meetings;
- Messaging;
- Task v2.

The existing `LARK_OPERATION_MATRIX.md` records token modes and selected API
families, but it is not a full SDK inventory. Several clients still use the
official SDK's low-level `request` fallback. These are valid current
implementations, but generated semantic methods should be preferred as each
operation is reviewed.

## 5. Agent navigation tree

```text
lark
├── lark-documents
│   ├── lark-document-create
│   ├── lark-document-checklist
│   ├── lark-document-rich-formatting
│   ├── lark-document-tables-media
│   └── lark-document-precise-editing
├── lark-tasks
│   ├── lark-task-create-update
│   ├── lark-task-collaboration
│   ├── lark-task-comments-attachments
│   └── lark-tasklists-subtasks
├── lark-messaging
│   ├── lark-message-send-reply
│   ├── lark-message-media-files
│   ├── lark-message-reactions-management
│   └── lark-chat-administration
└── lark-calendar
    ├── lark-calendar-event-create-update
    ├── lark-calendar-attendees-availability
    ├── lark-calendar-recurrence
    └── lark-calendar-advanced-settings
```

The full tree will include every inventoried Lark API family, not only the four
shown above. New family branches are created from the parity inventory. A leaf
should be split when its instructions, risk class, or operation surface becomes
difficult to select reliably.

## 6. Example traversal

Member request:

> Add these five items as to-dos inside the Lark document.

Expected resolution:

```text
lark
  → lark-documents
  → lark-document-checklist
  → larkDoc.append_blocks with blockType "todo"
  → fetch/list document blocks
  → confirm native todo blocks exist
```

The document checklist recipe must explicitly distinguish:

- native document `todo` blocks;
- ordinary bullet blocks decorated with checkbox emoji;
- separate Task v2 tasks in the member's task list.

## 7. Runtime lifecycle

### 7.1 Normal path

```text
understand request
  → resolve top-level family
  → resolve family leaf
  → load leaf instructions and permitted operation contract
  → validate account and identifiers
  → preflight required recipe revision
  → enforce RBAC and HITL
  → execute through the backend Lark gateway
  → verify provider state
  → return the confirmed result
```

Resolved nodes should be cached for the current run so follow-up work does not
repeat unchanged traversal.

### 7.2 Recovery path

```text
invalid or mismatched call
  → block before provider execution
  → classify the intended capability when confidence is high
  → return required router/leaf reference
  → load that node
  → rebuild and retry once
  → verify, ask one clarification, or report a blocker
```

No fuzzy family switching is allowed when multiple interpretations remain
credible.

## 8. Implementation phases

### Phase 0 — Freeze the parity baseline

- [x] Record the exact installed Lark SDK package and version.
- [x] Generate the complete service/resource/operation inventory.
- [ ] Compare generated inventory with all current Lark tools and clients.
- [ ] Classify every operation as implemented, missing, blocked, forbidden, or
  awaiting verification.
- [~] Add family and total coverage counts for all four parity gates. Inventory
  totals are implemented; gateway and governance totals remain.
- [x] Make SDK-version drift visible through a deterministic check suitable for
  CI.

### Phase 1 — Canonical operation manifest

- [ ] Define one manifest record for SDK identity, Divo identity, governance,
  implementation, verification, and recipe routing.
- [ ] Make operation IDs stable across SDK patch upgrades.
- [ ] Attach request/response schemas without placing all schemas in model
  context.
- [ ] Declare user-token, tenant-token, and app-only operations explicitly.
- [ ] Declare scopes, action group, HITL, idempotency, pagination, and
  verification policy.
- [ ] Reject unclassified operations from execution.

### Phase 2 — Gateway parity framework

- [ ] Reuse the existing backend-owned connection and token lifecycle.
- [ ] Prefer generated semantic SDK methods for new implementations.
- [ ] Permit official SDK `request` fallback only when a generated method is
  unavailable or defective, and record that fact in the manifest.
- [ ] Normalize provider errors into structured, non-secret Divo results.
- [ ] Add pagination, rate-limit, timeout, cancellation, and retry rules.
- [ ] Add idempotency protection for retryable mutations.
- [ ] Keep exact tool contracts permission-filtered and progressively loaded.

### Phase 3 — Registry and recipe contract

- [x] Define router and leaf node metadata.
- [x] Define stable slugs and revisions.
- [x] Define capability-to-recipe requirements.
- [ ] Define the structured `skill_reference_required` recovery result.
- [ ] Define request-scoped resolved-path tracking.
- [x] Confirm existing nested `SkillFolder.parentId` can represent the tree
  without a schema migration.

### Phase 4 — Hierarchical resolution

- [x] Provision the Lark root router.
- [x] Provision nested family folders and family recipes.
- [ ] Return lightweight child summaries from router resolution.
- [x] Load full instructions only for the selected node.
- [x] Restrict every lookup to permission-visible skills and tools.
- [ ] Cache resolved node IDs and revisions for the run.

### Phase 5 — Preflight and recovery

- [ ] Check required leaf and revision before provider execution.
- [ ] Detect unsupported operation names and argument shapes.
- [ ] Detect high-confidence family mismatches.
- [ ] Recommend the exact next router or leaf in a structured internal result.
- [ ] Permit only one automatic corrected retry.
- [ ] Record the original call, rejection, loaded recipe, retry, and outcome.

### Phase 6 — First vertical slice: document checklist

- [ ] Add the Documents family router.
- [ ] Add the Document Checklist leaf recipe.
- [ ] Map document checklist intent to native `todo` blocks.
- [ ] Reject emoji bullets as a substitute for native to-dos.
- [ ] Distinguish document to-dos from Task v2 creation.
- [ ] Verify created block types through a document read.
- [ ] Exercise the flow in a representative dev Lark conversation.

### Phase 7 — First 50% capability rollout

- [ ] Documents: common rich formatting and precise insertion.
- [ ] Task v2: assignees, followers, reminders, comments, and attachments.
- [ ] Messaging: send/reply, media, reactions, pins, and sent-message updates.
- [ ] Calendar: location, reminders, visibility, busy/free, and attachments.
- [ ] Add one happy-path and one recovery-path test per leaf.
- [ ] Review routing and recovery telemetry before expanding.

### Phase 8 — Full SDK family rollout

For each SDK family:

- [ ] Reconcile every SDK operation with the canonical manifest.
- [ ] Implement missing provider adapters and typed Divo contracts.
- [ ] Add scope, identity, RBAC, HITL, audit, and idempotency rules.
- [ ] Add focused contract and client tests.
- [ ] Add a router branch and leaf recipes where agent guidance is required.
- [ ] Verify representative reads and writes against a dev Lark tenant.
- [ ] Publish the family parity percentage and explicit blockers.

Rollout order is based on user value and risk:

1. Documents/Drive, Task v2, Messaging, and Calendar.
2. Base, Contacts, Approval, Meetings, and currently connected families.

### Phase 9 — Advanced and high-risk capabilities

- [ ] Complex Task v2 project structure and custom fields.
- [ ] Group and chat administration.
- [ ] Urgent SMS/phone messaging.
- [ ] Complex document embeds and nesting.
- [ ] Meeting rooms, check-in, and advanced calendar permissions.
- [ ] Bulk mutations and other high-blast-radius operations.

High-risk capability rollout begins only after common operations demonstrate
reliable selection, recovery, governance, and verification.

## 9. Acceptance gates

### SDK coverage

- [ ] The inventory is reproducible from the pinned SDK version.
- [ ] Every discovered operation has an explicit status and reason.
- [ ] SDK upgrades fail CI until new or changed operations are classified.
- [ ] Coverage is reported separately for inventory, gateway, governance,
  agent usability, tests, and live verification.
- [ ] No parity claim counts blocked or forbidden operations as executable.

### Gateway implementation

- [ ] Supported operations have typed input and structured output contracts.
- [ ] User/app/tenant token selection is explicit and tested.
- [ ] Required scopes and permission actions are declared.
- [ ] Mutations have approval and idempotency classifications.
- [ ] Pagination, partial results, cancellation, and rate limits are truthful.
- [ ] Credentials never leave the backend.

### Routing

- [ ] A request loads no unrelated full recipe instructions.
- [ ] The selected path is visible in audit data.
- [ ] Ambiguous requests do not silently choose a destructive or unrelated leaf.
- [ ] Follow-up requests reuse valid resolved nodes.

### Enforcement and recovery

- [ ] A required unresolved leaf blocks execution before side effects.
- [ ] A wrong but recognizable call receives the correct recipe reference.
- [ ] Automatic correction retries no more than once.
- [ ] Permission and approval policy cannot be bypassed through routing.
- [ ] Recovery does not expose internal schemas or identifiers to the member.

### Truthfulness

- [ ] Every supported mutation has an explicit verification strategy.
- [ ] Partial success is reported accurately.
- [ ] An unverified write is never presented as confirmed.
- [ ] Retry behavior cannot silently duplicate a completed mutation.

### Quality and performance

- [ ] Router summaries remain small enough for the target model.
- [ ] Leaf instructions contain only the selected capability.
- [ ] Added resolution latency is measured.
- [ ] First-call success, recovery success, clarification rate, and false-success
  rate are recorded.

## 10. Focused test matrix

| Scenario | Expected result |
|---|---|
| Clear document-checklist request | Resolves Documents → Checklist |
| “Create tasks for me” | Resolves Tasks, not document checklist |
| “Put tasks in this document” | Resolves document checklist |
| Missing required leaf | Provider call blocked; leaf suggested |
| `checkbox` passed as block type | Checklist recipe suggested; corrected once |
| Document token sent to Task v2 | High-confidence family mismatch recovered |
| Ambiguous “add todos” without a target | One clarification asks where they belong |
| Member lacks tool permission | Permission denial; no recipe bypass |
| Approval required | Pending approval; no success claim |
| Provider write succeeds but verification fails | Reports unverified/partial outcome |
| Corrected retry also fails | Stops without a second automatic retry |
| SDK adds a new operation | CI reports it as unclassified |
| Operation lacks token-mode metadata | Registration/readiness fails closed |
| Operation lacks RBAC action | Execution remains unavailable |
| Unsupported Lark edition/scope | Explicit blocked status and recovery guidance |
| Paginated read is truncated | Structured coverage/continuation metadata returned |
| Retryable mutation times out | Idempotency prevents silent duplication |

## 11. Progress tracker

| Milestone | Status | Evidence |
|---|---|---|
| Native Lark document `todo` block support | `[~]` | Local implementation and focused tests completed; deployment/live verification pending |
| Exact pinned SDK baseline | `[x]` | SDK `1.71.0`; 1,628 unique endpoints across 55 services |
| Generated full SDK inventory | `[x]` | `pnpm lark:sdk-parity` and focused drift test |
| Executable parity target | `[x]` | 510 unique endpoints across the nine SDK services backing eight Divo families |
| Document text blocks and formatting | `[~]` | Headings 4–9, ordered, quote, divider, inline styles, and block-style update implemented locally |
| Drive organization operations | `[~]` | Metadata, paginated folder listing, folder creation, file copy, and file move implemented locally |
| Current-tool gap report | `[ ]` | |
| Canonical parity manifest | `[ ]` | |
| Gateway parity framework | `[ ]` | |
| Tree taxonomy initial version | `[x]` | Recorded in this plan |
| Database-only Lark skill runtime | `[x]` | Legacy in-memory Lark skill removed; governed runtime reads company-granted DB skills |
| Router/leaf metadata contract | `[x]` | Tool-free root router plus eight exact operation-aligned family recipes |
| Hierarchical resolver | `[~]` | Root and nested family folders provisioned; preflight enforcement and resolved-path caching remain |
| Preflight recovery gate | `[ ]` | |
| Document checklist vertical slice | `[~]` | Native todo operation and truthful document recipe complete; production/live verification remains |
| First 50% rollout | `[ ]` | |
| Full SDK family rollout | `[ ]` | |
| 100% inventory parity | `[ ]` | |
| 100% supported-operation gateway parity | `[ ]` | |
| Production rollout | `[ ]` | |

## 12. Known repository fit

- The skill registry already has nested folders through
  `SkillFolder.parentId`.
- Current system Lark skills are provisioned from version-controlled backend
  definitions into the database.
- Current governed discovery searches the visible catalogue and selects the
  highest-ranked skill; it does not yet traverse a router tree.
- Existing scheduling behavior provides a precedent for blocking an operation
  until its required recipe has been resolved.
- Current Lark capability tools use family-level `op` enums, so parity work can
  extend existing patterns while splitting a family when its schema becomes
  too broad for reliable progressive disclosure.
- `LARK_OPERATION_MATRIX.md` is a useful governance seed but does not enumerate
  the full pinned SDK surface.

Canonical system recipes should remain version-controlled and be provisioned
to the database. Company-authored procedures may remain database-owned, but
they must use the same governed router and leaf contract.

## 13. Out of scope for the first vertical slice

- Direct SDK, `curl`, or `lark-cli` execution by Divo.
- Moving credentials, RBAC, or HITL into skills or the model runtime.
- Advanced Lark administration or bulk mutation support.
- Refactoring unrelated skill catalogue or orchestration code.
- Wiki, Sheets, Mail, OKR, Attendance, Helpdesk, Hire, CoreHR, Payroll,
  Search, Security, and all other SDK services outside the eight target
  families.

The complete SDK inventory is in scope from Phase 0. Implementing every family
inside the first vertical slice is not.

## 14. Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-07-28 | The primary project is full governed Lark SDK parity | Skill routing alone does not add missing provider capabilities |
| 2026-07-28 | Inventory the entire pinned SDK before broad implementation | Prevents undocumented gaps and allows measurable parity |
| 2026-07-28 | Limit executable parity to the eight existing Divo Lark families | The remaining SDK products are not required for this project |
| 2026-07-28 | Report inventory, gateway, governance, and agent parity separately | Avoids a misleading single “100%” claim |
| 2026-07-28 | Use sequential root → family → leaf routing | Reduces context overload and semantic collisions |
| 2026-07-28 | Search exposes summaries; selection loads instructions | Preserves discovery without flooding the model |
| 2026-07-28 | Enforce required recipes in backend preflight | Prompt-only compliance is not reliable enough |
| 2026-07-28 | Retry a corrected call at most once | Prevents recovery loops and duplicate side effects |
| 2026-07-28 | Start with Documents → Checklist | It reproduces the observed failure and proves the complete pattern |

## 15. Open questions

- [ ] Within the eight target families, should deprecated/beta endpoints be
  executable or classified as intentionally unavailable?
- [ ] Which Lark products are unavailable in the connected tenant edition?
- [ ] Which provider operations must remain intentionally unavailable under
  Divo policy despite SDK support?
- [ ] Which simple Lark operations may execute from contracts without a
  mandatory leaf recipe?
- [ ] Should company-authored leaves be allowed beneath system family routers?
- [ ] What confidence threshold permits automatic family-mismatch recovery?
- [ ] Which writes cannot support read-after-write and need an alternative
  verification signal?
- [ ] What latency budget should hierarchical resolution meet at p50 and p95?
