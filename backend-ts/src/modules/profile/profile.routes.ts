import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { getMyProfile, getMySecurity, patchMyProfile } from './profile.controller';

const profileRouter = Router();

profileRouter.get('/profile', asyncHandler(getMyProfile));
profileRouter.patch('/profile', asyncHandler(patchMyProfile));
profileRouter.get('/security', asyncHandler(getMySecurity));

export default profileRouter;
