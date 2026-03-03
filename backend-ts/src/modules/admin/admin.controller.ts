import { Request, Response } from 'express';

import { AppHttpError } from '../../middlewares/error.middleware';
import { capabilitiesForRole } from '../policy/policy.service';
import { TOOL_CATALOG } from '../policy/tool-catalog';
import { logAudit } from '../../utils/audit';
import { prisma } from '../../utils/prisma';

export async function listMembers(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const members = await prisma.membership.findMany({
    where: { organization_id: organizationId },
    include: { user: true },
    orderBy: { created_at: 'asc' },
  });

  return res.status(200).json(
    members.map((m) => ({
      id: m.id,
      role_key: m.role_key,
      status: m.status,
      user: {
        id: m.user.id,
        email: m.user.email,
        first_name: m.user.first_name,
        last_name: m.user.last_name,
      },
    })),
  );
}

export async function updateMember(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const member = await prisma.membership.findFirst({
    where: { id: req.params.id, organization_id: organizationId },
  });

  if (!member) throw new AppHttpError(404, 'Member not found');

  const role_key = req.body?.role_key ?? member.role_key;
  const status = req.body?.status ?? member.status;

  const updated = await prisma.membership.update({
    where: { id: member.id },
    data: { role_key, status },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'member.updated',
    targetType: 'membership',
    targetId: member.id,
    metadata: { role_key, status },
  });

  return res.status(200).json(updated);
}

export async function listRoles(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const roles = await prisma.role.findMany({
    where: {
      OR: [{ organization_id: null }, { organization_id: organizationId }],
    },
    orderBy: [{ is_system: 'desc' }, { key: 'asc' }],
  });

  return res.status(200).json(roles);
}

export async function createRole(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const key = (req.body?.key ?? '').trim();
  const name = (req.body?.name ?? '').trim();

  if (!key || !name) throw new AppHttpError(400, 'key and name are required');

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
    action: 'role.created',
    targetType: 'role',
    targetId: role.id,
    metadata: { key, name },
  });

  return res.status(201).json(role);
}

export async function updateRole(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const role = await prisma.role.findFirst({
    where: { id: req.params.id, organization_id: organizationId },
  });

  if (!role) throw new AppHttpError(404, 'Role not found');
  if (role.is_system) throw new AppHttpError(400, 'System role cannot be edited');

  const updated = await prisma.role.update({
    where: { id: role.id },
    data: {
      key: req.body?.key ?? role.key,
      name: req.body?.name ?? role.name,
    },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'role.updated',
    targetType: 'role',
    targetId: role.id,
    metadata: req.body ?? {},
  });

  return res.status(200).json(updated);
}

export async function deleteRole(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;

  const role = await prisma.role.findFirst({
    where: { id: req.params.id, organization_id: organizationId },
  });
  if (!role) throw new AppHttpError(404, 'Role not found');
  if (role.is_system) throw new AppHttpError(400, 'System role cannot be deleted');

  const usage = await prisma.membership.count({
    where: { organization_id: organizationId, role_key: role.key },
  });

  if (usage > 0) throw new AppHttpError(400, 'Role is assigned to members');

  await prisma.role.delete({ where: { id: role.id } });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'role.deleted',
    targetType: 'role',
    targetId: role.id,
  });

  return res.status(204).send();
}

export async function listTools(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const roleKey = req.roleKey!;

  const settings = await prisma.organizationToolSetting.findMany({
    where: { organization_id: organizationId },
  });

  const settingMap = new Map(settings.map((s) => [s.tool_key, s.is_enabled]));

  const capabilities = await capabilitiesForRole({ organizationId, roleKey });
  const blockedMap = new Map(capabilities.tools_blocked.map((b) => [b.tool, b.reason]));

  return res.status(200).json(
    TOOL_CATALOG.map((toolKey) => ({
      tool_key: toolKey,
      enabled: settingMap.get(toolKey) ?? true,
      allowed_for_requester: capabilities.tools_allowed.includes(toolKey),
      deny_reason_for_requester: blockedMap.get(toolKey) ?? null,
    })),
  );
}

export async function updateRoleToolPermission(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const roleId = req.params.roleId;
  const toolKey = req.params.toolKey;

  const role = await prisma.role.findFirst({
    where: {
      id: roleId,
      OR: [{ organization_id: organizationId }, { organization_id: null }],
    },
  });

  if (!role) throw new AppHttpError(404, 'Role not found');

  const can_execute = Boolean(req.body?.can_execute);
  const requires_approval = Boolean(req.body?.requires_approval);

  const permission = await prisma.roleToolPermission.upsert({
    where: {
      role_id_tool_key: {
        role_id: role.id,
        tool_key: toolKey,
      },
    },
    create: {
      role_id: role.id,
      tool_key: toolKey,
      can_execute,
      requires_approval,
    },
    update: {
      can_execute,
      requires_approval,
    },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'tool.permission.updated',
    targetType: 'role_tool_permission',
    targetId: permission.id,
    metadata: { role_id: role.id, tool_key: toolKey, can_execute, requires_approval },
  });

  return res.status(200).json(permission);
}

export async function setToolEnabled(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const actorUserId = req.userId!;
  const toolKey = req.params.toolKey;
  const enabled = Boolean(req.body?.enabled);

  const setting = await prisma.organizationToolSetting.upsert({
    where: {
      organization_id_tool_key: {
        organization_id: organizationId,
        tool_key: toolKey,
      },
    },
    create: {
      organization_id: organizationId,
      tool_key: toolKey,
      is_enabled: enabled,
    },
    update: {
      is_enabled: enabled,
    },
  });

  await logAudit({
    organizationId,
    actorUserId,
    action: 'tool.setting.updated',
    targetType: 'organization_tool_setting',
    targetId: setting.id,
    metadata: { tool_key: toolKey, enabled },
  });

  return res.status(200).json(setting);
}
