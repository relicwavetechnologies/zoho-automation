# Desktop Session Memory and Document Workflows

## Objective
- Persist desktop threads and integrate desktop conversations with existing personal vector memory, Lark Doc create/edit workflows, and conversation-level state so desktop feels like a durable workspace rather than a stateless chat surface.

## Current State
- Conversation memory store already exists in backend.
- Personal vector memory already stores user and assistant turns for supported request paths.
- Lark Docs create/edit support already exists in backend.
- Desktop-specific thread persistence and Lark Doc references for desktop conversations do not exist yet.

## In Scope
- Persist desktop thread metadata and message history sufficiently for thread reload.
- Ensure desktop chat writes user/assistant turns into personal vector memory with desktop request context.
- Retrieve relevant personal vector memory for subsequent desktop turns.
- Store useful conversation-scoped references such as created/edited Lark Doc IDs/URLs.
- Surface these references in the desktop UI thread experience.

## Out of Scope
- Shared/admin-approved promotion flow changes.
- Local-only desktop memory outside backend authority.
- Full local terminal/file artifact history.

## Locked Decisions
- Desktop conversations use the same personal memory model as existing chat flows: isolated by company and requester user.
- Desktop should reuse current Lark Doc create/edit backend capabilities rather than inventing a new document layer.
- Thread persistence should live in backend state, not only local desktop storage.

## Dependencies
- Existing conversation memory store.
- Existing personal vector memory service.
- Existing Lark Doc create/edit tools and state tracking.
- Desktop chat route from task `03`.

## Implementation Contract
- Add desktop thread and message persistence using the current backend state model or an additive extension of it.
- Make thread listing and thread resume available to the desktop renderer.
- Ensure document references created during a conversation remain associated with that thread/session.
- Keep personal vector ingestion and retrieval behavior enabled for desktop.

## Risks
- Treating desktop sessions as transient and losing conversation continuity.
- Forgetting to persist created/edited Lark Doc references, making follow-up edits unreliable.
- Splitting memory logic between desktop-local state and backend state in a way that causes drift.

## Acceptance Criteria
- [ ] Desktop users can reopen prior threads and reload their messages.
- [ ] Desktop conversations store and retrieve personal vector memory for later turns.
- [ ] Lark Doc create/edit references remain associated with the relevant desktop thread.
- [ ] Thread reload restores enough context for document follow-ups such as “edit that doc”.
- [ ] Backend remains source of truth for desktop session/thread state.
