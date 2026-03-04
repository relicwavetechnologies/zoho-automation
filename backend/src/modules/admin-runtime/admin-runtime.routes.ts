import { Router } from 'express';

import { requireAdminSession, requireRbacAction } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { adminRuntimeController } from './admin-runtime.controller';

const router = Router();

router.use(requireAdminSession(), requireRbacAction('system.controls.write'));
router.get('/tasks', asyncHandler(adminRuntimeController.listTasks));
router.get('/tasks/:taskId', asyncHandler(adminRuntimeController.getTask));
router.post('/tasks/:taskId/control', asyncHandler(adminRuntimeController.controlTask));
router.post('/tasks/:taskId/recover', asyncHandler(adminRuntimeController.recoverTask));

export default router;
