import { z } from 'zod';
import type { Tool } from '../tool.contract';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import { asToolId } from '../../../../shared/ids';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import {
  runInSandbox,
  SandboxInputTooLargeError,
  SandboxScriptError,
  SandboxSerializationError,
  SandboxTimeoutError,
} from '../shared/sandbox-runner';

const INLINE_RESULT_LIMIT = 50;

const Schema = z.object({
  script: z.string().min(1).describe(
    'JavaScript function body. Receives data and args and must return a JSON-serializable result.',
  ),
  data: z.unknown().describe(
    'A small, bounded dataset already present in model context. Complete provider datasets belong in dataExport.',
  ),
  args: z.record(z.unknown()).optional(),
}).strict();

type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  rowCount: z.number().optional(),
  message: z.string().optional(),
  resultTruncated: z.boolean().optional(),
});

type Res = z.infer<typeof ResultSchema>;

export const createDataProcessorTool = (): Tool<Args, Res> => ({
  id: asToolId('dataProcessor'),
  family: 'data',
  actionGroups: new Set(['read']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description:
    'Transform a small bounded dataset already visible to the model in a networkless JavaScript sandbox. Use dataExport for complete Airtable or Zoho Books datasets.',
  parameterDocs: [
    'script: JavaScript function body. Receives data and args and must return a JSON-serializable value.',
    'data: small bounded input only. Never copy or page a complete provider dataset into this field.',
    'args: optional extra parameters.',
    'For large/complete datasets, call dataExport so source paging, transformation, and Google delivery remain server-side.',
  ].join('\n'),

  permissionCheck(_args, perm) {
    return perm.allowedToolIds.has(asToolId('dataProcessor'))
      ? ok('read' as ToolActionGroup)
      : err(new PermissionError({ toolId: 'dataProcessor', action: 'read', reason: 'not_allowed' }));
  },

  async execute(args, ctx) {
    try {
      const output = runInSandbox({
        script: args.script,
        data: args.data,
        ...(args.args ? { args: args.args } : {}),
      });
      const resultTruncated = output.isArray && (output.rowCount ?? 0) > INLINE_RESULT_LIMIT;
      const data = resultTruncated
        ? (output.result as unknown[]).slice(0, INLINE_RESULT_LIMIT)
        : output.result;
      ctx.logger.info('data_processor.completed', {
        companyId: ctx.runContext.companyId,
        rowCount: output.rowCount,
        resultTruncated,
      });
      return ok({
        success: true,
        data,
        ...(output.rowCount !== undefined ? { rowCount: output.rowCount } : {}),
        ...(resultTruncated ? { resultTruncated: true } : {}),
        message: resultTruncated
          ? `Processed ${output.rowCount} rows; showing the first ${INLINE_RESULT_LIMIT}. Use dataExport when the complete result must be delivered.`
          : 'Data processing completed.',
      });
    } catch (error) {
      const message =
        error instanceof SandboxTimeoutError
        || error instanceof SandboxScriptError
        || error instanceof SandboxInputTooLargeError
        || error instanceof SandboxSerializationError
          ? error.message
          : `Data processing failed: ${error instanceof Error ? error.message : String(error)}`;
      return err(new ToolError({
        toolId: 'dataProcessor',
        reason: 'upstream_failure',
        cause: error,
        message,
      }));
    }
  },
});
