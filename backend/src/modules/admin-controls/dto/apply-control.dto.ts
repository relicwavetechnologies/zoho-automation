import { z } from 'zod';

export const ADMIN_CONTROL_KEYS = [
  'zoho.integration.enabled',
  'runtime.historical_sync.enabled',
  'runtime.delta_sync.enabled',
] as const;

export const applyControlSchema = z.object({
  controlKey: z.enum(ADMIN_CONTROL_KEYS),
  requestedValue: z.boolean(),
  companyId: z.string().uuid().optional(),
  confirmation: z.literal('APPLY'),
});

export type ApplyControlDto = z.infer<typeof applyControlSchema>;
