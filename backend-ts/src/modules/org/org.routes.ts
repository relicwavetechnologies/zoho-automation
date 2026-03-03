import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { createOrganizationOnboarding, orgStatus } from './org.controller';

const orgRouter = Router();

orgRouter.get('/status', asyncHandler(orgStatus));
orgRouter.post('/onboarding', asyncHandler(createOrganizationOnboarding));

export default orgRouter;
