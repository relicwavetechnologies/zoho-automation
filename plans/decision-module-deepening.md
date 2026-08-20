# Deepen the Decision module into the one human ask interface

> Status: **All included phases and approved compatibility cleanup complete**
>
> Created: **2026-08-20**
>
> Executor: **Composer 2.5, Tier B.** Steps name the concrete files and the shape of each edit. Ask one clear question if the code disagrees with a locked decision.
>
> Scope: **The module that opens, delivers, reads, and settles human decisions in `advance-backend/`.**
>
> Parked: **Desktop app work in `jan/`, Pi runtime work in `divo-pi/`, and OAuth/connect resume work.** This job is about the backend Decision module and the adapters that already call it.

## 1. Outcome

The Decision module becomes the only backend module that opens and settles a human ask. When a manager approval, requester confirmation, or automation batch needs a person, the producer still owns its domain facts, but it no longer writes approval rows, chooses delivery, stores card message ids, or repeats settlement rules itself.

`ApprovalGateService` keeps authority resolution, RBAC policy, connection-owner policy, idempotent execution grants, and exact-action replay. `BusinessActionService` keeps requester-owned execution. `AutomationPlanService` keeps batch preflight and execution. The Decision module owns the common human-ask mechanics behind one interface.

After this work, new Lark cards for the included asks use `decision_answer`, web and Desktop continue to read the same rows through `DecisionService.open`, and the approved cleanup removes the old actionable Lark approval-card compatibility surface.

## 2. Scope boundary

### Included

- `tool_action` manager approvals opened by `ApprovalGateService.check`.
- `business_action` requester confirmations opened by `BusinessActionService.prepare`.
- `automation_script_plan` approvals opened by `AutomationPlanService.create`.
- Lark card clicks for new `decision_answer` cards.
- Web and Desktop decision routes that already go through `DecisionService`.
- Focused tests around the Decision module, approval flow, business actions, automation plans, and surface parity.

### Parked, do not spend time here

- `plans/scope-gap-connect-ask.md`. It is related, but narrower. It should resume after the decision card and ask path are centralized.
- OAuth connect asks and `advance-backend/src/application/connections/google-connection-continuation.ts`. The connect plan owns that work.
- `jan/`. Installed Desktop clients keep using `desktop-approvals.routes.ts`; do not change the app.
- `divo-pi/`. Pi is the runtime layer, not the authority for approvals or decisions.
- Reintroducing a separate manager-approval Lark card handler. The approved cleanup has removed that compatibility path.
- Moving RBAC, approval authority, connection policy, or execution grants into the Decision module. That would create duplicate authority.
- Database schema changes. The existing `RuntimeApproval` row shape is enough for this work.

## 3. Locked decisions

**D1. `DecisionService` is the external seam for human asks.** Reason: it already reads and settles approvals for web, Desktop, and native decision cards. Opening rows somewhere else is the source of the duplication.

**D2. Authority stays with the producer modules.** Reason: `ApprovalGateService.inspect` owns RBAC, connection-owner policy, external-forward checks, knowledge mutation routing, manager resolution, and self-bypass. Moving those would violate the no-duplicate-authority rule in `AGENTS.md`.

**D3. Old row kinds stay.** Reason: `tool_action`, `business_action`, and `automation_script_plan` rows feed existing execution and replay paths. This plan deepens the ask interface without a schema migration or a row-kind migration.

**D4. New Lark cards use `decision_answer`.** Reason: `LarkDecisionCardHandler` is already the thin adapter over `DecisionService.answerOne`, while `LarkApprovalCardHandler` repeats load, auth, expiry, resolve, card update, and resume.

**D5. Old approval-card compatibility was temporary.** Reason: delivered cards can outlive a deploy, so the compatibility adapter stayed during migration. Abhishek has now approved the final cleanup, so the old actionable manager-approval card path is removed instead of preserved indefinitely.

**D6. `DecisionContinuation` is not widened.** Reason: native decisions intentionally accept only `{ kind: 'none' }`; legacy rows already project to `{ kind: 'run' }` because they carry executable payloads.

