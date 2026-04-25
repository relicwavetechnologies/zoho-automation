import { z } from 'zod';

export const ToolActionGroupSchema = z.enum([
  'read',
  'create',
  'update',
  'delete',
  'send',
  'execute',
]);

export type ToolActionGroup = z.infer<typeof ToolActionGroupSchema>;

export const ALL_ACTION_GROUPS: readonly ToolActionGroup[] = [
  'read', 'create', 'update', 'delete', 'send', 'execute',
] as const;
