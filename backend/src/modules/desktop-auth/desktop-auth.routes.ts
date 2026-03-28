import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { createRateLimitMiddleware } from '../../middlewares/rate-limit.middleware';
import { desktopAuthController } from './desktop-auth.controller';

const router = Router();

const desktopExchangeRateLimit = createRateLimitMiddleware({
  name: 'desktop_auth_exchange',
  max: 10,
  windowMs: 60_000,
  message: 'Too many desktop auth exchange attempts. Please wait and try again.',
  key: (req) => req.ip ?? 'unknown_ip',
});

router.get('/lark/authorize-url', asyncHandler(desktopAuthController.getLarkAuthorizeUrl));
router.get('/lark/callback', asyncHandler(desktopAuthController.larkCallback));
router.post('/lark/exchange', desktopExchangeRateLimit, asyncHandler(desktopAuthController.exchangeLark));

router.get('/google/authorize-url', requireMemberSession(), asyncHandler(desktopAuthController.getGoogleAuthorizeUrl));
router.get('/google/callback', asyncHandler(desktopAuthController.googleCallback));

// Exchange handoff code (no auth required — the code IS the credential)
router.post('/exchange', desktopExchangeRateLimit, asyncHandler(desktopAuthController.exchange));

// Generate handoff code (requires logged-in member session from web app)
router.post('/handoff', requireMemberSession(), asyncHandler(desktopAuthController.generateHandoff));

// Desktop session validation
router.get('/me', requireMemberSession(), asyncHandler(desktopAuthController.me));
router.get('/departments', requireMemberSession(), asyncHandler(desktopAuthController.departments));
router.get('/google/status', requireMemberSession(), asyncHandler(desktopAuthController.googleStatus));

// Desktop logout
router.post('/logout', requireMemberSession(), asyncHandler(desktopAuthController.logout));
router.post('/lark/unlink', requireMemberSession(), asyncHandler(desktopAuthController.unlinkLark));
router.post('/google/unlink', requireMemberSession(), asyncHandler(desktopAuthController.unlinkGoogle));

export default router;
