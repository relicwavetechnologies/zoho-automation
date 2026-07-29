import { z } from 'zod';
import type { Tool } from '../tool.contract';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import { asToolId } from '../../../../shared/ids';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import {
  DatasetSourceRegistry,
  datasetSourceSchema,
  datasetSourceToolId,
} from '../../../data-export/data-export.types';
import {
  DataComputeSandbox,
  executeDataProgram,
} from '../../../data-export/data-export.sandbox';
import {
  ZOHO_BOOKS_OUTSTANDING_RULE,
  ZOHO_BOOKS_ROW_CONTRACT,
} from '../../../../shared/zoho-books-row-contract';

const INLINE_RESULT_LIMIT = 50;
const SOURCE_ROW_LIMIT = 100_000;
const RAW_AIRTABLE_ROW_ACCESS =
  /\brow\s*(?:(?:\?\.|\.)\s*(?:fields|cellValuesByFieldId)\b|(?:\?\.)?\s*\[\s*(['"])(?:fields|cellValuesByFieldId)\1\s*\])/;

const DirectSchema = z.object({
  script: z.string().min(1).max(20_000).describe(
    'JavaScript function body. Receives data and args and must return a JSON-serializable result.',
  ),
  data: z.unknown().describe(
    'A small, bounded dataset already present in model context.',
  ),
  args: z.record(z.unknown()).optional(),
}).strict();

const SourceSchema = z.object({
  sources: z.array(z.object({
    alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
    source: datasetSourceSchema,
  }).strict()).min(1).max(3),
  program: z.object({
    initialState: z.unknown().optional(),
    reduce: z.string().min(1).max(20_000).describe(
      'JavaScript reducer body receiving state, row, index, source, and args. It must return the next state.',
    ),
    finalize: z.string().min(1).max(20_000).optional().describe(
      'Optional JavaScript finalizer body receiving state, meta, and args. It must return the compact result.',
    ),
  }).strict(),
  args: z.record(z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  const aliases = new Set<string>();
  value.sources.forEach(({ alias }, index) => {
    if (aliases.has(alias)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index, 'alias'],
        message: `Duplicate source alias "${alias}"`,
      });
    }
    aliases.add(alias);
  });
  if (
    value.sources.some(({ source }) => source.kind === 'airtable_records')
    && RAW_AIRTABLE_ROW_ACCESS.test(value.program.reduce)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['program', 'reduce'],
      message:
        'Airtable source rows are flattened by field name. Read row["Status"]; '
        + 'row.fields and row.cellValuesByFieldId are unavailable.',
    });
  }
});

const Schema = z.union([DirectSchema, SourceSchema]);
type Args = z.infer<typeof Schema>;

const ProvenanceSchema = z.record(z.object({
  kind: z.enum(['airtable_records', 'zoho_books']),
  pagesRead: z.number().int().nonnegative(),
  recordsRead: z.number().int().nonnegative(),
  complete: z.boolean(),
}));

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  rowCount: z.number().optional(),
  recordsProcessed: z.number().optional(),
  complete: z.boolean().optional(),
  provenance: ProvenanceSchema.optional(),
  message: z.string().optional(),
  resultTruncated: z.boolean().optional(),
});

type Res = z.infer<typeof ResultSchema>;

