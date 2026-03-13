import { z } from 'zod';

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

export type ZohoResult = z.infer<typeof zohoResultSchema>;
export type LarkDocResult = z.infer<typeof larkDocResultSchema>;
export type OutreachResult = z.infer<typeof outreachResultSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
