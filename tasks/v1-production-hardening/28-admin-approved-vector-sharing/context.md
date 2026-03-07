# Admin Approved Vector Sharing

## Why This Task Exists
Personal chat-derived knowledge must not become company-shared automatically. V1 needs an explicit approval path that preserves safety without blocking normal usage.

## Current State
1. Vector visibility workflow is not fully modeled.
2. There is no durable share request entity or approval flow in the current source.
3. Admin review surface is absent.

## In Scope
1. Add `VectorShareRequest` persistence and lifecycle states.
2. Model whole-conversation share requests.
3. Keep normal chat flow unblocked while request is pending.
4. Add admin approve/reject endpoints and admin UI review surface.
5. Enqueue promotion logic that copies or re-scopes vectors after approval.
6. Audit request, decision, and promotion events.

## Out of Scope
1. Lark card approval UX.
2. Partial-conversation or chunk-level approval.
3. Advanced policy engine beyond admin approval.

## Dependencies
27-vector-visibility-personal-shared-public

## Deliverables
1. Share request schema/model and state machine.
2. Admin review endpoints and UI.
3. Promotion queue/job path with auditing.
4. Tests for approve, reject, expire, and pending behavior.

## Exit Criteria
Personal-to-shared vector promotion requires explicit admin approval and leaves normal chat unaffected while pending.