**D7. Delivery uncertainty remains durable.** Reason: `approvalDeliveryUnknownCheckpoint` and `approvalDeliveryFailedCheckpoint` protect exactly-once behaviour when Lark may have accepted a card but the backend lost confirmation.

## 4. Open questions

None.

## 5. Current state

Everything in this section was checked on **2026-08-20**.

- `plans/scope-gap-connect-ask.md` exists and is parked. Verified by opening it. It depends on centralized decision cards but only covers connect asks, so this plan owns the broader Decision module deepening.
- `AGENTS.md` says backend owns identity, permissions, tools, approvals, auditing, and integrations. Verified by reading `AGENTS.md`. This plan keeps that authority in `advance-backend/` and does not touch Pi or Desktop app code.
- The worktree is dirty. Verified by `git status --short` on 2026-08-20. There are active changes in `advance-backend/src/application/decision/decision.service.ts`, `advance-backend/src/application/decision/decision-projection.ts`, `advance-backend/src/domain/decision/decision.ts`, `advance-backend/src/application/approval/business-action.service.ts`, admin decision files, and untracked decision subject files. The executor must preserve unrelated and concurrent work.
- `advance-backend/src/application/decision/decision.service.ts` is 672 lines. Verified by `wc -l`. It says it is "the one place Divo asks a person something and hears back", but the same comment says `ask` has no caller and older paths still write rows and cards.
- `DecisionService.ask` opens native `decision` rows at `advance-backend/src/application/decision/decision.service.ts:218`. It writes the row before delivery, stores `resolvedManagerUserId`, sends a Lark card through `DecisionCourier` only when the surface supports button decisions, and leaves web decisions for the browser to read.
- `DecisionService.settle` starts at `advance-backend/src/application/decision/decision.service.ts:363`. It loads, authorizes, checks expiry, validates answers, resolves through `atomicResolve`, persists the answer, updates the delivered card, and resumes only when the projected continuation says to run.
- `DecisionService.answerOne` starts at `advance-backend/src/application/decision/decision.service.ts:429`. It is the Lark button path for `decision_answer` cards and delegates final settlement to `DecisionService.settle`.
- `DecisionService` currently authorizes by user id and company id. Verified by reading `load` in `advance-backend/src/application/decision/decision.service.ts`. The old Lark approval handler also checks `resolvedManagerOpenId` and `tenantKey`, so phase 1 must preserve that before delegation.
- `advance-backend/src/application/decision/decision-projection.ts` projects native `decision` rows and legacy `tool_action` and `business_action` rows into a `Decision`. Verified by opening the file. It does not yet give automation plan rows a special projection.
- `advance-backend/src/domain/decision/decision.ts` owns the pure rules for `Decision`, `DecisionQuestion`, `DecisionOption`, answer validation, verdict derivation, summaries, and whether a card can answer a question with buttons. Verified by reading the file.
- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.ts` defines the new callback kind `decision_answer`. Its file comment says none of the old card paths has been migrated and nothing calls `DecisionService.ask`.
- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.handler.ts` is 127 lines. Verified by `wc -l`. It parses Lark values, calls `DecisionService.answerOne`, and builds callback cards.
- `advance-backend/src/infrastructure/channels/lark/lark-approval-card.handler.ts` is 318 lines. Verified by `wc -l`. It parses `approval_decision`, repeats approval loading, Lark identity authorization, expiry checks, `atomicResolve`, card updates, and resume decisions.
- `advance-backend/src/application/approval/approval-gate.service.ts` is 1330 lines. Verified by `wc -l`. `check` opens `tool_action` rows at line 213, builds old approval cards at line 336, sends them with `sendDirectCard` at line 348, and handles delivery failures inline. `inspect` starts at line 439 and must stay in this module.
- `ApprovalGateService.decisionFromExisting` starts at `advance-backend/src/application/approval/approval-gate.service.ts:871`. It owns approved grant claiming, executing-state replay, consumed result replay, pending reuse, dispatching delivery barriers, and failed/rejected handling. Do not reimplement that in Decision.
- `advance-backend/src/application/approval/business-action.service.ts` opens `business_action` rows directly in `prepare` at line 76 and writes with `createOrReuseActive` at line 94. `decide` starts at line 172 and owns execution after the requester confirms. Move opening, not execution.
- `advance-backend/src/application/gateway/automation-plan.service.ts` opens `automation_script_plan` rows directly at line 296, builds old automation approval cards at line 355, and sends them through Lark. `AutomationPlanExecutor` remains the batch execution owner.
- `advance-backend/src/application/approval/approval-delivery.ts` owns durable delivery uncertainty helpers. Verified by opening it. Keep those semantics when delivery moves behind the Decision interface.
- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts` dispatches card clicks in this order: workbook conversion, decision card, knowledge review, group mode, generic approval card. Verified by reading lines 302 to 373. The decision card branch already sits before the old branches.
- `advance-backend/src/http/desktop/web-chat.routes.ts` exposes `GET /decisions` and `POST /decisions/:decisionId`, both backed by `DecisionService`. Verified by reading lines 524 to 560.
- `advance-backend/src/http/desktop/desktop-approvals.routes.ts` is the installed-client compatibility adapter. Verified by reading lines 40 to 90. It lists through `DecisionService.openRows` and settles through `DecisionService.settle`.
- Baseline tests passed on 2026-08-20:
  - `node --import tsx --test tests/application/decision.service.test.ts tests/domain/decision.test.ts` returned 57 pass, 0 fail.
  - `node --import tsx --test tests/approval/hitl-flow.test.ts tests/approval/approver-without-lark.test.ts` returned 65 pass, 0 fail.
  - `node --import tsx --test tests/application/business-action.service.test.ts tests/application/automation-plan.service.test.ts` returned 40 pass, 0 fail.
  - `node --import tsx --test tests/application/surface-parity.test.ts tests/application/google-scope-request.test.ts` returned 12 pass, 0 fail.

## 6. The shape

Keep the Decision module deep. The interface should make producers say what they are asking and who may answer, not how to persist it or how to draw cards.

The target interface is a discriminated ask input behind `DecisionService.ask`:

```ts
type DecisionAsk =
  | NativeDecisionAsk
  | ToolActionDecisionAsk
  | RequesterBusinessActionDecisionAsk
  | AutomationPlanDecisionAsk;

