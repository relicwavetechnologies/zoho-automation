import { Router } from 'express';

import {
  requireAdminRole,
  requireAdminSession,
  requireRbacAction,
} from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { rbacController } from './rbac.controller';

const router = Router();

router.use(requireAdminSession());

router.get('/actions', requireRbacAction('rbac.permissions.read'), asyncHandler(rbacController.listActions));
router.get('/permissions', requireRbacAction('rbac.permissions.read'), asyncHandler(rbacController.listPermissions));
router.put(
  '/permissions',
  requireAdminRole('SUPER_ADMIN'),
  requireRbacAction('rbac.permissions.write'),
  asyncHandler(rbacController.updatePermission),
);

router.get('/assignments', requireRbacAction('rbac.permissions.read'), asyncHandler(rbacController.listAssignments));
router.post(
  '/assignments',
  requireAdminRole('SUPER_ADMIN'),
  requireRbacAction('rbac.assignments.write'),
  asyncHandler(rbacController.createAssignment),
);
router.delete(
  '/assignments',
  requireAdminRole('SUPER_ADMIN'),
  requireRbacAction('rbac.assignments.write'),
  asyncHandler(rbacController.revokeAssignment),
);

export default router;
