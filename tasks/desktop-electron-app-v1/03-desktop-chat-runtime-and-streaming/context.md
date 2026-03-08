# Desktop Chat Runtime and Streaming

## Objective
- Add a first-class desktop chat runtime path to the backend so desktop requests stream like Lark conversations but are explicitly identified as desktop-originated requests with their own request contract and renderer-friendly event model.

## Current State
- Lark ingress enters through `/webhooks/lark/events`.
- Mastra runtime already exposes streaming under `/api/agents/:agentId/stream`.
- Current orchestration already supports channel-aware behavior, progress updates, tool permissions, vector memory, and multi-engine execution.
- There is currently no desktop-specific request path, no desktop request context, and no renderer-oriented event contract.

## In Scope
- New desktop request route/controller/service in backend.
- New request context fields identifying source/client/channel as `desktop`.
- Streaming contract for renderer consumption:
  - progress/stage updates
  - streamed assistant text
  - optional tool progress/state
  - final completion payload
  - explicit failure payload
- Reuse existing orchestration internally rather than duplicating agent logic.
- Preserve RBAC/tool permissions and AI role checks for desktop users.

## Out of Scope
- Lark webhook changes.
- Replacing Mastra runtime routes.
- Full desktop-thread persistence logic.

## Locked Decisions
- Desktop requests must not masquerade as Lark messages.
- Desktop streaming contract should be purpose-built for the desktop renderer, not inherited from webhook semantics.
- Existing Zoho/Outreach/Lark Doc capabilities remain server-side and must be callable through the same orchestration boundaries.

## Dependencies
- Existing orchestration service and engine selection logic.
- Existing tool permission service and AI role enforcement.
- Existing personal vector memory and conversation memory integrations.

## Implementation Contract
- Add backend desktop chat endpoints under a new module namespace.
- Inject desktop user/session/company metadata into orchestration request context.
- Ensure desktop requests log distinctly from Lark requests.
- Make streaming deterministic and renderer-consumable.
- Preserve failure transparency; never emit false `done` semantics on failed tool execution.

## Risks
- Accidentally bypassing existing RBAC/tool permission checks.
- Reusing an internal runtime contract that is too low-level or admin-oriented for the desktop app.
- Losing parity with Lark behavior for supported tools.

## Acceptance Criteria
- [ ] Desktop has a dedicated backend chat/streaming route.
- [ ] Backend can distinguish desktop requests from Lark requests in logs and request context.
- [ ] Desktop users can invoke Zoho, Outreach, and Lark Doc flows through the same agent stack.
- [ ] Streaming events cover progress, text deltas, completion, and explicit errors.
- [ ] Tool permissions and AI role checks still apply for desktop-originated requests.
