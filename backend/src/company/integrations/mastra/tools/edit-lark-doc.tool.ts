import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { larkDocsService, LarkDocsIntegrationError } from '../../../channels/lark/lark-docs.service';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';

const buildConversationKey = (requestContext?: { get: (key: string) => unknown }): string | null => {
  const channel = requestContext?.get('channel');
  const tenant = requestContext?.get('larkTenantKey');
  const chatId = requestContext?.get('chatId');
  if (typeof channel !== 'string' || typeof chatId !== 'string') {
    return null;
  }
  return `${channel}:${typeof tenant === 'string' && tenant.trim() ? tenant.trim() : 'no_tenant'}:${chatId}`;
};

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
    const conversationKey = buildConversationKey(requestContext as any);
    const latestDoc = conversationKey ? conversationMemoryStore.getLatestLarkDoc(conversationKey) : null;
    const documentId = inputData.documentId?.trim() || latestDoc?.documentId;

    if (!documentId) {
      return {
        answer: 'No prior Lark Doc was found in this conversation. Please specify the document ID or create a doc first.',
        error: 'missing_document_id',
      };
    }

    try {
      const result = await larkDocsService.editMarkdownDoc({
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
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

      return {
        answer: `Updated Lark Doc. URL: ${result.url}`,
        documentId: result.documentId,
        url: result.url,
        blocksAffected: result.blocksAffected,
      };
    } catch (error) {
      const message = error instanceof LarkDocsIntegrationError ? error.message : error instanceof Error ? error.message : 'unknown_error';
      return {
        answer: `Lark Doc update failed: ${message}`,
        error: message,
        documentId,
      };
    }
  },
});
