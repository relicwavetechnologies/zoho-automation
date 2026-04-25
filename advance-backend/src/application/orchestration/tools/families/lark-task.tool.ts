import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { ok, err } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';

// ─── People resolver port ─────────────────────────────────────────────────

export interface ResolvedPerson {
  openId:      string;
  displayName: string;
  email?:      string;
}

export interface PeopleResolverPort {
  resolve(
    companyId:       string,
    queries:         string[],
    requesterOpenId: string,
  ): Promise<{
    resolved:  ResolvedPerson[];
    ambiguous: Array<{ query: string; matches: ResolvedPerson[] }>;
    notFound:  string[];
  }>;
}

// ─── Arg schema ───────────────────────────────────────────────────────────

const LarkTaskArgsSchema = z.object({
  op: z.enum(['create', 'update', 'complete', 'delete', 'list', 'get']),
  title: z.string().optional(),
  taskId: z.string().optional(),
  dueDate: z.string().optional(),
  /** Explicit Lark open_ids. Takes priority over assigneeNames. */
  assigneeIds: z.array(z.string()).optional(),
  /** Human-readable names to resolve to open_ids (e.g. "Anish", "Shivam sir"). */
  assigneeNames: z.array(z.string()).optional(),
  followerIds: z.array(z.string()).optional(),
  notes: z.string().optional(),
  tasklist: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type LarkTaskArgs = z.infer<typeof LarkTaskArgsSchema>;

const LarkTaskResultSchema = z.object({
  success: z.boolean(),
  taskId: z.string().optional(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type LarkTaskResult = z.infer<typeof LarkTaskResultSchema>;

// ─── Action group inference ────────────────────────────────────────────────

const inferAction = (op: LarkTaskArgs['op']): ToolActionGroup => {
  if (op === 'list' || op === 'get')                    return 'read';
  if (op === 'create')                                   return 'create';
  if (op === 'update' || op === 'complete')              return 'update';
  if (op === 'delete')                                   return 'delete';
  return 'read';
};

// ─── Client port ──────────────────────────────────────────────────────────

export interface LarkTaskClientPort {
  createTask(params: {
    title: string;
    dueDate?: string;
    assigneeIds?: string[];
    followerIds?: string[];
    notes?: string;
    tasklist?: string;
  }): Promise<{ taskId: string; title: string }>;

  updateTask(taskId: string, params: {
    title?: string;
    dueDate?: string;
    assigneeIds?: string[];
    notes?: string;
  }): Promise<void>;

  completeTask(taskId: string): Promise<void>;

  deleteTask(taskId: string): Promise<void>;

  listTasks(params: { limit?: number; tasklist?: string }): Promise<Array<{ taskId: string; title: string; completed: boolean }>>;

  getTask(taskId: string): Promise<{ taskId: string; title: string; completed: boolean; dueDate?: string }>;
}

// ─── Factory ──────────────────────────────────────────────────────────────

export const createLarkTaskTool = (deps: {
  client:         LarkTaskClientPort;
  peopleResolver: PeopleResolverPort;
}): Tool<LarkTaskArgs, LarkTaskResult> => ({
  id: asToolId('larkTask'),
  family: 'lark',
  actionGroups: new Set(['read', 'create', 'update', 'delete']),
  argsSchema: LarkTaskArgsSchema,
  resultSchema: LarkTaskResultSchema,
  description: 'Create, read, update, complete, or delete Lark tasks.',
  parameterDocs: `
- op: Operation to perform. One of: create, update, complete, delete, list, get.
- title: Task title (required for create).
- taskId: Task ID (required for update, complete, delete, get).
- dueDate: ISO 8601 due date (optional).
- assigneeIds: Array of Lark open_ids to assign (optional). Takes priority over assigneeNames.
- assigneeNames: Array of human-readable names to assign, e.g. ["Anish", "Shivam sir"]. Resolved automatically to open_ids.
- notes: Task description/notes (optional).
- limit: Max tasks to return for list (default 20).
  `.trim(),

  permissionCheck(args: LarkTaskArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const toolId = asToolId('larkTask');
    const allowed = perm.allowedActionsByTool.get(toolId)?.has(action) ?? false;
    if (!allowed) {
      return err(new PermissionError({
        toolId: 'larkTask',
        action,
        reason: 'not_allowed',
        message: `larkTask:${action} is not permitted in the current context`,
      }));
    }
    return ok(action);
  },

  async execute(args: LarkTaskArgs, ctx: ToolExecutionContext): Promise<Result<LarkTaskResult, ToolError>> {
    const log = ctx.logger.child({ tool: 'larkTask', op: args.op, correlationId: ctx.correlationId });
    try {
      switch (args.op) {
        case 'create': {
          if (!args.title) {
            return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'title is required for create' }));
          }

          // Resolve assignees: explicit ids → name lookup → self fallback
          let assigneeIds: string[] | undefined;
          if (args.assigneeIds?.length) {
            assigneeIds = args.assigneeIds;
          } else if (args.assigneeNames?.length) {
            const requesterOpenId = ctx.runContext.userExternalId ?? '';
            const resolved = await deps.peopleResolver.resolve(
              String(ctx.runContext.companyId),
              args.assigneeNames,
              requesterOpenId,
            );

            if (resolved.notFound.length > 0) {
              return err(new ToolError({
                toolId: 'larkTask',
                reason: 'bad_args',
                message: `Could not find Lark users: ${resolved.notFound.join(', ')}`,
              }));
            }
            if (resolved.ambiguous.length > 0) {
              const detail = resolved.ambiguous
                .map(a => `"${a.query}" → ${a.matches.map(m => m.displayName).join(' / ')}`)
                .join('; ');
              return err(new ToolError({
                toolId: 'larkTask',
                reason: 'bad_args',
                message: `Ambiguous assignee names — please clarify: ${detail}`,
              }));
            }
            assigneeIds = resolved.resolved.map(p => p.openId);
          } else {
            // Default: self-assign so task appears in requester's "My Tasks"
            assigneeIds = ctx.runContext.userExternalId
              ? [ctx.runContext.userExternalId]
              : undefined;
          }

          const result = await deps.client.createTask({
            title: args.title,
            ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
            ...(assigneeIds !== undefined ? { assigneeIds } : {}),
            ...(args.followerIds !== undefined ? { followerIds: args.followerIds } : {}),
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
            ...(args.tasklist !== undefined ? { tasklist: args.tasklist } : {}),
          });
          log.info('larkTask.created', { taskId: result.taskId, assigneeIds });
          return ok({ success: true, taskId: result.taskId, data: result, message: `Task "${result.title}" created` });
        }
        case 'update': {
          if (!args.taskId) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId is required for update' }));
          await deps.client.updateTask(args.taskId, {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
            ...(args.assigneeIds !== undefined ? { assigneeIds: args.assigneeIds } : {}),
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
          });
          return ok({ success: true, taskId: args.taskId, message: 'Task updated' });
        }
        case 'complete': {
          if (!args.taskId) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId is required for complete' }));
          await deps.client.completeTask(args.taskId);
          return ok({ success: true, taskId: args.taskId, message: 'Task marked complete' });
        }
        case 'delete': {
          if (!args.taskId) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId is required for delete' }));
          await deps.client.deleteTask(args.taskId);
          return ok({ success: true, taskId: args.taskId, message: 'Task deleted' });
        }
        case 'list': {
          const tasks = await deps.client.listTasks({ limit: args.limit ?? 20, ...(args.tasklist !== undefined ? { tasklist: args.tasklist } : {}) });
          return ok({ success: true, data: tasks, message: `Found ${tasks.length} tasks` });
        }
        case 'get': {
          if (!args.taskId) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId is required for get' }));
          const task = await deps.client.getTask(args.taskId);
          return ok({ success: true, taskId: task.taskId, data: task });
        }
      }
    } catch (e) {
      log.error('larkTask.execute.error', { error: String(e) });
      return err(new ToolError({ toolId: 'larkTask', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
