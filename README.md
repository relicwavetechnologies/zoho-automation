# EMIAC Agentic Orchestration Engine

This repository contains the backend foundation and execution plan for an extensible agent orchestration platform.

## Current Repository Structure

```txt
/backend               TypeScript backend template (current implementation base)
/docs                  Architecture and planning source documents
/tasks                 Execution tasks for team collaboration
/tasks/v0-emiac        Numbered V0 implementation tasks
/tasks/templates       Reusable task file templates
```

## Master Plan

The canonical architecture plan lives here:
- [docs/EMIAC-Architecture-Planning-v3.0.md](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/docs/EMIAC-Architecture-Planning-v3.0.md)

All implementation tasks must map back to this plan by section number.

## Version Separation Matrix

| Version | Goal | Scope | Extensibility Focus |
|---|---|---|---|
| V0 | Working foundation on Lark | Core orchestration flow, queue, idempotency, Redis checkpointing, basic agents, HITL for writes | Introduce stable adapter/registry interfaces from day 1 |
| V1 | Product-ready expansion | Better routing, richer agent set, RBAC hardening, file handling, stronger retries/fallbacks | Add second channel (Slack/WhatsApp) without core rewrites |
| V2 | Enterprise scale | Multi-tenant hardening, advanced security/compliance, proactive intelligence, deep observability | Per-tenant feature flags and faster integration rollout |

## Design Rules For Scalability (V0 -> V1 -> V2)

1. Keep channel logic behind `ChannelAdapter` interfaces.
2. Keep integration logic behind `IntegrationAdapter`/`MCPAdapter` interfaces.
3. Keep agent logic behind `Agent` + `AgentRegistry`.
4. Keep orchestration independent of channel and integration specifics.
5. Do not couple task execution to Lark-only payload formats outside adapter boundary.

## Team Execution Rules (Critical)

To avoid confusion across multiple contributors/agents, every task folder must maintain these files:

1. `context.md`: stable requirements, assumptions, non-goals, dependencies.
2. `todo.md`: actionable checklist with owner and status.
3. `progress.md`: chronological work log with timestamps, decisions, blockers.

Hard rule:
- Start work: claim item in `todo.md`.
- End work session: append update in `progress.md` and update `todo.md` status.
- Never leave a task in-progress without a next-step note.

See [`tasks/README.md`](/Users/abhishekverma/Desktop/Cluster/Projects/cursor/cursorr/tasks/README.md) for the exact convention.
