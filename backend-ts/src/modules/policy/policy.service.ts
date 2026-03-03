import { prisma } from '../../utils/prisma';
import { TOOL_CATALOG } from './tool-catalog';

export type PolicyReasonCode =
  | 'tool_not_permitted'
  | 'role_not_assigned'
  | 'tool_disabled_org_level'
  | 'requires_higher_role'
  | 'approval_required'
  | 'not_org_member'
  | 'policy_conflict';

export interface PolicyDecision {
  allowed: boolean;
  reason_code: PolicyReasonCode;
  reason_message: string;
  requires_approval: boolean;
}

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  manager: 3,
  admin: 4,
  owner: 5,
};

const ROLE_DEFAULTS: Record<string, Record<string, PolicyDecision>> = {
  owner: {
    get_current_time: allow(),
    'zoho.clients.read': allow(),
    'zoho.invoices.read': allow(),
    'zoho.invoice.write': approvalRequired(),
  },
  admin: {
    get_current_time: allow(),
    'zoho.clients.read': allow(),
    'zoho.invoices.read': allow(),
    'zoho.invoice.write': approvalRequired(),
  },
  manager: {
    get_current_time: allow(),
    'zoho.clients.read': allow(),
    'zoho.invoices.read': allow(),
    'zoho.invoice.write': deny('requires_higher_role', 'This action requires a higher role.'),
  },
  member: {
    get_current_time: allow(),
    'zoho.clients.read': allow(),
    'zoho.invoices.read': deny('tool_not_permitted', 'Your role does not allow this tool.'),
    'zoho.invoice.write': deny('requires_higher_role', 'This action requires a higher role.'),
  },
  viewer: {
    get_current_time: allow(),
    'zoho.clients.read': deny('tool_not_permitted', 'Your role does not allow this tool.'),
    'zoho.invoices.read': deny('tool_not_permitted', 'Your role does not allow this tool.'),
    'zoho.invoice.write': deny('requires_higher_role', 'This action requires a higher role.'),
  },
};

function allow(): PolicyDecision {
  return {
    allowed: true,
    reason_code: 'policy_conflict',
    reason_message: 'Allowed by policy.',
    requires_approval: false,
  };
}

function approvalRequired(): PolicyDecision {
  return {
    allowed: false,
    reason_code: 'approval_required',
    reason_message: 'Approval token required before execution.',
    requires_approval: true,
  };
}

function deny(reason_code: PolicyReasonCode, reason_message: string): PolicyDecision {
  return { allowed: false, reason_code, reason_message, requires_approval: false };
}

function fallbackPolicy(roleKey: string, toolKey: string): PolicyDecision {
  const roleMap = ROLE_DEFAULTS[roleKey] ?? ROLE_DEFAULTS.viewer;
  return roleMap[toolKey] ?? deny('tool_not_permitted', 'Your role does not allow this tool.');
}

export function compareRoleRank(left: string, right: string): number {
  return (ROLE_RANK[left] ?? 0) - (ROLE_RANK[right] ?? 0);
}

