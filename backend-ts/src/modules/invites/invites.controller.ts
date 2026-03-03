import crypto from 'crypto';
import { Request, Response } from 'express';

import { AppHttpError } from '../../middlewares/error.middleware';
import { logAudit } from '../../utils/audit';
import { prisma } from '../../utils/prisma';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createInvite(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const email = (req.body?.email ?? '').trim().toLowerCase();
  const role_key = (req.body?.role_key ?? '').trim();

  if (!email || !email.includes('@')) {
    throw new AppHttpError(400, 'Valid email is required');
  }
  if (!role_key) {
    throw new AppHttpError(400, 'role_key is required');
  }

  const roleExists = await prisma.role.findFirst({
    where: {
      key: role_key,
      OR: [{ organization_id: organizationId }, { organization_id: null }],
    },
  });

  if (!roleExists) {
    throw new AppHttpError(400, 'Invalid role_key');
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const token_hash = hashToken(rawToken);
  const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const invite = await prisma.invite.create({
    data: {
      organization_id: organizationId,
      email,
      role_key,
      token_hash,
      expires_at,
      invited_by_user_id: actorUserId,
      status: 'pending',
    },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'invite.created',
    targetType: 'invite',
    targetId: invite.id,
    metadata: { email, role_key },
  });

  return res.status(201).json({
    invite_id: invite.id,
    status: invite.status,
    expires_at: invite.expires_at.toISOString(),
    magic_link_token: rawToken,
  });
}

export async function listInvites(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const invites = await prisma.invite.findMany({
    where: { organization_id: organizationId },
    orderBy: { created_at: 'desc' },
  });
  return res.status(200).json(invites);
}

export async function revokeInvite(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const invite = await prisma.invite.findFirst({
    where: { id: req.params.id, organization_id: organizationId },
  });

  if (!invite) throw new AppHttpError(404, 'Invite not found');
  if (invite.status !== 'pending') throw new AppHttpError(400, 'Invite is not pending');

  const updated = await prisma.invite.update({
    where: { id: invite.id },
    data: { status: 'revoked', revoked_at: new Date() },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'invite.revoked',
    targetType: 'invite',
    targetId: invite.id,
  });

  return res.status(200).json(updated);
}

export async function acceptInvite(req: Request, res: Response) {
  const userId = req.userId!;
  const token = (req.body?.token ?? '').trim();
  if (!token) throw new AppHttpError(400, 'token is required');

  const token_hash = hashToken(token);
  const invite = await prisma.invite.findFirst({ where: { token_hash } });

  if (!invite) throw new AppHttpError(400, 'invalid_token');
  if (invite.status === 'revoked') throw new AppHttpError(400, 'revoked');
  if (invite.status === 'accepted') throw new AppHttpError(400, 'already_used');
  if (invite.expires_at.getTime() < Date.now()) {
    await prisma.invite.update({ where: { id: invite.id }, data: { status: 'expired' } });
    throw new AppHttpError(400, 'expired');
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.upsert({
      where: {
        user_id_organization_id: {
          user_id: userId,
          organization_id: invite.organization_id,
        },
      },
      create: {
        user_id: userId,
        organization_id: invite.organization_id,
        role_key: invite.role_key,
        status: 'active',
      },
      update: {
        role_key: invite.role_key,
        status: 'active',
      },
    });

    await tx.invite.update({
      where: { id: invite.id },
      data: { status: 'accepted', accepted_at: new Date() },
    });
  });

  await logAudit({
    organizationId: invite.organization_id,
    actorUserId: userId,
    action: 'invite.accepted',
    targetType: 'invite',
    targetId: invite.id,
  });

  return res.status(200).json({
    status: 'accepted',
    organization_id: invite.organization_id,
    role_key: invite.role_key,
  });
}
