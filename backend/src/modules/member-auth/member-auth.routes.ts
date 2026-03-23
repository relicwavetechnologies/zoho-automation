import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { createRateLimitMiddleware } from '../../middlewares/rate-limit.middleware';
import { memberAuthController } from './member-auth.controller';

const router = Router();

const memberLoginRateLimit = createRateLimitMiddleware({
  name: 'member_login',
  max: 5,
  windowMs: 15 * 60_000,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
  key: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown_email';
    return `${req.ip}:${email}`;
  },
});

router.post('/login', memberLoginRateLimit, asyncHandler(memberAuthController.login));
router.get('/me', requireMemberSession(), asyncHandler(memberAuthController.me));
router.post('/logout', requireMemberSession(), asyncHandler(memberAuthController.logout));
router.get('/usage', requireMemberSession(), asyncHandler(memberAuthController.usage));

export default router;
