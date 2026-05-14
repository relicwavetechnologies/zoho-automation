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
  op: z.enum([
    'create', 'update', 'complete', 'delete', 'list', 'get',
    'list_tasklists', 'create_tasklist', 'add_to_tasklist', 'remove_from_tasklist',
    'list_subtasks', 'create_subtask',
  ]),
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
  // tasklist ops
  tasklistId: z.string().optional(),
  // subtask ops
  parentTaskId: z.string().optional(),
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
  if (op === 'list' || op === 'get' || op === 'list_tasklists' || op === 'list_subtasks') return 'read';
  if (op === 'create' || op === 'create_tasklist' || op === 'create_subtask') return 'create';
  if (op === 'update' || op === 'complete' || op === 'add_to_tasklist' || op === 'remove_from_tasklist') return 'update';
  return 'delete';
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

  listTasklists(): Promise<Array<{ guid: string; name: string }>>;

  createTasklist(name: string, memberIds?: string[]): Promise<{ guid: string; name: string }>;

  addTaskToTasklist(tasklistGuid: string, taskGuid: string): Promise<void>;

  removeTaskFromTasklist(tasklistGuid: string, taskGuid: string): Promise<void>;

  listSubtasks(taskId: string): Promise<Array<{ taskId: string; title: string; completed: boolean }>>;

  createSubtask(parentTaskId: string, params: {
    title: string;
    assigneeIds?: string[];
    dueDate?: string;
    notes?: string;
  }): Promise<{ taskId: string; title: string }>;
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
  description: 'Create, read, update, complete, delete Lark tasks; manage tasklists and subtasks.',
  parameterDocs: `
- op: create|update|complete|delete|list|get|list_tasklists|create_tasklist|add_to_tasklist|remove_from_tasklist|list_subtasks|create_subtask
- title: Task title (required for create, create_subtask, create_tasklist).
- taskId: Task ID (required for update, complete, delete, get, add_to_tasklist, remove_from_tasklist, list_subtasks).
- parentTaskId: Parent task ID (required for create_subtask).
- tasklistId: Tasklist GUID (required for add_to_tasklist, remove_from_tasklist).
- dueDate: ISO 8601 due date (optional).
- assigneeIds: Array of Lark open_ids (optional). Takes priority over assigneeNames.
- assigneeNames: Array of human-readable names, e.g. ["Anish", "Shivam sir"]. Resolved automatically.
- notes: Task description/notes (optional).
- limit: Max tasks to return for list (default 20).
  `.trim(),

  permissionCheck(args: LarkTaskArgs, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = inferAction(args.op);
    const toolId = asToolId('larkTask');
    const allowed = perm.allowedActionsByTool.get(toolId)?.has(action) ?? false;
    if (!allowed) {
      return err(new PermissionError({ toolId: 'larkTask', action, reason: 'not_allowed' }));
    }
    return ok(action);
  },

  async execute(args: LarkTaskArgs, ctx: ToolExecutionContext): Promise<Result<LarkTaskResult, ToolError>> {
    const log = ctx.logger.child({ tool: 'larkTask', op: args.op, correlationId: ctx.correlationId });

    const resolveAssignees = async (): Promise<string[] | undefined> => {
      if (args.assigneeIds?.length) return args.assigneeIds;
      if (args.assigneeNames?.length) {
        const requesterOpenId = ctx.runContext.userExternalId ?? '';
        const resolved = await deps.peopleResolver.resolve(String(ctx.runContext.companyId), args.assigneeNames, requesterOpenId);
        if (resolved.notFound.length > 0)
          throw new Error(`Could not find Lark users: ${resolved.notFound.join(', ')}`);
        if (resolved.ambiguous.length > 0) {
          const detail = resolved.ambiguous.map(a => `"${a.query}" → ${a.matches.map(m => m.displayName).join(' / ')}`).join('; ');
          throw new Error(`Ambiguous assignee names — please clarify: ${detail}`);
        }
        return resolved.resolved.map(p => p.openId);
      }
      return undefined;
    };

    try {
      switch (args.op) {
        case 'create': {
          if (!args.title) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'title is required for create' }));
          ctx.onProgress?.(`Creating task "${args.title.slice(0, 40)}"…`);
          let assigneeIds = await resolveAssignees();
          if (!assigneeIds && ctx.runContext.userExternalId) {
            assigneeIds = [ctx.runContext.userExternalId];
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
          const assigneeIds = await resolveAssignees();
          await deps.client.updateTask(args.taskId, {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
            ...(assigneeIds !== undefined ? { assigneeIds } : {}),
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
          ctx.onProgress?.('Fetching Lark tasks…');
          const tasks = await deps.client.listTasks({ limit: args.limit ?? 20, ...(args.tasklist !== undefined ? { tasklist: args.tasklist } : {}) });
          return ok({ success: true, data: tasks, message: `Found ${tasks.length} tasks` });
        }

        case 'get': {
          if (!args.taskId) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId is required for get' }));
          const task = await deps.client.getTask(args.taskId);
          return ok({ success: true, taskId: task.taskId, data: task });
        }

        case 'list_tasklists': {
          const lists = await deps.client.listTasklists();
          return ok({ success: true, data: lists, message: `Found ${lists.length} tasklist(s)` });
        }

        case 'create_tasklist': {
          if (!args.title) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'title required for create_tasklist' }));
          const memberIds = await resolveAssignees();
          const tl = await deps.client.createTasklist(args.title, memberIds);
          return ok({ success: true, data: tl, message: `Tasklist "${tl.name}" created` });
        }

        case 'add_to_tasklist': {
          if (!args.taskId || !args.tasklistId)
            return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId and tasklistId required' }));
          await deps.client.addTaskToTasklist(args.tasklistId, args.taskId);
          return ok({ success: true, taskId: args.taskId, message: 'Task added to tasklist' });
        }

        case 'remove_from_tasklist': {
          if (!args.taskId || !args.tasklistId)
            return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId and tasklistId required' }));
          await deps.client.removeTaskFromTasklist(args.tasklistId, args.taskId);
          return ok({ success: true, taskId: args.taskId, message: 'Task removed from tasklist' });
        }

        case 'list_subtasks': {
          if (!args.taskId) return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'taskId required' }));
          const subtasks = await deps.client.listSubtasks(args.taskId);
          return ok({ success: true, data: subtasks, message: `Found ${subtasks.length} subtask(s)` });
        }

        case 'create_subtask': {
          if (!args.parentTaskId || !args.title)
            return err(new ToolError({ toolId: 'larkTask', reason: 'bad_args', message: 'parentTaskId and title required' }));
          const assigneeIds = await resolveAssignees();
          const result = await deps.client.createSubtask(args.parentTaskId, {
            title: args.title,
            ...(assigneeIds ? { assigneeIds } : {}),
            ...(args.dueDate ? { dueDate: args.dueDate } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
          });
          log.info('larkTask.subtask.created', { taskId: result.taskId, parentTaskId: args.parentTaskId });
          return ok({ success: true, taskId: result.taskId, data: result, message: `Subtask "${result.title}" created` });
        }
      }
    } catch (e) {
      log.error('larkTask.execute.error', { error: String(e) });
      return err(new ToolError({ toolId: 'larkTask', reason: 'upstream_failure', cause: e, message: String(e) }));
    }
  },
});
