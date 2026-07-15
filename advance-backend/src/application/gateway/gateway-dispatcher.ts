import type { ToolRegistry } from '../orchestration/tools/tool-registry';
import type { PermissionService } from '../permissions/permission.service';
import type { SkillCatalogService } from '../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../skills/skill-access.port';
import type { Logger } from '../../shared/logger';
import { asCompanyId, asDepartmentId, asToolId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { PermissionResult } from '../permissions/permission.types';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { ToolExecutor } from './tool-executor';
import type { LocalApprovalIntentService } from './local-approval-intent.service';
import { mediaImageOcrPayloadSchema, type MediaOcrService } from './media-ocr.service';
import type { ConnectionRegistryPort } from '../connections/connection-registry.port';
import type { AuditService } from '../observability/audit.service';
import type {
  GatewayMemberContext,
  GatewayRequest,
  GatewayResponse,
} from './gateway.types';
import {
  gatewayFailure,
  gatewaySuccess,
  connectionsListPayloadSchema,
  isGatewayOp,
  skillsGetPayloadSchema,
  skillsSearchPayloadSchema,
  toolsInvokePayloadSchema,
  toolsCommitPayloadSchema,
} from './gateway.types';
import { GOOGLE_WORKSPACE_TOOL_IDS } from '../google/google-workspace-mcp-manifest';

/**
 * Per-skill RBAC. Skill discovery is deny-by-default: a member sees/uses only
 * skills explicitly granted to them (as a user, or via a department, role, or
 * company grant — see SkillAccessGrant). Always wired in production; when the
 * port is absent (some tests) the catalog falls back to tool-derived
 * visibility.
 */
export interface GatewayDispatcherDeps {
  readonly permissions: PermissionService;
  readonly toolRegistry: ToolRegistry;
  readonly skillCatalog: SkillCatalogService;
  readonly toolExecutor: ToolExecutor;
  readonly localApprovalIntents?: LocalApprovalIntentService;
  readonly connectionRegistry?: ConnectionRegistryPort;
  readonly mediaOcr?: MediaOcrService;
  readonly skillAccessEnforcement?: SkillAccessEnforcementPort;
  readonly auditService?: Pick<AuditService, 'record'>;
  readonly logger: Logger;
}

export class GatewayDispatcher {
  constructor(private readonly deps: GatewayDispatcherDeps) {}

  async dispatch(request: GatewayRequest, member: GatewayMemberContext): Promise<GatewayResponse> {
    if (!isGatewayOp(request.op)) {
      return gatewayFailure('unknown_op', `Unknown operation: ${request.op}`);
    }

    const departmentId = request.departmentId;

    switch (request.op) {
      case 'capabilities.get':
        return this.handleCapabilitiesGet(member, departmentId);
      case 'tools.list':
        return this.handleToolsList(member, departmentId);
      case 'skills.list':
        return this.handleSkillsList(member, departmentId);
      case 'skills.search':
        return this.handleSkillsSearch(member, departmentId, request.payload);
      case 'skills.get':
        return this.handleSkillsGet(member, departmentId, request.payload);
      case 'connections.list':
        return this.handleConnectionsList(member, departmentId, request.payload);
      case 'media.image_ocr':
        return this.handleMediaImageOcr(member, departmentId, request.payload);
      case 'tools.invoke':
        return this.handleToolsInvoke(member, departmentId, request.payload);
      case 'tools.prepare':
        return this.handleToolsPrepare(member, departmentId, request.payload);
      case 'tools.commit':
        return this.handleToolsCommit(member, departmentId, request.payload);
      default:
        return gatewayFailure('unknown_op', `Unknown operation: ${request.op}`);
    }
  }

  private async resolvePerm(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<PermissionResult | null> {
    const result = await this.deps.permissions.resolve({
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      channel: 'desktop',
    });

    if (!result.ok) {
      return null;
    }

    return result.value;
  }

  /**
   * The set of skill IDs granted to this member. `undefined` only when no
   * enforcement port is wired (some tests), in which case callers fall back to
   * tool-derived visibility.
   */
  private async grantedSkillIds(
    member: GatewayMemberContext,
  ): Promise<ReadonlySet<string> | undefined> {
    const enforcement = this.deps.skillAccessEnforcement;
    if (!enforcement) return undefined;
    return enforcement.listGrantedSkillIds(member.companyId, member.userId);
  }

  private permissionDenied(message: string): GatewayResponse {
    return gatewayFailure('permission_denied', message);
  }

  private async handleCapabilitiesGet(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<GatewayResponse> {
    const permOrError = await this.resolvePerm(member, departmentId);
    if (!permOrError) {
      return this.permissionDenied('Permission resolution failed');
    }

    const perm = withGatewayDiscoveryPermissions(permOrError);
    const grantedSkillIds = await this.grantedSkillIds(member);
    const allowedSkills = await this.deps.skillCatalog.listVisible({
      companyId: member.companyId,
      ...(departmentId ? { departmentId } : {}),
      permission: perm,
      ...(grantedSkillIds ? { grantedSkillIds } : {}),
    });

    return gatewaySuccess({
      user: {
        userId: member.userId,
        email: member.email,
        role: member.aiRole,
        larkOpenId: member.larkOpenId,
      },
      company: { companyId: member.companyId },
      departments: [],
      tools: [...perm.allowedToolIds].map((toolId) => ({
        toolId,
        allowedActions: [...(perm.allowedActionsByTool.get(toolId) ?? [])],
      })),
      skills: allowedSkills.map((skill) => ({
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
      })),
    });
  }

  private async handleToolsList(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<GatewayResponse> {
    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    const discoveryPerm = withGatewayDiscoveryPermissions(perm);
    const tools = this.deps.toolRegistry
      .forRuntime(discoveryPerm)
      .filter((tool) => tool.id !== 'runCommand')
      .map((tool) => ({
        id: tool.id,
        family: tool.family,
        description: tool.description,
        parameterDocs: tool.parameterDocs,
        allowedActions: [...(discoveryPerm.allowedActionsByTool.get(asToolId(tool.id)) ?? [])],
      }));

    return gatewaySuccess({ tools });
  }

  private async handleSkillsList(
    member: GatewayMemberContext,
    departmentId?: string,
  ): Promise<GatewayResponse> {
    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    const discoveryPerm = withGatewayDiscoveryPermissions(perm);
    const grantedSkillIds = await this.grantedSkillIds(member);
    const skills = (await this.deps.skillCatalog.listVisible({
      companyId: member.companyId,
      ...(departmentId ? { departmentId } : {}),
      permission: discoveryPerm,
      ...(grantedSkillIds ? { grantedSkillIds } : {}),
    })).map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      toolIds: [...skill.toolIds],
      revision: skill.revision,
    }));

    const registryRevision = await this.skillRegistryRevision(member.companyId);
    return gatewaySuccess({ registryRevision, skills });
  }

  private async handleSkillsSearch(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = skillsSearchPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid skills.search payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      this.recordSkillAudit(member, 'gateway.skill.search', 'failure', {
        departmentId: departmentId ?? null,
        reason: 'permission_resolution',
      });
      return this.permissionDenied('Permission resolution failed');
    }

    const discoveryPerm = withGatewayDiscoveryPermissions(perm);
    const grantedSkillIds = await this.grantedSkillIds(member);
    const results = await this.deps.skillCatalog.searchVisible({
      companyId: member.companyId,
      ...(departmentId ? { departmentId } : {}),
      permission: discoveryPerm,
      ...(grantedSkillIds ? { grantedSkillIds } : {}),
      query: parsed.data.query,
      limit: parsed.data.limit ?? 3,
    });

    const registryRevision = await this.skillRegistryRevision(member.companyId);
    this.recordSkillAudit(member, 'gateway.skill.search', 'success', {
      departmentId: departmentId ?? null,
      queryLength: parsed.data.query.length,
      resultCount: results.length,
      registryRevision,
      skillIds: results.map((result) => result.skill.id),
    });
    return gatewaySuccess({
      query: parsed.data.query,
      registryRevision,
      nextStep: 'Call skills.get with the selected skillId before invoking backend tools.',
      skills: results.map((result) => ({
        id: result.skill.id,
        slug: result.skill.slug,
        name: result.skill.name,
        description: result.skill.description,
        score: result.score,
        toolIds: [...result.skill.toolIds],
        revision: result.skill.revision,
      })),
    });
  }

  private async handleSkillsGet(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = skillsGetPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid skills.get payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      this.recordSkillAudit(member, 'gateway.skill.get', 'failure', {
        departmentId: departmentId ?? null,
        skillId: parsed.data.skillId,
        reason: 'permission_resolution',
      });
      return this.permissionDenied('Permission resolution failed');
    }
    const discoveryPerm = withGatewayDiscoveryPermissions(perm);

    const grantedSkillIds = await this.grantedSkillIds(member);
    const skill = await this.deps.skillCatalog.getInScope({
      companyId: member.companyId,
      ...(departmentId ? { departmentId } : {}),
      skillId: parsed.data.skillId,
    });
    if (!skill) {
      this.recordSkillAudit(member, 'gateway.skill.get', 'failure', {
        departmentId: departmentId ?? null,
        skillId: parsed.data.skillId,
        reason: 'not_found',
      });
      return gatewayFailure('bad_request', `Unknown skillId "${parsed.data.skillId}"`);
    }

    // Enforced: deny-by-default by explicit grant. Legacy: usable iff the member
    // can use every required tool.
    const allowed = grantedSkillIds
      ? grantedSkillIds.has(skill.id)
      : skill.toolIds.length > 0 && skill.toolIds.every((toolId) =>
          discoveryPerm.allowedToolIds.has(asToolId(toolId)),
        );
    if (!allowed) {
      this.recordSkillAudit(member, 'gateway.skill.get', 'failure', {
        departmentId: departmentId ?? null,
        skillId: skill.id,
        reason: 'permission_denied',
      });
      return gatewayFailure(
        'permission_denied',
        `Skill "${skill.id}" is not available for this user`,
      );
    }

    const registryRevision = await this.skillRegistryRevision(member.companyId);
    this.recordSkillAudit(member, 'gateway.skill.get', 'success', {
      departmentId: departmentId ?? null,
      skillId: skill.id,
      skillRevision: skill.revision,
      registryRevision,
    });
    return gatewaySuccess({
      registryRevision,
      skill: {
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        toolIds: [...skill.toolIds],
        revision: skill.revision,
      },
    });
  }

  private async handleToolsInvoke(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = toolsInvokePayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid tools.invoke payload — ${issues}`);
    }

    this.deps.logger.info('gateway.tools.invoke', {
      toolId: parsed.data.toolId,
      userId: member.userId,
      companyId: member.companyId,
      departmentId: departmentId ?? null,
    });

    const input = {
      member,
      ...(departmentId ? { departmentId } : {}),
      toolId: parsed.data.toolId,
      args: parsed.data.args,
    };
    const prepared = await this.deps.toolExecutor.prepare(input);
    if (!prepared.ok || !prepared.data) {
      this.recordToolInvocationAudit(member, departmentId, parsed.data.toolId, prepared);
      return prepared;
    }
    if (prepared.data.action !== 'read') {
      const response = gatewayFailure(
        'local_approval_required',
        'Write actions must be prepared with tools.prepare and executed with tools.commit after local approval.',
      );
      this.recordToolInvocationAudit(member, departmentId, parsed.data.toolId, response);
      return response;
    }

    const response = await this.deps.toolExecutor.invoke({ ...input, expectedAction: 'read' });
    this.recordToolInvocationAudit(member, departmentId, parsed.data.toolId, response);
    return response;
  }

  private async handleToolsPrepare(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = toolsInvokePayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid tools.prepare payload — ${issues}`);
    }
    if (!this.deps.localApprovalIntents) {
      return gatewayFailure('tool_error', 'Local approval intents are not configured');
    }

    return this.deps.localApprovalIntents.prepare({
      member,
      ...(departmentId ? { departmentId } : {}),
      toolId: parsed.data.toolId,
      args: parsed.data.args,
    });
  }

  private async handleToolsCommit(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = toolsCommitPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid tools.commit payload — ${issues}`);
    }
    if (!this.deps.localApprovalIntents) {
      return gatewayFailure('tool_error', 'Local approval intents are not configured');
    }

    return this.deps.localApprovalIntents.commit({
      member,
      ...(departmentId ? { departmentId } : {}),
      intentId: parsed.data.intentId,
    });
  }

  private async handleConnectionsList(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = connectionsListPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid connections.list payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    if (!this.deps.connectionRegistry) {
      return gatewayFailure('tool_error', 'Connection registry is not configured');
    }

    const provider = parsed.data.provider ?? 'google_workspace';
    const canUseGoogle = GOOGLE_WORKSPACE_TOOL_IDS.some((toolId) =>
      perm.allowedToolIds.has(asToolId(toolId)),
    );
    const canUseZoho = ['zohoCrm', 'zohoBooks'].some((toolId) =>
      perm.allowedToolIds.has(asToolId(toolId)),
    );
    const canUseCanva = perm.allowedToolIds.has(asToolId('canvaDesign'));
    const canUseLark = [
      'larkTask',
      'larkMessaging',
      'larkContacts',
      'larkCalendar',
      'larkMeeting',
      'larkDoc',
      'larkBase',
      'larkApproval',
    ].some((toolId) => perm.allowedToolIds.has(asToolId(toolId)));
    if (provider === 'google_workspace' && !canUseGoogle) {
      return gatewaySuccess({ connections: [] });
    }
    if (provider === 'zoho' && !canUseZoho) {
      return gatewaySuccess({ connections: [] });
    }
    if (provider === 'canva' && !canUseCanva) {
      return gatewaySuccess({ connections: [] });
    }
    if (provider === 'lark' && !canUseLark) {
      return gatewaySuccess({ connections: [] });
    }

    const result = provider === 'zoho'
      ? await this.deps.connectionRegistry.listAccessibleZohoConnections({
        companyId: member.companyId,
        userId:    member.userId,
      })
      : provider === 'canva'
        ? await this.deps.connectionRegistry.listAccessibleCanvaConnections({
          companyId: member.companyId,
          userId:    member.userId,
        })
        : provider === 'lark'
          ? await this.deps.connectionRegistry.listAccessibleLarkConnections({
            companyId: member.companyId,
            userId:    member.userId,
          })
      : await this.deps.connectionRegistry.listAccessibleGoogleConnections({
        companyId: member.companyId,
        userId:    member.userId,
        });
    if (!result.ok) {
      return gatewayFailure('tool_error', result.error.message);
    }

    return gatewaySuccess({
      connections: result.value.map(connection => ({
        connectionId: connection.connectionId,
        provider:     connection.provider,
        label:        connection.label,
        accountEmail: connection.accountEmail ?? null,
        accountName:  connection.accountName ?? null,
        ownerType:    connection.ownerType,
        ownerUserId:  connection.ownerUserId ?? null,
        access:       connection.access,
        scopes:       connection.scopes,
        connectedAt:  connection.connectedAt.toISOString(),
        lastUsedAt:   connection.lastUsedAt?.toISOString() ?? null,
      })),
    });
  }

  private async handleMediaImageOcr(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Promise<GatewayResponse> {
    const parsed = mediaImageOcrPayloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('bad_request', `Invalid media.image_ocr payload — ${issues}`);
    }

    const perm = await this.resolvePerm(member, departmentId);
    if (!perm) {
      return this.permissionDenied('Permission resolution failed');
    }

    if (!this.deps.mediaOcr) {
      return gatewayFailure('tool_error', 'Media OCR is not configured');
    }

    this.deps.logger.info('gateway.media.image_ocr', {
      userId: member.userId,
      companyId: member.companyId,
      departmentId: departmentId ?? null,
      mimeType: parsed.data.mimeType,
      fileName: parsed.data.fileName ?? null,
    });

    const result = await this.deps.mediaOcr.extractImage(parsed.data);
    return gatewaySuccess({ media: result });
  }

  private async skillRegistryRevision(companyId: string): Promise<number> {
    const catalog = this.deps.skillCatalog as SkillCatalogService & {
      registryRevision?: (id: string) => Promise<number>;
    };
    return catalog.registryRevision ? await catalog.registryRevision(companyId) : 1;
  }

  private recordSkillAudit(
    member: GatewayMemberContext,
    action: string,
    outcome: 'success' | 'failure',
    metadata: Record<string, unknown>,
  ): void {
    this.deps.auditService?.record({
      actorId: member.userId,
      companyId: member.companyId,
      action,
      outcome,
      metadata,
    });
  }

  private recordToolInvocationAudit(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    toolId: string,
    response: GatewayResponse,
  ): void {
    this.deps.auditService?.record({
      actorId: member.userId,
      companyId: member.companyId,
      action: 'gateway.tool.invocation',
      outcome: response.ok ? 'success' : 'failure',
      metadata: {
        departmentId: departmentId ?? null,
        toolId,
        gatewayStatus: response.status,
      },
    });
  }
}

function withGatewayDiscoveryPermissions(perm: PermissionResult): PermissionResult {
  const allowedActionsByTool = new Map(perm.allowedActionsByTool);
  const allowedToolIds = new Set(perm.allowedToolIds);

  const memoryPublishingToolId = asToolId('memoryPublishing');
  const memoryActions = new Set<ToolActionGroup>(
    allowedActionsByTool.get(memoryPublishingToolId) ?? [],
  );
  memoryActions.add('read');
  allowedActionsByTool.set(memoryPublishingToolId, memoryActions);
  allowedToolIds.add(memoryPublishingToolId);

  const memoryRecallToolId = asToolId('memoryRecall');
  const recallActions = new Set<ToolActionGroup>(
    allowedActionsByTool.get(memoryRecallToolId) ?? [],
  );
  recallActions.add('read');
  allowedActionsByTool.set(memoryRecallToolId, recallActions);
  allowedToolIds.add(memoryRecallToolId);

  if (perm.department?.roleSlug === 'MANAGER') {
    const skillPublishingToolId = asToolId('skillPublishing');
    const skillActions = new Set<ToolActionGroup>(
      allowedActionsByTool.get(skillPublishingToolId) ?? [],
    );
    skillActions.add('read');
    skillActions.add('create');
    allowedActionsByTool.set(skillPublishingToolId, skillActions);
    allowedToolIds.add(skillPublishingToolId);
  }

  return {
    ...perm,
    allowedToolIds,
    allowedActionsByTool,
  };
}
