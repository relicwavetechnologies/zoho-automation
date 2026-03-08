import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { larkDocsService } from '../../../channels/lark/lark-docs.service';

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
    const result = await larkDocsService.createMarkdownDoc({
      companyId: requestContext?.get('companyId') as string | undefined,
      larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
      title: inputData.title,
      markdown: inputData.markdown,
      folderToken: inputData.folderToken,
    });

    return {
      answer: result.url
        ? `Created Lark Doc "${result.title}". URL: ${result.url}`
        : `Created Lark Doc "${result.title}". Document ID: ${result.documentId}`,
      title: result.title,
      documentId: result.documentId,
      url: result.url,
      blockCount: result.blockCount,
    };
  },
});
