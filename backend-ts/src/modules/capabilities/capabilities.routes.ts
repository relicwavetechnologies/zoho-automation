import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { capabilityBootstrap, policyCheck } from './capabilities.controller';

const capabilityRouter = Router();

capabilityRouter.get('/bootstrap', asyncHandler(capabilityBootstrap));
capabilityRouter.post('/check', asyncHandler(policyCheck));

export default capabilityRouter;
