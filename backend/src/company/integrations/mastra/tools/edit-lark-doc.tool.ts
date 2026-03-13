import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { larkDocsService, LarkDocsIntegrationError } from '../../../channels/lark/lark-docs.service';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { buildConversationKey } from './conversation-key';

export const editLarkDocTool = createTool({
  id: 'edit-lark-doc',
  description:
    'Edit an existing Lark Doc. Use this when the user asks to update, rewrite, append to, or remove content from an existing Lark Doc.',
  inputSchema: z.object({
    strategy: z.enum(['replace', 'append', 'patch', 'delete']).describe('How to edit the target document'),
    instruction: z.string().min(1).describe('The natural language edit instruction'),
    documentId: z.string().optional().describe('Optional explicit document ID. If omitted, use the latest doc from this chat.'),
    newMarkdown: z.string().optional().describe('Markdown content for replace, append, or section patch operations'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes('edit-lark-doc') && !allowedToolIds.includes('lark-doc-agent')) {
      const name = TOOL_REGISTRY_MAP.get('edit-lark-doc')?.name ?? 'Edit Lark Doc';
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: 'edit-lark-doc',
        label: 'Editing Lark Document',
        icon: 'file-text',
      });
    }

    const conversationKey = buildConversationKey(requestContext as any);
    const latestDoc = conversationKey ? conversationMemoryStore.getLatestLarkDoc(conversationKey) : null;
    const documentId = inputData.documentId?.trim() || latestDoc?.documentId;

    if (!documentId) {
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'edit-lark-doc',
          label: 'Edit failed: No document ID',
          icon: 'x-circle',
        });
      }
      return {
        answer: 'No prior Lark Doc was found in this conversation. Please specify the document ID or create a doc first.',
        error: 'missing_document_id',
      };
    }

    try {
      const credentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const result = await larkDocsService.editMarkdownDoc({
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
        documentId,
        instruction: inputData.instruction,
        newMarkdown: inputData.newMarkdown,
        strategy: inputData.strategy,
      });

      if (conversationKey) {
        conversationMemoryStore.addLarkDoc(conversationKey, {
          title: latestDoc?.title ?? 'Lark Doc',
          documentId: result.documentId,
          url: result.url,
        });
      }

      if (requestId) {
        const answer = `Updated Lark Doc: ${result.url}`;
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'edit-lark-doc',
          label: 'Edited Lark Document',
          icon: 'file-text',
          externalRef: result.documentId || result.url,
          resultSummary: answer,
        });
      }

      return {
        answer: `Updated Lark Doc: ${result.url}`,
        documentId: result.documentId,
        url: result.url,
        blocksAffected: result.blocksAffected,
      };
    } catch (error) {
      const message = error instanceof LarkDocsIntegrationError ? error.message : error instanceof Error ? error.message : 'unknown_error';
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'edit-lark-doc',
          label: 'Failed to edit document',
          icon: 'x-circle',
          resultSummary: 'Error',
        });
      }
      return {
        answer: `Lark Doc failed: ${message}`,
        error: message,
        documentId,
      };
    }
  },
});
