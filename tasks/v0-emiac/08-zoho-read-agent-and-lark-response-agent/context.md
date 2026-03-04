# Context

## Task
- 08 - Zoho Read Agent And Lark Response Agent

## Objective
- Implement minimal useful worker agents: Zoho read operations and Lark response/progress delivery.

## Dependency
- 07-agent-registry-and-base-agent, 03-channel-abstraction-and-lark-adapter

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
- Focus on delivering user-visible value while keeping write safety boundaries intact.
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
- Primary DTO impact: AgentInvokeInputDTO objective/constraints handling and AgentResultDTO result payload formatting.

## State Sync Rules (No Deviation)
- Ingress idempotency key is messageId.
- Queue correlation must preserve taskId and messageId.
- Checkpoint version increments by one on each write.
- Resume uses highest checkpoint version only.
- HITL status transitions are atomic.
- Agent results are append-only history plus latest derived snapshot.

## Additional Sync Constraints For This Task
- Agent result serialization must be checkpoint-safe and deterministic.

## Expected Code Touchpoints
- backend/src/engine/agents/zoho, backend/src/engine/agents/lark, backend/src/engine/integrations/zoho, backend/src/engine/channels/lark

## Execution Steps
- Implement Zoho read agent via integration adapter; implement Lark response agent; register both; connect orchestrator calls.

## Validation
- End-to-end read task returns useful data and sends user-visible updates.

## Definition Of Done
- Minimum worker set operational for V0 demo flow.
- todo.md updated with owner and final status for every item.
- progress.md contains exact changes, blockers, and next step.

## Non-Goals
- Do not implement write, update, delete actions in this task.

## Anti-Hallucination Rules
- Do not invent missing APIs, folders, or DTO fields.
- If a required dependency is missing, document assumption in progress.md before implementing.
- Keep all status and enum additions documented in this file if changed.
