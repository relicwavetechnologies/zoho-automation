import { Router } from 'express';

import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { desktopWorkflowsController } from './desktop-workflows.controller';

const router = Router();

router.use(requireMemberSession());
router.get('/', asyncHandler(desktopWorkflowsController.list));
router.post('/compile', asyncHandler(desktopWorkflowsController.compile));
router.post('/publish', asyncHandler(desktopWorkflowsController.publish));
router.post('/:workflowId/run', asyncHandler(desktopWorkflowsController.runNow));
router.delete('/:workflowId', asyncHandler(desktopWorkflowsController.archive));

export default router;
