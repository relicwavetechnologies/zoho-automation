import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

/**
 * Skill Registry admin service — the write/read model behind the Skills Lab
 * admin area. Company-scoped (callers pass the resolved companyId; route-level
 * auth guarantees a company admin only ever passes their own).
 *
 * Owns the SkillFolder tree: create / rename / move / archive folders and move
 * skills between them. All authorization and validation is server-side; the UI
 * never decides placement or access.
 *
 * Folders are one of two kinds, and the two never mix in a single subtree:
 *   • company-wide  → departmentId = null and scope = `company`
 *   • department    → departmentId = <id>  (holds that department's skills)
 */

// ── Result ────────────────────────────────────────────────────────────────────
export type RegistryErrorKind =
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'forbidden'
  | 'internal';
export interface RegistryError {
  readonly kind: RegistryErrorKind;
  readonly message: string;
}
export type ServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RegistryError };

const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = <T>(error: RegistryError): ServiceResult<T> => ({ ok: false, error });

// ── Scope helpers ─────────────────────────────────────────────────────────────
// `company` is the governed knowledge scope. `global` remains a read-compatible
// legacy/system-skill scope until those rows are migrated; both are company-wide
// for registry placement and grant validation.
const COMPANY_WIDE_SCOPES = ['company', 'global'] as const;
const isCompanyWideScope = (scope: string): boolean =>
  (COMPANY_WIDE_SCOPES as readonly string[]).includes(scope);

const SHARED_FOLDER_NAME = 'Shared';
const DEPARTMENT_STARTER_FOLDER_NAME = 'General';

const normalizeSlug = (v: string): string =>
  v
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

// ── DTOs ──────────────────────────────────────────────────────────────────────
export interface SkillNodeDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly summary: string;
  readonly toolIds: string[];
  readonly tags: string[];
  readonly status: string;
  readonly scope: string;
  readonly departmentId: string | null;
  readonly folderId: string | null;
  readonly isSystem: boolean;
  readonly revision: number;
  readonly updatedAt: string;
  /**
   * How many grants this skill has.
   *
   * Zero is the one that matters: the skill exists, appears in the library, and
   * cannot be run by anybody. The tree carries it so a screen can say so
   * without asking per skill.
   */
  readonly grantCount: number;
}
export interface FolderNodeDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly departmentId: string | null;
  readonly parentId: string | null;
  readonly status: string;
  readonly children: FolderNodeDto[];
  readonly skills: SkillNodeDto[];
}
export interface RegistryRootDto {
  readonly folders: FolderNodeDto[];
  readonly skills: SkillNodeDto[]; // loose skills at this root (folderId = null)
}
export interface RegistryTreeDto {
  readonly registryRevision: number;
  readonly companyWide: RegistryRootDto;
  readonly departments: (RegistryRootDto & { id: string; name: string })[];
}

export interface SkillDetailDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: string[];
  readonly tags: string[];
  readonly aliases: string[];
  readonly status: string;
  readonly scope: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly folderId: string | null;
  readonly folderPath: string[]; // root → leaf folder names, e.g. ['General', 'Ops']
  readonly isSystem: boolean;
  readonly revision: number;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillAuditEntryDto {
  readonly id: string;
  readonly action: string;
  readonly actorId: string;
  readonly outcome: string;
  readonly metadata: unknown;
  readonly createdAt: string;
}

// Polymorphic grantee, mirroring IntegrationConnectionGrant.
export type GranteeType = 'user' | 'department' | 'role' | 'company';
const GRANTEE_TYPES: readonly GranteeType[] = ['user', 'department', 'role', 'company'];
const isGranteeType = (v: string): v is GranteeType =>
  (GRANTEE_TYPES as readonly string[]).includes(v);

export interface GranteeCandidateDto {
  readonly granteeId: string;
  readonly label: string;
  readonly detail: string | null;
}
export interface SkillGrantDto {
  readonly granteeType: GranteeType;
  readonly granteeId: string;
  readonly label: string;
  readonly detail: string | null;
  readonly grantedBy: string | null;
  readonly createdAt: string;
}
/**
 * Per-skill RBAC view. Deny-by-default: only grantees in `grants` may use the
 * skill. `candidates` are eligible-but-not-yet-granted grantees for the admin's
 * "Manage access" picker, bucketed by type.
 */
export interface SkillAccessDto {
  readonly skillId: string;
  readonly scope: string;
  readonly departmentId: string | null;
  readonly grants: SkillGrantDto[];
  readonly candidates: {
    readonly users: GranteeCandidateDto[];
    readonly departments: GranteeCandidateDto[];
    readonly roles: GranteeCandidateDto[];
    readonly company: GranteeCandidateDto | null;
  };
}