type DecisionAskOutcome =
  | {
      ok: true;
      decision: Decision;
      row: RuntimeApprovalRow;
      created: boolean;
      replacedExpired: boolean;
      deliveredVia: 'lark' | 'desktop' | 'web' | 'divo';
      requestState: 'created' | 'reused' | 'dispatching' | 'replaced_expired';
    }
  | {
      ok: false;
      reason: 'invalid' | 'store_failed' | 'delivery_failed' | 'delivery_unknown';
      message: string;
      rowId?: string;
    };
```

That exact type can live in `advance-backend/src/application/decision/decision.service.ts` or in `advance-backend/src/application/decision/decision-ask.ts` (new). Choose the smaller diff, but keep the external seam on `DecisionService`.

For each ask variant, the Decision module owns:

- building the `RuntimeApproval` row input;
- calling `createOrReuseActive`;
- projecting the row into `Decision`;
- deciding whether the ask is visible in Divo only or also delivered to Lark;
- sending a `decision_answer` card for new Lark deliveries;
- storing `decisionMessageId`;
- preserving durable delivery failure or uncertainty state;
- returning a typed ask outcome to the producer.

The producer modules still own:

- deciding whether an ask is required;
- resolving the approver;
- exact authority names and policy source;
- exact payloads, argument hashes, preflighted batches, and execution signatures;
- mapping the ask outcome back to existing gateway return shapes;
- claiming and executing approved work.

The adapter seam is `DecisionCourier`. It may need a richer failure result than it has today, because native decisions can treat a failed card as "visible in Divo", while approval asks must preserve delivery uncertainty. Do not add another Lark adapter just for approvals. Extend this port if needed and keep `LarkDecisionCourier` as the production adapter.

## 7. Phases

### Phase 1 — route old card settlement through Decision ✅ *2026-08-20*

**Goal.** Old `approval_decision` cards settle through `DecisionService.settle` without losing Lark open-id or tenant authorization.

**Files.**

- `advance-backend/src/application/decision/decision.service.ts` - extend `DecisionActor` and `load` for optional Lark card identity checks.
- `advance-backend/src/infrastructure/channels/lark/lark-approval-card.handler.ts` - make it a compatibility adapter that parses old payloads, calls `DecisionService.settle`, and builds the old callback response.
- `advance-backend/src/composition.ts` - wire the handler after `DecisionService` exists, or pass a lazy reference without changing runtime behaviour.
- `advance-backend/tests/application/decision.service.test.ts` - add Decision-level coverage for Lark open-id and tenant mismatch.
- `advance-backend/tests/approval/hitl-flow.test.ts` - keep old card compatibility tests green, adjusting expected internals only where settlement is now delegated.

**Steps.**

- [x] Add optional Lark identity to `DecisionActor`, preferably as `lark?: { openId: string; tenantKey: string }`.
- [x] In `DecisionService.load`, if `actor.lark` is present and the row metadata has `resolvedManagerOpenId`, require it to match.
- [x] In `DecisionService.load`, if `actor.lark` is present and the row metadata has `tenantKey`, require it to match.
- [x] Keep web and Desktop settlement working with no Lark identity by leaving the existing user-id and company-id check in place.
- [x] Change `LarkApprovalCardHandler.handle` so, after parsing `{ kind: 'approval_decision', approvalId, decision }`, it calls `DecisionService.settle(actor, approvalId, confirmAnswer(decision))`.
- [x] Keep the old callback card shape for old cards, but remove duplicated resolve and resume logic from `LarkApprovalCardHandler`.
- [x] Update composition wiring without creating a second `DecisionService`.

**Do not.**

- Do not weaken the old open-id or tenant check.
- Do not move `approvalResumesAutomatically` logic into the handler. `DecisionService.continue` already owns that choice.
- ~~Do not remove `LarkApprovalCardHandler`; it still handles delivered old cards.~~ Superseded by phase 6 after Abhishek approved the old-card compatibility cleanup.

**Gate.** The phase closes only when the Decision tests and approval HITL tests in section 9 pass, and code inspection shows `LarkApprovalCardHandler` no longer calls `atomicResolve` or `resumer.resume` directly.

### Phase 2 — move manager approval opening ✅ *2026-08-20*

**Goal.** `ApprovalGateService.check` still decides authority, but `DecisionService.ask` opens and delivers `tool_action` human asks.

**Files.**

- `advance-backend/src/application/decision/decision.service.ts` - add the `tool_action` ask variant.
- `advance-backend/src/application/decision/decision-ask.ts` (new) - optional type/helper module if keeping the union in `decision.service.ts` makes the file harder to read.
- `advance-backend/src/application/approval/approval-gate.service.ts` - replace direct row creation and card delivery with the Decision ask interface.
- `advance-backend/src/application/approval/approval-delivery.ts` - keep delivery uncertainty helpers in use through the Decision module.
- `advance-backend/src/infrastructure/channels/lark/lark-decision.courier.ts` - return enough delivery detail for approval asks.
- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.ts` - ensure the `tool_action` approval renders as a button-answerable decision.
- `advance-backend/tests/application/decision.service.test.ts` - cover `tool_action` ask row shape, reuse, Lark delivery, no-Lark inbox delivery, and delivery uncertainty.
- `advance-backend/tests/approval/hitl-flow.test.ts` - preserve existing approval gate behaviours.
- `advance-backend/tests/approval/approver-without-lark.test.ts` - preserve Divo inbox delivery.
- `advance-backend/tests/approval/approval-card-builder.test.ts` - keep old builder coverage only for compatibility.

