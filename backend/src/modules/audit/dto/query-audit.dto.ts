import { z } from 'zod';

export const queryAuditSchema = z.object({
  companyId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().min(1).optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type QueryAuditDto = z.infer<typeof queryAuditSchema>;
