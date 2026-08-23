import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { ChannelKey } from '../../domain/channel/incoming-message';
import {
  surfaceCapabilities,
  type SurfaceAudience,
} from '../../domain/channel/surface-capabilities';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { zohoServicesForScopes } from '../../domain/zoho/zoho-scope';
import type { PermissionService } from '../permissions/permission.service';
import type { SkillCatalogService, CatalogSkill } from '../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../skills/skill-access.port';
import type { ManagerPersonaRuntimeService } from '../persona-learning/manager-persona-runtime.service';
import type { ConnectionRegistryPort } from '../connections/connection-registry.port';
import { getCanonicalPersonalMemorySnapshot } from '../knowledge/knowledge-resource-query.service';
import {
  buildDesktopCapabilityBootstrap,
  isFinanceDepartment,
  type DesktopCapabilityBootstrap,
} from '../desktop/desktop-capability-bootstrap';
import { nativeSkillBinding } from '../skills/native-skill-binding';
import {
  measureRunLatency,
  type RunLatencyTrace,
} from '../observability/run-latency-recorder';
import { createMemberGrantScope } from '../../domain/permissions/member-grant-scope';

const NATIVE_SKILL_LIMIT = 100;
const NATIVE_SKILL_DESCRIPTION_BYTES = 1_024;
const NATIVE_SKILL_INSTRUCTIONS_BYTES = 100_000;
const NATIVE_SKILL_TOTAL_BYTES = 2_000_000;

export interface NativeSkillBootstrap {
  readonly registryRevision: number;
  readonly skills: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly revision: number;
  }[];
}

type LegacyCapabilityBootstrap = Omit<DesktopCapabilityBootstrap, 'version' | 'families'> & {
  readonly version: 2;
};

export interface RuntimeContextSnapshot {
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly personaPrompt: string;
  readonly version: string | null;
  readonly personalMemory: readonly string[];
  readonly surface: ReturnType<typeof surfaceCapabilities>;
  readonly capabilityBootstrap?: DesktopCapabilityBootstrap | LegacyCapabilityBootstrap;
  readonly nativeSkillBootstrap?: NativeSkillBootstrap;
  readonly nativeSkillBinding?: string;
  readonly nativeSkillsUnchanged?: true;
}

export type RuntimeContextLifecycleResult =
  | { readonly kind: 'ready'; readonly snapshot: RuntimeContextSnapshot }
  | {
      readonly kind: 'denied';
      readonly reason: 'department_access_denied' | 'skill_access_denied';
      readonly message: string;
    };

export interface RuntimeContextLifecycleInput {
  readonly userId: string;
  readonly companyId: string;
  readonly companyRole: string;
  readonly channel: ChannelKey;
  /** Trusted from the signed Pi runtime lease when present. */
  readonly audience?: SurfaceAudience;
  readonly departmentId?: string;
  readonly capabilityVersion: 2 | 3;
  /** Present only after the HTTP adapter validates the pinned Pi runtime lease. */
  readonly nativeSkills?: {
    readonly requestedBinding?: string;
  };
  readonly trace?: RunLatencyTrace;
}

export interface RuntimeContextLifecycleDeps {
  readonly prisma: PrismaClient;
  readonly permissions: PermissionService;
  readonly skillCatalog: SkillCatalogService;
  readonly skillAccessEnforcement: SkillAccessEnforcementPort;
  readonly managerPersonaRuntime: ManagerPersonaRuntimeService;
  readonly connectionRegistry: ConnectionRegistryPort;
  readonly logger: Logger;
}

/**
 * Owns the freshness rules for one authenticated Runtime Context read.
 *
 * Native skill content is conditional and session-scoped. Session validity,
 * membership, permissions, skill grants, personal memory, manager persona and
 * connection availability remain fresh inputs on every call. The HTTP adapter
 * validates transport concerns and serializes this module's result.
 */
export class RuntimeContextLifecycle {
  private readonly log: Logger;

