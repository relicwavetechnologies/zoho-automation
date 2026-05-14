/**
 * DocumentRag tool — exposes 4 operations to the supervisor:
 *   search      — semantic chunk search with Groq listwise reranking
 *   readSection — read a specific section by path
 *   readFull    — read the full document (triggered by exact-wording queries)
 *   listFiles   — list indexed files visible to the requester
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

// ─── Args schema ──────────────────────────────────────────────────────────────

const DocumentRagArgsSchema = z.object({
  operation: z.enum(['search', 'readSection', 'readFull', 'listFiles']).describe(
    'search: semantic chunk search; readSection: read a section; readFull: full doc text for exact wording; listFiles: list indexed files',
  ),
  query:       z.string().optional().describe('Search query (required for search and readSection)'),
  fileAssetId: z.string().optional().describe('Specific file to search or read (optional for search, required for readFull/readSection)'),
  sectionPath: z.string().optional().describe('Dot-separated section path (e.g. "3.2") for readSection'),
  limit:       z.number().int().min(1).max(20).optional().describe('Max chunks to return (default 6)'),
});

type DocumentRagArgs = z.infer<typeof DocumentRagArgsSchema>;

// ─── Result schema ────────────────────────────────────────────────────────────

const DocumentRagResultSchema = z.object({
  success:    z.boolean(),
  operation:  z.string(),
  results:    z.array(z.object({
    text:         z.string(),
    fileName:     z.string(),
    fileAssetId:  z.string(),
    sectionPath:  z.string().optional(),
    cloudinaryUrl: z.string().optional(),
    score:        z.number().optional(),
    citation:     z.string(),
  })),
  totalFiles:  z.number().optional(),
  message:     z.string().optional(),
});

type DocumentRagResult = z.infer<typeof DocumentRagResultSchema>;

// ─── Broker port ─────────────────────────────────────────────────────────────

export interface DocumentRagBrokerPort {
  search(input: {
    query:         string;
    companyId:     string;
    requesterUserId: string;
    requesterAiRole: string;
    fileAssetId?:  string;
    limit?:        number;
  }): Promise<DocumentRagResult['results']>;

  readFull(input: {
    fileAssetId:   string;
    companyId:     string;
    requesterUserId: string;
  }): Promise<{ text: string; fileName: string; cloudinaryUrl: string; truncated: boolean } | null>;

  listFiles(input: {
    companyId:     string;
    requesterUserId: string;
    requesterAiRole: string;
    isAdmin:       boolean;
  }): Promise<Array<{ fileAssetId: string; fileName: string; status: string; createdAt: string }>>;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export class DocumentRagTool implements Tool<DocumentRagArgs, DocumentRagResult> {
  readonly id = asToolId('documentRag');
  readonly family = 'rag' as const;
  readonly actionGroups = new Set<ToolActionGroup>(['read'] as ToolActionGroup[]);
  readonly argsSchema  = DocumentRagArgsSchema;
  readonly resultSchema = DocumentRagResultSchema;

  readonly description = [
    'Search and read company documents, policies, handbooks, and uploaded files.',
    'Use "search" for semantic Q&A, "readFull" when the user asks for exact wording/clauses,',
    '"listFiles" to see what documents are available.',
  ].join(' ');

  readonly parameterDocs = `
operation: "search" | "readSection" | "readFull" | "listFiles"
  - search: semantic chunk search across all (or one) file(s). Returns top-K relevant excerpts with citations.
  - readFull: returns the full text of a specific file. Use when user asks for "exact clause", "verbatim", "full policy", etc.
  - listFiles: lists all files visible to the user with ingestion status.
query: required for search and readSection. Natural-language question or keyword.
fileAssetId: (optional) restrict search to one file; required for readFull.
limit: (optional) max chunks for search, default 6.
`.trim();

  constructor(private readonly broker: DocumentRagBrokerPort) {}

  permissionCheck(_args: DocumentRagArgs, _perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    return ok('read' as ToolActionGroup);
  }

  async execute(args: DocumentRagArgs, ctx: ToolExecutionContext): Promise<Result<DocumentRagResult, ToolError>> {
    const { runContext } = ctx;
    const companyId = String(runContext.companyId);
    const requesterUserId = String(runContext.userId);
    const requesterAiRole = String(runContext.companyRole ?? 'MEMBER');

    try {
      if (args.operation === 'listFiles') {
        ctx.onProgress?.('Listing documents…');
        const files = await this.broker.listFiles({
          companyId, requesterUserId, requesterAiRole, isAdmin: requesterAiRole === 'COMPANY_ADMIN' || requesterAiRole === 'SUPER_ADMIN',
        });
        return ok({
          success:    true,
          operation:  'listFiles',
          results:    [],
          totalFiles: files.length,
          message:    files.length === 0
            ? 'No documents indexed yet.'
            : files.map(f => `${f.fileName} (${f.status}, id: ${f.fileAssetId})`).join('\n'),
        });
      }

      if (args.operation === 'readFull') {
        if (!args.fileAssetId) {
          return err(new ToolError({ toolId: 'documentRag', reason: 'bad_args', message: 'fileAssetId is required for readFull' }));
        }
        ctx.onProgress?.('Reading document…');
        const doc = await this.broker.readFull({ fileAssetId: args.fileAssetId, companyId, requesterUserId });
        if (!doc) {
          return ok({ success: false, operation: 'readFull', results: [], message: 'Document not found or not indexed.' });
        }
        return ok({
          success: true,
          operation: 'readFull',
          results: [{
            text:          doc.text,
            fileName:      doc.fileName,
            fileAssetId:   args.fileAssetId ?? '',
            cloudinaryUrl: doc.cloudinaryUrl,
            citation:      `[${doc.fileName}]${doc.truncated ? ' (truncated)' : ''}`,
          }],
        });
      }

      // search + readSection share the search path
      if (!args.query) {
        return err(new ToolError({ toolId: 'documentRag', reason: 'bad_args', message: 'query is required for search/readSection' }));
      }
      ctx.onProgress?.('Searching documents…');
      const results = await this.broker.search({
        query: args.query, companyId, requesterUserId, requesterAiRole,
        limit: args.limit ?? 6,
        ...(args.fileAssetId ? { fileAssetId: args.fileAssetId } : {}),
      });

      return ok({
        success:   true,
        operation: args.operation,
        results,
        message:   results.length === 0 ? 'No relevant document sections found.' : undefined,
      });
    } catch (e) {
      return err(new ToolError({ toolId: 'documentRag', reason: 'upstream_failure', cause: e }));
    }
  }
}
