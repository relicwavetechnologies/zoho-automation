# V0 Shared Agent Context

Use this file as the first reference for any AI/human contributor before opening a task folder.

## Mission
Build a production-credible V0 of EMIAC on top of the existing TypeScript backend template, with clear extension seams for:
- New channels (Slack/WhatsApp)
- New integrations/MCP adapters
- New worker agents

V0 is not the full 17-agent platform. V0 is the stable core spine.

## Current Codebase Baseline
- Runtime: Node.js + TypeScript + Express + Prisma.
- Existing backend lives in `/backend`.
- Existing pattern is module-based (`controller/service/repository/routes`).
- There is no orchestration runtime yet; V0 introduces that.

## Canonical Plan References
- Master architecture doc: `/docs/EMIAC-Architecture-Planning-v3.0.md`
- Repo overview: `/README.md`
- Task operating rules: `/tasks/README.md`
- V0 index and dependency map: `/tasks/v0-emiac/README.md`

## Non-Negotiable V0 Boundaries
1. Lark-first channel support.
2. Adapter boundaries from day 1 (`ChannelAdapter`, `IntegrationAdapter/MCPAdapter`, `AgentRegistry`).
3. Queue-based execution with idempotency and checkpointing.
4. HITL for write/destructive actions.
5. Keep architecture forward-compatible for V1 without rewrites.

## Required Working Rules
1. Claim item in `todo.md` before implementing.
2. Append `progress.md` at end of each work session.
3. If blocked, log exact unblock condition.
4. If scope changes, update that task's `context.md` and note it in `progress.md`.

## Suggested Runtime Shape (V0)
- `backend/src/engine/orchestration`
- `backend/src/engine/agents`
- `backend/src/engine/channels`
- `backend/src/engine/integrations`
- `backend/src/engine/queue`
- `backend/src/engine/state`
- `backend/src/engine/security`
- `backend/src/engine/observability`

If these folders do not exist yet, tasks may create them incrementally.

## Definition of Done For Any Task
1. Functional outcome matches acceptance criteria.
2. `todo.md` statuses are updated with real owner names.
3. `progress.md` includes what changed, verification, and next step.
4. No unresolved ambiguity left for the next assignee.
