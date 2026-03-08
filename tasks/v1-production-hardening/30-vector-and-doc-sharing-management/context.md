# Task Context: Vector and Doc Sharing Management

This task involves two major enhancements to the sharing and permission system within Lark:

1. **Admin-Approved Vector Sharing:** Transitioning from instant vector sharing to an approval-based workflow where administrators review requests before personal context is promoted to company-wide shared context.
2. **Lark Document Sharing & Permissions:** Enabling the bot to not only create documents but also share them with specific users identified in the chat, managing Lark Drive permissions dynamically.

## Key Files
- `backend/src/company/channels/lark/lark.adapter.ts`: Lark messaging and direct routing.
- `backend/src/company/channels/lark/lark-docs.service.ts`: Document creation and permission management.
- `backend/src/company/orchestration/engine/mastra-orchestration.engine.ts`: Business logic for intercepting button clicks and routing approvals.
- `backend/src/company/integrations/vector/personal-vector-memory.service.ts`: Logic for promoting vectors from personal to shared.

## Dependencies
- Lark Open Platform (Docx API, Drive Permissions API, IM API for direct messages).
- PostgreSQL (`VectorDocument`, `VectorShareRequest`, `ChannelIdentity` tables).
- Qdrant (Vector storage synchronization).
