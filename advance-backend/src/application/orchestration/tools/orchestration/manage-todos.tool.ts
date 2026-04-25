/**
 * manageTodos — supervisor tool for creating and tracking a visible todo list.
 * Backed by SupervisorTodoRepository (chat-scoped, 24h TTL).
 * Not exposed to domain runners.
 */

import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { SupervisorTodoRepository } from '../../../../infrastructure/persistence/supervisor-todo.repository';
import type { RunContext } from '../../../../domain/orchestration/run-context';

const schema = z.object({
  op: z.enum(['list', 'add', 'update_status', 'clear']).describe(
    'list=show all todos; add=create one; update_status=mark done/in_progress/cancelled; clear=remove all',
  ),
  chatId: z.string().describe('The current chat/thread ID to scope todos'),
  title:  z.string().optional().describe('Todo title (required for add)'),
  id:     z.string().optional().describe('Todo id (required for update_status)'),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional().describe(
    'New status (required for update_status)',
  ),
});

export function createManageTodosTool(
  repo: SupervisorTodoRepository,
  runContext: RunContext,
) {
  return dynamicTool({
    description:
      'Manage a visible todo list for the current conversation. Use to track multi-step work so the user can see progress.',
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const args = input as {
        op:      'list' | 'add' | 'update_status' | 'clear';
        chatId:  string;
        title?:  string;
        id?:     string;
        status?: 'pending' | 'in_progress' | 'done' | 'cancelled';
      };
      const userId = String(runContext.userId);

      switch (args.op) {
        case 'list': {
          const todos = await repo.listByChatId(args.chatId, userId);
          if (todos.length === 0) return 'No todos for this chat.';
          return todos
            .map(t => `[${t.status}] ${t.position}. ${t.title} (id:${t.id})`)
            .join('\n');
        }

        case 'add': {
          if (!args.title) return 'error: title is required for add';
          const existing = await repo.listByChatId(args.chatId, userId);
          const nextPos = existing.length + 1;
          const todo = await repo.create({
            companyId: String(runContext.companyId),
            userId,
            channel:   runContext.channel,
            chatId:    args.chatId,
            title:     args.title,
            position:  nextPos,
          });
          return `Added todo: "${todo.title}" (id:${todo.id})`;
        }

        case 'update_status': {
          if (!args.id)     return 'error: id is required for update_status';
          if (!args.status) return 'error: status is required for update_status';
          const updated = await repo.updateStatus({ id: args.id, status: args.status });
          if (!updated) return `error: todo ${args.id} not found`;
          return `Updated "${updated.title}" → ${updated.status}`;
        }

        case 'clear': {
          await repo.clearByChatId(args.chatId, userId);
          return 'Todos cleared.';
        }
      }

      return 'error: unknown op';
    },
  });
}
