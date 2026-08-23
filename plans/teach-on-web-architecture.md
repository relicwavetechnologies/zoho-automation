# Self-updating skill pipeline, end to end

> Status: **Implemented; one local web update applied at revision 2; focused-review and next-turn behavior proof pending**
>
> Created: **2026-08-17**
>
> Re-scoped: **2026-08-22**
>
> Executor: **Codex GPT-5.x, Tier A**
>
> Scope: **One correction-driven skill update from Pi proposal through durable review, approval, projection, and next-turn skill reload.**
>
> Parked: **Media work, governed files, shared memory, Teach UI, Jan/Desktop migration, and Pi core changes.**

## 1. Outcome

- A member corrects a reusable procedure in an ordinary Divo conversation.
- Pi calls `divo_knowledge_review` with the complete replacement skill.
- The backend creates a durable `KnowledgeMutation` before asking anyone to approve it.
- The requester reviews the exact skill content through the existing Decision module.
- A personal skill applies after the requester confirms it.
- A department skill from an ordinary member goes to the current department manager.
- A department manager can confirm and apply their own department skill update in one decision.
- A company skill still needs a different company administrator.
- Approval applies the exact reviewed mutation, projects the `Skill`, writes `SkillVersion`, and bumps `SkillRegistryRevision`.
- The next Pi turn receives a changed native-skill bootstrap digest, replaces the warm Pi process, and uses the new instruction.
- Web and Lark use the same durable backend state. A Redis TTL is never the source of truth for a skill review.

## 2. Scope boundary

### Included

- Skill `create`, `update`, `publish`, and `delete` operations through `divo_knowledge_review`.
- Personal, department, and company skill scopes.
- Requester review of the complete replacement content.
- Department-manager and company-admin approval where policy requires it.
- Department-manager self-approval for department skills only.
- Exact-content hashing, optimistic `baseVersion`, idempotency, actor checks, expiry, and atomic execution claims.
- Durable web and Lark Decision cards.
- Skill projection into `Skill`, `SkillVersion`, access grants, and registry revision.
- Native-skill bootstrap refresh and next-turn Pi process replacement.
- A Development proof that records every durable row and revision in the chain.

### Parked, do not spend time here

- Media understanding and attachment work. It has no phase in this plan.
- Shared-memory review. Keep its current behavior unchanged.
- Governed-file review. Keep its current behavior unchanged.
- Persona learning and manager Teach sessions. A skill is the approved object.
- A `/teach` command, Teach mode, or Teach-specific user interface.
- Jan/Desktop approval migration. Its local confirmation adapter stays as-is.
- Vendored Pi core. The Divo-owned extension and controller already provide the needed seams.
- A new skill editor or approval page. The current Decision card, thread, Home, You, and Team surfaces remain the adapters.
- Automatic skill rewriting from Divo's own opinion. A human correction must start the proposal.
- Merging two different live proposals. The current mutation store rejects a competing live mutation, and this plan preserves that honest conflict.

## 3. Locked decisions

- **D1. Skill updates are an ordinary capability.** There is no Teach feature, command, session, or second write path.
- **D2. The approved object is a skill.** Persona rules are not readable enough to be the object a person approves.
- **D3. The backend remains the authority.** Pi proposes exact content but never writes a skill file or decides RBAC, policy, approval, or scope.
- **D4. The Decision module stores every skill-review question.** Web and Lark render the same durable `RuntimeApproval` row.
- **D5. The exact content is stored before review.** The `KnowledgeMutation` snapshot and its content hash are created before the Decision row.
- **D6. Only explicit correction starts an update.** Divo may act when a member corrects a reusable procedure. It may not propose a change merely because it dislikes an existing skill.
- **D7. Personal scope needs requester review only.** The owner confirms the exact replacement and the mutation applies.
- **D8. Department scope uses current authority.** An ordinary member's confirmed proposal goes to the current manager. A current manager's own confirmed proposal uses the same requester Decision as the authority receipt and applies without asking a second manager.
- **D9. Company scope keeps a distinct administrator.** This plan does not weaken company-wide approval.
- **D10. Manager self-approval is limited to department skills.** Shared memory and governed files keep their current distinct-approver policy.
- **D11. A changed skill becomes active between turns.** The current turn reports that Divo learned it. The next message runs with the new revision.
- **D12. Lark cuts over only after web proof.** The existing Lark skill review works today. Build and prove the durable web path first, then route Lark skill reviews through it.
- **D13. Old skill-specific Redis code does not remain after confirmed cleanup.** Once the cutover proves that branch dead, ask for the required cleanup approval. Keep the Redis workflow only for parked memory and file review behavior that still needs it.
- **D14. Projection failures remain visible.** A queued projection is not reported as a completed skill refresh.
- **D15. People approve the change, not the storage object.** Web and Lark render one backend-derived focused diff from canonical current and proposed skill content. Full markdown, unchanged fields, and fingerprints are not review copy. A change too large for a bounded exact diff is rejected before a Decision opens and must be split.

