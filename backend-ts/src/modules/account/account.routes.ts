import { Router } from 'express';

import { asyncHandler } from '../../utils/async-handler';
import { confirmPasswordReset, requestPasswordReset } from './account.controller';

const accountRouter = Router();

accountRouter.post('/password/reset/request', asyncHandler(requestPasswordReset));
accountRouter.post('/password/reset/confirm', asyncHandler(confirmPasswordReset));

export default accountRouter;
