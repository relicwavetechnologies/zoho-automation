import crypto from 'crypto';
import { Request, Response } from 'express';

import { config } from '../../config/env';
import { AppHttpError } from '../../middlewares/error.middleware';
import { logAudit } from '../../utils/audit';
import { sendInviteMagicLinkEmail } from '../../utils/mailer';
import { prisma } from '../../utils/prisma';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function buildMagicLink(rawToken: string): string {
  const url = new URL('/invite/accept', config.appBaseUrl);
  url.searchParams.set('token', rawToken);
  return url.toString();
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

  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { email: true },
  });

  const magicLink = buildMagicLink(rawToken);
  await sendInviteMagicLinkEmail({
    to: email,
    roleKey: role_key,
    magicLink,
    invitedBy: actor?.email ?? actorUserId,
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
    const membership = await tx.membership.upsert({
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

    const role = await tx.role.findFirst({
      where: {
        key: invite.role_key,
        OR: [{ organization_id: invite.organization_id }, { organization_id: null }],
      },
      orderBy: { organization_id: 'desc' },
    });

    if (!role) {
      throw new AppHttpError(400, 'invalid_role');
    }

    await tx.memberRole.upsert({
      where: { membership_id: membership.id },
      create: {
        membership_id: membership.id,
        role_id: role.id,
        status: 'active',
      },
      update: {
        role_id: role.id,
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

export async function validateInvite(req: Request, res: Response) {
  const token = String(req.query.token ?? '').trim();
  if (!token) throw new AppHttpError(400, 'token is required');

  const invite = await prisma.invite.findFirst({
    where: { token_hash: hashToken(token) },
  });

  if (!invite) {
    return res.status(200).json({ status: 'invalid' });
  }

  if (invite.status === 'pending' && invite.expires_at.getTime() < Date.now()) {
    await prisma.invite.update({
      where: { id: invite.id },
      data: { status: 'expired' },
    });
    return res.status(200).json({ status: 'expired', email: invite.email });
  }

  return res.status(200).json({
    status: invite.status,
    email: invite.email,
    role_key: invite.role_key,
    expires_at: invite.expires_at.toISOString(),
  });
}

export async function resendInvite(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const invite = await prisma.invite.findFirst({
    where: { id: req.params.id, organization_id: organizationId },
  });

  if (!invite) throw new AppHttpError(404, 'Invite not found');
  if (invite.status !== 'pending') throw new AppHttpError(400, 'Invite is not pending');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const token_hash = hashToken(rawToken);
  const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.invite.update({
    where: { id: invite.id },
    data: {
      token_hash,
      expires_at,
      revoked_at: null,
    },
  });

  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { email: true },
  });

  const magicLink = buildMagicLink(rawToken);
  await sendInviteMagicLinkEmail({
    to: invite.email,
    roleKey: invite.role_key,
    magicLink,
    invitedBy: actor?.email ?? actorUserId,
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'invite.resent',
    targetType: 'invite',
    targetId: invite.id,
  });

  return res.status(200).json({
    status: 'pending',
    invite_id: invite.id,
    expires_at: expires_at.toISOString(),
  });
}
