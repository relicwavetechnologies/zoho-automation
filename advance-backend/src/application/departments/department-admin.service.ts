import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import { Prisma } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { PermissionService } from '../permissions/permission.service';
import {
  CANONICAL_TOOL_IDS,
  TOOL_DEFAULT_PERMISSIONS,
  TOOL_SUPPORTED_ACTIONS,
  type CanonicalToolId,
} from '../../domain/tools/tool-id';
import { provisionZohoFinanceSystemSkills } from '../skills/zoho-finance-system-skills';
import { syncSystemSkillRoutes } from '../skills/system-skill-routes';
import {
  DEPARTMENT_COMPANY_INHERITED_TOOLS,
  isFixedToolPolicy,
  isDepartmentGrantOnlyTool,
} from '../../domain/tools/tool-policy';

export interface DepartmentAdminServiceDeps {
  prisma: PrismaClient;
  logger: Logger;
  permissions: PermissionService;
}

/** Sparse MEMBER-template grants used to seed department role matrices. */
export function memberTemplateGrants(): Array<{ toolId: string; actionGroup: string }> {
  const grants: Array<{ toolId: string; actionGroup: string }> = [];
  for (const toolId of CANONICAL_TOOL_IDS) {
    if (isFixedToolPolicy(toolId)) continue;
    // Permissive by role default, but only as a ceiling — seeding it here
    // would hand it to every member of every new role matrix.
    if (isDepartmentGrantOnlyTool(toolId)) continue;
    // Central identity capabilities inherit the live company RBAC decision.
    // Storing duplicate role rows would obscure that single authority and make
    // newly added actions depend on department-creation time.
    if (DEPARTMENT_COMPANY_INHERITED_TOOLS.includes(toolId)) continue;
    if (!TOOL_DEFAULT_PERMISSIONS[toolId].MEMBER) continue;
    for (const actionGroup of TOOL_SUPPORTED_ACTIONS[toolId as CanonicalToolId]) {
      grants.push({ toolId, actionGroup });
    }
  }
  return grants;
}

export type DeptServiceError =
  | { kind: 'not_found';  message: string }
  | { kind: 'conflict';   message: string }
  | { kind: 'validation'; message: string }
  | { kind: 'forbidden';  message: string }
  | { kind: 'internal';   message: string };

type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: DeptServiceError };

function ok<T>(value: T): ServiceResult<T> { return { ok: true,  value }; }
function fail<T>(error: DeptServiceError): ServiceResult<T> { return { ok: false, error }; }

// ── Slug helpers ──────────────────────────────────────────────────────────────

const normalizeSlug = (v: string) =>
  v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const normalizeRoleSlug = (v: string) =>
  v.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '').slice(0, 40);

// ── Tool validation ───────────────────────────────────────────────────────────

const VALID_TOOL_IDS = new Set<string>(CANONICAL_TOOL_IDS);

function validateToolAndAction(toolId: string, actionGroup: string): DeptServiceError | null {
  if (!VALID_TOOL_IDS.has(toolId)) {
    return { kind: 'validation', message: `Unknown tool ID: ${toolId}` };
  }
  if (isFixedToolPolicy(toolId)) {
    return { kind: 'validation', message: `Fixed-policy tool cannot be configured: ${toolId}` };
  }
  const supported = TOOL_SUPPORTED_ACTIONS[toolId as keyof typeof TOOL_SUPPORTED_ACTIONS] ?? [];
  if (actionGroup !== 'all' && !supported.includes(actionGroup)) {
    return { kind: 'validation', message: `Unsupported action group '${actionGroup}' for tool '${toolId}'` };
  }
  return null;
}

// ── View types ────────────────────────────────────────────────────────────────

export interface DeptSummary {
  id:            string;
  companyId:     string;
  name:          string;
  slug:          string;
  description:   string | null;
  status:        string;
  managerCount:  number;
  memberCount:   number;
  roleCount:     number;
  hasAgentConfig: boolean;
  createdAt:     string;
  updatedAt:     string;
}

export interface DeptRoleView {
  id:            string;
  name:          string;
  slug:          string;
  isSystem:      boolean;
  isDefault:     boolean;
  zohoReadScope: string;
  createdAt:     string;
  updatedAt:     string;
}

export interface DeptMembershipView {
  id:        string;
  userId:    string;
  name:      string | null;
  email:     string;
  roleId:    string;
  roleSlug:  string;
  roleName:  string;
  status:    string;
  createdAt: string;
  updatedAt: string;
}