// Audit actions that reference a specific skill (by metadata.skillId or
// metadata.skillIds). Folder events are registry-level and excluded here.
const SKILL_AUDIT_ACTIONS = [
  'gateway.skill.get',
  'gateway.skill.search',
  'skill.archive',
  'skill.move',
] as const;

// ── Row shapes (internal) ───────────────────────────────────────────────────
type FolderRow = {
  id: string;
  name: string;
  slug: string;
  departmentId: string | null;
  parentId: string | null;
  status: string;
};
type SkillRow = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  toolIds: string[];
  tags: string[];
  status: string;
  scope: string;
  departmentId: string | null;
  folderId: string | null;
  isSystem: boolean;
  revision: number;
  updatedAt: Date;
};

export interface SkillRegistryAdminServiceDeps {
  prisma: PrismaClient;
  logger: Logger;
}

export class SkillRegistryAdminService {
  constructor(private readonly deps: SkillRegistryAdminServiceDeps) {}

  private get db() {
    return this.deps.prisma;
  }

  // ── Read: the full tree ──────────────────────────────────────────────────
  async getTree(
    companyId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<ServiceResult<RegistryTreeDto>> {
    try {
      const folderStatus = opts.includeArchived ? undefined : 'active';
      const skillStatusIn = opts.includeArchived ? undefined : 'active';

      /*
       * How many people or groups each skill is shared with, counted once for
       * the whole library.
       *
       * A skill nobody has been granted exists but can never run, and that was
       * only discoverable by opening each skill's Access tab in turn — a
       * hundred skills, a hundred clicks, to find the handful that are dead.
       * One grouped count answers it for every skill at once, so this stays a
       * fixed number of queries rather than one per skill.
       *
       * Counted across the company rather than filtered to the visible tree:
       * the group-by is cheaper than assembling an id list, and skills outside
       * the tree simply never get looked up.
       */
      const [folders, skills, departments, registry, grantCounts] = await Promise.all([
        this.db.skillFolder.findMany({
          where: { companyId, ...(folderStatus ? { status: folderStatus } : {}) },
          select: { id: true, name: true, slug: true, departmentId: true, parentId: true, status: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.db.skill.findMany({
          where: {
            companyId,
            scope: { not: 'personal' },
            ...(skillStatusIn ? { status: skillStatusIn } : {}),
          },
          select: SKILL_SELECT,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.db.department.findMany({
          where: { companyId, status: 'active' },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.db.skillRegistryRevision.findUnique({
          where: { companyId },
          select: { revision: true },
        }),
        this.db.skillAccessGrant.groupBy({
          by: ['skillId'],
          where: { companyId },
          _count: { skillId: true },
        }),
      ]);

      const grantsBySkill = new Map(
        grantCounts.map((row) => [row.skillId, row._count.skillId] as const),
      );

      const tree = buildTree(folders, skills, departments, registry?.revision ?? 1, grantsBySkill);
      return ok(tree);
    } catch (e) {
      this.deps.logger.error('skill_registry.tree.failed', { companyId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to load skill registry tree' });
    }
  }

  // ── Read: a single skill's detail (fields + aliases + folder path) ───────
  async getSkillDetail(
    companyId: string,
    skillId: string,
  ): Promise<ServiceResult<SkillDetailDto>> {
    try {
      const skill = await this.db.skill.findFirst({
        where: { id: skillId, companyId, scope: { not: 'personal' } },
        select: {
          ...SKILL_SELECT,
          markdown: true,
          createdBy: true,
          updatedBy: true,
          createdAt: true,
          department: { select: { name: true } },
          aliases: { select: { alias: true }, orderBy: { alias: 'asc' } },
        },
      });
      if (!skill) return fail({ kind: 'not_found', message: 'Skill not found' });

      let folderPath: string[] = [];
      if (skill.folderId) {
        const folders = await this.db.skillFolder.findMany({
          where: { companyId },
          select: { id: true, name: true, parentId: true },
        });
        folderPath = buildFolderPath(folders, skill.folderId);
      }

      return ok({
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        summary: skill.summary,
        markdown: skill.markdown,
        toolIds: skill.toolIds,
        tags: skill.tags,
        aliases: skill.aliases.map((a) => a.alias),
        status: skill.status,
        scope: skill.scope,
        departmentId: skill.departmentId,
        departmentName: skill.department?.name ?? null,
        folderId: skill.folderId,
        folderPath,
        isSystem: skill.isSystem,
        revision: skill.revision,
        createdBy: skill.createdBy,
        updatedBy: skill.updatedBy,
        createdAt: skill.createdAt.toISOString(),
        updatedAt: skill.updatedAt.toISOString(),
      });
    } catch (e) {
      this.deps.logger.error('skill_registry.skill.detail.failed', { companyId, skillId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to load skill detail' });
    }
  }

  // ── Read: audit trail for a skill (gateway + registry events) ────────────
  async getSkillAudit(
    companyId: string,
    skillId: string,
    opts: { limit?: number } = {},
  ): Promise<ServiceResult<SkillAuditEntryDto[]>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skill = await this.db.skill.findFirst({
      where: { id: skillId, companyId, scope: { not: 'personal' } },
      select: { id: true },
    });
    if (!skill) return fail({ kind: 'not_found', message: 'Skill not found' });

    try {
      // Read a recent window of skill-scoped events, then keep only those that
      // reference this skill. JS filtering avoids brittle JSON-path queries and
      // transparently handles both metadata.skillId and metadata.skillIds[].
      const rows = await this.db.auditLog.findMany({
        where: { companyId, action: { in: [...SKILL_AUDIT_ACTIONS] } },
        orderBy: { createdAt: 'desc' },
        take: 300,
        select: { id: true, action: true, actorId: true, outcome: true, metadata: true, createdAt: true },
      });

      const entries = rows
        .filter((r) => auditRefsSkill(r.metadata, skillId))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          action: r.action,
          actorId: r.actorId,
          outcome: r.outcome,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
        }));
      return ok(entries);
    } catch (e) {
      this.deps.logger.error('skill_registry.skill.audit.failed', { companyId, skillId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to load skill audit trail' });
    }
  }

  // ── Read: per-skill RBAC (explicit grants, deny-by-default) ──────────────
  // Only grantees with an explicit SkillAccessGrant may use the skill. Returns
  // current grants (resolved to labels) plus eligible-but-ungranted grantees
  // bucketed by type for the "Manage access" picker.
  async getSkillAccess(
    companyId: string,
    skillId: string,
  ): Promise<ServiceResult<SkillAccessDto>> {
    const skill = await this.db.skill.findFirst({
      where: { id: skillId, companyId, scope: { not: 'personal' } },
      select: { id: true, scope: true, departmentId: true },
    });
    if (!skill) return fail({ kind: 'not_found', message: 'Skill not found' });

    try {
      const eligibleDeptIds = await this.eligibleDepartmentIds(companyId, skill);

      const [company, departments, roles, members, grantRows] = await Promise.all([
        this.db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } }),
        eligibleDeptIds.length > 0
          ? this.db.department.findMany({
              where: { id: { in: eligibleDeptIds } },
              select: { id: true, name: true },
              orderBy: { name: 'asc' },
            })
          : Promise.resolve([] as { id: string; name: string }[]),
        eligibleDeptIds.length > 0
          ? this.db.departmentRole.findMany({
              where: { departmentId: { in: eligibleDeptIds } },
              select: { id: true, name: true, department: { select: { name: true } } },
              orderBy: [{ department: { name: 'asc' } }, { isSystem: 'desc' }, { name: 'asc' }],
            })
          : Promise.resolve([] as { id: string; name: string; department: { name: string } | null }[]),
        this.db.adminMembership.findMany({
          where: { companyId, isActive: true },
          select: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { user: { email: 'asc' } },
        }),
        this.db.skillAccessGrant.findMany({
          where: { skillId, companyId },
          select: { granteeType: true, granteeId: true, grantedBy: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      // Resolver maps for labelling grants.
      const deptById = new Map(departments.map((d) => [d.id, d] as const));
      const roleById = new Map(roles.map((r) => [r.id, r] as const));
      const userById = new Map(members.map((m) => [m.user.id, m.user] as const));

      const label = (t: string, id: string): { label: string; detail: string | null } => {
        if (t === 'company') return { label: company?.name ?? 'Whole company', detail: 'Whole company' };
        if (t === 'department') { const d = deptById.get(id); return { label: d?.name ?? id, detail: 'Department' }; }
        if (t === 'role') { const r = roleById.get(id); return { label: r?.name ?? id, detail: r?.department?.name ?? 'Role' }; }
        const u = userById.get(id); return { label: u?.name || u?.email || id, detail: u?.email ?? 'User' };
      };

      const grants: SkillGrantDto[] = grantRows.map((g) => ({
        granteeType: isGranteeType(g.granteeType) ? g.granteeType : 'user',
        granteeId: g.granteeId,
        ...label(g.granteeType, g.granteeId),
        grantedBy: g.grantedBy,
        createdAt: g.createdAt.toISOString(),
      }));

      const grantedKeys = new Set(grantRows.map((g) => `${g.granteeType}:${g.granteeId}`));
      const ungranted = (t: GranteeType, id: string) => !grantedKeys.has(`${t}:${id}`);

      const candidates = {
        users: members
          .filter((m) => ungranted('user', m.user.id))
          .map((m) => ({ granteeId: m.user.id, label: m.user.name || m.user.email, detail: m.user.email })),
        departments: departments
          .filter((d) => ungranted('department', d.id))
          .map((d) => ({ granteeId: d.id, label: d.name, detail: 'Department' })),
        roles: roles
          .filter((r) => ungranted('role', r.id))
          .map((r) => ({ granteeId: r.id, label: r.name, detail: r.department?.name ?? null })),
        company:
          company && ungranted('company', company.id)
            ? { granteeId: company.id, label: company.name, detail: 'Everyone in the company' }
            : null,
      };

      return ok({ skillId, scope: skill.scope, departmentId: skill.departmentId, grants, candidates });
    } catch (e) {
      this.deps.logger.error('skill_registry.skill.access.failed', { companyId, skillId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to load skill access' });
    }
  }

  // ── Grant a skill to a grantee (user / department / role / company) ──────
  async grantSkillAccess(
    companyId: string,
    skillId: string,
    granteeType: GranteeType,
    granteeId: string,
    grantedBy: string,
  ): Promise<ServiceResult<SkillGrantDto>> {
    const skill = await this.db.skill.findFirst({
      where: { id: skillId, companyId, scope: { not: 'personal' } },
      select: { id: true, scope: true, departmentId: true, knowledgeResourceId: true },
    });
    if (!skill) return fail({ kind: 'not_found', message: 'Skill not found' });
    if (skill.knowledgeResourceId) {
      return fail({
        kind: 'conflict',
        message: 'Governed skill access is derived from its approved knowledge scope and cannot be changed directly.',
      });
    }

    const resolved = await this.validateGrantee(companyId, skill, granteeType, granteeId);
    if (!resolved.ok) return resolved as ServiceResult<SkillGrantDto>;

    try {
      const grant = await this.db.skillAccessGrant.upsert({
        where: { skillId_granteeType_granteeId: { skillId, granteeType, granteeId } },
        create: { companyId, skillId, granteeType, granteeId, grantedBy },
        update: {}, // idempotent — an existing grant stays as-is
        select: { grantedBy: true, createdAt: true },
      });
      return ok({
        granteeType,
        granteeId,
        label: resolved.value.label,
        detail: resolved.value.detail,
        grantedBy: grant.grantedBy,
        createdAt: grant.createdAt.toISOString(),
      });
    } catch (e) {
      this.deps.logger.error('skill_registry.skill.grant.failed', { companyId, skillId, granteeType, granteeId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to grant skill access' });
    }
  }

  // ── Revoke a skill grant ─────────────────────────────────────────────────
  async revokeSkillAccess(
    companyId: string,
    skillId: string,
    granteeType: GranteeType,
    granteeId: string,
  ): Promise<ServiceResult<{ skillId: string; granteeType: GranteeType; granteeId: string }>> {
    const skill = await this.db.skill.findFirst({
      where: { id: skillId, companyId, scope: { not: 'personal' } },
      select: { id: true, knowledgeResourceId: true },
    });
    if (!skill) return fail({ kind: 'not_found', message: 'Skill not found' });
    if (skill.knowledgeResourceId) {
      return fail({
        kind: 'conflict',
        message: 'Governed skill access is derived from its approved knowledge scope and cannot be changed directly.',
      });
    }

    try {
      await this.db.skillAccessGrant.deleteMany({ where: { skillId, granteeType, granteeId, companyId } });
      return ok({ skillId, granteeType, granteeId });
    } catch (e) {
      this.deps.logger.error('skill_registry.skill.revoke.failed', { companyId, skillId, granteeType, granteeId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to revoke skill access' });
    }
  }

  /** Validate a grantee exists, is in the company, and is eligible for this skill. */
  private async validateGrantee(
    companyId: string,
    skill: { scope: string; departmentId: string | null },
    granteeType: GranteeType,
    granteeId: string,
  ): Promise<ServiceResult<{ label: string; detail: string | null }>> {
    const deptScoped = !isCompanyWideScope(skill.scope);

    switch (granteeType) {
      case 'company': {
        if (granteeId !== companyId) return fail({ kind: 'validation', message: 'Invalid company grantee' });
        const company = await this.db.company.findUnique({ where: { id: companyId }, select: { name: true } });
        if (!company) return fail({ kind: 'not_found', message: 'Company not found' });
        return ok({ label: company.name, detail: 'Whole company' });
      }
      case 'department': {
        const dept = await this.db.department.findFirst({
          where: { id: granteeId, companyId, status: 'active' },
          select: { id: true, name: true },
        });
        if (!dept) return fail({ kind: 'not_found', message: 'Department not found' });
        if (deptScoped && dept.id !== skill.departmentId) {
          return fail({ kind: 'validation', message: 'A department skill can only be shared with its own department' });
        }
        return ok({ label: dept.name, detail: 'Department' });
      }
      case 'role': {
        const role = await this.db.departmentRole.findFirst({
          where: { id: granteeId, department: { companyId } },
          select: { name: true, departmentId: true, department: { select: { name: true } } },
        });
        if (!role) return fail({ kind: 'not_found', message: 'Role not found' });
        if (deptScoped && role.departmentId !== skill.departmentId) {
          return fail({ kind: 'validation', message: "A department skill can only be shared with its own department's roles" });
        }
        return ok({ label: role.name, detail: role.department?.name ?? null });
      }
      case 'user': {
        const membership = await this.db.adminMembership.findFirst({
          where: { userId: granteeId, companyId, isActive: true },
          select: { user: { select: { name: true, email: true } } },
        });
        if (!membership) return fail({ kind: 'not_found', message: 'User is not a member of this company' });
        return ok({ label: membership.user.name || membership.user.email, detail: membership.user.email });
      }
      default:
        return fail({ kind: 'validation', message: 'Unknown grantee type' });
    }
  }

  /** Departments whose roles/members are eligible to hold a grant for this skill. */
  private async eligibleDepartmentIds(
    companyId: string,
    skill: { scope: string; departmentId: string | null },
  ): Promise<string[]> {
    if (isCompanyWideScope(skill.scope)) {
      const depts = await this.db.department.findMany({
        where: { companyId, status: 'active' },
        select: { id: true },
      });
      return depts.map((d) => d.id);
    }
    return skill.departmentId ? [skill.departmentId] : [];
  }

  // ── Create folder ────────────────────────────────────────────────────────
  async createFolder(
    companyId: string,
    createdBy: string,
    input: { name: string; parentId?: string | null; departmentId?: string | null },
  ): Promise<ServiceResult<FolderRow>> {
    const name = input.name.trim();
    if (!name) return fail({ kind: 'validation', message: 'Folder name is required' });
    const slug = normalizeSlug(name);
    if (!slug) return fail({ kind: 'validation', message: 'Folder slug could not be derived from the name' });

    const departmentId = input.parentId ? undefined : (input.departmentId ?? null);

    try {
      // Placement is defined by the parent when present; otherwise by departmentId.
      let effectiveDepartmentId: string | null;
      const parentId = input.parentId ?? null;

      if (parentId) {
        const parent = await this.db.skillFolder.findFirst({
          where: { id: parentId, companyId, status: 'active' },
          select: { departmentId: true },
        });
        if (!parent) return fail({ kind: 'not_found', message: 'Parent folder not found' });
        effectiveDepartmentId = parent.departmentId;
      } else {
        effectiveDepartmentId = departmentId ?? null;
        if (effectiveDepartmentId) {
          const dept = await this.db.department.findFirst({
            where: { id: effectiveDepartmentId, companyId, status: 'active' },
            select: { id: true },
          });
          if (!dept) return fail({ kind: 'not_found', message: 'Department not found' });
        }
      }

      const dup = await this.siblingSlugClash(companyId, effectiveDepartmentId, parentId, slug, null);
      if (dup) return fail({ kind: 'conflict', message: 'A folder with this name already exists here' });

      const row = await this.db.skillFolder.create({
        data: {
          companyId,
          departmentId: effectiveDepartmentId,
          parentId,
          name,
          slug,
          createdBy,
          updatedBy: createdBy,
        },
        select: FOLDER_SELECT,
      });
      return ok(row);
    } catch (e) {
      this.deps.logger.error('skill_registry.folder.create.failed', { companyId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to create folder' });
    }
  }

  // ── Rename folder ────────────────────────────────────────────────────────
  async renameFolder(
    companyId: string,
    folderId: string,
    updatedBy: string,
    input: { name: string },
  ): Promise<ServiceResult<FolderRow>> {
    const name = input.name.trim();
    if (!name) return fail({ kind: 'validation', message: 'Folder name is required' });
    const slug = normalizeSlug(name);
    if (!slug) return fail({ kind: 'validation', message: 'Folder slug could not be derived from the name' });

    const folder = await this.db.skillFolder.findFirst({
      where: { id: folderId, companyId },
      select: { id: true, departmentId: true, parentId: true },
    });
    if (!folder) return fail({ kind: 'not_found', message: 'Folder not found' });

    try {
      const dup = await this.siblingSlugClash(companyId, folder.departmentId, folder.parentId, slug, folderId);
      if (dup) return fail({ kind: 'conflict', message: 'A folder with this name already exists here' });

      const row = await this.db.skillFolder.update({
        where: { id: folderId },
        data: { name, slug, updatedBy },
        select: FOLDER_SELECT,
      });
      return ok(row);
    } catch (e) {
      this.deps.logger.error('skill_registry.folder.rename.failed', { companyId, folderId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to rename folder' });
    }
  }

  // ── Move folder ──────────────────────────────────────────────────────────
  async moveFolder(
    companyId: string,
    folderId: string,
    updatedBy: string,
    input: { parentId?: string | null },
  ): Promise<ServiceResult<FolderRow>> {
    const parentId = input.parentId ?? null;
    if (parentId === folderId) return fail({ kind: 'validation', message: 'A folder cannot be moved into itself' });

    const folder = await this.db.skillFolder.findFirst({
      where: { id: folderId, companyId },
      select: { id: true, slug: true, departmentId: true, parentId: true },
    });
    if (!folder) return fail({ kind: 'not_found', message: 'Folder not found' });

    try {
      let effectiveDepartmentId = folder.departmentId;
      if (parentId) {
        const parent = await this.db.skillFolder.findFirst({
          where: { id: parentId, companyId, status: 'active' },
          select: { id: true, departmentId: true },
        });
        if (!parent) return fail({ kind: 'not_found', message: 'Target folder not found' });
        // Moving across the company-wide / department boundary would strand
        // skills whose scope no longer matches the tree they sit in.
        if (parent.departmentId !== folder.departmentId) {
          return fail({ kind: 'validation', message: 'A folder cannot move between company-wide and department scopes' });
        }
        effectiveDepartmentId = parent.departmentId;

        // Reject a move into the folder's own subtree.
        const all = await this.db.skillFolder.findMany({
          where: { companyId, departmentId: folder.departmentId },
          select: { id: true, parentId: true },
        });
        if (isDescendant(all, folderId, parentId)) {
          return fail({ kind: 'validation', message: 'A folder cannot be moved into its own subtree' });
        }
      }

      const dup = await this.siblingSlugClash(companyId, effectiveDepartmentId, parentId, folder.slug, folderId);
      if (dup) return fail({ kind: 'conflict', message: 'A folder with this name already exists at the destination' });

      const row = await this.db.skillFolder.update({
        where: { id: folderId },
        data: { parentId, updatedBy },
        select: FOLDER_SELECT,
      });
      return ok(row);
    } catch (e) {
      this.deps.logger.error('skill_registry.folder.move.failed', { companyId, folderId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to move folder' });
    }
  }

  // ── Archive folder (cascades to child folders; detaches skills to root) ──
  async archiveFolder(
    companyId: string,
    folderId: string,
    updatedBy: string,
  ): Promise<ServiceResult<{ archivedFolders: number; detachedSkills: number }>> {
    const folder = await this.db.skillFolder.findFirst({
      where: { id: folderId, companyId },
      select: { id: true, departmentId: true },
    });
    if (!folder) return fail({ kind: 'not_found', message: 'Folder not found' });

    try {
      const all = await this.db.skillFolder.findMany({
        where: { companyId, departmentId: folder.departmentId },
        select: { id: true, parentId: true },
      });
      const subtree = collectSubtree(all, folderId); // includes folderId itself

      const result = await this.db.$transaction(async (tx) => {
        // Skills in the archived subtree fall back to the department/company root.
        const detached = await tx.skill.updateMany({
          where: { companyId, folderId: { in: subtree } },
          data: { folderId: null },
        });
        const archived = await tx.skillFolder.updateMany({
          where: { companyId, id: { in: subtree }, status: 'active' },
          data: { status: 'archived', updatedBy },
        });
        return { archivedFolders: archived.count, detachedSkills: detached.count };
      });
      return ok(result);
    } catch (e) {
      this.deps.logger.error('skill_registry.folder.archive.failed', { companyId, folderId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to archive folder' });
    }
  }

  // ── Move a skill into a folder (or to the root when folderId is null) ────
  async moveSkill(
    companyId: string,
    skillId: string,
    updatedBy: string,
    input: { folderId: string | null },
  ): Promise<ServiceResult<{ skillId: string; folderId: string | null }>> {
    const skill = await this.db.skill.findFirst({
      where: { id: skillId, companyId, scope: { not: 'personal' } },
      select: { id: true, scope: true, departmentId: true },
    });
    if (!skill) return fail({ kind: 'not_found', message: 'Skill not found' });

    try {
      if (input.folderId) {
        const folder = await this.db.skillFolder.findFirst({
          where: { id: input.folderId, companyId, status: 'active' },
          select: { id: true, departmentId: true },
        });
        if (!folder) return fail({ kind: 'not_found', message: 'Target folder not found' });

        const skillIsCompanyWide = isCompanyWideScope(skill.scope);
        if (skillIsCompanyWide && folder.departmentId !== null) {
          return fail({ kind: 'validation', message: 'A company-wide skill can only live in a company-wide folder' });
        }
        if (!skillIsCompanyWide && folder.departmentId !== skill.departmentId) {
          return fail({ kind: 'validation', message: "A department skill can only live in its own department's folder" });
        }
      }

      await this.db.skill.update({
        where: { id: skillId },
        data: { folderId: input.folderId },
      });
      return ok({ skillId, folderId: input.folderId });
    } catch (e) {
      this.deps.logger.error('skill_registry.skill.move.failed', { companyId, skillId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to move skill' });
    }
  }

  // ── Backfill: organize existing skills into starter folders ──────────────
  // Idempotent. Creates a "Shared" root for company-wide skills and one
  // "General" root per department, then drops each still-loose skill into the
  // matching root. Re-running only fills gaps.
  async backfillFolders(
    companyId: string,
    createdBy: string,
  ): Promise<ServiceResult<{ foldersCreated: number; skillsPlaced: number }>> {
    try {
      const result = await this.db.$transaction(async (tx) => {
        let foldersCreated = 0;
        let skillsPlaced = 0;

        const ensureRoot = async (departmentId: string | null, name: string): Promise<string> => {
          const slug = normalizeSlug(name);
          const existing = await tx.skillFolder.findFirst({
            where: { companyId, departmentId, parentId: null, slug, status: 'active' },
            select: { id: true },
          });
          if (existing) return existing.id;
          const created = await tx.skillFolder.create({
            data: { companyId, departmentId, parentId: null, name, slug, createdBy, updatedBy: createdBy },
            select: { id: true },
          });
          foldersCreated += 1;
          return created.id;
        };

        // Company-wide → "Shared".
        const sharedId = await ensureRoot(null, SHARED_FOLDER_NAME);
        const companyWide = await tx.skill.updateMany({
          where: { companyId, folderId: null, scope: { in: [...COMPANY_WIDE_SCOPES] } },
          data: { folderId: sharedId },
        });
        skillsPlaced += companyWide.count;

        // One "General" root per department with loose skills.
        const departments = await tx.department.findMany({
          where: { companyId, status: 'active' },
          select: { id: true },
        });
        for (const dept of departments) {
          const generalId = await ensureRoot(dept.id, DEPARTMENT_STARTER_FOLDER_NAME);
          const placed = await tx.skill.updateMany({
            where: { companyId, departmentId: dept.id, folderId: null, scope: 'department' },
            data: { folderId: generalId },
          });
          skillsPlaced += placed.count;
        }

        return { foldersCreated, skillsPlaced };
      });
      return ok(result);
    } catch (e) {
      this.deps.logger.error('skill_registry.backfill.failed', { companyId, error: String(e) });
      return fail({ kind: 'internal', message: 'Failed to backfill skill folders' });
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────
  private async siblingSlugClash(
    companyId: string,
    departmentId: string | null,
    parentId: string | null,
    slug: string,
    excludeId: string | null,
  ): Promise<boolean> {
    const clash = await this.db.skillFolder.findFirst({
      where: {
        companyId,
        departmentId,
        parentId,
        slug,
        status: 'active',
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    return Boolean(clash);
  }
}

// ── Selects ───────────────────────────────────────────────────────────────
const FOLDER_SELECT = {
  id: true,
  name: true,
  slug: true,
  departmentId: true,
  parentId: true,
  status: true,
} as const;

const SKILL_SELECT = {
  id: true,
  name: true,
  slug: true,
  summary: true,
  toolIds: true,
  tags: true,
  status: true,
  scope: true,
  departmentId: true,
  folderId: true,
  isSystem: true,
  revision: true,
  updatedAt: true,
} satisfies Prisma.SkillSelect;

// ── Pure tree helpers (exported for tests) ──────────────────────────────────
export function isDescendant(
  folders: { id: string; parentId: string | null }[],
  ancestorId: string,
  candidateId: string,
): boolean {
  const byId = new Map(folders.map((f) => [f.id, f.parentId] as const));
  let cur: string | null | undefined = candidateId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break; // defensive: broken data must not loop forever
    seen.add(cur);
    cur = byId.get(cur) ?? null;
  }
  return false;
}

export function collectSubtree(
  folders: { id: string; parentId: string | null }[],
  rootId: string,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const arr = childrenOf.get(f.parentId) ?? [];
    arr.push(f.id);
    childrenOf.set(f.parentId, arr);
  }
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return out;
}

/** Root → leaf folder names for a folder, following parentId. Cycle-safe. */
export function buildFolderPath(
  folders: { id: string; name: string; parentId: string | null }[],
  folderId: string,
): string[] {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = folderId;
  while (cur) {
    if (seen.has(cur)) break; // defensive: broken data must not loop forever
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    chain.push(node.name);
    cur = node.parentId;
  }
  return chain.reverse();
}

/** True when an audit row's metadata references this skill by id. */
export function auditRefsSkill(metadata: unknown, skillId: string): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const meta = metadata as Record<string, unknown>;
  if (meta['skillId'] === skillId) return true;
  const ids = meta['skillIds'];
  return Array.isArray(ids) && ids.includes(skillId);
}

function toSkillDto(s: SkillRow, grantCount = 0): SkillNodeDto {
  return {
    grantCount,
    id: s.id,
    name: s.name,
    slug: s.slug,
    summary: s.summary,
    toolIds: s.toolIds,
    tags: s.tags,
    status: s.status,
    scope: s.scope,
    departmentId: s.departmentId,
    folderId: s.folderId,
    isSystem: s.isSystem,
    revision: s.revision,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function buildTree(
  folders: FolderRow[],
  skills: SkillRow[],
  departments: { id: string; name: string }[],
  registryRevision: number,
  /*
   * Grants per skill. Optional so the existing callers and tests that build a
   * tree without access data keep working — an absent map means every skill
   * reports zero, which is what the tree said before this existed.
   */
  grantsBySkill: ReadonlyMap<string, number> = new Map(),
): RegistryTreeDto {
  const folderIds = new Set(folders.map((f) => f.id));
  // Skills whose folder was archived/removed render at their scope root.
  const skillsByFolder = new Map<string, SkillNodeDto[]>();
  const looseByDepartment = new Map<string | null, SkillNodeDto[]>();

  for (const s of skills) {
    const dto = toSkillDto(s, grantsBySkill.get(s.id) ?? 0);
    const parkedInFolder = s.folderId && folderIds.has(s.folderId);
    if (parkedInFolder) {
      const arr = skillsByFolder.get(s.folderId as string) ?? [];
      arr.push(dto);
      skillsByFolder.set(s.folderId as string, arr);
    } else {
      const key = isCompanyWideScope(s.scope) ? null : s.departmentId;
      const arr = looseByDepartment.get(key) ?? [];
      arr.push(dto);
      looseByDepartment.set(key, arr);
    }
  }

  const childrenOf = new Map<string | null, FolderRow[]>();
  for (const f of folders) {
    const arr = childrenOf.get(f.parentId) ?? [];
    arr.push(f);
    childrenOf.set(f.parentId, arr);
  }

  const buildFolder = (f: FolderRow): FolderNodeDto => ({
    id: f.id,
    name: f.name,
    slug: f.slug,
    departmentId: f.departmentId,
    parentId: f.parentId,
    status: f.status,
    skills: skillsByFolder.get(f.id) ?? [],
    children: (childrenOf.get(f.id) ?? []).map(buildFolder),
  });

  // Root folders (parentId null) grouped by departmentId.
  const rootFolders = childrenOf.get(null) ?? [];
  const companyWideFolders = rootFolders.filter((f) => f.departmentId === null).map(buildFolder);
  const deptRootFolders = new Map<string, FolderNodeDto[]>();
  for (const f of rootFolders) {
    if (f.departmentId === null) continue;
    const arr = deptRootFolders.get(f.departmentId) ?? [];
    arr.push(buildFolder(f));
    deptRootFolders.set(f.departmentId, arr);
  }

  return {
    registryRevision,
    companyWide: {
      folders: companyWideFolders,
      skills: looseByDepartment.get(null) ?? [],
    },
    departments: departments.map((d) => ({
      id: d.id,
      name: d.name,
      folders: deptRootFolders.get(d.id) ?? [],
      skills: looseByDepartment.get(d.id) ?? [],
    })),
  };
}
