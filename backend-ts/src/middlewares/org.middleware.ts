import { NextFunction, Request, Response } from 'express';

import { getMembershipRole } from '../modules/policy/policy.service';
import { prisma } from '../utils/prisma';

export async function requireOrgAccess(req: Request, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const membership = await prisma.membership.findFirst({
    where: { user_id: userId, status: 'active' },
    orderBy: { created_at: 'asc' },
  });

  if (!membership) {
    return res.status(403).json({ error: 'Organization setup incomplete' });
  }

  const role = await getMembershipRole({
    organizationId: membership.organization_id,
    userId,
  });

  req.organizationId = membership.organization_id;
  req.membershipId = membership.id;
  req.roleId = role?.roleId;
  req.roleKey = role?.roleKey ?? membership.role_key;
  return next();
}

export function requireRole(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.roleKey;
    if (!role) {
      return res.status(403).json({ error: 'Organization setup incomplete' });
    }
    if (!allowed.includes(role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}
