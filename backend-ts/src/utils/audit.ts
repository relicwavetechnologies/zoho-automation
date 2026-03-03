import { Prisma } from '@prisma/client';

import { prisma } from './prisma';

export async function logAudit(params: {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      organization_id: params.organizationId,
      actor_user_id: params.actorUserId ?? null,
      action: params.action,
      target_type: params.targetType ?? null,
      target_id: params.targetId ?? null,
      metadata: params.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}
