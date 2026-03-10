import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';

import { larkDocsService, LarkDocsIntegrationError } from '../../../channels/lark/lark-docs.service';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';

const buildConversationKey = (requestContext?: { get: (key: string) => unknown }): string | null => {
  const channel = requestContext?.get('channel');
  const tenant = requestContext?.get('larkTenantKey');
  const chatId = requestContext?.get('chatId');
  if (typeof channel !== 'string' || typeof chatId !== 'string') {
    return null;
  }
  return `${channel}:${typeof tenant === 'string' && tenant.trim() ? tenant.trim() : 'no_tenant'}:${chatId}`;
};

export const createLarkDocTool = createTool({
  id: 'create-lark-doc',
  description:
    'Create a Lark Doc from markdown content by converting markdown into native Lark Doc blocks. Use this when the user asks to create, export, or save a report into Lark Docs.',
  inputSchema: z.object({
    title: z.string().min(1).describe('The document title'),
    markdown: z.string().min(1).describe('Markdown content to import into the new Lark Doc'),
    folderToken: z.string().optional().describe('Optional Lark Drive folder token to place the document into'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes('create-lark-doc') && !allowedToolIds.includes('lark-doc-agent')) {
      const name = TOOL_REGISTRY_MAP.get('create-lark-doc')?.name ?? 'Create Lark Doc';
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: 'create-lark-doc',
        label: 'Creating Lark Document',
        icon: 'file-text',
      });
    }

    try {
      const result = await larkDocsService.createMarkdownDoc({
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        title: inputData.title,
        markdown: inputData.markdown,
        folderToken: inputData.folderToken,
      });

      const conversationKey = buildConversationKey(requestContext as any);
      if (conversationKey) {
        conversationMemoryStore.addLarkDoc(conversationKey, {
          title: result.title,
          documentId: result.documentId,
          url: result.url,
        });
      }

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'create-lark-doc',
          label: 'Created Lark Document',
          icon: 'file-text',
          resultSummary: result.title,
        });
      }

      return {
        answer: result.url
          ? `Created Lark Doc "${result.title}". URL: ${result.url}`
          : `Created Lark Doc "${result.title}". Document ID: ${result.documentId}`,
        title: result.title,
        documentId: result.documentId,
        url: result.url,
        blockCount: result.blockCount,
      };
    } catch (error) {
      const message = error instanceof LarkDocsIntegrationError ? error.message : error instanceof Error ? error.message : 'unknown_error';
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: 'create-lark-doc',
          label: 'Failed to create document',
          icon: 'x-circle',
          resultSummary: 'Error',
        });
      }
      return {
        answer: `Lark Doc creation failed: ${message}`,
        error: message,
      };
    }
  },
});
