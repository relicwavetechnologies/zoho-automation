import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

const Schema = z.object({
  connectionId: z.string().min(1),
  op: z.enum(['list', 'get', 'read', 'search', 'create_folder']),
  fileId: z.string().optional(),
  exportMimeType: z.string().optional(),
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
  readFile(fileId: string, exportMimeType?: string): Promise<unknown>;
  searchFiles(query: string, limit?: number): Promise<unknown[]>;
  createFolder(name: string): Promise<{ fileId: string }>;
  downloadFile?(fileId: string): Promise<Buffer>;
  exportFile?(fileId: string, mimeType: string): Promise<Buffer>;
}

export const createGoogleDriveTool = (deps: { getClient: (input: {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly minimumAccess: 'read_only' | 'read_write';
}) => Promise<GoogleDriveClientPort | null> }): Tool<Args, Res> => ({
  id: asToolId('googleDrive'), family: 'google',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema, resultSchema: ResultSchema,
  description: 'List, search, read, and access Google Drive files.',
  parameterDocs: 'connectionId: required backend connection id from connections.list. op: list|get|read|search|create_folder. Use get for metadata and read for file content. exportMimeType optionally controls Google Workspace export format.',
  permissionCheck(args, perm) {
    const action: ToolActionGroup = args.op === 'create_folder' ? 'create' : 'read';
    const allowed = perm.allowedActionsByTool.get(asToolId('googleDrive'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'googleDrive', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const client = await deps.getClient({
      companyId:     ctx.runContext.companyId,
      userId:        ctx.runContext.userId,
      connectionId:  args.connectionId,
      minimumAccess: args.op === 'create_folder' ? 'read_write' : 'read_only',
    });
    if (!client) return err(new ToolError({ toolId: 'googleDrive', reason: 'unrecoverable', message: 'Google Drive connection is unavailable or not allowed for this operation' }));
    try {
      switch (args.op) {
        case 'list': {
          ctx.onProgress?.('Listing Drive files…');
          return ok({ success: true, data: await client.listFiles(args.limit) });
        }
        case 'get': {
          if (!args.fileId) return err(new ToolError({ toolId: 'googleDrive', reason: 'bad_args', message: 'fileId required' }));
          return ok({ success: true, data: await client.getFile(args.fileId) });
        }
        case 'read': {
          if (!args.fileId) return err(new ToolError({ toolId: 'googleDrive', reason: 'bad_args', message: 'fileId required' }));
          ctx.onProgress?.('Reading Google Drive file…');
          return ok({ success: true, data: await client.readFile(args.fileId, args.exportMimeType) });
        }
        case 'search': {
          ctx.onProgress?.('Searching Google Drive…');
          return ok({ success: true, data: await client.searchFiles(args.query ?? '', args.limit) });
        }
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