## 4. Open questions

- None.

## 5. Current state

- The worktree was clean on `dev` at commit `needb232d0e596cb183d02746c8555f393f01b646`. Verified 2026-08-22 with `git status --short --branch`, `git rev-parse HEAD`, and `git rev-parse origin/dev`.
- `divo-pi/divo/extensions/divo-gateway/knowledge-review.ts` registers `divo_knowledge_review`. Web and Lark runs call `knowledge.review.open`; installed Desktop uses its local confirmation path. Verified 2026-08-22 by reading `executeKnowledgeReview`.
- `advance-backend/src/application/gateway/gateway-dispatcher.ts` rejects `knowledge.review.open` unless the caller is an authenticated Lark Pi runtime with matching runtime lease provenance. This is the direct web blocker. Verified 2026-08-22 by reading `openVerifiedLarkKnowledgeReview`.
- `advance-backend/src/application/knowledge/lark-knowledge-review.service.ts` writes the pending requester review and queued decision to Redis for 24 hours. Its comment states that PostgreSQL reconstruction is a separate durability requirement. Verified 2026-08-22 by reading `openReviewRequest`, `handle`, and `processQueuedDecision`.
- The same Lark module handles memory, skills, and files. Removing the whole module would break parked behavior. The skill branch must move without deleting the memory and file paths. Verified 2026-08-22 by reading `openMemoryForRuntime`, `openResourceForRuntime`, and `executeDecision`.
- `advance-backend/src/application/knowledge/knowledge-mutation.service.ts` already owns proposal policy, exact-content hashing, requester confirmation, approval binding, approval acceptance, cancellation, and apply state transitions.
- `advance-backend/src/infrastructure/persistence/knowledge-mutation.repository.ts` serializes proposal and apply operations with advisory locks. It rejects a second live mutation for the same company, kind, target, and logical key.
- `advance-backend/src/application/approval/approval-gate.service.ts` already opens manager and administrator approvals through `DecisionService.ask`, binds the approval row to the mutation before delivery, and refuses approval before requester review.
- `advance-backend/src/application/decision/decision.service.ts` already provides durable ask, inbox, authority, expiry, answer validation, atomic settlement, and continuation for web and Lark.
- Native decisions cannot execute a continuation. A skill review therefore needs its own durable row kind and a knowledge-owned settlement path, like `business_action`, instead of pretending a native Decision can run a tool.
- `advance-backend/src/application/approval/business-action.service.ts` proves the needed pattern: a producer opens a Decision row, Decision settlement delegates the whole producer-owned lifecycle, and exact arguments are claimed once before execution.
- `advance-backend/src/application/approval/business-action-presentation.ts` already knows how to describe exact knowledge proposal content, but `decision-projection.ts` does not project that full presentation into the current web card.
- `advance-backend/src/application/knowledge/knowledge-review-presentation.ts` now derives a bounded exact diff from canonical current and proposed skill content, verifies the proposed content hash, and rejects oversized changes before review.
- `admin/src/pages/workspace/decisions/decision.view.tsx` renders only changed fields and focused instruction lines. It does not render the complete skill or SHA-256 fingerprint.
- `advance-backend/src/application/knowledge/knowledge-projection.service.ts` updates or creates the projected `Skill`, increments its revision, rewrites access grants, writes `SkillVersion`, and bumps the company registry revision in one transaction.
- Skill slug collision is still detected in the outbox projection after approval. It must move to proposal validation so a person never approves a mutation that cannot project.
- `advance-backend/src/application/skills/knowledge-provisioning.ts`, `advance-backend/src/domain/knowledge/knowledge-mutation.ts`, and `advance-backend/prisma/sql/knowledge-invariants.sql` currently require a distinct approver for every shared mutation. Department-manager self-approval therefore needs an explicit, skill-only policy and database change. It is not only a row update.
- `divo-pi/divo/native-skills.mjs` hashes the complete validated skill bootstrap and scope. `divo-pi/divo/runtime-warm-process.mjs` includes that digest in `piProcessBinding`, and `divo-pi/divo/local-rpc-controller.mjs` discards a warm Pi process when the digest changes.
- Focused backend baseline passed on 2026-08-22: 146 tests, 0 failures.
- Pi knowledge-review baseline passed on 2026-08-22: 8 tests, 0 failures.
- Pi controller baseline passed on 2026-08-22: 64 tests, 0 failures.
- Admin Decision baseline passed on 2026-08-22: 29 tests, 0 failures.

