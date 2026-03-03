import { Router } from 'express';

import { requireRole } from '../../middlewares/org.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { connectZoho, disconnectZoho, reconnectZoho, zohoStatus } from './zoho.controller';

const zohoRouter = Router();

zohoRouter.get('/status', requireRole(['owner', 'admin']), asyncHandler(zohoStatus));
zohoRouter.post('/connect', requireRole(['owner', 'admin']), asyncHandler(connectZoho));
zohoRouter.post('/reconnect', requireRole(['owner', 'admin']), asyncHandler(reconnectZoho));
zohoRouter.post('/disconnect', requireRole(['owner', 'admin']), asyncHandler(disconnectZoho));

export default zohoRouter;
