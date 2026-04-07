import { tool } from 'ai';
import { z } from 'zod';

import { conversationMemoryStore } from '../../../../state/conversation';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

type DocumentsRuntimeHelpers = {
  buildEnvelope: (input: Record<string, unknown>) => any;
  withLifecycle: (
    hooks: VercelRuntimeToolHooks,
    toolName: string,
    title: string,
    run: () => Promise<any>,
  ) => Promise<any>;
  buildConversationKey: (threadId: string) => string;
  listVisibleRuntimeFiles: (runtime: VercelRuntimeRequestContext) => Promise<Array<any>>;
  rankRuntimeFileMatches: (files: Array<any>, query?: string) => Array<any>;
  resolveRuntimeFile: (runtime: VercelRuntimeRequestContext, input: Record<string, unknown>) => Promise<any | null>;
  loadOutboundArtifactService: () => {
    materializeFromUploadedFile: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  extractFileText: (
    runtime: VercelRuntimeRequestContext,
    file: Record<string, any>,
  ) => Promise<{ text: string; source: string }>;
  asString: (value: unknown) => string | undefined;
  parseInvoiceDocument: (text: string) => Record<string, any>;
  parseStatementDocument: (text: string) => Record<string, any>;
};

export const buildDocumentRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: DocumentsRuntimeHelpers,
): Record<string, any> => ({
  documentOcrRead: tool({
    description:
      'List visible uploaded files, extract machine-readable text from a selected document, or materialize a sendable attachment artifact from an uploaded file. Use this as an internal uploaded-file path before workspace, Google Drive, or repo inspection when you need the exact file contents or a reusable outbound file reference.',
    inputSchema: z.object({
      operation: z.enum(['listFiles', 'extractText', 'createArtifactFromUploadedFile']),
      fileAssetId: z.string().optional(),
      fileName: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'documentOcrRead', 'Running document OCR', async () => {
        const conversationKey = helpers.buildConversationKey(runtime.threadId);
        if (input.operation === 'listFiles') {
          const files = await helpers.listVisibleRuntimeFiles(runtime);
          const limited = helpers.rankRuntimeFileMatches(files, input.query ?? input.fileName).slice(
            0,
            input.limit ?? 10,
          );
          return helpers.buildEnvelope({
            success: true,
            summary:
              limited.length > 0
                ? `Found ${limited.length} accessible uploaded file(s)${input.query?.trim() ? ` matching "${input.query.trim()}"` : ''}.`
                : input.query?.trim()
                  ? `No accessible uploaded files matched "${input.query.trim()}".`
                  : 'No accessible uploaded files were found.',
            keyData: {
              fileAssetIds: limited.map((file) => file.fileAssetId),
              resultCount: limited.length,
            },
            fullPayload: {
              files: limited,
            },
          });
        }

        const file = await helpers.resolveRuntimeFile(runtime, input);
        if (!file) {
          const candidates = helpers
            .rankRuntimeFileMatches(await helpers.listVisibleRuntimeFiles(runtime), input.fileName)
            .slice(0, 5);
          return helpers.buildEnvelope({
            success: false,
            summary:
              candidates.length > 0
                ? `No exact uploaded file match was found. Closest visible files: ${candidates.map((candidate) => candidate.fileName).join(', ')}.`
                : 'No matching uploaded file was found. Provide fileAssetId or fileName, or upload a document first.',
            errorKind: 'missing_input',
            retryable: false,
            missingFields: ['fileAssetId_or_fileName'],
            userAction: 'Please provide fileAssetId or fileName, or upload a document first.',
            fullPayload: {
              ...(candidates.length > 0 ? { candidates } : {}),
            },
          });
        }

        if (input.operation === 'createArtifactFromUploadedFile') {
          const artifact = await helpers.loadOutboundArtifactService().materializeFromUploadedFile({
            companyId: runtime.companyId,
            requesterUserId: runtime.userId,
            requesterAiRole: runtime.requesterAiRole,
            fileAssetId: file.fileAssetId,
          });
          conversationMemoryStore.addFileAsset(conversationKey, file);
          return helpers.buildEnvelope({
            success: true,
            summary: `Created outbound attachment artifact for ${file.fileName}.`,
            keyData: {
              artifactId: helpers.asString(artifact.id),
              fileAssetId: file.fileAssetId,
              fileName: file.fileName,
              mimeType: file.mimeType,
            },
            fullPayload: {
              artifact,
              file,
            },
            citations: [
              {
                id: `file-${file.fileAssetId}`,
                title: file.fileName,
                url: file.cloudinaryUrl,
                kind: 'file',
                sourceType: 'file_document',
                sourceId: file.fileAssetId,
                fileAssetId: file.fileAssetId,
              },
            ],
          });
        }

        const extracted = await helpers.extractFileText(runtime, file);
        if (!extracted.text.trim()) {
          return helpers.buildEnvelope({
            success: false,
            summary: `No extractable text was found in ${file.fileName}.`,
            errorKind: 'validation',
            retryable: false,
            repairHints: {
              fileAssetId:
                'The file may be a scanned image with no selectable text. Try document-ocr-read with a higher-quality scan or a different file.',
            },
          });
        }

        conversationMemoryStore.addFileAsset(conversationKey, file);
        return helpers.buildEnvelope({
          success: true,
          summary: `Extracted text from ${file.fileName}.`,
          keyData: {
            fileAssetId: file.fileAssetId,
            fileName: file.fileName,
            extractionSource: extracted.source,
          },
          fullPayload: {
            file,
            text: extracted.text,
            extractionSource: extracted.source,
          },
          citations: [
            {
              id: `file-${file.fileAssetId}`,
              title: file.fileName,
              url: file.cloudinaryUrl,
              kind: 'file',
              sourceType: 'file_document',
              sourceId: file.fileAssetId,
              fileAssetId: file.fileAssetId,
            },
          ],
        });
      }),
  }),

  invoiceParser: tool({
    description: 'Parse uploaded invoice or bill documents into structured finance fields.',
    inputSchema: z.object({
      fileAssetId: z.string().optional(),
      fileName: z.string().optional(),
      text: z.string().optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'invoiceParser', 'Parsing invoice document', async () => {
        const conversationKey = helpers.buildConversationKey(runtime.threadId);
        const file = input.text ? null : await helpers.resolveRuntimeFile(runtime, input);
        if (!input.text && !file) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'Invoice parsing requires uploaded document text or a visible file reference.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const extracted = input.text
          ? { text: input.text.trim(), source: 'provided' as const }
          : await helpers.extractFileText(runtime, file!);
        if (!extracted.text.trim()) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'The invoice document does not contain extractable text.',
            errorKind: 'validation',
            retryable: false,
          });
        }

        if (file) {
          conversationMemoryStore.addFileAsset(conversationKey, file);
        }

        const parsed = helpers.parseInvoiceDocument(extracted.text);
        return helpers.buildEnvelope({
          success: true,
          summary: parsed.invoiceNumber
            ? `Parsed invoice ${parsed.invoiceNumber}${parsed.vendorName ? ` for ${parsed.vendorName}` : ''}.`
            : `Parsed invoice fields${parsed.vendorName ? ` for ${parsed.vendorName}` : ''}.`,
          keyData: {
            fileAssetId: file?.fileAssetId,
            fileName: file?.fileName,
            vendorName: parsed.vendorName,
            invoiceNumber: parsed.invoiceNumber,
            totalAmount: parsed.totalAmount,
          },
          fullPayload: {
            file,
            extractionSource: extracted.source,
            parsed,
            textPreview: extracted.text.slice(0, 4000),
          },
          ...(file
            ? {
                citations: [
                  {
                    id: `file-${file.fileAssetId}`,
                    title: file.fileName,
                    url: file.cloudinaryUrl,
                    kind: 'file',
                    sourceType: 'file_document',
                    sourceId: file.fileAssetId,
                    fileAssetId: file.fileAssetId,
                  },
                ],
              }
            : {}),
        });
      }),
  }),

  statementParser: tool({
    description:
      'Parse uploaded bank or account statements into transaction rows and statement totals.',
    inputSchema: z.object({
      fileAssetId: z.string().optional(),
      fileName: z.string().optional(),
      text: z.string().optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'statementParser', 'Parsing statement document', async () => {
        const conversationKey = helpers.buildConversationKey(runtime.threadId);
        const file = input.text ? null : await helpers.resolveRuntimeFile(runtime, input);
        if (!input.text && !file) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'Statement parsing requires uploaded document text or a visible file reference.',
            errorKind: 'missing_input',
            retryable: false,
          });
        }

        const extracted = input.text
          ? { text: input.text.trim(), source: 'provided' as const }
          : await helpers.extractFileText(runtime, file!);
        if (!extracted.text.trim()) {
          return helpers.buildEnvelope({
            success: false,
            summary: 'The statement document does not contain extractable text.',
            errorKind: 'validation',
            retryable: false,
          });
        }

        if (file) {
          conversationMemoryStore.addFileAsset(conversationKey, file);
        }

        const parsed = helpers.parseStatementDocument(extracted.text);
        return helpers.buildEnvelope({
          success: true,
          summary: `Parsed ${parsed.transactionCount} statement row(s).`,
          keyData: {
            fileAssetId: file?.fileAssetId,
            fileName: file?.fileName,
            transactionCount: parsed.transactionCount,
            closingBalance: parsed.closingBalance,
          },
          fullPayload: {
            file,
            extractionSource: extracted.source,
            parsed,
            textPreview: extracted.text.slice(0, 4000),
          },
          ...(file
            ? {
                citations: [
                  {
                    id: `file-${file.fileAssetId}`,
                    title: file.fileName,
                    url: file.cloudinaryUrl,
                    kind: 'file',
                    sourceType: 'file_document',
                    sourceId: file.fileAssetId,
                    fileAssetId: file.fileAssetId,
                  },
                ],
              }
            : {}),
        });
      }),
  }),
});
