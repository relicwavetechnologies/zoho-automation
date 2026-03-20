import { HttpException } from '../../core/http-exception';
import { prisma } from '../../utils/prisma';
import { TOOL_REGISTRY } from '../tools/tool-registry';
import { getSupportedToolActionGroups, type ToolActionGroup } from '../tools/tool-action-groups';
import { hashPassword } from '../../utils/bcrypt';
import crypto from 'crypto';
import { skillService } from '../skills/skill.service';
import { departmentRuntimeCache } from './department-runtime.cache';

type DepartmentAdminRole = 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'DEPARTMENT_MANAGER';

export type DepartmentAdminSession = {
  userId: string;
  role: DepartmentAdminRole;
  companyId?: string;
};

export type UserDepartmentSummary = {
  id: string;
  name: string;
  slug: string;
  roleId: string;
  roleSlug: string;
  roleName: string;
  canManage: boolean;
};

export type DepartmentCandidateSummary = {
  channelIdentityId: string;
  userId?: string;
  name?: string;
  email?: string;
  workspaceRole?: string;
  isWorkspaceMember: boolean;
  isAlreadyAssigned: boolean;
  larkDisplayName?: string;
  larkUserId?: string;
  larkOpenId?: string;
  larkSourceRoles: string[];
};

export type ResolvedDepartmentRuntime = {
  departmentId?: string;
  departmentName?: string;
  departmentRoleSlug?: string;
  systemPrompt?: string;
  skillsMarkdown?: string;
  allowedToolIds: string[];
  allowedActionsByTool?: Record<string, ToolActionGroup[]>;
};

const DEFAULT_MEMBER_TOOL_IDS = new Set(['search-read', 'search-agent', 'skill-search']);

const normalizeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const normalizeRoleSlug = (value: string): string =>
  value.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 40);

const vercelToolIds = TOOL_REGISTRY.filter((tool) => tool.engines.includes('vercel')).map((tool) => tool.id);
const ACTION_GROUP_ALL = 'all';

const uniqueByUserId = <T extends { userId: string }>(rows: T[]): T[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.userId)) return false;
    seen.add(row.userId);
    return true;
  });
};

const normalizeSearchValue = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const computeCandidateScore = (
  candidate: Pick<
    DepartmentCandidateSummary,
    'name' | 'email' | 'larkDisplayName' | 'larkUserId' | 'larkOpenId' | 'larkSourceRoles' | 'isWorkspaceMember'
  >,
  query: string,
): number => {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) {
    return candidate.isWorkspaceMember ? 10 : 0;
  }

  const fields = [
    candidate.name,
    candidate.email,
    candidate.larkDisplayName,
    candidate.larkUserId,
    candidate.larkOpenId,
    ...(candidate.larkSourceRoles ?? []),
  ]
    .map((value) => normalizeSearchValue(value))
    .filter((value) => value.length > 0);

  if (fields.length === 0) return -1;

  let bestScore = -1;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');

  for (const field of fields) {
    if (field === normalizedQuery) bestScore = Math.max(bestScore, 100);
    if (field.startsWith(normalizedQuery)) bestScore = Math.max(bestScore, 80);
    if (field.includes(normalizedQuery)) bestScore = Math.max(bestScore, 60);

    if (terms.length > 1 && terms.every((term) => field.includes(term))) {
      bestScore = Math.max(bestScore, 70);
    }

    if (field.replace(/\s+/g, '').includes(compactQuery)) {
      bestScore = Math.max(bestScore, 65);
    }
  }

  if (bestScore < 0) return -1;
  return bestScore + (candidate.isWorkspaceMember ? 8 : 0);
};

const buildCaseInsensitiveEmailClauses = (emails: string[]) =>
  emails
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0)
    .map((email) => ({
      email: {
        equals: email,
        mode: 'insensitive' as const,
      },
    }));

class DepartmentService {
  private async resolveDepartmentCompanyId(departmentId: string, fallbackCompanyId?: string): Promise<string> {
    if (fallbackCompanyId) return fallbackCompanyId;
    const department = await prisma.department.findUnique({
      where: { id: departmentId },
      select: { companyId: true },
    });
    if (!department) {
      throw new HttpException(404, 'Department not found.');
    }
    return department.companyId;
  }

