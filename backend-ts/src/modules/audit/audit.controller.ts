import { Request, Response } from 'express';

import { prisma } from '../../utils/prisma';

export async function listAuditLogs(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const action = req.query.action as string | undefined;
  const actorUserId = req.query.actor_user_id as string | undefined;
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 200) : 50;

  const logs = await prisma.auditLog.findMany({
    where: {
      organization_id: organizationId,
      ...(action ? { action } : {}),
      ...(actorUserId ? { actor_user_id: actorUserId } : {}),
      ...(from || to
        ? {
            created_at: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    orderBy: { created_at: 'desc' },
    take: limit,
  });

  return res.status(200).json(logs);
}
