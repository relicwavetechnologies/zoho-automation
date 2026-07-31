import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';

const CanvaOpSchema = z.enum([
  'get_assets',
  'upload_asset_from_url',
  'search_designs',
  'get_design',
  'get_design_pages',
  'get_design_content',
  'get_presenter_notes',
  'get_export_formats',
  'generate_design',
  'create_design_from_candidate',
  'copy_design',
  'export_design',
  'create_folder',
  'list_folder_items',
  'search_folders',
  'move_item_to_folder',
  'comment_on_design',
  'reply_to_comment',
  'list_comments',
  'list_replies',
  'resize_design',
  'start_editing_transaction',
  'perform_editing_operations',
  'commit_editing_transaction',
  'cancel_editing_transaction',
]);

type CanvaOp = z.infer<typeof CanvaOpSchema>;

const Schema = z.object({
  connectionId: z.string().min(1),
  op: CanvaOpSchema,
  /** Provider arguments are passed only to the named, allow-listed Canva MCP tool. */
  input: z.record(z.unknown()).optional(),
});
type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  op: CanvaOpSchema,
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

const TOOL_BY_OPERATION: Record<CanvaOp, { nativeTool: string; action: ToolActionGroup }> = {
  get_assets:                    { nativeTool: 'get-assets', action: 'read' },
  upload_asset_from_url:         { nativeTool: 'upload-asset-from-url', action: 'create' },
  search_designs:                { nativeTool: 'search-designs', action: 'read' },
  get_design:                    { nativeTool: 'get-design', action: 'read' },
  get_design_pages:              { nativeTool: 'get-design-pages', action: 'read' },
  get_design_content:            { nativeTool: 'get-design-content', action: 'read' },
  get_presenter_notes:           { nativeTool: 'get-presenter-notes', action: 'read' },
  get_export_formats:            { nativeTool: 'get-export-formats', action: 'read' },
  generate_design:               { nativeTool: 'generate-design', action: 'create' },
  create_design_from_candidate:  { nativeTool: 'create-design-from-candidate', action: 'create' },
  copy_design:                   { nativeTool: 'copy-design', action: 'create' },
  export_design:                 { nativeTool: 'export-design', action: 'read' },
  create_folder:                 { nativeTool: 'create-folder', action: 'create' },
  list_folder_items:             { nativeTool: 'list-folder-items', action: 'read' },
  search_folders:                { nativeTool: 'search-folders', action: 'read' },
  move_item_to_folder:           { nativeTool: 'move-item-to-folder', action: 'update' },
  comment_on_design:             { nativeTool: 'comment-on-design', action: 'create' },
  reply_to_comment:              { nativeTool: 'reply-to-comment', action: 'create' },
  list_comments:                 { nativeTool: 'list-comments', action: 'read' },
  list_replies:                  { nativeTool: 'list-replies', action: 'read' },
  resize_design:                 { nativeTool: 'resize-design', action: 'update' },
  start_editing_transaction:     { nativeTool: 'start-editing-transaction', action: 'update' },
  perform_editing_operations:    { nativeTool: 'perform-editing-operations', action: 'update' },
  commit_editing_transaction:    { nativeTool: 'commit-editing-transaction', action: 'update' },
  cancel_editing_transaction:    { nativeTool: 'cancel-editing-transaction', action: 'update' },
};

export interface CanvaMcpClientPort {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export const createCanvaDesignTool = (deps: {
  getClient: (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly connectionId: string;
    readonly minimumAccess: 'read_only' | 'read_write';
  }) => Promise<CanvaMcpClientPort | null>;
}): Tool<Args, Res> => ({
  id: asToolId('canvaDesign'),
  family: 'canva',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Search, create, edit, export, and collaborate on Canva designs through an approved shared Canva connection.',
  parameterDocs: 'connectionId: required Divo Canva connection ID from connections.list(provider: canva). op: an allow-listed Canva action. input: arguments for that exact operation only.',
  permissionCheck(args, perm) {
    const action = TOOL_BY_OPERATION[args.op].action;
    const allowed = perm.allowedActionsByTool.get(asToolId('canvaDesign'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'canvaDesign', action, reason: 'not_allowed' }));
  },
  async execute(args, ctx): Promise<Result<Res, ToolError>> {
    const operation = TOOL_BY_OPERATION[args.op];
    const client = await deps.getClient({
      companyId: ctx.runContext.companyId,
      userId: ctx.runContext.userId,
      connectionId: args.connectionId,
      minimumAccess: operation.action === 'read' ? 'read_only' : 'read_write',
    });
    if (!client) {
      return err(new ToolError({
        toolId: 'canvaDesign',
        reason: 'unrecoverable',
        message: 'Canva connection is unavailable or you do not have access to it',
      }));
    }
    try {
      ctx.onProgress?.(`Calling Canva: ${args.op.replaceAll('_', ' ')}…`);
      return ok({
        success: true,
        op: args.op,
        data: await client.callTool(operation.nativeTool, args.input ?? {}),
      });
    } catch (cause) {
      return err(new ToolError({
        toolId: 'canvaDesign',
        reason: 'upstream_failure',
        cause,
        message: `Canva ${args.op} failed: ${String(cause)}`,
      }));
    }
  },
});
