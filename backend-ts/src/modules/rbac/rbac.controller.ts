import { Request, Response } from 'express';

import { AppHttpError } from '../../middlewares/error.middleware';
import { logAudit } from '../../utils/audit';
import { prisma } from '../../utils/prisma';
import {
  capabilitiesForUser,
  compareRoleRank,
  getMembershipRole,
  resolvePolicyForUser,
} from '../policy/policy.service';
import { TOOL_CATALOG } from '../policy/tool-catalog';

function toRoleDto(role: {
  id: string;
  organization_id: string | null;
  key: string;
  name: string;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: role.id,
    org_id: role.organization_id,
    key: role.key,
    name: role.name,
    is_system: role.is_system,
    created_at: role.created_at.toISOString(),
    updated_at: role.updated_at.toISOString(),
  };
}

async function getRoleForOrg(organizationId: string, roleId: string) {
  const role = await prisma.role.findFirst({
    where: {
      id: roleId,
      OR: [{ organization_id: organizationId }, { organization_id: null }],
    },
  });

  if (!role) throw new AppHttpError(404, 'Role not found');
  return role;
}

export async function getSessionCapabilities(req: Request, res: Response) {
  const organizationId = req.organizationId;
  const userId = req.userId;

  if (!organizationId || !userId) {
    throw new AppHttpError(403, 'Organization setup incomplete');
  }

  const capabilities = await capabilitiesForUser({ organizationId, userId });
  return res.status(200).json(capabilities);
}

export async function listRbacRoles(req: Request, res: Response) {
  const organizationId = req.organizationId!;

  const roles = await prisma.role.findMany({
    where: {
      OR: [{ organization_id: organizationId }, { organization_id: null }],
    },
    orderBy: [{ is_system: 'desc' }, { key: 'asc' }],
  });

  return res.status(200).json(roles.map(toRoleDto));
}

export async function createRbacRole(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const key = String(req.body?.key ?? '').trim();
  const name = String(req.body?.name ?? '').trim();

  if (!key || !name) {
    throw new AppHttpError(400, 'key and name are required');
  }

  const exists = await prisma.role.findFirst({
    where: {
      key,
      OR: [{ organization_id: organizationId }, { organization_id: null }],
    },
  });

  if (exists) {
    throw new AppHttpError(409, 'Role key already exists in this organization scope');
  }

  const role = await prisma.role.create({
    data: {
      organization_id: organizationId,
      key,
      name,
      is_system: false,
    },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'rbac.role.created',
    targetType: 'role',
    targetId: role.id,
    metadata: { key, name },
  });

  return res.status(201).json(toRoleDto(role));
}

export async function updateRbacRole(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const role = await getRoleForOrg(organizationId, req.params.id);

  if (role.is_system) {
    throw new AppHttpError(400, 'System role cannot be edited');
  }

  const nextKey = req.body?.key === undefined ? role.key : String(req.body?.key).trim();
  const nextName = req.body?.name === undefined ? role.name : String(req.body?.name).trim();

  if (!nextKey || !nextName) {
    throw new AppHttpError(400, 'key and name cannot be empty');
  }

  const conflict = await prisma.role.findFirst({
    where: {
      id: { not: role.id },
      key: nextKey,
      OR: [{ organization_id: organizationId }, { organization_id: null }],
    },
  });

  if (conflict) {
    throw new AppHttpError(409, 'Role key already exists in this organization scope');
  }

  const updated = await prisma.role.update({
    where: { id: role.id },
    data: {
      key: nextKey,
      name: nextName,
    },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'rbac.role.updated',
    targetType: 'role',
    targetId: role.id,
    metadata: { key: nextKey, name: nextName },
  });

  return res.status(200).json(toRoleDto(updated));
}

export async function deleteRbacRole(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const role = await getRoleForOrg(organizationId, req.params.id);

  if (role.is_system) {
    throw new AppHttpError(400, 'System role cannot be deleted');
  }

  const assigned = await prisma.memberRole.count({
    where: {
      role_id: role.id,
      status: 'active',
    },
  });

  if (assigned > 0) {
    throw new AppHttpError(400, 'Role is assigned to active members');
  }

  await prisma.role.delete({ where: { id: role.id } });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'rbac.role.deleted',
    targetType: 'role',
    targetId: role.id,
  });

  return res.status(204).send();
}

export async function getRolePermissions(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const roleId = String(req.query.role_id ?? '').trim();

  if (!roleId) throw new AppHttpError(400, 'role_id is required');

  await getRoleForOrg(organizationId, roleId);

  const permissions = await prisma.roleToolPermission.findMany({
    where: { role_id: roleId },
    orderBy: { tool_key: 'asc' },
  });

  return res.status(200).json(
    permissions.map((p) => ({
      role_id: p.role_id,
      tool_key: p.tool_key,
      can_execute: p.can_execute,
      requires_approval: p.requires_approval,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
    })),
  );
}

