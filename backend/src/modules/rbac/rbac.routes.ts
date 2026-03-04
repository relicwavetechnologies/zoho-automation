import { Router } from 'express';

import {
  requireAdminRole,
  requireAdminSession,
  requireRbacAction,
} from '../../middlewares/admin-auth.middleware';
import { rbacController } from './rbac.controller';

const router = Router();

router.use(requireAdminSession());

router.get('/actions', requireRbacAction('rbac.permissions.read'), rbacController.listActions);
router.get('/permissions', requireRbacAction('rbac.permissions.read'), rbacController.listPermissions);
router.put(
  '/permissions',
  requireAdminRole('SUPER_ADMIN'),
  requireRbacAction('rbac.permissions.write'),
  rbacController.updatePermission,
);

router.get('/assignments', requireRbacAction('rbac.permissions.read'), rbacController.listAssignments);
router.post(
  '/assignments',
  requireAdminRole('SUPER_ADMIN'),
  requireRbacAction('rbac.assignments.write'),
  rbacController.createAssignment,
);
router.delete(
  '/assignments',
  requireAdminRole('SUPER_ADMIN'),
  requireRbacAction('rbac.assignments.write'),
  rbacController.revokeAssignment,
);

export default router;
