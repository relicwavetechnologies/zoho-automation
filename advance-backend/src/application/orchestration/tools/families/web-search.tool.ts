import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({
  success: z.boolean(),
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })).optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

export interface WebSearchClientPort {
  search(query: string, limit?: number): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

export const createWebSearchTool = (deps: { client: WebSearchClientPort }): Tool<Args, Res> => ({
  id: asToolId('webSearch'), family: 'context',
  actionGroups: new Set(['read']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'Search the web for current information.',
  parameterDocs: '- query: Search query\n- limit: Max results (default 5)',
  permissionCheck(_args, perm) {
    const allowed = perm.allowedActionsByTool.get(asToolId('webSearch'))?.has('read') ?? false;
    return allowed ? ok('read') : err(new PermissionError({ toolId: 'webSearch', action: 'read', reason: 'not_allowed' }));
  },
  async execute(args, _ctx): Promise<Result<Res, ToolError>> {
    try {
      const results = await deps.client.search(args.query, args.limit ?? 5);
      return ok({ success: true, results, message: `Found ${results.length} results` });
    } catch (e) {
      return err(new ToolError({ toolId: 'webSearch', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
