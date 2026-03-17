import { Router } from 'express';

import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { desktopExecutionsController } from './desktop-executions.controller';

const router = Router();

router.use(requireMemberSession());
router.get('/:executionId', asyncHandler(desktopExecutionsController.get));
router.get('/:executionId/events', asyncHandler(desktopExecutionsController.events));
router.post('/:executionId/events', asyncHandler(desktopExecutionsController.appendEvent));

export default router;