export const createDataProcessorTool = (deps?: {
  readonly sources: DatasetSourceRegistry;
  readonly sourceRowLimit?: number;
}): Tool<Args, Res> => ({
  id: asToolId('dataProcessor'),
  family: 'data',
  actionGroups: new Set(['read']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description:
    'Run governed JavaScript calculations. Pass direct data for small inputs, or source descriptors to page complete approved Zoho Books or Airtable datasets server-side. Source mode supports up to three datasets and returns completeness provenance.',
  parameterDocs: [
    'DIRECT MODE: { script, data, args? }. Use only for a small bounded dataset already visible in the current run.',
    'SOURCE MODE: { sources, program, args? }. The backend owns connection checks, pagination, deduplication, and source access.',
    'sources: 1-3 entries shaped as { alias, source }. Aliases are passed to the reducer as source.',
    'program.initialState: small JSON accumulator, default {}.',
    'program.reduce: JS body receiving state, row, index, source, args. Return the next state for every row.',
    'program.finalize: optional JS body receiving state, meta, args. Return the compact answer. Without it, state is returned.',
    'meta.sources[alias] contains kind, pagesRead, recordsRead, complete. Never describe a result as exact when complete is false.',
    'Airtable source rows are flattened objects keyed by field name plus "Record ID". Read row["Status"]; row.fields and row.cellValuesByFieldId are rejected before pagination.',
    ZOHO_BOOKS_ROW_CONTRACT,
    ZOHO_BOOKS_OUTSTANDING_RULE,
    'Source mode is read-only. The member must have dataProcessor read access and read access to every source tool.',
    `Each source processes at most ${SOURCE_ROW_LIMIT.toLocaleString('en-IN')} rows; hitting the boundary returns complete=false.`,
  ].join('\n'),

  permissionCheck(args, perm) {
    if (!perm.allowedToolIds.has(asToolId('dataProcessor'))) {
      return err(new PermissionError({
        toolId: 'dataProcessor',
        action: 'read',
        reason: 'not_allowed',
      }));
    }
    if ('sources' in args) {
      for (const { source } of args.sources) {
        const sourceToolId = datasetSourceToolId(source);
        if (!perm.allowedActionsByTool.get(asToolId(sourceToolId))?.has('read')) {
          return err(new PermissionError({
            toolId: sourceToolId,
            action: 'read',
            reason: 'not_allowed',
          }));
        }
      }
    }
    return ok('read' as ToolActionGroup);
  },

  async execute(args, ctx) {
    if (!('sources' in args)) {
      try {
        return ok(formatResult(
          await executeDataProgram(args.data, args.script, args.args),
          'Data processing completed.',
        ));
      } catch (cause) {
        return dataProcessorError(cause);
      }
    }

    if (!deps) {
      return err(new ToolError({
        toolId: 'dataProcessor',
        reason: 'upstream_failure',
        message: 'Source-backed data processing is not configured.',
      }));
    }

    const provenance: Record<string, {
      kind: 'airtable_records' | 'zoho_books';
      pagesRead: number;
      recordsRead: number;
      complete: boolean;
    }> = {};
    let sandbox: DataComputeSandbox | undefined;
    let recordsProcessed = 0;
    const sourceRowLimit = Math.max(1, Math.floor(deps.sourceRowLimit ?? SOURCE_ROW_LIMIT));

    try {
      sandbox = new DataComputeSandbox({
        initialState: args.program.initialState ?? {},
        reduce: args.program.reduce,
        ...(args.program.finalize ? { finalize: args.program.finalize } : {}),
        ...(args.args ? { args: args.args } : {}),
      });
      for (const { alias, source } of args.sources) {
        const adapter = deps.sources.resolve(source);
        let pagesRead = 0;
        let recordsRead = 0;
        let complete = true;
        ctx.onProgress?.(`Reading ${alias}…`);

        for await (const page of adapter.read(source, {
          companyId: ctx.runContext.companyId,
          userId: ctx.runContext.userId,
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        })) {
          ctx.abortSignal?.throwIfAborted();
          pagesRead += 1;
          const remaining = sourceRowLimit - recordsRead;
          const rows = page.rows.slice(0, remaining);
          if (rows.length > 0) {
            await sandbox.accumulatePage(rows, alias, recordsRead);
            recordsRead += rows.length;
            recordsProcessed += rows.length;
          }
          complete &&= page.sourceTruncated !== true;
          if (page.rows.length > rows.length || (recordsRead >= sourceRowLimit && page.hasMore === true)) {
            complete = false;
            break;
          }
        }

        provenance[alias] = {
          kind: source.kind,
          pagesRead,
          recordsRead,
          complete,
        };
      }

      const complete = Object.values(provenance).every((source) => source.complete);
      const data = await sandbox.finalize({ sources: provenance, complete });
      ctx.logger.info('data_processor.sources.completed', {
        companyId: ctx.runContext.companyId,
        sourceCount: args.sources.length,
        recordsProcessed,
        complete,
      });
      const result = formatResult(
        data,
        complete
          ? `Processed ${recordsProcessed} records from ${args.sources.length} complete source(s).`
          : `Processed ${recordsProcessed} records, but at least one source was incomplete. Do not present this result as exact.`,
      );
      return ok({
        ...result,
        recordsProcessed,
        complete,
        provenance,
      });
    } catch (cause) {
      return dataProcessorError(cause);
    } finally {
      await sandbox?.close().catch((cause) => {
        ctx.logger.warn('data_processor.sandbox_close_failed', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
  },
});

function formatResult(data: unknown, message: string): Res {
  const isArray = Array.isArray(data);
  const rowCount = isArray ? data.length : undefined;
  const resultTruncated = isArray && data.length > INLINE_RESULT_LIMIT;
  return {
    success: true,
    data: resultTruncated ? data.slice(0, INLINE_RESULT_LIMIT) : data,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(resultTruncated ? { resultTruncated: true } : {}),
    message: resultTruncated
      ? `${message} Showing the first ${INLINE_RESULT_LIMIT} of ${rowCount} result rows.`
      : message,
  };
}

function dataProcessorError(cause: unknown) {
  return err(new ToolError({
    toolId: 'dataProcessor',
    reason: 'upstream_failure',
    cause,
    message: `Data processing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  }));
}