export interface DeptToolPermView {
  id:          string;
  roleId:      string;
  toolId:      string;
  actionGroup: string;
  allowed:     boolean;
}

export interface DeptUserOverrideView {
  id:          string;
  userId:      string;
  toolId:      string;
  actionGroup: string;
  allowed:     boolean;
}

export interface SkillView {
  id:           string;
  name:         string;
  slug:         string;
  summary:      string;
  markdown:     string;
  toolIds:      string[];
  tags:         string[];
  status:       string;
  scope:        string;
  departmentId: string | null;
  folderId:     string | null;
}

export type DeptDetailSection =
  | 'overview'
  | 'roles'
  | 'members'
  | 'permissions'
  | 'config';

const ALL_DEPT_DETAIL_SECTIONS: DeptDetailSection[] = ['overview', 'roles', 'members', 'permissions', 'config'];

export interface DeptDetail {
  loadedSections: DeptDetailSection[];
  department: {
    id:          string;
    companyId:   string;
    name:        string;
    slug:        string;
    description: string | null;
    status:      string;
    createdAt:   string;
    updatedAt:   string;
  };
  config: {
    systemPrompt:    string;
    desktopPersonaPrompt: string;
    managerApproval: unknown;
    isActive:        boolean;
  };
  roles:            DeptRoleView[];
  memberships:      DeptMembershipView[];
  toolPermissions:  DeptToolPermView[];
  userOverrides:    DeptUserOverrideView[];
  departmentSkills: SkillView[];
  globalSkills:     SkillView[];
  availableTools:   Array<{ toolId: string; supportedActionGroups: string[] }>;
}

export interface CandidateSummary {
  channelIdentityId:   string;
  userId?:             string;
  name?:               string;
  email?:              string;
  workspaceRole?:      string;
  isWorkspaceMember:   boolean;
  isAlreadyAssigned:   boolean;
  larkDisplayName?:    string;
  larkUserId?:         string;
  larkOpenId?:         string;
  larkSourceRoles:     string[];
}

export class DepartmentAdminService {
  private readonly log: Logger;

  constructor(private readonly deps: DepartmentAdminServiceDeps) {
    this.log = deps.logger.child({ service: 'department-admin' });
  }

