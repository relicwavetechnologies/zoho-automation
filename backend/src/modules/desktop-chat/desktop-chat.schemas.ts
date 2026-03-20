import { z } from 'zod';

export const attachedFileSchema = z.object({
  fileAssetId: z.string(),
  cloudinaryUrl: z.string().url(),
  mimeType: z.string(),
  fileName: z.string(),
});

export const workspaceSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
});

export const workflowInvocationSchema = z.object({
  workflowId: z.string().uuid(),
  workflowName: z.string().min(1).max(160).optional(),
  overrideText: z.string().trim().max(4000).optional(),
}).strict();

export const sendSchema = z.object({
  message: z.string().max(10000).optional().default(''),
  attachedFiles: z.array(attachedFileSchema).optional().default([]),
  workspace: workspaceSchema.optional(),
  mode: z.enum(['fast', 'high', 'xtreme']).optional().default('xtreme'),
  executionId: z.string().uuid().optional(),
  workflowInvocation: workflowInvocationSchema.optional(),
});

export const actionResultSchema = z.object({
  kind: z.enum(['list_files', 'read_file', 'write_file', 'mkdir', 'delete_path', 'run_command', 'tool_action']),
  ok: z.boolean(),
  summary: z.string().min(1).max(30000),
});

export const actSchema = z.object({
  message: z.string().min(1).max(10000).optional(),
  workspace: workspaceSchema.optional(),
  actionResult: actionResultSchema.optional(),
  mode: z.enum(['fast', 'high', 'xtreme']).optional().default('xtreme'),
  executionId: z.string().uuid().optional(),
});

export type DesktopSendRequest = z.infer<typeof sendSchema>;
export type DesktopActRequest = z.infer<typeof actSchema>;