  private async ensureWorkspaceMemberFromChannelIdentity(input: {
    companyId: string;
    channelIdentityId: string;
  }): Promise<{ userId: string; workspaceRole: string }> {
    const identity = await prisma.channelIdentity.findFirst({
      where: {
        id: input.channelIdentityId,
        companyId: input.companyId,
        channel: 'lark',
      },
    });

    if (!identity) {
      throw new HttpException(404, 'Synced Lark user not found.');
    }

    const email = identity.email?.trim();
    if (!email) {
      throw new HttpException(400, 'This synced Lark user has no email, so it cannot be mapped into a department yet.');
    }

    const normalizedEmail = email.toLowerCase();
    let user = await prisma.user.findFirst({
      where: {
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
    });

    if (!user) {
      const hashedPassword = await hashPassword(crypto.randomBytes(24).toString('hex'));
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          password: hashedPassword,
          name: identity.displayName ?? email.split('@')[0],
        },
      });
    }

    const existingMembership = await prisma.adminMembership.findFirst({
      where: {
        userId: user.id,
        companyId: input.companyId,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingMembership) {
      const active = await prisma.adminMembership.update({
        where: { id: existingMembership.id },
        data: { isActive: true },
      });
      return {
        userId: user.id,
        workspaceRole: active.role,
      };
    }

    const createdMembership = await prisma.adminMembership.create({
      data: {
        userId: user.id,
        companyId: input.companyId,
        role: 'MEMBER',
        isActive: true,
      },
    });

    return {
      userId: user.id,
      workspaceRole: createdMembership.role,
    };
  }

  async listUserDepartments(userId: string, companyId: string): Promise<UserDepartmentSummary[]> {
    const rows = await prisma.departmentMembership.findMany({
      where: {
        userId,
        status: 'active',
        department: {
          companyId,
          status: 'active',
        },
      },
      include: {
        department: true,
        role: true,
      },
      orderBy: [
        { department: { name: 'asc' } },
        { createdAt: 'asc' },
      ],
    });

    return rows.map((row) => ({
      id: row.department.id,
      name: row.department.name,
      slug: row.department.slug,
      roleId: row.roleId,
      roleSlug: row.role.slug,
      roleName: row.role.name,
      canManage: row.role.slug === 'MANAGER',
    }));
  }

  async userManagesAnyDepartment(userId: string, companyId: string): Promise<boolean> {
    const count = await prisma.departmentMembership.count({
      where: {
        userId,
        status: 'active',
        department: {
          companyId,
          status: 'active',
        },
        role: {
          slug: 'MANAGER',
        },
      },
    });

    return count > 0;
  }

  async resolveDepartmentForThreadCreation(input: {
    userId: string;
    companyId: string;
    requestedDepartmentId?: string;
  }): Promise<UserDepartmentSummary | null> {
    const departments = await this.listUserDepartments(input.userId, input.companyId);
    if (departments.length === 0) {
      return null;
    }

    if (input.requestedDepartmentId) {
      const match = departments.find((department) => department.id === input.requestedDepartmentId);
      if (!match) {
        throw new HttpException(403, 'You do not have access to the selected department.');
      }
      return match;
    }

    if (departments.length === 1) {
      return departments[0];
    }

    throw new HttpException(400, 'Select a department before starting a new chat.');
  }

  async resolveRuntimeContext(input: {
    userId: string;
    companyId: string;
    departmentId?: string | null;
    fallbackAllowedToolIds: string[];
  }): Promise<ResolvedDepartmentRuntime> {
    if (!input.departmentId) {
      const allowedActionsByTool = Object.fromEntries(
        input.fallbackAllowedToolIds.map((toolId) => [toolId, getSupportedToolActionGroups(toolId)]),
      );
      return { allowedToolIds: input.fallbackAllowedToolIds, allowedActionsByTool };
    }

    const cached = await departmentRuntimeCache.get({
      companyId: input.companyId,
      userId: input.userId,
      departmentId: input.departmentId,
      fallbackAllowedToolIds: input.fallbackAllowedToolIds,
    });
    if (cached) {
      return cached;
    }

    const membership = await prisma.departmentMembership.findFirst({
      where: {
        userId: input.userId,
        status: 'active',
        departmentId: input.departmentId,
        department: {
          companyId: input.companyId,
          status: 'active',
        },
      },
      include: {
        department: {
          include: {
            agentConfig: true,
          },
        },
        role: true,
      },
    });

    if (!membership) {
      throw new HttpException(403, 'You do not have access to this department.');
    }

    const rolePermissions = await prisma.departmentToolPermission.findMany({
      where: {
        departmentId: membership.departmentId,
        roleId: membership.roleId,
      },
    });
    const userOverrides = await prisma.departmentUserToolOverride.findMany({
      where: {
        departmentId: membership.departmentId,
        userId: input.userId,
      },
    });

    const buildActionLookup = <T extends { toolId: string; actionGroup: string; allowed: boolean }>(rows: T[]) => {
      const map = new Map<string, Map<string, boolean>>();
      for (const row of rows) {
        const existing = map.get(row.toolId) ?? new Map<string, boolean>();
        existing.set(row.actionGroup, row.allowed);
        map.set(row.toolId, existing);
      }
      return map;
    };

    const rolePermissionMap = buildActionLookup(rolePermissions);
    const overrideMap = buildActionLookup(userOverrides);

    const defaultAllowed = (toolId: string): boolean => {
      if (membership.role.slug === 'MANAGER') return true;
      return DEFAULT_MEMBER_TOOL_IDS.has(toolId);
    };

    const fallbackAllowed = new Set(input.fallbackAllowedToolIds);
    const resolveActionAllowed = (toolId: string, actionGroup: ToolActionGroup): boolean => {
      if (!fallbackAllowed.has(toolId)) return false;

      const overrideRows = overrideMap.get(toolId);
      if (overrideRows?.has(actionGroup)) {
        return overrideRows.get(actionGroup) as boolean;
      }
      if (overrideRows?.has(ACTION_GROUP_ALL)) {
        return overrideRows.get(ACTION_GROUP_ALL) as boolean;
      }

      const roleRows = rolePermissionMap.get(toolId);
      if (roleRows?.has(actionGroup)) {
        return roleRows.get(actionGroup) as boolean;
      }
      if (roleRows?.has(ACTION_GROUP_ALL)) {
        return roleRows.get(ACTION_GROUP_ALL) as boolean;
      }

      return defaultAllowed(toolId);
    };

    const allowedActionsByTool = Object.fromEntries(
      vercelToolIds
        .map((toolId) => {
          const actions = getSupportedToolActionGroups(toolId).filter((actionGroup) =>
            resolveActionAllowed(toolId, actionGroup));
          return [toolId, actions] as const;
        })
        .filter(([, actions]) => actions.length > 0),
    );
    const allowedToolIds = Object.keys(allowedActionsByTool);

    const resolved: ResolvedDepartmentRuntime = {
      departmentId: membership.department.id,
      departmentName: membership.department.name,
      departmentRoleSlug: membership.role.slug,
      systemPrompt: membership.department.agentConfig?.systemPrompt ?? undefined,
      skillsMarkdown: membership.department.agentConfig?.skillsMarkdown ?? undefined,
      allowedToolIds,
      allowedActionsByTool,
    };
    await departmentRuntimeCache.set({
      companyId: input.companyId,
      userId: input.userId,
      departmentId: input.departmentId,
      fallbackAllowedToolIds: input.fallbackAllowedToolIds,
      runtime: resolved,
    });
    return resolved;
  }

  private async resolveAdminCompanyId(session: DepartmentAdminSession, requestedCompanyId?: string): Promise<string> {
    if (session.role === 'SUPER_ADMIN') {
      if (!requestedCompanyId) {
        throw new HttpException(400, 'companyId is required.');
      }
      return requestedCompanyId;
    }
    if (!session.companyId) {
      throw new HttpException(403, 'Company scope is missing from the admin session.');
    }
    if (requestedCompanyId && requestedCompanyId !== session.companyId) {
      throw new HttpException(403, 'Company scope mismatch.');
    }
    return session.companyId;
  }

  private async assertDepartmentAccess(
    session: DepartmentAdminSession,
    departmentId: string,
  ) {
    const department = await prisma.department.findUnique({
      where: { id: departmentId },
      include: {
        agentConfig: true,
        roles: {
          orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        },
        memberships: {
          where: { status: 'active' },
          include: {
            role: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
          orderBy: [{ role: { name: 'asc' } }, { createdAt: 'asc' }],
        },
        toolPermissions: true,
        userToolOverrides: true,
      },
    });

    if (!department) {
      throw new HttpException(404, 'Department not found.');
    }

    const companyId = await this.resolveAdminCompanyId(session, department.companyId);
    if (department.companyId !== companyId) {
      throw new HttpException(403, 'Company scope mismatch.');
    }

    if (session.role === 'DEPARTMENT_MANAGER') {
      const managerMembership = await prisma.departmentMembership.findFirst({
        where: {
          departmentId,
          userId: session.userId,
          status: 'active',
          role: { slug: 'MANAGER' },
        },
      });
      if (!managerMembership) {
        throw new HttpException(403, 'Manager access denied for this department.');
      }
    }

    return department;
  }

  async listAdminDepartments(session: DepartmentAdminSession, companyId?: string) {
    const scopedCompanyId = await this.resolveAdminCompanyId(session, companyId);

    const departments = await prisma.department.findMany({
      where: {
        companyId: scopedCompanyId,
        ...(session.role === 'DEPARTMENT_MANAGER'
          ? {
            memberships: {
              some: {
                userId: session.userId,
                status: 'active',
                role: { slug: 'MANAGER' },
              },
            },
          }
          : {}),
      },
      include: {
        memberships: {
          where: { status: 'active' },
          include: { role: true },
        },
        agentConfig: true,
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });

    return departments.map((department) => {
      const managerCount = department.memberships.filter((membership) => membership.role.slug === 'MANAGER').length;
      return {
        id: department.id,
        companyId: department.companyId,
        name: department.name,
        slug: department.slug,
        description: department.description,
        status: department.status,
        managerCount,
        memberCount: department.memberships.length,
        hasAgentConfig: Boolean(department.agentConfig),
        createdAt: department.createdAt.toISOString(),
        updatedAt: department.updatedAt.toISOString(),
      };
    });
  }

  async getAdminDepartmentDetail(session: DepartmentAdminSession, departmentId: string) {
    const department = await this.assertDepartmentAccess(session, departmentId);
    const skillBundle = await skillService.listAdminSkillBundle(session, departmentId);
    const larkIdentities = await prisma.channelIdentity.findMany({
      where: {
        companyId: department.companyId,
        channel: 'lark',
      },
      select: {
        email: true,
        displayName: true,
        larkOpenId: true,
        larkUserId: true,
        sourceRoles: true,
      },
    });
    const larkIdentityByEmail = new Map(
      larkIdentities
        .filter((row) => typeof row.email === 'string' && row.email.trim().length > 0)
        .map((row) => [row.email!.trim().toLowerCase(), row]),
    );
    const availableMembers = uniqueByUserId(await prisma.adminMembership.findMany({
      where: {
        companyId: department.companyId,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })).map((row) => {
      const larkIdentity = row.user.email ? larkIdentityByEmail.get(row.user.email.trim().toLowerCase()) : undefined;
      return {
        userId: row.userId,
        name: row.user.name,
        email: row.user.email,
        workspaceRole: row.role,
        isLarkSynced: Boolean(larkIdentity),
        larkDisplayName: larkIdentity?.displayName ?? undefined,
        larkUserId: larkIdentity?.larkUserId ?? undefined,
        larkOpenId: larkIdentity?.larkOpenId ?? undefined,
        larkSourceRoles: larkIdentity?.sourceRoles ?? [],
      };
    });

    return {
      department: {
        id: department.id,
        companyId: department.companyId,
        name: department.name,
        slug: department.slug,
        description: department.description,
        status: department.status,
        createdAt: department.createdAt.toISOString(),
        updatedAt: department.updatedAt.toISOString(),
      },
      config: {
        systemPrompt: department.agentConfig?.systemPrompt ?? '',
        skillsMarkdown: department.agentConfig?.skillsMarkdown ?? '',
        isActive: department.agentConfig?.isActive ?? true,
      },
      roles: department.roles.map((role) => ({
        id: role.id,
        name: role.name,
        slug: role.slug,
        isSystem: role.isSystem,
        isDefault: role.isDefault,
        createdAt: role.createdAt.toISOString(),
        updatedAt: role.updatedAt.toISOString(),
      })),
      memberships: department.memberships.map((membership) => ({
        id: membership.id,
        userId: membership.userId,
        name: membership.user.name,
        email: membership.user.email,
        roleId: membership.roleId,
        roleSlug: membership.role.slug,
        roleName: membership.role.name,
        status: membership.status,
        createdAt: membership.createdAt.toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
      })),
      toolPermissions: department.toolPermissions.map((row) => ({
        id: row.id,
        roleId: row.roleId,
        toolId: row.toolId,
        actionGroup: row.actionGroup,
        allowed: row.allowed,
      })),
      userOverrides: department.userToolOverrides.map((row) => ({
        id: row.id,
        userId: row.userId,
        toolId: row.toolId,
        actionGroup: row.actionGroup,
        allowed: row.allowed,
      })),
      globalSkills: skillBundle.globalSkills,
      departmentSkills: skillBundle.departmentSkills,
      availableMembers,
      availableTools: TOOL_REGISTRY.filter((tool) => tool.engines.includes('vercel')).map((tool) => ({
        toolId: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        supportedActionGroups: getSupportedToolActionGroups(tool.id),
      })),
    };
  }

  async searchDepartmentCandidates(session: DepartmentAdminSession, departmentId: string, query: string): Promise<DepartmentCandidateSummary[]> {
    const department = await this.assertDepartmentAccess(session, departmentId);
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const assignedMemberships = await prisma.departmentMembership.findMany({
      where: { departmentId },
      select: { userId: true },
    });
    const assignedUserIds = new Set(assignedMemberships.map((row) => row.userId));

    const rows = await prisma.channelIdentity.findMany({
      where: {
        companyId: department.companyId,
        channel: 'lark',
        OR: [
          {
            displayName: {
              contains: normalizedQuery,
              mode: 'insensitive',
            },
          },
          {
            email: {
              contains: normalizedQuery,
              mode: 'insensitive',
            },
          },
          {
            externalUserId: {
              contains: normalizedQuery,
              mode: 'insensitive',
            },
          },
          {
            larkOpenId: {
              contains: normalizedQuery,
              mode: 'insensitive',
            },
          },
          {
            larkUserId: {
              contains: normalizedQuery,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });

    const emails = rows
      .map((row) => row.email?.trim().toLowerCase())
      .filter((email): email is string => Boolean(email));

    const emailClauses = buildCaseInsensitiveEmailClauses(emails);

    const [users, memberships] = await Promise.all([
      emailClauses.length > 0
        ? prisma.user.findMany({
          where: {
            OR: emailClauses,
          },
          select: {
            id: true,
            email: true,
            name: true,
          },
        })
        : Promise.resolve([]),
      emailClauses.length > 0
        ? prisma.adminMembership.findMany({
          where: {
            companyId: department.companyId,
            isActive: true,
            user: {
              OR: emailClauses,
            },
          },
          include: {
            user: {
              select: {
                id: true,
                email: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        })
        : Promise.resolve([]),
    ]);

    const userByEmail = new Map(
      users.map((user) => [user.email.trim().toLowerCase(), user]),
    );
    const membershipByEmail = new Map<string, { userId: string; role: string }>();
    for (const membership of memberships) {
      const email = membership.user.email.trim().toLowerCase();
      if (!membershipByEmail.has(email)) {
        membershipByEmail.set(email, {
          userId: membership.userId,
          role: membership.role,
        });
      }
    }

    return rows
      .map((row) => {
      const normalizedEmail = row.email?.trim().toLowerCase();
      const matchedUser = normalizedEmail ? userByEmail.get(normalizedEmail) : undefined;
      const matchedMembership = normalizedEmail ? membershipByEmail.get(normalizedEmail) : undefined;
      const resolvedUserId = matchedMembership?.userId ?? matchedUser?.id;
      const candidate: DepartmentCandidateSummary = {
        channelIdentityId: row.id,
        userId: resolvedUserId,
        name: matchedUser?.name ?? row.displayName ?? undefined,
        email: row.email ?? undefined,
        workspaceRole: matchedMembership?.role,
        isWorkspaceMember: Boolean(matchedMembership),
        isAlreadyAssigned: Boolean(resolvedUserId && assignedUserIds.has(resolvedUserId)),
        larkDisplayName: row.displayName ?? undefined,
        larkUserId: row.larkUserId ?? undefined,
        larkOpenId: row.larkOpenId ?? undefined,
        larkSourceRoles: row.sourceRoles,
      };
      return {
        candidate,
        score: computeCandidateScore(candidate, normalizedQuery),
      };
      })
      .filter((row) => row.score >= 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (left.candidate.name ?? left.candidate.email ?? left.candidate.channelIdentityId).localeCompare(
          right.candidate.name ?? right.candidate.email ?? right.candidate.channelIdentityId,
        );
      })
      .map((row) => row.candidate);
  }

  async createDepartment(session: DepartmentAdminSession, input: {
    companyId?: string;
    name: string;
    description?: string;
  }) {
    if (session.role === 'DEPARTMENT_MANAGER') {
      throw new HttpException(403, 'Department managers cannot create departments.');
    }

    const companyId = await this.resolveAdminCompanyId(session, input.companyId);
    const name = input.name.trim();
    if (!name) {
      throw new HttpException(400, 'Department name is required.');
    }

    const baseSlug = normalizeSlug(name);
    if (!baseSlug) {
      throw new HttpException(400, 'Department slug could not be derived from the name.');
    }

    let slug = baseSlug;
    let suffix = 2;
    while (await prisma.department.findFirst({ where: { companyId, slug } })) {
      slug = `${baseSlug}-${suffix++}`;
    }

    const department = await prisma.$transaction(async (tx) => {
      const created = await tx.department.create({
        data: {
          companyId,
          name,
          slug,
          description: input.description?.trim() || null,
          status: 'active',
        },
      });
      const managerRole = await tx.departmentRole.create({
        data: {
          departmentId: created.id,
          name: 'Manager',
          slug: 'MANAGER',
          isSystem: true,
          isDefault: false,
        },
      });
      const memberRole = await tx.departmentRole.create({
        data: {
          departmentId: created.id,
          name: 'Member',
          slug: 'MEMBER',
          isSystem: true,
          isDefault: true,
        },
      });
      await tx.departmentAgentConfig.create({
        data: {
          departmentId: created.id,
          systemPrompt: '',
          skillsMarkdown: '',
          isActive: true,
          createdBy: session.userId,
          updatedBy: session.userId,
        },
      });
      return { created, managerRole, memberRole };
    });

    return {
      id: department.created.id,
      companyId,
      name: department.created.name,
      slug: department.created.slug,
      status: department.created.status,
      managerRoleId: department.managerRole.id,
      memberRoleId: department.memberRole.id,
    };
  }

  async updateDepartment(session: DepartmentAdminSession, departmentId: string, input: {
    name?: string;
    description?: string | null;
    status?: string;
  }) {
    const existing = await this.assertDepartmentAccess(session, departmentId);
    if (session.role === 'DEPARTMENT_MANAGER' && input.status && input.status !== existing.status) {
      throw new HttpException(403, 'Department managers cannot change department status.');
    }

    const nextName = input.name?.trim();
    let nextSlug = existing.slug;
    if (nextName && nextName !== existing.name) {
      const baseSlug = normalizeSlug(nextName);
      nextSlug = baseSlug || existing.slug;
      let suffix = 2;
      while (await prisma.department.findFirst({ where: { companyId: existing.companyId, slug: nextSlug, id: { not: departmentId } } })) {
        nextSlug = `${baseSlug}-${suffix++}`;
      }
    }

    const updated = await prisma.department.update({
      where: { id: departmentId },
      data: {
        ...(nextName ? { name: nextName, slug: nextSlug } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async archiveDepartment(session: DepartmentAdminSession, departmentId: string) {
    if (session.role === 'DEPARTMENT_MANAGER') {
      throw new HttpException(403, 'Department managers cannot archive departments.');
    }
    await this.assertDepartmentAccess(session, departmentId);
    const updated = await prisma.department.update({
      where: { id: departmentId },
      data: { status: 'archived' },
    });
    return {
      id: updated.id,
      status: updated.status,
    };
  }

  async updateDepartmentConfig(session: DepartmentAdminSession, departmentId: string, input: {
    systemPrompt: string;
    skillsMarkdown: string;
    isActive?: boolean;
  }) {
    await this.assertDepartmentAccess(session, departmentId);
    const updated = await prisma.departmentAgentConfig.upsert({
      where: { departmentId },
      update: {
        systemPrompt: input.systemPrompt,
        skillsMarkdown: input.skillsMarkdown,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedBy: session.userId,
      },
      create: {
        departmentId,
        systemPrompt: input.systemPrompt,
        skillsMarkdown: input.skillsMarkdown,
        isActive: input.isActive ?? true,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    });

    return {
      departmentId,
      systemPrompt: updated.systemPrompt,
      skillsMarkdown: updated.skillsMarkdown,
      isActive: updated.isActive,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async createDepartmentRole(session: DepartmentAdminSession, departmentId: string, input: {
    name: string;
    slug: string;
  }) {
    await this.assertDepartmentAccess(session, departmentId);
    const slug = normalizeRoleSlug(input.slug);
    if (!slug || slug === 'MANAGER' || slug === 'MEMBER') {
      throw new HttpException(400, 'Choose a unique custom role slug.');
    }
    const role = await prisma.departmentRole.create({
      data: {
        departmentId,
        name: input.name.trim(),
        slug,
        isSystem: false,
        isDefault: false,
      },
    });
    return {
      id: role.id,
      name: role.name,
      slug: role.slug,
    };
  }

  async updateDepartmentRole(session: DepartmentAdminSession, departmentId: string, roleId: string, input: { name: string }) {
    await this.assertDepartmentAccess(session, departmentId);
    const existing = await prisma.departmentRole.findFirst({
      where: { id: roleId, departmentId },
    });
    if (!existing) {
      throw new HttpException(404, 'Department role not found.');
    }
    const updated = await prisma.departmentRole.update({
      where: { id: roleId },
      data: { name: input.name.trim() },
    });
    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
    };
  }

  async updateDepartmentRoleSettings(
    session: DepartmentAdminSession,
    departmentId: string,
    roleId: string,
    input: { name: string; isDefault?: boolean },
  ) {
    await this.assertDepartmentAccess(session, departmentId);
    const existing = await prisma.departmentRole.findFirst({
      where: { id: roleId, departmentId },
    });
    if (!existing) {
      throw new HttpException(404, 'Department role not found.');
    }

    const nextName = input.name.trim();
    if (!nextName) {
      throw new HttpException(400, 'Role name is required.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.departmentRole.updateMany({
          where: { departmentId },
          data: { isDefault: false },
        });
      }

      return tx.departmentRole.update({
        where: { id: roleId },
        data: {
          name: nextName,
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      isDefault: updated.isDefault,
    };
  }

  async deleteDepartmentRole(session: DepartmentAdminSession, departmentId: string, roleId: string) {
    await this.assertDepartmentAccess(session, departmentId);
    const existing = await prisma.departmentRole.findFirst({
      where: { id: roleId, departmentId },
    });
    if (!existing) {
      throw new HttpException(404, 'Department role not found.');
    }
    if (existing.isSystem) {
      throw new HttpException(400, 'System roles cannot be deleted.');
    }
    if (existing.isDefault) {
      throw new HttpException(409, 'Choose a different default role before deleting this one.');
    }
    const membershipCount = await prisma.departmentMembership.count({ where: { roleId, status: 'active' } });
    if (membershipCount > 0) {
      throw new HttpException(409, 'Move members off this role before deleting it.');
    }
    await prisma.departmentRole.delete({ where: { id: roleId } });
    return { deleted: true };
  }

  async upsertDepartmentMembership(session: DepartmentAdminSession, departmentId: string, input: {
    userId?: string;
    channelIdentityId?: string;
    roleId?: string;
    status?: string;
  }) {
    const department = await this.assertDepartmentAccess(session, departmentId);
    let resolvedUserId = input.userId;
    if (!resolvedUserId && input.channelIdentityId) {
      const mapped = await this.ensureWorkspaceMemberFromChannelIdentity({
        companyId: department.companyId,
        channelIdentityId: input.channelIdentityId,
      });
      resolvedUserId = mapped.userId;
    }
    if (!resolvedUserId) {
      throw new HttpException(400, 'userId or channelIdentityId is required.');
    }
    const workspaceMember = await prisma.adminMembership.findFirst({
      where: {
        userId: resolvedUserId,
        companyId: department.companyId,
        isActive: true,
      },
    });
    if (!workspaceMember) {
      throw new HttpException(400, 'User must already be an active workspace member.');
    }
    const role = input.roleId
      ? await prisma.departmentRole.findFirst({
        where: { id: input.roleId, departmentId },
      })
      : await prisma.departmentRole.findFirst({
        where: { departmentId, isDefault: true },
        orderBy: [{ updatedAt: 'desc' }],
      });
    if (!role) {
      throw new HttpException(404, 'Department role not found. Configure a default department role first.');
    }

    const membership = await prisma.departmentMembership.upsert({
      where: {
        departmentId_userId: {
          departmentId,
          userId: resolvedUserId,
        },
      },
      update: {
        roleId: input.roleId,
        status: input.status ?? 'active',
      },
      create: {
        departmentId,
        userId: resolvedUserId,
        roleId: role.id,
        status: input.status ?? 'active',
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        role: true,
      },
    });

    return {
      id: membership.id,
      userId: membership.userId,
      name: membership.user.name,
      email: membership.user.email,
      roleId: membership.roleId,
      roleSlug: membership.role.slug,
      roleName: membership.role.name,
      status: membership.status,
    };
  }

  async removeDepartmentMembership(session: DepartmentAdminSession, departmentId: string, userId: string) {
    await this.assertDepartmentAccess(session, departmentId);
    await prisma.departmentMembership.delete({
      where: {
        departmentId_userId: {
          departmentId,
          userId,
        },
      },
    });
    return { deleted: true };
  }

  async updateDepartmentRolePermission(
    session: DepartmentAdminSession,
    departmentId: string,
    roleId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
  ) {
    await this.assertDepartmentAccess(session, departmentId);
    const role = await prisma.departmentRole.findFirst({
      where: { id: roleId, departmentId },
    });
    if (!role) {
      throw new HttpException(404, 'Department role not found.');
    }
    if (!vercelToolIds.includes(toolId)) {
      throw new HttpException(404, 'Unknown or unsupported tool.');
    }
    const normalizedActionGroup = actionGroup.trim().toLowerCase();
    if (normalizedActionGroup !== ACTION_GROUP_ALL && !getSupportedToolActionGroups(toolId).includes(normalizedActionGroup as ToolActionGroup)) {
      throw new HttpException(400, 'Unsupported action group for this tool.');
    }
    const row = await prisma.departmentToolPermission.upsert({
      where: {
        departmentId_roleId_toolId_actionGroup: {
          departmentId,
          roleId,
          toolId,
          actionGroup: normalizedActionGroup,
        },
      },
      update: {
        allowed,
        updatedBy: session.userId,
      },
      create: {
        departmentId,
        roleId,
        toolId,
        actionGroup: normalizedActionGroup,
        allowed,
        updatedBy: session.userId,
      },
    });
    await departmentRuntimeCache.invalidateDepartment(
      await this.resolveDepartmentCompanyId(departmentId, session.companyId),
      departmentId,
    );
    return {
      id: row.id,
      roleId: row.roleId,
      toolId: row.toolId,
      actionGroup: row.actionGroup,
      allowed: row.allowed,
    };
  }

  async updateDepartmentUserOverride(
    session: DepartmentAdminSession,
    departmentId: string,
    userId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
  ) {
    await this.assertDepartmentAccess(session, departmentId);
    if (!vercelToolIds.includes(toolId)) {
      throw new HttpException(404, 'Unknown or unsupported tool.');
    }
    const normalizedActionGroup = actionGroup.trim().toLowerCase();
    if (normalizedActionGroup !== ACTION_GROUP_ALL && !getSupportedToolActionGroups(toolId).includes(normalizedActionGroup as ToolActionGroup)) {
      throw new HttpException(400, 'Unsupported action group for this tool.');
    }
    const row = await prisma.departmentUserToolOverride.upsert({
      where: {
        departmentId_userId_toolId_actionGroup: {
          departmentId,
          userId,
          toolId,
          actionGroup: normalizedActionGroup,
        },
      },
      update: {
        allowed,
        updatedBy: session.userId,
      },
      create: {
        departmentId,
        userId,
        toolId,
        actionGroup: normalizedActionGroup,
        allowed,
        updatedBy: session.userId,
      },
    });
    await departmentRuntimeCache.invalidateDepartment(
      await this.resolveDepartmentCompanyId(departmentId, session.companyId),
      departmentId,
    );
    return {
      id: row.id,
      userId: row.userId,
      toolId: row.toolId,
      actionGroup: row.actionGroup,
      allowed: row.allowed,
    };
  }
}

export const departmentService = new DepartmentService();