**Steps.**

- [x] Keep `ApprovalGateService.inspect`, `bindKnowledgeApproval`, `decisionFromExisting`, and grant claiming in `ApprovalGateService`.
- [x] Let `ApprovalGateService.check` compute the exact approver, authority, args hash, idempotency namespace, compatibility scopes, requester display, and execution metadata as it does today.
- [x] Move the `createOrReuseActive` call for new `tool_action` rows behind the Decision ask interface.
- [x] Preserve the stored metadata fields currently read by projection, inbox queries, resumer, execution replay, and Desktop compatibility.
- [x] Send new Lark approvals through `LarkDecisionCourier`, so their button value is `decision_answer`.
- [x] Preserve no-Lark behaviour: the row stays pending and visible in Divo instead of failing the tool call.
- [x] Preserve ambiguous Lark delivery behaviour: checkpoint unknown delivery and block exact automatic retry.
- [x] Return the same `ApprovalDecision` shapes from `ApprovalGateService.check` that callers already handle.

**Do not.**

- Do not let Decision decide whether approval is required.
- Do not reimplement `matchesApproval`, execution grants, or terminal checkpoint replay in Decision.
- Do not create a second approval route or a second card handler for new manager approvals.

**Gate.** The phase closes only when the Decision, approval HITL, no-Lark approver, and surface parity tests in section 9 pass, and code inspection shows `ApprovalGateService.check` no longer builds or sends Lark cards directly.

