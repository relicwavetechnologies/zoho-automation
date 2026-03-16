import { z } from 'zod';

export const specialistResultSchema = z.object({
  workerKey: z.string(),
  success: z.boolean(),
  summary: z.string(),
  keyData: z.record(z.string(), z.unknown()).default({}),
  fullPayload: z.string().default(''),
  sourceUrls: z.array(z.string()).default([]),
  timestamp: z.number(),
  retryCount: z.number().default(0),
  errorKind: z.string().optional(),
  retryable: z.boolean().optional(),
  error: z.string().optional(),
});

export const zohoResultSchema = z.object({
  success: z.boolean(),
  recordId: z.string().optional(),
  recordType: z.string().optional(),
  summary: z.string(),
  error: z.string().optional(),
});

export const larkDocResultSchema = z.object({
  success: z.boolean(),
  docToken: z.string().optional(),
  docUrl: z.string().optional(),
  operation: z.enum(['created', 'updated', 'read']),
  summary: z.string(),
  error: z.string().optional(),
});

export const larkOperationalResultSchema = z.object({
  success: z.boolean(),
  summary: z.string(),
  error: z.string().optional(),
  errorKind: z.enum(['missing_input', 'unsupported', 'permission', 'api_failure', 'unknown']).optional(),
  retryable: z.boolean().optional(),
  userAction: z.string().optional(),
  taskId: z.string().optional(),
  eventId: z.string().optional(),
  documentId: z.string().optional(),
  recordId: z.string().optional(),
});

export const outreachResultSchema = z.object({
  success: z.boolean(),
  campaignId: z.string().optional(),
  recipientCount: z.number().optional(),
  summary: z.string(),
  error: z.string().optional(),
});

export const searchResultSchema = z.object({
  success: z.boolean(),
  resultCount: z.number(),
  summary: z.string(),
  sources: z.array(z.string()).optional(),
});

export const terminalOperationalResultSchema = z.object({
  success: z.boolean(),
  summary: z.string(),
  command: z.string().optional(),
  cwdHint: z.string().optional(),
  verificationCommand: z.string().optional(),
  writesToWorkspace: z.boolean().optional(),
  needsApproval: z.boolean().optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
  userAction: z.string().optional(),
});

export type ZohoResult = z.infer<typeof zohoResultSchema>;
export type LarkDocResult = z.infer<typeof larkDocResultSchema>;
export type LarkOperationalResult = z.infer<typeof larkOperationalResultSchema>;
export type OutreachResult = z.infer<typeof outreachResultSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type TerminalOperationalResult = z.infer<typeof terminalOperationalResultSchema>;
export type SpecialistResultRecord = z.infer<typeof specialistResultSchema>;