  constructor(private readonly deps: RuntimeContextLifecycleDeps) {
    this.log = deps.logger.child({ service: 'runtime-context-lifecycle' });
  }

  async load(input: RuntimeContextLifecycleInput): Promise<RuntimeContextLifecycleResult> {
    const personalMemoryLoad = measureRunLatency(input.trace, {
      name: 'runtime.context.personal-memory',
      category: 'memory',
    }, () => getCanonicalPersonalMemorySnapshot(
      this.deps.prisma,
      {
        userId: input.userId,
        companyId: input.companyId,
        limit: 12,
        maxFactChars: 500,
        maxTotalChars: 2_200,
      },
    )).catch((error: unknown) => {
      this.log.warn('runtime_context.personal_memory_failed', {
        error: String(error),
        userId: input.userId,
        companyId: input.companyId,
      });
      return [];
    });

    if (!input.departmentId) {
      return {
        kind: 'ready',
        snapshot: {
          departmentId: null,
          departmentName: null,
          personaPrompt: '',
          version: null,
          personalMemory: await personalMemoryLoad,
          surface: surfaceCapabilities(input.channel, input.audience),
        },
      };
    }
    const departmentId = input.departmentId;

    const [personalMemory, [memberships, adminMembership]] = await Promise.all([
      personalMemoryLoad,
      measureRunLatency(input.trace, {
        name: 'runtime.context.membership',
        category: 'persistence',
      }, () => Promise.all([
        this.deps.prisma.departmentMembership.findMany({
          where: {
            userId: input.userId,
            status: 'active',
            department: { companyId: input.companyId, status: 'active' },
          },
          select: {
            departmentId: true,
            roleId: true,
            department: {
              select: {
                id: true,
                name: true,
                slug: true,
                agentConfig: {
                  select: {
                    desktopPersonaPrompt: true,
                    isActive: true,
                    updatedAt: true,
                  },
                },
              },
            },
          },
        }),
        this.deps.prisma.adminMembership.findFirst({
          where: {
            userId: input.userId,
            companyId: input.companyId,
            isActive: true,
          },
          select: { role: true },
        }),
      ])),
    ]);
    const membership = memberships.find(candidate => candidate.departmentId === departmentId);

    if (!membership) {
      return {
        kind: 'denied',
        reason: 'department_access_denied',
        message: 'Department access denied',
      };
    }

    const department = membership.department;
    const memberGrantScope = createMemberGrantScope({
      companyId: input.companyId,
      userId: input.userId,
      departmentIds: memberships.map(candidate => candidate.departmentId),
      departmentRoleIds: memberships.map(candidate => candidate.roleId),
      adminRole: adminMembership?.role ?? null,
    });
    const config = department.agentConfig;
    const active = config?.isActive === true;
    const financeDepartment = isFinanceDepartment(department.name, department.slug);

    // All of these inputs are fresh on every turn, but independent once the
    // department membership above is proven. Start them together; awaiting
    // order below expresses data dependencies rather than serial I/O.
    const memberScopeLoad = Promise.all([
      measureRunLatency(input.trace, {
        name: 'runtime.context.permission',
        category: 'authorization',
      }, () => this.deps.permissions.resolve({
        companyId: asCompanyId(input.companyId),
        userId: asUserId(input.userId),
        companyRole: asCompanyRoleSlug(input.companyRole),
        departmentId: asDepartmentId(department.id),
        // This preserves the current governed runtime permission context. The
        // resolver does not currently branch or cache by channel.
        channel: 'lark',
      })),
      measureRunLatency(input.trace, {
        name: 'runtime.context.skill-grants',
        category: 'authorization',
      }, () => this.deps.skillAccessEnforcement.listGrantedSkillIds(
        input.companyId,
        input.userId,
        undefined,
        memberGrantScope,
      )),
      measureRunLatency(input.trace, {
        name: 'runtime.context.registry-revision',
        category: 'persistence',
      }, () => this.deps.skillCatalog.registryRevision(
        input.companyId,
        undefined,
        { failClosed: Boolean(input.nativeSkills) },
      )),
    ]);
    memberScopeLoad.catch(() => undefined);

    const managerPersonaBriefLoad = measureRunLatency(input.trace, {
      name: 'runtime.context.manager-persona',
      category: 'persistence',
    }, () => this.deps.managerPersonaRuntime.getDepartmentBrief({
      companyId: input.companyId,
      departmentId: department.id,
    }));
    managerPersonaBriefLoad.catch(() => undefined);

    const zohoConnectionsLoad = financeDepartment
      ? measureRunLatency(input.trace, {
          name: 'runtime.context.connections',
          category: 'persistence',
        }, () => this.deps.connectionRegistry.listAccessibleZohoConnections({
          userId: input.userId,
          companyId: input.companyId,
          memberGrantScope,
        }))
      : undefined;
    zohoConnectionsLoad?.catch(() => undefined);

    let nativeSkillBootstrap: NativeSkillBootstrap | undefined;
    let currentNativeSkillBinding: string | undefined;
    let nativeSkillsUnchanged = false;
    if (input.nativeSkills) {
      const [permissionResult, grantedSkillIds, registryRevision] = await memberScopeLoad;
      if (!permissionResult.ok) {
        return {
          kind: 'denied',
          reason: 'skill_access_denied',
          message: 'Runtime skill access denied',
        };
      }
      currentNativeSkillBinding = nativeSkillBinding({
        companyId: input.companyId,
        userId: input.userId,
        departmentId: department.id,
        channel: input.channel,
        registryRevision,
        permission: permissionResult.value,
        grantedSkillIds,
      });
      nativeSkillsUnchanged = input.nativeSkills.requestedBinding === currentNativeSkillBinding;
      if (!nativeSkillsUnchanged) {
        nativeSkillBootstrap = await this.loadNativeSkillBootstrap({
          companyId: input.companyId,
          departmentId: department.id,
          registryRevision,
          permission: permissionResult.value,
          grantedSkillIds,
          ...(input.trace ? { trace: input.trace } : {}),
        });
      }
    }

    let managerPersonaPrompt = '';
    let managerPersonaVersion: string | null = null;
    try {
      const brief = await managerPersonaBriefLoad;
      managerPersonaPrompt = brief?.prompt ?? '';
      managerPersonaVersion = brief?.version ?? null;
    } catch (error) {
      this.log.warn('runtime_context.manager_persona_failed', {
        error: String(error),
        userId: input.userId,
        companyId: input.companyId,
        departmentId,
      });
    }

    let capabilityBootstrap: DesktopCapabilityBootstrap | LegacyCapabilityBootstrap | undefined;
    try {
      const [[permissionResult, grantedSkillIds, registryRevision], zohoConnectionsResult] = await Promise.all([
        memberScopeLoad,
        zohoConnectionsLoad ?? Promise.resolve(null),
      ]);
      if (permissionResult.ok) {
        // Native Pi consumes the complete native snapshot. Desktop and other
        // callers retain the compact skill guidance projection.
        const visibleSkills = input.nativeSkills
          ? []
          : await measureRunLatency(input.trace, {
              name: 'runtime.context.capabilities',
              category: 'persistence',
            }, () => this.deps.skillCatalog.listVisible({
              companyId: input.companyId,
              departmentId: department.id,
              permission: permissionResult.value,
              grantedSkillIds,
              limit: 50,
            }));
        const built = buildDesktopCapabilityBootstrap({
          departmentName: department.name,
          departmentSlug: department.slug,
          companyRole: input.companyRole,
          permission: permissionResult.value,
          visibleSkills,
          includeSkillGuidance: !input.nativeSkills,
          registryRevision,
          ...(zohoConnectionsResult?.ok ? {
            zohoConnections: zohoConnectionsResult.value.map(connection => ({
              connectionId: connection.connectionId,
              label: connection.label,
              access: connection.access,
              services: zohoServicesForScopes(connection.scopes),
            })),
          } : {}),
        });
        if (input.capabilityVersion === 3) {
          capabilityBootstrap = built;
        } else {
          const { families, ...legacy } = built;
          void families;
          capabilityBootstrap = { ...legacy, version: 2 };
        }
      }
    } catch (error) {
      this.log.warn('runtime_context.capability_bootstrap_failed', {
        error: String(error),
        userId: input.userId,
        companyId: input.companyId,
        departmentId,
      });
    }

    return {
      kind: 'ready',
      snapshot: {
        departmentId: department.id,
        departmentName: department.name,
        personaPrompt: [
          active ? config.desktopPersonaPrompt : '',
          managerPersonaPrompt,
        ].filter(Boolean).join('\n\n'),
        version: [
          active ? config.updatedAt.toISOString() : null,
          managerPersonaVersion,
        ].filter((value): value is string => Boolean(value)).join('|') || null,
        personalMemory,
        surface: surfaceCapabilities(input.channel, input.audience),
        ...(capabilityBootstrap ? { capabilityBootstrap } : {}),
        ...(nativeSkillBootstrap ? { nativeSkillBootstrap } : {}),
        ...(currentNativeSkillBinding ? { nativeSkillBinding: currentNativeSkillBinding } : {}),
        ...(nativeSkillsUnchanged ? { nativeSkillsUnchanged: true } : {}),
      },
    };
  }

