import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { desktopChatController } from './desktop-chat.controller';

const router = Router();

router.use(requireMemberSession());

// Send message and stream response
router.post('/:threadId/send', asyncHandler(desktopChatController.send));
router.post('/:threadId/act/stream', asyncHandler(desktopChatController.actStream));
router.post('/:threadId/act', asyncHandler(desktopChatController.act));
router.post('/:threadId/hitl/:actionId/decision', asyncHandler(desktopChatController.resolveHitlAction));
router.post('/:threadId/share', asyncHandler(desktopChatController.shareConversation));

export default router;