## 6. The shape

The finished flow is:

```text
explicit correction
  -> divo_knowledge_review
  -> knowledge.review.open
  -> KnowledgeSkillReviewService.open
  -> KnowledgeMutation awaiting_requester_review
  -> Decision awaiting the requester
  -> requester confirms exact content
  -> KnowledgeSkillReviewService.decide
     -> personal: apply
     -> department manager requester: bind same Decision, apply
     -> ordinary department member: open manager Decision, wait
     -> company: open distinct admin Decision, wait
  -> KnowledgeOutbox
  -> Skill + SkillVersion + SkillRegistryRevision
  -> next runtime-context bootstrap changes
  -> native skill digest changes
  -> warm Pi process is replaced
  -> next message follows the new skill
```

### Owning module

- Add `KnowledgeSkillReviewService` in `advance-backend/src/application/knowledge/knowledge-skill-review.service.ts` (new).
- Its small interface owns the whole skill requester-review lifecycle:
  - `open(...)` validates the authenticated target, creates or reuses the exact mutation, and opens or reuses the requester Decision.
  - `decide(...)` cancels or confirms the mutation, performs the live authority check, and either applies it or opens the existing manager/admin approval path.
- Keep exact-content validation, policy, versioning, and apply inside `KnowledgeMutationService`.
- Keep generic ask, delivery, inbox, answer, expiry, and atomic settlement inside `DecisionService`.
- Keep manager/admin authority and approval delivery inside `ApprovalGateService` and `ApprovalResolverService`.
- Keep web and Lark as adapters. Neither adapter may store workflow state or reconstruct skill policy.

### Durable records

- `KnowledgeMutation` stores the exact proposed content, content hash, policy snapshot, scope, base version, requester, and mutation status.
- A `RuntimeApproval` row with kind `knowledge_skill_review` stores the requester Decision and exact apply arguments.
- A second existing `tool_action` approval row exists only when a different manager or administrator must approve.
- `KnowledgeOutbox` stores projection work.
- `Skill`, `SkillVersion`, and `SkillRegistryRevision` store the active runtime result.

### Error interface

- Invalid skill schema, unavailable tool IDs, language policy, slug collision, stale base version, unavailable scope, or a competing live mutation fails before a Decision opens.
- An expired requester Decision leaves the mutation unapplied and allows a fresh exact request.
- Rejection cancels the mutation. It never leaves a live mutation blocking the next correction.
- Manager or administrator rejection moves the mutation to `rejected` and closes the linked requester Decision.
- An expired requester or authority Decision cannot leave a live mutation that blocks a fresh correction.
- Changed membership or authority fails at settlement or apply with a named structured reason.
- Projection failure returns `projection: queued` and stays visible in logs and proof evidence.
- A reused request returns the existing Decision and mutation IDs. It does not send another card.

## 7. Phases

### Phase 1 - Durable skill-review module

**Goal.** Put the requester review on durable rows and give the knowledge domain one settlement owner without changing live routing yet.

**Files.**

- `advance-backend/src/application/knowledge/knowledge-skill-review.service.ts` (new) - owns open, cancel, confirm, authority hand-off, and apply coordination.
- `advance-backend/src/application/knowledge/knowledge-skill-review.worker.ts` (new) - reconciles terminal and expired linked Decisions from durable PostgreSQL rows.
- `CONTEXT.md` (new) - names the durable skill-review, linked-Decision, applied, and active-projection concepts.
- `advance-backend/tests/application/knowledge-skill-review.service.test.ts` (new) - tests the module through its interface.
- `advance-backend/src/application/decision/decision.service.ts` - delegates `knowledge_skill_review` settlement to the knowledge owner, as it already does for `business_action`.
- `advance-backend/src/application/decision/decision-projection.ts` - projects the new row kind without inventing tool semantics.
- `advance-backend/src/application/approval/approval-resumer.service.ts` - reports linked approval outcomes through a row-kind-neutral continuation seam.
- `advance-backend/src/application/approval/business-action.service.ts` - becomes one adapter at that linked-decision seam without changing its behavior.
- `advance-backend/src/infrastructure/persistence/runtime-approval.repository.ts` - generalizes linked requester-row transitions beyond `business_action` while keeping allowed row kinds explicit.
- `advance-backend/src/composition.ts` - wires one lazy Decision ask port and one settlement dependency without creating a second Decision implementation.

