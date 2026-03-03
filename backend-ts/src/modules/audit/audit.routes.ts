import { Router } from 'express';

import { requireRole } from '../../middlewares/org.middleware';
import { asyncHandler } from '../../utils/async-handler';
import { listAuditLogs } from './audit.controller';

const auditRouter = Router();

auditRouter.get('/logs', requireRole(['owner', 'admin']), asyncHandler(listAuditLogs));

export default auditRouter;
