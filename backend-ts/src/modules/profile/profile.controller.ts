import { Request, Response } from 'express';

import { AppHttpError } from '../../middlewares/error.middleware';
import { logAudit } from '../../utils/audit';
import { prisma } from '../../utils/prisma';

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export async function getMyProfile(req: Request, res: Response) {
  const userId = req.userId!;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      first_name: true,
      last_name: true,
      avatar_url: true,
      auth_provider: true,
      created_at: true,
      updated_at: true,
    },
  });

  if (!user) throw new AppHttpError(401, 'User not found');

  const membership = await prisma.membership.findFirst({
    where: {
      user_id: userId,
      status: 'active',
    },
    include: {
      organization: true,
    },
    orderBy: { created_at: 'asc' },
  });

  if (!membership) {
    throw new AppHttpError(403, 'not_org_member');
  }

  const role = await prisma.role.findFirst({
    where: {
      key: membership.role_key,
      OR: [{ organization_id: membership.organization_id }, { organization_id: null }],
    },
    orderBy: { organization_id: 'desc' },
    select: { name: true },
  });

  return res.status(200).json({
    user: {
      ...user,
      created_at: user.created_at.toISOString(),
      updated_at: user.updated_at.toISOString(),
    },
    workspace: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: toSlug(membership.organization.name),
    },
    membership: {
      role_key: membership.role_key,
      role_name: role?.name ?? membership.role_key,
      status: membership.status,
    },
  });
}

export async function patchMyProfile(req: Request, res: Response) {
  const userId = req.userId!;
  const firstName = String(req.body?.first_name ?? '').trim();
  const lastName = String(req.body?.last_name ?? '').trim();
  const avatarUrlRaw = req.body?.avatar_url;

  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
    throw new AppHttpError(400, 'validation_error');
  }

  let avatarUrl: string | null = null;
  if (avatarUrlRaw !== null && avatarUrlRaw !== undefined && String(avatarUrlRaw).trim() !== '') {
    const candidate = String(avatarUrlRaw).trim();
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new AppHttpError(400, 'validation_error');
      }
      avatarUrl = candidate;
    } catch {
      throw new AppHttpError(400, 'validation_error');
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      first_name: firstName,
      last_name: lastName,
      avatar_url: avatarUrl,
    },
  });

  const orgId = req.organizationId;
  if (orgId) {
    await logAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: 'profile.updated',
      targetType: 'user',
      targetId: userId,
      metadata: {
        first_name: firstName,
        last_name: lastName,
        avatar_url: avatarUrl,
      },
    });
  }

  return res.status(200).json({
    user: {
      id: updated.id,
      email: updated.email,
      first_name: updated.first_name,
      last_name: updated.last_name,
      avatar_url: updated.avatar_url,
      auth_provider: updated.auth_provider,
      created_at: updated.created_at.toISOString(),
      updated_at: updated.updated_at.toISOString(),
    },
  });
}

export async function getMySecurity(req: Request, res: Response) {
  const userId = req.userId!;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      auth_provider: true,
      password_hash: true,
      last_password_change_at: true,
    },
  });

  if (!user) throw new AppHttpError(401, 'User not found');

  const passwordEnabled = !user.password_hash.startsWith('oauth:');

  return res.status(200).json({
    auth_provider: user.auth_provider,
    password_enabled: passwordEnabled,
    mfa_enabled: false,
    last_password_change_at: user.last_password_change_at
      ? user.last_password_change_at.toISOString()
      : null,
  });
}
