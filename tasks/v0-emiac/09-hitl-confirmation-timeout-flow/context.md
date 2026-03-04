# Context

## Task
- 09 - HITL Confirmation Timeout Flow

## Objective
- Implement pause for write intent, confirmation callback processing, cancel path, and timeout auto-cancel.

## Dependency
- 06-orchestrator-v0-routing-dispatch, 08-zoho-read-agent-and-lark-response-agent

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
- Focus on safe human approval gating for destructive operations.
- Keep channel, integration, orchestrator, and agent logic separated.
- Do not let platform-specific payload shape leak into core orchestrator contracts.

## V0 DTO Contract Snapshot (Use Exactly)
- NormalizedIncomingMessageDTO fields: channel, userId, chatId, chatType, messageId, timestamp, text, rawEvent.
- OrchestrationTaskDTO fields: taskId, messageId, userId, chatId, status, complexityLevel, orchestratorModel, plan, executionMode.
- AgentInvokeInputDTO fields: taskId, agentKey, objective, constraints, contextPacket, correlationId.
- AgentResultDTO fields: taskId, agentKey, status, message, result, error, metrics.
- ErrorDTO fields: type, classifiedReason, rawMessage, retriable.
- HITLActionDTO fields: taskId, actionId, actionType, summary, requestedAt, expiresAt, status.
- CheckpointDTO fields: taskId, version, node, state, updatedAt.

## DTO Focus For This Task
- Primary DTO impact: HITLActionDTO lifecycle and OrchestrationTaskDTO hitl status transitions.

## State Sync Rules (No Deviation)
- Ingress idempotency key is messageId.
- Queue correlation must preserve taskId and messageId.
- Checkpoint version increments by one on each write.
- Resume uses highest checkpoint version only.
- HITL status transitions are atomic.
- Agent results are append-only history plus latest derived snapshot.

## Additional Sync Constraints For This Task
- Transitions must remain atomic: pending to confirmed/cancelled/expired only.

## Expected Code Touchpoints
- backend/src/engine/orchestration, backend/src/engine/state, backend/src/engine/channels/lark

## Execution Steps
- Add hitl pending state creation; send confirmation message; process confirm/cancel callbacks; enforce expiry timeout behavior.

## Validation
- Confirm resumes flow; cancel stops flow; expiry auto-cancels and notifies user.

## Definition Of Done
- Write safety gate is enforced with clear audit trail in progress logs.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not add complex UI variants beyond required confirmation flow.

## Anti-Hallucination Rules
- Do not invent missing APIs, folders, or DTO fields.
- If a required dependency is missing, document assumption in progress.md before implementing.
- Keep all status and enum additions documented in this file if changed.
