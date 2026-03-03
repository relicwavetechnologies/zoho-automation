import { Request, Response } from 'express';

import { AppHttpError } from '../../middlewares/error.middleware';
import { logAudit } from '../../utils/audit';
import { prisma } from '../../utils/prisma';

export async function orgStatus(req: Request, res: Response) {
  const userId = req.userId!;

  const membership = await prisma.membership.findFirst({
    where: { user_id: userId, status: 'active' },
    include: { organization: true },
    orderBy: { created_at: 'asc' },
  });

  if (!membership) {
    return res.status(200).json({ complete: false, organization: null, membership: null });
  }

  return res.status(200).json({
    complete: true,
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
    },
    membership: {
      id: membership.id,
      role_key: membership.role_key,
      status: membership.status,
    },
  });
}

export async function createOrganizationOnboarding(req: Request, res: Response) {
  const userId = req.userId!;
  const name = (req.body?.name ?? '').trim();

  if (!name) {
    throw new AppHttpError(400, 'Organization name is required');
  }

  const existing = await prisma.membership.findFirst({
    where: { user_id: userId, status: 'active' },
    include: { organization: true },
  });

  if (existing) {
    return res.status(200).json({
      organization: { id: existing.organization.id, name: existing.organization.name },
      membership: { role_key: existing.role_key, status: existing.status },
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({ data: { name } });

    const membership = await tx.membership.create({
      data: {
        user_id: userId,
        organization_id: organization.id,
        role_key: 'owner',
        status: 'active',
      },
    });

    await tx.organizationToolSetting.createMany({
      data: [
        { organization_id: organization.id, tool_key: 'get_current_time', is_enabled: true },
        { organization_id: organization.id, tool_key: 'zoho.clients.read', is_enabled: true },
        { organization_id: organization.id, tool_key: 'zoho.invoices.read', is_enabled: true },
        { organization_id: organization.id, tool_key: 'zoho.invoice.write', is_enabled: true },
      ],
      skipDuplicates: true,
    });

    return { organization, membership };
  });

  await logAudit({
    organizationId: created.organization.id,
    actorUserId: userId,
    action: 'org.onboarding.created',
    targetType: 'organization',
    targetId: created.organization.id,
    metadata: { name },
  });

  return res.status(201).json({
    organization: { id: created.organization.id, name: created.organization.name },
    membership: { role_key: created.membership.role_key, status: created.membership.status },
  });
}