### Phase 3 — move requester confirmation opening ✅ *2026-08-20*

**Goal.** Requester confirmations become Decision asks while `BusinessActionService.decide` keeps the exact execution lifecycle.

**Files.**

- `advance-backend/src/application/decision/decision.service.ts` - add the `business_action` ask variant.
- `advance-backend/src/application/approval/business-action.service.ts` - replace direct row creation in `prepare` with the Decision ask interface.
- `advance-backend/src/application/approval/business-action-routing.ts` - keep routing facts intact if tests require small call-shape adjustments.
- `advance-backend/tests/application/business-action.service.test.ts` - preserve requester-confirmation behaviour.
- `advance-backend/tests/application/decision.service.test.ts` - cover `business_action` ask projection and settlement delegation.

**Steps.**

- [x] Move `business_action` row opening out of `BusinessActionService.prepare`.
- [x] Preserve `resolvedDecisionUserId`, `resolvedManagerUserId`, requester metadata, session metadata, `approvalOrigin: 'gateway'`, and `autoResume: true`.
- [x] Keep `BusinessActionService.decide` unchanged unless the new ask outcome requires a narrow type adjustment.
- [x] Keep web thread extraction working for requester confirmations.
- [x] Return the existing gateway success shape from `prepare`.

**Do not.**

- Do not execute the business action from Decision.
- Do not card requester confirmations in Lark unless existing surface capabilities already require it.
- Do not remove the Desktop compatibility fields.

**Gate.** The phase closes only when the Decision and business-action tests in section 9 pass, and code inspection shows `BusinessActionService.prepare` no longer calls `createOrReuseActive`.

### Phase 4 — move automation plan opening ✅ *2026-08-20*

**Goal.** Automation batch approval uses the same Decision ask interface without changing batch preflight or execution.

**Files.**

- `advance-backend/src/application/decision/decision.service.ts` - add the `automation_script_plan` ask variant.
- `advance-backend/src/application/decision/decision-projection.ts` - project automation rows into a useful `Decision` title, detail, question, continuation, and approver.
- `advance-backend/src/application/gateway/automation-plan.service.ts` - replace direct row creation and card delivery with the Decision ask interface.
- `advance-backend/src/application/gateway/automation-plan.executor.ts` - read only if tests show execution assumptions changed; avoid edits unless needed.
- `advance-backend/tests/application/automation-plan.service.test.ts` - preserve create, reuse, delivery, and executor behaviours.
- `advance-backend/tests/application/decision.service.test.ts` - cover automation-plan projection and answerability.

**Steps.**

