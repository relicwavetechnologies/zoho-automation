import { tool } from 'ai';
import { z } from 'zod';

type CompositeTools = Record<string, any>;

export const buildCompositeRuntimeTools = (tools: CompositeTools): Record<string, any> => ({
  larkTaskLegacy: tools.larkTask,

  larkTask: tool({
    description: 'Lark Tasks operations. operation=read or write.',
    inputSchema: z
      .object({
        operation: z.enum(['read', 'write']),
        taskOperation: z
          .enum([
            'list',
            'listMine',
            'listOpenMine',
            'get',
            'current',
            'listTasklists',
            'listAssignableUsers',
            'create',
            'update',
            'delete',
            'complete',
            'reassign',
          ])
          .optional(),
        taskId: z.string().optional(),
        tasklistId: z.string().optional(),
        query: z.string().optional(),
        summary: z.string().optional(),
        description: z.string().optional(),
      })
      .passthrough(),
    execute: async (input, options) =>
      tools.larkTaskLegacy.execute(
        {
          ...input,
          operation:
            input.operation === 'write' ? input.taskOperation ?? 'create' : input.taskOperation ?? 'list',
        },
        options,
      ),
  }),

  googleWorkspace: tool({
    description:
      'Google Workspace operations for Gmail (sendMessage, searchMessages, createDraft, sendDraft, listMessages, getMessage, getThread), Drive (listFiles, getFile, downloadFile, createFolder, uploadFile, updateFile, deleteFile), and Calendar. Use operation="sendMessage" to send email, operation="searchMessages" to search inbox, operation="createDraft" to draft, operation="drive" for Drive, operation="calendar" for Calendar.',
    inputSchema: z.discriminatedUnion('operation', [
      z
        .object({
          operation: z.literal('sendMessage'),
          to: z.union([z.string().min(1), z.array(z.string().email()).min(1)]),
          subject: z.string().min(1),
          body: z.string().min(1),
          cc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
          bcc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
          isHtml: z.boolean().optional(),
          threadId: z.string().optional(),
        })
        .passthrough(),
      z
        .object({
          operation: z.literal('createDraft'),
          to: z.union([z.string().min(1), z.array(z.string().email()).min(1)]),
          subject: z.string().optional(),
          body: z.string().optional(),
          cc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
          bcc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
          isHtml: z.boolean().optional(),
          threadId: z.string().optional(),
          purpose: z.string().optional(),
          facts: z.array(z.string()).optional(),
        })
        .passthrough(),
      z
        .object({
          operation: z.literal('sendDraft'),
          draftId: z.string().min(1),
        })
        .passthrough(),
      z
        .object({
          operation: z.enum([
            'gmail',
            'drive',
            'calendar',
            'searchMessages',
            'listMessages',
            'getMessage',
            'getThread',
          ]),
        })
        .passthrough(),
    ]),
    execute: async (input, options) => {
      const gmailOperations = [
        'gmail',
        'sendMessage',
        'searchMessages',
        'createDraft',
        'sendDraft',
        'listMessages',
        'getMessage',
        'getThread',
      ] as const;
      if ((gmailOperations as readonly string[]).includes(input.operation)) {
        return tools.googleMail.execute(input, options);
      }
      if (input.operation === 'drive') {
        return tools.googleDrive.execute(input, options);
      }
      return tools.googleCalendar.execute(input, options);
    },
  }),

  documentRead: tool({
    description: 'Document reading operations. operation=ocr, invoiceParse, or statementParse.',
    inputSchema: z
      .object({
        operation: z.enum(['ocr', 'invoiceParse', 'statementParse']),
      })
      .passthrough(),
    execute: async (input, options) => {
      if (input.operation === 'invoiceParse') {
        return tools.invoiceParser.execute(input, options);
      }
      if (input.operation === 'statementParse') {
        return tools.statementParser.execute(input, options);
      }
      return tools.documentOcrRead.execute(input, options);
    },
  }),

  devTools: tool({
    description: 'Developer tools. operation=code, repo, or skillSearch.',
    inputSchema: z
      .object({
        operation: z.enum(['code', 'repo', 'skillSearch']),
      })
      .passthrough(),
    execute: async (input, options) => {
      if (input.operation === 'repo') {
        return tools.repo.execute(input, options);
      }
      if (input.operation === 'skillSearch') {
        return tools.skillSearch.execute(input, options);
      }
      return tools.coding.execute(input, options);
    },
  }),
});
