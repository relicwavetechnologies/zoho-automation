import { Router } from 'express';

import { requireAdminRole, requireAdminSession } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { adminAiModelsController } from './admin-ai-models.controller';

const router = Router();

router.use(requireAdminSession(), requireAdminRole('SUPER_ADMIN'));
router.get('/', asyncHandler(adminAiModelsController.listTargets));
router.put('/:targetKey', asyncHandler(adminAiModelsController.updateTarget));

export default router;
