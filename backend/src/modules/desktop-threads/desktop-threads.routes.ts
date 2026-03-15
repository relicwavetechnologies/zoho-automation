import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { desktopThreadsController } from './desktop-threads.controller';

const router = Router();

router.use(requireMemberSession());

router.get('/', asyncHandler(desktopThreadsController.list));
router.post('/', asyncHandler(desktopThreadsController.create));
router.patch('/:threadId/preferences', asyncHandler(desktopThreadsController.updatePreferences));
router.post('/:threadId/messages', asyncHandler(desktopThreadsController.addMessage));
router.delete('/:threadId/history', asyncHandler(desktopThreadsController.clearHistory));
router.get('/:threadId', asyncHandler(desktopThreadsController.get));
router.delete('/:threadId', asyncHandler(desktopThreadsController.delete));

export default router;
