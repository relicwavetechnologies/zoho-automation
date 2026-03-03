import { Router } from 'express';

import { requireRole } from '../../middlewares/org.middleware';
import { asyncHandler } from '../../utils/async-handler';
import {
  createRole,
  deleteRole,
  listMembers,
  listRoles,
  listTools,
  setToolEnabled,
  updateMember,
  updateRole,
  updateRoleToolPermission,
} from './admin.controller';

const adminRouter = Router();

adminRouter.get('/members', requireRole(['owner', 'admin']), asyncHandler(listMembers));
adminRouter.patch('/members/:id', requireRole(['owner', 'admin']), asyncHandler(updateMember));

adminRouter.get('/roles', requireRole(['owner', 'admin']), asyncHandler(listRoles));
adminRouter.post('/roles', requireRole(['owner', 'admin']), asyncHandler(createRole));
adminRouter.patch('/roles/:id', requireRole(['owner', 'admin']), asyncHandler(updateRole));
adminRouter.delete('/roles/:id', requireRole(['owner', 'admin']), asyncHandler(deleteRole));

adminRouter.get('/tools', requireRole(['owner', 'admin']), asyncHandler(listTools));
adminRouter.patch('/roles/:roleId/tools/:toolKey', requireRole(['owner', 'admin']), asyncHandler(updateRoleToolPermission));
adminRouter.patch('/tools/:toolKey', requireRole(['owner', 'admin']), asyncHandler(setToolEnabled));

export default adminRouter;
