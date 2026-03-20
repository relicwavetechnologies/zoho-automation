import { Router } from 'express';

import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { desktopWorkflowsController } from './desktop-workflows.controller';

const router = Router();

router.use(requireMemberSession());
router.post('/drafts', asyncHandler(desktopWorkflowsController.createDraft));
router.get('/', asyncHandler(desktopWorkflowsController.list));
router.post('/compile', asyncHandler(desktopWorkflowsController.compile));
router.post('/publish', asyncHandler(desktopWorkflowsController.publish));
router.get('/:workflowId', asyncHandler(desktopWorkflowsController.get));
router.patch('/:workflowId', asyncHandler(desktopWorkflowsController.update));
router.post('/:workflowId/author', asyncHandler(desktopWorkflowsController.author));
router.post('/:workflowId/run', asyncHandler(desktopWorkflowsController.runNow));
router.patch('/:workflowId/schedule', asyncHandler(desktopWorkflowsController.setScheduleState));
router.delete('/:workflowId', asyncHandler(desktopWorkflowsController.archive));

export default router;
