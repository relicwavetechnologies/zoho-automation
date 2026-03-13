import { Router } from 'express';

import { requireAdminSession } from '../../middlewares/admin-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { adminExecutionsController } from './admin-executions.controller';

const router = Router();

router.use(requireAdminSession());
router.get('/', asyncHandler(adminExecutionsController.list));
router.get('/:executionId', asyncHandler(adminExecutionsController.get));
router.get('/:executionId/events', asyncHandler(adminExecutionsController.events));

export default router;