  private async assertDepartmentInCompany(
    departmentId: string,
    companyId: string,
  ): Promise<ServiceResult<{ id: string; companyId: string; name: string; slug: string }>> {
    const dept = await this.deps.prisma.department.findFirst({
      where: { id: departmentId, companyId },
      select: { id: true, companyId: true, name: true, slug: true },
    });
    if (!dept) {
      return fail({ kind: 'not_found', message: 'Department not found' });
    }
    return ok(dept);
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listDepartments(companyId: string, limit?: number): Promise<ServiceResult<DeptSummary[]>> {
    try {
      const rows = await this.deps.prisma.department.findMany({
        where:   { companyId },
        include: {
          memberships: { where: { status: 'active' }, include: { role: true } },
          roles: { select: { id: true } },
          agentConfig: { select: { id: true } },
        },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        take: limit ?? 200,
      });
      return ok(rows.map(r => ({
        id:             r.id,
        companyId:      r.companyId,
        name:           r.name,
        slug:           r.slug,
        description:    r.description,
        status:         r.status,
        managerCount:   r.memberships.filter(m => m.role.slug === 'MANAGER').length,
        memberCount:    r.memberships.length,
        roleCount:      r.roles.length,
        hasAgentConfig: Boolean(r.agentConfig),
        createdAt:      r.createdAt.toISOString(),
        updatedAt:      r.updatedAt.toISOString(),
      })));
    } catch (e) {
      this.log.error('dept.list.failed', { error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to load departments' });
    }
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  async getDepartmentDetail(
    departmentId: string,
    companyId: string,
    sections?: DeptDetailSection[],
  ): Promise<ServiceResult<DeptDetail>> {
    try {
      const requestedSections = sections && sections.length > 0 ? [...new Set(sections)] : ALL_DEPT_DETAIL_SECTIONS;
      const includeRoles = requestedSections.includes('roles') || requestedSections.includes('members') || requestedSections.includes('permissions');
      const includeMembers = requestedSections.includes('members') || requestedSections.includes('permissions');
      const includePermissions = requestedSections.includes('permissions');
      const includeConfig = requestedSections.includes('config');

      const dept = await this.deps.prisma.department.findFirst({
        where:  { id: departmentId, companyId },
        select: {
          id: true,
          companyId: true,
          name: true,
          slug: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!dept) return fail({ kind: 'not_found', message: 'Department not found' });

      const [agentConfig, roleRows, membershipRows, permissionRows, userOverrideRows, departmentSkillRows, globalSkillRows] = await Promise.all([
        includeConfig
          ? this.deps.prisma.departmentAgentConfig.findUnique({ where: { departmentId } })
          : Promise.resolve(null),
        includeRoles
          ? this.deps.prisma.departmentRole.findMany({
              where: { departmentId },
              orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
            })
          : Promise.resolve([]),
        includeMembers
          ? this.deps.prisma.departmentMembership.findMany({
              where:   { departmentId, status: 'active' },
              include: { role: true, user: { select: { id: true, name: true, email: true } } },
              orderBy: [{ role: { name: 'asc' } }, { createdAt: 'asc' }],
            })
          : Promise.resolve([]),
        includePermissions
          ? this.deps.prisma.departmentToolPermission.findMany({ where: { departmentId } })
          : Promise.resolve([]),
        includePermissions
          ? this.deps.prisma.departmentUserToolOverride.findMany({ where: { departmentId } })
          : Promise.resolve([]),
        includeConfig
          ? this.deps.prisma.skill.findMany({
              where:   { departmentId, status: { not: 'deleted' } },
              orderBy: { sortOrder: 'asc' },
            })
          : Promise.resolve([]),
        includeConfig
          ? this.deps.prisma.skill.findMany({
              where:   { companyId, departmentId: null, status: { not: 'deleted' } },
              orderBy: { sortOrder: 'asc' },
            })
          : Promise.resolve([]),
      ]);

      const mapSkill = (s: { id: string; name: string; slug: string; summary: string; markdown: string; toolIds: string[]; tags: string[]; status: string; scope: string; departmentId: string | null; folderId: string | null }): SkillView => ({
        id: s.id, name: s.name, slug: s.slug, summary: s.summary,
        markdown: s.markdown, toolIds: s.toolIds, tags: s.tags, status: s.status,
        scope: s.scope, departmentId: s.departmentId, folderId: s.folderId,
      });

      return ok({
        loadedSections: requestedSections,
        department: {
          id:          dept.id,
          companyId:   dept.companyId,
          name:        dept.name,
          slug:        dept.slug,
          description: dept.description,
          status:      dept.status,
          createdAt:   dept.createdAt.toISOString(),
          updatedAt:   dept.updatedAt.toISOString(),
        },
        config: {
          systemPrompt:    agentConfig?.systemPrompt ?? '',
          desktopPersonaPrompt: agentConfig?.desktopPersonaPrompt ?? '',
          managerApproval: agentConfig?.managerApprovalJson ?? null,
          isActive:        agentConfig?.isActive ?? true,
        },
        roles: roleRows.map(r => ({
          id:            r.id,
          name:          r.name,
          slug:          r.slug,
          isSystem:      r.isSystem,
          isDefault:     r.isDefault,
          zohoReadScope: r.zohoReadScope,
          createdAt:     r.createdAt.toISOString(),
          updatedAt:     r.updatedAt.toISOString(),
        })),
        memberships: membershipRows.map(m => ({
          id:        m.id,
          userId:    m.userId,
          name:      m.user.name,
          email:     m.user.email,
          roleId:    m.roleId,
          roleSlug:  m.role.slug,
          roleName:  m.role.name,
          status:    m.status,
          createdAt: m.createdAt.toISOString(),
          updatedAt: m.updatedAt.toISOString(),
        })),
        toolPermissions: permissionRows.map(p => ({
          id:          p.id,
          roleId:      p.roleId,
          toolId:      p.toolId,
          actionGroup: p.actionGroup,
          allowed:     p.allowed,
        })),
        userOverrides: userOverrideRows.map(o => ({
          id:          o.id,
          userId:      o.userId,
          toolId:      o.toolId,
          actionGroup: o.actionGroup,
          allowed:     o.allowed,
        })),
        departmentSkills: departmentSkillRows.map(mapSkill),
        globalSkills:     globalSkillRows.map(mapSkill),
        availableTools:   includePermissions
          ? CANONICAL_TOOL_IDS.map(toolId => ({
              toolId,
              supportedActionGroups: [...TOOL_SUPPORTED_ACTIONS[toolId]],
            }))
          : [],
      });
    } catch (e) {
      this.log.error('dept.detail.failed', { departmentId, sections, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to load department detail' });
    }
  }

  // ── Search candidates ─────────────────────────────────────────────────────

  async searchCandidates(
    departmentId: string,
    companyId: string,
    query: string,
  ): Promise<ServiceResult<CandidateSummary[]>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<CandidateSummary[]>;

    try {
      const q = query.trim();
      if (!q) return ok([]);

      const assignedRows = await this.deps.prisma.departmentMembership.findMany({
        where:  { departmentId },
        select: { userId: true },
      });
      const assignedUserIds = new Set(assignedRows.map(r => r.userId));

      const identities = await this.deps.prisma.channelIdentity.findMany({
        where: {
          companyId,
          channel: 'lark',
          OR: [
            { displayName:    { contains: q, mode: 'insensitive' } },
            { email:          { contains: q, mode: 'insensitive' } },
            { externalUserId: { contains: q, mode: 'insensitive' } },
            { larkOpenId:     { contains: q, mode: 'insensitive' } },
            { larkUserId:     { contains: q, mode: 'insensitive' } },
          ],
        },
        take: 40,
      });

      const emails = identities
        .map(i => i.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e));

      const [users, memberships] = await Promise.all([
        emails.length > 0
          ? this.deps.prisma.user.findMany({
              where:  { email: { in: emails, mode: 'insensitive' } },
              select: { id: true, email: true, name: true },
            })
          : Promise.resolve([]),
        emails.length > 0
          ? this.deps.prisma.adminMembership.findMany({
              where:   { companyId, isActive: true, user: { email: { in: emails, mode: 'insensitive' } } },
              include: { user: { select: { id: true, email: true } } },
            })
          : Promise.resolve([]),
      ]);

      const userByEmail = new Map(users.map(u => [u.email.trim().toLowerCase(), u]));
      const memberByEmail = new Map<string, { userId: string; role: string }>();
      for (const m of memberships) {
        const e = m.user.email.trim().toLowerCase();
        if (!memberByEmail.has(e)) memberByEmail.set(e, { userId: m.userId, role: m.role });
      }

      return ok(identities.map(i => {
        const email   = i.email?.trim().toLowerCase();
        const user    = email ? userByEmail.get(email) : undefined;
        const member  = email ? memberByEmail.get(email) : undefined;
        const userId  = member?.userId ?? user?.id;
        return {
          channelIdentityId: i.id,
          userId,
          name:              user?.name ?? i.displayName ?? undefined,
          email:             i.email ?? undefined,
          workspaceRole:     member?.role,
          isWorkspaceMember: Boolean(member),
          isAlreadyAssigned: Boolean(userId && assignedUserIds.has(userId)),
          larkDisplayName:   i.displayName ?? undefined,
          larkUserId:        i.larkUserId ?? undefined,
          larkOpenId:        i.larkOpenId ?? undefined,
          larkSourceRoles:   i.sourceRoles,
        } as CandidateSummary;
      }));
    } catch (e) {
      this.log.error('dept.candidates.failed', { departmentId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to search candidates' });
    }
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createDepartment(
    companyId: string,
    createdBy: string,
    input: { name: string; description?: string | undefined },
  ): Promise<ServiceResult<{ id: string; companyId: string; name: string; slug: string; status: string; managerRoleId: string; memberRoleId: string }>> {
    try {
      const name     = input.name.trim();
      const baseSlug = normalizeSlug(name);
      if (!baseSlug) return fail({ kind: 'validation', message: 'Department slug could not be derived from the name' });

      let slug = baseSlug;
      let suffix = 2;
      while (await this.deps.prisma.department.findFirst({ where: { companyId, slug } })) {
        slug = `${baseSlug}-${suffix++}`;
      }

      const result = await this.deps.prisma.$transaction(async tx => {
        const created = await tx.department.create({
          data: { companyId, name, slug, description: input.description?.trim() || null, status: 'active' },
        });
        const managerRole = await tx.departmentRole.create({
          data: { departmentId: created.id, name: 'Manager', slug: 'MANAGER', isSystem: true, isDefault: false },
        });
        const memberRole = await tx.departmentRole.create({
          data: { departmentId: created.id, name: 'Member',  slug: 'MEMBER',  isSystem: true, isDefault: true },
        });
        await tx.departmentAgentConfig.create({
          data: { departmentId: created.id, systemPrompt: '', isActive: true, createdBy, updatedBy: createdBy },
        });

        // Seed sparse allow rows from MEMBER company defaults for both system roles.
        // Missing rows are denied at runtime; without this seed new depts would lock all tools.
        const grants = memberTemplateGrants();
        if (grants.length > 0) {
          await tx.departmentToolPermission.createMany({
            data: [managerRole.id, memberRole.id].flatMap((roleId) =>
              grants.map((g) => ({
                departmentId: created.id,
                roleId,
                toolId: g.toolId,
                actionGroup: g.actionGroup,
                allowed: true,
                updatedBy: createdBy,
              })),
            ),
          });
        }

        await provisionZohoFinanceSystemSkills(tx, companyId);
        await syncSystemSkillRoutes(tx, companyId);

        return { created, managerRole, memberRole };
      });

      return ok({ id: result.created.id, companyId, name: result.created.name, slug: result.created.slug, status: result.created.status, managerRoleId: result.managerRole.id, memberRoleId: result.memberRole.id });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return fail({ kind: 'conflict', message: 'A department with this name already exists' });
      }
      this.log.error('dept.create.failed', { companyId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to create department' });
    }
  }

  /**
   * Seed MEMBER-template grants for department roles that currently have zero
   * tool-permission rows. Safe to re-run: roles that already have any rows are skipped.
   */
  async backfillEmptyRolePermissions(
    companyId: string,
    updatedBy: string,
    departmentId?: string,
  ): Promise<ServiceResult<{ departmentsTouched: number; rolesSeeded: number; rowsCreated: number }>> {
    try {
      const departments = await this.deps.prisma.department.findMany({
        where: {
          companyId,
          status: 'active',
          ...(departmentId ? { id: departmentId } : {}),
        },
        select: {
          id: true,
          roles: { select: { id: true } },
        },
      });

      const grants = memberTemplateGrants();
      let departmentsTouched = 0;
      let rolesSeeded = 0;
      let rowsCreated = 0;

      for (const dept of departments) {
        let deptTouched = false;
        for (const role of dept.roles) {
          const existing = await this.deps.prisma.departmentToolPermission.count({
            where: { departmentId: dept.id, roleId: role.id },
          });
          if (existing > 0 || grants.length === 0) continue;

          const created = await this.deps.prisma.departmentToolPermission.createMany({
            data: grants.map((g) => ({
              departmentId: dept.id,
              roleId: role.id,
              toolId: g.toolId,
              actionGroup: g.actionGroup,
              allowed: true,
              updatedBy,
            })),
            skipDuplicates: true,
          });
          rolesSeeded += 1;
          rowsCreated += created.count;
          deptTouched = true;
        }
        if (deptTouched) {
          departmentsTouched += 1;
          await this.deps.permissions.invalidateDept(companyId, dept.id);
        }
      }

      this.log.info('dept.permissions.backfill.done', {
        companyId,
        departmentId: departmentId ?? null,
        departmentsTouched,
        rolesSeeded,
        rowsCreated,
      });

      return ok({ departmentsTouched, rolesSeeded, rowsCreated });
    } catch (e) {
      this.log.error('dept.permissions.backfill.failed', { companyId, departmentId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to backfill department permissions' });
    }
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateDepartment(
    departmentId: string,
    companyId: string,
    input: { name?: string | undefined; description?: string | null | undefined; status?: string | undefined },
  ): Promise<ServiceResult<{ id: string; name: string; slug: string; description: string | null; status: string; updatedAt: string }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ id: string; name: string; slug: string; description: string | null; status: string; updatedAt: string }>;

    const existing = check.value;
    try {
      const nextName = input.name?.trim();
      let nextSlug = existing.slug;
      if (nextName && nextName !== existing.name) {
        const base = normalizeSlug(nextName);
        nextSlug = base || existing.slug;
        let suffix = 2;
        while (await this.deps.prisma.department.findFirst({ where: { companyId, slug: nextSlug, id: { not: departmentId } } })) {
          nextSlug = `${base}-${suffix++}`;
        }
      }
      const updated = await this.deps.prisma.department.update({
        where: { id: departmentId },
        data: {
          ...(nextName ? { name: nextName, slug: nextSlug } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
      return ok({ id: updated.id, name: updated.name, slug: updated.slug, description: updated.description, status: updated.status, updatedAt: updated.updatedAt.toISOString() });
    } catch (e) {
      this.log.error('dept.update.failed', { departmentId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to update department' });
    }
  }

  // ── Archive ───────────────────────────────────────────────────────────────

  async archiveDepartment(departmentId: string, companyId: string): Promise<ServiceResult<{ id: string; status: string }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ id: string; status: string }>;
    try {
      const updated = await this.deps.prisma.department.update({ where: { id: departmentId }, data: { status: 'archived' } });
      return ok({ id: updated.id, status: updated.status });
    } catch (e) {
      return fail({ kind: 'internal', message: 'Failed to archive department' });
    }
  }

  // ── Update config ─────────────────────────────────────────────────────────

  async updateConfig(
    departmentId: string,
    companyId: string,
    updatedBy: string,
    input: { systemPrompt: string; desktopPersonaPrompt?: string | undefined; managerApproval?: unknown; isActive?: boolean | undefined },
  ): Promise<ServiceResult<{ departmentId: string; systemPrompt: string; desktopPersonaPrompt: string; isActive: boolean; updatedAt: string }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ departmentId: string; systemPrompt: string; desktopPersonaPrompt: string; isActive: boolean; updatedAt: string }>;
    try {
      const updated = await this.deps.prisma.departmentAgentConfig.upsert({
        where:  { departmentId },
        update: { systemPrompt: input.systemPrompt, ...(input.desktopPersonaPrompt !== undefined ? { desktopPersonaPrompt: input.desktopPersonaPrompt } : {}), ...(input.managerApproval !== undefined ? { managerApprovalJson: input.managerApproval as object } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), updatedBy },
        create: { departmentId, systemPrompt: input.systemPrompt, desktopPersonaPrompt: input.desktopPersonaPrompt ?? '', ...(input.managerApproval !== undefined ? { managerApprovalJson: input.managerApproval as object } : {}), isActive: input.isActive ?? true, createdBy: updatedBy, updatedBy },
      });
      return ok({ departmentId, systemPrompt: updated.systemPrompt, desktopPersonaPrompt: updated.desktopPersonaPrompt, isActive: updated.isActive, updatedAt: updated.updatedAt.toISOString() });
    } catch (e) {
      this.log.error('dept.config.update.failed', { departmentId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to update department config' });
    }
  }

  // ── Role CRUD ─────────────────────────────────────────────────────────────

  async createRole(
    departmentId: string,
    companyId: string,
    input: { name: string; slug: string; zohoReadScope?: string | undefined },
  ): Promise<ServiceResult<{ id: string; name: string; slug: string; zohoReadScope: string }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ id: string; name: string; slug: string; zohoReadScope: string }>;

    const slug = normalizeRoleSlug(input.slug);
    if (!slug || slug === 'MANAGER' || slug === 'MEMBER') {
      return fail({ kind: 'validation', message: 'Choose a unique custom role slug' });
    }
    try {
      const role = await this.deps.prisma.departmentRole.create({
        data: { departmentId, name: input.name.trim(), slug, isSystem: false, isDefault: false, zohoReadScope: input.zohoReadScope === 'show_all' ? 'show_all' : 'personalized' },
      });
      return ok({ id: role.id, name: role.name, slug: role.slug, zohoReadScope: role.zohoReadScope });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return fail({ kind: 'conflict', message: 'Role slug already exists in this department' });
      }
      return fail({ kind: 'internal', message: 'Failed to create role' });
    }
  }

  async updateRole(
    departmentId: string,
    companyId: string,
    roleId: string,
    input: { name: string; isDefault?: boolean | undefined; zohoReadScope?: string | undefined },
  ): Promise<ServiceResult<{ id: string; name: string; slug: string; isDefault: boolean; zohoReadScope: string }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ id: string; name: string; slug: string; isDefault: boolean; zohoReadScope: string }>;

    const existing = await this.deps.prisma.departmentRole.findFirst({ where: { id: roleId, departmentId } });
    if (!existing) return fail({ kind: 'not_found', message: 'Department role not found' });
    const nextName = input.name.trim();
    if (!nextName) return fail({ kind: 'validation', message: 'Role name is required' });

    try {
      const updated = await this.deps.prisma.$transaction(async tx => {
        if (input.isDefault) {
          await tx.departmentRole.updateMany({ where: { departmentId }, data: { isDefault: false } });
        }
        return tx.departmentRole.update({
          where: { id: roleId },
          data:  { name: nextName, ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}), ...(input.zohoReadScope !== undefined ? { zohoReadScope: input.zohoReadScope === 'show_all' ? 'show_all' : 'personalized' } : {}) },
        });
      });
      return ok({ id: updated.id, name: updated.name, slug: updated.slug, isDefault: updated.isDefault, zohoReadScope: updated.zohoReadScope });
    } catch (e) {
      return fail({ kind: 'internal', message: 'Failed to update role' });
    }
  }

  async deleteRole(departmentId: string, companyId: string, roleId: string): Promise<ServiceResult<{ deleted: boolean }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ deleted: boolean }>;

    const existing = await this.deps.prisma.departmentRole.findFirst({ where: { id: roleId, departmentId } });
    if (!existing) return fail({ kind: 'not_found', message: 'Department role not found' });
    if (existing.isSystem)  return fail({ kind: 'validation', message: 'System roles cannot be deleted' });
    if (existing.isDefault) return fail({ kind: 'conflict',   message: 'Choose a different default role before deleting this one' });

    const memberCount = await this.deps.prisma.departmentMembership.count({ where: { roleId, status: 'active' } });
    if (memberCount > 0) return fail({ kind: 'conflict', message: 'Move members off this role before deleting it' });

    try {
      await this.deps.prisma.departmentRole.delete({ where: { id: roleId } });
      return ok({ deleted: true });
    } catch (e) {
      return fail({ kind: 'internal', message: 'Failed to delete role' });
    }
  }

  // ── Membership ────────────────────────────────────────────────────────────

  async upsertMembership(
    departmentId: string,
    companyId: string,
    input: { userId?: string | undefined; channelIdentityId?: string | undefined; roleId?: string | undefined; status?: string | undefined },
  ): Promise<ServiceResult<DeptMembershipView>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<DeptMembershipView>;

    let resolvedUserId = input.userId;
    if (!resolvedUserId && input.channelIdentityId) {
      const identity = await this.deps.prisma.channelIdentity.findFirst({
        where: { id: input.channelIdentityId, companyId, channel: 'lark' },
      });
      if (!identity) return fail({ kind: 'not_found', message: 'Synced Lark user not found' });
      const email = identity.email?.trim().toLowerCase();
      if (!email) return fail({ kind: 'validation', message: 'Lark user has no email — cannot map to a department yet' });
      const user = await this.deps.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      if (!user) return fail({ kind: 'not_found', message: 'No app user found for this Lark identity' });
      resolvedUserId = user.id;
    }
    if (!resolvedUserId) return fail({ kind: 'validation', message: 'userId or channelIdentityId is required' });

    const workspaceMember = await this.deps.prisma.adminMembership.findFirst({ where: { userId: resolvedUserId, companyId, isActive: true } });
    if (!workspaceMember) return fail({ kind: 'validation', message: 'User must be an active workspace member' });

    const role = input.roleId
      ? await this.deps.prisma.departmentRole.findFirst({ where: { id: input.roleId, departmentId } })
      : await this.deps.prisma.departmentRole.findFirst({ where: { departmentId, isDefault: true }, orderBy: { updatedAt: 'desc' } });
    if (!role) return fail({ kind: 'not_found', message: 'Department role not found. Configure a default role first.' });

    try {
      const membership = await this.deps.prisma.departmentMembership.upsert({
        where:  { departmentId_userId: { departmentId, userId: resolvedUserId } },
        update: { roleId: input.roleId ?? role.id, status: input.status ?? 'active' },
        create: { departmentId, userId: resolvedUserId, roleId: role.id, status: input.status ?? 'active' },
        include: { user: { select: { id: true, name: true, email: true } }, role: true },
      });
      await this.deps.permissions.invalidateDept(companyId, departmentId);
      return ok({ id: membership.id, userId: membership.userId, name: membership.user.name, email: membership.user.email, roleId: membership.roleId, roleSlug: membership.role.slug, roleName: membership.role.name, status: membership.status, createdAt: membership.createdAt.toISOString(), updatedAt: membership.updatedAt.toISOString() });
    } catch (e) {
      return fail({ kind: 'internal', message: 'Failed to save membership' });
    }
  }

  async removeMembership(departmentId: string, companyId: string, userId: string): Promise<ServiceResult<{ deleted: boolean }>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<{ deleted: boolean }>;
    try {
      await this.deps.prisma.departmentMembership.delete({ where: { departmentId_userId: { departmentId, userId } } });
      await this.deps.permissions.invalidateDept(companyId, departmentId);
      return ok({ deleted: true });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return fail({ kind: 'not_found', message: 'Membership not found' });
      }
      return fail({ kind: 'internal', message: 'Failed to remove membership' });
    }
  }

  // ── Role permissions ──────────────────────────────────────────────────────

  async updateRolePermission(
    departmentId: string,
    companyId: string,
    roleId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
    updatedBy: string,
  ): Promise<ServiceResult<DeptToolPermView>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<DeptToolPermView>;

    const toolErr = validateToolAndAction(toolId, actionGroup);
    if (toolErr) return fail(toolErr);

    const role = await this.deps.prisma.departmentRole.findFirst({ where: { id: roleId, departmentId } });
    if (!role) return fail({ kind: 'not_found', message: 'Department role not found' });

    try {
      const row = await this.deps.prisma.departmentToolPermission.upsert({
        where:  { departmentId_roleId_toolId_actionGroup: { departmentId, roleId, toolId, actionGroup } },
        update: { allowed, updatedBy },
        create: { departmentId, roleId, toolId, actionGroup, allowed, updatedBy },
      });
      await this.deps.permissions.invalidateDept(companyId, departmentId);
      return ok({ id: row.id, roleId: row.roleId, toolId: row.toolId, actionGroup: row.actionGroup, allowed: row.allowed });
    } catch (e) {
      return fail({ kind: 'internal', message: 'Failed to update role permission' });
    }
  }

  // ── User overrides ────────────────────────────────────────────────────────

  async updateUserOverride(
    departmentId: string,
    companyId: string,
    userId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
    updatedBy: string,
  ): Promise<ServiceResult<DeptUserOverrideView>> {
    const check = await this.assertDepartmentInCompany(departmentId, companyId);
    if (!check.ok) return check as ServiceResult<DeptUserOverrideView>;

    const toolErr = validateToolAndAction(toolId, actionGroup);
    if (toolErr) return fail(toolErr);

    try {
      const row = await this.deps.prisma.departmentUserToolOverride.upsert({
        where:  { departmentId_userId_toolId_actionGroup: { departmentId, userId, toolId, actionGroup } },
        update: { allowed, updatedBy },
        create: { departmentId, userId, toolId, actionGroup, allowed, updatedBy },
      });
      await this.deps.permissions.invalidateDept(companyId, departmentId);
      return ok({ id: row.id, userId: row.userId, toolId: row.toolId, actionGroup: row.actionGroup, allowed: row.allowed });
    } catch (e) {
      return fail({ kind: 'internal', message: 'Failed to update user override' });
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────

  /**
   * Validates that a folder is a legal home for a department-scoped skill:
   * it must exist, live in the same company, be active, and belong to the
   * same department. `null` (root) is always allowed. Mirrors the scope rules
   * enforced by SkillRegistryAdminService.moveSkill.
   */
  // ── Books module permissions ──────────────────────────────────────────────

  async getBookModulePermissions(
    departmentId: string,
    companyId: string,
  ): Promise<ServiceResult<Array<{ id: string; roleId: string; module: string; enabled: boolean }>>> {
    const dept = await this.deps.prisma.department.findFirst({
      where: { id: departmentId, companyId },
    });
    if (!dept) return fail({ kind: 'not_found', message: 'Department not found' });

    const roles = await this.deps.prisma.departmentRole.findMany({
      where: { departmentId },
      select: { id: true },
    });
    const roleIds = roles.map(r => r.id);
    if (roleIds.length === 0) return ok([]);

    const rows = await this.deps.prisma.booksModulePermission.findMany({
      where: { companyId, departmentRoleId: { in: roleIds } },
      select: { id: true, departmentRoleId: true, module: true, enabled: true },
    });

    return ok(rows.map(r => ({
      id: r.id,
      roleId: r.departmentRoleId,
      module: r.module,
      enabled: r.enabled,
    })));
  }

  async updateBookModulePermission(
    departmentId: string,
    companyId: string,
    roleId: string,
    module: string,
    enabled: boolean,
    actorId: string,
  ): Promise<ServiceResult<{ roleId: string; module: string; enabled: boolean }>> {
    const role = await this.deps.prisma.departmentRole.findFirst({
      where: { id: roleId, departmentId },
    });
    if (!role) return fail({ kind: 'not_found', message: 'Role not found in this department' });

    await this.deps.prisma.booksModulePermission.upsert({
      where: {
        companyId_departmentRoleId_module: { companyId, departmentRoleId: roleId, module },
      },
      create: { companyId, departmentRoleId: roleId, module, enabled, updatedBy: actorId },
      update: { enabled, updatedBy: actorId },
    });

    // Books module gates are evaluated at tool runtime; clear dept permission cache
    // so subsequent resolves do not serve a stale allowed-tool snapshot.
    await this.deps.permissions.invalidateDept(companyId, departmentId);

    return ok({ roleId, module, enabled });
  }

  // ── Unused random UUID for invite token ───────────────────────────────────
  static generateToken(): string { return randomUUID(); }
}
