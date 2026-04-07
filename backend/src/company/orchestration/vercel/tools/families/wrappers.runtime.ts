import { tool } from 'ai';
import { z } from 'zod';

type RuntimeTools = Record<string, any>;

export const buildCanonicalRuntimeWrappers = (tools: RuntimeTools): Record<string, any> => ({
  zohoBooks: tool({
    description:
      'Zoho Books finance operations. Prefer this canonical wrapper. @deprecated aliases: zoho-books-read, zoho-books-write, zoho-books-agent',
    inputSchema: z
      .object({
        operation: z.enum(['read', 'write', 'buildOverdueReport', 'listRecords']),
        module: z.string().optional(),
        organizationId: z.string().optional(),
        query: z.string().optional(),
        recordId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
        reportName: z.string().optional(),
        invoiceDateFrom: z.string().optional(),
        invoiceDateTo: z.string().optional(),
        asOfDate: z.string().optional(),
        customerId: z.string().optional(),
        vendorId: z.string().optional(),
        readOperation: z.string().optional(),
        writeOperation: z.string().optional(),
      })
      .passthrough(),
    execute: async (input, options) => {
      if (input.operation === 'write') {
        return tools.booksWrite.execute(
          {
            ...input,
            operation: input.writeOperation ?? 'createRecord',
          },
          options,
        );
      }
      if (input.operation === 'buildOverdueReport') {
        return tools.booksRead.execute({ ...input, operation: 'buildOverdueReport' }, options);
      }
      if (input.operation === 'listRecords') {
        return tools.booksRead.execute({ ...input, operation: 'listRecords' }, options);
      }
      return tools.booksRead.execute(
        {
          ...input,
          operation: input.readOperation ?? (input.recordId ? 'getRecord' : 'listRecords'),
        },
        options,
      );
    },
  }),

  zohoCrm: tool({
    description:
      'Zoho CRM operations. Prefer this canonical wrapper. @deprecated aliases: search-zoho-context, read-zoho-records, zoho-read, zoho-agent, zoho-write',
    inputSchema: z
      .object({
        operation: z.enum(['search', 'read', 'write']),
        module: z.string().optional(),
        query: z.string().optional(),
        recordId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
        fields: z.record(z.unknown()).optional(),
        readOperation: z.string().optional(),
        writeOperation: z.string().optional(),
      })
      .passthrough(),
    execute: async (input, options) => {
      if (input.operation === 'search') {
        return tools.zoho.execute({ ...input, operation: 'searchContext' }, options);
      }
      if (input.operation === 'write') {
        return tools.zoho.execute(
          {
            ...input,
            operation: input.writeOperation ?? 'updateRecord',
          },
          options,
        );
      }
      return tools.zoho.execute(
        {
          ...input,
          operation: input.readOperation ?? (input.recordId ? 'getRecord' : 'readRecords'),
        },
        options,
      );
    },
  }),

  workflow: tool({
    description: 'Workflow authoring operations. operation=author.',
    inputSchema: z
      .object({
        operation: z.enum(['author']),
        workflowOperation: z
          .enum(['draft', 'plan', 'build', 'validate', 'save', 'schedule', 'list', 'archive', 'run'])
          .optional(),
      })
      .passthrough(),
    execute: async (input, options) => {
      const workflowOperation = input.workflowOperation ?? 'draft';
      const workflowToolMap = {
        draft: tools.workflowDraft,
        plan: tools.workflowPlan,
        build: tools.workflowBuild,
        validate: tools.workflowValidate,
        save: tools.workflowSave,
        schedule: tools.workflowSchedule,
        list: tools.workflowList,
        archive: tools.workflowArchive,
        run: tools.workflowRun,
      } as const;
      return workflowToolMap[workflowOperation].execute(input, options);
    },
  }),
});
