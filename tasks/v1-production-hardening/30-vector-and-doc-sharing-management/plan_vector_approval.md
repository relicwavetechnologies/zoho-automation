# Implementation Plan: Vector Share Approval Flow

**Goal:** Change the instant vector sharing button to an approval flow where administrators receive a Lark Direct Message with context and can Approve or Reject the request.

## 1. Request Creation
When the user clicks "Share this chat's knowledge":
- **[MODIFY]** `mastra-orchestration.engine.ts` (`share_vectors` action handler):
  - Do not call `shareConversation()` immediately.
  - Insert a new row into `VectorShareRequest` (PostgreSQL) with `status: 'pending'`.
  - Update the user's message to: _"⏳ Share request sent to administrators for review."_

## 2. Admin Context Fetching
To give admins enough information to approve/reject, they need to see what is being shared.
- **[MODIFY]** `personal-vector-memory.service.ts`:
  - Add `getConversationPreview(companyId, requesterUserId, conversationKey): Promise<string>`.
  - This queries `vectorDocumentRepository.findByConversation` and concatenates the first 3-5 text chunks from the vector payload to build a short preview string.

## 3. Lark Direct Messaging
We must route the approval card directly to admins.
- **[MODIFY]** `lark.adapter.ts`:
  - Update `sendMessage()` to check if the `chatId` looks like an open ID (e.g., starts with `ou_`).
  - If it does, dynamically set `receive_id_type=open_id`.
  - Keep it as `chat_id` for standard channel messages.

## 4. Admin Notification Dispatch
- **[MODIFY]** `mastra-orchestration.engine.ts` (after creating the request):
  - Query `ChannelIdentity` for all users in the company with `aiRole IN ('COMPANY_ADMIN', 'SUPER_ADMIN')` who have a valid `larkOpenId`.
  - For each admin, call `channelAdapter.sendMessage` using their `larkOpenId` as the `chatId`.
  - The message will include the conversation preview (from Step 2) and two actions:
    - `[ Approve ]` (value: `{ requestId, decision: 'approve' }`, style: `primary`)
    - `[ Reject ]` (value: `{ requestId, decision: 'reject' }`, style: `danger`)

## 5. Admin Decision Handling
- **[MODIFY]** `mastra-orchestration.engine.ts`:
  - Add a new block in the card action interceptor at the top of `_runTask` to handle `id === 'admin_share_decision'`.
  - Check the `decision` value.
  - **If Approve:** 
    1. Update `VectorShareRequest` to `approved`.
    2. Call `personalVectorMemoryService.shareConversation(...)` to promote the vectors.
    3. Call `channelAdapter.updateMessage()` to change the admin's card to: _"✅ Request Approved and Vectors Shared."_
  - **If Reject:**
    1. Update `VectorShareRequest` to `rejected`.
    2. Update the admin's card to: _"❌ Request Rejected."_

## 6. Verification Plan
1. **User Request:** A user clicks the share button. Ensure their local message changes to the "pending" state.
2. **Admin Notification:** Verify that all users with `COMPANY_ADMIN` get the direct message from the bot with the context preview.
3. **Approval Flow:**
   - Admin clicks `Approve`.
   - Admin card updates.
   - Vectors in PostgreSQL and Qdrant verify as swapped to `shared`.
4. **Rejection Flow (Optional):** Repeat process but click `Reject` and ensure vectors remain `personal`.
