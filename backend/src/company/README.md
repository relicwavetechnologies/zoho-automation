# Orchestration V0 Boundary Scaffold

This folder reserves V0 architecture seams so downstream tasks can implement behavior without cross-layer leakage.

## Boundary Modules

- `contracts`: centralized DTO and orchestration contract ownership.
- `channels`: channel adapters that normalize provider-specific payloads.
- `integrations`: adapters for external systems (e.g., Zoho).
- `agents`: base agent contract, registry, and agent implementations.
- `orchestration`: planning, routing, and dispatch logic.
- `queue`: BullMQ runtime and worker controls.
- `state`: checkpoint persistence and orchestration recovery.
- `security`: webhook guards, idempotency, and HITL gates.
- `observability`: logs, metrics, retries, and error taxonomy signals.

## Dependency Direction (V0)

Allowed high-level flow:

`channels -> orchestration -> agents -> integrations`

Cross-cutting boundaries:

- `contracts` can be imported by all boundary modules.
- `queue` and `state` support orchestration execution and recovery.
- `security` gates ingress and guarded execution actions.
- `observability` can instrument every layer.

Disallowed pattern:

- Raw channel payload types imported by `orchestration`, `agents`, `queue`, or `state`.

## Default V0 Agents

- `risk-check`: detects potentially destructive intent keywords.
- `response`: deterministic textual response synthesis helper.
- `zoho-read`: read-only sample fetch through Zoho historical adapter.
- `lark-response`: progress delivery to Lark chat during orchestration.

## V0 Route Entry

- Lark webhook entry is mounted at `/webhooks/lark/events` and must normalize payloads via the channel adapter before any orchestration handoff.
