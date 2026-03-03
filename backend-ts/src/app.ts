import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { sessionBootstrap } from './modules/auth/auth.controller';
import authRouter from './modules/auth/auth.routes';
import conversationsRouter from './modules/conversations/conversations.routes';
import messagesRouter from './modules/messages/messages.routes';
import modelsRouter from './modules/models/models.routes';
import { requireAuth } from './middlewares/auth.middleware';
import { errorMiddleware } from './middlewares/error.middleware';
import { loggingMiddleware } from './middlewares/logging.middleware';
import { streamHandler } from './modules/messages/stream.handler';
import { asyncHandler } from './utils/async-handler';
import { requireOrgAccess, requireRole } from './middlewares/org.middleware';
import orgRouter from './modules/org/org.routes';
import { createOrganizationOnboarding, orgStatus } from './modules/org/org.controller';
import invitesRouter from './modules/invites/invites.routes';
import { acceptInvite, validateInvite } from './modules/invites/invites.controller';
import adminRouter from './modules/admin/admin.routes';
import {
  createRole,
  deleteRole,
  listMembers,
  listRoles,
  listTools,
  setToolEnabled,
  updateMember,
  updateRole,
  updateRoleToolPermission,
} from './modules/admin/admin.controller';
import capabilityRouter from './modules/capabilities/capabilities.routes';
import { policyCheck } from './modules/capabilities/capabilities.controller';
import zohoRouter from './modules/integrations/zoho.routes';
import auditRouter from './modules/audit/audit.routes';
import { listAuditLogs } from './modules/audit/audit.controller';
import rbacRouter, { getSessionCapabilities } from './modules/rbac/rbac.routes';

export const app = express();

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(helmet());
app.use(express.json());
app.use(loggingMiddleware);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.use('/auth', authRouter);

app.get('/session/bootstrap', requireAuth, asyncHandler(sessionBootstrap));
app.get('/session/capabilities', requireAuth, requireOrgAccess, asyncHandler(getSessionCapabilities));

app.use('/org', requireAuth, orgRouter);
app.get('/onboarding/status', requireAuth, asyncHandler(orgStatus));
app.post('/onboarding/organization', requireAuth, asyncHandler(createOrganizationOnboarding));

app.use('/conversations', requireAuth, requireOrgAccess, conversationsRouter);
app.use('/conversations/:id/messages', requireAuth, requireOrgAccess, messagesRouter);
app.get('/conversations/:id/stream', requireAuth, requireOrgAccess, asyncHandler(streamHandler));
app.post('/conversations/:id/stream', requireAuth, requireOrgAccess, asyncHandler(streamHandler));

app.get('/invites/validate', asyncHandler(validateInvite));
app.post('/invites/accept', requireAuth, asyncHandler(acceptInvite));
app.use('/invites', requireAuth, requireOrgAccess, invitesRouter);
app.use('/admin', requireAuth, requireOrgAccess, adminRouter);

// Contract aliases matching shared-contracts.md root paths.
app.get('/members', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(listMembers));
app.patch('/members/:id', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(updateMember));
app.get('/roles', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(listRoles));
app.post('/roles', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(createRole));
app.patch('/roles/:id', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(updateRole));
app.delete('/roles/:id', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(deleteRole));
app.get('/tools', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(listTools));
app.patch(
  '/roles/:roleId/tools/:toolKey',
  requireAuth,
  requireOrgAccess,
  requireRole(['owner', 'admin']),
  asyncHandler(updateRoleToolPermission),
);
app.patch('/tools/:toolKey', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(setToolEnabled));

app.use('/capabilities', requireAuth, requireOrgAccess, capabilityRouter);
app.post('/policy/check', requireAuth, requireOrgAccess, asyncHandler(policyCheck));
app.use('/rbac', requireAuth, requireOrgAccess, rbacRouter);
app.use('/integrations/zoho', requireAuth, requireOrgAccess, zohoRouter);
app.use('/audit', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), auditRouter);
app.get('/admin/audit', requireAuth, requireOrgAccess, requireRole(['owner', 'admin']), asyncHandler(listAuditLogs));

app.use('/models', modelsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use(errorMiddleware);
