import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  op: z.enum(['list', 'get', 'search', 'create_folder']),
  fileId: z.string().optional(),
  query: z.string().optional(),
  name: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Args = z.infer<typeof Schema>;
const ResultSchema = z.object({ success: z.boolean(), data: z.unknown().optional(), fileId: z.string().optional(), message: z.string().optional() });
type Res = z.infer<typeof ResultSchema>;

export interface GoogleDriveClientPort {
  listFiles(limit?: number): Promise<unknown[]>;
  getFile(fileId: string): Promise<unknown>;
  searchFiles(query: string, limit?: number): Promise<unknown[]>;
  createFolder(name: string): Promise<{ fileId: string }>;
}

export const createGoogleDriveTool = (deps: { getClient: (companyId: string, userId: string) => Promise<GoogleDriveClientPort | null> }): Tool<Args, Res> => ({
  id: asToolId('googleDrive'), family: 'google',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, search, and access Google Drive files.',
  parameterDocs: 'op: list|get|search|create_folder.',
  permissionCheck(args, perm) {
    const action: ToolActionGroup = args.op === 'create_folder' ? 'create' : 'read';
    const allowed = perm.allowedActionsByTool.get(asToolId('googleDrive'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'googleDrive', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const client = await deps.getClient(ctx.runContext.companyId, ctx.runContext.userId);
    if (!client) return err(new ToolError({ toolId: 'googleDrive', reason: 'unrecoverable', message: 'Google Drive not connected' }));
    try {
      switch (args.op) {
        case 'list': return ok({ success: true, data: await client.listFiles(args.limit) });
        case 'get': {
          if (!args.fileId) return err(new ToolError({ toolId: 'googleDrive', reason: 'bad_args', message: 'fileId required' }));
          return ok({ success: true, data: await client.getFile(args.fileId) });
        }
        case 'search': return ok({ success: true, data: await client.searchFiles(args.query ?? '', args.limit) });
        case 'create_folder': {
          if (!args.name) return err(new ToolError({ toolId: 'googleDrive', reason: 'bad_args', message: 'name required' }));
          const r = await client.createFolder(args.name);
          return ok({ success: true, fileId: r.fileId, message: 'Folder created' });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'googleDrive', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