export async function getMembershipRole(params: { organizationId: string; userId: string }) {
  const membership = await prisma.membership.findFirst({
    where: {
      user_id: params.userId,
      organization_id: params.organizationId,
      status: 'active',
    },
    include: {
      member_roles: {
        where: { status: 'active' },
        include: { role: true },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });

  if (!membership) return null;

  const memberRole = membership.member_roles[0];
  if (memberRole?.role) {
    return {
      membershipId: membership.id,
      roleId: memberRole.role.id,
      roleKey: memberRole.role.key,
      roleName: memberRole.role.name,
    };
  }

  const fallbackRole = await prisma.role.findFirst({
    where: {
      key: membership.role_key,
      OR: [{ organization_id: params.organizationId }, { organization_id: null }],
    },
    orderBy: { organization_id: 'desc' },
  });

  if (!fallbackRole) return null;

  return {
    membershipId: membership.id,
    roleId: fallbackRole.id,
    roleKey: fallbackRole.key,
    roleName: fallbackRole.name,
  };
}

export async function resolvePolicyForUser(params: {
  organizationId: string;
  userId: string;
  toolKey: string;
  action: string;
}): Promise<PolicyDecision> {
  if (!TOOL_CATALOG.includes(params.toolKey as (typeof TOOL_CATALOG)[number])) {
    return deny('policy_conflict', 'Unknown tool key.');
  }

  if (params.action !== 'execute') {
    return deny('policy_conflict', 'Unsupported policy action.');
  }

  const userRole = await getMembershipRole({
    organizationId: params.organizationId,
    userId: params.userId,
  });

  if (!userRole) {
    const memberExists = await prisma.membership.findFirst({
      where: {
        user_id: params.userId,
        organization_id: params.organizationId,
      },
      select: { id: true },
    });

    if (!memberExists) {
      return deny('not_org_member', 'User is not a member of this organization.');
    }

    return deny('role_not_assigned', 'No active role is assigned for this member.');
  }

  const toolSetting = await prisma.organizationToolSetting.findUnique({
    where: {
      organization_id_tool_key: {
        organization_id: params.organizationId,
        tool_key: params.toolKey,
      },
    },
  });

  if (toolSetting && !toolSetting.is_enabled) {
    return deny('tool_disabled_org_level', 'This tool is disabled at organization level.');
  }

  const permission = await prisma.roleToolPermission.findUnique({
    where: {
      role_id_tool_key: {
        role_id: userRole.roleId,
        tool_key: params.toolKey,
      },
    },
  });

  if (permission) {
    if (!permission.can_execute) {
      return deny('tool_not_permitted', 'Your role does not allow this tool.');
    }

    if (permission.requires_approval) {
      return approvalRequired();
    }

    return allow();
  }

  return fallbackPolicy(userRole.roleKey, params.toolKey);
}

export async function resolvePolicy(params: {
  organizationId: string;
  roleKey: string;
  toolKey: string;
}): Promise<{ allowed: boolean; reason: string; requires_approval: boolean }> {
  const toolSetting = await prisma.organizationToolSetting.findUnique({
    where: {
      organization_id_tool_key: {
        organization_id: params.organizationId,
        tool_key: params.toolKey,
      },
    },
  });

  if (toolSetting && !toolSetting.is_enabled) {
    return {
      allowed: false,
      reason: 'tool_disabled_org_level',
      requires_approval: false,
    };
  }

  const role = await prisma.role.findFirst({
    where: {
      key: params.roleKey,
      OR: [{ organization_id: params.organizationId }, { organization_id: null }],
    },
    orderBy: { organization_id: 'desc' },
  });

  if (role) {
    const permission = await prisma.roleToolPermission.findUnique({
      where: {
        role_id_tool_key: {
          role_id: role.id,
          tool_key: params.toolKey,
        },
      },
    });

    if (permission) {
      if (!permission.can_execute) {
        return {
          allowed: false,
          reason: 'tool_not_permitted',
          requires_approval: false,
        };
      }

      if (permission.requires_approval) {
        return {
          allowed: false,
          reason: 'approval_required',
          requires_approval: true,
        };
      }

      return {
        allowed: true,
        reason: 'allowed',
        requires_approval: false,
      };
    }
  }

  const fallback = fallbackPolicy(params.roleKey, params.toolKey);
  return {
    allowed: fallback.allowed,
    reason: fallback.reason_code,
    requires_approval: fallback.requires_approval,
  };
}

export async function capabilitiesForRole(params: { organizationId: string; roleKey: string }) {
  const tools_allowed: string[] = [];
  const tools_blocked: Array<{ tool: string; reason: string }> = [];

  for (const toolKey of TOOL_CATALOG) {
    const policy = await resolvePolicy({
      organizationId: params.organizationId,
      roleKey: params.roleKey,
      toolKey,
    });

    if (policy.allowed) {
      tools_allowed.push(toolKey);
    } else {
      tools_blocked.push({ tool: toolKey, reason: policy.reason });
    }
  }

  return { tools_allowed, tools_blocked };
}

export async function capabilitiesForUser(params: { organizationId: string; userId: string }) {
  const role = await getMembershipRole(params);

  if (!role) {
    return {
      roles: [] as string[],
      tools: {
        allowed: [] as string[],
        blocked: TOOL_CATALOG.map((tool_key) => ({
          tool_key,
          reason_code: 'role_not_assigned' as PolicyReasonCode,
        })),
        approval_required: [] as string[],
      },
    };
  }

  const allowed: string[] = [];
  const blocked: Array<{ tool_key: string; reason_code: PolicyReasonCode }> = [];
  const approvalRequired: string[] = [];

  for (const toolKey of TOOL_CATALOG) {
    const policy = await resolvePolicyForUser({
      organizationId: params.organizationId,
      userId: params.userId,
      toolKey,
      action: 'execute',
    });

    if (policy.allowed) {
      allowed.push(toolKey);
    } else {
      blocked.push({ tool_key: toolKey, reason_code: policy.reason_code });
      if (policy.requires_approval) {
        approvalRequired.push(toolKey);
      }
    }
  }

  return {
    roles: [role.roleKey],
    tools: {
      allowed,
      blocked,
      approval_required: approvalRequired,
    },
  };
}
