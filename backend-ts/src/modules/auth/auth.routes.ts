import { Router } from 'express';

import { requireAuth } from '../../middlewares/auth.middleware';
import { asyncHandler } from '../../utils/async-handler';
import {
  googleCallback,
  googleStart,
  login,
  me,
  register,
  sessionExchange,
} from './auth.controller';

const authRouter = Router();

authRouter.post('/register', asyncHandler(register));
authRouter.post('/login', asyncHandler(login));
authRouter.get('/me', requireAuth, asyncHandler(me));
authRouter.get('/google/start', asyncHandler(googleStart));
authRouter.get('/google/callback', asyncHandler(googleCallback));
authRouter.post('/session/exchange', asyncHandler(sessionExchange));

export default authRouter;
