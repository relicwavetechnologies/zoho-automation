import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler';
import { requireMemberSession } from '../../middlewares/member-auth.middleware';
import { memberAuthController } from './member-auth.controller';

const router = Router();

router.post('/login', asyncHandler(memberAuthController.login));
router.get('/me', requireMemberSession(), asyncHandler(memberAuthController.me));
router.post('/logout', requireMemberSession(), asyncHandler(memberAuthController.logout));
router.get('/usage', requireMemberSession(), asyncHandler(memberAuthController.usage));

export default router;
