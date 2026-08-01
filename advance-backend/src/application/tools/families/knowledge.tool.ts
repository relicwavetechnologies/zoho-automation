import { z } from 'zod';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import { asToolId } from '../../../shared/ids';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../../permissions/permission.types';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import { resolveToolKnowledgeScope } from '../../knowledge/resolve-tool-knowledge-scope';
import type { KnowledgeMutationService } from '../../knowledge/knowledge-mutation.service';
import type { KnowledgeProjectionService } from '../../knowledge/knowledge-projection.service';
import type { KnowledgeFileService } from '../../knowledge/knowledge-file.service';
import type { KnowledgeResourceQueryService } from '../../knowledge/knowledge-resource-query.service';
import { KnowledgeMutationError } from '../../knowledge/knowledge-mutation.errors';
import { sha256CanonicalJson } from '../../../shared/hash';
import {
  KNOWLEDGE_RECALL_MAX_DEPARTMENT_NAME_CHARS,
  KNOWLEDGE_RECALL_MAX_DEPARTMENT_PREFERENCES,
  KNOWLEDGE_RECALL_MAX_FACT_CHARS,
  KNOWLEDGE_RECALL_MAX_FACTS,
  KNOWLEDGE_RECALL_MAX_QUERY_CHARS,
  KNOWLEDGE_RECALL_MAX_TOTAL_CHARS,
  type KnowledgeRecallService,
} from '../../knowledge/knowledge-recall.service';
import {
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_EXCERPT_CHARS,
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_QUERY_CHARS,
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS,
  KNOWLEDGE_DOCUMENT_SEARCH_MAX_TOTAL_CHARS,
  type KnowledgeDocumentSearchService,
} from '../../knowledge/knowledge-document-search.service';

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const jsonPayloadSchema = z.unknown().superRefine((value, ctx) => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 250_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Knowledge content must be valid JSON no larger than 250 KB.' });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Knowledge content must be valid JSON.' });
  }
});

const targetFields = {
  scope: z.enum(['personal', 'department', 'company']),
  departmentId: z.string().trim().min(1).max(200).optional(),
};

const Schema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('check_targets') }).strict(),
  z.object({
    operation: z.literal('resources.list'),
    kind: z.enum(['memory', 'skill', 'file']).optional(),
    scope: z.enum(['personal', 'department', 'company']).optional(),
    query: z.string().trim().min(1).max(240).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }).strict(),
  z.object({
    operation: z.literal('resources.get'),
    resourceId: z.string().uuid(),
  }).strict(),
  z.object({
    operation: z.literal('files.download'),
    resourceId: z.string().uuid(),
  }).strict(),
  z.object({
    operation: z.literal('documents.search'),
    query: z.string().trim().min(1).max(KNOWLEDGE_DOCUMENT_SEARCH_MAX_QUERY_CHARS),
  }).strict(),
  z.object({
    operation: z.literal('recall'),
    query: z.string().trim().min(1).max(KNOWLEDGE_RECALL_MAX_QUERY_CHARS),
    departmentPreferences: z.array(
      z.string()
        .trim()
        .min(1)
        .max(KNOWLEDGE_RECALL_MAX_DEPARTMENT_NAME_CHARS)
        .refine(name => !UUID_LIKE.test(name), 'Use department names, not IDs.'),
    ).max(KNOWLEDGE_RECALL_MAX_DEPARTMENT_PREFERENCES).optional(),
  }).strict(),
  z.object({
    operation: z.literal('propose'),
    kind: z.enum(['memory', 'skill', 'file']),
    action: z.enum(['create', 'update', 'publish', 'delete']),
    ...targetFields,
    logicalKey: z.string().trim().min(1).max(240),
    baseVersion: z.number().int().positive().optional(),
    content: jsonPayloadSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('apply'),
    mutationId: z.string().uuid(),
    contentHash: z.string().length(64).nullable(),
    kind: z.enum(['memory', 'skill', 'file']),
    action: z.enum(['create', 'update', 'publish', 'delete']),
    ...targetFields,
    content: jsonPayloadSchema.optional(),
  }).strict(),
]);

type Args = z.infer<typeof Schema>;

const ResultSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('check_targets'),
    targets: z.array(z.discriminatedUnion('scope', [
      z.object({ scope: z.literal('personal'), label: z.string() }),
      z.object({ scope: z.literal('department'), departmentId: z.string(), label: z.string() }),
      z.object({ scope: z.literal('company'), label: z.string() }),
    ])).max(3),
  }),
  z.object({
    operation: z.literal('resources.list'),
    resources: z.array(z.object({
      resourceId: z.string().uuid(),
      kind: z.enum(['memory', 'skill', 'file']),
      scope: z.enum(['personal', 'department', 'company']),
      logicalKey: z.string(),
      currentVersion: z.number().int().positive(),
      title: z.string(),
      summary: z.string(),
      department: z.object({ name: z.string() }).optional(),
      updatedAt: z.string().datetime(),
    }).strict()).max(20),
  }).strict(),
  z.object({
    operation: z.literal('resources.get'),
    resource: z.object({
      resourceId: z.string().uuid(),
      kind: z.enum(['memory', 'skill', 'file']),
      scope: z.enum(['personal', 'department', 'company']),
      logicalKey: z.string(),
      currentVersion: z.number().int().positive(),
      title: z.string(),
      summary: z.string(),
      department: z.object({ name: z.string() }).optional(),
      updatedAt: z.string().datetime(),
      content: jsonPayloadSchema,
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('files.download'),
    resourceId: z.string().uuid(),
    fileName: z.string(),
    url: z.string().url(),
    expiresInSeconds: z.number().int().positive(),
  }).strict(),
  z.object({
    operation: z.literal('documents.search'),
    status: z.enum(['available', 'partial', 'unavailable']),
    results: z.array(z.object({
      resourceId: z.string().uuid(),
      scope: z.enum(['personal', 'department', 'company']),
      fileName: z.string().min(1).max(500),
      excerpt: z.string().min(1).max(KNOWLEDGE_DOCUMENT_SEARCH_MAX_EXCERPT_CHARS),
      pageStart: z.number().int().positive().optional(),
      pageEnd: z.number().int().positive().optional(),
      sectionPath: z.array(z.string().min(1).max(300)).max(8),
      department: z.object({ name: z.string().min(1).max(120) }).optional(),
    }).strict()).max(KNOWLEDGE_DOCUMENT_SEARCH_MAX_RESULTS),
  }).strict(),
  z.object({
    operation: z.literal('recall'),
    facts: z.array(z.discriminatedUnion('scope', [
      z.object({ scope: z.literal('personal'), text: z.string().min(1).max(KNOWLEDGE_RECALL_MAX_FACT_CHARS) }),
      z.object({
        scope: z.literal('department'),
        text: z.string().min(1).max(KNOWLEDGE_RECALL_MAX_FACT_CHARS),
        department: z.object({ name: z.string().min(1).max(KNOWLEDGE_RECALL_MAX_DEPARTMENT_NAME_CHARS) }),
      }),
      z.object({ scope: z.literal('company'), text: z.string().min(1).max(KNOWLEDGE_RECALL_MAX_FACT_CHARS) }),
    ])).max(KNOWLEDGE_RECALL_MAX_FACTS),
    coverage: z.object({
      personal: z.enum(['searched', 'failed']),
      departments: z.object({ searched: z.number().int().min(0), failed: z.number().int().min(0) }),
      company: z.enum(['searched', 'failed']),
    }),
    status: z.enum(['available', 'partial', 'unavailable', 'storage_unavailable']),
  }),
  z.object({
    operation: z.literal('propose'),
    mutationId: z.string(),
    contentHash: z.string().nullable(),
    status: z.string(),
    scope: z.enum(['personal', 'department', 'company']),
    requesterReviewRequired: z.boolean(),
    requiredAuthority: z.enum(['none', 'department_manager', 'company_admin']),
    applied: z.boolean(),
    resourceId: z.string().nullable(),
  }),
  z.object({
    operation: z.literal('apply'),
    mutationId: z.string(),
    status: z.literal('applied'),
    resourceId: z.string(),
    version: z.number().int().nonnegative(),
    projection: z.enum(['completed', 'queued']),
  }),
]).superRefine((result, ctx) => {
  const totalChars = result.operation === 'recall'
    ? result.facts.reduce((sum, fact) => sum + fact.text.length, 0)
    : result.operation === 'documents.search'
      ? result.results.reduce((sum, item) => sum + item.excerpt.length, 0)
      : 0;
  const limit = result.operation === 'documents.search'
    ? KNOWLEDGE_DOCUMENT_SEARCH_MAX_TOTAL_CHARS
    : KNOWLEDGE_RECALL_MAX_TOTAL_CHARS;
  if (totalChars > limit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Knowledge retrieval exceeds the ${limit}-character context budget.`,
      path: [result.operation === 'documents.search' ? 'results' : 'facts'],
    });
  }
});

type Res = z.infer<typeof ResultSchema>;

export const createKnowledgeTool = (deps: {
  mutations: KnowledgeMutationService;
  projections: KnowledgeProjectionService;
  recall: KnowledgeRecallService;
  resources: KnowledgeResourceQueryService;
  files: KnowledgeFileService;
  documents: KnowledgeDocumentSearchService;
}): Tool<Args, Res> => ({
  id: asToolId('knowledge'),
  family: 'memory',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Use the backend knowledge authority for personal, department, or company memory, skills, and governed files.',
  parameterDocs: [
    'check_targets lists backend-authenticated targets.',
    'recall searches personal, every active-department, and company semantic projections; callers cannot select scope IDs.',
    'resources.list and resources.get read canonical Postgres versions for exact updates/deletes; visibility comes from live membership, never caller-provided scope IDs.',
    'files.download creates a short-lived authenticated download for one currently approved file resource.',
    'documents.search performs permission-filtered hybrid search over approved file contents and returns canonical page-aware excerpts.',
    'propose creates one exact versioned mutation. Shared targets always wait for requester review and then a different manager/admin.',
    'apply is only for a mutation returned by propose after its required human review. Never invent a mutationId or contentHash.',
    'Use two proposals when the user wants both department and company publication.',
    'logicalKey identifies the durable subject; updates and deletes must also include the exact current baseVersion.',
  ].join('\n'),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action: ToolActionGroup = args.operation === 'check_targets'
      || args.operation === 'recall'
      || args.operation === 'resources.list'
      || args.operation === 'resources.get'
      || args.operation === 'files.download'
      || args.operation === 'documents.search'
      ? 'read'
      : args.action === 'publish' ? 'create' : args.action;
    if (perm.allowedActionsByTool.get(asToolId('knowledge'))?.has(action)) return ok(action);
    return err(new PermissionError({
      toolId: 'knowledge',
      action,
      reason: 'not_allowed',
      message: `Knowledge ${action} is not permitted in this authenticated context.`,
    }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    try {
      if (args.operation === 'check_targets') {
        const targets: Extract<Res, { operation: 'check_targets' }>['targets'] = [
          { scope: 'personal', label: 'Personal' },
        ];
        const department = resolveToolKnowledgeScope({ scope: 'department' }, ctx);
        if (department.ok && department.value.scope === 'department') {
          targets.push({
            scope: 'department',
            departmentId: String(department.value.departmentId),
            label: department.value.departmentName,
          });
        }
        targets.push({ scope: 'company', label: 'Company' });
        return ok({ operation: 'check_targets', targets });
      }

      if (args.operation === 'resources.list') {
        const resources = await deps.resources.list({
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.query ? { query: args.query } : {}),
          limit: args.limit ?? 10,
        });
        return ok({ operation: 'resources.list', resources });
      }

      if (args.operation === 'resources.get') {
        const resource = await deps.resources.get({
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          resourceId: args.resourceId,
        });
        if (!resource) return err(toolError('bad_args', 'Knowledge resource not found.'));
        return ok({ operation: 'resources.get', resource });
      }

      if (args.operation === 'files.download') {
        const resource = await deps.resources.get({
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          resourceId: args.resourceId,
        });
        if (!resource || resource.kind !== 'file') {
          return err(toolError('bad_args', 'Governed file resource not found.'));
        }
        const content = resource.content as { assetId?: unknown };
        if (typeof content.assetId !== 'string') {
          return err(toolError('upstream_failure', 'Governed file resource has no current asset.'));
        }
        const download = await deps.files.createDownload({
          identity: {
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
            companyRole: String(ctx.runContext.companyRole),
            channel: ctx.runContext.channel,
          },
          assetId: content.assetId,
        });
        return ok({
          operation: 'files.download',
          resourceId: resource.resourceId,
          ...download,
        });
      }

      if (args.operation === 'documents.search') {
        const result = await deps.documents.search({
          query: args.query,
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          companyRole: String(ctx.runContext.companyRole),
          channel: ctx.runContext.channel,
        });
        return ok({
          operation: 'documents.search',
          status: result.status,
          results: result.results.map(item => ({
            ...item,
            sectionPath: [...item.sectionPath],
          })),
        });
      }

      if (args.operation === 'recall') {
        const recalled = await deps.recall.recall({
          query: args.query,
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          companyRole: String(ctx.runContext.companyRole),
          channel: ctx.runContext.channel,
          ...(args.departmentPreferences
            ? { departmentPreferences: args.departmentPreferences }
            : {}),
        });
        return ok({ operation: 'recall', ...recalled });
      }

      const target = resolveToolKnowledgeScope({
        scope: args.scope,
        ...(args.scope === 'department' && args.departmentId
          ? { departmentId: args.departmentId }
          : {}),
      }, ctx);
      if (!target.ok) return err(toolError('permission_denied', target.message));

      if (args.operation === 'propose') {
        const mutation = await deps.mutations.propose({
          target: target.value,
          requester: {
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
          },
          kind: args.kind,
          logicalKey: args.logicalKey,
          action: args.action,
          ...(args.baseVersion ? { baseVersion: args.baseVersion } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          sourceType: args.kind === 'skill'
            ? 'skill_teach'
            : args.kind === 'file'
              ? 'file_upload'
              : 'user_explicit',
          ...(ctx.runContext.traceId ? { sourceRef: String(ctx.runContext.traceId) } : {}),
        });
        if (mutation.status === 'approved') {
          const applied = await deps.mutations.apply({
            mutationId: mutation.id,
            companyId: mutation.companyId,
          });
          await deps.projections.projectMutation(mutation.id);
          const projected = await deps.mutations.get({ mutationId: mutation.id, companyId: mutation.companyId });
          return ok({
            operation: 'propose',
            mutationId: mutation.id,
            contentHash: mutation.proposedContentHash,
            status: projected.status,
            scope: mutation.scope,
            requesterReviewRequired: mutation.requesterReviewRequired,
            requiredAuthority: mutation.requiredAuthority,
            applied: true,
            resourceId: applied.resourceId,
          });
        }
        return ok({
          operation: 'propose',
          mutationId: mutation.id,
          contentHash: mutation.proposedContentHash,
          status: mutation.status,
          scope: mutation.scope,
          requesterReviewRequired: mutation.requesterReviewRequired,
          requiredAuthority: mutation.requiredAuthority,
          applied: false,
          resourceId: mutation.resourceId,
        });
      }

      const mutation = await deps.mutations.get({
        mutationId: args.mutationId,
        companyId: String(ctx.runContext.companyId),
      });
      assertApplyMatches(args, mutation, ctx);
      if (mutation.requiredAuthority !== 'none') {
        if (
          !ctx.approvalGrant
          || ctx.approvalGrant.approvalId !== mutation.runtimeApprovalId
          || ctx.approvalGrant.authority !== mutation.requiredAuthority
        ) {
          return err(toolError('permission_denied', 'The exact shared-knowledge approval was not claimed.'));
        }
        await deps.mutations.acceptRuntimeApproval({
          mutationId: mutation.id,
          companyId: mutation.companyId,
          approvalId: ctx.approvalGrant.approvalId,
        });
      }
      const applied = await deps.mutations.apply({
        mutationId: mutation.id,
        companyId: mutation.companyId,
      });
      let projection: 'completed' | 'queued' = 'completed';
      try {
        await deps.projections.projectMutation(mutation.id);
      } catch (cause) {
        projection = 'queued';
        ctx.logger.warn('knowledge.projection.deferred', {
          mutationId: mutation.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return ok({
        operation: 'apply',
        mutationId: mutation.id,
        status: 'applied',
        resourceId: applied.resourceId,
        version: applied.version,
        projection,
      });
    } catch (cause) {
      if (cause instanceof KnowledgeMutationError) {
        return err(toolError(
          cause.code === 'permission_denied' || cause.code === 'approval_mismatch'
            ? 'permission_denied'
            : cause.code === 'invalid_request' || cause.code === 'stale_version' || cause.code === 'conflict'
              ? 'bad_args'
              : 'upstream_failure',
          cause.message,
          cause,
        ));
      }
      return err(toolError(
        cause instanceof z.ZodError ? 'bad_args' : 'upstream_failure',
        cause instanceof Error ? cause.message : String(cause),
        cause,
      ));
    }
  },
});

function assertApplyMatches(
  args: Extract<Args, { operation: 'apply' }>,
  mutation: Awaited<ReturnType<KnowledgeMutationService['get']>>,
  ctx: ToolExecutionContext,
): void {
  if (mutation.requesterId !== String(ctx.runContext.userId)) {
    throw new KnowledgeMutationError('permission_denied', 'Only the original requester may apply this mutation.');
  }
  const departmentId = args.scope === 'department' ? args.departmentId ?? null : null;
  const contentHash = args.action === 'delete'
    ? null
    : args.content === undefined || args.content === null
      ? '__missing__'
      : sha256CanonicalJson(args.content);
  if (
    mutation.kind !== args.kind
    || mutation.action !== args.action
    || mutation.scope !== args.scope
    || mutation.departmentId !== departmentId
    || mutation.proposedContentHash !== args.contentHash
    || contentHash !== args.contentHash
  ) {
    throw new KnowledgeMutationError('approval_mismatch', 'Apply arguments do not match the exact reviewed proposal.');
  }
}

function toolError(
  reason: 'bad_args' | 'upstream_failure' | 'permission_denied',
  message: string,
  cause?: unknown,
): ToolError {
  return new ToolError({ toolId: 'knowledge', reason, message, ...(cause ? { cause } : {}) });
}