**Steps.**

- [x] Define the `knowledge_skill_review` row payload from an existing `KnowledgeMutation` and exact apply arguments.
- [x] Implement `open` so the mutation exists before the Decision and an exact retry reuses both.
- [x] Implement reject so it atomically settles the Decision and cancels the mutation.
- [x] Implement approve so it atomically settles and claims the requester Decision before confirming the mutation.
- [x] Route personal approval to apply and shared approval to the existing authority path.
- [x] Replace `parentBusinessActionId` completion with one linked requester-decision interface used by business actions and skill reviews.
- [x] On authority rejection, reject the mutation and close the linked requester Decision.
- [x] On requester or authority expiry, retire the stale mutation before accepting a fresh correction.
- [x] Persist terminal success, waiting-for-authority, failure, and projection-queued results on the requester row.
- [ ] Test wrong actor, wrong company, expired row, authority rejection, changed hash, duplicate answer, restart-safe settlement, and concurrent settlement.

**Gate.** A module test creates a mutation and Decision, discards the module instance, reconstructs it, settles the same Decision once, and observes exactly one of: cancelled, applied, or awaiting authority. No Redis fake appears in the test.

### Phase 2 - Focused exact change on every Decision surface

**Goal.** Let a person understand the exact change without reading the complete storage object or a fingerprint.

> Correction recorded 2026-08-22 after local web proof. The original full-content card was cryptographically exact but unusable. It hid a one-line edit inside roughly 16,000 characters of unchanged skill content. The focused diff below supersedes that presentation choice while keeping the complete mutation and hash as backend authority.

**Files.**

