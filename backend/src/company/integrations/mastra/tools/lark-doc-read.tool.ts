import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { larkDocsService, LarkDocsIntegrationError } from '../../../channels/lark/lark-docs.service';
import { conversationMemoryStore } from '../../../state/conversation';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { buildConversationKey } from './conversation-key';

const TOOL_ID = 'lark-doc-read';

export const larkDocReadTool = createTool({
  id: TOOL_ID,
  description: 'Read or inspect a Lark Doc by document ID or the latest doc in this conversation.',
  inputSchema: z.object({
    action: z.enum(['read', 'inspect']).default('read'),
    documentId: z.string().optional().describe('Optional explicit document ID. Falls back to the latest doc in this conversation.'),
    query: z.string().optional().describe('Optional case-insensitive text filter applied to the returned document text.'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID) && !allowedToolIds.includes('lark-doc-agent')) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const callId = randomUUID();
    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Reading Lark Document',
        icon: 'file-text',
      });
    }

    try {
      const conversationKey = buildConversationKey(requestContext as any);
      const latestDoc = conversationKey ? conversationMemoryStore.getLatestLarkDoc(conversationKey) : null;
      const documentId = inputData.documentId?.trim() || latestDoc?.documentId;
      if (!documentId) {
        return { answer: 'Lark Doc read failed: no document ID was provided and no prior doc was found in this conversation.' };
      }

      const credentialMode = requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      if (inputData.action === 'inspect') {
        const result = await larkDocsService.inspectDocument({
          companyId: requestContext?.get('companyId') as string | undefined,
          larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
          appUserId: requestContext?.get('userId') as string | undefined,
          credentialMode,
          documentId,
        });
        const answer = `Lark Doc is available: ${result.url} (${result.blockCount} block(s)).`;
        if (requestId) {
          emitActivityEvent(requestId, 'activity_done', {
            id: callId,
            name: TOOL_ID,
            label: 'Inspected Lark Document',
            icon: 'file-text',
            externalRef: result.documentId,
            resultSummary: answer,
          });
        }
        return {
          answer,
          ...result,
        };
      }

      const result = await larkDocsService.readDocument({
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
        documentId,
      });

      const normalizedQuery = inputData.query?.trim().toLowerCase();
      const matched = normalizedQuery
        ? result.text.split(/\n{2,}/).filter((section) => section.toLowerCase().includes(normalizedQuery))
        : [];
      const preview = normalizedQuery
        ? (matched.slice(0, 6).join('\n\n').trim() || 'No matching sections were found in this Lark Doc.')
        : result.text.slice(0, 3000);
      const answer = normalizedQuery
        ? `Read Lark Doc: ${result.url}\n\n${preview}`
        : `Read Lark Doc: ${result.url}\n\n${preview}`;

      if (conversationKey) {
        conversationMemoryStore.addLarkDoc(conversationKey, {
          title: latestDoc?.title ?? 'Lark Doc',
          documentId: result.documentId,
          url: result.url,
        });
      }

      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Read Lark Document',
          icon: 'file-text',
          externalRef: result.documentId,
          resultSummary: `Read Lark Doc: ${result.url}`,
        });
      }

      return {
        answer,
        ...result,
        matchedSections: normalizedQuery ? matched : undefined,
      };
    } catch (error) {
      const message = error instanceof LarkDocsIntegrationError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'unknown_error';
      if (requestId) {
        emitActivityEvent(requestId, 'activity_done', {
          id: callId,
          name: TOOL_ID,
          label: 'Lark Doc read failed',
          icon: 'x-circle',
          resultSummary: message,
        });
      }
      return { answer: `Lark Doc read failed: ${message}` };
    }
  },
});
