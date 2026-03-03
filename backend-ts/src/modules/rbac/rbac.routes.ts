import { Router } from 'express';

import { requireRole } from '../../middlewares/org.middleware';
import { asyncHandler } from '../../utils/async-handler';
import {
  createRbacRole,
  deleteRbacRole,
  getMemberRoles,
  getRolePermissions,
  getSessionCapabilities,
  listRbacRoles,
  policyCheck,
  putMemberRoles,
  putRolePermissions,
  updateRbacRole,
} from './rbac.controller';

const rbacRouter = Router();

rbacRouter.get('/roles', requireRole(['owner', 'admin']), asyncHandler(listRbacRoles));
rbacRouter.post('/roles', requireRole(['owner', 'admin']), asyncHandler(createRbacRole));
rbacRouter.patch('/roles/:id', requireRole(['owner', 'admin']), asyncHandler(updateRbacRole));
rbacRouter.delete('/roles/:id', requireRole(['owner', 'admin']), asyncHandler(deleteRbacRole));

rbacRouter.get('/role-permissions', requireRole(['owner', 'admin']), asyncHandler(getRolePermissions));
rbacRouter.put('/role-permissions/:role_id', requireRole(['owner', 'admin']), asyncHandler(putRolePermissions));

rbacRouter.get('/members/:member_id/roles', requireRole(['owner', 'admin']), asyncHandler(getMemberRoles));
rbacRouter.put('/members/:member_id/roles', requireRole(['owner', 'admin']), asyncHandler(putMemberRoles));

rbacRouter.post('/policy/check', asyncHandler(policyCheck));

export { getSessionCapabilities };
export default rbacRouter;
