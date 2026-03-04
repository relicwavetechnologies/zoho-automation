import { z } from 'zod';

import { ADMIN_ROLES } from '../rbac.constants';

export const createAssignmentSchema = z.object({
  userId: z.string().uuid(),
  companyId: z.string().uuid(),
  roleId: z.enum(ADMIN_ROLES),
});

export const revokeAssignmentSchema = z.object({
  assignmentId: z.string().uuid(),
});

export type CreateAssignmentDto = z.infer<typeof createAssignmentSchema>;
export type RevokeAssignmentDto = z.infer<typeof revokeAssignmentSchema>;
