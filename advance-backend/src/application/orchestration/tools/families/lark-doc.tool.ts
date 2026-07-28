import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import {
  larkConnectionSelectionData,
  larkConnectionRequiredMessage,
  resolveLarkUserClient,
  type LarkUserTokenResolver,
} from './lark-user-connection';

const BlockTypeSchema = z.enum([
  'text',
  'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9',
  'bullet', 'ordered', 'code', 'quote', 'todo', 'divider',
]);
const TextStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  underline: z.boolean().optional(),
  inlineCode: z.boolean().optional(),
  backgroundColor: z.number().int().min(1).max(15).optional(),
  textColor: z.number().int().min(1).max(7).optional(),
  link: z.string().url().refine(value => /^https?:\/\//i.test(value), 'link must use http or https').optional(),
}).strict();
const BlockStyleSchema = z.object({
  align: z.enum(['left', 'center', 'right']).optional(),
  done: z.boolean().optional(),
  folded: z.boolean().optional(),
  codeLanguage: z.number().int().min(1).max(75).optional(),
  wrap: z.boolean().optional(),
  backgroundColor: z.enum([
    'LightGrayBackground', 'LightRedBackground', 'LightOrangeBackground', 'LightYellowBackground',
    'LightGreenBackground', 'LightBlueBackground', 'LightPurpleBackground', 'PaleGrayBackground',
    'DarkGrayBackground', 'DarkRedBackground', 'DarkOrangeBackground', 'DarkYellowBackground',
    'DarkGreenBackground', 'DarkBlueBackground', 'DarkPurpleBackground',
  ]).optional(),
  indentationLevel: z.enum(['NoIndent', 'OneLevelIndent']).optional(),
}).strict();
const BlockSchema = z.object({
  content: z.string().min(1).max(100_000).optional(),
  blockType: BlockTypeSchema.optional(),
  textStyle: TextStyleSchema.optional(),
  blockStyle: BlockStyleSchema.optional(),
});
const DriveFileTypeSchema = z.enum([
  'doc', 'sheet', 'bitable', 'mindnote', 'file', 'wiki', 'docx', 'folder', 'synced_block', 'slides',
]);
const CopyableDriveFileTypeSchema = z.enum([
  'file', 'doc', 'sheet', 'bitable', 'docx', 'mindnote', 'slides',
]);
const MovableDriveFileTypeSchema = z.enum([
  'file', 'docx', 'bitable', 'doc', 'sheet', 'mindnote', 'folder', 'slides',
]);
const DriveNameSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 256,
  'name must be at most 256 UTF-8 bytes',
);

export type LarkDocTextStyle = z.infer<typeof TextStyleSchema>;
export type LarkDocBlockStyle = z.infer<typeof BlockStyleSchema>;
export type LarkDocBlockInput = z.infer<typeof BlockSchema>;
export type LarkDriveFileType = z.infer<typeof DriveFileTypeSchema>;
export type LarkCopyableDriveFileType = z.infer<typeof CopyableDriveFileTypeSchema>;
export type LarkMovableDriveFileType = z.infer<typeof MovableDriveFileTypeSchema>;

const Schema = z.object({
  op: z.enum([
    'get', 'create', 'list_blocks', 'append_block', 'append_blocks', 'update_block', 'update_block_style',
    'delete_block', 'insert_table', 'share', 'get_metadata', 'list_files', 'create_folder', 'copy_file', 'move_file',
    'check_drive_task',
  ]),
  docToken: z.string().optional(),
  title: z.string().optional(),
  content: z.string().max(100_000).optional(),
  blockType: BlockTypeSchema.optional(),
  textStyle: TextStyleSchema.optional(),
  blockStyle: BlockStyleSchema.optional(),
  blocks: z.array(BlockSchema).min(1).max(50).optional(),
  blockId: z.string().optional(),
  rows: z.number().int().min(1).max(50).optional(),
  cols: z.number().int().min(1).max(20).optional(),
  headers: z.array(z.string()).optional(),
  data: z.array(z.array(z.string())).max(50).optional(),
  visibility: z.enum(['anyone', 'tenant', 'specified']).optional(),
  fileToken: z.string().optional(),
  fileType: DriveFileTypeSchema.optional(),
  folderToken: z.string().optional(),
  name: DriveNameSchema.optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  pageToken: z.string().optional(),
  orderBy: z.enum(['EditedTime', 'CreatedTime']).optional(),
  direction: z.enum(['ASC', 'DESC']).optional(),
  taskId: z.string().optional(),
  /** Exact Divo-managed Lark connection when more than one is accessible. */
  connectionId: z.string().uuid().optional(),
});
type Args = z.infer<typeof Schema>;

const ResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  docToken: z.string().optional(),
  url: z.string().url().optional(),
  message: z.string().optional(),
});
type Res = z.infer<typeof ResultSchema>;

export interface LarkDocClientPort {
  getDoc(docToken: string): Promise<unknown>;
  createDoc(title: string): Promise<{ docToken: string; url?: string }>;
  appendBlock(docToken: string, content: string, blockType?: LarkDocBlockInput['blockType'], textStyle?: LarkDocTextStyle, blockStyle?: LarkDocBlockStyle): Promise<void>;
  appendBlocks(docToken: string, blocks: LarkDocBlockInput[]): Promise<void>;
  listBlocks(docToken: string): Promise<unknown[]>;
  updateBlock(docToken: string, blockId: string, content: string, textStyle?: LarkDocTextStyle): Promise<void>;
  updateBlockStyle(docToken: string, blockId: string, style: LarkDocBlockStyle): Promise<void>;
  deleteBlock(docToken: string, blockId: string): Promise<void>;
  insertTable(docToken: string, params: { afterBlockId?: string; rows: number; cols: number; headers?: string[]; data?: string[][] }): Promise<void>;
  shareDoc(docToken: string, visibility: string): Promise<{ shareUrl?: string }>;
  getDriveMetadata(fileToken: string, fileType: LarkDriveFileType): Promise<unknown>;
  listDriveFiles(params: { folderToken?: string; pageSize?: number; pageToken?: string; orderBy?: 'EditedTime' | 'CreatedTime'; direction?: 'ASC' | 'DESC' }): Promise<unknown>;
  createDriveFolder(name: string, folderToken?: string): Promise<unknown>;
  copyDriveFile(fileToken: string, params: { fileType: LarkCopyableDriveFileType; name: string; folderToken?: string }): Promise<unknown>;
  moveDriveFile(fileToken: string, params: { fileType: LarkMovableDriveFileType; folderToken?: string }): Promise<unknown>;
  checkDriveTask(taskId: string): Promise<unknown>;
}

const inferAction = (op: Args['op']): ToolActionGroup => {
  if (op === 'get' || op === 'list_blocks' || op === 'get_metadata' || op === 'list_files' || op === 'check_drive_task') return 'read';
  if (op === 'create' || op === 'create_folder' || op === 'copy_file') return 'create';
  return 'update';
};

