import { z } from 'zod';

export const deltaSyncEventSchema = z.object({
  source: z.literal('zoho'),
  sourceType: z.enum(['zoho_lead', 'zoho_contact', 'zoho_deal', 'zoho_ticket']),
  sourceId: z.string().min(1),
  changedAt: z.string().datetime(),
  companyId: z.string().uuid(),
  operation: z.enum(['create', 'update', 'delete']),
  eventKey: z.string().min(6),
  payload: z.record(z.unknown()).optional(),
});

export type DeltaSyncEventDto = z.infer<typeof deltaSyncEventSchema>;