- `advance-backend/src/domain/decision/decision.ts` - carries the focused field and instruction diff plus the non-rendered complete-content hash.
- `advance-backend/src/application/decision/decision-projection.ts` - projects a human skill title, focused summary, and exact diff.
- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.ts` - renders the same focused evidence as web.
- `advance-backend/src/application/knowledge/knowledge-review-presentation.ts` - owns canonical hash verification, bounded exact line diffing, and Lark formatting.
- `admin/src/pages/workspace/decisions/decision.ts` - mirrors the focused evidence value.
- `admin/src/pages/workspace/decisions/decision.view.tsx` - renders changed fields and focused instruction lines with wrapping.
- `advance-backend/tests/application/decision.service.test.ts` - covers projection and settlement.
- `advance-backend/tests/infrastructure/lark/lark-decision-card.handler.test.ts` - covers native Decision callback behavior.
- `admin/src/pages/workspace/decisions/decision.test.ts` - covers the mirrored value rules.

**Steps.**

- [x] Replace full replacement evidence with one canonical focused-change value for web and Lark.
- [x] Derive that value on the backend from the readable current `KnowledgeVersion` and the exact proposed mutation content.
- [x] Verify the proposed complete-content hash before opening the Decision.
- [x] Refuse updates over the bounded diff budget instead of truncating or dumping a complete skill.
- [x] Remove unchanged name, slug, summary, tools, tags, full markdown, and SHA-256 from visible review copy.
- [x] Use `Update <skill name>` and `Apply this change from the next turn?` instead of generic knowledge/apply language.
- [x] Wrap long diff lines and label the final action `Approve change` or `Reject change`.
- [x] Refresh the originating web thread after settlement so the backend-written applied/rejected/failed outcome appears immediately.
- [x] Tell Pi not to duplicate the Decision evidence or pending-state explanation in chat after opening the review.
- [ ] Prove the focused card and immediate applied outcome through the local web UI.

**Gate.** A one-line update displays exactly that line with one context line on either side on both web and Lark. No unchanged metadata, full skill body, or fingerprint is visible. Approving applies the content bound to the same hash and immediately appends the applied revision to the web thread. An update over the review budget opens no Decision and asks for smaller changes.

### Phase 3 - Department-manager self-approval and early rejection

**Goal.** Make the chosen department policy real and stop unprojectable skill proposals before anyone reviews them.

**Files.**

- `advance-backend/src/domain/knowledge/knowledge-mutation.ts` - allows non-distinct approval only for the locked department-skill case.
- `advance-backend/src/application/skills/knowledge-provisioning.ts` - provisions department skill policies with `distinctApprover: false` and increments their policy version.
- `advance-backend/prisma/sql/knowledge-invariants.sql` - preserves database checks while allowing that one case.
- `advance-backend/prisma/migrations/20260822_department_skill_manager_self_approval/migration.sql` (new) - updates Development/Main schema constraints and existing global policy rows safely.
- `advance-backend/src/application/knowledge/knowledge-mutation.service.ts` - rejects a live slug collision before creating a proposal.
- `advance-backend/src/application/knowledge/knowledge-mutation.store.ts` - adds the minimum lookup needed for early collision proof.
- `advance-backend/src/infrastructure/persistence/knowledge-mutation.repository.ts` - implements the lookup and keeps live authority rechecks.
- `advance-backend/src/application/approval/approval-gate.service.ts` - keeps distinct company approval and ordinary-member manager routing.
- `advance-backend/tests/domain/knowledge-mutation-policy.test.ts` - pins the narrow policy exception.
- `advance-backend/tests/approval/knowledge-approval-gate.test.ts` - pins ordinary-member and manager paths.
- `advance-backend/tests/infrastructure/knowledge-mutation-authority.test.ts` - proves live manager authority at apply.

**Steps.**

- [x] Change the policy validator and SQL constraints only for `kind = skill`, `scope = department`.
- [x] Update existing global department-skill policies in the migration and increment their version.
- [x] Keep department memory, department files, and every company mutation distinct-approver.
- [x] Reuse the requester Decision as the bound authority receipt only when the requester is the current department manager.
- [x] Recheck manager authority inside the apply transaction.
- [x] Send an ordinary member's confirmed mutation to the current manager through the existing approval gate.
- [x] Reject a colliding active skill slug, including a system-skill slug, before opening a requester Decision.

**Gate.** The policy tests prove four cases: personal owner confirmation applies; ordinary department member creates two decisions; department manager creates one decision and applies; company administrator still needs a different administrator. A system-skill slug collision creates zero Decision rows.

### Phase 4 - Web skill review cutover

**Goal.** Make `divo_knowledge_review` work from web chat through the durable skill path.

**Files.**

- `advance-backend/src/application/gateway/gateway-dispatcher.ts` - routes skill review opens for web to `KnowledgeSkillReviewService` and keeps the runtime lease check.
- `advance-backend/src/application/gateway/gateway.types.ts` - keeps the existing payload schema and documents the channel-neutral result.
- `advance-backend/tests/application/gateway.test.ts` - replaces the web denial expectation with durable review behavior.
- `divo-pi/divo/extensions/divo-gateway/knowledge-review.ts` - keeps one model-facing tool and reports the durable waiting state plainly.
- `divo-pi/divo/extensions/divo-gateway/knowledge-review.test.ts` - proves web opens the backend-owned review and Desktop stays local.
- `advance-backend/src/http/desktop/web-chat.routes.ts` - keeps settlement through `DecisionService`; no skill-specific route is added.
- `admin/src/pages/workspace/data/use-decisions.ts` - continues to read the same Decision inbox.

**Steps.**

- [x] Accept authenticated web Pi runtime provenance for skill review open.
- [x] Preserve the exact company, user, department, thread, run, and action IDs on the durable row.
- [x] Return the durable review state with the Decision and mutation IDs in structured data.
- [x] Project the requester Decision into the originating thread and the Home, You, and Team Decision lists through existing reads.
- [x] After approval, append a truthful thread outcome for applied, waiting on authority, cancelled, failed, or projection queued.
- [x] Remove the web permission-denied path for skills without weakening lease validation.

**Gate.** A web-originated skill correction opens one Decision in the same `web_...` thread. Confirming it produces either an applied personal skill or one manager/admin Decision. Refreshing the browser before confirmation does not lose the request.

### Phase 5 - Lark skill review cutover and focused cleanup

**Goal.** Route Lark skills through the same durable Decision flow after the web path is proven.

**Files.**

- `advance-backend/src/application/gateway/gateway-dispatcher.ts` - routes Lark `kind: skill` to `KnowledgeSkillReviewService`.
- `advance-backend/src/application/knowledge/lark-knowledge-review.service.ts` - removes skill ownership while retaining parked memory and file behavior.
- `advance-backend/src/application/knowledge/knowledge-review-decision.worker.ts` - remains only for the parked Redis-backed review kinds.
- `advance-backend/src/application/knowledge/knowledge-review-decision.queue.ts` - remains only for the parked Redis-backed review kinds.
- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts` - keeps `decision_answer` ahead of the legacy memory/file callback branch.
- `advance-backend/tests/application/gateway.test.ts` - proves Lark skill routing and unchanged memory/file routing.
- `advance-backend/tests/infrastructure/lark/lark-decision-card.handler.test.ts` - proves skill requester settlement through `decision_answer`.

**Steps.**