export const createLarkDocTool = (deps: {
  client: LarkDocClientPort;
  userTokenResolver?: LarkUserTokenResolver;
  createUserClient?: (userToken: string) => LarkDocClientPort;
}): Tool<Args, Res> => ({
  id: asToolId('larkDoc'),
  family: 'lark',
  actionGroups: new Set(['read', 'create', 'update']),
  argsSchema: Schema,
  resultSchema: ResultSchema,
  description: 'Read, create, and edit Lark Docs and organize Drive content — native formatted blocks, tables, metadata, folders, file listing, copy, move, and sharing.',
  parameterDocs: `
- op: get|create|list_blocks|append_block|append_blocks|update_block|update_block_style|delete_block|insert_table|share|get_metadata|list_files|create_folder|copy_file|move_file|check_drive_task
- docToken: Lark doc token (required for Docx operations except create)
- title: Doc title (required for create)
- create always returns docToken and resolves the canonical Lark document URL when Drive metadata provides it
- content: Block text content (for append_block, update_block). Omit only for a divider.
- blockType: text|heading1..heading9|bullet|ordered|code|quote|todo|divider (default: text). Use todo for an interactive document checklist; do not imitate one with bullet characters or emoji.
- textStyle: Optional inline bold, italic, strikethrough, underline, inlineCode, backgroundColor (1–15), textColor (1–7), and link URL.
- blockStyle: Optional align, todo done, folded, codeLanguage (1–75), wrap, backgroundColor, or indentationLevel. update_block_style requires blockId and at least one style field.
- Use done only on todo blocks; codeLanguage/wrap only on code; indentationLevel only on text; folded only on headings, text, ordered, bullet, or todo.
- blocks: Ordered content blocks for append_blocks. Prefer this over many append_block calls when writing a section or document.
- For bullet blocks, provide plain text without a leading bullet character.
- blockId: Block ID (required for update_block, delete_block; optional afterBlockId for insert_table)
- rows, cols: Table dimensions in cells (required for insert_table; rows includes the header row when headers are present)
- headers: Column header strings (optional, for insert_table)
- data: Table body rows (optional, for insert_table). Put row/column data here instead of appending it as bullets after an empty table.
- visibility: anyone|tenant|specified (required for share)
- fileToken, fileType: Drive file token and matching provider type (required for get_metadata, copy_file, move_file)
- folderToken: Parent/target folder token. Omit for the user's Drive root.
- name: Folder name for create_folder or destination filename for copy_file (maximum 256 UTF-8 bytes)
- pageSize, pageToken, orderBy, direction: Optional list_files pagination and sorting controls
- taskId: Async Drive task ID (required for check_drive_task; use when move_file returns task_id)
- connectionId: Exact accessible Lark UUID. In backend-hosted channels, omit it when no account was supplied; the backend selects only one accessible account or returns exact choices.
  `.trim(),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const allowed = perm.allowedActionsByTool.get(asToolId('larkDoc'))?.has(action) ?? false;
    return allowed ? ok(action) : err(new PermissionError({ toolId: 'larkDoc', action, reason: 'not_allowed' }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    try {
      const userConnection = await resolveLarkUserClient(deps, ctx, {
        ...(args.connectionId ? { connectionId: args.connectionId } : {}),
        minimumAccess: inferAction(args.op) === 'read' ? 'read_only' : 'read_write',
      });
      if (userConnection.status === 'choose_connection') {
        return ok({ success: false, data: larkConnectionSelectionData(userConnection.connections), message: 'Choose a Lark connection before continuing.' });
      }
      if (deps.userTokenResolver && userConnection.status === 'unavailable') {
        return err(new ToolError({ toolId: 'larkDoc', reason: 'unrecoverable', message: larkConnectionRequiredMessage }));
      }
      const client = userConnection.status === 'resolved' ? userConnection.client : deps.client;
      switch (args.op) {
        case 'get': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          ctx.onProgress?.('Reading document…');
          return ok({ success: true, data: await client.getDoc(args.docToken) });
        }
        case 'create': {
          if (!args.title) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'title required' }));
          ctx.onProgress?.('Creating document…');
          const r = await client.createDoc(args.title);
          return ok({
            success: true,
            docToken: r.docToken,
            ...(r.url ? { url: r.url } : {}),
            data: {
              title: args.title,
              docToken: r.docToken,
              ...(r.url ? { url: r.url } : {}),
            },
            message: r.url
              ? 'Doc created'
              : 'Doc created, but Lark Drive metadata did not return a canonical URL',
          });
        }
        case 'append_block': {
          if (!args.docToken || (!args.content && args.blockType !== 'divider'))
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and content required unless blockType is divider' }));
          if (args.blockType === 'divider' && Boolean(args.content || args.textStyle || args.blockStyle))
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'divider blocks cannot contain content or styles' }));
          ctx.onProgress?.('Updating document…');
          await client.appendBlock(args.docToken, args.content ?? '', args.blockType, args.textStyle, args.blockStyle);
          return ok({ success: true, message: 'Block appended' });
        }
        case 'append_blocks': {
          if (!args.docToken || !args.blocks
            || args.blocks.some(block =>
              block.blockType === 'divider'
                ? Boolean(block.content || block.textStyle || block.blockStyle)
                : !block.content))
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'non-divider blocks require content; divider blocks cannot contain content or styles' }));
          ctx.onProgress?.('Updating document…');
          await client.appendBlocks(args.docToken, args.blocks);
          return ok({ success: true, message: `${args.blocks.length} blocks appended` });
        }
        case 'list_blocks': {
          if (!args.docToken) return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken required' }));
          return ok({ success: true, data: await client.listBlocks(args.docToken) });
        }
        case 'update_block': {
          if (!args.docToken || !args.blockId || !args.content)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, blockId, and content required' }));
          await client.updateBlock(args.docToken, args.blockId, args.content, args.textStyle);
          return ok({ success: true, message: 'Block updated' });
        }
        case 'update_block_style': {
          if (!args.docToken || !args.blockId || !args.blockStyle || Object.keys(args.blockStyle).length === 0)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, blockId, and blockStyle required' }));
          await client.updateBlockStyle(args.docToken, args.blockId, args.blockStyle);
          return ok({ success: true, message: 'Block style updated' });
        }
        case 'delete_block': {
          if (!args.docToken || !args.blockId)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and blockId required' }));
          await client.deleteBlock(args.docToken, args.blockId);
          return ok({ success: true, message: 'Block deleted' });
        }
        case 'insert_table': {
          if (!args.docToken || !args.rows || !args.cols)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken, rows, and cols required' }));
          const { rows, cols } = args;
          const bodyCapacity = args.rows - (args.headers?.length ? 1 : 0);
          if ((args.headers?.length ?? 0) > cols
            || (args.data?.length ?? 0) > bodyCapacity
            || args.data?.some(row => row.length > cols)) {
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'headers and data must fit the declared table dimensions' }));
          }
          await client.insertTable(args.docToken, {
            rows,
            cols,
            ...(args.blockId ? { afterBlockId: args.blockId } : {}),
            ...(args.headers ? { headers: args.headers } : {}),
            ...(args.data ? { data: args.data } : {}),
          });
          return ok({ success: true, message: `Table (${args.rows}×${args.cols}) inserted` });
        }
        case 'share': {
          if (!args.docToken || !args.visibility)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'docToken and visibility required' }));
          const r = await client.shareDoc(args.docToken, args.visibility);
          return ok({ success: true, docToken: args.docToken, data: r, message: 'Doc sharing updated' });
        }
        case 'get_metadata': {
          if (!args.fileToken || !args.fileType)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'fileToken and fileType required' }));
          return ok({ success: true, data: await client.getDriveMetadata(args.fileToken, args.fileType) });
        }
        case 'list_files': {
          return ok({
            success: true,
            data: await client.listDriveFiles({
              ...(args.folderToken !== undefined ? { folderToken: args.folderToken } : {}),
              ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
              ...(args.pageToken ? { pageToken: args.pageToken } : {}),
              ...(args.orderBy ? { orderBy: args.orderBy } : {}),
              ...(args.direction ? { direction: args.direction } : {}),
            }),
          });
        }
        case 'create_folder': {
          if (!args.name)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'name required' }));
          return ok({
            success: true,
            data: await client.createDriveFolder(args.name, args.folderToken),
            message: 'Folder created',
          });
        }
        case 'copy_file': {
          if (!args.fileToken || !args.name || !args.fileType || !CopyableDriveFileTypeSchema.safeParse(args.fileType).success)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'fileToken, copyable fileType, and name required' }));
          return ok({
            success: true,
            data: await client.copyDriveFile(args.fileToken, {
              fileType: args.fileType as LarkCopyableDriveFileType,
              name: args.name,
              ...(args.folderToken !== undefined ? { folderToken: args.folderToken } : {}),
            }),
            message: 'File copied',
          });
        }
        case 'move_file': {
          if (!args.fileToken || !args.fileType || !MovableDriveFileTypeSchema.safeParse(args.fileType).success)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'fileToken and movable fileType required' }));
          return ok({
            success: true,
            data: await client.moveDriveFile(args.fileToken, {
              fileType: args.fileType as LarkMovableDriveFileType,
              ...(args.folderToken !== undefined ? { folderToken: args.folderToken } : {}),
            }),
            message: 'Move accepted',
          });
        }
        case 'check_drive_task': {
          if (!args.taskId)
            return err(new ToolError({ toolId: 'larkDoc', reason: 'bad_args', message: 'taskId required' }));
          return ok({ success: true, data: await client.checkDriveTask(args.taskId) });
        }
      }
    } catch (e) {
      return err(new ToolError({ toolId: 'larkDoc', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
