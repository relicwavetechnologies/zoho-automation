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

