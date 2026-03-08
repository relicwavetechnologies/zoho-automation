# TODO: Vector and Doc Sharing Management

## Phase 1: Lark Infrastructure
- [x] Modify `LarkChannelAdapter` to support direct messaging via `open_id`.
- [ ] Add `addDocumentMember` to `LarkDocsService` for permission management.
- [ ] Create `lark-directory.service.ts` for resolving user names to OpenIDs.

## Phase 2: Vector Share Approval Flow
- [x] Update `mastra-orchestration.engine.ts` to create `VectorShareRequest` (Postgres) on button click.
- [x] Implement `getConversationPreview` in `personal-vector-memory.service.ts`.
- [x] Implement admin notification logic with interactive cards.
- [x] Implement approval/rejection handlers in the orchestrator.
- [x] Created `VectorShareRequestsPage.tsx` and admin UI route for approving requests.

## Phase 3: Lark Doc Sharing Tool
- [ ] Create `share-lark-doc.tool.ts`.
- [ ] Register tool in `tool-registry.ts`.
- [ ] Update `lark-doc-specialist.agent.ts` instructions to utilize sharing.

## Phase 4: Verification
- [ ] Verify admin notification DMs.
- [ ] Verify vector promotion after approval.
- [ ] Verify doc permission grant to other users.
