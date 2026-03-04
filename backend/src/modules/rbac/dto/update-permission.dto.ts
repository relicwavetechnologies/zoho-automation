import { z } from 'zod';

import { ADMIN_ROLES, RBAC_ACTIONS } from '../rbac.constants';

export const updatePermissionSchema = z.object({
  roleId: z.enum(ADMIN_ROLES),
  actionId: z.enum(RBAC_ACTIONS),
  allowed: z.boolean(),
});

export type UpdatePermissionDto = z.infer<typeof updatePermissionSchema>;
