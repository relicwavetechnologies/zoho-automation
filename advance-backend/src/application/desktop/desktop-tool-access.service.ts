import type { PrismaClient } from '../../generated/prisma';
import type { PermissionService } from '../permissions/permission.service';
import type { PermissionWriteService } from '../permissions/permission-write.service';
import { CONNECTION_NEEDS_KEY, type IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import { getDesktopToolPolicy } from '../../domain/tools/tool-policy';
import { TOOL_DEFAULT_PERMISSIONS } from '../../domain/tools/tool-id';
import { actionPhrase } from '../../domain/tools/tool-labels';
import type { ToolActionPermissionRepoPort } from '../../infrastructure/persistence/tool-action-permission.repository';
import type { ToolPermissionRepoPort } from '../../infrastructure/persistence/tool-permission.repository';
import type { CompanyRoleRepoPort, CompanyRoleRow } from '../../infrastructure/persistence/company-role.repository';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import type { ToolRegistry } from '../tools/tool-registry';
import type { Logger } from '../../shared/logger';

const COMPANY_ROLES = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'] as const;
const COMPANY_ADMIN_ROLES = new Set<string>(['COMPANY_ADMIN', 'SUPER_ADMIN']);
const DEPARTMENT_RESOLVE_CONCURRENCY = 4;
// These endpoints accept a Lark user_access_token and therefore run through a
// selected Divo-managed Lark connection. Directory and native-approval APIs
// are tenant-token-only according to Lark's API contracts.
const LARK_USER_CONNECTION_TOOL_IDS = new Set([
  'larkMessaging',
  'larkTask',
  'larkCalendar',
  'larkMeeting',
  'larkDoc',
  'larkBase',
]);

type Actor = { userId: string; companyId: string; role: string };
type RegisteredTool = { toolId: string; name: string; description: string; category: string; domain: string; hitlRequired: boolean };

export class DesktopToolAccessService {
  constructor(private readonly deps: {
    prisma: PrismaClient;
    permissions: PermissionService;
    permissionWrites: PermissionWriteService;
    toolActionRepo: ToolActionPermissionRepoPort;
    toolPermRepo: ToolPermissionRepoPort;
    companyRoleRepo: CompanyRoleRepoPort;
    connectionRepo: IntegrationConnectionRepository;
    toolRegistry: ToolRegistry;
    logger: Logger;
  }) {}

  private runtimeHas(toolId: string): boolean {
    return Boolean(this.deps.toolRegistry.byId(toolId as any));
  }

  private cataloguePolicy(toolId: string) {
    const policy = getDesktopToolPolicy(toolId);
    if (!policy) {
      this.deps.logger.error('desktop.tools.catalogue.unclassified_registered_tool', { toolId });
      return null;
    }
    if (!this.runtimeHas(toolId)) {
      this.deps.logger.error('desktop.tools.catalogue.registry_mismatch', { toolId, policyKind: policy.kind });
      return null;
    }
    return policy;
  }

  private async liveCompanyRole(actor: Pick<Actor, 'userId' | 'companyId'>): Promise<string | null> {
    const membership = await this.deps.prisma.adminMembership.findFirst({
      where: { userId: actor.userId, companyId: actor.companyId, isActive: true },
      select: { role: true },
      orderBy: { updatedAt: 'desc' },
    });
    return membership?.role ?? null;
  }

  private async isDepartmentManager(actor: Pick<Actor, 'userId' | 'companyId'>, departmentId: string): Promise<boolean> {
    const membership = await this.deps.prisma.departmentMembership.findFirst({
      where: { userId: actor.userId, departmentId, status: 'active', department: { companyId: actor.companyId, status: 'active' }, role: { slug: 'MANAGER' } },
      select: { id: true },
    });
    return Boolean(membership);
  }

  /**
   * Who may configure one department's tool access.
   *
   * Its manager, and any company admin. The read and write paths drifted apart
   * here: reading a department's coverage allowed either, while opening a tool
   * inside it demanded MANAGER membership — so a company admin who was not
   * personally a manager of Marketing could see it listed and get a 403 on
   * click. One rule, used by every path that governs a department.
   */
  private async canGovernDepartment(
    actor: Pick<Actor, 'userId' | 'companyId'>,
    liveRole: string,
    departmentId: string,
  ): Promise<boolean> {
    if (COMPANY_ADMIN_ROLES.has(liveRole)) return true;
    return this.isDepartmentManager(actor, departmentId);
  }

  private async requireRegisteredConfigurable(toolId: string): Promise<RegisteredTool | null> {
    if (this.cataloguePolicy(toolId)?.kind !== 'configurable') return null;
    return this.deps.prisma.registeredTool.findFirst({
      where: { toolId, deprecated: false },
      select: { toolId: true, name: true, description: true, category: true, domain: true, hitlRequired: true },
    });
  }

  /** Mirrors PermissionService's company tool gate fallback for custom roles. */
  private toolGate(toolId: string, role: string, values: ReadonlyMap<string, boolean>): boolean {
    const explicit = values.get(`${role}:${toolId}`);
    if (explicit !== undefined) return explicit;
    const defaults = TOOL_DEFAULT_PERMISSIONS[toolId as keyof typeof TOOL_DEFAULT_PERMISSIONS];
    return COMPANY_ROLES.includes(role as typeof COMPANY_ROLES[number])
      ? defaults[role as typeof COMPANY_ROLES[number]]
      : defaults.MEMBER;
  }

  private async companyToolGate(companyId: string, toolId: string, role: string): Promise<boolean> {
    const rows = await this.deps.toolPermRepo.getForCompany(companyId);
    if (!rows.ok) throw new DesktopToolAccessError('internal');
    const values = new Map(rows.value.filter(row => row.toolId === toolId).map(row => [`${row.role}:${row.toolId}`, row.enabled]));
    return this.toolGate(toolId, role, values);
  }

  private async companyRoles(companyId: string): Promise<CompanyRoleRow[]> {
    const result = await this.deps.companyRoleRepo.listByCompany(companyId);
    if (!result.ok) throw new DesktopToolAccessError('internal');
    const bySlug = new Map(result.value.map(role => [role.slug, role]));
    for (const role of COMPANY_ROLES) {
      if (!bySlug.has(role)) bySlug.set(role, {
        id: role,
        companyId,
        slug: role,
        displayName: role.replace(/_/g, ' '),
        isBuiltIn: true,
      });
    }
    return [...bySlug.values()];
  }

  async inventory(actor: Actor) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole) throw new DesktopToolAccessError('forbidden');
    const [registered, memberships, google, canva, zoho, lark, airtable, aitable] = await Promise.all([
      this.deps.prisma.registeredTool.findMany({
        where: { deprecated: false },
        select: { toolId: true, name: true, description: true, category: true, domain: true, hitlRequired: true },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      }),
      this.deps.prisma.departmentMembership.findMany({
        where: { userId: actor.userId, status: 'active', department: { companyId: actor.companyId, status: 'active' } },
        select: { departmentId: true, department: { select: { name: true } }, role: { select: { slug: true } } },
        orderBy: { department: { name: 'asc' } },
      }),
      this.deps.connectionRepo.listAccessibleGoogleConnections({ companyId: actor.companyId, userId: actor.userId }),
      this.deps.connectionRepo.listAccessibleCanvaConnections({ companyId: actor.companyId, userId: actor.userId }),
      this.deps.connectionRepo.listAccessibleZohoConnections({ companyId: actor.companyId, userId: actor.userId }),
      this.deps.connectionRepo.listAccessibleLarkConnections({ companyId: actor.companyId, userId: actor.userId }),
      this.deps.connectionRepo.listAccessibleAirtableConnections({ companyId: actor.companyId, userId: actor.userId }),
      this.deps.connectionRepo.listAccessibleAitableConnections({ companyId: actor.companyId, userId: actor.userId }),
    ]);
    const companyResult = await this.deps.permissions.resolve({ companyId: asCompanyId(actor.companyId), userId: asUserId(actor.userId), companyRole: liveRole as any, channel: 'desktop' });
    if (!companyResult.ok) throw new DesktopToolAccessError('internal');
    const departmentResults = await orderedConcurrent(memberships, DEPARTMENT_RESOLVE_CONCURRENCY, async membership => ({
      membership,
      result: await this.deps.permissions.resolve({
        companyId: asCompanyId(actor.companyId), userId: asUserId(actor.userId), companyRole: liveRole as any, departmentId: asDepartmentId(membership.departmentId), channel: 'desktop',
      }),
    }));
    if (departmentResults.some(({ result }) => !result.ok)) throw new DesktopToolAccessError('internal');

    const googleReady = google.ok && google.value.length > 0;
    const canvaReady = canva.ok && canva.value.length > 0;
    const zohoReady = zoho.ok && zoho.value.length > 0;
    const larkReady = lark.ok && lark.value.length > 0;
    const airtableReady = airtable.ok && airtable.value.length > 0;
    // A connection whose API key was regenerated upstream is listed but cannot
    // serve a call, so it must not count towards readiness — otherwise the
    // screen reports "ready" for a tool that fails on its next use.
    const aitableReady = aitable.ok && aitable.value.some(connection => connection.status !== CONNECTION_NEEDS_KEY);
    const canManageGlobal = COMPANY_ADMIN_ROLES.has(liveRole);
    const managedDepartments = new Set(memberships.filter(m => m.role.slug === 'MANAGER').map(m => m.departmentId));
    // A company admin governs every department, not only the ones they happen
    // to be a MANAGER of. Building this list from the actor's own memberships
    // meant an admin who was a manager of Finance and nothing else could not
    // see — let alone configure — Marketing or Sales at all.
    const manageableDepartments = canManageGlobal
      ? await this.deps.prisma.department.findMany({
        where: { companyId: actor.companyId, status: 'active' },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
      : memberships
        .filter(m => managedDepartments.has(m.departmentId))
        .map(m => ({ id: m.departmentId, name: m.department.name }));

    const tools: Array<{ tool: RegisteredTool; origins: unknown[]; managementScopes: unknown[]; readiness: string }> = [];
    for (const tool of registered) {
      const policy = this.cataloguePolicy(tool.toolId);
      if (!policy) continue;
      if (policy.kind === 'local') { tools.push({ tool, origins: [{ kind: 'local', reason: policy.reason }], managementScopes: [], readiness: 'not_applicable' }); continue; }
      if (policy.kind === 'system') { tools.push({ tool, origins: [{ kind: 'system', allowedActions: policy.supportedActions, reason: policy.reason }], managementScopes: [], readiness: 'not_applicable' }); continue; }

      const globalActions = [...(companyResult.value.allowedActionsByTool.get(tool.toolId as any) ?? [])];
      const departmentOrigins = departmentResults.flatMap(({ membership, result }) =>
        result.ok && (result.value.allowedActionsByTool.get(tool.toolId as any)?.size ?? 0) > 0
          ? [{ kind: 'department' as const, department: { id: membership.departmentId, name: membership.department.name }, allowedActions: [...(result.value.allowedActionsByTool.get(tool.toolId as any) ?? [])] }]
          : [],
      );
      const managementScopes = [
        ...(canManageGlobal ? [{ kind: 'global' as const, label: 'Global' as const }] : []),
        ...manageableDepartments.map(department => ({ kind: 'department' as const, department })),
      ];
      if (globalActions.length === 0 && departmentOrigins.length === 0 && managementScopes.length === 0) continue;
      const readiness = tool.toolId.startsWith('google')
        ? (googleReady ? 'ready' : 'connection_required')
        : tool.toolId.startsWith('canva')
          ? (canvaReady ? 'ready' : 'connection_required')
        : tool.toolId.startsWith('zoho')
          ? (zohoReady ? 'ready' : canManageGlobal ? 'connection_required' : 'admin_connection_required')
        : tool.toolId.startsWith('airtable')
          ? (airtableReady ? 'ready' : 'connection_required')
        // Distinct from the branch above by one character, which is exactly why
        // the AITable tool IDs were named for datasheets and fields rather than
        // records and schema.
        : tool.toolId.startsWith('aitable')
          ? (aitableReady ? 'ready' : 'connection_required')
        : tool.toolId.startsWith('lark')
            ? (LARK_USER_CONNECTION_TOOL_IDS.has(tool.toolId)
              ? (larkReady ? 'ready' : 'connection_required')
              : 'ready')
          : 'not_applicable';
      tools.push({
        tool,
        origins: [...(globalActions.length ? [{ kind: 'global' as const, allowedActions: globalActions }] : []), ...departmentOrigins],
        managementScopes,
        readiness,
      });
    }
    return { tools };
  }

  async snapshot(actor: Actor, toolId: string, scope: { kind: 'global' } | { kind: 'department'; departmentId: string }) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole) throw new DesktopToolAccessError('forbidden');
    const tool = await this.requireRegisteredConfigurable(toolId);
    if (!tool) throw new DesktopToolAccessError('invalid');
    const policy = getDesktopToolPolicy(toolId)!;
    if (scope.kind === 'global') {
      if (!COMPANY_ADMIN_ROLES.has(liveRole)) throw new DesktopToolAccessError('forbidden');
      const [actionRows, toolRows, companyRoles] = await Promise.all([
        this.deps.toolActionRepo.getForCompany(actor.companyId),
        this.deps.toolPermRepo.getForCompany(actor.companyId),
        this.companyRoles(actor.companyId),
      ]);
      if (!actionRows.ok || !toolRows.ok) throw new DesktopToolAccessError('internal');
      const actionValues = new Map(actionRows.value.filter(row => row.toolId === toolId).map(row => [`${row.role}:${row.actionGroup}`, row.enabled]));
      const toolValues = new Map(toolRows.value.filter(row => row.toolId === toolId).map(row => [`${row.role}:${row.toolId}`, row.enabled]));
      return {
        tool, scope: { kind: 'global' as const, label: 'Global' as const }, supportedActions: policy.kind === 'configurable' ? policy.supportedActions : [],
        actionLabels: Object.fromEntries((policy.kind === 'configurable' ? policy.supportedActions : []).map(action => [action, actionPhrase(toolId, action)])),
        roles: companyRoles.map(roleDefinition => {
          const role = roleDefinition.slug;
          const toolEnabled = this.toolGate(toolId, role, toolValues);
          return { role, actions: (policy.kind === 'configurable' ? policy.supportedActions : []).map(actionGroup => {
            const actionKey = `${role}:${actionGroup}`;
            const storedAllowed = actionValues.get(actionKey) ?? true;
            return {
              actionGroup,
              effectiveAllowed: toolEnabled && storedAllowed,
              storedAllowed,
              storedProvenance: actionValues.has(actionKey) ? 'override' as const : 'default' as const,
              clampReason: toolEnabled ? null : 'company_tool_disabled' as const,
            };
          }) };
        }),
      };
    }
    if (!await this.canGovernDepartment(actor, liveRole, scope.departmentId)) throw new DesktopToolAccessError('forbidden');
    const department = await this.deps.prisma.department.findFirst({ where: { id: scope.departmentId, companyId: actor.companyId, status: 'active' }, select: { id: true, name: true } });
    if (!department) throw new DesktopToolAccessError('forbidden');
    const [roles, members, roleRows, overrideRows, companyActionRows, companyToolRows] = await Promise.all([
      this.deps.prisma.departmentRole.findMany({ where: { departmentId: department.id }, select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }),
      this.deps.prisma.departmentMembership.findMany({ where: { departmentId: department.id, status: 'active' }, select: { userId: true, user: { select: { name: true, email: true } }, roleId: true }, orderBy: { user: { email: 'asc' } } }),
      this.deps.prisma.departmentToolPermission.findMany({ where: { departmentId: department.id, toolId }, select: { roleId: true, actionGroup: true, allowed: true } }),
      this.deps.prisma.departmentUserToolOverride.findMany({ where: { departmentId: department.id, toolId }, select: { userId: true, actionGroup: true, allowed: true } }),
      this.deps.toolActionRepo.getForCompany(actor.companyId),
      this.deps.toolPermRepo.getForCompany(actor.companyId),
    ]);
    if (!companyActionRows.ok || !companyToolRows.ok) throw new DesktopToolAccessError('internal');
    const companyActionValues = new Map(companyActionRows.value.filter(row => row.toolId === toolId).map(row => [`${row.role}:${row.actionGroup}`, row.enabled]));
    const companyToolValues = new Map(companyToolRows.value.filter(row => row.toolId === toolId).map(row => [`${row.role}:${row.toolId}`, row.enabled]));
    const supportedActions = policy.kind === 'configurable' ? policy.supportedActions : [];
    const overrideValues = new Map(overrideRows.map(row => [`${row.userId}:${row.actionGroup}`, row.allowed]));
    const roleActionValues = new Map(roleRows.map(row => [`${row.roleId}:${row.actionGroup}`, row.allowed]));
    const memberAccess = await orderedConcurrent(members, DEPARTMENT_RESOLVE_CONCURRENCY, async member => {
      const companyRole = await this.liveCompanyRole({ userId: member.userId, companyId: actor.companyId });
      // A department membership without an active company membership cannot be
      // a desktop tool candidate. Do not present a guessed access state.
      if (!companyRole) return null;
      const resolved = await this.deps.permissions.resolve({
        companyId: asCompanyId(actor.companyId),
        userId: asUserId(member.userId),
        companyRole: companyRole as any,
        departmentId: asDepartmentId(department.id),
        channel: 'desktop',
      });
      if (!resolved.ok) throw new DesktopToolAccessError('internal');
      const allowedActions = resolved.value.allowedActionsByTool.get(toolId as any);
      const companyToolEnabled = this.toolGate(toolId, companyRole, companyToolValues);
      return {
        member,
        companyRole,
        actions: supportedActions.map(actionGroup => {
          const overrideKey = `${member.userId}:${actionGroup}`;
          const roleKey = `${member.roleId}:${actionGroup}`;
          const configuredAllowed = overrideValues.has(overrideKey)
            ? overrideValues.get(overrideKey)!
            : roleActionValues.get(roleKey) ?? false;
          const configuredProvenance = overrideValues.has(overrideKey)
            ? 'member_override' as const
            : roleActionValues.has(roleKey) ? 'department_role' as const : 'default' as const;
          const effectiveAllowed = Boolean(allowedActions?.has(actionGroup as any));
          const companyActionEnabled = companyActionValues.get(`${companyRole}:${actionGroup}`) ?? true;
          return {
            userId: member.userId,
            actionGroup,
            configuredAllowed,
            configuredProvenance,
            effectiveAllowed,
            effectiveBlockReason: !effectiveAllowed && !companyToolEnabled
              ? 'company_tool_disabled' as const
              : !effectiveAllowed && configuredAllowed && !companyActionEnabled
                ? 'company_action_disabled' as const : null,
            storedOverride: overrideValues.get(overrideKey) ?? null,
            provenance: overrideValues.has(overrideKey) ? 'override' as const : 'inherited' as const,
          };
        }),
      };
    });
    const activeMembers = memberAccess.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const roleActionStates = roles.flatMap(role => {
      const roleMembers = activeMembers.filter(entry => entry.member.roleId === role.id);
      return supportedActions.map(actionGroup => {
        const configuredAllowed = roleActionValues.get(`${role.id}:${actionGroup}`) ?? false;
        const companyPolicyStatus = roleMembers.length === 0
          ? 'no_active_members' as const
          : roleMembers.every(entry => !this.toolGate(toolId, entry.companyRole as typeof COMPANY_ROLES[number], companyToolValues))
            ? 'company_tool_blocks_all_current_members' as const
            : roleMembers.every(entry => {
                const toolEnabled = this.toolGate(toolId, entry.companyRole as typeof COMPANY_ROLES[number], companyToolValues);
                const actionEnabled = companyActionValues.get(`${entry.companyRole}:${actionGroup}`) ?? true;
                return !toolEnabled || !actionEnabled;
              })
              ? 'company_action_blocks_all_current_members' as const
              : 'company_policy_allows_some_current_members' as const;
        return {
          roleId: role.id,
          actionGroup,
          configuredAllowed,
          configuredProvenance: roleActionValues.has(`${role.id}:${actionGroup}`) ? 'department_role' as const : 'default' as const,
          companyPolicyStatus,
        };
      });
    });
    return {
      tool, scope: { kind: 'department' as const, department }, supportedActions,
      actionLabels: Object.fromEntries(supportedActions.map(action => [action, actionPhrase(toolId, action)])),
      roles, members: activeMembers.map(({ member }) => ({ userId: member.userId, name: member.user.name, email: member.user.email, roleId: member.roleId })),
      roleActions: roleRows, memberOverrides: overrideRows,
      memberActionStates: activeMembers.flatMap(({ actions }) => actions),
      roleActionStates,
      companyCeiling: COMPANY_ROLES.map(role => ({
        role,
        actions: this.toolGate(toolId, role, companyToolValues)
          ? supportedActions.filter(action => companyActionValues.get(`${role}:${action}`) ?? true)
          : [],
      })),
    };
  }

  /**
   * Every tool's configured reach in one department, in one round trip.
   *
   * The tools list needs to answer "who can use this" for a whole catalogue at
   * once, and `snapshot()` is far too heavy for that — it resolves permissions
   * per member per tool. This reads the department's grant rows directly and
   * counts, so a 30-tool catalogue costs a handful of queries instead of a
   * hundred. It reports what a manager *configured*, and separately whether the
   * company ceiling is holding any of it down, because those are the two facts
   * a manager needs before deciding to open a tool.
   */
  async coverage(actor: Actor, departmentId: string) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole) throw new DesktopToolAccessError('forbidden');
    if (!await this.canGovernDepartment(actor, liveRole, departmentId)) throw new DesktopToolAccessError('forbidden');
    const department = await this.deps.prisma.department.findFirst({
      where: { id: departmentId, companyId: actor.companyId, status: 'active' },
      select: { id: true, name: true },
    });
    if (!department) throw new DesktopToolAccessError('forbidden');

    const [registered, members, roleRows, overrideRows, companyActionRows, companyToolRows, agentConfig] = await Promise.all([
      this.deps.prisma.registeredTool.findMany({
        where: { deprecated: false },
        select: { toolId: true, name: true, description: true, category: true, domain: true, hitlRequired: true },
      }),
      this.deps.prisma.departmentMembership.findMany({
        where: { departmentId: department.id, status: 'active' },
        select: { userId: true, roleId: true },
      }),
      this.deps.prisma.departmentToolPermission.findMany({
        where: { departmentId: department.id, allowed: true },
        select: { toolId: true, roleId: true, actionGroup: true },
      }),
      this.deps.prisma.departmentUserToolOverride.findMany({
        where: { departmentId: department.id },
        select: { toolId: true, userId: true, actionGroup: true, allowed: true },
      }),
      this.deps.toolActionRepo.getForCompany(actor.companyId),
      this.deps.toolPermRepo.getForCompany(actor.companyId),
      this.deps.prisma.departmentAgentConfig.findUnique({
        where: { departmentId: department.id },
        select: { managerApprovalJson: true },
      }),
    ]);
    if (!companyActionRows.ok || !companyToolRows.ok) throw new DesktopToolAccessError('internal');

    const companyActionValues = new Map(companyActionRows.value.map(row => [`${row.toolId}:${row.role}:${row.actionGroup}`, row.enabled]));
    const companyToolValues = new Map(companyToolRows.value.map(row => [`${row.role}:${row.toolId}`, row.enabled]));
    const grantedByTool = groupBy(roleRows, row => row.toolId);
    const overridesByTool = groupBy(overrideRows, row => row.toolId);
    const approvalByTool = approvalActionsByTool(agentConfig?.managerApprovalJson);

    const tools = registered.flatMap(tool => {
      const policy = this.cataloguePolicy(tool.toolId);
      if (policy?.kind !== 'configurable') return [];
      const supportedActions = policy.supportedActions;
      const grants = grantedByTool.get(tool.toolId) ?? [];
      const overrides = overridesByTool.get(tool.toolId) ?? [];

      const grantedByRole = new Map<string, Set<string>>();
      for (const grant of grants) {
        const set = grantedByRole.get(grant.roleId) ?? new Set<string>();
        set.add(grant.actionGroup);
        grantedByRole.set(grant.roleId, set);
      }
      const overrideByUser = new Map<string, Map<string, boolean>>();
      for (const override of overrides) {
        const map = overrideByUser.get(override.userId) ?? new Map<string, boolean>();
        map.set(override.actionGroup, override.allowed);
        overrideByUser.set(override.userId, map);
      }

      const peopleWithAccess = members.filter(member => supportedActions.some(action => {
        const override = overrideByUser.get(member.userId)?.get(action);
        return override ?? Boolean(grantedByRole.get(member.roleId)?.has(action));
      })).length;

      // The ceiling as it applies to an ordinary member; a company admin's own
      // reach is never what a manager is trying to read off this row.
      const memberToolEnabled = this.toolGate(tool.toolId, 'MEMBER', companyToolValues);
      const blockedActions = supportedActions.filter(action => !memberToolEnabled
        || !(companyActionValues.get(`${tool.toolId}:MEMBER:${action}`) ?? true));

      return [{
        tool,
        supportedActions,
        // Phrased on the backend so a switch, an approval card and the tools
        // list all call the same action by the same name.
        actionLabels: Object.fromEntries(supportedActions.map(action => [action, actionPhrase(tool.toolId, action)])),
        actionsGranted: supportedActions.filter(action => [...grantedByRole.values()].some(set => set.has(action))),
        approvalActions: (approvalByTool.get(tool.toolId) ?? []).filter(action => supportedActions.includes(action)),
        peopleWithAccess,
        blockedActions,
        exceptionCount: overrideByUser.size,
      }];
    });

    return { department, totalPeople: members.length, tools };
  }

  async setGlobal(actor: Actor, toolId: string, role: string, actionGroup: string, enabled: boolean) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole || !COMPANY_ADMIN_ROLES.has(liveRole)) throw new DesktopToolAccessError('forbidden');
    if (!await this.requireRegisteredConfigurable(toolId)) throw new DesktopToolAccessError('invalid');
    const roles = await this.companyRoles(actor.companyId);
    if (!roles.some(candidate => candidate.slug === role)) throw new DesktopToolAccessError('invalid');
    if (!await this.companyToolGate(actor.companyId, toolId, role)) throw new DesktopToolAccessError('invalid');
    const result = await this.deps.permissionWrites.setCompanyAction({
      companyId: actor.companyId, actorId: actor.userId, toolId, role, actionGroup, enabled,
      revalidate: async () => {
        const currentRole = await this.liveCompanyRole(actor);
        if (!currentRole || !COMPANY_ADMIN_ROLES.has(currentRole)) return false;
        const currentRoles = await this.companyRoles(actor.companyId);
        return currentRoles.some(candidate => candidate.slug === role)
          && await this.companyToolGate(actor.companyId, toolId, role);
      },
    });
    if (!result.ok) throw new DesktopToolAccessError(result.reason === 'invalid' ? 'invalid' : 'internal');
    return this.snapshot({ ...actor, role: liveRole }, toolId, { kind: 'global' });
  }

  async setDepartmentRole(actor: Actor, toolId: string, departmentId: string, roleId: string, actionGroup: string, allowed: boolean) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole) throw new DesktopToolAccessError('forbidden');
    if (!await this.canGovernDepartment(actor, liveRole, departmentId)) throw new DesktopToolAccessError('forbidden');
    if (!await this.requireRegisteredConfigurable(toolId)) throw new DesktopToolAccessError('invalid');
    const target = await this.deps.prisma.departmentRole.findFirst({ where: { id: roleId, departmentId }, select: { id: true } });
    if (!target) throw new DesktopToolAccessError('forbidden');
    const result = await this.deps.permissionWrites.setDepartmentRoleAction({
      companyId: actor.companyId, departmentId, actorId: actor.userId, toolId, roleId, actionGroup, allowed,
      // Re-checked against live state at write time, so a role or membership
      // revoked mid-request cannot land the change.
      revalidate: async () => {
        const role = await this.liveCompanyRole(actor);
        return Boolean(role)
          && await this.canGovernDepartment(actor, role!, departmentId)
          && Boolean(await this.deps.prisma.departmentRole.findFirst({ where: { id: roleId, departmentId }, select: { id: true } }));
      },
    });
    if (!result.ok) throw new DesktopToolAccessError(result.reason === 'invalid' ? 'invalid' : 'internal');
    return this.snapshot(actor, toolId, { kind: 'department', departmentId });
  }

  async setDepartmentMember(actor: Actor, toolId: string, departmentId: string, userId: string, actionGroup: string, allowed: boolean) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole) throw new DesktopToolAccessError('forbidden');
    if (!await this.canGovernDepartment(actor, liveRole, departmentId)) throw new DesktopToolAccessError('forbidden');
    if (!await this.requireRegisteredConfigurable(toolId)) throw new DesktopToolAccessError('invalid');
    const target = await this.deps.prisma.departmentMembership.findFirst({ where: { departmentId, userId, status: 'active', department: { companyId: actor.companyId, status: 'active' } }, select: { id: true } });
    if (!target) throw new DesktopToolAccessError('forbidden');
    const result = await this.deps.permissionWrites.setDepartmentMemberAction({
      companyId: actor.companyId, departmentId, actorId: actor.userId, userId, toolId, actionGroup, allowed,
      revalidate: async () => {
        const role = await this.liveCompanyRole(actor);
        return Boolean(role)
          && await this.canGovernDepartment(actor, role!, departmentId)
          && Boolean(await this.deps.prisma.departmentMembership.findFirst({
            where: { departmentId, userId, status: 'active', department: { companyId: actor.companyId, status: 'active' } },
            select: { id: true },
          }));
      },
    });
    if (!result.ok) throw new DesktopToolAccessError(result.reason === 'invalid' ? 'invalid' : 'internal');
    return this.snapshot(actor, toolId, { kind: 'department', departmentId });
  }

  /**
   * Removes one person's exception, returning them to their role.
   *
   * Guarded exactly like setting one: lifting an exception is as much a
   * permission change as imposing it, and on a deny it *widens* access.
   */
  async clearDepartmentMember(actor: Actor, toolId: string, departmentId: string, userId: string, actionGroup: string) {
    const liveRole = await this.liveCompanyRole(actor);
    if (!liveRole) throw new DesktopToolAccessError('forbidden');
    if (!await this.canGovernDepartment(actor, liveRole, departmentId)) throw new DesktopToolAccessError('forbidden');
    if (!await this.requireRegisteredConfigurable(toolId)) throw new DesktopToolAccessError('invalid');
    const target = await this.deps.prisma.departmentMembership.findFirst({ where: { departmentId, userId, status: 'active', department: { companyId: actor.companyId, status: 'active' } }, select: { id: true } });
    if (!target) throw new DesktopToolAccessError('forbidden');
    const result = await this.deps.permissionWrites.clearDepartmentMemberAction({
      companyId: actor.companyId, departmentId, actorId: actor.userId, userId, toolId, actionGroup,
      revalidate: async () => {
        const role = await this.liveCompanyRole(actor);
        return Boolean(role)
          && await this.canGovernDepartment(actor, role!, departmentId)
          && Boolean(await this.deps.prisma.departmentMembership.findFirst({
            where: { departmentId, userId, status: 'active', department: { companyId: actor.companyId, status: 'active' } },
            select: { id: true },
          }));
      },
    });
    if (!result.ok) throw new DesktopToolAccessError(result.reason === 'invalid' ? 'invalid' : 'internal');
    return this.snapshot(actor, toolId, { kind: 'department', departmentId });
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket) bucket.push(item);
    else grouped.set(key(item), [item]);
  }
  return grouped;
}

/**
 * Which actions a department gates behind manager approval, per tool.
 * `requiredActionGroups` is the flat form — an action group gated for every
 * tool — so it has to be folded in per tool rather than read as a tool list.
 */
function approvalActionsByTool(managerApprovalJson: unknown): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  if (typeof managerApprovalJson !== 'object' || managerApprovalJson === null) return byTool;
  const config = managerApprovalJson as Record<string, unknown>;
  if (config['enabled'] !== true) return byTool;

  const required = Array.isArray(config['requiredActions']) ? config['requiredActions'] : [];
  for (const entry of required) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const toolId = typeof record['toolId'] === 'string' ? record['toolId'] : null;
    const actions = Array.isArray(record['actions']) ? record['actions'].filter((a): a is string => typeof a === 'string') : [];
    if (!toolId || !actions.length) continue;
    byTool.set(toolId, [...new Set([...(byTool.get(toolId) ?? []), ...actions])]);
  }
  return byTool;
}

export class DesktopToolAccessError extends Error {
  constructor(readonly code: 'forbidden' | 'invalid' | 'internal') { super(code); }
}

/** Preserves source membership order while avoiding an unbounded DB/cache fan-out. */
async function orderedConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
