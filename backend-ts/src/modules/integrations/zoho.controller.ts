import { Request, Response } from 'express';

import { logAudit } from '../../utils/audit';
import { prisma } from '../../utils/prisma';

async function upsertZohoIntegration(params: {
  organizationId: string;
  status: string;
  accessToken?: string | null;
  refreshToken?: string | null;
}) {
  return prisma.organizationIntegration.upsert({
    where: {
      organization_id_provider: {
        organization_id: params.organizationId,
        provider: 'zoho',
      },
    },
    create: {
      organization_id: params.organizationId,
      provider: 'zoho',
      status: params.status,
      access_token: params.accessToken ?? null,
      refresh_token: params.refreshToken ?? null,
      connected_at: params.status === 'connected' ? new Date() : null,
      last_health_check_at: new Date(),
    },
    update: {
      status: params.status,
      access_token: params.accessToken ?? null,
      refresh_token: params.refreshToken ?? null,
      connected_at: params.status === 'connected' ? new Date() : null,
      last_health_check_at: new Date(),
    },
  });
}

export async function connectZoho(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const integration = await upsertZohoIntegration({
    organizationId,
    status: 'connected',
    accessToken: req.body?.access_token ?? null,
    refreshToken: req.body?.refresh_token ?? null,
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'integration.zoho.connected',
    targetType: 'integration',
    targetId: integration.id,
  });

  return res.status(200).json({
    provider: 'zoho',
    status: integration.status,
    connected_at: integration.connected_at,
    last_health_check_at: integration.last_health_check_at,
  });
}

export async function reconnectZoho(req: Request, res: Response) {
  return connectZoho(req, res);
}

export async function disconnectZoho(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const integration = await upsertZohoIntegration({
    organizationId,
    status: 'disconnected',
    accessToken: null,
    refreshToken: null,
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'integration.zoho.disconnected',
    targetType: 'integration',
    targetId: integration.id,
  });

  return res.status(200).json({
    provider: 'zoho',
    status: integration.status,
    connected_at: integration.connected_at,
    last_health_check_at: integration.last_health_check_at,
  });
}

export async function zohoStatus(req: Request, res: Response) {
  const organizationId = req.organizationId!;

  const integration = await prisma.organizationIntegration.findUnique({
    where: {
      organization_id_provider: {
        organization_id: organizationId,
        provider: 'zoho',
      },
    },
  });

  if (!integration) {
    return res.status(200).json({
      provider: 'zoho',
      status: 'disconnected',
      connected_at: null,
      last_health_check_at: null,
    });
  }

  return res.status(200).json({
    provider: 'zoho',
    status: integration.status,
    connected_at: integration.connected_at,
    last_health_check_at: integration.last_health_check_at,
  });
}
