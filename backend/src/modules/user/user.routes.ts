import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { createRateLimitMiddleware } from '../../middlewares/rate-limit.middleware';
import { userController } from './user.controller';

const router = Router();

const userLoginRateLimit = createRateLimitMiddleware({
  name: 'user_login',
  max: 5,
  windowMs: 15 * 60_000,
  message: 'Too many login attempts. Please wait a few minutes and try again.',
  key: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : 'unknown_email';
    return `${req.ip}:${email}`;
  },
});

router.post('/register', asyncHandler(userController.register));
router.post('/login', userLoginRateLimit, asyncHandler(userController.login));

export default router;
