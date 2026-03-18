import { Router } from 'express';

import { requireAdminRole, requireAdminSession } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { adminDepartmentsController } from './admin-departments.controller';

const router = Router();

router.use(requireAdminSession());
router.use(requireAdminRole('SUPER_ADMIN', 'COMPANY_ADMIN'));

router.get('/', asyncHandler(adminDepartmentsController.list));
router.get('/:departmentId', asyncHandler(adminDepartmentsController.detail));
router.get('/:departmentId/candidates', asyncHandler(adminDepartmentsController.searchCandidates));
router.post('/', asyncHandler(adminDepartmentsController.create));
router.put('/:departmentId', asyncHandler(adminDepartmentsController.update));
router.post('/:departmentId/archive', asyncHandler(adminDepartmentsController.archive));
router.put('/:departmentId/config', asyncHandler(adminDepartmentsController.updateConfig));
router.post('/:departmentId/roles', asyncHandler(adminDepartmentsController.createRole));
router.put('/:departmentId/roles/:roleId', asyncHandler(adminDepartmentsController.updateRole));
router.delete('/:departmentId/roles/:roleId', asyncHandler(adminDepartmentsController.deleteRole));
router.put('/:departmentId/memberships', asyncHandler(adminDepartmentsController.upsertMembership));
router.delete('/:departmentId/memberships/:userId', asyncHandler(adminDepartmentsController.removeMembership));
router.post('/:departmentId/skills', asyncHandler(adminDepartmentsController.createSkill));
router.put('/:departmentId/skills/:skillId', asyncHandler(adminDepartmentsController.updateSkill));
router.post('/:departmentId/skills/:skillId/archive', asyncHandler(adminDepartmentsController.archiveSkill));
router.put(
  '/:departmentId/role-permissions/:roleId/:toolId/:actionGroup',
  asyncHandler(adminDepartmentsController.updateRolePermission),
);
router.put(
  '/:departmentId/user-overrides/:userId/:toolId/:actionGroup',
  asyncHandler(adminDepartmentsController.updateUserOverride),
);

export default router;