export async function putRolePermissions(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const roleId = req.params.role_id;

  await getRoleForOrg(organizationId, roleId);

  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
  if (!permissions) {
    throw new AppHttpError(400, 'permissions array is required');
  }

  const upserts = permissions.map((item: any) => {
    const toolKey = String(item?.tool_key ?? '').trim();
    if (!TOOL_CATALOG.includes(toolKey as (typeof TOOL_CATALOG)[number])) {
      throw new AppHttpError(400, `Invalid tool_key: ${toolKey}`);
    }

    return prisma.roleToolPermission.upsert({
      where: {
        role_id_tool_key: {
          role_id: roleId,
          tool_key: toolKey,
        },
      },
      create: {
        role_id: roleId,
        tool_key: toolKey,
        can_execute: Boolean(item?.can_execute),
        requires_approval: Boolean(item?.requires_approval),
      },
      update: {
        can_execute: Boolean(item?.can_execute),
        requires_approval: Boolean(item?.requires_approval),
      },
    });
  });

  const updated = await prisma.$transaction(upserts);

  await logAudit({
    organizationId,
    actorUserId,
    action: 'rbac.role_permissions.updated',
    targetType: 'role',
    targetId: roleId,
    metadata: { count: updated.length },
  });

  return res.status(200).json(
    updated.map((p) => ({
      role_id: p.role_id,
      tool_key: p.tool_key,
      can_execute: p.can_execute,
      requires_approval: p.requires_approval,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
    })),
  );
}

export async function getMemberRoles(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const memberId = req.params.member_id;

  const membership = await prisma.membership.findFirst({
    where: {
      id: memberId,
      organization_id: organizationId,
    },
    include: {
      member_roles: {
        include: { role: true },
      },
    },
  });

  if (!membership) throw new AppHttpError(404, 'Member not found');

  return res.status(200).json(
    membership.member_roles.map((mr) => ({
      member_id: membership.id,
      role_id: mr.role_id,
      status: mr.status,
      role_key: mr.role.key,
      role_name: mr.role.name,
    })),
  );
}

export async function putMemberRoles(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const memberId = req.params.member_id;
  const roleId = String(req.body?.role_id ?? '').trim();
  const status = String(req.body?.status ?? 'active').trim();

  if (!roleId) throw new AppHttpError(400, 'role_id is required');

  const membership = await prisma.membership.findFirst({
    where: {
      id: memberId,
      organization_id: organizationId,
    },
  });

  if (!membership) throw new AppHttpError(404, 'Member not found');

  const role = await getRoleForOrg(organizationId, roleId);
  const actorRole = await getMembershipRole({ organizationId, userId: actorUserId });

  if (!actorRole) throw new AppHttpError(403, 'not_org_member');

  if (compareRoleRank(actorRole.roleKey, role.key) < 0) {
    throw new AppHttpError(403, 'Cannot assign a higher role than your own');
  }

  const memberRole = await prisma.memberRole.upsert({
    where: { membership_id: membership.id },
    create: {
      membership_id: membership.id,
      role_id: role.id,
      status,
    },
    update: {
      role_id: role.id,
      status,
    },
  });

  // Keep legacy field in sync for compatibility.
  await prisma.membership.update({
    where: { id: membership.id },
    data: { role_key: role.key, status },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'rbac.member_role.updated',
    targetType: 'membership',
    targetId: membership.id,
    metadata: { role_id: role.id, role_key: role.key, status },
  });

  return res.status(200).json({
    member_id: membership.id,
    role_id: memberRole.role_id,
    status: memberRole.status,
  });
}

export async function policyCheck(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const orgIdFromBody = String(req.body?.org_id ?? '').trim();
  const userId = String(req.body?.user_id ?? '').trim();
  const toolKey = String(req.body?.tool_key ?? '').trim();
  const action = String(req.body?.action ?? 'execute').trim();

  if (!orgIdFromBody || !userId || !toolKey) {
    throw new AppHttpError(400, 'org_id, user_id and tool_key are required');
  }

  if (orgIdFromBody !== organizationId) {
    throw new AppHttpError(403, 'Cross-org access denied');
  }

  const result = await resolvePolicyForUser({
    organizationId,
    userId,
    toolKey,
    action,
  });

  if (!result.allowed) {
    await logAudit({
      organizationId,
      actorUserId: req.userId,
      action: 'rbac.policy.denied',
      targetType: 'tool',
      targetId: toolKey,
      metadata: {
        requested_user_id: userId,
        reason_code: result.reason_code,
      },
    });
  }

  return res.status(200).json(result);
}
