# Context

## Task
- 00 - V0 Scope And Guardrails

## Objective
- Freeze V0 scope boundaries and implementation guardrails so all contributors execute the same target.

## Dependency
- None

## Reference Docs
- README.md (repo overview and V0/V1/V2 boundaries)
- docs/EMIAC-Architecture-Planning-v3.0.md (architecture source)
- docs/ARCHITECTURE-REFERENCE-MAP.md (task to section mapping)
- docs/V0-DTO-SYNC-CONTRACT.md (contract baseline)
- tasks/README.md (execution protocol)
- tasks/v0-emiac/README.md (task dependency map)
- This folder: todo.md and progress.md

## Project Snapshot (Self-Contained)
- Runtime stack: Node.js, TypeScript, Express, Prisma, Redis, BullMQ (V0 target).
- Existing code base is under backend directory with module pattern and loaders.
- V0 delivery goal: Lark-first orchestration core with extension seams for future channels and integrations.
- Safety baseline: idempotency, queue-based execution, checkpointing, human confirmation for write operations.

## V0 Architecture Slice For This Task
- Focus on scope lock, extension seams, and phased execution discipline.
- Keep channel, integration, orchestrator, and agent logic separated.
- Do not let platform-specific payload shape leak into core orchestrator contracts.

## Frozen V0 In-Scope (Must Be Deliverable In V0)
- Lark as the only production channel for ingress and response in V0.
- Normalized inbound message contract and queue handoff with idempotency by `messageId`.
- BullMQ-based orchestration runtime with pause/resume/cancel control primitives.
- Base orchestrator routing for complexity levels L1-L3 only.
- Agent registry and base agent contract with V0-safe status reporting.
- Minimal agents for V0 value path: Zoho read flow and Lark response flow.
- HITL confirmation gate for write/update/delete/execute actions.
- Redis checkpoint persistence and resume from highest checkpoint version.
- Baseline observability, retry behavior, and error taxonomy required for safe operations.
- E2E smoke validation and release checklist for V0 readiness.

## Frozen Out-Of-Scope (Explicitly Not V0)
- Additional channels (Slack, WhatsApp, email, voice) beyond Lark.
- Deep multi-tenant controls, enterprise compliance add-ons, and advanced RBAC hardening.
- Proactive intelligence, autonomous long-running planning, and advanced memory systems.
- Rich file-processing pipelines and heavy document intelligence workflows.
- V1/V2 scale optimizations that are not required for a stable V0 production slice.

## Mandatory Architectural Boundaries
- Channel adapters normalize provider payloads and hide platform-specific schemas.
- Orchestrator consumes normalized DTOs only and never raw channel webhook payloads.
- Agent implementations execute via registry contract and never bypass orchestrator state updates.
- Integration adapter logic remains outside channel and orchestrator packages.
- Queue and checkpoint layers own execution state transitions; business logic cannot mutate checkpoint versions directly.
- HITL transition handling must be atomic and isolated from non-gated action flows.

## Frozen Runtime Status Vocabularies
- `OrchestrationTaskDTO.status`: `pending | running | hitl | done | failed | cancelled`
- `AgentResultDTO.status`: `success | failed | needs_context | hitl_paused | timed_out_partial`
- `HITLActionDTO.status`: `pending | confirmed | cancelled | expired`
- No status additions, renames, or semantic drift without simultaneous updates to this file and `docs/V0-DTO-SYNC-CONTRACT.md`.

## Phase Gates For Downstream Tasks
- Task 01+ must preserve V0 boundary separation and must not leak Lark payload shape into orchestration core.
- Task 03+ must preserve adapter-first design even when only one channel exists in V0.
- Task 06+ must enforce allowed orchestration transitions only (`pending -> running -> hitl/running -> done/failed/cancelled`).
- Task 09 must enforce HITL gating only for write-class actions defined in contract.
- Task 12 signoff must reject release if any V1/V2-only feature is marked required for V0.

## V0 DTO Contract Snapshot (Use Exactly)
- NormalizedIncomingMessageDTO fields: channel, userId, chatId, chatType, messageId, timestamp, text, rawEvent.
- OrchestrationTaskDTO fields: taskId, messageId, userId, chatId, status, complexityLevel, orchestratorModel, plan, executionMode.
- AgentInvokeInputDTO fields: taskId, agentKey, objective, constraints, contextPacket, correlationId.
- AgentResultDTO fields: taskId, agentKey, status, message, result, error, metrics.
- ErrorDTO fields: type, classifiedReason, rawMessage, retriable.
- HITLActionDTO fields: taskId, actionId, actionType, summary, requestedAt, expiresAt, status.
- CheckpointDTO fields: taskId, version, node, state, updatedAt.

## DTO Focus For This Task
- Primary DTOs: OrchestrationTaskDTO status values and AgentResultDTO status vocabulary.

## State Sync Rules (No Deviation)
- Ingress idempotency key is messageId.
- Queue correlation must preserve taskId and messageId.
- Checkpoint version increments by one on each write.
- Resume uses highest checkpoint version only.
- HITL status transitions are atomic.
- Agent results are append-only history plus latest derived snapshot.

## Additional Sync Constraints For This Task
- No new runtime status names without explicit documentation update in this file.

## Expected Code Touchpoints
- README, tasks/v0-emiac/README, this folder files

## Execution Steps
- Document V0 in-scope and out-of-scope; list mandatory boundaries; map all downstream task dependencies; mark frozen decisions.

## Validation
- Dependency graph is coherent; no V1 or V2 feature marked as V0 required.
- All runtime status vocabularies match the DTO contract source document.
- Global V0 guardrail reference is reachable from every task via `tasks/v0-emiac/README.md`.

## Definition Of Done
- V0 boundary list approved and referenced by all task folders.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not write runtime implementation code in this task.

## Anti-Hallucination Rules
- Do not invent missing APIs, folders, or DTO fields.
- If a required dependency is missing, document assumption in progress.md before implementing.
- Keep all status and enum additions documented in this file if changed.