  private async loadNativeSkillBootstrap(input: {
    readonly companyId: string;
    readonly departmentId: string;
    readonly registryRevision: number;
    readonly permission: Parameters<SkillCatalogService['listVisible']>[0]['permission'];
    readonly grantedSkillIds: ReadonlySet<string>;
    readonly trace?: RunLatencyTrace;
  }): Promise<NativeSkillBootstrap> {
    const visibleSkills = await measureRunLatency(input.trace, {
      name: 'runtime.context.native-skills',
      category: 'persistence',
    }, () => this.deps.skillCatalog.listVisible({
      companyId: input.companyId,
      departmentId: input.departmentId,
      permission: input.permission,
      grantedSkillIds: input.grantedSkillIds,
      complete: true,
      failClosed: true,
    }));
    const { skills, omittedSlugs } = boundNativeSkills(visibleSkills);
    if (omittedSlugs.length > 0) {
      this.log.warn('runtime.native_skills.bounded', {
        visibleCount: visibleSkills.length,
        loadedCount: skills.length,
        omittedCount: omittedSlugs.length,
        omittedSlugs: omittedSlugs.slice(0, 20),
      });
    }
    return {
      registryRevision: input.registryRevision,
      skills: skills.map(skill => ({
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        revision: skill.revision,
      })),
    };
  }
}

function boundNativeSkills(skills: readonly CatalogSkill[]): {
  readonly skills: readonly CatalogSkill[];
  readonly omittedSlugs: readonly string[];
} {
  const bounded: CatalogSkill[] = [];
  const omittedSlugs: string[] = [];
  let totalBytes = 0;
  for (const skill of skills) {
    const descriptionBytes = Buffer.byteLength(skill.description, 'utf8');
    const instructionBytes = Buffer.byteLength(skill.instructions, 'utf8');
    if (
      bounded.length >= NATIVE_SKILL_LIMIT
      || descriptionBytes > NATIVE_SKILL_DESCRIPTION_BYTES
      || instructionBytes > NATIVE_SKILL_INSTRUCTIONS_BYTES
      || totalBytes + descriptionBytes + instructionBytes > NATIVE_SKILL_TOTAL_BYTES
    ) {
      omittedSlugs.push(skill.slug);
      continue;
    }
    totalBytes += descriptionBytes + instructionBytes;
    bounded.push(skill);
  }
  return { skills: bounded, omittedSlugs };
}