- [x] Keep automation preflight, plan hashing, invocation signatures, and executor revalidation in the automation module.
- [x] Move only row opening and Lark delivery behind Decision.
- [x] Preserve existing `automation_script_plan` payload and metadata fields, including `planHash`, `actionCounts`, approver metadata, authority, requester metadata, and delivery mode.
- [x] Project automation rows as one confirm question with the same approve/reject semantics.
- [x] Put the existing batch preview and safety copy into the Decision detail, capped to the same preview count used today.
- [x] Preserve no-Lark inbox behaviour and delivery uncertainty checkpoints.

**Do not.**

- Do not run automation batches from Decision.
- Do not loosen executor revalidation.
- Do not expand automation approvals into a new card family.

**Gate.** The phase closes only when the Decision, automation-plan, approval HITL, and surface parity tests in section 9 pass, and code inspection shows `AutomationPlanService.create` no longer builds or sends Lark cards directly.

### Phase 5 — shrink the old card surface to compatibility ✅ *2026-08-20*

**Goal.** New included asks emit only `decision_answer`; old `approval_decision` code is labelled as compatibility and left in place until cleanup is approved.

**Files.**

- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts` - keep decision handling first and route old approval handling only as compatibility.
- `advance-backend/src/infrastructure/channels/lark/lark-approval-card.handler.ts` - update comments to say it handles old delivered cards only.
- `advance-backend/src/application/approval/approval-card-builder.ts` - update comments to say the old builders are compatibility-only.
- `advance-backend/tests/approval/approval-card-builder.test.ts` - keep coverage for old callback cards until cleanup is approved.

**Steps.**

- [x] Confirm no included producer still calls `buildApprovalCard` or `buildAutomationPlanApprovalCard`.
- [x] Update comments on old card files to match current behaviour.
- [x] Leave old handler wiring intact for delivered cards.
- [x] Add a build-log entry naming what remains compatibility-only and why it was not deleted.

**Do not.**

- Do not delete old handler files in this phase.
- Do not remove tests that prove old cards still settle.
- Do not touch workbook conversion, knowledge review, or group-mode card branches unless a migrated producer requires it.

**Gate.** The phase closes only when all section 9 commands pass and code inspection shows the included producers no longer emit `approval_decision`.

### Phase 6 — remove the approved old card compatibility surface ✅ *2026-08-20*

**Goal.** Remove the old actionable manager-approval Lark card path after Abhishek approval, while keeping the current approval resolution card used by `DecisionService.onResolvedCard`.

**Files.**

- `advance-backend/src/infrastructure/channels/lark/lark-approval-card.handler.ts` - deleted.
- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts` - removed the fallback handler dispatch.
- `advance-backend/src/composition.ts` and `advance-backend/src/server.ts` - stopped constructing and passing the deleted handler.
- `advance-backend/src/application/approval/approval-card-builder.ts` - removed old actionable builders, kept resolution rendering.
- `advance-backend/tests/approval/hitl-flow.test.ts` and `advance-backend/tests/approval/approval-card-builder.test.ts` - removed compatibility-only tests and kept current Decision path coverage.

**Gate.** The phase closes only when `rg` finds no production old-card handler or builder reference, focused approval/decision/automation tests pass, and backend typecheck passes.

## 8. Primary files

**Decision module.**

- `advance-backend/src/application/decision/decision.service.ts`
- `advance-backend/src/application/decision/decision-projection.ts`
- `advance-backend/src/application/decision/decision-ask.ts` (new, optional)
- `advance-backend/src/application/decision/subject-from-tool-action.ts`
- `advance-backend/src/domain/decision/decision.ts`
- `advance-backend/src/domain/decision/decision-subject.ts`

**Producer modules.**

- `advance-backend/src/application/approval/approval-gate.service.ts`
- `advance-backend/src/application/approval/business-action.service.ts`
- `advance-backend/src/application/approval/business-action-routing.ts`
- `advance-backend/src/application/gateway/automation-plan.service.ts`
- `advance-backend/src/application/gateway/automation-plan.executor.ts`

**Approval helpers that must not be duplicated.**

