import { Router } from 'express';

import { requireRole } from '../../middlewares/org.middleware';
import { asyncHandler } from '../../utils/async-handler';
import {
  createInvite,
  listInvites,
  resendInvite,
  revokeInvite,
} from './invites.controller';

const invitesRouter = Router();

invitesRouter.get('/', requireRole(['owner', 'admin']), asyncHandler(listInvites));
invitesRouter.post('/', requireRole(['owner', 'admin']), asyncHandler(createInvite));
invitesRouter.post('/:id/revoke', requireRole(['owner', 'admin']), asyncHandler(revokeInvite));
invitesRouter.post('/:id/resend', requireRole(['owner', 'admin']), asyncHandler(resendInvite));

export default invitesRouter;
