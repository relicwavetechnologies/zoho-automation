/**
 * Context-search tool — delegates to ContextSearchBroker.
 *
 * The tool receives a high-level query + optional source/date filters, calls the
 * broker, and returns a structured result with citations the LLM can reference.
 */

import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import type { ContextSearchOutput, ContextCitation } from '../../../context-search/context-search.types';

// ─── Args schema ──────────────────────────────────────────────────────────────

const ContextSearchArgsSchema = z.object({
  query: z.string().min(1).describe('Search query text'),
  limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)'),
  sources: z.object({
    personalHistory: z.boolean().optional(),
    files:           z.boolean().optional(),
    larkContacts:    z.boolean().optional(),
    zohoCrmContext:  z.boolean().optional(),
    zohoBooksLive:   z.boolean().optional(),
    workspace:       z.boolean().optional(),
    web:             z.boolean().optional(),
    skills:          z.boolean().optional(),
  }).optional().describe('Explicit source overrides; unset sources use smart defaults'),
  dateFrom: z.string().optional().describe('ISO-8601 date range start (inclusive)'),
  dateTo:   z.string().optional().describe('ISO-8601 date range end (inclusive)'),
  site:     z.string().optional().describe('Restrict web search to this domain (e.g. "docs.example.com")'),
});

type ContextSearchArgs = z.infer<typeof ContextSearchArgsSchema>;

// ─── Result schema ────────────────────────────────────────────────────────────

const ContextSearchResultSchema = z.object({
  success:       z.boolean(),
  resultCount:   z.number(),
  searchSummary: z.string(),
  results:       z.array(z.object({
    scope:       z.string(),
    sourceType:  z.string(),
    sourceLabel: z.string(),
    excerpt:     z.string(),
    score:       z.number(),
    chunkRef:    z.string(),
    asOf:        z.string().optional(),
    url:         z.string().optional(),
    fileName:    z.string().optional(),
    title:       z.string().optional(),
    authorityLevel: z.string().optional(),
  })),
  resolvedEntities: z.record(z.string()),
  citations:        z.array(z.object({
    index:       z.number(),
    chunkRef:    z.string(),
    sourceLabel: z.string(),
    excerpt:     z.string(),
    score:       z.number(),
    title:       z.string().optional(),
    url:         z.string().optional(),
    fileName:    z.string().optional(),
  })),
  nextFetchRefs: z.array(z.string()),
});

type ContextSearchResult = z.infer<typeof ContextSearchResultSchema>;

// ─── Port ─────────────────────────────────────────────────────────────────────

export interface ContextSearchBrokerPort {
  search(input: {
    companyId: string;
    userId: string;
    requesterEmail?: string;
    departmentId?: string;
    departmentZohoReadScope?: string;
    requesterAiRole?: string;
    query: string;
    limit?: number;
    sources?: ContextSearchArgs['sources'];
    dateFrom?: string;
    dateTo?: string;
    site?: string;
    workspacePath?: string;
  }): Promise<ContextSearchOutput>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export const createContextSearchTool = (deps: {
  broker: ContextSearchBrokerPort;
}): Tool<ContextSearchArgs, ContextSearchResult> => ({
  id: asToolId('contextSearch'),
  family: 'context',
  actionGroups: new Set(['read']),
  argsSchema: ContextSearchArgsSchema,
  resultSchema: ContextSearchResultSchema,
  description:
    'Search the company knowledge base, CRM, Books, Lark contacts, company files, ' +
    'workspace, web, and skills in parallel. Returns ranked excerpts with citations.',
  parameterDocs: `
- query: Full-text or semantic query string
- limit: Max results to return (1–10, default 5)
- sources: Explicit per-source flags (defaults: personalHistory=true, files=true, larkContacts=true, zohoCrmContext=true; web/skills/workspace/zohoBooksLive=false unless set)
- dateFrom / dateTo: ISO-8601 date range filter
- site: Restrict web search to a specific domain
  `.trim(),

  permissionCheck(_args: ContextSearchArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const allowed = perm.allowedActionsByTool.get(asToolId('contextSearch'))?.has('read') ?? false;
    if (!allowed) return err(new PermissionError({ toolId: 'contextSearch', action: 'read', reason: 'not_allowed' }));
    return ok('read');
  },

  async execute(args: ContextSearchArgs, ctx: ToolExecutionContext): Promise<Result<ContextSearchResult, ToolError>> {
    try {
      ctx.onProgress?.('Searching knowledge base…');
      const rc = ctx.runContext;
      const output = await deps.broker.search({
        companyId: rc.companyId,
        userId:    rc.userId,
        query:     args.query,
        ...(rc.requesterEmail          ? { requesterEmail: rc.requesterEmail }                   : {}),
        ...(rc.departmentId            ? { departmentId: rc.departmentId }                       : {}),
        ...(rc.departmentZohoReadScope ? { departmentZohoReadScope: rc.departmentZohoReadScope } : {}),
        ...(rc.requesterAiRole         ? { requesterAiRole: rc.requesterAiRole }                 : {}),
        ...(rc.workspacePath           ? { workspacePath: rc.workspacePath }                     : {}),
        ...(args.limit   ? { limit: args.limit }     : {}),
        ...(args.sources ? { sources: args.sources } : {}),
        ...(args.dateFrom ? { dateFrom: args.dateFrom } : {}),
        ...(args.dateTo   ? { dateTo: args.dateTo }     : {}),
        ...(args.site     ? { site: args.site }         : {}),
      });

      return ok({
        success:       output.results.length > 0,
        resultCount:   output.results.length,
        searchSummary: output.searchSummary,
        results: output.results.map(r => ({
          scope:          r.scope,
          sourceType:     r.sourceType,
          sourceLabel:    r.sourceLabel,
          excerpt:        r.excerpt,
          score:          r.score,
          chunkRef:       r.chunkRef,
          asOf:           r.asOf,
          url:            r.url,
          fileName:       r.fileName,
          title:          r.title,
          authorityLevel: r.authorityLevel,
        })),
        resolvedEntities: output.resolvedEntities,
        citations: (output.citations as ContextCitation[]).map(c => ({
          index:       c.index,
          chunkRef:    c.chunkRef,
          sourceLabel: c.sourceLabel,
          excerpt:     c.excerpt,
          score:       c.score,
          title:       c.title,
          url:         c.url,
          fileName:    c.fileName,
        })),
        nextFetchRefs: output.nextFetchRefs,
      });
    } catch (e) {
      return err(new ToolError({
        toolId:  'contextSearch',
        reason:  'upstream_failure',
        cause:   e,
        message: e instanceof Error ? e.message : String(e),
      }));
    }
  },
});
