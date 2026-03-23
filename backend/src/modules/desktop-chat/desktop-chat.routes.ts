import { Request, Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { createRateLimitMiddleware, createRedisAvailabilityMiddleware } from '../../middlewares/rate-limit.middleware';
import { desktopChatController } from './desktop-chat.controller';

const router = Router();

router.use(requireMemberSession());

const desktopChatRateLimit = createRateLimitMiddleware({
  name: 'desktop_chat_send',
  max: 20,
  windowMs: 60_000,
  message: 'Too many chat requests in a short time. Please wait a moment and try again.',
  key: (req) => {
    const session = (req as Request & { memberSession?: { userId?: string } }).memberSession;
    return session?.userId ?? null;
  },
});

const desktopChatRedisGuard = createRedisAvailabilityMiddleware({
  name: 'desktop_chat_runtime',
  message: 'Desktop chat is temporarily unavailable while runtime infrastructure recovers.',
});

// Send message and stream response
router.post('/:threadId/send', desktopChatRedisGuard, desktopChatRateLimit, asyncHandler(desktopChatController.send));
router.post('/:threadId/act/stream', desktopChatRedisGuard, desktopChatRateLimit, asyncHandler(desktopChatController.actStream));
router.post('/:threadId/act', desktopChatRedisGuard, desktopChatRateLimit, asyncHandler(desktopChatController.act));
router.post('/:threadId/hitl/:actionId/decision', asyncHandler(desktopChatController.resolveHitlAction));
router.post('/:threadId/share', asyncHandler(desktopChatController.shareConversation));

export default router;