- `advance-backend/src/application/approval/approval-delivery.ts`
- `advance-backend/src/application/approval/approval-origin.ts`
- `advance-backend/src/application/approval/approval-card-builder.ts`
- `advance-backend/src/application/approval/describe-tool-action.ts`

**Lark adapters.**

- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-decision-card.handler.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-decision.courier.ts`
- `advance-backend/src/infrastructure/channels/lark/lark-approval-card.handler.ts`
- `advance-backend/src/infrastructure/channels/lark/lark.webhook.routes.ts`

**HTTP adapters.**

- `advance-backend/src/http/desktop/web-chat.routes.ts`
- `advance-backend/src/http/desktop/desktop-approvals.routes.ts`

**Tests.**

- `advance-backend/tests/application/decision.service.test.ts`
- `advance-backend/tests/domain/decision.test.ts`
- `advance-backend/tests/application/business-action.service.test.ts`
- `advance-backend/tests/application/automation-plan.service.test.ts`
- `advance-backend/tests/application/surface-parity.test.ts`
- `advance-backend/tests/application/google-scope-request.test.ts`
- `advance-backend/tests/approval/hitl-flow.test.ts`
- `advance-backend/tests/approval/approver-without-lark.test.ts`
- `advance-backend/tests/approval/approval-card-builder.test.ts`
- `advance-backend/tests/application/decision-ask.test.ts` (new, optional)

## 9. Verification commands

All commands below were run from `advance-backend/` on **2026-08-20** against the current baseline.

```bash
# Proves the current Decision module rules, projection, ask, settle, and pure answer logic.
node --import tsx --test tests/application/decision.service.test.ts tests/domain/decision.test.ts
```

Result on 2026-08-20: 64 pass, 0 fail. It covers native asks, manager tool asks, automation projection, reuse, no-Lark delivery, uncertain delivery, settlement, and answer validation.

```bash
# Proves approval gate policy, idempotency, delivery states, old Lark card handling, and no-Lark approver behaviour.
node --import tsx --test tests/approval/hitl-flow.test.ts tests/approval/approver-without-lark.test.ts
```

Result on 2026-08-20: 66 pass, 0 fail. It covers new `decision_answer` manager cards, old `approval_decision` compatibility cards, delivery checkpoints, and no-Lark approvers.

```bash
# Proves requester confirmations and automation batch approvals before opening moves into Decision.
node --import tsx --test tests/application/business-action.service.test.ts tests/application/automation-plan.service.test.ts
```

Result on 2026-08-20: 47 pass, 0 fail across the requester-confirmation service and automation plan service/executor tests. The Decision test above covers automation projection.

```bash
# Proves surface grants and Google scope helpers stayed unchanged while this plan was written.
node --import tsx --test tests/application/surface-parity.test.ts tests/application/google-scope-request.test.ts
```

Result on 2026-08-20: 12 pass, 0 fail. It does not prove card rendering quality.

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

## 11. Build log

- 2026-08-20: Handover created from source and test inspection.
- 2026-08-20: Phase 1 complete. `DecisionActor` now accepts optional Lark identity, and `DecisionService.load` keeps the existing user/company authorization while also requiring the stored manager open id and matching any stored tenant key for Lark card settlement. Missing legacy card metadata still returns the old metadata error.
- 2026-08-20: `LarkApprovalCardHandler` is now a compatibility adapter. It still parses object, single-encoded, and double-encoded `approval_decision` values and returns the old resolution card, but it delegates answer validation, authorization, atomic settlement, auditing, and continuation to `DecisionService.settle`. A neutral `followUp` result preserves the old gateway retry toast without moving `approvalResumesAutomatically` into the adapter. Delivered-card PATCHes remain fire-and-forget so the Lark callback is not held on recovery I/O.
- 2026-08-20: Composition constructs the legacy handler after the existing `DecisionService`; no second Decision module was introduced. The old handler and old approval builders remain wired for compatibility.
- 2026-08-20: Gate passed. `node --import tsx --test tests/application/decision.service.test.ts tests/domain/decision.test.ts` returned 59 pass, 0 fail. `node --import tsx --test tests/approval/hitl-flow.test.ts tests/approval/approver-without-lark.test.ts` returned 66 pass, 0 fail, including a regression test that leaves `updateMessageById` pending while the old callback returns. `pnpm typecheck` returned 0. Static inspection found no direct `atomicResolve`, `resumer.resume`, or approval-policy call in `lark-approval-card.handler.ts`.
- 2026-08-20: Phase 2 complete. `ApprovalGateService.check` still owns inspection, authority, exact-match compatibility, knowledge binding, grants, and execution replay. It now passes the exact row facts to `DecisionService.ask`, which owns row creation, `decision_answer` delivery, message-id persistence, and delivery checkpoints. The lazy composition port avoids a construction cycle without creating a second Decision implementation. Gates: 64 Decision/domain, 66 approval/no-Lark, and 12 surface/Google tests passed; `pnpm typecheck` passed.
- 2026-08-20: Phase 3 complete. `BusinessActionService.prepare` now asks the Decision module to open `business_action` rows and preserves requester metadata, session/execution facts, and the existing gateway response. `BusinessActionService.decide` remains the execution owner. Gate: 64 Decision/domain and 13 business-action/routing tests passed; inspection found no `createOrReuseActive` call in `prepare`.
- 2026-08-20: Phase 4 complete. `AutomationPlanService.create` still owns preflight, plan hashing, approval signatures, and the immutable payload, but passes opening and delivery to Decision. Automation rows project to one exact-batch question with the existing 12-call preview cap and safety copy. `AutomationPlanExecutor` was not changed. Gate: 64 Decision/domain, 34 automation service/executor, 66 approval/no-Lark, and 12 surface/Google tests passed.
- 2026-08-20: Phase 5 complete. Included producers no longer call `buildApprovalCard` or `buildAutomationPlanApprovalCard`; new included cards contain `decision_answer`. The old handler, builders, tests, and webhook wiring remain because delivered old cards can still be clicked. Compatibility cleanup remains an Abhishek decision after the old-card TTL.
- 2026-08-20: The broader gateway regression suite exposed its own `BusinessActionService` test factory without the new Decision dependency. It was repaired with the same in-memory approval repository; `node --import tsx --test tests/application/gateway.test.ts` returned 73 pass, 0 fail.
- 2026-08-20: Non-gating `pnpm typecheck:tests` remains red on broad repository diagnostics outside this phase, including Pi root-directory imports, scripts, and unrelated test fixtures. It was not used as a phase gate.
- 2026-08-20: Cold review initially found the missing gateway test dependency. The same reviewer rechecked the fix and the 73-test gateway result; final verdict was `ship`, with no remaining verified findings reported.
- 2026-08-20: Cold review first identified the callback recovery wait. The fire-and-forget correction and regression test were independently rechecked by the same reviewer, who found no remaining verified blockers and returned `ship`.
- 2026-08-20: Post-review correction: `LarkDecisionCardHandler` now uses `SettleOutcome.followUp`, so gateway approvals tell the requester to retry the exact action instead of claiming Divo is continuing. Regression coverage lives in `tests/infrastructure/lark/lark-decision-card.handler.test.ts`.
- 2026-08-20: Post-review correction: after a successful `setDecisionMessageId` checkpoint, `DecisionService.ask` returns a local row reflecting `pending` and the stored message id. The Decision ask test now asserts the immediate outcome is not stale.
- 2026-08-20: Final cleanup approved by Abhishek. Deleted the old Lark approval card handler, removed webhook/composition/server wiring for it, removed the old actionable approval-card builders, and kept only the approval resolution card still used by the current Decision path.

Found, out of scope:

- `plans/scope-gap-connect-ask.md`, OAuth/connect continuation, Desktop app work, and Pi work remain parked.
- The shared `dev` tip also contains landing/onboarding UI and schema-backed personal-approvals work in separate commits. This follow-up keeps the decision fixes isolated and does not rewrite shared history; review or merge those unrelated commits separately.

## 12. Next action

No Decision-module implementation phase remains.
