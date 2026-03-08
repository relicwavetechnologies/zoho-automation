# Implementation Plan: Lark Document Sharing

**Goal:** Allow users to ask the bot to "Make a doc and share it with [User]" and have the bot automatically create the Lark Document and manage the Lark Drive permissions to grant that specific user view/edit access.

## 1. Directory Search Service
To share a document, the bot needs to map a conversational name ("Mr. Wrecker") to a Lark Open ID. 
- **[MODIFY]** `lark.adapter.ts` or **[NEW]** `lark-directory.service.ts`:
  - Add a method to search the cached `ChannelIdentity` table by `displayName`, `email`, or `name` to resolve the `larkOpenId`.

## 2. Docs Service Permissions
Lark Documents reside in Lark Drive. We need a way to modify Drive permissions.
- **[MODIFY]** `lark-docs.service.ts`:
  - Add `addDocumentMember(documentId: string, memberId: string, role: 'view' | 'edit')`.
  - This method will hit the Lark API: `POST /open-apis/drive/v1/permissions/{token}/members`.
  - *Context:* `token` is the `documentId`. The payload needs `member_type: 'openid'` and `member_id: memberId`.

## 3. Tool Registration
Provide the AI agent with a specific tool to invoke sharing.
- **[NEW]** `share-lark-doc.tool.ts`:
  - Input schema: `documentId` (string), `memberName` (string), `role` (enum: view, edit).
  - Execution:
    1. Search for `memberName` in `ChannelIdentity` to get the `larkOpenId`.
    2. Call `larkDocsService.addDocumentMember()`.
    3. Return success/failure to the agent.
- **[MODIFY]** `tool-registry.ts`:
  - Register `share_lark_doc` tool and grant it to `MEMBER`, `COMPANY_ADMIN`, `SUPER_ADMIN`.
- **[MODIFY]** `lark-doc-specialist.agent.ts`:
  - Add `shareLarkDocTool` to the agent's tools list.
  - Update `instructions` so the agent knows: "If the user asks to share the document, first call `create-lark-doc`, then immediately call `share-lark-doc` with the resulting document ID."

## 4. Verification Plan
1. **Database prep:** Ensure there are at least two distinct users synced in `ChannelIdentity` for the company.
2. **Execution:** Send a message to the bot: "Write a summary of our Zoho CRM pipeline and share it with [Name of other user] so they can edit it."
3. **Validation:**
   - The bot replies with the Lark Document URL.
   - The other user checks their Lark instance and sees a notification that a document was shared with them.
   - The other user can successfully open and edit the document.