- [x] Route only skill review opens to the durable module.
- [x] Deliver the requester Decision through `LarkDecisionCourier`.
- [x] Confirm the skill through `LarkDecisionCardHandler` and `DecisionService.answerOne`.
- [x] Use the user's follow-up authorization to remove the proven-dead Redis skill branch while keeping memory and file review.
- [x] Remove `skill` from the legacy Lark review request types, validation, card builder, and execution branch.
- [x] Keep the legacy memory and file code paths unchanged.
- [x] Remove stale comments that still call the Redis module the owner of every shared knowledge mutation.

**Gate.** A Lark skill correction produces a `decision_answer` card backed by `RuntimeApproval`, with no `lark:knowledge-review:v1:` skill key. Existing shared-memory and governed-file review tests remain green.

### Phase 6 - Full pipeline proof and handoff

**Goal.** Prove the exact reviewed instruction is the instruction Pi follows on the next turn.

**Files.**

- `advance-backend/tests/integration/knowledge-skill-review.e2e.integration.test.ts` (new) - proves the durable backend chain.
- `divo-pi/divo/test/local-rpc-controller.test.mjs` - proves a changed skill digest replaces the warm Pi process for this scenario.
- `plans/hotspot-todos.md` - marks Self-Updating Skill Proof complete only after real Development evidence.
- `plans/teach-on-web-architecture.md` - records IDs, revisions, commands, deviations, and the final gate in the build log.

**Steps.**

- [ ] Add an integration test for Decision to mutation confirmation to authority to apply to projection.
- [ ] Run the Development Cloud-Pi harness under `AGENTS.local.md` and the prescribed local runtime framework.
- [ ] Start with a skill instruction whose output is easy to distinguish.
- [ ] Give an explicit correction and capture the requester Decision.
- [ ] Approve through the real web surface, including manager approval when the requester is an ordinary member.
- [ ] Record the `KnowledgeMutation`, requester `RuntimeApproval`, optional manager `RuntimeApproval`, `KnowledgeOutbox`, `KnowledgeResource`, `KnowledgeVersion`, `Skill`, `SkillVersion`, and `SkillRegistryRevision` IDs and statuses.
- [ ] Send the next message and capture `native_skill_digest_changed` as the Pi process replacement reason.
- [ ] Prove the answer follows the new instruction and would not satisfy the old instruction.
- [ ] Rerun the same exact request and prove no duplicate mutation, Decision, version, or revision appears.
- [x] Update the plan and hotspot todo with the implemented state and the still-pending proof gate.

**Gate.** One evidence bundle shows the full chain from explicit correction to next-turn changed behavior. Every durable ID is recorded, the mutation and projection are terminal, the Pi replacement reason is `native_skill_digest_changed`, and the next answer follows the new skill.

## 8. Primary files

### Skill proposal and mutation authority

- `CONTEXT.md`
- `advance-backend/src/application/knowledge/knowledge-mutation.service.ts`
- `advance-backend/src/application/knowledge/knowledge-mutation.store.ts`
- `advance-backend/src/infrastructure/persistence/knowledge-mutation.repository.ts`
- `advance-backend/src/domain/knowledge/knowledge-mutation.ts`
- `advance-backend/src/application/knowledge/knowledge-content-validator.ts`
- `advance-backend/src/application/knowledge/knowledge-skill-review.service.ts` (new)
- `advance-backend/src/application/knowledge/knowledge-skill-review.worker.ts` (new)

### Human decisions and authority approval

- `advance-backend/src/application/decision/decision.service.ts`
- `advance-backend/src/application/decision/decision-projection.ts`
- `advance-backend/src/domain/decision/decision.ts`
- `advance-backend/src/application/approval/approval-gate.service.ts`
- `advance-backend/src/application/approval/approval-resolver.service.ts`
- `advance-backend/src/application/approval/approval-resumer.service.ts`
- `advance-backend/src/application/approval/business-action.service.ts`
- `advance-backend/src/infrastructure/persistence/runtime-approval.repository.ts`

### Gateway and Pi tool

- `advance-backend/src/application/gateway/gateway-dispatcher.ts`
- `advance-backend/src/application/gateway/gateway.types.ts`
- `advance-backend/src/application/tools/families/knowledge.tool.ts`
- `divo-pi/divo/extensions/divo-gateway/knowledge-review.ts`
- `divo-pi/divo/extensions/divo-gateway/run-prompt.ts`

### Decision adapters

- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.handler.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-decision.courier.ts`
- `advance-backend/src/application/knowledge/knowledge-review-presentation.ts`
- `admin/src/pages/workspace/data/use-decisions.ts`
- `admin/src/pages/workspace/decisions/decision.ts`
- `admin/src/pages/workspace/decisions/decision.view.tsx`

### Projection and runtime refresh

- `advance-backend/src/application/knowledge/knowledge-projection.service.ts`
- `advance-backend/src/application/skills/skill-registry-versioning.ts`
- `advance-backend/src/application/runtime/runtime-context-lifecycle.ts`
- `advance-backend/src/application/skills/native-skill-binding.ts`
- `divo-pi/divo/native-skills.mjs`
- `divo-pi/divo/runtime-warm-process.mjs`
- `divo-pi/divo/local-rpc-controller.mjs`

### Policy and deployment

- `advance-backend/src/application/skills/knowledge-provisioning.ts`
- `advance-backend/prisma/sql/knowledge-invariants.sql`
- `advance-backend/prisma/schema.prisma`
- `advance-backend/prisma/migrations/20260822_department_skill_manager_self_approval/migration.sql` (new)

## 9. Related plans and references

- `AGENTS.md` - backend authority, fail-loud behavior, deep-module rules, and Cloud-Pi testing requirements.
- `plans/decision-module-deepening.md` - complete. It provides the durable Decision module this plan reuses.
- `plans/hotspot-todos.md` - item 2 is the final Self-Updating Skill Proof gate.
- `plans/pi-first-class-harness-quality-audit.md` - active. It owns broad Pi runtime quality, not this skill mutation.
- `plans/pi-cloud-runtime-code-quality-handoff.md` - active. It owns Cloud-Pi runtime modularity and parks Desktop.
- `plans/cloud-pi-runtime-optimization-consistency-and-proof.md` - active. It owns broader runtime performance and consistency proof.
- `plans/skill-intent-routing-and-search.md` - active. It owns skill selection quality, not skill mutation.
- `plans/scope-gap-connect-ask.md` - separate. It owns connection and OAuth waiting behavior.

## 10. Verification commands

These commands passed on 2026-08-22 before implementation. Run the narrow command for the phase first, then the relevant broader suite.

```bash
cd advance-backend
node --import tsx --test tests/application/decision.service.test.ts tests/application/business-action.service.test.ts tests/application/gateway.test.ts tests/application/knowledge-mutation.service.test.ts tests/application/knowledge-projection.service.test.ts tests/approval/knowledge-approval-gate.test.ts tests/tools/knowledge.tool.test.ts
```

- Baseline result: 146 passed, 0 failed.
- Proves the current Decision, gateway, mutation, projection, authority, and knowledge-tool seams.
- Does not prove the new durable skill coordinator until its test joins the command.

```bash
cd divo-pi
node --import tsx --test divo/extensions/divo-gateway/knowledge-review.test.ts
```

- Baseline result: 8 passed, 0 failed.
- Proves the Pi knowledge-review adapter.

```bash
cd divo-pi
node --test divo/test/local-rpc-controller.test.mjs
```

- Baseline result: 64 passed, 0 failed.
- Proves native-skill staging, digest binding, and warm-process replacement mechanics.

```bash
cd admin
pnpm exec tsx --test src/pages/workspace/decisions/decision.test.ts src/pages/workspace/home/upnext.test.ts
```

- Baseline result: 29 passed, 0 failed.
- Proves shared Decision value behavior and home ordering.
- The exact document evidence renderer also needs a focused rendering test in Phase 2.

## How to work this plan

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

## Build log

- 2026-08-22: The plan was re-scoped to the skill-update pipeline only. Completed and deferred media work was removed from this document. No implementation code changed.
- 2026-08-22: Code inspection corrected two earlier claims. The manager approval already uses the Decision module; the missing durable step is requester review. Department-manager self-approval also requires policy validation and SQL constraint changes, not only a policy row update.
- 2026-08-22: Baseline gates passed with 146 backend tests, 8 Pi knowledge-review tests, 64 Pi controller tests, and 29 admin Decision tests.
- 2026-08-22: Implemented the deep `KnowledgeSkillReviewService` with durable mutation-first review, atomic requester Decision plus mutation settlement, authority hand-off, department-manager self-approval, linked authority outcome settlement, terminal retry recovery, and truthful projection states.
- 2026-08-22: Replaced business-action-specific parent metadata and repository names with a linked Decision interface. The resumer still reads `parentBusinessActionId` only as rolling compatibility for approvals written before the rename.
- 2026-08-22: Added canonical skill evidence to Decision projection. Web and Lark now receive name, slug, summary, markdown, tool IDs, tags, and the full mutation content hash from one value.
- 2026-08-22: Routed web and Lark skill opens through the durable module. Removed only the dead skill branch from `LarkKnowledgeReviewService`; shared memory and governed files remain on its Redis worker.
- 2026-08-22: Added early active/system slug conflict checks, deterministic retries after terminal mutations, the narrow department-skill self-approval policy, SQL invariants, and migration `20260822_department_skill_manager_self_approval`.
- 2026-08-22: Knowledge provisioning now reconciles existing global department-skill policy rows to version 2 after schema sync; new defaults alone would have left Development on the old distinct-manager rule.
- 2026-08-22: Corrected stale Decision surface comments and queued-projection success copy. `KnowledgeMutation.status = applied` is no longer described as an active skill when projection is queued or unknown.
- 2026-08-22: Cold review found that linked manager outcomes still depended on a requester retry after a transient settlement failure. Added `KnowledgeSkillReviewWorker`, which reconciles terminal or expired authority rows from PostgreSQL every 15 seconds. The authority row remains the durable source; Redis is not involved.
- 2026-08-22: Cold review found delete Decisions lacked complete skill evidence. Delete review now snapshots the readable active skill into immutable Decision metadata and carries that evidence into the linked authority Decision.
- 2026-08-22: The same cold reviewer verified the corrections and returned no remaining blocker. Behavioral proof is still pending because the user reserved local UI testing.
- 2026-08-22: `pnpm typecheck:tests` remains red on pre-existing unrelated Zoho connection-ID fixtures and cross-root generated Pi imports. The implementation's production typecheck is green; this unrelated test-project debt was not changed or presented as passing.
- 2026-08-22: Static validation after the final edits: backend `pnpm typecheck` passed; admin `pnpm build` passed with existing Browserslist and chunk-size warnings; Pi `npm run divo:types` passed. Per user instruction, no post-implementation test suite or local UI flow was run. Phase gates remain unchecked until behavioral proof exists.
- 2026-08-22: Local web proof exposed two authority gaps before the skill review could open. Read-only `resources.list` entered the apply approval gate, and legacy editable `Skill` rows had no canonical `KnowledgeResource`. The gate now trusts the tool's canonical read action. Startup reconciliation adopted six access-compatible non-system skills, including `cursor-design-html`, without changing live content or access. It reported and left untouched `bike-search` with legacy `global` scope and two finance skills referencing unavailable retired tools.
- 2026-08-22: The first real Cursor update succeeded end to end. Mutation `c04f35bd-aa1c-4f7a-b877-0057fa7031ed` reached `applied`; Decision `a5cde14e-9490-4ce2-9f82-98ce10a72562` reached `consumed`; `cursor-design-html` moved from revision 1 to 2; projection completed.
- 2026-08-22: The same proof rejected the original Phase 2 UX. The card used generic “Edit knowledge · apply” language, showed six mostly unchanged fields, exposed the SHA-256 fingerprint, dumped roughly 16,000 characters of markdown, overflowed long lines, and ended on a dark-mode action with weak contrast. The model then duplicated the diff and stale “review pending” status in chat. Replaced this with backend-derived bounded focused evidence, human title/copy, wrapped lines, explicit approve/reject labels, and no rendered hash or full content.
- 2026-08-22: Approval applied correctly, but the open thread kept the pre-approval model sentence as its latest visible state even though the backend had appended the applied outcome. Decision settlement now refreshes the newest thread page before returning the composer.
- 2026-08-22: User interruption was incorrectly rendered as a red runtime failure and logged by the LLM proxy as upstream unavailability. Web now carries a distinct durable `interrupted` outcome, renders “Interrupted by user.” neutrally, and records the execution as interrupted. The proxy now records client cancellation without an upstream-error log.
- 2026-08-22: Open operational proof issues collected from the same run: concurrent `ExecutionRun` admission logs a Prisma `P2002` before its existing winner-refetch recovery succeeds; a late `/api/desktop/trace` batch receives `403 trace_provenance_required` after interruption terminalizes the run; hot reload once produced a transient mail worker “Response from the Engine was empty”. These did not block the skill update. They remain unclaimed by this plan unless they reproduce outside restart/interruption timing.
- 2026-08-22: Comparing canonical versions 1 and 2 found the proposal also added a trailing blank line that the model-written “one line” diff omitted. Focused evidence now labels blank-line formatting explicitly; it never counts or hides it as an instruction. After the correction, backend `pnpm typecheck` and admin `pnpm build` passed. No behavioral test suite was run; the next local UI proof remains the gate.

## Next action

- Run a second one-line correction in the local web UI. Confirm the card shows only the focused diff, approve it, confirm the applied revision appears immediately in the thread, then send the next message and prove Pi follows the revised instruction. Record the Decision ID, mutation ID, revision, and native skill digest change.
